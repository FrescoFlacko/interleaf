import type { AgentProfile, AgentDetection } from '@shared/types/agent';
import type { CustomAgentProfileConfig, ExecutableIdentity } from '@shared/schemas/custom-agent-profile';
import type { CustomAgentEnvironmentOverride, CustomAgentWorkingDirectoryPolicy } from '@shared/types/custom-agent-profile';
import { isAgentModelIdentifier, resolveAgentModelOptions } from '@shared/constants/agent-models';

/** Main-process-only profile record. Paths, argv templates, and permission
 * internals never cross the preload boundary. */
export type MainAgentDetection = AgentDetection & { readonly binaryPath: string | null };

export type MainAgentProfile = Omit<AgentProfile, 'detection' | 'availableModels'> & {
  readonly binaryPath: string;
  readonly defaultArgs: readonly string[];
  readonly permissionMode: string;
  /** User-owned model identifiers from validated settings. `availableModels`
   * is derived from this at the renderer boundary, never stored twice. */
  readonly configuredModels?: readonly string[] | undefined;
  /** Identifiers the installed CLI reported through a bounded main-owned
   * listing probe. Runtime-only and never persisted. */
  readonly discoveredModels?: readonly string[] | undefined;
  readonly environmentOverrides?: readonly CustomAgentEnvironmentOverride[];
  readonly workingDirectoryPolicy?: CustomAgentWorkingDirectoryPolicy;
  readonly detection: MainAgentDetection;
  /** Main-only custom executable capability and persisted identity. */
  readonly executableHandle?: string;
  readonly executableIdentity?: ExecutableIdentity;
  readonly customConfig?: CustomAgentProfileConfig;
  readonly promptRoot?: string;
};

/**
 * The models this main-owned profile may run. `AgentService` validates an
 * incoming per-run model against exactly this set, so the renderer can never be
 * offered a combination the launch path would reject.
 */
export function resolveMainProfileModels(profile: MainAgentProfile): readonly string[] {
  return resolveAgentModelOptions({
    providerId: profile.providerId,
    modelSelection: profile.capabilities.modelSelection,
    defaultModel: profile.defaultModel,
    configuredModels: profile.configuredModels,
    discoveredModels: profile.discoveredModels,
  });
}

export function toRendererAgentProfile(profile: MainAgentProfile): AgentProfile {
  const availableModels = resolveMainProfileModels(profile);
  const defaultModel = profile.defaultModel !== null && (
    !profile.capabilities.modelSelection || profile.isCustom || profile.providerId === 'custom'
      ? isAgentModelIdentifier(profile.defaultModel)
      : availableModels.includes(profile.defaultModel)
  ) ? profile.defaultModel : null;
  return {
    id: profile.id,
    providerId: profile.providerId,
    name: profile.name,
    defaultModel,
    availableModels: [...availableModels],
    reasoningEffort: profile.reasoningEffort,
    defaultSandboxMode: profile.defaultSandboxMode,
    capabilities: profile.capabilities,
    detection: {
      availability: profile.detection.availability,
      version: profile.detection.version,
      checkedAt: profile.detection.checkedAt,
      errorMessage: profile.detection.errorMessage,
    },
    isCustom: profile.isCustom,
    unsafe: profile.unsafe,
  };
}
