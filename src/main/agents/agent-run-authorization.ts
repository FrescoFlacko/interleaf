import type { AgentProfile, AgentRunRequest, AgentSession } from '@shared/types/agent';
import { resolveAgentRiskLevel, type AgentRiskLevel, type ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { CodexRepositoryTrust } from './agent-adapter';
import type { MainAgentProfile } from './profile-types';
import type { RegisteredWorkingDirectory, WorkingDirectoryRegistry } from './working-directory-registry';
import type { NativeSandboxCapabilityProber, VerifiedNativeSandbox } from './native-sandbox-probe';
import {
  assertPersistedTargetUnchanged,
  assertRegistryMatchesPersistedTarget,
  matchesRecordedCapability,
  recordedCapability,
  type PersistedSessionAuthority,
  type PersistedTargetIdentity,
} from './session-authority';
import type { OwnerOperation } from './agent-session-ownership';

/** What the native dialog shows before a run touches the working directory directly. */
export type DirectWorkspaceConfirmation = {
  readonly mode: 'active-env' | 'native-restricted';
  readonly riskLevel: AgentRiskLevel;
  readonly canonicalTargetPath: string;
  readonly profileName: string;
};

/** What the native dialog shows, and binds the answer to, before an unsafe or unverified run. */
export type DangerousRunConfirmation = {
  readonly mode: AgentRunRequest['executionMode'];
  readonly riskLevel: AgentRiskLevel;
  readonly canonicalTargetPath: string;
  readonly profileName: string;
  readonly profileFingerprint: string;
  readonly draftFingerprint: string;
  readonly expertShell?: boolean;
};

/**
 * Item N: one predicate answers for the confirmation, the persisted
 * environment, and the label the renderer shows.
 */
export type RunRisk = {
  readonly isExpertShell: boolean;
  readonly dangerousProfile: boolean;
  readonly riskLevel: AgentRiskLevel;
  /** Unsafe, unverified, and Expert Shell runs need a fresh confirmation. */
  readonly requiresConfirmation: boolean;
};

export function assessRunRisk(profile: MainAgentProfile, mode: ResolvedAgentExecutionMode): RunRisk {
  const isExpertShell = profile.customConfig?.executionKind === 'expert-shell';
  const dangerousProfile = isExpertShell || profile.unsafe;
  return {
    isExpertShell,
    dangerousProfile,
    riskLevel: resolveAgentRiskLevel({ mode, dangerousProfile, unverifiedProfile: profile.isCustom }),
    requiresConfirmation: dangerousProfile || profile.isCustom,
  };
}

export type DangerousRunDecision = 'not-required' | 'approved' | 'declined';

/** The refusal a declined dangerous-run confirmation raises. */
export function dangerousRunRefusal(risk: RunRisk): InterleafError {
  return risk.isExpertShell
    ? new InterleafError('security-violation', 'Expert custom shell execution was cancelled.')
    : new InterleafError('security-violation', 'Unsafe or unverified agent execution was cancelled.');
}

const NATIVE_SANDBOX_UNPROVEN = 'Native Restricted is unavailable because the selected adapter could not prove its native sandbox.';

export type AgentRunAuthorizationOptions = {
  readonly directories: WorkingDirectoryRegistry;
  readonly nativeSandbox: NativeSandboxCapabilityProber;
  readonly isGitRepository: (canonicalPath: string) => Promise<boolean>;
  /** Fresh native confirmation for every unsafe/unverified run in every mode. */
  readonly confirmDangerousAgentRun: (input: DangerousRunConfirmation) => Promise<boolean>;
};

/**
 * The authorization steps start and resume share. Each step is one check;
 * the caller decides the order and proves its operation is live after every
 * await.
 */
export class AgentRunAuthorization {
  private readonly options: AgentRunAuthorizationOptions;

  constructor(options: AgentRunAuthorizationOptions) {
    this.options = options;
  }

  /** Main-owned adapter capability probe used while resolving a mode. */
  async supportsNativeRestricted(profile: MainAgentProfile): Promise<boolean> {
    return (await this.options.nativeSandbox.verify(profile)) !== null;
  }

  /** First proof for a brand-new session; there is no recorded capability yet. */
  async requireNativeSandboxProof(profile: MainAgentProfile): Promise<VerifiedNativeSandbox> {
    const proof = await this.options.nativeSandbox.verify(profile, { fresh: true });
    if (proof === null) throw new InterleafError('mode-resolution-failed', NATIVE_SANDBOX_UNPROVEN);
    return proof;
  }

  /**
   * Re-proves Native Restricted against the capability the session recorded.
   * The answer must still describe the exact executable and argv contract the
   * session was authorized under. Anything else — an unprovable CLI, drifted
   * help output, a replaced binary, a missing or mismatched recorded
   * capability — fails closed before the adapter is entered. `cached` is only
   * for the early resume gate that decides whether to ask the user at all.
   */
  async proveRecordedNativeSandbox(
    profile: MainAgentProfile,
    authority: PersistedSessionAuthority,
    freshness: 'cached' | 'fresh',
  ): Promise<void> {
    const proof = await this.options.nativeSandbox.verify(profile, { fresh: freshness === 'fresh' });
    if (!matchesRecordedCapability(proof, recordedCapability(authority))) {
      throw new InterleafError('mode-resolution-failed', NATIVE_SANDBOX_UNPROVEN);
    }
  }

  /**
   * Asks for the per-run confirmation an unsafe, unverified, or Expert Shell
   * profile requires. The caller orders the refusal against its own liveness
   * check, because start and resume deliberately differ there.
   */
  async confirmDangerousRun(
    profile: MainAgentProfile,
    risk: RunRisk,
    binding: { readonly mode: DangerousRunConfirmation['mode']; readonly canonicalTargetPath: string; readonly profileFingerprint: string; readonly draftFingerprint: string },
  ): Promise<DangerousRunDecision> {
    if (!risk.requiresConfirmation) return 'not-required';
    const approved = await this.options.confirmDangerousAgentRun({
      ...binding,
      riskLevel: risk.riskLevel,
      profileName: profile.name,
      ...(risk.isExpertShell ? { expertShell: true } : {}),
    });
    return approved ? 'approved' : 'declined';
  }

  /**
   * Codex's repository check is derived from the resolved environment, never
   * from renderer input, profile settings, or custom argv. Isolated copies do
   * not contain `.git` even when their source is a repository, while worktrees
   * and Git direct-workspace runs remain trusted. Direct modes are probed again
   * after the registered directory has been revalidated so a persisted resume
   * cannot reuse a stale start-time decision.
   */
  async resolveCodexRepositoryTrust(
    providerId: AgentProfile['providerId'],
    mode: AgentSession['executionMode'],
    canonicalTargetPath: string,
  ): Promise<CodexRepositoryTrust> {
    if (providerId !== 'codex') return 'trusted';
    if (mode === 'isolated-copy') return 'untrusted';
    if (mode !== 'active-env' && mode !== 'native-restricted') return 'trusted';
    const isGit = await this.options.isGitRepository(canonicalTargetPath);
    return isGit ? 'trusted' : 'untrusted';
  }

  /** Re-resolves the handle and proves it still names the persisted target. */
  async resolveMatchingTarget(
    handle: string,
    identity: PersistedTargetIdentity,
    operation: OwnerOperation,
  ): Promise<RegisteredWorkingDirectory> {
    const directory = await this.options.directories.resolve(handle);
    operation.assertLive();
    assertRegistryMatchesPersistedTarget(directory, identity);
    return directory;
  }

  /**
   * The last target check before the adapter is entered.
   *
   * Every preceding await — a confirmation dialog, environment preparation, a
   * Git inspection, the uncached native-sandbox proof — is an unbounded window
   * in which the registered directory could be replaced, pointed at a symlink,
   * or moved under a protected application-data root. This re-resolves the
   * handle (which re-applies the protected-root policy and the registry's own
   * file-identity revalidation) and re-proves the persisted canonical path
   * and file identity, so no app-created window remains open across those
   * awaits.
   *
   * A narrow same-user race still exists between this check and the child
   * process's own first syscall; that residual is irreducible without kernel
   * support and is documented rather than claimed away. Nothing is mutated
   * here, so a rejection leaves the target and the prior session untouched.
   */
  async revalidateTargetBeforeSpawn(
    handle: string,
    identity: PersistedTargetIdentity,
    operation: OwnerOperation,
  ): Promise<void> {
    await this.resolveMatchingTarget(handle, identity, operation);
    await assertPersistedTargetUnchanged(identity);
    operation.assertLive();
  }
}
