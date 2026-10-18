import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import type { AIModelInfo, AIModelReasoning } from '@shared/types/ai';
import { type PortableMember, type PortableRecord, isPortableArray, isPortableRecord, parsePortableJson } from '@shared/models/portable';
import {
  CLAUDE_LISTING_TRANSPORT,
  CLAUDE_REQUEST_ID,
  CODEX_LISTING_TRANSPORT,
  CODEX_MODEL_LIST_ID,
  type ProbeCollector,
  type ProbeDefinition,
} from '../agents/model-discovery-probes';
import { type ProbeRequest, binaryIdentityKey, runBoundedProbe } from '../agents/model-discovery';
import { isPiModelId } from './providers/pi-cli';
import { claudeEntryReasoning, codexEntryReasoning, piEntryReasoning } from './providers/reasoning-metadata';
import type { Logger } from '../logging/logger';

/** One model a Reader Chat CLI listed, with the reasoning levels it published. */
type ListedChatModel = {
  readonly id: string;
  readonly reasoning: AIModelReasoning | null;
};

/**
 * What one bounded listing read. `defaultReasoning` belongs to the entry the
 * CLI marks as its own default, which is what the provider sentinel runs on.
 */
export type ChatModelListing = {
  readonly models: readonly ListedChatModel[];
  readonly defaultReasoning: AIModelReasoning | null;
};

export type ListedChatProvider = 'codex' | 'claude' | 'pi';

/** The seam CLI chat providers depend on, so tests never spawn a real CLI. */
export type ChatModelLister = {
  list(providerId: ListedChatProvider, binaryPath: string): Promise<ChatModelListing | null>;
  /** Cancels every in-flight listing and resolves once each child is cleaned up. */
  close(): Promise<void>;
};

/**
 * Listed entries kept from one answer, and the most models one provider status
 * carries with its sentinel; a longer listing is truncated, not trusted further.
 */
export const MAX_LISTED_CHAT_MODELS = 128;
const LISTING_TTL_MS = 30 * 60 * 1000;
const PI_REQUEST_ID = 'interleaf-chat-models';

type EntryReader = (entry: PortableRecord) => { readonly id: string; readonly reasoning: AIModelReasoning | null } | null;

/** Bounds, dedupes and validates entries; a malformed entry is dropped, not repaired. */
function readListing(entries: PortableMember, read: EntryReader, isDefault: (entry: PortableRecord) => boolean): ChatModelListing | null {
  if (!isPortableArray(entries)) return null;
  const models: ListedChatModel[] = [];
  const seen = new Set<string>();
  let defaultReasoning: AIModelReasoning | null = null;
  for (const entry of entries.slice(0, MAX_LISTED_CHAT_MODELS)) {
    if (!isPortableRecord(entry)) continue;
    const model = read(entry);
    if (model === null) continue;
    if (isDefault(entry)) defaultReasoning = model.reasoning;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { models, defaultReasoning };
}

function readFrame(line: string): PortableRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = parsePortableJson(trimmed);
    return isPortableRecord(value) ? value : null;
  } catch {
    // Diagnostics share the stream; a line that is not JSON is skipped.
    return null;
  }
}

function frameCollector(select: (frame: PortableRecord) => ChatModelListing | null): ProbeCollector<ChatModelListing> {
  return {
    accept: (line) => {
      const frame = readFrame(line);
      return frame === null ? null : select(frame);
    },
    finish: () => null,
  };
}

function agentEntry(candidate: PortableMember, reasoning: AIModelReasoning | null): ReturnType<EntryReader> {
  const id = candidate ?? null;
  return isAgentModelIdentifier(id) ? { id, reasoning } : null;
}

function selectCodex(frame: PortableRecord): ChatModelListing | null {
  if (frame.id !== CODEX_MODEL_LIST_ID || !isPortableRecord(frame.result)) return null;
  return readListing(
    frame.result.data,
    (entry) => agentEntry(typeof entry.model === 'string' ? entry.model : entry.id, codexEntryReasoning(entry)),
    (entry) => entry.isDefault === true,
  );
}

function selectClaude(frame: PortableRecord): ChatModelListing | null {
  const response = frame.response;
  if (!isPortableRecord(response) || response.request_id !== CLAUDE_REQUEST_ID || response.subtype !== 'success') return null;
  const body = response.response;
  return readListing(
    isPortableRecord(body) ? body.models : undefined,
    (entry) => agentEntry(entry.value, claudeEntryReasoning(entry)),
    // `default` is the alias the CLI itself runs when no `--model` is given.
    (entry) => entry.value === 'default',
  );
}

function selectPi(frame: PortableRecord): ChatModelListing | null {
  if (frame.type !== 'response' || frame.id !== PI_REQUEST_ID || frame.command !== 'get_available_models') return null;
  if (frame.success !== true || !isPortableRecord(frame.data)) return null;
  return readListing(
    frame.data.models,
    (entry) => {
      if (typeof entry.provider !== 'string' || typeof entry.id !== 'string') return null;
      const id = `${entry.provider}/${entry.id}`;
      return isPiModelId(id) ? { id, reasoning: piEntryReasoning(entry) } : null;
    },
    () => false,
  );
}

/**
 * The listing transports. Codex and Claude reuse the agent runtime's verified
 * listing calls. Pi's is its RPC mode asked for `get_available_models` only:
 * a metadata command that starts no turn, with the same `--offline`,
 * `--no-session` and project-extension hardening as Pi's other probes.
 */
export const CHAT_LISTING_PROBES: Readonly<Record<ListedChatProvider, ProbeDefinition<ChatModelListing>>> = {
  codex: { ...CODEX_LISTING_TRANSPORT, createCollector: () => frameCollector(selectCodex) },
  claude: { ...CLAUDE_LISTING_TRANSPORT, createCollector: () => frameCollector(selectClaude) },
  pi: {
    args: [
      '--mode', 'rpc', '--offline', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve',
    ],
    source: 'app-server-rpc',
    stdin: [JSON.stringify({ id: PI_REQUEST_ID, type: 'get_available_models' })],
    keepStdinOpen: true,
    createCollector: () => frameCollector(selectPi),
  },
};

export type ChatModelListingOptions = {
  readonly log: Pick<Logger, 'warn'>;
  /** Empty main-owned directory; never a user project root. */
  readonly probeCwd: string;
  readonly now?: () => number;
  readonly runProbe?: (request: ProbeRequest<ChatModelListing>) => Promise<ChatModelListing | null>;
};

type CachedListing = { readonly key: string; readonly expiresAt: number; readonly listing: ChatModelListing };
type InFlightListing = { readonly key: string; readonly abort: AbortController; readonly result: Promise<ChatModelListing | null> };

/**
 * Main-owned, bounded per-model metadata for Reader Chat's CLI providers.
 *
 * Every probe runs through `runBoundedProbe`: a fixed executable, tokenized
 * argv, no shell, a minimal environment, bounded output and lifetime, and
 * strict child-tree cleanup. A failed, partial or malformed answer is `null`,
 * which leaves each model on Default only. Answers are cached per binary
 * identity, and a concurrent caller joins the live probe instead of starting
 * another. A probe for a binary that has since been replaced keeps running for
 * its own caller, but only the newest probe per provider may write the cache,
 * and close cancels and awaits every probe still running.
 */
export class ChatModelListingProbe implements ChatModelLister {
  private readonly cache = new Map<ListedChatProvider, CachedListing>();
  /** The newest probe per provider: the one a caller joins, and the only one that caches. */
  private readonly inFlight = new Map<ListedChatProvider, InFlightListing>();
  /** Every probe still running, superseded ones included, so close owns them all. */
  private readonly pending = new Set<InFlightListing>();
  private readonly now: () => number;
  private readonly runProbe: NonNullable<ChatModelListingOptions['runProbe']>;
  private closed = false;

  constructor(private readonly options: ChatModelListingOptions) {
    this.now = options.now ?? Date.now;
    this.runProbe = options.runProbe ?? runBoundedProbe;
  }

  async list(providerId: ListedChatProvider, binaryPath: string): Promise<ChatModelListing | null> {
    if (this.closed) return null;
    const key = binaryIdentityKey(binaryPath);
    const cached = this.cache.get(providerId);
    if (cached?.key === key && cached.expiresAt > this.now()) return cached.listing;
    const existing = this.inFlight.get(providerId);
    if (existing?.key === key) return await existing.result;
    const abort = new AbortController();
    const result = this.probe(providerId, binaryPath, key, abort).finally(() => {
      this.pending.delete(entry);
      if (this.inFlight.get(providerId) === entry) this.inFlight.delete(providerId);
    });
    const entry: InFlightListing = { key, abort, result };
    this.pending.add(entry);
    this.inFlight.set(providerId, entry);
    return await result;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    const pending = [...this.pending];
    for (const probe of pending) probe.abort.abort();
    await Promise.all(pending.map((probe) => probe.result));
  }

  private async probe(providerId: ListedChatProvider, file: string, key: string, abort: AbortController): Promise<ChatModelListing | null> {
    const signal = abort.signal;
    let listing: ChatModelListing | null;
    try {
      listing = await this.runProbe({ file, cwd: this.options.probeCwd, definition: CHAT_LISTING_PROBES[providerId], signal });
    } catch (error) {
      this.options.log.warn('Reader Chat model listing probe failed', {
        providerId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
    if (listing === null || listing.models.length === 0) return null;
    // A probe a newer binary replaced still answers its caller, but never the cache.
    if (!this.closed && this.inFlight.get(providerId)?.abort === abort) {
      this.cache.set(providerId, { key, expiresAt: this.now() + LISTING_TTL_MS, listing });
    }
    return listing;
  }
}

/**
 * The application's lister. Under NODE_ENV=test it exists only when CLI lookup
 * is confined to the launch PATH, where an end-to-end run places its offline
 * fixtures, so no test probes a real CLI.
 */
export function createChatModelListing(options: ChatModelListingOptions, cliPathConfined: boolean): ChatModelLister | undefined {
  return process.env.NODE_ENV === 'test' && !cliPathConfined ? undefined : new ChatModelListingProbe(options);
}

/**
 * A CLI's sentinel default followed by each listed model, at most
 * `MAX_LISTED_CHAT_MODELS` in all, so a full listing still fits one provider
 * status. A listing carries identifiers and reasoning only, so each entry
 * keeps the sentinel's limits.
 */
export function listedChatModels(fallback: AIModelInfo, listing: ChatModelListing | null): readonly AIModelInfo[] {
  const sentinel = withReasoning(fallback, listing?.defaultReasoning ?? null);
  const listed = (listing?.models ?? [])
    .filter((model) => model.id !== fallback.id && isAgentModelIdentifier(model.id))
    .slice(0, MAX_LISTED_CHAT_MODELS - 1);
  return [sentinel, ...listed.map((model) => withReasoning({ ...fallback, id: model.id, name: model.id }, model.reasoning))];
}

/** Attaches listed reasoning to a separately discovered catalog, by identifier. */
export function mergeListedReasoning(models: readonly AIModelInfo[], listing: ChatModelListing | null): readonly AIModelInfo[] {
  if (listing === null) return models;
  const byId = new Map(listing.models.map((model) => [model.id, model.reasoning]));
  return models.map((model) => withReasoning(model, byId.get(model.id) ?? null));
}

function withReasoning(model: AIModelInfo, reasoning: AIModelReasoning | null): AIModelInfo {
  const copy: AIModelInfo = { ...model };
  if (reasoning === null) delete copy.reasoning;
  else copy.reasoning = reasoning;
  return copy;
}
