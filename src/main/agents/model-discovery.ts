import { statSync } from 'node:fs';
import type { AgentProviderId } from '@shared/types/agent';
import { MAX_DISCOVERED_AGENT_MODELS, isAgentModelIdentifier } from '@shared/constants/agent-models';
import { ProcessRunner, type ProcessRunHandle, type ProcessRunnerEvent } from './process-runner';
import { PROBES, type ProbeCollector, type ProbeDefinition } from './model-discovery-probes';
import type { PortableRecord } from '@shared/models/portable';

/**
 * How a provider's model list was obtained. Recorded so an unusual catalog can
 * be traced back to the mechanism that produced it.
 */
export type AgentModelDiscoverySource = 'app-server-rpc' | 'control-protocol' | 'list-command';

export type DiscoveredAgentModels = {
  readonly providerId: AgentProviderId;
  readonly models: readonly string[];
  readonly source: AgentModelDiscoverySource;
  readonly discoveredAt: string;
};

/** The seam `AgentRegistry` depends on, so tests never spawn a provider CLI. */
export type AgentModelDiscoverer = {
  supports(providerId: AgentProviderId): boolean;
  discover(providerId: AgentProviderId, binaryPath: string, force?: boolean): Promise<DiscoveredAgentModels | null>;
  /**
   * Stop listing and give up ownership of every child it started. Resolves only
   * once each in-flight probe has finished cleaning its process tree up, so a
   * caller can make shutdown wait for it.
   */
  close(): Promise<void>;
};

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 512 * 1024;
/** A cached catalog is reused for this long before the CLI is probed again. */
const CATALOG_TTL_MS = 30 * 60 * 1000;

export type ProbeRequest<T = readonly string[]> = {
  readonly file: string;
  readonly cwd: string;
  readonly definition: ProbeDefinition<T>;
  /**
   * Aborted when the owner stops listing. The probe then terminates its child
   * tree and still resolves only after that termination is complete.
   */
  readonly signal: AbortSignal;
};

/**
 * The identifiers a probe actually finished collecting, or `null`.
 *
 * `null` is the only representation of a failed, truncated, timed-out, cancelled
 * or non-zero-exit probe: a partial answer is never promoted into a catalog.
 */
export type ProbeAnswer = readonly string[] | null;

export type AgentModelDiscoveryOptions = {
  readonly log: {
    readonly warn: (message: string, meta?: PortableRecord) => void;
    readonly debug: (message: string, meta?: PortableRecord) => void;
  };
  /**
   * Main-owned directory the probes run in. It must never be a user project
   * root: these CLIs load project-local configuration, hooks, skills and
   * extensions from their working directory, and listing models must not
   * execute any of it.
   */
  readonly probeCwd: string;
  readonly now?: () => Date;
  readonly runProbe?: (request: ProbeRequest) => Promise<ProbeAnswer>;
};

type CacheEntry = {
  readonly key: string;
  readonly expiresAt: number;
  readonly catalog: DiscoveredAgentModels;
};

/** One live probe per provider, owned until its child tree is cleaned up. */
type InFlightProbe = {
  readonly abort: AbortController;
  readonly result: Promise<DiscoveredAgentModels | null>;
};

/**
 * Main-owned discovery of the model identifiers an installed agent CLI accepts.
 *
 * Every probe runs through the same `ProcessRunner` the agent launch path uses:
 * a fixed executable with tokenized argv, `shell: false`, a minimal environment,
 * bounded output and a bounded lifetime, terminated through the one
 * TERM → KILL → reap (or Windows `taskkill /T`) sequence that already proves a
 * child's tree is gone. Probes run in a neutral main-owned directory with each
 * CLI's project-extension loading disabled, and are listing calls only — none of
 * them starts a model turn, so discovery never issues a paid request. Probe
 * output is untrusted external data: a candidate is only kept if it satisfies
 * the same `isAgentModelIdentifier` guard that governs the launch allowlist, and
 * the catalog is bounded. Only identifiers leave this module; the surrounding
 * response fields (home directories, account state, descriptions) do not.
 *
 * A provider with no listing mechanism, an unparseable, partial or truncated
 * answer, or a failed probe yields no catalog at all, which leaves the provider
 * default and the user's own configured list exactly as they were.
 *
 * Concurrency is explicit rather than incidental: at most one probe per provider
 * exists at a time and later callers join it, so a repeated refresh cannot start
 * a second CLI or let an older answer overwrite a newer one.
 */
export class AgentModelDiscovery implements AgentModelDiscoverer {
  private readonly log: AgentModelDiscoveryOptions['log'];
  private readonly probeCwd: string;
  private readonly now: () => Date;
  private readonly runProbe: (request: ProbeRequest) => Promise<ProbeAnswer>;
  private readonly cache = new Map<AgentProviderId, CacheEntry>();
  private readonly inFlight = new Map<AgentProviderId, InFlightProbe>();
  private closed = false;

  constructor(options: AgentModelDiscoveryOptions) {
    this.log = options.log;
    this.probeCwd = options.probeCwd;
    this.now = options.now ?? (() => new Date());
    this.runProbe = options.runProbe ?? runBoundedProbe;
  }

  supports(providerId: AgentProviderId): boolean {
    return PROBES[providerId] !== undefined;
  }

  /**
   * Returns the provider's catalog, probing only when nothing usable is cached
   * and no probe for the same provider is already running. The cache key
   * includes the binary's identity so an upgraded CLI is re-probed instead of
   * answering from the previous version's catalog.
   */
  async discover(providerId: AgentProviderId, binaryPath: string, force = false): Promise<DiscoveredAgentModels | null> {
    const definition = PROBES[providerId];
    if (definition === undefined || this.closed) return null;
    const key = binaryIdentityKey(binaryPath);
    const cached = this.cachedCatalog(providerId, key, force);
    if (cached !== null) return cached;
    // A live probe is already the freshest possible answer, so a concurrent
    // caller — including a forced refresh — joins it instead of spawning a
    // second CLI whose result could land out of order.
    const existing = this.inFlight.get(providerId);
    if (existing !== undefined) return await existing.result;
    return await this.startProbe(providerId, definition, binaryPath, key);
  }

  /**
   * Cancel every in-flight probe and wait for it. Callers use this to keep a
   * listing child from outliving the service that started it.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    const pending = [...this.inFlight.values()];
    for (const probe of pending) probe.abort.abort();
    await Promise.all(pending.map((probe) => probe.result));
  }

  clear(): void {
    this.cache.clear();
  }

  private startProbe(
    providerId: AgentProviderId,
    definition: ProbeDefinition,
    binaryPath: string,
    key: string,
  ): Promise<DiscoveredAgentModels | null> {
    const abort = new AbortController();
    const result = this.probeCatalog(providerId, definition, binaryPath, key, abort.signal)
      .finally(() => { this.inFlight.delete(providerId); });
    this.inFlight.set(providerId, { abort, result });
    return result;
  }

  private async probeCatalog(
    providerId: AgentProviderId,
    definition: ProbeDefinition,
    binaryPath: string,
    key: string,
    signal: AbortSignal,
  ): Promise<DiscoveredAgentModels | null> {
    const answer = await this.probe({ file: binaryPath, cwd: this.probeCwd, definition, signal }, providerId);
    if (answer === null) return null;
    const models = boundedIdentifiers(answer);
    if (models.length === 0) {
      this.log.debug('agent model discovery returned no usable identifiers', { providerId });
      return null;
    }
    const catalog: DiscoveredAgentModels = {
      providerId,
      models,
      source: definition.source,
      discoveredAt: this.now().toISOString(),
    };
    // A catalog that arrived after close is still returned to whoever asked,
    // but it is never retained for a later caller.
    if (!this.closed) this.cache.set(providerId, { key, expiresAt: this.now().getTime() + CATALOG_TTL_MS, catalog });
    return catalog;
  }

  private cachedCatalog(providerId: AgentProviderId, key: string, force: boolean): DiscoveredAgentModels | null {
    if (force) return null;
    const cached = this.cache.get(providerId);
    if (cached?.key !== key) return null;
    return cached.expiresAt > this.now().getTime() ? cached.catalog : null;
  }

  private async probe(request: ProbeRequest, providerId: AgentProviderId): Promise<ProbeAnswer> {
    try {
      return await this.runProbe(request);
    } catch (error) {
      // A failed listing is not a failed provider: the profile keeps whatever
      // the user configured and the CLI keeps its own default model.
      this.log.warn('agent model discovery probe failed', {
        providerId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }
}

/**
 * The discoverer the application wires into `AgentRegistry`, or `undefined`
 * under `NODE_ENV=test`.
 *
 * Automated runs never probe a real provider CLI: the listing itself is free,
 * but a test must not depend on which CLIs a given machine has installed.
 */
export function createAgentModelDiscovery(options: AgentModelDiscoveryOptions): AgentModelDiscoverer | undefined {
  return process.env.NODE_ENV === 'test' ? undefined : new AgentModelDiscovery(options);
}

/**
 * Applies the shared identifier guard and bound. Probe output is external
 * process output and is treated as untrusted data: anything that would not be
 * accepted as a launch model identifier is dropped rather than repaired.
 */
function boundedIdentifiers(candidates: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const candidate of candidates) {
    if (!isAgentModelIdentifier(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    models.push(candidate);
    if (models.length >= MAX_DISCOVERED_AGENT_MODELS) break;
  }
  return models;
}

export function binaryIdentityKey(binaryPath: string): string {
  try {
    const identity = statSync(binaryPath);
    return `${binaryPath}:${String(identity.size)}:${String(identity.mtimeMs)}`;
  } catch {
    return binaryPath;
  }
}

/** What one probe observed, before any of it is allowed to become a catalog. */
type ProbeReading<T> = {
  /** Set only when a collector reported a complete listing. */
  answer: T | null;
  /** Output after the last newline, usable only on a clean natural exit. */
  tail: string;
  bytes: number;
  /** Truncated, over budget, cancelled, timed out or failed to start. */
  discarded: boolean;
  exitCode: number | null;
  exitSignal: string | null;
};

/**
 * Bounded, shell-free probe over a line-delimited stdout, run on the agent
 * runtime's own process boundary.
 *
 * `ProcessRunner` is used rather than a private spawn so there is exactly one
 * child-process lifecycle in the runtime: it frames stdout so a chunk boundary
 * in the middle of a JSON line can neither satisfy nor corrupt a listing, bounds
 * output and time, and — the part a listing must not reimplement — closes its
 * event stream only after the TERM → KILL → group-reap escalation (or the
 * Windows `taskkill /T` sequence) has proven the child's tree is gone. Stopping
 * a server-style CLI once it has replied is therefore a deliberate supervisor
 * stop whose exit status carries no meaning, while a CLI that ends on its own
 * must end cleanly for its output to count.
 *
 * Exported so the framing, termination and cancellation behaviour can be
 * exercised against real child processes without a provider CLI; production
 * callers reach it through `AgentModelDiscovery`.
 *
 * The probe runs with the runner's strict cleanup policy: when the runner
 * cannot prove the child tree is gone — the POSIX group still present when the
 * bounded reap window closes, or the Windows tree helper unavailable, failed,
 * or unverified after its grace — `completion` rejects and the listing is
 * dropped rather than reported from an unverified state. An external
 * cancellation (a caller's abort) discards whatever has been read, while the
 * runner-initiated stop after a complete reply is deliberate and does not.
 */
export async function runBoundedProbe<T = readonly string[]>(request: ProbeRequest<T>): Promise<T | null> {
  const definition = request.definition;
  const collector = definition.createCollector();
  const handle = new ProcessRunner().run({
    file: request.file,
    args: definition.args,
    cwd: request.cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
    keepStdinOpen: definition.keepStdinOpen === true,
    // Discovery must never report a catalog from a run whose child tree was
    // not proven terminated. With this flag the runner rejects `completion`
    // when the reap window closes with the group still present (POSIX) or the
    // Windows tree helper stays unverified, instead of settling as success.
    strictCleanup: true,
    ...(definition.stdin === undefined ? {} : { stdin: definition.stdin.map((frame) => `${frame}\n`).join('') }),
  });
  const reading: ProbeReading<T> = { answer: null, tail: '', bytes: 0, discarded: false, exitCode: null, exitSignal: null };
  const abandon = (): void => {
    reading.discarded = true;
    handle.cancel();
  };
  if (request.signal.aborted) abandon();
  else request.signal.addEventListener('abort', abandon, { once: true });
  try {
    for await (const event of handle.events) readProbeEvent(event, reading, collector, handle);
    await handle.completion;
  } finally {
    request.signal.removeEventListener('abort', abandon);
  }
  return probeAnswer(reading, collector);
}

function readProbeEvent<T>(
  event: ProcessRunnerEvent,
  reading: ProbeReading<T>,
  collector: ProbeCollector<T>,
  handle: ProcessRunHandle,
): void {
  if (event.type === 'ended') {
    reading.exitCode = event.exitCode;
    reading.exitSignal = event.signal;
    return;
  }
  // A runner-reported failure (spawn, timeout, output bound) and an evicted
  // event both mean the stream this listing is being read from has a gap.
  if (event.type === 'error' || isDroppedEventMarker(event)) {
    reading.discarded = true;
    return;
  }
  if (event.type !== 'stdout' || reading.answer !== null || reading.discarded) return;
  reading.bytes += Buffer.byteLength(event.text, 'utf8');
  if (reading.bytes > PROBE_MAX_BYTES) {
    reading.discarded = true;
    handle.cancel();
    return;
  }
  const lines = (reading.tail + event.text).split('\n');
  reading.tail = lines.pop() ?? '';
  for (const line of lines) {
    reading.answer = collector.accept(line.replace(/\r$/u, ''));
    if (reading.answer === null) continue;
    // The reply is whole, so the CLI is stopped on purpose. Whatever exit
    // status that produces describes the stop, not the listing.
    handle.cancel();
    return;
  }
}

function probeAnswer<T>(reading: ProbeReading<T>, collector: ProbeCollector<T>): T | null {
  // A discard reported at any point — including after a complete reply was
  // already collected, for example a runner failure, an evicted event, or an
  // external cancellation — overrides that reply. A listing read from a run
  // that went wrong somewhere is not evidence.
  if (reading.discarded) return null;
  if (reading.answer !== null) return reading.answer;
  // Every remaining case is a CLI that ended on its own. Only a clean,
  // untruncated exit may contribute the trailing unterminated line or a
  // whole-output listing; a failed or signalled exit contributes nothing.
  if (reading.exitCode !== 0 || reading.exitSignal !== null) return null;
  const tail = reading.tail.length > 0 ? collector.accept(reading.tail.replace(/\r$/u, '')) : null;
  return tail ?? collector.finish();
}

/** The runner's bounded queue reports evicted events; a listing read from a
 * gapped stream is incomplete by definition. */
function isDroppedEventMarker(event: ProcessRunnerEvent): boolean {
  return event.type === 'structured' && event.data.kind === 'dropped-events';
}
