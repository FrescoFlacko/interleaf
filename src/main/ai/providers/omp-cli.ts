/**
 * Omp CLI adapter for Reader Chat.
 *
 * Omp ("Oh My Pi") is Pi's successor and shares its `--mode json` event
 * vocabulary, so the event parsing and the tool-use detector are the shared
 * ones in `agent-json-stream`. What differs — and what lives here — is Omp's
 * flag surface, its richer model-selector grammar, and the fact that it
 * publishes a machine-readable catalog instead of a text table.
 *
 * The safety claim for this provider is narrower than Pi's, and is stated
 * narrowly on purpose. Omp has no `--offline` flag, so no claim is made that
 * its startup, update or telemetry traffic is suppressed. What is enforced is
 * that the turn is **tool-free**: `--no-tools`, `--no-lsp`, `--no-pty`,
 * `--no-extensions`, `--no-skills`, `--no-rules` remove every built-in tool and
 * every externally owned extension, skill and rule; `--no-session` and
 * `--no-title` keep the turn ephemeral; the process runs in a private empty
 * app-owned directory so there is no project context to discover; and
 * Interleaf grants no filesystem or tool-execution capability of its own. Any
 * tool-shaped event that appears anyway aborts the turn.
 *
 * Omp's stdout is untrusted external process output throughout: the catalog and
 * the event stream are parsed and validated, never trusted, and never logged
 * raw.
 */
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../../logging/logger';
import { AgentJsonStreamParser } from './agent-json-stream';
import { ompEntryReasoning } from './reasoning-metadata';
import { buildAllowlistedEnvironment } from './cli-runtime';
import type { CliExecFile } from './cli-ai-provider';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, parsePortableJson } from '@shared/models/portable';

/** Probe timeout. The catalog listing is a local read and returns quickly. */
const OMP_PROBE_TIMEOUT_MS = 10_000;
/** How long a successful catalog probe may answer a repeated status request. */
const OMP_CATALOG_TTL_MS = 30_000;
/**
 * Bound on the catalog payload. Omp's listing is far larger than the shared
 * diagnostic budget — around 185 KB for ~590 models on the development machine
 * — so it gets its own limit, generous enough for growth and still a hard cap
 * on what an unexpected payload can make Interleaf buffer.
 */
const OMP_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Models exposed to the renderer. Omp publishes several hundred, but the AI
 * provider status contract carries at most 128, so the list is trimmed here
 * rather than being rejected downstream for overflowing that schema.
 */
const OMP_MAX_MODELS = 128;
/** Entries read from one listing before the rest is discarded unparsed. */
const OMP_MAX_CATALOG_ENTRIES = 4_096;
/** Longest system prompt Omp may receive as a single argv token. */
const OMP_MAX_SYSTEM_PROMPT_UNITS = 8_192;
/**
 * Longest model selector accepted, matching `modelIdSchema` in the shared AI
 * contract.
 *
 * Anything longer could be validated here and then rejected when the session
 * row that must store it is written, so a selector Omp would accept but
 * Interleaf cannot persist is refused at the point it is read instead of
 * failing later. The longest selector Omp's own catalog publishes is far under
 * this.
 */
const OMP_MAX_SELECTOR_LENGTH = 128;
const OMP_MAX_DISPLAY_NAME_LENGTH = 128;
const OMP_DEFAULT_CONTEXT_WINDOW = 128_000;
const OMP_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const OMP_MAX_CONTEXT_WINDOW = 2_000_000;
const OMP_MAX_OUTPUT_TOKENS = 200_000;

/**
 * Catalog argv.
 *
 * `--no-extensions` keeps the listing from loading extension code owned by a
 * project or another user just to enumerate models. The listing reads local
 * configuration only: it starts no model, runs no inference, and prints no
 * credential — Omp filters the catalog down to providers the user is already
 * signed in to, which is exactly the readiness signal Interleaf needs and
 * nothing more.
 */
export const OMP_LIST_MODELS_ARGS: readonly string[] = ['models', '--json', '--no-extensions'];

/**
 * Chat flags.
 *
 * `--mode json` + `--print` is the structured non-interactive surface. The
 * `--no-*` flags disable, in order: every built-in tool, the LSP tool and
 * diagnostics surface, PTY-based interactive bash, extension discovery, skill
 * discovery, rule discovery, session persistence, and title auto-generation.
 *
 * `--approval-mode always-ask` is a backstop rather than the control: with
 * `--no-tools` there is nothing left to approve, but if a future Omp version
 * were to expose a tool through some path these flags do not cover, the
 * fallback is a prompt that this non-interactive process can never answer —
 * never a silent execution. Note what is deliberately absent: Omp has no
 * `--offline`, so unlike Pi this argv makes no claim about suppressing the
 * CLI's own non-inference network traffic.
 */
export const OMP_CHAT_FLAGS: readonly string[] = [
  '--mode', 'json', '--print', '--no-tools', '--no-lsp', '--no-pty',
  '--no-extensions', '--no-skills', '--no-rules', '--no-session', '--no-title',
  '--approval-mode', 'always-ask',
];

/**
 * Omp's `provider/id` selector grammar.
 *
 * It is looser than Pi's because Omp's identifiers genuinely are: the model
 * part carries colons (`ollama/qwen3:8b`), embedded slashes
 * (`ollama/hf.co/user/repo-GGUF:BF16`) and a leading `~` alias marker
 * (`openrouter/~anthropic/claude-sonnet-latest`). The provider segment stays
 * strict.
 *
 * The pattern is anchored and excludes whitespace, `=`, and any leading `-`, so
 * a selector that passes is always exactly one argv token that cannot be read
 * as an option. It is a shape check only: {@link buildOmpChatArgs} additionally
 * requires the selector to be one the catalog actually published, so a
 * well-formed identifier the user's account cannot use never reaches Omp.
 */
const OMP_SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})\/[A-Za-z0-9~](?:[A-Za-z0-9._:~/-]{0,126})$/u;

export function isOmpModelSelector(value: string): boolean {
  return value.length <= OMP_MAX_SELECTOR_LENGTH && OMP_SELECTOR_PATTERN.test(value);
}

/**
 * Build Omp's argv for one Reader Chat turn.
 *
 * The document, the conversation history and the question are never
 * interpolated here: they travel on stdin. Only the app-owned Reader AI system
 * prompt and a validated, catalog-backed model selector become argv tokens.
 */
export function buildOmpChatArgs(input: {
  readonly modelId: string | null;
  readonly models: readonly AIModelInfo[];
  readonly systemPrompt: string;
  readonly chatRoot: string;
}): readonly string[] {
  const modelId = input.modelId ?? input.models[0]?.id ?? null;
  if (modelId === null || !isOmpModelSelector(modelId) || !input.models.some((model) => model.id === modelId)) {
    throw new Error('omp-model-unavailable');
  }
  if (input.systemPrompt.length === 0 || input.systemPrompt.length > OMP_MAX_SYSTEM_PROMPT_UNITS) {
    throw new Error('omp-system-prompt-invalid');
  }
  return [
    ...OMP_CHAT_FLAGS,
    // Replaces Omp's coding-assistant prompt outright rather than adding to it.
    '--system-prompt', input.systemPrompt,
    // Omp otherwise appends discovered global/project system text to whatever
    // prompt is in force. An explicit empty value takes that precedence slot so
    // no externally owned text can extend the Reader AI prompt.
    '--append-system-prompt', '',
    // The process is already spawned in this private empty app-owned directory;
    // naming it explicitly means Omp's own project resolution cannot fall back
    // to the launch directory if that ever changes.
    '--cwd', input.chatRoot,
    '--model', modelId,
  ];
}

/**
 * Omp's event stream, with terminal completion required.
 *
 * Omp exits 0 after writing an unfinished stream in some abort paths, so exit
 * status alone would let a truncated answer be stored as a complete one.
 * Requiring `agent_end`/`turn_end` makes the turn fail closed instead, with a
 * message that says the response was incomplete rather than exposing anything
 * about the process that produced it.
 */
export class OmpStreamParser extends AgentJsonStreamParser {
  constructor() {
    super({
      requireCompletion: true,
      providerName: 'Omp',
      onIncomplete: () => {
        throw new InterleafError('validation', 'Omp ended its response before it was complete.');
      },
    });
  }
}

export type OmpCatalog = {
  readonly authentication: AIProviderStatus['authentication'];
  readonly models: readonly AIModelInfo[];
};

/**
 * Parse `omp models --json`.
 *
 * Every field is treated as untrusted: entries that are not objects, whose
 * selector fails the grammar, or that duplicate an already-accepted selector
 * are dropped; names are trimmed and bounded; token counts are clamped and fall
 * back to conservative defaults rather than being believed. The scan itself is
 * bounded, so an oversized listing costs a bounded amount of work.
 */
export function parseOmpModelCatalog(stdout: string): readonly AIModelInfo[] {
  let payload: PortableValue;
  try {
    payload = parsePortableJson(stdout);
  } catch {
    return [];
  }
  const entries = (payload as { models?: PortableValue } | null)?.models;
  if (!isPortableArray(entries)) return [];

  // Grouped by provider so the 128-model budget is shared out rather than
  // consumed by whichever provider happens to sort first — one provider
  // publishing 500 models must not hide the others the user is signed in to.
  const byProvider = new Map<string, AIModelInfo[]>();
  const seen = new Set<string>();
  for (const entry of entries.slice(0, OMP_MAX_CATALOG_ENTRIES)) {
    const model = readCatalogEntry(entry);
    if (model === null || seen.has(model.info.id)) continue;
    seen.add(model.info.id);
    const bucket = byProvider.get(model.provider);
    if (bucket === undefined) byProvider.set(model.provider, [model.info]);
    else bucket.push(model.info);
  }

  const buckets = [...byProvider.values()];
  const models: AIModelInfo[] = [];
  for (let index = 0; models.length < OMP_MAX_MODELS; index += 1) {
    const round = buckets.filter((bucket) => bucket.length > index);
    if (round.length === 0) break;
    for (const bucket of round) {
      if (models.length >= OMP_MAX_MODELS) break;
      const info = bucket[index];
      if (info !== undefined) models.push(info);
    }
  }
  return models;
}

function readCatalogEntry(value: PortableValue): { readonly provider: string; readonly info: AIModelInfo } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as PortableRecord;
  const selector = typeof entry.selector === 'string' ? entry.selector.trim() : '';
  if (!isOmpModelSelector(selector)) return null;
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
  if (provider.length === 0 || provider.length > 64) return null;
  const reasoning = ompEntryReasoning(entry);
  return {
    provider,
    info: {
      ...(reasoning === null ? {} : { reasoning }),
      id: selector,
      // Omp's display name is only a label, but it is still external text, so
      // it is trimmed and bounded; the selector is the fallback because it is
      // already validated.
      name: readDisplayName(entry.name) ?? selector,
      contextWindow: clampTokens(entry.contextWindow, OMP_DEFAULT_CONTEXT_WINDOW, OMP_MAX_CONTEXT_WINDOW),
      maxOutputTokens: clampTokens(entry.maxTokens, OMP_DEFAULT_MAX_OUTPUT_TOKENS, OMP_MAX_OUTPUT_TOKENS),
      supportsStreaming: true,
    },
  };
}

function readDisplayName(value: PortableMember): string | null {
  if (typeof value !== 'string') return null;
  // Control characters would let a catalog entry disturb the rendered list.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, OMP_MAX_DISPLAY_NAME_LENGTH);
}

/** A positive integer token count, clamped; anything else takes the default. */
function clampTokens(value: PortableMember, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

export type OmpProbeContext = {
  readonly binary: string;
  readonly executeFile: CliExecFile;
  /** App-owned directory the probe runs in; never a user project root. */
  readonly cwd: string;
  readonly log: Logger;
};

/**
 * Create the Omp catalog probe.
 *
 * Readiness is established without emitting a credential, without revealing
 * auth data and without starting an inference call. Omp already filters its
 * listing to providers the user is signed in to, so a non-empty catalog *is*
 * the readiness signal; an empty one means signed out, and a failed probe means
 * unknown rather than either. Results are cached briefly because every send
 * re-checks provider status.
 */
export function createOmpCatalogProbe(): (context: OmpProbeContext) => Promise<OmpCatalog> {
  let cached: { readonly key: string; readonly at: number; readonly catalog: OmpCatalog } | null = null;
  let inFlight: Promise<OmpCatalog> | null = null;
  return async (context) => {
    const now = Date.now();
    if (cached !== null && cached.key === context.binary && now - cached.at < OMP_CATALOG_TTL_MS) {
      return cached.catalog;
    }
    inFlight ??= probeOmpCatalog(context).finally(() => { inFlight = null; });
    const catalog = await inFlight;
    if (catalog.models.length > 0) cached = { key: context.binary, at: Date.now(), catalog };
    return catalog;
  };
}

async function probeOmpCatalog(context: OmpProbeContext): Promise<OmpCatalog> {
  let stdout: string;
  try {
    const result = await context.executeFile(context.binary, OMP_LIST_MODELS_ARGS, {
      cwd: context.cwd,
      timeout: OMP_PROBE_TIMEOUT_MS,
      maxBuffer: OMP_CATALOG_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
      env: buildAllowlistedEnvironment(),
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch {
    // Deliberately no error detail: probe failures are logged as a reason code,
    // never as CLI output that could carry account or path information.
    context.log.warn('Omp model listing probe failed', { providerId: 'omp', reason: 'probe-failed' });
    return { authentication: 'unknown', models: [] };
  }
  const models = parseOmpModelCatalog(stdout);
  return { authentication: models.length > 0 ? 'connected' : 'disconnected', models };
}
