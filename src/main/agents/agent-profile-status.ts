import type {
  AgentAvailability,
  AgentProfile,
  AgentProfileStatus,
  AgentUnavailabilityReason,
} from '@shared/types/agent';
import { FIXED_UNAVAILABLE_AGENT_PROVIDERS } from './agent-adapter';

/**
 * Projecting a detected agent profile into the bounded status row onboarding
 * renders.
 *
 * This lives beside the registry rather than inside `AgentService` because it is
 * a pure read of facts detection already established — it starts no probe, holds
 * no state and touches no session — and because the one judgement it does make
 * belongs with the detection decision it mirrors.
 */

/**
 * Why a runtime is unavailable, when it is.
 *
 * `AgentAvailability` alone conflates two very different facts: detection looked
 * for an executable and did not find one, versus Interleaf does not offer this
 * runtime for unattended Agent Mode at all. Only the first justifies pointing a
 * user at installation instructions, so the distinction is drawn here from the
 * same main-owned table `detectDefinition` acts on, never guessed in the
 * renderer from an error string.
 */
function unavailabilityReason(
  availability: AgentAvailability,
  providerId: string
): AgentUnavailabilityReason {
  if (availability === 'installed') return 'none';
  if (availability === 'error') return 'error';
  return FIXED_UNAVAILABLE_AGENT_PROVIDERS.has(providerId) ? 'unsupported' : 'not-found';
}

/**
 * One profile as a status row.
 *
 * Strictly a projection of the record `agent:list-profiles` already returns: no
 * executable path, no raw probe output and no capability the renderer did not
 * already have.
 */
export function toAgentProfileStatus(profile: AgentProfile): AgentProfileStatus {
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    name: profile.name,
    availability: profile.detection.availability,
    unavailability: unavailabilityReason(profile.detection.availability, profile.providerId),
    version: profile.detection.version,
    errorMessage: profile.detection.errorMessage,
    checkedAt: profile.detection.checkedAt,
    defaultModel: profile.defaultModel,
    availableModels: profile.availableModels,
    supportsModelSelection: profile.capabilities.modelSelection,
    isCustom: profile.isCustom,
  };
}
