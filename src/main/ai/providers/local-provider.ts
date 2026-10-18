/**
 * Reader Chat against a local inference server.
 *
 * What this provider guarantees, precisely: **Interleaf only ever opens a
 * connection to a loopback address on this machine.** The endpoint policy in
 * `@shared/schemas/local-endpoint` admits nothing else, the transport performs
 * no name lookup and follows no redirect, and no proxy can redirect it.
 *
 * What it does **not** guarantee, and must never be described as guaranteeing:
 * that inference happens on this device. Ollama is a loopback server that can
 * itself route a cloud-capable model to Ollama's own infrastructure. When it
 * does, the prompt leaves the machine — through the runtime, not through
 * Interleaf, and entirely outside Interleaf's control. Only the runtime can
 * settle that, which is why the UI points users at Ollama's `OLLAMA_NO_CLOUD=1`
 * rather than making a promise on the runtime's behalf. "Local" here names the
 * socket, not the silicon.
 *
 * The server is treated as an untrusted program throughout: it is a separate
 * process the user installed, its catalog and its stream are validated and
 * bounded, and it is granted no tool, function or MCP surface at all.
 */
import type {
  AIModelInfo,
  AIModelReasoning,
  AIProviderCapabilities,
  AIProviderStatus,
  ReasoningEffort,
} from '@shared/types/ai';
import { AI_PROVIDER_DISPLAY_NAMES } from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  LOOPBACK_ENDPOINT_MESSAGES,
  parseLoopbackEndpoint,
  type LocalEndpointMode,
  type LoopbackEndpoint,
} from '@shared/schemas/local-endpoint';
import type { LocalProviderSettings } from '@shared/schemas/settings';
import {
  describeLoopbackStatus,
  loopbackRequest,
  loopbackStreamLines,
} from './loopback-transport';
import { responseTokenLimit, type AIProvider, type ProviderChatEvent, type ProviderChatRequest } from './types';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableRecord, parsePortableJson } from '@shared/models/portable';
import { ollamaThinkingReasoning } from './reasoning-metadata';

/** Fixed, app-owned request paths. Never assembled from configuration. */
const OPENAI_MODELS_PATH = '/v1/models';
const OPENAI_CHAT_PATH = '/v1/chat/completions';
const OLLAMA_SHOW_PATH = '/api/show';

/** How long a successful catalog probe may answer a repeated status request. */
const LOCAL_CATALOG_TTL_MS = 15_000;
/** Models accepted from one catalog, and identifier/label bounds. */
const LOCAL_MAX_MODELS = 64;
const LOCAL_MAX_CATALOG_ENTRIES = 1_024;
const LOCAL_MAX_MODEL_ID_LENGTH = 128;
/**
 * Models whose native metadata is read for a real context window. Bounded
 * because each is a separate request; the rest keep the conservative default.
 */
const LOCAL_MAX_METADATA_PROBES = 12;
const LOCAL_METADATA_TIMEOUT_MS = 5_000;
/**
 * Context window assumed when the server publishes none.
 *
 * Deliberately small. The OpenAI-compatible surface says nothing about context
 * length, and guessing high would mean silently building a prompt the server
 * truncates from the front — dropping the document, keeping the question, and
 * producing a confident answer about text the model never saw. Guessing low
 * only sends less context than necessary.
 */
const LOCAL_DEFAULT_CONTEXT_WINDOW = 8_192;
const LOCAL_MAX_CONTEXT_WINDOW = 1_000_000;
const LOCAL_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

/** Reads current settings. Injected so the provider owns no persistence. */
export type LocalSettingsReader = () => LocalProviderSettings;

type LocalCatalog = {
  readonly models: readonly AIModelInfo[];
  /** Populated when the server was reached but refused or answered oddly. */
  readonly errorMessage: string | null;
};

export class LocalProvider implements AIProvider {
  readonly id = 'local' as const;
  readonly name = AI_PROVIDER_DISPLAY_NAMES.local;
  readonly capabilities: AIProviderCapabilities = {
    streaming: true,
    // A loopback server holds no Interleaf account and takes no Interleaf key.
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: false,
    // No tools, functions or MCP servers are offered in any request this
    // provider builds, and a tool-shaped delta aborts the turn.
    toolFreeMode: true,
    // There is no hosted search behind a loopback socket, and Interleaf will
    // not stand one up.
    hostedWebSearch: false,
  };

  private readonly active = new Map<string, AbortController>();
  // Every catalog table is keyed by `mode|origin`, never by "the current
  // endpoint": two endpoints are two separate servers, so a read of one must
  // never be answered, cached or invalidated by a read of the other.
  private readonly cached = new Map<string, { readonly at: number; readonly catalog: LocalCatalog }>();
  private readonly inFlight = new Map<string, Promise<LocalCatalog>>();
  /**
   * How many times a fresh read has been demanded for each key.
   *
   * A read carries the number it started with and may only write the cache if
   * that is still current, so a request already in flight when the user asked
   * for a new look cannot install its older answer over the new one.
   */
  private readonly generation = new Map<string, number>();

  constructor(private readonly readSettings: LocalSettingsReader) {}

  async detect(options?: { readonly forceRefresh?: boolean }): Promise<AIProviderStatus> {
    const settings = this.readSettings();
    const parsed = parseLoopbackEndpoint(settings.endpoint);
    if (!parsed.ok) {
      return this.status({
        available: false,
        installed: false,
        authentication: 'disconnected',
        errorMessage: LOOPBACK_ENDPOINT_MESSAGES[parsed.reason],
        models: [],
      });
    }
    const catalog = await this.catalog(parsed.endpoint, settings.mode, options);
    const reachable = catalog.errorMessage === null;
    const models = preferSavedModel(catalog.models, settings.model);
    return this.status({
      // "Installed" has no meaning for a server Interleaf did not install; it
      // is reported as the only thing Interleaf actually knows — whether
      // something answered on that port.
      available: reachable && models.length > 0,
      installed: reachable,
      authentication: reachable ? 'connected' : 'disconnected',
      errorMessage: catalog.errorMessage
        ?? (models.length === 0 ? 'The local server is running but has no models available.' : null)
        ?? staleModelMessage(models, settings.model),
      models,
    });
  }

  async listModels(): Promise<readonly AIModelInfo[]> {
    const settings = this.readSettings();
    const parsed = parseLoopbackEndpoint(settings.endpoint);
    if (!parsed.ok) return [];
    return preferSavedModel((await this.catalog(parsed.endpoint, settings.mode)).models, settings.model);
  }

  /**
   * A read-only reachability check.
   *
   * It lists models and nothing else: no model is loaded, nothing is pulled,
   * and no inference runs, so testing a connection can never cost the user time
   * on a cold model or start a download.
   */
  async testConnection(): Promise<{ readonly success: boolean; readonly message?: string }> {
    const settings = this.readSettings();
    const parsed = parseLoopbackEndpoint(settings.endpoint);
    if (!parsed.ok) return { success: false, message: LOOPBACK_ENDPOINT_MESSAGES[parsed.reason] };
    // A test the user explicitly asked for should reflect the server as it is
    // now, not a cached answer from a moment ago.
    const catalog = await this.catalog(parsed.endpoint, settings.mode, { forceRefresh: true });
    if (catalog.errorMessage !== null) return { success: false, message: catalog.errorMessage };
    if (catalog.models.length === 0) {
      return { success: false, message: 'The local server responded but offers no models.' };
    }
    return {
      success: true,
      message: `Connected to ${parsed.endpoint.origin} — ${String(catalog.models.length)} model${catalog.models.length === 1 ? '' : 's'} available.`,
    };
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    // Nothing downstream can enable a hosted search for this provider, so a
    // request carrying the flag is not a capability mismatch to accommodate but
    // a forged or corrupted one. It is refused before a socket is opened.
    if (request.webSearch) {
      throw new InterleafError('validation', 'The local server does not support web search.');
    }

    const settings = this.readSettings();
    const parsed = parseLoopbackEndpoint(settings.endpoint);
    if (!parsed.ok) {
      throw new InterleafError('validation', LOOPBACK_ENDPOINT_MESSAGES[parsed.reason]);
    }
    const endpoint = parsed.endpoint;
    const models = (await this.catalog(endpoint, settings.mode)).models;
    const model = selectModel(models, request.modelId ?? settings.model);
    const reasoningEffort = localReasoningEffort(model, request.reasoningEffort);

    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    try {
      const body = JSON.stringify({
        model: model.id,
        stream: true,
        max_tokens: responseTokenLimit(request, model.maxOutputTokens),
        messages: [
          { role: 'system', content: request.systemPrompt },
          ...request.history.map((message) => ({ role: message.role, content: message.content })),
          { role: 'user', content: `${request.contextXml}\n\nUser question:\n${request.userMessage}` },
        ],
        ...(reasoningEffort === null ? {} : { reasoning_effort: reasoningEffort }),
        // No `tools`, `functions`, `tool_choice` or MCP field appears anywhere
        // in this body. A server may still volunteer a tool call; the parser
        // below treats that as a violation rather than as content.
      });

      const parser = new OpenAiDeltaStreamParser();
      let emitted = 0;
      for await (const line of loopbackStreamLines({
        endpoint,
        path: OPENAI_CHAT_PATH,
        method: 'POST',
        body,
        signal: controller.signal,
      })) {
        for (const token of parser.parseLine(line)) {
          emitted += 1;
          yield { type: 'token', token };
        }
        if (parser.done) break;
      }
      if (controller.signal.aborted) {
        throw new InterleafError('internal', 'The local response was cancelled.');
      }
      // A stream that simply stopped is not a finished answer. Requiring an
      // explicit terminal signal means a server killed mid-sentence surfaces as
      // a failure rather than being stored as the model's complete reply.
      parser.assertComplete();
      if (emitted === 0) {
        throw new InterleafError('internal', 'The local server returned an empty response.');
      }
      yield { type: 'done', totalTokens: emitted };
    } finally {
      this.active.delete(request.requestId);
    }
  }

  cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.abort();
    this.active.delete(requestId);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    return Promise.resolve();
  }

  private status(input: {
    readonly available: boolean;
    readonly installed: boolean;
    readonly authentication: AIProviderStatus['authentication'];
    readonly errorMessage: string | null;
    readonly models: readonly AIModelInfo[];
  }): AIProviderStatus {
    return {
      id: this.id,
      name: this.name,
      available: input.available,
      installed: input.installed,
      authentication: input.authentication,
      version: null,
      errorMessage: input.errorMessage,
      models: [...input.models],
      capabilities: this.capabilities,
    };
  }

  /**
   * Cached, single-flight catalog read. Every send re-checks provider status.
   *
   * Both the cache and the in-flight read are keyed by mode and origin. Sharing
   * one unkeyed in-flight promise would mean a status refresh issued straight
   * after an endpoint change could be answered by the request already running
   * against the *old* server, and then cached under the new endpoint's key — so
   * the user would be offered one server's models while talking to another.
   */
  private async catalog(
    endpoint: LoopbackEndpoint,
    mode: LocalEndpointMode,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<LocalCatalog> {
    const key = `${mode}|${endpoint.origin}`;
    if (options?.forceRefresh === true) {
      this.cached.delete(key);
      this.inFlight.delete(key);
      this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    } else {
      const hit = this.cached.get(key);
      if (hit !== undefined && Date.now() - hit.at < LOCAL_CATALOG_TTL_MS) return hit.catalog;
    }
    const generation = this.generation.get(key) ?? 0;
    const pending = this.inFlight.get(key) ?? this.start(key, endpoint, mode);
    const catalog = await pending;
    // Only the newest read for this key may publish a cache entry. An older one
    // describes the server as it was before the user asked to look again, and
    // reinstating it would undo the refresh they requested.
    if (generation === (this.generation.get(key) ?? 0)) {
      this.cached.set(key, { at: Date.now(), catalog });
    }
    return catalog;
  }

  /** Register a catalog read as this key's in-flight one, and clear it after. */
  private start(key: string, endpoint: LoopbackEndpoint, mode: LocalEndpointMode): Promise<LocalCatalog> {
    const pending = fetchLocalCatalog(endpoint, mode);
    this.inFlight.set(key, pending);
    void pending.catch(() => undefined).finally(() => {
      // Only if it is still the current one: a force refresh may already have
      // dropped this entry and started its replacement.
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    return pending;
  }
}

/**
 * Put the saved model at the head of the catalog.
 *
 * Every layer that has to choose a model without being told one — the chat
 * store creating a session, the provider registry resolving a null id — takes
 * the first entry. Ordering here is therefore what makes the user's saved
 * choice the actual default, in one place, instead of a new "default model"
 * field that each of those layers would have to be taught to respect and could
 * quietly stop respecting later.
 *
 * A saved model the server no longer publishes cannot be moved to the front,
 * and is deliberately not synthesised into the list: the catalog stays exactly
 * what the server offers, and `staleModelMessage` says so out loud.
 */
function preferSavedModel(
  models: readonly AIModelInfo[],
  saved: string | null,
): readonly AIModelInfo[] {
  if (saved === null || models.length === 0) return models;
  const index = models.findIndex((model) => model.id === saved);
  if (index <= 0) return models;
  return [...models.slice(index, index + 1), ...models.slice(0, index), ...models.slice(index + 1)];
}

/**
 * Said when the saved model is gone from the server that is answering now.
 *
 * The fallback — the server's first model — is stated rather than performed
 * silently, because the alternative is a user who chose an on-device model
 * being answered by whatever happens to be listed first, which on Ollama may be
 * a cloud-capable one. The saved identifier is never echoed back: it is
 * displayed in the Settings dropdown already, and this string is rendered.
 */
function staleModelMessage(models: readonly AIModelInfo[], saved: string | null): string | null {
  if (saved === null || models.length === 0) return null;
  if (models.some((model) => model.id === saved)) return null;
  return 'The model saved for this server is no longer available on it. Interleaf will use the first model listed below until you choose another.';
}

/** Pick the requested model, or fail rather than quietly substituting one. */
function selectModel(models: readonly AIModelInfo[], requested: string | null): AIModelInfo {
  if (models.length === 0) {
    throw new InterleafError('validation', 'The local server has no models available.');
  }
  if (requested === null) {
    const first = models[0];
    if (first === undefined) throw new InterleafError('validation', 'The local server has no models available.');
    return first;
  }
  const found = models.find((model) => model.id === requested);
  if (found === undefined) {
    throw new InterleafError('validation', 'The selected local model is no longer available on that server.');
  }
  return found;
}

async function fetchLocalCatalog(endpoint: LoopbackEndpoint, mode: LocalEndpointMode): Promise<LocalCatalog> {
  let response;
  try {
    response = await loopbackRequest({ endpoint, path: OPENAI_MODELS_PATH, method: 'GET' });
  } catch (error) {
    return { models: [], errorMessage: safeMessage(error instanceof Error ? error : null) };
  }
  if (response.status < 200 || response.status >= 300) {
    return { models: [], errorMessage: describeLoopbackStatus(response.status) };
  }
  const ids = parseOpenAiModelIds(response.body);
  if (mode !== 'ollama') {
    return { models: ids.map((id) => defaultModelInfo(id)), errorMessage: null };
  }
  return { models: await withOllamaContextWindows(endpoint, ids), errorMessage: null };
}

/**
 * Read `/v1/models`.
 *
 * Every identifier is untrusted text from another program: entries that are not
 * objects, ids that are empty, oversized, duplicated, or that contain control
 * characters are dropped rather than repaired, and the count is capped.
 */
export function parseOpenAiModelIds(body: string): readonly string[] {
  let payload: PortableValue;
  try {
    payload = parsePortableJson(body);
  } catch {
    return [];
  }
  const entries = (payload as { data?: PortableValue } | null)?.data;
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, LOCAL_MAX_CATALOG_ENTRIES)) {
    if (ids.length >= LOCAL_MAX_MODELS) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const raw = (entry as { id?: PortableValue }).id;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || id.length > LOCAL_MAX_MODEL_ID_LENGTH) continue;
    if (/[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The `reasoning_effort` value for one turn, or `null` for Default. The level
 * is checked against the levels this server's own `/api/show` advertised for
 * the model; Ollama's boolean thinking switch travels as `medium`/`none`.
 */
function localReasoningEffort(model: AIModelInfo, effort: ReasoningEffort | undefined): string | null {
  if (effort === undefined) return null;
  if (model.reasoning?.levels.includes(effort) !== true) {
    throw new InterleafError('validation', 'This model does not offer that reasoning effort. Choose another level or Default.');
  }
  if (effort === 'on') return 'medium';
  return effort === 'off' ? 'none' : effort;
}

function defaultModelInfo(id: string, contextWindow = LOCAL_DEFAULT_CONTEXT_WINDOW, reasoning: AIModelReasoning | null = null): AIModelInfo {
  return {
    ...(reasoning === null ? {} : { reasoning }),
    id,
    // The identifier is the name a local runtime uses and the one the user
    // typed when they pulled it, so inventing a prettier label would only make
    // the two disagree.
    name: id,
    contextWindow,
    maxOutputTokens: Math.min(LOCAL_DEFAULT_MAX_OUTPUT_TOKENS, contextWindow),
    supportsStreaming: true,
  };
}

/**
 * Ask Ollama for each model's real context window.
 *
 * `/api/show` is read-only metadata: it reports what a model already is and
 * neither loads it nor pulls it. It is worth the extra requests because the
 * OpenAI-compatible catalog carries no context length at all, and the
 * conservative fallback would otherwise cost most local models the majority of
 * their usable window. A model whose metadata is missing or unreadable simply
 * keeps that fallback.
 */
async function withOllamaContextWindows(
  endpoint: LoopbackEndpoint,
  ids: readonly string[],
): Promise<readonly AIModelInfo[]> {
  const models: AIModelInfo[] = [];
  for (const [index, id] of ids.entries()) {
    if (index >= LOCAL_MAX_METADATA_PROBES) {
      models.push(defaultModelInfo(id));
      continue;
    }
    const metadata = await readOllamaMetadata(endpoint, id);
    models.push(defaultModelInfo(id, metadata.contextWindow, metadata.reasoning));
  }
  return models;
}

type OllamaModelMetadata = { readonly contextWindow: number; readonly reasoning: AIModelReasoning | null };
const NO_OLLAMA_METADATA: OllamaModelMetadata = { contextWindow: LOCAL_DEFAULT_CONTEXT_WINDOW, reasoning: null };

async function readOllamaMetadata(endpoint: LoopbackEndpoint, id: string): Promise<OllamaModelMetadata> {
  try {
    const response = await loopbackRequest({
      endpoint,
      path: OLLAMA_SHOW_PATH,
      method: 'POST',
      body: JSON.stringify({ model: id }),
      timeoutMs: LOCAL_METADATA_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) return NO_OLLAMA_METADATA;
    return parseOllamaShow(response.body);
  } catch {
    return NO_OLLAMA_METADATA;
  }
}

/**
 * Pull the context length out of `/api/show`.
 *
 * Ollama namespaces the field by architecture — `qwen3.context_length`,
 * `llama.context_length` — so the key is matched by suffix rather than by a
 * list of architectures that would go stale with every new model family.
 */
export function parseOllamaContextWindow(body: string): number {
  return parseOllamaShow(body).contextWindow;
}

/**
 * Read the `/api/show` fields Reader Chat uses: the context length, and the
 * `thinking` levels the server advertises for this model. A server too old to
 * publish `thinking` offers Default only.
 */
export function parseOllamaShow(body: string): OllamaModelMetadata {
  let payload: PortableValue;
  try {
    payload = parsePortableJson(body);
  } catch {
    return NO_OLLAMA_METADATA;
  }
  if (!isPortableRecord(payload)) return NO_OLLAMA_METADATA;
  return { contextWindow: readContextLength(payload.model_info), reasoning: ollamaThinkingReasoning(payload.thinking) };
}

function readContextLength(info: PortableMember): number {
  if (!isPortableRecord(info)) return LOCAL_DEFAULT_CONTEXT_WINDOW;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
    return Math.min(value, LOCAL_MAX_CONTEXT_WINDOW);
  }
  return LOCAL_DEFAULT_CONTEXT_WINDOW;
}

/**
 * The OpenAI-compatible streaming format, read one line at a time.
 *
 * Only `choices[0].delta.content` becomes assistant text. That is a whitelist,
 * not a filter: `reasoning`, `reasoning_content`, `thinking` and any other
 * field a local runtime invents are simply not the branch that emits, so a
 * model's private scratchpad has no route to the renderer or to stored history
 * — which matters here because local reasoning models such as qwen3 emit those
 * fields by default.
 */
export class OpenAiDeltaStreamParser {
  /** Set once the stream signalled its own end. */
  done = false;

  parseLine(line: string): readonly string[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    // SSE framing. Comment and metadata lines carry no assistant text.
    if (!trimmed.startsWith('data:')) return [];
    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      this.done = true;
      return [];
    }
    let event: PortableValue;
    try {
      event = parsePortableJson(data);
    } catch {
      throw new InterleafError('validation', 'The local server sent a malformed response.');
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return [];
    const record = event as PortableRecord;
    if (typeof record.error === 'object' && record.error !== null) {
      throw new InterleafError('internal', 'The local server reported an error while generating.');
    }
    const choices: PortableMember = record.choices;
    if (!Array.isArray(choices)) return [];
    const choice: PortableMember = (choices as readonly PortableValue[])[0];
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) return [];
    const choiceRecord = choice as PortableRecord;

    const delta = choiceRecord.delta;
    const deltaRecord = typeof delta === 'object' && delta !== null && !Array.isArray(delta)
      ? (delta as PortableRecord)
      : null;
    // Reader Chat grants no tools, so a tool or function call is a violated
    // invariant rather than a shape to render or ignore.
    if (deltaRecord !== null && (deltaRecord.tool_calls !== undefined || deltaRecord.function_call !== undefined)) {
      throw new InterleafError('validation', 'The local server attempted an unsupported tool operation.');
    }
    const finish = choiceRecord.finish_reason;
    if (finish === 'tool_calls' || finish === 'function_call') {
      throw new InterleafError('validation', 'The local server attempted an unsupported tool operation.');
    }
    if (typeof finish === 'string' && finish.length > 0) this.done = true;

    const content = deltaRecord?.content;
    return typeof content === 'string' && content.length > 0 ? [content] : [];
  }

  assertComplete(): void {
    if (!this.done) {
      throw new InterleafError('internal', 'The local server ended its response before it was complete.');
    }
  }
}

/** Provider-safe error text; never the raw body a local server controls. */
function safeMessage(error: Error | null): string {
  return error instanceof InterleafError ? error.message : 'Interleaf could not reach the local server.';
}
