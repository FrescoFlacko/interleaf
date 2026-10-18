import { createHash } from 'node:crypto';
import type {
  AgentProfile,
  AgentRunRequest,
  AgentRunRequestInput,
  AgentSession,
  AgentStartResult,
} from '@shared/types/agent';
import { agentContextPacketSchema, agentStartRequestSchema } from '@shared/schemas/agent';
import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import type { ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { AgentAdapter, AgentAdapterRun, AgentRegistry, CodexRepositoryTrust } from './agent-adapter';
import { resolveMainProfileModels, type MainAgentProfile } from './profile-types';
import type { RegisteredWorkingDirectory, WorkingDirectoryRegistry } from './working-directory-registry';
import type { AgentEnvironmentManager, PreparedEnvironment } from './environment-manager';
import type { RiskConfirmationGrantStore } from './risk-confirmation-grants';
import { resolveExecutionMode, type ModeResolverOptions } from './mode-resolver';
import type { VerifiedNativeSandbox } from './native-sandbox-probe';
import { buildSessionAuthority, type PersistedSessionAuthority, type PersistedTargetIdentity } from './session-authority';
import { fingerprintExecutionAuthority } from './execution-authority';
import { buildPrompt, fingerprintDraft, summarizeContext } from './agent-run-prompt';
import type { AgentProfileManager } from './agent-profile-manager';
import type { AgentRunRegistry, StartingRun } from './agent-run-registry';
import type { AgentSessionOwnership, OwnerOperation } from './agent-session-ownership';
import type { AgentServiceLiveness } from './agent-service-liveness';
import { assessRunRisk, dangerousRunRefusal, type AgentRunAuthorization, type RunRisk } from './agent-run-authorization';
import type { AgentContextPackets } from './agent-context-packets';
import type { AgentStartupRollback } from './agent-startup-rollback';
import { pickFileIdentity } from '../security/file-identity';

export type AgentSessionStarterOptions = {
  readonly repository: AgentRepository;
  readonly directories: WorkingDirectoryRegistry;
  readonly agents: AgentRegistry;
  readonly profiles: AgentProfileManager;
  readonly environments: AgentEnvironmentManager;
  readonly runs: AgentRunRegistry;
  readonly ownership: AgentSessionOwnership;
  readonly liveness: AgentServiceLiveness;
  readonly authorization: AgentRunAuthorization;
  readonly contextPackets: AgentContextPackets;
  readonly rollback: AgentStartupRollback;
  readonly riskGrants: RiskConfirmationGrantStore;
  readonly isGitRepository: (canonicalPath: string) => Promise<boolean>;
};

/** The request after every synchronous check, before anything is awaited. */
type StartPlan = {
  readonly request: AgentRunRequest;
  readonly profile: AgentProfile;
  readonly adapter: AgentAdapter;
  readonly mainProfile: MainAgentProfile;
  readonly effectiveModel: string | null;
};

/** What the start was authorized to do, proved before the session exists. */
type AuthorizedStart = {
  readonly mode: ResolvedAgentExecutionMode;
  readonly directory: RegisteredWorkingDirectory;
  readonly risk: RunRisk;
  readonly profileFingerprint: string;
  readonly verifiedNative: VerifiedNativeSandbox | null;
};

/** A persisted session whose run has been claimed but not yet spawned. */
type ClaimedStart = {
  readonly plan: StartPlan;
  readonly authorized: AuthorizedStart;
  readonly session: AgentSession;
  readonly claim: StartingRun;
  readonly ownerId: number;
  readonly targetIdentity: PersistedTargetIdentity;
  readonly sessionAuthority: PersistedSessionAuthority;
};

/** Each startup step either continues with a value or ends a cancelled start. */
type StartupStep<T> =
  | { readonly kind: 'continued'; readonly value: T }
  | { readonly kind: 'cancelled'; readonly session: AgentSession };

function stepResult<T>(value: T, cancelled: AgentSession | null): StartupStep<T> {
  return cancelled === null ? { kind: 'continued', value } : { kind: 'cancelled', session: cancelled };
}

function folderDisplayName(canonicalPath: string): string {
  return canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'Selected folder';
}

/**
 * Decides whether an explicit per-run model may reach the tokenized argv slot.
 *
 * Built-in profiles publish a bounded, settings-derived allowlist through
 * `AgentProfile.availableModels`; a per-run model must be a member of exactly
 * that set, so the renderer can never launch a combination it was not offered.
 *
 * Custom profiles are owned by the main-side profile store and carry no
 * settings-persisted model list, so they keep their existing contract: any
 * well-formed model identifier their user-authored argv template accepts. The
 * identifier grammar still rejects whitespace, quotes, and leading dashes, and
 * the value is only ever passed as one whole argv token with `shell: false`.
 * Giving custom profiles their own allowlist needs a profile-schema change and
 * is deliberately left out of this work unit.
 */
function isAcceptableRunModel(profile: MainAgentProfile, model: string): boolean {
  if (!isAgentModelIdentifier(model)) return false;
  if (!profile.capabilities.modelSelection) return true;
  if (profile.isCustom || profile.providerId === 'custom') return true;
  return resolveMainProfileModels(profile).includes(model);
}

/**
 * Starts a fresh agent session: plan, authorize, persist and claim, prepare
 * the environment, persist the context packet, then spawn and activate.
 * Cancellation is observed between steps, and every await is followed by a
 * proof that the owner's operation is still live.
 */
export class AgentSessionStarter {
  private readonly options: AgentSessionStarterOptions;

  constructor(options: AgentSessionStarterOptions) {
    this.options = options;
  }

  async start(input: AgentRunRequestInput, ownerId: number): Promise<AgentStartResult> {
    this.options.liveness.assertAcceptingRuns();
    const plan = this.plan(input);
    const operation = this.options.ownership.beginOperation(ownerId);
    let claimedSessionId: string | null = null;
    try {
      const authorized = await this.authorize(plan, ownerId, operation);
      // Resuming from `authorize` is itself a turn in which the owner can die.
      operation.assertLive();
      const claimed = this.createSession(plan, authorized, ownerId);
      claimedSessionId = claimed.session.id;
      return await this.launch(claimed, operation);
    } finally {
      if (claimedSessionId !== null) this.options.runs.releaseClaim(claimedSessionId);
      this.options.ownership.finishOperation(operation);
    }
  }

  private plan(input: AgentRunRequestInput): StartPlan {
    const request = agentStartRequestSchema.parse(input);
    const profile = this.options.profiles.find(request.profileId);
    if (profile === undefined) throw new InterleafError('validation', 'The selected agent profile is unavailable.');
    if (profile.detection.availability !== 'installed') throw new InterleafError('validation', `${profile.name} is not installed.`);
    // An empty selection means "use this profile's configured default"; only a
    // non-empty identifier is treated as an explicit per-run model choice.
    const requestedModel = request.model === null || request.model.length === 0 ? null : request.model;
    if (requestedModel !== null && !profile.capabilities.modelSelection) throw new InterleafError('validation', 'The selected agent profile does not support model selection.');
    if (request.contextPacket !== null) agentContextPacketSchema.parse(request.contextPacket);
    const adapter = this.options.agents.getAdapter(profile.id);
    if (adapter === undefined) throw new InterleafError('internal', 'The selected agent adapter is unavailable.');
    const mainProfile = adapter.profile;
    const effectiveModel = requestedModel ?? mainProfile.defaultModel;
    if (requestedModel !== null && !isAcceptableRunModel(mainProfile, requestedModel)) {
      throw new InterleafError('validation', 'The selected model is not available for this agent profile.');
    }
    if (effectiveModel !== null && !isAcceptableRunModel(mainProfile, effectiveModel)) {
      throw new InterleafError('validation', 'The effective agent model is not available for this agent profile.');
    }
    return { request, profile, adapter, mainProfile, effectiveModel };
  }

  /** Resolves the concrete mode and proves every confirmation it requires. */
  private async authorize(plan: StartPlan, ownerId: number, operation: OwnerOperation): Promise<AuthorizedStart> {
    const { directories } = this.options;
    const handle = plan.request.workingDirectoryHandle;
    await directories.resolve(handle);
    operation.assertLive();
    this.assertUnattendedRunAllowed(plan.profile);
    const profileFingerprint = fingerprintExecutionAuthority(plan.mainProfile);
    const draftFingerprint = fingerprintDraft({ ...plan.request, draftId: plan.request.riskConfirmation?.draftId ?? null });
    // Auto-isolated is a real validated request mode, not a placeholder for a
    // profile preference. The resolver must inspect this target and choose a
    // Git worktree (or a directory copy) before the adapter is started.
    const mode = await resolveExecutionMode(plan.request.executionMode, this.modeOptions(plan, ownerId, profileFingerprint, draftFingerprint));
    operation.assertLive();
    const resolved = await directories.resolve(handle);
    operation.assertLive();
    const risk = assessRunRisk(plan.mainProfile, mode);
    await this.confirmDangerousStart(plan, risk, { mode, canonicalTargetPath: resolved.canonicalPath, profileFingerprint, draftFingerprint }, operation);
    operation.assertLive();
    const directory = await directories.resolve(handle);
    operation.assertLive();
    // Native Restricted is re-proved here, after every confirmation and
    // immediately before the session row exists — so the capability that is
    // persisted and later enforced is the one that was true at this instant,
    // not one cached from mode selection. Nothing has been spawned yet.
    const verifiedNative = mode === 'native-restricted'
      ? await this.options.authorization.requireNativeSandboxProof(plan.mainProfile)
      : null;
    operation.assertLive();
    return { mode, directory, risk, profileFingerprint, verifiedNative };
  }

  private assertUnattendedRunAllowed(profile: AgentProfile): void {
    if (profile.providerId === 'copilot') {
      throw new InterleafError('validation', 'GitHub Copilot CLI is unavailable for unattended Agent Mode.');
    }
    if (!profile.capabilities.nonInteractiveMode) {
      throw new InterleafError('validation', `${profile.name} is unavailable for unattended Agent Mode.`);
    }
    if (profile.providerId === 'fake' && !this.options.profiles.isFakeAllowed()) {
      throw new InterleafError('security-violation', 'The selected agent profile is unavailable.');
    }
  }

  private modeOptions(plan: StartPlan, ownerId: number, profileFingerprint: string, draftFingerprint: string): ModeResolverOptions {
    const { authorization, directories, riskGrants } = this.options;
    const { mainProfile, request } = plan;
    return {
      directoryHandle: request.workingDirectoryHandle,
      directoryRegistry: directories,
      isGitRepo: this.options.isGitRepository,
      ...(request.riskConfirmation === null ? {} : {
        riskConfirmationGrant: {
          grantId: request.riskConfirmation.grantId,
          draftId: request.riskConfirmation.draftId,
          profileId: plan.profile.id,
          profileFingerprint,
          effectivePermissionPolicy: mainProfile.permissionMode,
          draftFingerprint,
          ownerId,
          store: riskGrants,
        },
      }),
      supportsNativeRestricted: () => authorization.supportsNativeRestricted(mainProfile),
    };
  }

  /** A start refuses a declined confirmation before proving it is still live. */
  private async confirmDangerousStart(
    plan: StartPlan,
    risk: RunRisk,
    binding: { readonly mode: ResolvedAgentExecutionMode; readonly canonicalTargetPath: string; readonly profileFingerprint: string; readonly draftFingerprint: string },
    operation: OwnerOperation,
  ): Promise<void> {
    const decision = await this.options.authorization.confirmDangerousRun(plan.mainProfile, risk, binding);
    if (decision === 'not-required') return;
    if (decision === 'declined') throw dangerousRunRefusal(risk);
    operation.assertLive();
    await this.options.directories.resolve(plan.request.workingDirectoryHandle);
    operation.assertLive();
  }

  /**
   * Registers the authoritative identity immediately before creating the
   * session, so a rehydrated handle remains valid across restarts and a stale
   * handle cannot become a dangling persisted session. Then binds the owner
   * and claims the run.
   */
  private createSession(plan: StartPlan, authorized: AuthorizedStart, ownerId: number): ClaimedStart {
    const { repository } = this.options;
    const { directory, mode, profileFingerprint } = authorized;
    const { mainProfile, profile, request } = plan;
    const displayName = folderDisplayName(directory.canonicalPath);
    repository.registerWorkingDirectory({
      handle: directory.handle,
      canonicalPath: directory.canonicalPath,
      displayName,
      ...pickFileIdentity(directory),
    });
    const targetIdentity: PersistedTargetIdentity = {
      version: 1,
      directoryHandle: directory.handle,
      canonicalPath: directory.canonicalPath,
      ...pickFileIdentity(directory),
    };
    const sessionAuthority = buildSessionAuthority({
      profileId: profile.id,
      profileFingerprint,
      effectivePermissionPolicy: mainProfile.permissionMode,
      executionMode: mode,
      unsafeProfile: mainProfile.unsafe,
      reasoningEffort: mainProfile.reasoningEffort ?? null,
    }, authorized.verifiedNative);
    const session = repository.createSession({
      documentId: request.documentId,
      profileId: profile.id,
      providerId: profile.providerId,
      targetDirectory: { handle: request.workingDirectoryHandle, displayName },
      canonicalTargetPath: directory.canonicalPath,
      sandboxMode: mode,
      userPrompt: request.prompt,
      contextSummary: summarizeContext(request.contextPacket),
      effectiveModel: plan.effectiveModel ?? null,
      effectiveReasoningEffort: mainProfile.reasoningEffort ?? null,
      baselineFingerprint: createHash('sha256').update(`${String(directory.device)}:${String(directory.inode)}:${directory.canonicalPath}`).digest('hex'),
      // Durable, main-only. Both records are enforced at every later
      // privileged continuation instead of re-deriving authority from whatever
      // the registry and profile settings happen to say at that time.
      targetIdentity,
      authority: sessionAuthority,
    });
    this.options.ownership.record(session.id, ownerId);
    const claim = this.options.runs.claim(session.id, ownerId, 'start');
    return { plan, authorized, session, claim, ownerId, targetIdentity, sessionAuthority };
  }

  private async launch(claimed: ClaimedStart, operation: OwnerOperation): Promise<AgentStartResult> {
    const cancelled = await this.options.rollback.settleIfCancelled(claimed.session, null, claimed.ownerId);
    if (cancelled !== null) return { session: cancelled };
    const prepared = await this.prepareEnvironment(claimed, operation);
    if (prepared.kind === 'cancelled') return { session: prepared.session };
    const context = await this.persistContext(claimed, operation);
    if (context.kind === 'cancelled') return { session: context.session };
    return this.spawn(claimed, prepared.value, context.value, operation);
  }

  private async prepareEnvironment(claimed: ClaimedStart, operation: OwnerOperation): Promise<StartupStep<PreparedEnvironment>> {
    const { environments, repository, rollback } = this.options;
    const { authorized, session } = claimed;
    try {
      const prepared = await environments.prepare({
        sessionId: session.id,
        mode: authorized.mode,
        canonicalTargetPath: authorized.directory.canonicalPath,
        expectedIdentity: pickFileIdentity(authorized.directory),
        dangerousProfile: authorized.risk.dangerousProfile,
      });
      await this.revalidateHandle(claimed, operation);
      // Resuming from that await is itself a turn in which the owner can die.
      operation.assertLive();
      repository.updateSession(session.id, {
        environment: { ...prepared.review, sessionId: session.id },
        environmentWorkspacePath: prepared.workspacePath,
        environmentState: 'prepared',
      });
      return stepResult(prepared, await rollback.settleIfCancelled(session, null, claimed.ownerId));
    } catch (error) {
      await rollback.fail(session.id, error instanceof Error ? error : null);
      throw error;
    }
  }

  /** Returns the context packet path, or `null` when the request had none. */
  private async persistContext(claimed: ClaimedStart, operation: OwnerOperation): Promise<StartupStep<string | null>> {
    const { contextPackets, repository, rollback } = this.options;
    const { session } = claimed;
    const packet = claimed.plan.request.contextPacket;
    let contextPath: string | null = null;
    try {
      if (packet !== null) contextPath = await contextPackets.persist(session, packet, operation);
      await this.revalidateHandle(claimed, operation);
      operation.assertLive();
      repository.updateSession(session.id, { status: 'running' });
      return stepResult(contextPath, await rollback.settleIfCancelled(session, contextPath, claimed.ownerId));
    } catch (error) {
      await rollback.fail(session.id, error instanceof Error ? error : null);
      throw error;
    }
  }

  private async spawn(
    claimed: ClaimedStart,
    prepared: PreparedEnvironment,
    contextPath: string | null,
    operation: OwnerOperation,
  ): Promise<AgentStartResult> {
    const { repository, rollback, runs } = this.options;
    const { session, ownerId } = claimed;
    let adapterRun: AgentAdapterRun | null;
    try {
      const codexRepositoryTrust = await this.proveReadyToSpawn(claimed, operation);
      // No await between this liveness proof, the adapter start and
      // activation: resuming from the final proof is itself a turn in which
      // the owner can die, and the event consumer must begin reading in the
      // same turn the adapter run starts.
      adapterRun = claimed.claim.cancelRequested ? null : this.startLiveAdapter(claimed, prepared, codexRepositoryTrust, operation);
    } catch (error) {
      await rollback.fail(session.id, error instanceof Error ? error : null);
      throw error;
    }
    if (adapterRun !== null) claimed.claim.attach(adapterRun);
    if (adapterRun === null || runs.isClaimCancelled(session.id)) {
      adapterRun?.cancel();
      await rollback.cancel(session.id, contextPath, ownerId);
      runs.releaseClaim(session.id);
      return { session: repository.getSession(session.id) ?? session };
    }
    runs.activate(session.id, ownerId, adapterRun);
    return { session: repository.getSession(session.id) ?? session };
  }

  private async proveReadyToSpawn(claimed: ClaimedStart, operation: OwnerOperation): Promise<CodexRepositoryTrust> {
    const { authorization, directories, profiles } = this.options;
    const { authorized, plan } = claimed;
    const { request } = plan;
    operation.assertLive();
    await profiles.assertCustomExecutableReady(plan.mainProfile);
    operation.assertLive();
    const directory = await directories.resolve(request.workingDirectoryHandle);
    operation.assertLive();
    const codexRepositoryTrust = await authorization.resolveCodexRepositoryTrust(plan.profile.providerId, authorized.mode, directory.canonicalPath);
    operation.assertLive();
    // Final, uncached proof: everything between the earlier proof and this
    // line (environment preparation, context persistence, Git inspection) is
    // an unbounded window. A binary replaced or drifted inside it must stop
    // the start before the adapter is entered.
    if (authorized.mode === 'native-restricted') {
      await authorization.proveRecordedNativeSandbox(plan.mainProfile, claimed.sessionAuthority, 'fresh');
      operation.assertLive();
    }
    // After the proof, and after every other await above: the target must
    // still be the exact directory this session was authorized against.
    await authorization.revalidateTargetBeforeSpawn(request.workingDirectoryHandle, claimed.targetIdentity, operation);
    return codexRepositoryTrust;
  }

  private startLiveAdapter(
    claimed: ClaimedStart,
    prepared: PreparedEnvironment,
    codexRepositoryTrust: CodexRepositoryTrust,
    operation: OwnerOperation,
  ): AgentAdapterRun {
    operation.assertLive();
    const { authorized, plan, session } = claimed;
    const { request } = plan;
    return plan.adapter.start({
      documentId: request.documentId,
      profileId: request.profileId,
      workingDirectoryHandle: request.workingDirectoryHandle,
      // Pass the main-resolved mode to the adapter. The renderer may request
      // auto-isolated, but the child process must only observe the concrete
      // isolation decision made after inspecting the target and profile.
      executionMode: authorized.mode,
      model: plan.effectiveModel,
      contextPacket: request.contextPacket,
      riskConfirmation: request.riskConfirmation,
      prompt: buildPrompt(request.prompt, request.contextPacket),
      canonicalWorkingDirectory: prepared.workspacePath,
      sessionId: session.id,
      codexRepositoryTrust,
    });
  }

  /** The step boundary: the owner is still live and the handle still resolves. */
  private async revalidateHandle(claimed: ClaimedStart, operation: OwnerOperation): Promise<void> {
    operation.assertLive();
    await this.options.directories.resolve(claimed.plan.request.workingDirectoryHandle);
    operation.assertLive();
  }
}
