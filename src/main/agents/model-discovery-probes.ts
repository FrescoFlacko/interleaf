import type { AgentProviderId } from '@shared/types/agent';
import type { AgentModelDiscoverySource } from './model-discovery';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, parsePortableJson } from '@shared/models/portable';

/**
 * Reads one probe's stdout, one complete line at a time.
 *
 * `accept` returns the finished identifier list as soon as the answer is whole,
 * which lets a server-style protocol be stopped the moment it has replied. It
 * must never answer from a partial frame: the runner only ever hands it lines
 * that were terminated by a newline, plus (on a clean exit) the final
 * unterminated line. `finish` is called only after a clean, untruncated exit,
 * for listings whose answer is the output as a whole.
 */
export type ProbeCollector<T = readonly string[]> = {
  accept(line: string): T | null;
  finish(): T | null;
};

export type ProbeDefinition<T = readonly string[]> = {
  readonly args: readonly string[];
  readonly source: AgentModelDiscoverySource;
  /** Frames written to stdin, one per line, before reading begins. */
  readonly stdin?: readonly string[];
  /** Server-style protocols answer only while stdin stays open. */
  readonly keepStdinOpen?: boolean;
  readonly createCollector: () => ProbeCollector<T>;
};

/** Bounded request identifiers, so a reply can be matched to this probe only. */
export const CODEX_MODEL_LIST_ID = 2;
export const CLAUDE_REQUEST_ID = 'interleaf-model-discovery';
const CODEX_MODEL_LIST_LIMIT = 64;

const CODEX_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'interleaf', version: '1' } },
});
const CODEX_MODEL_LIST = JSON.stringify({
  jsonrpc: '2.0',
  id: CODEX_MODEL_LIST_ID,
  method: 'model/list',
  params: { limit: CODEX_MODEL_LIST_LIMIT },
});
const CLAUDE_LIST_MODELS = JSON.stringify({
  type: 'control_request',
  request_id: CLAUDE_REQUEST_ID,
  request: { subtype: 'list_models' },
});

/** The Codex `model/list` transport, shared with Reader Chat's own listing. */
export const CODEX_LISTING_TRANSPORT = {
  args: ['app-server', '--listen', 'stdio://'],
  source: 'app-server-rpc',
  stdin: [CODEX_INITIALIZE, CODEX_MODEL_LIST],
  keepStdinOpen: true,
} as const satisfies Omit<ProbeDefinition, 'createCollector'>;

/** The Claude `list_models` transport, shared with Reader Chat's own listing. */
export const CLAUDE_LISTING_TRANSPORT = {
  args: ['-p', '--bare', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--tools', ''],
  source: 'control-protocol',
  stdin: [CLAUDE_LIST_MODELS],
  keepStdinOpen: true,
} as const satisfies Omit<ProbeDefinition, 'createCollector'>;

/**
 * Per-provider listing mechanisms, each observed against the locally installed
 * CLI rather than assumed. `docs/CLI_CAPABILITIES.md` §7.9 records what each one
 * costs, what it reads, and what it does not guarantee.
 *
 * `copilot` has no entry on purpose: its accepted `--model` values appear only
 * in `--help` prose, and it is no longer a built-in profile (refused for
 * unattended Agent Mode), so a discovered list would unlock nothing.
 * `cursor` has no entry on purpose either: `cursor-agent` was wired from
 * Cursor's published CLI documentation without being run, so no listing
 * subcommand has been observed and guessing one would spawn an unverified
 * argv. Its models come from the user's own per-profile list until someone
 * probes the real binary.
 *
 * `custom` and `fake` are never probed — a custom profile's models are the
 * user's own configuration and the fixture is deterministic.
 */
export const PROBES: Partial<Record<AgentProviderId, ProbeDefinition>> = {
  // `codex app-server` speaks line-delimited JSON-RPC; `model/list` is declared
  // in its own `generate-json-schema` output and answers after `initialize`.
  // Entries carry both `id` and `model`; `model` is the value `--model` takes.
  codex: {
    ...CODEX_LISTING_TRANSPORT,
    createCollector: () => jsonFrameCollector(selectCodexModels),
  },
  // `--bare` is what keeps this a listing rather than a session: it suppresses
  // hooks, plugins, LSP, memory and CLAUDE.md discovery, so no project-owned or
  // user-owned extension is executed to read a local model list.
  'claude-code': {
    ...CLAUDE_LISTING_TRANSPORT,
    createCollector: () => jsonFrameCollector(selectClaudeModels),
  },
  // `agy models` prints `id<TAB>display name`. It refreshes the list over the
  // network; it does not run a model.
  antigravity: {
    args: ['models'],
    source: 'list-command',
    createCollector: () => wholeOutputCollector(takeTabbedIdentifier),
  },
  // `--pure` lists without loading external plugins. Identifiers are already
  // `provider/model`, which is the form `opencode --model` accepts.
  opencode: {
    args: ['--pure', 'models'],
    source: 'list-command',
    createCollector: () => wholeOutputCollector((line) => line.trim()),
  },
  // `--offline` keeps the listing local, and the `--no-*` flags stop project
  // extensions, skills, prompt templates, themes and context files from
  // loading. `pi --model` takes `provider/model`, which this table's first two
  // whitespace-aligned columns spell out.
  pi: {
    args: ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve', '--list-models'],
    source: 'list-command',
    createCollector: () => wholeOutputCollector(takePiTableIdentifier),
  },
};

/** Accumulates every line and answers once, at a clean end of output. */
function wholeOutputCollector(select: (line: string) => string): ProbeCollector {
  const models: string[] = [];
  const take = (line: string): void => {
    const model = select(line);
    if (model.length > 0) models.push(model);
  };
  return {
    accept: (line) => { take(line); return null; },
    finish: () => models,
  };
}

/** Answers from the first complete JSON frame the selector recognises. */
function jsonFrameCollector(select: (frame: PortableRecord) => readonly string[] | null): ProbeCollector {
  return {
    accept: (line) => {
      const frame = parseJsonObject(line);
      return frame === null ? null : select(frame);
    },
    finish: () => null,
  };
}

function selectCodexModels(frame: PortableRecord): readonly string[] | null {
  if (frame.id !== CODEX_MODEL_LIST_ID) return null;
  const data = asRecord(frame.result)?.data;
  if (!Array.isArray(data)) return null;
  return data.map(codexModelIdentifier).filter(isNonEmpty);
}

function codexModelIdentifier(entry: PortableValue): string {
  const record = asRecord(entry);
  const model = record?.model;
  if (typeof model === 'string') return model;
  return typeof record?.id === 'string' ? record.id : '';
}

function selectClaudeModels(frame: PortableRecord): readonly string[] | null {
  const response = asRecord(frame.response);
  if (response?.request_id !== CLAUDE_REQUEST_ID || response.subtype !== 'success') return null;
  const models = asRecord(response.response)?.models;
  if (!isPortableArray(models)) return null;
  // `value` is what `--model` accepts; `resolvedModel` is the snapshot it
  // currently points at and is deliberately not offered as a choice.
  return models.map((entry) => stringField(entry, 'value')).filter(isNonEmpty);
}

/** `agy models` rows are `id<TAB>display name`; prose lines carry no tab. */
function takeTabbedIdentifier(line: string): string {
  const tab = line.indexOf('\t');
  return tab <= 0 ? '' : line.slice(0, tab).trim();
}

/** `pi --list-models` prints `provider  model  context …`, header row first. */
function takePiTableIdentifier(line: string): string {
  const [provider, model] = line.trim().split(/\s{2,}/u);
  if (provider === undefined || model === undefined) return '';
  return provider === 'provider' && model === 'model' ? '' : `${provider}/${model}`;
}

function stringField(entry: PortableValue, field: string): string {
  const value = asRecord(entry)?.[field];
  return typeof value === 'string' ? value : '';
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}

function parseJsonObject(line: string): PortableRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return asRecord(parsePortableJson(trimmed));
  } catch {
    // Diagnostics and progress frames share this stream; a line that is not
    // valid JSON is skipped rather than failing the probe.
    return null;
  }
}

function asRecord(value: PortableMember): PortableRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as PortableRecord
    : null;
}
