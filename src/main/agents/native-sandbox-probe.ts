import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentProviderId } from '@shared/types/agent';
import type { MainAgentProfile } from './profile-types';
import { ProcessRunner, type ProcessLauncher, type ProcessRunHandle, type ProcessRunnerEvent } from './process-runner';
import { hashFileInWorker } from '../workers/hash-file-worker';
import { ProbeCancellationScope } from './probe-cancellation-scope';
import type { PortableRecord } from '@shared/models/portable';

/**
 * Main-owned proof that a built-in adapter really offers the native sandbox
 * that Native Restricted mode depends on (docs/REMAINING_WORK.md item Q,
 * ADR 0008).
 *
 * A declared capability bit and a glance at the profile's argv preset are not
 * containment proofs: settings, detection, and profile presets are all
 * mutable, and a replaced binary keeps the same path. This module instead
 * requires, for every start and every resume:
 *
 * 1. a canonical executable identity (realpath + regular-file + bounded
 *    content digest, so a metadata-preserving replacement is still a different
 *    executable), re-read after the probe so a binary swapped mid-probe
 *    invalidates the result;
 * 2. a bounded, non-inference `--version` and `--help` probe whose output is
 *    treated as untrusted text and only ever *searched* for the exact tokens
 *    of one fixed contract; and
 * 3. an exact argv contract: the start tokens the profile must already carry,
 *    and the resume tokens Interleaf will add.
 *
 * The verified result is bound to the executable fingerprint plus the contract
 * identifier. Timeout, truncation, a non-zero exit, output drift, an
 * unparseable or unsupported version, or any other uncertainty makes Native
 * Restricted unavailable *before* an adapter is spawned. No inference or task
 * run is ever used as the probe.
 */

/** Bounded because these are help/version listings, not sessions. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 256 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
/** Availability listings are re-rendered constantly; a short TTL keeps that
 * cheap. Start and resume authorization always passes `{ fresh: true }` and
 * never reads this cache. */
const VERIFICATION_TTL_MS = 5 * 60 * 1_000;

export type NativeSandboxContract = {
  readonly contractId: string;
  /** Non-inference probes, in order. All must succeed. */
  readonly probes: readonly {
    readonly args: readonly string[];
    /** Every token must appear literally in the probe's combined output. */
    readonly requiredTokens: readonly string[];
    /** No token here may appear; used to detect a drifted/renamed contract. */
    readonly forbiddenTokens?: readonly string[];
  }[];
  /** Exact argv prefix the profile's own defaults must already carry. */
  readonly startArgs: readonly string[];
  /** Exact tokens Interleaf appends on resume to preserve the sandbox. */
  readonly resumeSandboxArgs: readonly string[];
  /** Lowest CLI version whose sandbox contract was verified against this code. */
  readonly minimumVersion: readonly [number, number, number];
  /** Probe whose output carries the version string. */
  readonly versionArgs: readonly string[];
};

/**
 * Only adapters with a truthfully provable contract appear here.
 *
 * `antigravity` is deliberately absent even though its capability table says
 * `nativeSandbox: true`: its argv preset contains no sandbox selector and
 * `agy --help` exposes no enforceable native-sandbox flag, so Interleaf cannot
 * prove containment for it and Native Restricted stays unavailable rather than
 * silently falling back to active-env or isolated execution.
 *
 * `cursor` is absent for the same reason, one step weaker: its capability table
 * already says `nativeSandbox: false`, and its argv preset was derived from
 * Cursor's published CLI documentation without ever being verified against an
 * installed `cursor-agent`. Nothing here has observed a containment flag, so
 * there is no contract to prove and Native Restricted stays unavailable.
 *
 * The same applies to every custom, expert-shell, unsafe, and fixture profile.
 */
export const NATIVE_SANDBOX_CONTRACTS: Partial<Record<AgentProviderId, NativeSandboxContract>> = {
  codex: {
    contractId: 'codex-exec-sandbox-workspace-write-v1',
    versionArgs: ['--version'],
    minimumVersion: [0, 20, 0],
    probes: [
      {
        // `codex exec` is the non-interactive entry point Interleaf starts.
        args: ['exec', '--help'],
        requiredTokens: ['--sandbox', 'workspace-write', 'read-only', 'danger-full-access', '--json', '--skip-git-repo-check'],
      },
      {
        // `codex exec resume` has no `--sandbox` selector of its own; the
        // sandbox policy is carried by the same `-c key=value` override the
        // adapter already uses for reasoning effort. Requiring `--config` and
        // forbidding `--sandbox` pins that exact shape, so a future release
        // that adds a resume-side `--sandbox` flag is treated as drift and
        // re-verified deliberately instead of silently.
        args: ['exec', 'resume', '--help'],
        requiredTokens: ['--config', '--json', '--model', '--skip-git-repo-check'],
        forbiddenTokens: ['--sandbox <', '-s, --sandbox'],
      },
    ],
    startArgs: ['exec', '--json', '--sandbox', 'workspace-write'],
    resumeSandboxArgs: ['-c', 'sandbox_mode="workspace-write"'],
  },
};

export type VerifiedNativeSandbox = {
  readonly contractId: string;
  readonly executableFingerprint: string;
  readonly startArgs: readonly string[];
  readonly resumeSandboxArgs: readonly string[];
};

export type NativeSandboxProberOptions = {
  readonly runner?: ProcessLauncher;
  /** App-owned empty directory; never the user's target. */
  readonly probeCwd: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly log: { warn(message: string, context?: PortableRecord): void };
  /** Main-owned seam for the bounded executable digest, so shutdown ordering
   * around it can be exercised deterministically. Defaults to the real hash. */
  readonly fingerprint?: (binaryPath: string) => Promise<string>;
};

type CacheEntry = { readonly verifiedAt: number; readonly result: VerifiedNativeSandbox };

export class NativeSandboxCapabilityProber {
  private readonly runner: ProcessLauncher;
  private readonly probeCwd: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log: NativeSandboxProberOptions['log'];
  private readonly fingerprint: (binaryPath: string) => Promise<string>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<VerifiedNativeSandbox | null>>();
  /** Every probe child this prober owns, plus every verification awaiting
   * one, so shutdown can end both. */
  private readonly scope = new ProbeCancellationScope();
  private closed = false;

  constructor(options: NativeSandboxProberOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.probeCwd = options.probeCwd;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? VERIFICATION_TTL_MS;
    this.log = options.log;
    this.fingerprint = options.fingerprint ?? executableFingerprint;
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Shutdown's cancellation point (docs/REMAINING_WORK.md item R).
   *
   * Closing marks the prober closed, clears the cache so no later `verify()`
   * can succeed, cancels every probe child this prober still owns, and only
   * then resolves — a probe is a short bounded run, but shutdown must not have
   * to wait out its own 10s bound for an answer nobody will use. Awaiting
   * callers are answered `null` by the cancellation, which is the ordinary
   * fail-closed value, and the drain keeps the reaping inside the caller's
   * bound rather than leaving it to the run's timeout.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    await this.scope.close();
  }

  /**
   * Returns the verified capability, or `null` when Native Restricted must be
   * unavailable. Never throws: an unavailable capability is an ordinary
   * fail-closed answer, not an error the caller has to interpret.
   *
   * `fresh` skips the cache *and* any in-flight attempt and re-runs the
   * bounded probes. Availability listings may use the cached answer, but the
   * final authorization immediately before an adapter spawn must not: only a
   * probe run at that instant can speak for that instant.
   */
  async verify(profile: MainAgentProfile, options: { readonly fresh?: boolean } = {}): Promise<VerifiedNativeSandbox | null> {
    if (this.closed) return null;
    const contract = staticContractFor(profile);
    if (contract === null) return null;
    // Item R: the whole verification is tracked from before its first await,
    // including the fingerprint read. Tracking only the probe would let a
    // `close()` that lands during the fingerprint see no work, resolve, and
    // then have this attempt spawn a child nobody owns.
    return await this.scope.track(this.runVerification(profile, contract, options.fresh === true));
  }

  private async runVerification(
    profile: MainAgentProfile,
    contract: NativeSandboxContract,
    fresh: boolean,
  ): Promise<VerifiedNativeSandbox | null> {
    let fingerprint: string;
    try {
      fingerprint = await this.fingerprint(profile.binaryPath);
    } catch {
      return null;
    }
    // Revalidated after every await and immediately before anything can be
    // spawned: no probe may start once shutdown has begun.
    if (this.closed) return null;
    const key = `${profile.id}\0${contract.contractId}\0${fingerprint}`;
    if (fresh) {
      this.cache.delete(key);
      return await this.probeContract(profile, contract, fingerprint, key);
    }
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.verifiedAt < this.ttlMs) return cached.result;
    this.cache.delete(key);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return await existing;
    const attempt = this.probeContract(profile, contract, fingerprint, key)
      .finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, attempt);
    return await attempt;
  }

  private async probeContract(
    profile: MainAgentProfile,
    contract: NativeSandboxContract,
    fingerprint: string,
    key: string,
  ): Promise<VerifiedNativeSandbox | null> {
    const version = await this.readOutput(profile.binaryPath, contract.versionArgs);
    if (version === null || !supportedVersion(version, contract.minimumVersion)) {
      this.log.warn('native sandbox capability probe rejected the CLI version', { profileId: profile.id });
      return null;
    }
    for (const probe of contract.probes) {
      const output = await this.readOutput(profile.binaryPath, probe.args);
      if (output === null) return null;
      if (!probe.requiredTokens.every((token) => output.includes(token))) {
        this.log.warn('native sandbox capability probe found drifted help output', { profileId: profile.id });
        return null;
      }
      if (probe.forbiddenTokens?.some((token) => output.includes(token)) === true) {
        this.log.warn('native sandbox capability probe found an unexpected flag', { profileId: profile.id });
        return null;
      }
    }
    // The binary may have been replaced while the probes ran; a proof that
    // describes a different file is no proof at all.
    let confirmed: string;
    try {
      confirmed = await this.fingerprint(profile.binaryPath);
    } catch {
      return null;
    }
    if (confirmed !== fingerprint) return null;
    if (this.closed) return null;
    const result: VerifiedNativeSandbox = {
      contractId: contract.contractId,
      executableFingerprint: fingerprint,
      startArgs: contract.startArgs,
      resumeSandboxArgs: contract.resumeSandboxArgs,
    };
    this.cache.set(key, { verifiedAt: this.now(), result });
    return result;
  }

  /**
   * One bounded, fixed-executable, tokenized, `shell: false`, minimal-
   * environment run. Returns `null` for any non-clean outcome: non-zero exit,
   * signal, truncation, timeout, spawn error, or unproven child-tree cleanup.
   */
  private async readOutput(file: string, args: readonly string[]): Promise<string | null> {
    // Nothing is spawned once the prober is closed, even mid-contract.
    if (this.closed) return null;
    const handle = this.scope.adopt(this.runner.run({
      file,
      args,
      cwd: this.probeCwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      // A capability answer must never come from a run whose child tree could
      // not be proven terminated.
      strictCleanup: true,
    }));
    try {
      return await collectProbeOutput(handle);
    } catch {
      return null;
    } finally {
      this.scope.release(handle);
    }
  }
}

/**
 * Drains one probe run to its bounded output, or to `null` for any outcome a
 * capability answer may not rest on: non-zero exit, signal, truncation past
 * the byte bound, cancellation, or a runner error.
 */
async function collectProbeOutput(handle: ProcessRunHandle): Promise<string | null> {
  let text = '';
  let bytes = 0;
  let truncated = false;
  let failed = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  for await (const event of handle.events) {
    const chunk = outputChunk(event);
    if (chunk !== null) {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > PROBE_MAX_BYTES) { truncated = true; handle.cancel(); }
      else text += chunk;
    }
    if (event.type === 'ended') { exitCode = event.exitCode; signal = event.signal; }
    if (event.type === 'error' || event.type === 'cancelled') failed = true;
  }
  await handle.completion;
  if (failed || truncated || signal !== null || exitCode !== 0) return null;
  return text;
}

function outputChunk(event: ProcessRunnerEvent): string | null {
  return event.type === 'stdout' || event.type === 'stderr' ? event.text : null;
}

/**
 * Static gate applied before any process is spawned. A profile that fails any
 * of these can never reach the probe, so an unverified or user-authored
 * profile has no path to Native Restricted.
 */
function staticContractFor(profile: MainAgentProfile): NativeSandboxContract | null {
  if (profile.detection.availability !== 'installed') return null;
  if (profile.isCustom || profile.unsafe) return null;
  if (!profile.capabilities.nativeSandbox || !profile.capabilities.nonInteractiveMode) return null;
  if (profile.permissionMode.toLowerCase().includes('bypass')) return null;
  const contract = NATIVE_SANDBOX_CONTRACTS[profile.providerId];
  if (contract === undefined) return null;
  return startsWithTokens(profile.defaultArgs, contract.startArgs) ? contract : null;
}

function startsWithTokens(args: readonly string[], expected: readonly string[]): boolean {
  return expected.every((token, index) => args[index] === token);
}

/** Untrusted output: only the first version-shaped triple is read, and only
 * from a bounded prefix. */
function supportedVersion(output: string, minimum: readonly [number, number, number]): boolean {
  const match = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/u.exec(output.slice(0, 512));
  if (match === null) return false;
  const found: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    const left = found[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Canonical executable identity, bound to a bounded cryptographic digest of
 * the file's contents — the same basis `ExecutableRegistry` uses, and for the
 * same reason: metadata alone is forgeable. A replacement that reuses the
 * inode, size, and mtime changes the digest and therefore invalidates every
 * proof taken against the previous file.
 *
 * Symlinks are followed (built-in CLIs are routinely installed as launcher
 * symlinks) but the *resolved* file must be a regular, executable, bounded
 * file, and the hash worker re-checks that identity with no-follow semantics
 * before and after streaming the digest.
 */
async function executableFingerprint(binaryPath: string): Promise<string> {
  if (typeof binaryPath !== 'string' || binaryPath.length === 0 || binaryPath.length > 4_096 || binaryPath.includes('\0')) {
    throw new Error('invalid executable path');
  }
  const canonicalPath = await realpath(resolve(binaryPath));
  const identity = await lstat(canonicalPath);
  if (identity.isSymbolicLink() || !identity.isFile()) throw new Error('executable is not a regular file');
  if (identity.size > MAX_EXECUTABLE_BYTES) throw new Error('executable exceeds the bounded size limit');
  if (process.platform !== 'win32' && (identity.mode & 0o111) === 0) throw new Error('file is not executable');
  const sha256 = await hashFileInWorker(canonicalPath, {
    device: identity.dev,
    inode: identity.ino,
    fileSize: identity.size,
    fileMtimeMs: Math.round(identity.mtimeMs),
  }, { label: 'executable' });
  return createHash('sha256')
    .update(`${canonicalPath}\0${String(identity.dev)}\0${String(identity.ino)}\0${String(identity.size)}\0${sha256}`)
    .digest('hex');
}
