import { describeError, reportRejection } from '@shared/models/caught-error';
import { writeFile } from 'node:fs/promises';
import type {
  AgentCopyResultResult,
  AgentSessionClaimResult,
  AgentEvent,
  AgentProfile,
  AgentProfileStatusSnapshot,
  AgentResumeRequest,
  AgentRunRequestInput,
  AgentSession,
  AgentSessionDetail,
  AgentStartResult,
  AgentWorkingDirectory,
} from '@shared/types/agent';
import { agentSessionRequestSchema, agentWorkingDirectorySchema } from '@shared/schemas/agent';
import type { AppSettings } from '@shared/schemas/settings';
import { agentRiskGrantRequestSchema } from '@shared/schemas/agent-environment';
import { resolveAgentRiskLevel } from '@shared/constants/agent-modes';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import { redactText } from './event-redaction';
import type { AgentRegistry } from './agent-adapter';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { CustomAgentProfileRepository } from '../db/repositories/custom-agent-profile-repository';
import type { WorkingDirectoryRegistry } from './working-directory-registry';
import type { ExecutableRegistry } from './executable-registry';
import type {
  AgentExecutableSelection,
  CustomAgentProfile,
  CustomAgentProfileCreateInput,
  CustomAgentProfileUpdateInput,
} from '@shared/types/custom-agent-profile';
import type { AgentEnvironmentManager } from './environment-manager';
import { RiskConfirmationGrantStore } from './risk-confirmation-grants';
import { defaultIsGitRepository } from './mode-resolver';
import type { AgentRiskGrantRequest, AgentEnvironmentReviewResult, AgentRiskGrant, AgentModeAvailability, AgentPatchExportResult } from '@shared/types/agent-environment';
import { NativeSandboxCapabilityProber } from './native-sandbox-probe';
import { assertPersistedTargetUnchanged, requireSessionRecords, type PersistedSessionRecords } from './session-authority';
import { fingerprintExecutionAuthority } from './execution-authority';
import { fingerprintDraft } from './agent-run-prompt';
import { AgentServiceLiveness } from './agent-service-liveness';
import { AgentProfileManager } from './agent-profile-manager';
import { AgentSessionOwnership } from './agent-session-ownership';
import { AgentRunEvents } from './agent-run-events';
import { AgentRunRegistry, isTerminalSessionStatus } from './agent-run-registry';
import { AgentRunAuthorization, type DangerousRunConfirmation, type DirectWorkspaceConfirmation } from './agent-run-authorization';
import { AgentContextPackets } from './agent-context-packets';
import { AgentStartupRollback } from './agent-startup-rollback';
import { AgentSessionStarter } from './agent-session-start';
import { AgentSessionResumer } from './agent-session-resume';
import { pickFileIdentity, sameFileIdentity } from '../security/file-identity';

export type AgentServiceOptions = {
  readonly repository: AgentRepository;
  readonly registry: WorkingDirectoryRegistry;
  readonly agentRegistry: AgentRegistry;
  readonly contextRoot: string;
  readonly chooseDirectory: () => Promise<string | null>;
  readonly log: Logger;
  readonly isPackaged: boolean;
  /** Explicit opt-in, honoured only when unpackaged. The renderer cannot set this option. */
  readonly allowFakeAgent: boolean;
  readonly isGitRepository?: (canonicalPath: string) => Promise<boolean>;
  readonly environmentManager: AgentEnvironmentManager;
  readonly riskGrantStore?: RiskConfirmationGrantStore;
  /** Main-owned native confirmation dialog. Production wires Electron dialog;
   * deterministic tests may inject an explicit decision. */
  readonly confirmDirectWorkspace: (input: DirectWorkspaceConfirmation) => Promise<boolean>;
  readonly customProfiles: CustomAgentProfileRepository;
  readonly executableRegistry: ExecutableRegistry;
  readonly chooseExecutable: () => Promise<string | null>;
  /** Test-only seam for exercising shutdown while an app-owned context write
   * is awaiting I/O. Production uses the native fs implementation. */
  readonly writeContextPacket?: (path: string, data: string) => Promise<void>;
  readonly confirmUnsafeCustomProfile: (profileName: string) => Promise<boolean>;
  readonly confirmExpertShellProfile: (profileName: string) => Promise<boolean>;
  /** Fresh native confirmation for every unsafe/unverified run in every mode.
   * Tests inject a deterministic decision at this seam. */
  readonly confirmDangerousAgentRun: (input: DangerousRunConfirmation) => Promise<boolean>;
  readonly clipboard: { writeText(text: string): Promise<void> };
  /** Main-owned bounded native-sandbox capability probe. Tests may inject a
   * deterministic prober; the renderer can never supply one. */
  readonly nativeSandboxProber?: NativeSandboxCapabilityProber;
};

/** The single documented copy barrier error (docs/REMAINING_WORK.md item D). */
const COPY_REAPING_BARRIER_MESSAGE = 'The agent result cannot be copied until the agent process has finished and been reaped.';
const COPY_MAX_CHARACTERS = 65_536;
const COPY_MAX_BYTES = 256 * 1024;
const SHUTDOWN_DRAIN_MS = 10_000;

type EnvironmentAction = 'apply' | 'discard' | 'export-patch' | 'open-folder';

function writeContextPacketFile(path: string, data: string): Promise<void> {
  return writeFile(path, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

/** Resolves true when `waits` did not settle within the shutdown bound. */
async function drainTimedOut(waits: readonly Promise<void>[]): Promise<boolean> {
  let shutdownTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(true); }, SHUTDOWN_DRAIN_MS);
    timer.unref();
    shutdownTimer = timer;
  });
  const timedOut = await Promise.race([
    Promise.all(waits).then(() => false),
    timeoutPromise,
  ]);
  if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
  return timedOut;
}

/**
 * The agent runtime's coordinator. It keeps the public surface the IPC
 * dispatcher and the app bootstrap use, and delegates each responsibility to
 * its owner: profiles, session ownership, run lifecycle, event consumption,
 * start and resume authorization, context packets, and startup rollback.
 */
export class AgentService {
  private readonly repository: AgentRepository;
  private readonly directories: WorkingDirectoryRegistry;
  private readonly agents: AgentRegistry;
  private readonly chooseDirectory: () => Promise<string | null>;
  private readonly log: Logger;
  private readonly environments: AgentEnvironmentManager;
  private readonly riskGrants: RiskConfirmationGrantStore;
  private readonly confirmDirectWorkspace: AgentServiceOptions['confirmDirectWorkspace'];
  private readonly clipboard: { writeText(text: string): Promise<void> };
  private readonly nativeSandbox: NativeSandboxCapabilityProber;
  private readonly liveness = new AgentServiceLiveness();
  private readonly profiles: AgentProfileManager;
  private readonly ownership: AgentSessionOwnership;
  private readonly events: AgentRunEvents;
  private readonly runs: AgentRunRegistry;
  private readonly authorization: AgentRunAuthorization;
  private readonly contextPackets: AgentContextPackets;
  private readonly starter: AgentSessionStarter;
  private readonly resumer: AgentSessionResumer;

  constructor(options: AgentServiceOptions) {
    this.repository = options.repository;
    this.directories = options.registry;
    this.agents = options.agentRegistry;
    this.chooseDirectory = options.chooseDirectory;
    this.log = options.log;
    this.environments = options.environmentManager;
    this.riskGrants = options.riskGrantStore ?? new RiskConfirmationGrantStore();
    this.confirmDirectWorkspace = options.confirmDirectWorkspace;
    this.clipboard = options.clipboard;
    // The probe runs in the app-owned context directory, never in the user's
    // selected target.
    this.nativeSandbox = options.nativeSandboxProber ?? new NativeSandboxCapabilityProber({ probeCwd: options.contextRoot, log: options.log });
    const isGitRepository = options.isGitRepository ?? defaultIsGitRepository;
    const { liveness, repository, environments, log } = this;
    this.profiles = new AgentProfileManager({
      agents: this.agents,
      repository,
      customProfiles: options.customProfiles,
      executables: options.executableRegistry,
      chooseExecutable: options.chooseExecutable,
      confirmUnsafeCustomProfile: options.confirmUnsafeCustomProfile,
      confirmExpertShellProfile: options.confirmExpertShellProfile,
      liveness,
      log,
      // The application bootstrap must opt in explicitly; a packaged build
      // never exposes the fake agent whatever it is passed.
      allowFakeAgent: !options.isPackaged && options.allowFakeAgent,
    });
    this.ownership = new AgentSessionOwnership(liveness);
    this.events = new AgentRunEvents({ repository, environments, log, liveness });
    this.runs = new AgentRunRegistry({ log, consume: (sessionId, run) => this.events.consume(sessionId, run) });
    this.authorization = new AgentRunAuthorization({
      directories: this.directories,
      nativeSandbox: this.nativeSandbox,
      isGitRepository,
      confirmDangerousAgentRun: options.confirmDangerousAgentRun,
    });
    this.contextPackets = new AgentContextPackets({
      contextRoot: options.contextRoot,
      repository,
      liveness,
      writeContextPacket: options.writeContextPacket ?? writeContextPacketFile,
    });
    const rollback = new AgentStartupRollback({ repository, environments, runs: this.runs, events: this.events, liveness, log });
    const shared = {
      repository,
      agents: this.agents,
      profiles: this.profiles,
      environments,
      runs: this.runs,
      ownership: this.ownership,
      liveness,
      authorization: this.authorization,
      riskGrants: this.riskGrants,
      directories: this.directories,
    };
    this.starter = new AgentSessionStarter({ ...shared, contextPackets: this.contextPackets, rollback, isGitRepository });
    this.resumer = new AgentSessionResumer({ ...shared, events: this.events, confirmDirectWorkspace: this.confirmDirectWorkspace });
    this.directories.rehydrate(this.repository.listWorkingDirectories());
    // The durable row stays authoritative for the whole process lifetime. A
    // transient filesystem error evicts the registry's process-local entry, and
    // without this the still-persisted capability would report "invalid or
    // expired" forever. The registry re-verifies file identity and canonical path
    // against the filesystem before it trusts anything read back here.
    this.directories.useDurableSource((handle) => this.repository.getWorkingDirectory(handle));
  }

  async initialize(): Promise<void> {
    await this.contextPackets.sweepExpired();
    this.liveness.assertLive();
    await this.environments.initialize();
    this.liveness.assertLive();
    await this.profiles.load();
  }

  listProfiles(): readonly AgentProfile[] {
    return this.profiles.list();
  }

  /** Settled detection facts, without waiting for model catalogs. */
  listProfileStatuses(): AgentProfileStatusSnapshot {
    return this.profiles.listStatuses();
  }

  /** The renderer-facing profile list once the background model listing settles. */
  listDiscoveredProfiles(): Promise<readonly AgentProfile[]> {
    return this.profiles.listDiscovered();
  }

  /** Re-probes the installed CLIs, joining a refresh that is already running. */
  refreshDiscoveredModels(): Promise<readonly AgentProfile[]> {
    return this.profiles.refreshDiscoveredModels();
  }

  selectExecutable(): Promise<AgentExecutableSelection | null> {
    return this.profiles.selectExecutable();
  }

  listCustomProfiles(): readonly CustomAgentProfile[] {
    return this.profiles.listCustom();
  }

  createCustomProfile(request: CustomAgentProfileCreateInput): Promise<CustomAgentProfile> {
    return this.profiles.createCustom(request);
  }

  updateCustomProfile(request: CustomAgentProfileUpdateInput): Promise<CustomAgentProfile> {
    return this.profiles.updateCustom(request);
  }

  deleteCustomProfile(id: string): void {
    this.profiles.deleteCustom(id);
  }

  applyProfileSettings(settings: AppSettings['agent']['profiles']): void {
    this.profiles.applySettings(settings);
  }

  async listModeAvailability(profileId: string | null = null): Promise<readonly AgentModeAvailability[]> {
    this.liveness.assertLive();
    const profile = profileId === null ? undefined : this.agents.getAdapter(profileId)?.profile;
    const runtime = await this.environments.containerAvailability();
    this.liveness.assertLive();
    const native = profile !== undefined && (await this.authorization.supportsNativeRestricted(profile));
    this.liveness.assertLive();
    const containerReason = runtime === null
      ? 'Unavailable: Docker or Podman was not detected.'
      : 'Unavailable: a verified Interleaf container executor is not implemented.';
    const nativeReason = native
      ? null
      : 'Unavailable: the selected main-owned adapter has not proved a supported native sandbox and safe noninteractive arguments.';
    return [
      { mode: 'auto-isolated', available: true, reason: null, containerRuntime: runtime },
      { mode: 'isolated-worktree', available: true, reason: 'Available only for Git targets; explicit selection on a non-Git target fails closed.', containerRuntime: runtime },
      { mode: 'isolated-copy', available: true, reason: null, containerRuntime: runtime },
      { mode: 'native-restricted', available: native, reason: nativeReason, containerRuntime: runtime },
      { mode: 'active-env', available: true, reason: 'Requires a fresh main-owned confirmation grant for this exact draft.', containerRuntime: runtime },
      { mode: 'container-sandbox', available: false, reason: containerReason, containerRuntime: runtime },
    ];
  }

  async selectWorkingDirectory(): Promise<AgentWorkingDirectory | null> {
    this.liveness.assertLive();
    const chosen = await this.chooseDirectory();
    this.liveness.assertLive();
    if (chosen === null) return null;
    const selected = await this.directories.register(chosen);
    this.liveness.assertLive();
    const resolved = await this.directories.resolve(selected.handle);
    this.liveness.assertLive();
    this.repository.registerWorkingDirectory({
      handle: resolved.handle,
      canonicalPath: resolved.canonicalPath,
      displayName: selected.displayName,
      ...pickFileIdentity(resolved),
    });
    return selected;
  }

  subscribe(ownerId: number, callback: (event: AgentEvent) => void): () => void {
    return this.events.subscribe(ownerId, callback);
  }

  startSession(request: AgentRunRequestInput, ownerId: number): Promise<AgentStartResult> {
    return this.starter.start(request, ownerId);
  }

  resumeSession(request: AgentResumeRequest, ownerId: number): Promise<AgentStartResult> {
    return this.resumer.resume(request, ownerId);
  }

  async stopSession(sessionId: string, ownerId: number): Promise<void> {
    await Promise.resolve();
    this.liveness.assertLive();
    const outcome = this.runs.requestStop(sessionId, ownerId);
    if (outcome === 'already-settled') return;
    if (outcome === 'not-running') {
      const persisted = this.repository.getSession(sessionId);
      if (persisted === null || isTerminalSessionStatus(persisted.status)) return;
      this.ownership.assertOwner(sessionId, ownerId);
    }
    this.events.recordCancelled(sessionId, ownerId);
  }

  async copyResult(sessionId: string, ownerId: number): Promise<AgentCopyResultResult> {
    this.liveness.assertLive();
    const parsed = agentSessionRequestSchema.parse({ sessionId });
    this.ownership.assertOwner(parsed.sessionId, ownerId);
    // Item D: prove the barrier and record the generation before the first
    // suspension point, so the report read below belongs to a run that had
    // already finished and been reaped when this copy began.
    const generation = this.requireCopyReady(parsed.sessionId);

    await Promise.resolve();
    this.liveness.assertLive();
    // Item C: the window may have been destroyed while this copy was
    // suspended. A caller that no longer owns the session must not reach the
    // clipboard, which is a privileged side effect outside the renderer.
    this.ownership.assertOwner(parsed.sessionId, ownerId);

    const redacted = redactText(this.readCopyableReport(parsed.sessionId));
    // Re-assert immediately before the clipboard write. A stop, a resume, or
    // another copy's continuation may have run in between; if the session
    // moved on, this report is no longer the stable terminal generation and
    // nothing is copied.
    this.ownership.assertOwner(parsed.sessionId, ownerId);
    if (this.requireCopyReady(parsed.sessionId) !== generation) {
      throw new InterleafError('validation', COPY_REAPING_BARRIER_MESSAGE);
    }
    await this.clipboard.writeText(redacted);
    return { copied: true, characterCount: redacted.length };
  }

  private readCopyableReport(sessionId: string): string {
    const session = this.repository.getSession(sessionId);
    if (session === null) throw new InterleafError('validation', 'The agent session no longer exists.');
    const finalReport = session.finalReport;
    if (finalReport === null || finalReport.trim().length === 0) {
      throw new InterleafError('validation', 'The agent session has no report to copy.');
    }
    if (finalReport.length > COPY_MAX_CHARACTERS || Buffer.byteLength(finalReport, 'utf8') > COPY_MAX_BYTES) {
      throw new InterleafError('validation', 'The agent result exceeds the bounded copy limit.');
    }
    return finalReport;
  }

  /**
   * Main's own window factory declares the one main window (item C).
   *
   * Never call this with an id that came from a renderer payload.
   */
  adoptMainWindow(ownerId: number): void {
    this.ownership.adoptMainWindow(ownerId);
  }

  async cancelOwner(ownerId: number): Promise<void> {
    // Synchronous, before any await: a suspended operation that resumes later
    // must see that its window is gone.
    const pending = this.ownership.beginOwnerDestruction(ownerId);
    this.runs.cancelClaimsOf(ownerId);
    for (const sessionId of this.runs.activeSessionsOf(ownerId)) await this.stopSession(sessionId, ownerId);
    await Promise.all(pending);
    this.events.unsubscribeOwner(ownerId);
    this.ownership.releaseOwner(ownerId);
  }

  /**
   * The explicit main-authorized handoff (docs/REMAINING_WORK.md item C).
   *
   * The caller's authority is a grant main minted for it; knowing the session
   * ID grants nothing. The claim runs as one of the claimant's own pending
   * owner operations, so destroying its window invalidates it, and
   * authorization plus claimant liveness are proved again after the drain —
   * immediately before the transfer — because both can change while this call
   * is suspended. A session that is still starting or running is never handed
   * over.
   */
  async claimSession(sessionId: string, ownerId: number): Promise<AgentSessionClaimResult> {
    this.liveness.assertLive();
    const parsed = agentSessionRequestSchema.parse({ sessionId });
    const authority = this.ownership.authorizeHandoff(parsed.sessionId, ownerId);
    if (authority === 'already-owned') return { claimed: true, ownerChanged: false };
    if (this.repository.getSession(parsed.sessionId) === null) {
      throw new InterleafError('validation', 'The agent session no longer exists.');
    }
    const operation = this.ownership.beginOperation(ownerId);
    try {
      await this.drainPreviousOwner(parsed.sessionId, ownerId, authority.previousOwnerId);
      this.liveness.assertLive();
      operation.assertLive();
      // Re-prove authority on the far side of the suspension: the claimant's
      // window may be gone, its grant revoked, or the session already taken.
      const confirmed = this.ownership.authorizeHandoff(parsed.sessionId, ownerId);
      if (confirmed === 'already-owned') return { claimed: true, ownerChanged: false };
      this.assertSessionSettled(parsed.sessionId);
      operation.assertLive();
      this.ownership.transfer(parsed.sessionId, ownerId);
      return { claimed: true, ownerChanged: true };
    } finally {
      this.ownership.finishOperation(operation);
    }
  }

  /**
   * Reclaim only after the previous owner's work has actually finished. The
   * claimant's own operations — the claim included — are never part of the
   * drain set, so the claim cannot wait on itself.
   */
  private async drainPreviousOwner(sessionId: string, ownerId: number, previousOwnerId: number | null): Promise<void> {
    const ownerOperations = previousOwnerId === null || previousOwnerId === ownerId
      ? []
      : this.ownership.pendingCompletionsOf(previousOwnerId);
    const drains = [...ownerOperations, ...this.runs.handoffDrains(sessionId)];
    await Promise.all(drains.map(async (drain) => {
      try {
        await drain;
      } catch { /* the old owner's failure is not this claim's failure */ }
    }));
  }

  private assertSessionSettled(sessionId: string): void {
    if (this.runs.isBusy(sessionId)) {
      throw new InterleafError('validation', 'The agent session is still finishing. Try again once it has stopped.');
    }
    const session = this.repository.getSession(sessionId);
    if (session === null) throw new InterleafError('validation', 'The agent session no longer exists.');
    if (session.status === 'running' || session.status === 'queued' || session.status === 'waiting') {
      throw new InterleafError('validation', 'The agent session is still finishing. Try again once it has stopped.');
    }
  }

  getSession(sessionId: string): AgentSessionDetail | null {
    return this.repository.getSessionDetail(sessionId);
  }

  getSessionForDocument(sessionId: string, documentId: string): AgentSessionDetail | null {
    return this.repository.getSessionDetailForDocument(sessionId, documentId);
  }

  listSessions(documentId: string): readonly AgentSession[] {
    return this.repository.listSessions(documentId);
  }

  /** Validate renderer-persisted capability projections at the main boundary.
   * Both the in-memory registry and the durable row must agree on the current
   * filesystem identity before settings can reference a handle. */
  async validateSavedWorkingDirectorySettings(settings: AppSettings): Promise<void> {
    this.liveness.assertLive();
    const stored = new Map(this.repository.listWorkingDirectories().map((entry) => [entry.handle, entry]));
    for (const entry of settings.agent.workingDirectories) {
      const persisted = stored.get(entry.handle);
      if (persisted?.displayName !== entry.displayName) {
        throw new InterleafError('security-violation', 'A saved working directory is invalid or no longer registered. Select it again.');
      }
      const resolved = await this.directories.resolve(entry.handle);
      this.liveness.assertLive();
      if (
        resolved.canonicalPath !== persisted.canonicalPath ||
        !sameFileIdentity(resolved, persisted)
      ) {
        throw new InterleafError('security-violation', 'A saved working directory changed and must be selected again.');
      }
    }
    this.liveness.assertLive();
  }

  /**
   * Settings validation is asynchronous, so the dispatcher must perform one
   * final synchronous liveness check immediately before writing the complete
   * settings document. This closes the gap where shutdown begins after the
   * last directory resolve but before SettingsRepository.update().
   */
  assertSettingsUpdateAllowed(): void {
    this.liveness.assertLive();
  }

  /** Main-owned typed list for settings surfaces. Invalid/stale capabilities
   * are omitted; no canonical paths or identities leave this process. */
  async listWorkingDirectories(): Promise<readonly AgentWorkingDirectory[]> {
    this.liveness.assertLive();
    const result: AgentWorkingDirectory[] = [];
    for (const entry of this.repository.listWorkingDirectories()) {
      try {
        const resolved = await this.directories.resolve(entry.handle);
        if (resolved.canonicalPath !== entry.canonicalPath || !sameFileIdentity(resolved, entry)) continue;
        // Validate the final public projection as a defense-in-depth boundary.
        // A malformed/tampered durable row is omitted instead of exposing a
        // path-like label or any main-owned identity data to the renderer.
        const publicEntry = agentWorkingDirectorySchema.safeParse({
          handle: entry.handle,
          displayName: entry.displayName,
        });
        if (!publicEntry.success) continue;
        result.push(publicEntry.data);
      } catch {
        // Stale capabilities fail closed and are never exposed to renderer.
      }
    }
    this.liveness.assertLive();
    return result;
  }

  async issueRiskGrant(request: AgentRiskGrantRequest, ownerId: number): Promise<AgentRiskGrant> {
    this.liveness.assertLive();
    const parsed = agentRiskGrantRequestSchema.parse(request);
    const profile = this.profiles.find(parsed.profileId);
    if (profile?.detection.availability !== 'installed') throw new InterleafError('validation', 'The selected agent profile is unavailable.');
    // The directory registry is main-owned and this method deliberately does
    // not accept a canonical path from the renderer.
    const selected = await this.directories.resolve(parsed.workingDirectoryHandle);
    this.liveness.assertLive();
    const mainProfile = this.agents.getAdapter(profile.id)?.profile;
    if (mainProfile === undefined) throw new InterleafError('internal', 'The selected agent adapter is unavailable.');
    if (parsed.executionMode === 'native-restricted' && !(await this.authorization.supportsNativeRestricted(mainProfile))) {
      throw new InterleafError('mode-resolution-failed', 'Native Restricted is unavailable for the selected main-owned adapter profile.');
    }
    const profileFingerprint = fingerprintExecutionAuthority(mainProfile);
    const approved = await this.confirmDirectWorkspace({
      mode: parsed.executionMode,
      riskLevel: resolveAgentRiskLevel({ mode: parsed.executionMode, dangerousProfile: mainProfile.unsafe || mainProfile.customConfig?.executionKind === 'expert-shell' }),
      canonicalTargetPath: selected.canonicalPath,
      profileName: profile.name,
    });
    this.liveness.assertLive();
    if (!approved) throw new InterleafError('security-violation', 'Direct workspace confirmation was cancelled.');
    const directory = await this.directories.resolve(parsed.workingDirectoryHandle);
    this.liveness.assertLive();
    const issued = this.riskGrants.issue({
      draftId: parsed.draftId,
      directoryHandle: parsed.workingDirectoryHandle,
      profileId: profile.id,
      profileFingerprint,
      effectivePermissionPolicy: mainProfile.permissionMode,
      canonicalTargetPath: directory.canonicalPath,
      ...pickFileIdentity(directory),
      mode: parsed.executionMode,
      draftFingerprint: fingerprintDraft(parsed),
      ownerId,
    });
    return { ...issued, mode: parsed.executionMode };
  }

  async getEnvironmentReview(sessionId: string, ownerId: number): Promise<AgentEnvironmentReviewResult | null> {
    this.liveness.assertLive();
    this.ownership.assertOwner(sessionId, ownerId);
    await assertPersistedTargetUnchanged(this.requireSessionRecords(sessionId).targetIdentity);
    this.liveness.assertLive();
    const review = await this.environments.getReview(sessionId);
    this.liveness.assertLive();
    return review === null ? null : { sessionId, review };
  }

  async applyChanges(sessionId: string, ownerId: number): Promise<AgentEnvironmentReviewResult> {
    this.liveness.assertLive();
    this.ownership.assertOwner(sessionId, ownerId);
    this.requireEnvironmentActionReady(sessionId);
    const applyIdentity = this.requireSessionRecords(sessionId).targetIdentity;
    return this.withEnvironmentAction(sessionId, 'apply', async () => {
      // Before the environment manager takes its lock or stages anything.
      await assertPersistedTargetUnchanged(applyIdentity);
      this.liveness.assertLive();
      const result = await this.environments.apply(sessionId);
      this.liveness.assertPersistenceWritable();
      this.repository.updateSession(sessionId, { environment: { ...result.review, sessionId }, environmentState: 'applied' });
      return result;
    });
  }

  async discardSandbox(sessionId: string, ownerId: number): Promise<void> {
    this.liveness.assertLive();
    this.ownership.assertOwner(sessionId, ownerId);
    this.requireEnvironmentActionReady(sessionId);
    return this.withEnvironmentAction(sessionId, 'discard', async () => {
      await this.environments.discard(sessionId);
      this.liveness.assertPersistenceWritable();
      this.repository.updateSession(sessionId, { environment: null, environmentWorkspacePath: null, environmentState: 'discarded' });
    });
  }

  async exportPatch(sessionId: string, ownerId: number): Promise<AgentPatchExportResult> {
    this.liveness.assertLive();
    this.ownership.assertOwner(sessionId, ownerId);
    this.requireEnvironmentActionReady(sessionId);
    return this.withEnvironmentAction(sessionId, 'export-patch', async () => {
      const exported = await this.environments.exportPatch(sessionId);
      // A cancelled save wrote nothing, so there is no artifact to record.
      if (exported.outcome === 'cancelled') return exported;
      this.liveness.assertPersistenceWritable();
      this.repository.addArtifact({ sessionId, kind: 'patch', metadata: { artifactId: exported.artifactId, fileName: exported.fileName, bytes: exported.bytes } });
      return exported;
    });
  }

  async openFolder(sessionId: string, ownerId: number): Promise<{ readonly opened: boolean }> {
    this.liveness.assertLive();
    this.ownership.assertOwner(sessionId, ownerId);
    const folderIdentity = this.requireSessionRecords(sessionId).targetIdentity;
    return this.withEnvironmentAction(sessionId, 'open-folder', async () => {
      await assertPersistedTargetUnchanged(folderIdentity);
      this.liveness.assertLive();
      const opened = await this.environments.openFolder(sessionId);
      this.liveness.assertPersistenceWritable();
      return opened;
    });
  }

  /**
   * Main-only durable session records. Missing, stale, or unparseable records
   * fail closed: a session that cannot prove what it was started under is
   * never continued under current defaults.
   */
  private requireSessionRecords(sessionId: string): PersistedSessionRecords {
    return requireSessionRecords(this.repository.getSessionAuthority(sessionId));
  }

  private async withEnvironmentAction<T>(sessionId: string, action: EnvironmentAction, operation: () => Promise<T>): Promise<T> {
    this.liveness.assertLive();
    this.liveness.assertAcceptingRuns();
    // This method is entered synchronously by each IPC handler, so the
    // reservation is installed before the operation's first await.
    const lifecycleReservation = this.runs.reserveLifecycle(sessionId, action);
    try {
      // Item H: the reservation and the scanning admission are taken together.
      // Shutdown waits for both, so an action that was already running when
      // quitting began can finish the snapshot it needs, while one that starts
      // afterwards is refused a worker rather than racing the drain.
      return await this.environments.admitScanning(operation);
    } finally {
      this.runs.releaseLifecycle(sessionId, lifecycleReservation);
    }
  }

  /**
   * The copy barrier (docs/REMAINING_WORK.md item D). Persisted terminal
   * status is not sufficient on its own: `stopSession` records `cancelled`
   * before the child is reaped, and a claimed resume leaves the previous
   * generation's completed record in place until the new run persists
   * anything. In both windows the report on record belongs to a generation the
   * session has already left, so copy is refused rather than served stale.
   *
   * Returns the current generation so the caller can prove the session did not
   * move while the report was being read.
   */
  private requireCopyReady(sessionId: string): number {
    const session = this.repository.getSession(sessionId);
    if (session === null) throw new InterleafError('validation', 'The agent session no longer exists.');
    if (!isTerminalSessionStatus(session.status)) throw new InterleafError('validation', 'Only completed or terminal agent results can be copied.');
    if (this.runs.isBusy(sessionId)) {
      throw new InterleafError('validation', COPY_REAPING_BARRIER_MESSAGE);
    }
    return this.runs.generation(sessionId);
  }

  /** Filesystem environment mutations wait for both persisted terminal state
   * and completion of the main-owned adapter consumer. stopSession records
   * cancellation before child/process-group reaping, so status alone is not a
   * sufficient transaction barrier. */
  private requireEnvironmentActionReady(sessionId: string): void {
    const session = this.repository.getSession(sessionId);
    if (session === null) throw new InterleafError('validation', 'The agent session no longer exists.');
    // Terminal status is written only after the consumer has persisted its
    // final event and environment review. The consumer map may remain for a
    // single promise-finally microtask, which is no longer a persistence
    // barrier once the active run has been removed.
    if (!isTerminalSessionStatus(session.status) || this.runs.isActive(sessionId)) {
      throw new InterleafError('validation', 'Environment actions are unavailable until the agent process has finished and been reaped.');
    }
  }

  /** Accepted or pending operations, claimed or unreaped runs, and lifecycle actions. */
  liveWork(): number {
    return this.ownership.pendingOperationCount() + this.runs.liveSessionCount();
  }

  /** Refuses new runs and lifecycle actions; admitted work continues until drain. */
  closeAdmission(): void {
    this.liveness.closeAdmission();
  }

  async shutdown(): Promise<void> {
    if (!this.liveness.beginShutdown()) return;
    // Model listing owns child processes of its own. Cancel it first so its
    // probes are already terminating while the sessions drain.
    const modelDiscoveryDrain = this.profiles.closeDiscovery();
    // The capability prober owns bounded child processes too. Closing it both
    // withdraws Native Restricted for anything still starting and cancels the
    // probe children, so no probe outlives this drain (item R).
    const proberDrain = reportRejection(this.nativeSandbox.close(), (caught) => {
      this.log.error('native sandbox capability prober shutdown failed', { errorType: describeError(caught).name });
    });
    // Item H: workspace scanning owns worker threads. Draining the environment
    // manager's pool here stops a long hash from holding the process open or
    // posting a result into a main that has already torn down its database and
    // registries. The closure is permanent for this service, so the pending
    // owner and lifecycle work drained below cannot start a scan on the way
    // out: it is refused admission rather than racing the drain's end.
    const snapshotDrain = reportRejection(this.environments.drainSnapshots(), (caught) => {
      this.log.error('agent workspace scanning shutdown failed', { errorType: describeError(caught).name });
    });
    const pendingOperations = this.ownership.cancelAllOperations();
    // An ended event has already determined a run's terminal result; that
    // consumer finishes its final persistence instead of being downgraded to
    // cancellation. Shutdown persists cancellation without delivering it.
    const runWaits = this.runs.shutdownRuns((sessionId) => { this.events.persistCancelled(sessionId); });
    const waits = [...runWaits, ...pendingOperations, modelDiscoveryDrain, proberDrain, snapshotDrain];
    if (await drainTimedOut(waits)) this.liveness.closePersistence();
    this.runs.clearActive();
    this.events.clearSubscribers();
    this.riskGrants.clear();
    this.profiles.clearExecutables();
  }
}
