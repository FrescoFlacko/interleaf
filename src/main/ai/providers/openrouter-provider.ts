import type { AIModelInfo, AIModelPrice, AIProviderCapabilities, AIProviderStatus } from '@shared/types/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import { openRouterApiKeySchema, openRouterModelIdSchema } from '@shared/schemas/ai';
import { CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS, OPENROUTER_AUTH_FAILED_MESSAGE } from '@shared/constants/ai';
import type { AppSettings, AppSettingsInput } from '@shared/schemas/settings';
import type { OpenRouterCredentialStatus } from '@shared/schemas/credential-preview';
import type { SettingsRepository } from '../../db/repositories/settings-repository';
import type { CredentialVault } from '../credential-vault';
import { clearOpenRouterCredential } from '../openrouter-credential-status';
import { responseTokenLimit, type AIProvider, type ProviderChatEvent, type ProviderChatRequest } from './types';
import { type OpenRouterStreamState, SseEventParser, decodeEventChunks, reasoningBudgetError, toWebSources } from './openrouter-stream';
import { OPENROUTER_EFFORTS, openRouterReasoning } from './reasoning-metadata';
import { type PortableMember, type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';

export { SseEventParser } from './openrouter-stream';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_AUTH_ENDPOINT = 'https://openrouter.ai/api/v1/auth/key';
const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MODELS_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_MODELS = 5_000;
const MAX_MODEL_NAME_LENGTH = 128;
const MIN_CONTEXT_WINDOW = 1;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MIN_MAX_OUTPUT_TOKENS = 1;
const MAX_MAX_OUTPUT_TOKENS = 1_000_000;
/**
 * Documented per-token price syntax: an optionally signed JSON-style decimal
 * or scientific-notation literal ("0", "-1", "0.0000025", "1e-12"). Rejects
 * hexadecimal/binary/octal-like forms, leading '+', legacy-octal leading
 * zeros, bare fractional starts ('.5'), 'Infinity'/'NaN', exponent fragments,
 * and any trailing junk BEFORE Number conversion can silently reinterpret
 * them. Sign is captured so negative sentinels keep their own kind.
 */
const DOCUMENTED_PRICE_LEXEME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_PRICE_TEXT_LENGTH = 64;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MODELS_FETCH_TIMEOUT_MS = 10_000; // 10 seconds
export const DEFAULT_OPENROUTER_MODEL: AIModelInfo = {
  id: 'openrouter/auto',
  name: 'OpenRouter Auto',
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  supportsStreaming: true,
  // Live catalog advertises -1/-1 for the dynamic Auto Router. The sentinel
  // is undocumented upstream, so the truthful label is "Price unavailable"
  // rather than a claim that no price was published.
  pricing: { input: { kind: 'unavailable' }, output: { kind: 'unavailable' } },
};

/**
 * The part of the main-owned credential vault this provider drives. The vault
 * itself stays main's: the provider only reads, replaces or drops the one
 * OpenRouter secret, and a boundary test can answer exactly that much.
 */
export type OpenRouterKeyStore = Pick<
  CredentialVault,
  'hasOpenRouterKey' | 'getOpenRouterKey' | 'setOpenRouterKey' | 'clearOpenRouterKey' | 'describeStorage'
>;

/** The part of the settings repository a configure call reads and writes. */
export type OpenRouterSettingsStore = Pick<SettingsRepository, 'get' | 'update'>;

/** A catalog entry's pricing and reasoning levels, each present only when published. */
function optionalCatalogMembers(record: PortableRecord): Pick<AIModelInfo, 'pricing' | 'reasoning'> {
  const prices = record.pricing as PortableRecord | null | undefined;
  const reasoning = openRouterReasoning(record.reasoning);
  return {
    ...(typeof prices === 'object' && prices !== null
      ? { pricing: { input: parseCatalogPriceKind(prices.prompt), output: parseCatalogPriceKind(prices.completion) } } : {}),
    ...(reasoning !== null ? { reasoning } : {}),
  };
}

export class OpenRouterProvider implements AIProvider {
  readonly id = 'openrouter' as const;
  readonly name = 'OpenRouter';
  readonly capabilities: AIProviderCapabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: true,
    persistentSessions: false,
    toolFreeMode: true,
    // OpenRouter is the only provider offering a server-hosted search: the
    // search runs on OpenRouter's infrastructure and Interleaf never executes
    // a tool call for it.
    hostedWebSearch: true,
  };
  private readonly active = new Map<string, AbortController>();
  private cachedModels: { readonly models: readonly AIModelInfo[]; readonly timestamp: number } | null = null;
  private inFlightFetch: Promise<readonly AIModelInfo[]> | null = null;
  private configureLockTail: Promise<void> = Promise.resolve();
  constructor(private readonly vault: OpenRouterKeyStore) {}
  async detect(): Promise<AIProviderStatus> {
    const configured = await this.vault.hasOpenRouterKey();
    return {
      id: this.id,
      name: this.name,
      available: configured,
      installed: false,
      authentication: configured ? 'connected' : 'disconnected',
      version: null,
      errorMessage: configured ? null : 'OpenRouter API key is not configured in Settings.',
      models: [DEFAULT_OPENROUTER_MODEL],
      capabilities: this.capabilities,
    };
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([DEFAULT_OPENROUTER_MODEL]);
  }

  async listCatalogModels(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIModelInfo[]> {
    const forceRefresh = options?.forceRefresh === true;
    const now = Date.now();

    // Join any active in-flight network fetch regardless of forceRefresh
    if (this.inFlightFetch !== null) {
      return this.inFlightFetch;
    }

    if (!forceRefresh && this.cachedModels !== null && now - this.cachedModels.timestamp < MODELS_CACHE_TTL_MS) {
      return this.cachedModels.models;
    }

    const fetchPromise = this.fetchAndCacheCatalog();
    this.inFlightFetch = fetchPromise;

    try {
      return await fetchPromise;
    } finally {
      if (this.inFlightFetch === fetchPromise) {
        this.inFlightFetch = null;
      }
    }
  }

  private async fetchAndCacheCatalog(): Promise<readonly AIModelInfo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, MODELS_FETCH_TIMEOUT_MS);
    timer.unref();

    try {
      const headers: Record<string, string> = {
        'X-Title': 'Interleaf',
        Accept: 'application/json',
      };

      const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
        method: 'GET',
        signal: controller.signal,
        headers,
        redirect: 'error',
      });

      if (!response.ok) {
        const safeMessage = mapCatalogHttpStatusError(response.status);
        throw new InterleafError('internal', `Failed to fetch OpenRouter model catalog: ${safeMessage}`);
      }

      if (!response.body) {
        throw new InterleafError('internal', 'OpenRouter models response body was empty.');
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declaredLength = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_BODY_BYTES) {
          throw new InterleafError('internal', 'OpenRouter model catalog payload exceeded maximum size limit.');
        }
      }

      const rawBody = await readBoundedBody(response.body, MAX_MODELS_BODY_BYTES);
      const parsed = parseModelsBody(rawBody);

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('data' in parsed) ||
        !Array.isArray(parsed.data)
      ) {
        throw new InterleafError('internal', 'OpenRouter models response shape was invalid.');
      }

      if (parsed.data.length > MAX_REMOTE_MODELS) {
        throw new InterleafError(
          'internal',
          'OpenRouter model catalog exceeded maximum entry limit.'
        );
      }

      const remoteModelsMap = new Map<string, AIModelInfo>();

      for (const item of parsed.data) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as PortableRecord;
        const rawId = typeof record.id === 'string' ? record.id.trim() : '';
        if (rawId.length === 0) continue;
        const validation = openRouterModelIdSchema.safeParse(rawId);
        if (!validation.success) continue;

        const rawName = typeof record.name === 'string' ? record.name.trim() : '';
        const name = rawName.length > 0 ? rawName.slice(0, MAX_MODEL_NAME_LENGTH) : rawId;

        let contextWindow = 128_000;
        if (typeof record.context_length === 'number' && Number.isFinite(record.context_length)) {
          const clamped = Math.floor(record.context_length);
          if (clamped >= MIN_CONTEXT_WINDOW && clamped <= MAX_CONTEXT_WINDOW) {
            contextWindow = clamped;
          }
        }

        let maxOutputTokens = 4_096;
        const topProvider = record.top_provider;
        if (typeof topProvider === 'object' && topProvider !== null) {
          const maxTokens = (topProvider as PortableRecord).max_completion_tokens;
          if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
            const clampedTokens = Math.floor(maxTokens);
            if (clampedTokens >= MIN_MAX_OUTPUT_TOKENS && clampedTokens <= MAX_MAX_OUTPUT_TOKENS) {
              maxOutputTokens = clampedTokens;
            }
          }
        }

        if (!remoteModelsMap.has(rawId)) {
          if (remoteModelsMap.size >= MAX_REMOTE_MODELS) {
            throw new InterleafError(
              'internal',
              'OpenRouter model catalog exceeded maximum entry limit.'
            );
          }
          remoteModelsMap.set(rawId, {
            id: rawId,
            name,
            contextWindow,
            maxOutputTokens,
            supportsStreaming: true,
            ...optionalCatalogMembers(record),
          });
        }
      }

      const remoteModels = Array.from(remoteModelsMap.values());
      remoteModels.sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        if (nameCmp !== 0) return nameCmp;
        return a.id.localeCompare(b.id);
      });

      const nonAutoRemoteModels = remoteModels.filter((m) => m.id !== DEFAULT_OPENROUTER_MODEL.id);
      const result: readonly AIModelInfo[] = [DEFAULT_OPENROUTER_MODEL, ...nonAutoRemoteModels];
      this.cachedModels = { models: result, timestamp: Date.now() };
      return result;
    } catch (error) {
      throw catalogFailure(error instanceof Error ? error : null, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Serializes every credential-store mutation this provider owns.
   *
   * The vault document is a read-modify-write of one file, so two mutations
   * that overlap can lose an update and then each report a state that is not
   * the one on disk. Configure and removal therefore share this single queue:
   * whichever is requested second observes the first one's completed result.
   */
  private async withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    const previousLock = this.configureLockTail;
    let resolveLock!: () => void;
    this.configureLockTail = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    await previousLock.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveLock();
    }
  }

  configure(
    input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string },
    settingsRepo: OpenRouterSettingsStore
  ): Promise<AppSettings> {
    return this.withCredentialLock(() => this.executeConfigure(input, settingsRepo));
  }

  /**
   * Deletes the stored credential immediately, under the same lock configure
   * uses, and answers with the masked status that replaced it.
   *
   * Nothing is decrypted and no existing key is validated: the record is
   * dropped, so a ciphertext the current OS key can no longer read is
   * removable exactly like a readable one. Serializing it here is what keeps a
   * concurrent replacement from being silently dropped — or from being
   * reported as removed while it is in fact stored.
   */
  clearCredential(): Promise<OpenRouterCredentialStatus> {
    return this.withCredentialLock(() => clearOpenRouterCredential(this.vault));
  }

  private async executeConfigure(
    input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string },
    settingsRepo: OpenRouterSettingsStore
  ): Promise<AppSettings> {
    const trimmedModel = input.model.trim();
    const parsedModel = openRouterModelIdSchema.safeParse(trimmedModel);
    if (!parsedModel.success) {
      throw new InterleafError('validation', 'OpenRouter model identifier is invalid.');
    }
    const validatedModel = parsedModel.data;

    const rawKey = input.apiKey?.trim();
    const removeKey = input.removeKey === true;
    if (removeKey && input.apiKey !== undefined) {
      throw new InterleafError('validation', 'Remove key cannot be combined with a replacement API key.');
    }
    if (rawKey !== undefined && rawKey.length > 0) {
      if (!openRouterApiKeySchema.safeParse(rawKey).success) {
        throw new InterleafError('validation', 'OpenRouter API key is invalid.');
      }
    }

    const currentSettings = settingsRepo.get();
    const modelChanged = validatedModel !== currentSettings.ai.openRouterModel;
    // A persisted model that has disappeared from the catalog is retained for
    // truthful display, but changing it (including to Auto) must be validated
    // against a fresh catalog. The initial Auto default remains available to
    // a genuinely fresh/unconfigured setup without a network dependency.
    if (modelChanged && (validatedModel !== DEFAULT_OPENROUTER_MODEL.id || currentSettings.ai.openRouterModel !== DEFAULT_OPENROUTER_MODEL.id)) {
      let catalog: readonly AIModelInfo[];
      try {
        catalog = await this.listCatalogModels();
      } catch {
        throw new InterleafError(
          'validation',
          'The OpenRouter model catalog is unavailable. Retry the catalog before saving a changed model.'
        );
      }
      if (!catalog.some((model) => model.id === validatedModel)) {
        throw new InterleafError(
          'validation',
          'Select a model from the current OpenRouter catalog before saving.'
        );
      }
    }

    const hasExistingKey = await this.vault.hasOpenRouterKey();
    const isKeyReplacement = rawKey !== undefined && rawKey.length > 0;

    if (!removeKey && !isKeyReplacement && !hasExistingKey) {
      throw new InterleafError('validation', 'OpenRouter API key is required when no key is configured.');
    }

    // Ordering is the transaction design: the non-secret model setting is
    // written first, and the vault second.
    //
    // Neither store is transactional across the other, so exactly one of them
    // has to be the compensable side. Restoring a previous *model* needs only
    // the value already in hand; restoring a previous *key* would need the old
    // plaintext, which would mean decrypting a credential the user is about to
    // discard — and which is unavailable precisely in the case this ordering
    // exists to support, a ciphertext the current OS key can no longer read.
    // So settings changes are compensated and credential writes are not: a
    // failed vault write leaves the vault exactly as the user found it, and a
    // failed settings write never touches the credential at all.
    const nextSettings: AppSettingsInput = {
      ...currentSettings,
      ai: {
        ...currentSettings.ai,
        openRouterModel: validatedModel,
      },
    };
    const saved = settingsRepo.update(nextSettings);

    try {
      if (isKeyReplacement) {
        // Overwrites whatever ciphertext is stored. The previous secret is
        // never read, so an undecryptable record is replaceable.
        await this.vault.setOpenRouterKey(rawKey);
      } else if (removeKey && hasExistingKey) {
        await this.vault.clearOpenRouterKey();
      }
      return saved;
    } catch (vaultError) {
      try {
        settingsRepo.update(currentSettings);
      } catch (compensationError) {
        throw new InterleafError(
          'internal',
          'The OpenRouter credential was not changed, and the previous model setting could not be restored. Reopen Settings to check the saved model.',
          { cause: compensationError instanceof Error ? compensationError : null }
        );
      }
      throw vaultError;
    }
  }

  resolveModel(modelId: string | null): AIModelInfo {
    if (modelId === null || modelId === DEFAULT_OPENROUTER_MODEL.id) {
      return DEFAULT_OPENROUTER_MODEL;
    }
    const parsed = openRouterModelIdSchema.safeParse(modelId);
    if (parsed.success) {
      return {
        id: parsed.data,
        name: parsed.data,
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        supportsStreaming: true,
      };
    }
    throw new InterleafError('validation', `Invalid OpenRouter model ID: '${modelId}'.`);
  }

  async testConnection(): Promise<{ readonly success: boolean; readonly message?: string }> {
    const key = await this.vault.getOpenRouterKey();
    if (!key) {
      return { success: false, message: 'OpenRouter API key is not configured in Settings.' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 5_000);
    timer.unref();

    try {
      const response = await fetch(OPENROUTER_AUTH_ENDPOINT, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'X-Title': 'Interleaf',
        },
      });
      if (response.ok) {
        return { success: true, message: 'OpenRouter API connection verified successfully.' };
      }
      if (response.status === 401) {
        return { success: false, message: 'OpenRouter did not accept this API key. Check that it is correct and still active, or replace it.' };
      }
      return {
        success: false,
        message: `OpenRouter connection test returned status ${String(response.status)}.`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection test request failed.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    const key = await this.vault.getOpenRouterKey();
    if (!key) throw new InterleafError('validation', 'OpenRouter API key is not configured.');

    const model = this.resolveModel(request.modelId);
    const reasoningFields = await this.reasoningFields(model.id, request.reasoningEffort);
    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    const timeout = setTimeout(() => { controller.abort(); }, 5 * 60 * 1_000);
    timeout.unref();

    try {
      const response = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'Interleaf',
        },
        body: JSON.stringify({
          model: model.id,
          stream: true,
          max_tokens: responseTokenLimit(request, model.maxOutputTokens),
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...request.history.map((message) => ({ role: message.role, content: message.content })),
            {
              role: 'user',
              content: `${request.contextXml}\n\nUser question:\n${request.userMessage}`,
            },
          ],
          ...reasoningFields,
          // Provider-hosted server tool: OpenRouter runs the search on its own
          // infrastructure and returns text, so no tool call ever executes in
          // Interleaf and no local capability is exposed. Sent only for a turn
          // the user explicitly opted in; omitted entirely otherwise, so the
          // default request shape is unchanged.
          // https://openrouter.ai/docs/guides/features/server-tools/web-search
          ...(request.webSearch
            ? {
                tools: [
                  {
                    type: 'openrouter:web_search',
                    parameters: { max_total_results: CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS },
                  },
                ],
              }
            : {}),
        }),
      });

      if (isSignalAborted(controller)) {
        throw new InterleafError('internal', 'OpenRouter generation was cancelled or timed out.');
      }

      if (!response.ok) {
        const errorBody = response.body ? await readBoundedErrorBody(response.body) : '';
        const message = parseOpenRouterErrorMessage(errorBody, response.status);
        throw new InterleafError('internal', message);
      }

      if (!response.body) {
        throw new InterleafError('internal', 'OpenRouter response body was empty.');
      }

      const reader = response.body.getReader();
      if (isSignalAborted(controller)) {
        void reader.cancel().catch(() => undefined);
        throw new InterleafError('internal', 'OpenRouter generation was cancelled or timed out.');
      }

      const abortListener = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener('abort', abortListener, { once: true });

      const decoder = new TextDecoder();
      let buffer = '';
      let totalBytes = 0;
      let tokenCount = 0;
      const sseParser = new SseEventParser();
      const stream: OpenRouterStreamState = { citations: new Map<string, string>(), finishReason: null };

      try {
        for (;;) {
          const part = await reader.read();
          if (part.done || isSignalAborted(controller)) break;
          totalBytes += part.value.byteLength;
          if (totalBytes > MAX_STREAM_BYTES) {
            controller.abort();
            throw new InterleafError('validation', 'OpenRouter response exceeded the safe output limit.');
          }

          buffer += decoder.decode(part.value, { stream: true });
          const events = sseParser.feed(buffer);
          buffer = sseParser.remainder;

          for (const chunk of decodeEventChunks(events, stream)) {
            tokenCount += 1;
            yield { type: 'token', token: chunk };
          }
        }

        // Flush text decoder and process any trailing event at EOF
        buffer += decoder.decode();
        for (const chunk of decodeEventChunks(sseParser.flush(buffer), stream)) {
          tokenCount += 1;
          yield { type: 'token', token: chunk };
        }

        if (isSignalAborted(controller)) {
          throw new InterleafError('internal', 'OpenRouter generation was cancelled or timed out.');
        }

        const budgetError = reasoningBudgetError(request.reasoningEffort, stream, tokenCount);
        if (budgetError !== null) throw budgetError;
        if (tokenCount === 0) {
          throw new InterleafError('internal', 'OpenRouter returned an empty response.');
        }

        // Sources the provider itself searched, reported as structured
        // metadata rather than streamed as tokens. The model did not write
        // them, so they belong neither in the answer text nor in `totalTokens`.
        yield { type: 'done', totalTokens: tokenCount, webSources: toWebSources(stream.citations) };
      } finally {
        controller.signal.removeEventListener('abort', abortListener);
      }
    } catch (error) {
      if (isSignalAborted(controller)) {
        throw new InterleafError('internal', 'OpenRouter generation was cancelled or timed out.', { cause: error instanceof Error ? error : null });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.requestId);
    }
  }

  /**
   * Request fields for one turn's reasoning level. Default sends nothing. An
   * explicit level is checked again against this model's catalog entry, so a
   * level the model does not list never reaches the network, and is sent with
   * `require_parameters` so no endpoint that would ignore it is routed to.
   */
  private async reasoningFields(modelId: string, effort: ProviderChatRequest['reasoningEffort']): Promise<PortableRecord> {
    if (effort === undefined) return {};
    const catalog = await this.listCatalogModels().catch(() => []);
    const levels = catalog.find((entry) => entry.id === modelId)?.reasoning?.levels ?? [];
    if (!levels.includes(effort) || !OPENROUTER_EFFORTS.includes(effort)) {
      throw new InterleafError('validation', 'This model does not offer that reasoning effort. Choose another level or Default.');
    }
    return { reasoning: { effort }, provider: { require_parameters: true } };
  }

  cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.abort();
    this.active.delete(requestId);
    return Promise.resolve();
  }
}

/**
 * Every catalog failure as one typed error: a failure this provider already
 * described is kept, an aborted request is reported as the timeout it was, and
 * anything else is an unavailable catalog.
 */
function catalogFailure(caught: Error | null, controller: AbortController): InterleafError {
  if (caught instanceof InterleafError) return caught;
  if (controller.signal.aborted) {
    return new InterleafError('internal', 'OpenRouter model catalog request timed out.');
  }
  return new InterleafError(
    'internal',
    'OpenRouter model catalog is currently unavailable. Check network connection and retry.',
    { cause: caught },
  );
}

/** The models response body, or a typed failure when it is not JSON at all. */
function parseModelsBody(rawBody: string): PortableValue {
  try {
    return parsePortableJson(rawBody);
  } catch (error) {
    throw new InterleafError('internal', 'OpenRouter models response was not valid JSON.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

function mapCatalogHttpStatusError(status: number): string {
  if (status === 401 || status === 403) {
    return OPENROUTER_AUTH_FAILED_MESSAGE;
  }
  if (status === 429) {
    return 'OpenRouter API rate limit reached. Please wait and retry.';
  }
  if (status >= 500 && status <= 599) {
    return 'OpenRouter service is temporarily unavailable. Please retry later.';
  }
  return `OpenRouter request failed with status ${String(status)}.`;
}

function parseOpenRouterErrorMessage(errorBody: string, status: number): string {
  if (status === 401 || status === 403) return OPENROUTER_AUTH_FAILED_MESSAGE;
  try {
    const parsed: PortableValue = parsePortableJson(errorBody);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      'message' in parsed.error &&
      typeof parsed.error.message === 'string'
    ) {
      return `OpenRouter error (${String(status)}): ${parsed.error.message.slice(0, 500)}`;
    }
  } catch {
    // ignore non-JSON error
  }
  return `OpenRouter request failed with status ${String(status)}.`;
}

async function readBoundedErrorBody(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let output = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = MAX_ERROR_BODY_BYTES - totalBytes;
      if (remaining <= 0) break;
      const bytes = part.value.subarray(0, remaining);
      totalBytes += bytes.byteLength;
      output += decoder.decode(bytes, { stream: bytes.byteLength === part.value.byteLength });
      if (bytes.byteLength < part.value.byteLength) break;
    }
    output += decoder.decode();
    return output;
  } catch {
    return output;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
async function readBoundedBody(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let totalBytes = 0;
  let output = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > maxBytes) {
        throw new InterleafError('internal', 'OpenRouter models payload exceeded maximum size limit.');
      }
      output += decoder.decode(part.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
function isSignalAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

/**
 * Classifies one advertised per-token USD figure into the explicit
 * {@link AIModelPrice} contract, preserving every state upstream expresses:
 * - every finite positive documented decimal/scientific value stays a numeric
 *   `priced` rate — no artificial ceiling is imposed;
 * - exact zero stays Free;
 * - negative markers (OpenRouter's undocumented `-1` sentinel, or any other
 *   negative figure) are conservatively `unavailable`;
 * - missing fields / empty or lexically malformed text / non-finite results
 *   (e.g. `1e999`) are `not_published`.
 */
function parseCatalogPriceKind(value: PortableMember): AIModelPrice {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { kind: 'not_published' };
    if (value < 0) return { kind: 'unavailable' };
    return value === 0 ? { kind: 'free' } : { kind: 'priced', usdPerToken: value };
  }
  if (typeof value !== 'string') return { kind: 'not_published' };
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_PRICE_TEXT_LENGTH) return { kind: 'not_published' };
  // Lexical validation happens before Number conversion: Number() would
  // happily read "0x10" as 16, "Infinity" as Infinity, or "1e999" overflow;
  // only documented decimal/scientific syntax may reach it.
  if (!DOCUMENTED_PRICE_LEXEME.test(raw)) return { kind: 'not_published' };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { kind: 'not_published' };
  // Negative markers are deliberately undocumented upstream; we cannot
  // assert "free" or "published elsewhere", so the price is unavailable.
  if (parsed < 0) return { kind: 'unavailable' };
  return parsed === 0 ? { kind: 'free' } : { kind: 'priced', usdPerToken: parsed };
}
