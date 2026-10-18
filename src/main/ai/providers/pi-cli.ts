/**
 * Pi CLI adapter for Reader Chat.
 *
 * Pi 0.84.4 is the one installed subscription-backed CLI that exposes an
 * enforceable tool-disable surface: `--no-tools` removes every built-in,
 * extension and custom tool, and the companion `--no-*` flags stop Pi from
 * discovering project- or user-owned extensions, skills, prompt templates,
 * themes and context files. That is what makes a genuinely tool-free Reader
 * Chat transport possible here, unlike the constrained Codex path in ADR 0005.
 *
 * Everything in this module treats Pi's stdout as untrusted external process
 * output: model listings, auth verdicts and JSON events are parsed and
 * validated, never trusted, and never logged raw.
 */
import { toError } from '@shared/models/caught-error';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import type { Logger } from '../../logging/logger';
import {
  agentJsonToolActivity,
  AgentJsonStreamParser,
  parseJsonRecord,
} from './agent-json-stream';
import { buildAllowlistedEnvironment, CLI_DIAGNOSTIC_MAX_BYTES } from './cli-runtime';
import type { CliExecFile } from './cli-ai-provider';

/** Probe timeout. Pi's listing and auth checks are local and quick. */
const PI_PROBE_TIMEOUT_MS = 10_000;
/** How long a successful catalog probe may answer a repeated status request. */
const PI_CATALOG_TTL_MS = 30_000;
/** Model rows accepted from one listing, and providers probed for readiness. */
const PI_MAX_MODELS = 64;
const PI_MAX_AUTH_PROBES = 8;
/** Longest system prompt Pi may receive as a single argv token. */
const PI_MAX_SYSTEM_PROMPT_UNITS = 8_192;
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const PI_MAX_CONTEXT_WINDOW = 2_000_000;
const PI_MAX_OUTPUT_TOKENS = 200_000;
/**
 * The one rejection `pi auth check` is documented to produce for a provider
 * that is simply not signed in: a plain nonzero exit that still prints the
 * JSON verdict. Every other failure mode is a fail-closed `unknown`.
 */
const PI_AUTH_NOT_READY_EXIT_CODE = 1;

/**
 * Discovery flags. They keep the listing local (`--offline`) and stop Pi from
 * loading anything a project directory or another user could own.
 */
export const PI_LIST_MODELS_ARGS: readonly string[] = [
  '--offline', '--no-extensions', '--no-skills', '--no-context-files',
  '--no-prompt-templates', '--no-themes', '--no-approve', '--list-models',
];

/**
 * Readiness probe argv. `--no-refresh` keeps the check from performing an OAuth
 * refresh, and `--credentials` is deliberately never passed: Interleaf asks
 * whether a provider is usable, never for the credential itself.
 */
export function buildPiAuthCheckArgs(provider: string): readonly string[] {
  return ['auth', 'check', '--provider', provider, '--json', '--no-refresh'];
}

/**
 * Chat flags, in the order Pi's own help documents them.
 *
 * `--mode json` + `--print` is the structured non-interactive surface;
 * `--no-tools` disables every tool; the remaining `--no-*` flags disable
 * discovery of externally owned extensions, skills, prompt templates, themes,
 * context files and project trust; `--no-session` keeps the turn ephemeral;
 * and `--offline` suppresses Pi's startup, update, catalog and telemetry
 * traffic. `--offline` does **not** disable the model request itself — the
 * selected remote provider is still called, which is the whole point of the
 * turn.
 */
export const PI_CHAT_FLAGS: readonly string[] = [
  '--mode', 'json', '--print', '--no-tools', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-session',
  '--no-approve', '--offline',
];

/**
 * `provider/model`, the identifier Pi's own listing prints and its `--model`
 * flag accepts. Anchored, so a validated identifier is always one argv token
 * with no separators, whitespace or option-looking prefix.
 */
const PI_MODEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})\/[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

export function isPiModelId(value: string): boolean {
  return PI_MODEL_ID_PATTERN.test(value);
}

/**
 * Build Pi's argv for one Reader Chat turn.
 *
 * The document, the conversation history and the question are never
 * interpolated here: they travel on stdin. Only the app-owned Reader AI system
 * prompt and a validated model identifier become argv tokens.
 */
export function buildPiChatArgs(input: {
  readonly modelId: string | null;
  readonly models: readonly AIModelInfo[];
  readonly systemPrompt: string;
}): readonly string[] {
  const modelId = input.modelId ?? input.models[0]?.id ?? null;
  if (modelId === null || !isPiModelId(modelId) || !input.models.some((model) => model.id === modelId)) {
    throw new Error('pi-model-unavailable');
  }
  if (input.systemPrompt.length === 0 || input.systemPrompt.length > PI_MAX_SYSTEM_PROMPT_UNITS) {
    throw new Error('pi-system-prompt-invalid');
  }
  return [
    ...PI_CHAT_FLAGS,
    // Replaces Pi's coding-assistant prompt outright rather than adding to it.
    '--system-prompt', input.systemPrompt,
    // Pi otherwise appends a discovered global/project APPEND_SYSTEM.md to
    // whatever prompt is in force. An explicit empty value takes that
    // precedence slot so no externally owned text can extend the Reader AI
    // prompt.
    '--append-system-prompt', '',
    '--model', modelId,
  ];
}

/**
 * Pi's tool-activity detector and event parser are the shared ones.
 *
 * Omp is Pi's successor and emits the same `--mode json` event vocabulary, so
 * both adapters read that stream through `agent-json-stream` rather than
 * keeping two copies of the same structural checks. Pi's own names are kept as
 * the module's public surface: this file remains where Pi's behaviour is
 * described, and its callers and tests do not need to know the parsing moved.
 */
export const piToolActivity = agentJsonToolActivity;

/**
 * Pi's documented JSON event stream (`docs/json.md`, 0.84.4).
 *
 * Terminal-event enforcement is deliberately not enabled here. Pi shipped
 * without it and its turns are already accepted on exit status alone; turning
 * it on now would change when existing Pi conversations fail, which is a
 * separate decision from adding Omp. Omp opts in from the start.
 */
export class PiStreamParser extends AgentJsonStreamParser {}

export type PiCatalog = {
  readonly authentication: AIProviderStatus['authentication'];
  readonly models: readonly AIModelInfo[];
};

type PiModelRow = { readonly provider: string; readonly id: string; readonly model: AIModelInfo };

/**
 * Parse Pi's whitespace-aligned `--list-models` table.
 *
 * The header row and any row whose identifier fails validation are dropped, so
 * only identifiers that can safely become a single `--model` token survive.
 */
export function parsePiModelTable(stdout: string): readonly PiModelRow[] {
  const rows: PiModelRow[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (rows.length >= PI_MAX_MODELS) break;
    const columns = line.trim().split(/\s+/u);
    const provider = columns[0];
    const name = columns[1];
    if (provider === undefined || name === undefined || provider === 'provider') continue;
    const id = `${provider}/${name}`;
    if (!isPiModelId(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      provider,
      id,
      model: {
        id,
        name: id,
        contextWindow: parseTokenCount(columns[2], PI_DEFAULT_CONTEXT_WINDOW, PI_MAX_CONTEXT_WINDOW),
        maxOutputTokens: parseTokenCount(columns[3], PI_DEFAULT_MAX_OUTPUT_TOKENS, PI_MAX_OUTPUT_TOKENS),
        supportsStreaming: true,
      },
    });
  }
  return rows;
}

/** `272K` / `1.5M` / `128000` from Pi's table, bounded and never guessed wider. */
function parseTokenCount(value: string | undefined, fallback: number, maximum: number): number {
  const match = /^(\d{1,7})(?:\.(\d))?([KM])?$/u.exec(value ?? '');
  if (match === null) return fallback;
  const whole = Number(match[1]);
  const fraction = match[2] === undefined ? 0 : Number(match[2]) / 10;
  const scale = match[3] === 'M' ? 1_000_000 : match[3] === 'K' ? 1_000 : 1;
  const total = Math.round((whole + fraction) * scale);
  if (!Number.isSafeInteger(total) || total <= 0) return fallback;
  return Math.min(total, maximum);
}

/**
 * Classify one `pi auth check --json` result for the provider that was asked
 * about. Anything else — another provider's verdict, an unknown status, a
 * non-object, unparseable text — is `unknown` rather than ready.
 */
export function parsePiAuthCheck(stdout: string, provider: string): 'ready' | 'not-ready' | 'unknown' {
  const record = parseJsonRecord(stdout);
  if (record?.provider !== provider) return 'unknown';
  if (record.status === 'ready') return 'ready';
  return record.status === 'not_ready' ? 'not-ready' : 'unknown';
}

export type PiProbeContext = {
  readonly binary: string;
  readonly executeFile: CliExecFile;
  /** App-owned directory the probes run in; never a user project root. */
  readonly cwd: string;
  readonly log: Logger;
};

/**
 * Create the Pi catalog probe.
 *
 * Readiness is established without emitting a credential and without starting
 * an inference call: a local model listing, then one bounded `auth check` per
 * discovered Pi model provider. Only models belonging to a provider that
 * answered `ready` are exposed, so the developer machine's own account or
 * model selection is never assumed to be universal. Results are cached briefly
 * because every send re-checks provider status.
 */
export function createPiCatalogProbe(): (context: PiProbeContext) => Promise<PiCatalog> {
  let cached: { readonly key: string; readonly at: number; readonly catalog: PiCatalog } | null = null;
  let inFlight: Promise<PiCatalog> | null = null;
  return async (context) => {
    const now = Date.now();
    if (cached !== null && cached.key === context.binary && now - cached.at < PI_CATALOG_TTL_MS) {
      return cached.catalog;
    }
    inFlight ??= probePiCatalog(context).finally(() => { inFlight = null; });
    const catalog = await inFlight;
    if (catalog.models.length > 0) cached = { key: context.binary, at: Date.now(), catalog };
    return catalog;
  };
}

async function probePiCatalog(context: PiProbeContext): Promise<PiCatalog> {
  const listingResult = await runPiProbe(context, PI_LIST_MODELS_ARGS);
  const listing = listingResult.ok ? listingResult.stdout : null;
  if (listing === null) {
    context.log.warn('Pi model listing probe failed', { providerId: 'pi', reason: 'probe-failed' });
    return { authentication: 'unknown', models: [] };
  }
  const rows = parsePiModelTable(listing);
  const providers = [...new Set(rows.map((row) => row.provider))].slice(0, PI_MAX_AUTH_PROBES);
  const verdicts = new Map<string, 'ready' | 'not-ready' | 'unknown'>();
  for (const provider of providers) {
    verdicts.set(provider, await probePiProviderAuth(context, provider));
  }
  const models = rows.filter((row) => verdicts.get(row.provider) === 'ready').map((row) => row.model);
  return { authentication: resolvePiAuthentication(models.length, [...verdicts.values()]), models };
}

function resolvePiAuthentication(
  readyModelCount: number,
  verdicts: readonly ('ready' | 'not-ready' | 'unknown')[],
): AIProviderStatus['authentication'] {
  if (readyModelCount > 0) return 'connected';
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'not-ready')) return 'disconnected';
  return 'unknown';
}

/**
 * Ask whether one Pi model provider is usable, fail closed on any doubt.
 *
 * `ready` is only ever concluded from a clean exit 0. `pi auth check` also
 * exits nonzero while printing a valid verdict for a provider that is simply
 * not signed in, so that one rejection shape — an ordinary exit 1 with no
 * signal, no kill and no timeout or `maxBuffer` abort — is parsed too, but it
 * can only downgrade the answer: a `ready` payload smuggled in by a killed,
 * timed-out, truncated or arbitrarily-failing process is `unknown`, never
 * connected.
 */
async function probePiProviderAuth(context: PiProbeContext, provider: string): Promise<'ready' | 'not-ready' | 'unknown'> {
  const result = await runPiProbe(context, buildPiAuthCheckArgs(provider));
  if (result.ok) return parsePiAuthCheck(result.stdout, provider);
  if (!isPiNotReadyRejection(result.failure)) {
    context.log.warn('Pi auth check probe failed', { providerId: 'pi', reason: 'probe-failed' });
    return 'unknown';
  }
  return parsePiAuthCheck(result.failure.stdout ?? '', provider) === 'not-ready' ? 'not-ready' : 'unknown';
}

/** Details of a rejected probe, read only to classify the failure. */
type PiProbeFailure = {
  readonly stdout: string | null;
  /** The exit status, or the `errno` string when the process never ran. */
  readonly code: number | string | null;
  readonly signal: NodeJS.Signals | null;
  readonly killed: boolean;
};

/**
 * What `child_process` attaches to the error it throws for a failed run: the
 * captured output plus how the process ended. Every member is optional because
 * an unrelated failure — a missing executable, a rejected environment — throws
 * a plain `Error`.
 */
type SpawnFailure = Error & {
  readonly stdout?: string;
  readonly code?: number | string;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;
};

type PiProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly failure: PiProbeFailure };

/**
 * Exactly the documented not-ready rejection: the process ran to completion on
 * its own and exited 1. A timeout or `maxBuffer` abort sets `killed`/`signal`
 * or a string `code`, and any other exit status is an unexplained failure.
 */
function isPiNotReadyRejection(failure: PiProbeFailure): boolean {
  return !failure.killed
    && failure.signal === null
    && failure.code === PI_AUTH_NOT_READY_EXIT_CODE
    && typeof failure.stdout === 'string';
}

async function runPiProbe(context: PiProbeContext, args: readonly string[]): Promise<PiProbeResult> {
  try {
    const result = await context.executeFile(context.binary, args, {
      cwd: context.cwd,
      timeout: PI_PROBE_TIMEOUT_MS,
      maxBuffer: CLI_DIAGNOSTIC_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
      env: buildAllowlistedEnvironment(),
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return { ok: false, failure: readPiProbeFailure(error instanceof Error ? error : null) };
  }
}

function readPiProbeFailure(caught: Error | null): PiProbeFailure {
  const failure: SpawnFailure = toError(caught);
  return {
    stdout: typeof failure.stdout === 'string' ? failure.stdout : null,
    code: failure.code ?? null,
    signal: failure.signal ?? null,
    killed: failure.killed ?? false,
  };
}
