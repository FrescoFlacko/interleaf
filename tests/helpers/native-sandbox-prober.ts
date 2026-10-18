import { NativeSandboxCapabilityProber, type VerifiedNativeSandbox } from '../../src/main/agents/native-sandbox-probe';
import type { MainAgentProfile } from '../../src/main/agents/profile-types';
import { silentLogger } from './silent-logger';

/**
 * A prober stand-in for tests whose subject is something other than the
 * capability proof itself (identity races, grant binding, resume authority).
 *
 * Real verification spawns the provider CLI, so tests that must not depend on a
 * locally installed binary state the capability answer explicitly instead. The
 * answer is still a value the service has to honour: setting it to `null` is
 * how a test asserts fail-closed behaviour.
 */
export class StubNativeSandboxProber extends NativeSandboxCapabilityProber {
  verifyCalls = 0;
  private answer: VerifiedNativeSandbox | null;

  constructor(answer: VerifiedNativeSandbox | null = stubVerifiedNativeSandbox()) {
    super({ probeCwd: '/nonexistent-probe-cwd', log: silentLogger });
    this.answer = answer;
  }

  /** Simulates drift discovered between two privileged continuations. */
  setAnswer(answer: VerifiedNativeSandbox | null): void {
    this.answer = answer;
  }

  /** Counts the forced pre-spawn proofs separately from availability lookups. */
  freshVerifyCalls = 0;

  /**
   * Runs while a forced pre-spawn proof is in flight. The real proof spawns a
   * child and takes a content digest, so it is a multi-second window; this hook
   * is how a test opens that window and changes the world inside it.
   */
  duringFreshVerify: (() => Promise<void> | void) | null = null;

  override async verify(_profile: MainAgentProfile, options: { readonly fresh?: boolean } = {}): Promise<VerifiedNativeSandbox | null> {
    this.verifyCalls += 1;
    if (options.fresh === true) {
      this.freshVerifyCalls += 1;
      await this.duringFreshVerify?.();
    }
    return this.answer;
  }
}

/**
 * A prober with one verification deliberately left in flight, standing in for
 * a real bounded probe child that shutdown must cancel rather than wait out
 * (docs/REMAINING_WORK.md item R). Ordinary verifications still answer at once,
 * so nothing else in a service's lifecycle blocks on this.
 */
export class BlockingNativeSandboxProber extends NativeSandboxCapabilityProber {
  closeCalls = 0;
  blockNextVerify = true;
  /** Resolves once the blocked verification is actually in flight. */
  readonly started: Promise<void>;
  private startVerify: () => void = () => undefined;
  private release: () => void = () => undefined;
  private attempt: Promise<VerifiedNativeSandbox | null> = Promise.resolve(null);

  constructor() {
    super({ probeCwd: '/nonexistent-probe-cwd', log: silentLogger });
    this.started = new Promise<void>((resolve) => { this.startVerify = resolve; });
  }

  override verify(): Promise<VerifiedNativeSandbox | null> {
    // The stub answers the same way for every profile and option set.
    if (!this.blockNextVerify) return Promise.resolve(null);
    this.blockNextVerify = false;
    const attempt = new Promise<VerifiedNativeSandbox | null>((resolve) => {
      this.release = () => { resolve(null); };
    });
    this.attempt = attempt;
    this.startVerify();
    return attempt;
  }

  /** Mirrors the real prober: closing cancels the run and the close only
   * settles once the awaiting caller has its fail-closed answer. */
  override async close(): Promise<void> {
    this.closeCalls += 1;
    this.release();
    await this.attempt;
  }
}

export function stubVerifiedNativeSandbox(overrides: Partial<VerifiedNativeSandbox> = {}): VerifiedNativeSandbox {
  return {
    contractId: 'codex-exec-sandbox-workspace-write-v1',
    executableFingerprint: 'stub-fingerprint',
    startArgs: ['exec', '--json', '--sandbox', 'workspace-write'],
    resumeSandboxArgs: ['-c', 'sandbox_mode="workspace-write"'],
    ...overrides,
  };
}
