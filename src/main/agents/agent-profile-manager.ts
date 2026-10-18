import { randomUUID } from 'node:crypto';
import { describeError, reportRejection } from '@shared/models/caught-error';
import type { AgentProfile, AgentProfileStatusSnapshot } from '@shared/types/agent';
import type { AppSettings } from '@shared/schemas/settings';
import { createCustomAgentProfileRequestSchema, updateCustomAgentProfileRequestSchema } from '@shared/schemas/custom-agent-profile';
import type {
  AgentExecutableSelection,
  CustomAgentProfile,
  CustomAgentProfileCreateInput,
  CustomAgentProfileUpdateInput,
} from '@shared/types/custom-agent-profile';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { CustomAgentProfileRepository, StoredCustomAgentProfile } from '../db/repositories/custom-agent-profile-repository';
import type { AgentRegistry } from './agent-adapter';
import { toAgentProfileStatus } from './agent-profile-status';
import { toRendererAgentProfile, type MainAgentProfile } from './profile-types';
import {
  isKnownShellBinary,
  validateShellExecutable,
  type ExecutableRegistry,
  type PublicExecutableSelection,
  type RegisteredExecutable,
} from './executable-registry';
import type { AgentServiceLiveness } from './agent-service-liveness';
import {
  buildCreatedConfig,
  executionAuthorityChanged,
  mergeUpdatedConfig,
  sameExecutableIdentity,
  updatedShellFamily,
} from './custom-profile-config';
import type { CustomAgentProfileConfig } from '@shared/schemas/custom-agent-profile';

export type AgentProfileManagerOptions = {
  readonly agents: AgentRegistry;
  readonly repository: AgentRepository;
  readonly customProfiles: CustomAgentProfileRepository;
  readonly executables: ExecutableRegistry;
  readonly chooseExecutable: () => Promise<string | null>;
  readonly confirmUnsafeCustomProfile: (profileName: string) => Promise<boolean>;
  readonly confirmExpertShellProfile: (profileName: string) => Promise<boolean>;
  readonly liveness: AgentServiceLiveness;
  readonly log: Logger;
  /** Already resolved against packaging: a packaged build always passes false. */
  readonly allowFakeAgent: boolean;
};

/**
 * Owns the agent profiles main offers: detection, custom profiles and their
 * executable capabilities, settings-derived defaults, and model discovery.
 */
export class AgentProfileManager {
  private readonly options: AgentProfileManagerOptions;
  private readonly customHandles = new Map<string, PublicExecutableSelection>();
  private profiles: readonly AgentProfile[] = [];
  /** In-flight background model listing; already settled when none is running. */
  private modelDiscovery: Promise<void> = Promise.resolve();
  /** The refresh concurrent callers join, or `null` when none is running. */
  private pendingModelRefresh: Promise<void> | null = null;
  /** Whether a listing pass is running right now, for progressive readouts. */
  private modelDiscoveryActive = false;

  constructor(options: AgentProfileManagerOptions) {
    this.options = options;
  }

  /** Detects built-ins, rehydrates custom profiles, and starts model listing. */
  async load(): Promise<void> {
    const { agents, liveness } = this.options;
    const detected = await agents.detect();
    liveness.assertLive();
    const mainProfiles: MainAgentProfile[] = this.isFakeAllowed() ? [...detected, agents.addFakeAdapter()] : [...detected];
    mainProfiles.push(...(await this.rehydrateCustomProfiles()));
    this.profiles = mainProfiles.map(toRendererAgentProfile);
    liveness.assertLive();
    for (const profile of mainProfiles) this.options.repository.upsertProfile(profile);
    // Model listing runs behind startup rather than inside it: the window,
    // renderer bundle and first paint proceed while the CLIs are asked what
    // they accept. `listDiscovered` is what makes the result deterministic for
    // the renderer.
    this.modelDiscovery = this.discoverModels();
  }

  private async rehydrateCustomProfiles(): Promise<MainAgentProfile[]> {
    const rehydrated: MainAgentProfile[] = [];
    try {
      for (const stored of this.options.customProfiles.list()) {
        rehydrated.push(await this.rehydrateCustomProfile(stored));
      }
    } catch (error) {
      if (this.options.liveness.isStopped()) throw error;
      // A malformed persisted custom row is never silently discarded or
      // converted into an executable. Keep built-ins usable and expose a
      // redacted diagnostic while the typed repository error fails closed.
      this.options.log.error('custom agent profile storage contains malformed data', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
    return rehydrated;
  }

  private async rehydrateCustomProfile(stored: StoredCustomAgentProfile): Promise<MainAgentProfile> {
    try {
      return await this.installRehydratedProfile(stored);
    } catch (error) {
      if (this.options.liveness.isStopped()) throw error;
      this.options.log.warn('custom agent executable failed revalidation', {
        profileId: stored.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return this.options.agents.addUnavailableCustomProfile({
        id: stored.id,
        name: stored.name,
        binaryPath: stored.canonicalPath,
        executableIdentity: stored.identity,
        config: stored.config,
        errorMessage: 'Configured executable is unavailable or changed; select it again.',
      });
    }
  }

  private async installRehydratedProfile(stored: StoredCustomAgentProfile): Promise<MainAgentProfile> {
    const { agents, executables, liveness } = this.options;
    const executable = await executables.rehydrate(stored.canonicalPath, stored.identity);
    try {
      liveness.assertLive();
    } catch (error) {
      executables.revoke(executable.handle);
      throw error;
    }
    const runtime = agents.addCustomProfile({
      id: stored.id,
      name: stored.name,
      binaryPath: executable.canonicalPath,
      executableHandle: executable.handle,
      executableIdentity: executable.identity,
      config: stored.config,
    });
    this.customHandles.set(stored.id, executables.toPublic(executable));
    try {
      liveness.assertLive();
    } catch (error) {
      this.customHandles.delete(stored.id);
      executables.revoke(executable.handle);
      agents.removeProfile(stored.id);
      throw error;
    }
    return runtime;
  }

  list(): readonly AgentProfile[] {
    return this.profiles;
  }

  find(profileId: string): AgentProfile | undefined {
    return this.profiles.find((candidate) => candidate.id === profileId);
  }

  /**
   * Detection facts that are already settled, without waiting for catalogs.
   *
   * `listDiscovered` deliberately blocks on the background model listing so
   * the composer and Settings share one allowlist. A progressive row set
   * cannot afford that wait for facts it already has, so this answers from the
   * same in-memory profiles and reports whether the *existing* coalesced
   * listing is still running. It starts no detection and no probe of its own:
   * a caller that wants fresh catalogs joins `refreshDiscoveredModels`.
   */
  listStatuses(): AgentProfileStatusSnapshot {
    return {
      profiles: this.profiles.map((profile) => toAgentProfileStatus(profile)),
      modelDiscoveryPending: this.modelDiscoveryActive,
    };
  }

  /**
   * The renderer-facing profile list, including any models the installed CLIs
   * reported.
   *
   * Awaiting the background listing here keeps one allowlist: whatever the
   * composer and Settings are offered is exactly what a start will accept.
   * When no discovery is configured the wait is already resolved.
   */
  async listDiscovered(): Promise<readonly AgentProfile[]> {
    await this.modelDiscovery;
    return this.profiles;
  }

  /**
   * Re-probe the installed CLIs, ignoring the cached catalogs.
   *
   * Repeated requests join the listing that is already running instead of
   * starting another set of CLI probes. Coalescing is what keeps the newest
   * answer authoritative: two overlapping refreshes would otherwise race to
   * write profiles back, and the one that started first could land last.
   */
  async refreshDiscoveredModels(): Promise<readonly AgentProfile[]> {
    this.options.liveness.assertLive();
    this.pendingModelRefresh ??= this.runModelRefresh();
    await this.pendingModelRefresh;
    return this.profiles;
  }

  private async runModelRefresh(): Promise<void> {
    const refresh = this.discoverModels(true);
    this.modelDiscovery = refresh;
    try {
      await refresh;
    } finally {
      this.pendingModelRefresh = null;
    }
  }

  private async discoverModels(force = false): Promise<void> {
    this.modelDiscoveryActive = true;
    try {
      if (!(await this.options.agents.refreshDiscoveredModels(force))) return;
      // Shutdown may have started while the probes ran; never write profiles
      // back through a closed repository.
      this.options.liveness.assertLive();
      this.refreshFromRegistry();
    } catch (error) {
      this.options.log.warn('agent model discovery did not complete', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.modelDiscoveryActive = false;
    }
  }

  /**
   * Model listing owns child processes of its own. Shutdown cancels it first
   * and keeps this drain in its wait set, so no listing CLI survives.
   */
  closeDiscovery(): Promise<void> {
    return reportRejection(this.options.agents.closeModelDiscovery(), (caught) => {
      this.options.log.error('agent model discovery shutdown failed', { errorType: describeError(caught).name });
    }).then(() => this.modelDiscovery);
  }

  async selectExecutable(): Promise<AgentExecutableSelection | null> {
    const { executables, liveness } = this.options;
    liveness.assertLive();
    const chosen = await this.options.chooseExecutable();
    liveness.assertLive();
    if (chosen === null) return null;
    const registered = await executables.register(chosen);
    try {
      liveness.assertLive();
    } catch (error) {
      // A worker-owned hash may finish after shutdown's drain timeout. Never
      // leave a newly-created capability alive after teardown starts.
      executables.revoke(registered.handle);
      throw error;
    }
    return executables.toPublic(registered);
  }

  listCustom(): readonly CustomAgentProfile[] {
    const repository = this.options.customProfiles;
    return repository.list().map((stored) => repository.toPublic(stored, this.customHandles.get(stored.id) ?? null));
  }

  async createCustom(request: CustomAgentProfileCreateInput): Promise<CustomAgentProfile> {
    const { executables, liveness } = this.options;
    liveness.assertLive();
    const parsed = createCustomAgentProfileRequestSchema.parse(request);
    const executable = await executables.resolve(parsed.executableHandle);
    assertExecutableFitsKind(executable, parsed.executionKind, parsed.shellFamily);
    await this.confirmCreation(parsed.executionKind, parsed.unsafe, parsed.name);
    liveness.assertLive();
    const id = `custom:${randomUUID()}`;
    const config = buildCreatedConfig(parsed);
    const stored = this.options.customProfiles.create({ id, name: parsed.name, canonicalPath: executable.canonicalPath, identity: executable.identity, config });
    this.customHandles.set(id, executables.toPublic(executable));
    this.registerCustomRuntime(stored, executable);
    this.refreshFromRegistry();
    return this.options.customProfiles.toPublic(stored, this.customHandles.get(id) ?? null);
  }

  private async confirmCreation(kind: CustomAgentProfileConfig['executionKind'], unsafe: boolean, name: string): Promise<void> {
    if (kind === 'expert-shell') {
      if (!(await this.options.confirmExpertShellProfile(name))) {
        throw new InterleafError('security-violation', 'Expert custom shell profile creation was cancelled.');
      }
      return;
    }
    if (unsafe && !(await this.options.confirmUnsafeCustomProfile(name))) {
      throw new InterleafError('security-violation', 'Unsafe custom profile creation was cancelled.');
    }
  }

  async updateCustom(request: CustomAgentProfileUpdateInput): Promise<CustomAgentProfile> {
    const { customProfiles, executables, liveness } = this.options;
    liveness.assertLive();
    const parsed = updateCustomAgentProfileRequestSchema.parse(request);
    const existing = customProfiles.get(parsed.id);
    if (existing === null) throw new InterleafError('validation', 'Built-in or unknown agent profiles cannot be edited.');
    const existingSelection = this.customHandles.get(parsed.id);
    const executable = await this.resolveUpdatedExecutable(parsed.executableHandle, existingSelection);
    const targetKind = parsed.executionKind ?? existing.config.executionKind;
    assertExecutableFitsKind(executable, targetKind, updatedShellFamily(existing.config, parsed));
    const config = mergeUpdatedConfig(existing.config, parsed, targetKind);
    await this.confirmUpdate(existing, executable, config, parsed.name ?? existing.name);
    liveness.assertLive();
    const stored = customProfiles.update(parsed.id, {
      name: parsed.name ?? existing.name,
      canonicalPath: executable.canonicalPath,
      identity: executable.identity,
      config,
    });
    this.customHandles.set(parsed.id, executables.toPublic(executable));
    const previousHandle = existingSelection?.handle;
    if (previousHandle !== undefined && previousHandle !== executable.handle) this.releaseCustomHandle(previousHandle);
    this.options.agents.removeProfile(parsed.id);
    this.registerCustomRuntime(stored, executable);
    this.refreshFromRegistry();
    return customProfiles.toPublic(stored, this.customHandles.get(parsed.id) ?? null);
  }

  private async resolveUpdatedExecutable(
    requestedHandle: string | undefined,
    existingSelection: PublicExecutableSelection | undefined,
  ): Promise<RegisteredExecutable> {
    const handle = requestedHandle ?? existingSelection?.handle;
    if (handle === undefined) throw new InterleafError('security-violation', 'The configured executable is unavailable; select it again.');
    return this.options.executables.resolve(handle);
  }

  /**
   * Compares the fully merged config before any persistence. Metadata-only
   * edits deliberately do not trigger the dedicated Expert Shell dialog.
   */
  private async confirmUpdate(
    existing: StoredCustomAgentProfile,
    executable: RegisteredExecutable,
    config: CustomAgentProfileConfig,
    name: string,
  ): Promise<void> {
    const touchesExpertShell = existing.config.executionKind === 'expert-shell' || config.executionKind === 'expert-shell';
    if (touchesExpertShell && executionAuthorityChanged(existing, executable, config)) {
      if (!(await this.options.confirmExpertShellProfile(name))) {
        throw new InterleafError('security-violation', 'Expert custom shell profile update was cancelled.');
      }
      this.options.liveness.assertLive();
    }
    if (config.unsafe && !existing.config.unsafe && !(await this.options.confirmUnsafeCustomProfile(name))) {
      throw new InterleafError('security-violation', 'Unsafe custom profile changes were cancelled.');
    }
  }

  deleteCustom(id: string): void {
    this.options.liveness.assertLive();
    this.options.customProfiles.delete(id);
    const handle = this.customHandles.get(id);
    this.customHandles.delete(id);
    if (handle !== undefined) this.releaseCustomHandle(handle.handle);
    this.options.agents.removeProfile(id);
    this.refreshFromRegistry();
  }

  applySettings(settings: AppSettings['agent']['profiles']): void {
    this.options.liveness.assertLive();
    this.options.agents.applyProfileSettings(settings);
    this.refreshFromRegistry();
  }

  /**
   * Hash custom executables off-thread immediately before adapter startup.
   * CliAgentAdapter keeps its synchronous boundary, where it repeats only the
   * bounded metadata guard; this async check closes the large-file main-thread
   * DoS and preserves content-integrity failure before a child is spawned.
   */
  async assertCustomExecutableReady(profile: MainAgentProfile): Promise<void> {
    if (profile.executableHandle === undefined || profile.executableIdentity === undefined) return;
    const executable = await this.options.executables.resolveForSpawn(profile.executableHandle);
    if (executable.canonicalPath !== profile.binaryPath || !sameExecutableIdentity(executable.identity, profile.executableIdentity)) {
      throw new InterleafError('security-violation', 'The configured executable changed and execution was stopped.');
    }
  }

  isFakeAllowed(): boolean {
    return this.options.allowFakeAgent;
  }

  /**
   * Executable handles are process-local capabilities. Shutdown clears them
   * only after every active adapter has completed or been cancelled and its
   * child reaped, so this never invalidates a live spawn boundary.
   */
  clearExecutables(): void {
    this.options.executables.clear();
  }

  private registerCustomRuntime(stored: StoredCustomAgentProfile, executable: RegisteredExecutable): void {
    this.options.agents.addCustomProfile({
      id: stored.id,
      name: stored.name,
      binaryPath: stored.canonicalPath,
      executableHandle: executable.handle,
      executableIdentity: stored.identity,
      config: stored.config,
    });
  }

  private refreshFromRegistry(): void {
    const mainProfiles = this.options.agents.listMainProfiles();
    this.profiles = mainProfiles.map(toRendererAgentProfile);
    for (const profile of mainProfiles) this.options.repository.upsertProfile(profile);
  }

  private releaseCustomHandle(handle: string): void {
    if ([...this.customHandles.values()].some((selection) => selection.handle === handle)) return;
    this.options.executables.revoke(handle);
  }
}

/** Direct shells must use Expert Shell mode, and Expert Shell must name its shell. */
function assertExecutableFitsKind(
  executable: RegisteredExecutable,
  kind: CustomAgentProfileConfig['executionKind'],
  shellFamily: ReturnType<typeof updatedShellFamily>,
): void {
  if (kind === 'expert-shell') {
    if (shellFamily === undefined) throw new InterleafError('validation', 'Expert shell profiles require a shell family.');
    validateShellExecutable(executable.canonicalPath, shellFamily);
    return;
  }
  if (isKnownShellBinary(executable.canonicalPath)) {
    throw new InterleafError('validation', `The executable "${executable.displayName}" is a direct shell binary. Direct shell executables must be configured using Expert Shell mode.`);
  }
}
