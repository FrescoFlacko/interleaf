import { randomUUID } from 'node:crypto';
import type { AgentProfile, AgentResumeRequest, AgentSession, AgentStartResult } from '@shared/types/agent';
import { agentResumeRequestSchema } from '@shared/schemas/agent';
import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import { resolveAgentRiskLevel } from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { AgentAdapter, AgentAdapterRun, AgentRegistry, CodexRepositoryTrust } from './agent-adapter';
import type { MainAgentProfile } from './profile-types';
import type { WorkingDirectoryRegistry } from './working-directory-registry';
import type { AgentEnvironmentManager } from './environment-manager';
import type { RiskConfirmationGrantBinding, RiskConfirmationGrantStore } from './risk-confirmation-grants';
import {
  assertAuthorityMatchesSession,
  assertDirectAuthorityUnchanged,
  assertPersistedTargetUnchanged,
  requireSessionRecords,
  type PersistedSessionAuthority,
  type PersistedTargetIdentity,
} from './session-authority';
import { fingerprintExecutionAuthority } from './execution-authority';
import { fingerprintDraft } from './agent-run-prompt';
import type { AgentProfileManager } from './agent-profile-manager';
import { isTerminalSessionStatus, type AgentRunRegistry, type LifecycleReservation, type StartingRun } from './agent-run-registry';
import type { AgentSessionOwnership, OwnerOperation } from './agent-session-ownership';
import type { AgentServiceLiveness } from './agent-service-liveness';
import type { AgentRunEvents } from './agent-run-events';
import { pickFileIdentity } from '../security/file-identity';
import {
  assessRunRisk,
  dangerousRunRefusal,
  type AgentRunAuthorization,
  type DirectWorkspaceConfirmation,
} from './agent-run-authorization';

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;

export type AgentSessionResumerOptions = {
  readonly repository: AgentRepository;
  readonly directories: WorkingDirectoryRegistry;
  readonly agents: AgentRegistry;
  readonly profiles: AgentProfileManager;
  readonly environments: AgentEnvironmentManager;
  readonly runs: AgentRunRegistry;
  readonly ownership: AgentSessionOwnership;
  readonly events: AgentRunEvents;
  readonly liveness: AgentServiceLiveness;
  readonly authorization: AgentRunAuthorization;
  readonly riskGrants: RiskConfirmationGrantStore;
  /** Main-owned native confirmation before a run touches the target directly. */
  readonly confirmDirectWorkspace: (input: DirectWorkspaceConfirmation) => Promise<boolean>;
};

type ResumableAdapter = AgentAdapter & { readonly resume: NonNullable<AgentAdapter['resume']> };

/** The request after every synchronous check, before anything is awaited. */
type ResumePlan = {
  readonly prompt: string;
  readonly session: AgentSession;
  readonly profile: AgentProfile;
  readonly adapter: ResumableAdapter;
  readonly mainProfile: MainAgentProfile;
  readonly ownerId: number;
};

/** What the persisted records allow this resume to do. */
type ResumeAuthority = {
  readonly targetIdentity: PersistedTargetIdentity;
  readonly authority: PersistedSessionAuthority;
  readonly workspacePath: string;
  readonly profileFingerprint: string;
  readonly draftFingerprint: string;
};

/** What the adapter is handed once every proof has passed. */
type ResumeLaunch = {
  readonly authority: PersistedSessionAuthority;
  readonly workspacePath: string;
  readonly codexRepositoryTrust: CodexRepositoryTrust;
};

function isResumable(adapter: AgentAdapter | undefined): adapter is ResumableAdapter {
  return adapter !== undefined && typeof adapter.resume === 'function';
}

function isDirectMode(mode: AgentSession['executionMode']): mode is DirectWorkspaceConfirmation['mode'] {
  return mode === 'active-env' || mode === 'native-restricted';
}

/**
 * Read through a call so the compiler does not carry an earlier narrowing of
 * the flag across the awaits that a stop can arrive during.
 */
function isStopRequested(claim: StartingRun): boolean {
  return claim.cancelRequested;
}

function isWithinResumeWindow(createdAt: string): boolean {
  const createdTime = new Date(createdAt).getTime();
  const now = Date.now();
  return !Number.isNaN(createdTime) && createdTime <= now + CLOCK_SKEW_MS && now - createdTime <= RESUME_WINDOW_MS;
}

/**
 * Resumes a terminal session under the authority it was started with: plan,
 * claim and reserve, prove the persisted records, confirm, prove again, then
 * spawn. Nothing is persisted until the adapter has returned a live handle,
 * so a rejected resume leaves the prior attempt's record untouched.
 */
export class AgentSessionResumer {
  private readonly options: AgentSessionResumerOptions;

  constructor(options: AgentSessionResumerOptions) {
    this.options = options;
  }

  async resume(input: AgentResumeRequest, ownerId: number): Promise<AgentStartResult> {
    const { ownership, runs } = this.options;
    this.options.liveness.assertAcceptingRuns();
    const plan = this.plan(input, ownerId);
    const sessionId = plan.session.id;
    const operation = ownership.beginOperation(ownerId);
    const claim = runs.claim(sessionId, ownerId, 'resume');
    let reservation: LifecycleReservation | null = null;
    try {
      // Reserve synchronously before the first async directory/confirmation
      // boundary. A lifecycle action must also fail closed while this request
      // is waiting for native confirmation or adapter startup.
      reservation = runs.reserveLifecycle(sessionId, 'resume');
      operation.assertLive();
      this.options.environments.assertResumeAvailable(sessionId);
      return await this.authorizeAndSpawn(plan, claim, operation);
    } finally {
      if (reservation !== null) runs.releaseLifecycle(sessionId, reservation);
      runs.releaseClaim(sessionId);
      ownership.finishOperation(operation);
    }
  }

  private plan(input: AgentResumeRequest, ownerId: number): ResumePlan {
    const request = agentResumeRequestSchema.parse(input);
    this.options.ownership.assertOwner(request.sessionId, ownerId);
    const session = this.options.repository.getSession(request.sessionId);
    if (session === null) throw new InterleafError('validation', 'The agent session no longer exists.');
    if (!isTerminalSessionStatus(session.status) || this.options.runs.isActive(session.id)) {
      throw new InterleafError('validation', 'Only terminal agent sessions can be resumed.');
    }
    if (!isWithinResumeWindow(session.createdAt)) {
      throw new InterleafError('validation', 'Agent sessions older than 24 hours cannot be resumed.');
    }
    const { profile, adapter } = this.resumableProfile(session);
    if (profile.providerId === 'codex' && (session.providerSessionId === null || session.providerSessionId.trim().length === 0)) {
      throw new InterleafError('validation', 'The session does not have a recorded provider thread ID to resume.');
    }
    if (session.effectiveModel !== null && !isAgentModelIdentifier(session.effectiveModel)) {
      throw new InterleafError('validation', 'The recorded agent model for this session is not a valid identifier.');
    }
    return { prompt: request.prompt, session, profile, adapter, mainProfile: adapter.profile, ownerId };
  }

  private resumableProfile(session: AgentSession): { readonly profile: AgentProfile; readonly adapter: ResumableAdapter } {
    const profile = this.options.profiles.find(session.profileId);
    if (profile === undefined) throw new InterleafError('validation', 'The selected agent profile is unavailable.');
    if (profile.detection.availability !== 'installed') throw new InterleafError('validation', `${profile.name} is not installed.`);
    const adapter = this.options.agents.getAdapter(profile.id);
    if (!profile.capabilities.sessionResume || !isResumable(adapter)) {
      throw new InterleafError('validation', `${profile.name} does not support session resume.`);
    }
    return { profile, adapter };
  }

  private async authorizeAndSpawn(plan: ResumePlan, claim: StartingRun, operation: OwnerOperation): Promise<AgentStartResult> {
    const resumeAuthority = await this.loadPersistedAuthority(plan, operation);
    await this.confirmDirectWorkspace(plan, resumeAuthority, operation);
    await this.confirmDangerousResume(plan, resumeAuthority, operation);
    operation.assertLive();
    await this.resolveMatchingTarget(plan, resumeAuthority, operation);
    // Direct modes run in the persisted canonical target, not in whatever the
    // registry currently maps this handle to.
    const workspacePath = isDirectMode(plan.session.executionMode)
      ? resumeAuthority.targetIdentity.canonicalPath
      : resumeAuthority.workspacePath;
    if (claim.cancelRequested) return this.currentSession(plan);
    // Nothing below is persisted until the adapter has returned a live run
    // handle. A rejected resume is not a new attempt: the prior completed run
    // keeps its exact terminal status and final report, and gains no run
    // generation, no `running` transition, and no error event. Failures
    // therefore propagate untouched instead of being written to the session.
    const codexRepositoryTrust = await this.proveReadyToSpawn(plan, resumeAuthority, operation);
    // No await between here and the adapter: resuming from the final proof is
    // itself a turn in which the owner can die or the runtime can shut down.
    if (isStopRequested(claim)) {
      // A stop arrived during the confirmation, the capability proof, or any
      // other await above. No child is spawned and no record is written: the
      // prior terminal status, final report, and event history stand.
      return this.currentSession(plan);
    }
    operation.assertLive();
    return this.spawn(plan, claim, { authority: resumeAuthority.authority, workspacePath, codexRepositoryTrust });
  }

  /**
   * The persisted session records — not the current registry entry and not
   * the profile's current defaults — decide what this resume is allowed to do.
   * Both are read and proven before any confirmation dialog, workspace read,
   * repository write, or adapter spawn.
   */
  private async loadPersistedAuthority(plan: ResumePlan, operation: OwnerOperation): Promise<ResumeAuthority> {
    const { session, mainProfile } = plan;
    const persisted = requireSessionRecords(this.options.repository.getSessionAuthority(session.id));
    const targetIdentity = await assertPersistedTargetUnchanged(persisted.targetIdentity);
    operation.assertLive();
    const { authority } = persisted;
    assertAuthorityMatchesSession({
      executionMode: session.executionMode,
      profileId: session.profileId,
      directoryHandle: session.targetDirectory.handle,
    }, persisted);
    const workspacePath = this.environmentWorkspacePath(session.id);
    const resumeAuthority: ResumeAuthority = {
      targetIdentity,
      authority,
      workspacePath,
      profileFingerprint: fingerprintExecutionAuthority(mainProfile),
      draftFingerprint: fingerprintDraft({
        profileId: plan.profile.id,
        workingDirectoryHandle: session.targetDirectory.handle,
        executionMode: session.executionMode,
        prompt: plan.prompt,
        draftId: null,
        model: null,
        contextPacket: null,
      }),
    };
    await this.resolveMatchingTarget(plan, resumeAuthority, operation);
    assertDirectAuthorityUnchanged(session.executionMode, {
      profileFingerprint: resumeAuthority.profileFingerprint,
      effectivePermissionPolicy: mainProfile.permissionMode,
    }, authority);
    // An early gate, bound to the exact executable and argv contract the
    // session was started under, so an already-unprovable capability is
    // rejected before the user is asked to confirm anything. It is not the
    // authorization: a second, uncached proof runs immediately before the
    // adapter is entered.
    if (session.executionMode === 'native-restricted') {
      await this.options.authorization.proveRecordedNativeSandbox(mainProfile, authority, 'cached');
      operation.assertLive();
    }
    return resumeAuthority;
  }

  private environmentWorkspacePath(sessionId: string): string {
    try {
      return this.options.environments.getWorkspacePath(sessionId);
    } catch (error) {
      throw new InterleafError('validation', 'The agent environment is no longer available.', { cause: error instanceof Error ? error : null });
    }
  }

  /**
   * A direct-workspace resume asks again, re-proves the target after the
   * dialog, and spends a one-shot grant bound to the persisted policy and the
   * persisted canonical identity — never to the profile's current permission
   * mode or to whatever the registry happens to resolve now.
   */
  private async confirmDirectWorkspace(plan: ResumePlan, resumeAuthority: ResumeAuthority, operation: OwnerOperation): Promise<void> {
    const { authority, targetIdentity } = resumeAuthority;
    const mode = plan.session.executionMode;
    if (!isDirectMode(mode)) return;
    const isExpertShell = plan.mainProfile.customConfig?.executionKind === 'expert-shell';
    const approved = await this.options.confirmDirectWorkspace({
      mode,
      riskLevel: resolveAgentRiskLevel({ mode, dangerousProfile: authority.unsafeProfile || isExpertShell }),
      canonicalTargetPath: targetIdentity.canonicalPath,
      profileName: plan.profile.name,
    });
    operation.assertLive();
    if (!approved) throw new InterleafError('security-violation', 'Direct workspace confirmation was cancelled.');
    await this.resolveMatchingTarget(plan, resumeAuthority, operation);
    // Re-proved after the confirmation await, because the dialog is an
    // arbitrarily long window in which the target could be swapped.
    await assertPersistedTargetUnchanged(targetIdentity);
    operation.assertLive();
    const binding: RiskConfirmationGrantBinding = {
      draftId: randomUUID(),
      directoryHandle: targetIdentity.directoryHandle,
      profileId: authority.profileId,
      profileFingerprint: authority.profileFingerprint,
      effectivePermissionPolicy: authority.effectivePermissionPolicy,
      canonicalTargetPath: targetIdentity.canonicalPath,
      ...pickFileIdentity(targetIdentity),
      mode,
      draftFingerprint: resumeAuthority.draftFingerprint,
      ownerId: plan.ownerId,
    };
    const issued = this.options.riskGrants.issue(binding);
    if (!this.options.riskGrants.consume(issued.grantId, binding)) {
      throw new InterleafError('security-violation', 'Risk confirmation grant consumption failed.');
    }
  }

  /** A resume proves it is still live before it looks at the answer. */
  private async confirmDangerousResume(plan: ResumePlan, resumeAuthority: ResumeAuthority, operation: OwnerOperation): Promise<void> {
    const mode = plan.session.executionMode;
    const risk = assessRunRisk(plan.mainProfile, mode);
    const decision = await this.options.authorization.confirmDangerousRun(plan.mainProfile, risk, {
      mode,
      // The registry entry was proven to match this identity before any
      // confirmation, so this is the path the session was authorized against.
      canonicalTargetPath: resumeAuthority.targetIdentity.canonicalPath,
      profileFingerprint: resumeAuthority.profileFingerprint,
      draftFingerprint: resumeAuthority.draftFingerprint,
    });
    if (decision === 'not-required') return;
    operation.assertLive();
    if (decision === 'declined') throw dangerousRunRefusal(risk);
    await this.options.directories.resolve(plan.session.targetDirectory.handle);
    operation.assertLive();
  }

  /** The final proofs, after every confirmation; returns the Codex trust decision. */
  private async proveReadyToSpawn(plan: ResumePlan, resumeAuthority: ResumeAuthority, operation: OwnerOperation): Promise<CodexRepositoryTrust> {
    const { authorization, profiles } = this.options;
    const { session, mainProfile } = plan;
    const { targetIdentity } = resumeAuthority;
    operation.assertLive();
    await profiles.assertCustomExecutableReady(mainProfile);
    operation.assertLive();
    await this.resolveMatchingTarget(plan, resumeAuthority, operation);
    await assertPersistedTargetUnchanged(targetIdentity);
    operation.assertLive();
    const codexRepositoryTrust = await authorization.resolveCodexRepositoryTrust(plan.profile.providerId, session.executionMode, targetIdentity.canonicalPath);
    operation.assertLive();
    // Final, uncached proof, after the confirmation dialog and every other
    // unbounded await. The earlier check only decides whether to ask the
    // user; this one decides whether to spawn.
    if (session.executionMode === 'native-restricted') {
      await authorization.proveRecordedNativeSandbox(mainProfile, resumeAuthority.authority, 'fresh');
      operation.assertLive();
    }
    // Last check before the adapter: the proof above is itself a multi-second
    // window in which the target could be replaced or repointed.
    await authorization.revalidateTargetBeforeSpawn(session.targetDirectory.handle, targetIdentity, operation);
    return codexRepositoryTrust;
  }

  private spawn(plan: ResumePlan, claim: StartingRun, launch: ResumeLaunch): AgentStartResult {
    const { repository, runs } = this.options;
    const { session, ownerId } = plan;
    const { authority, workspacePath, codexRepositoryTrust } = launch;
    const adapterRun = plan.adapter.resume(session.providerSessionId ?? session.id, {
      sessionId: session.id,
      prompt: plan.prompt,
      canonicalWorkingDirectory: workspacePath,
      model: session.effectiveModel,
      // The persisted snapshot, so a later profile edit cannot change the
      // reasoning effort an existing session resumes under.
      reasoningEffort: session.effectiveReasoningEffort ?? authority.reasoningEffort,
      executionMode: session.executionMode,
      // Preserves the exact native-restricted sandbox argv across resume.
      // Empty for every other mode, and proven again just before this call.
      sandboxArgs: authority.sandboxArgs,
      codexRepositoryTrust,
    });
    claim.attach(adapterRun);
    this.recordRunning(session.id, adapterRun);
    if (runs.isClaimCancelled(session.id)) {
      adapterRun.cancel();
      this.options.events.recordCancelled(session.id, ownerId);
      return this.currentSession(plan);
    }
    runs.activate(session.id, ownerId, adapterRun);
    return { session: repository.getSession(session.id) ?? session };
  }

  /**
   * The handle is live, so the new attempt is now real and must be recorded.
   * If persistence fails the child is cancelled rather than left running
   * behind a session that never advanced.
   */
  private recordRunning(sessionId: string, adapterRun: AgentAdapterRun): void {
    try {
      this.options.repository.updateSession(sessionId, { status: 'running' });
    } catch (error) {
      adapterRun.cancel();
      throw error;
    }
  }

  private async resolveMatchingTarget(plan: ResumePlan, resumeAuthority: ResumeAuthority, operation: OwnerOperation): Promise<void> {
    await this.options.authorization.resolveMatchingTarget(plan.session.targetDirectory.handle, resumeAuthority.targetIdentity, operation);
  }

  private currentSession(plan: ResumePlan): AgentStartResult {
    return { session: this.options.repository.getSession(plan.session.id) ?? plan.session };
  }
}
