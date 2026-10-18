import { AGENT_EXECUTION_MODE_INFO, type AgentExecutionMode } from '@shared/constants/agent-modes';
import { AGENT_SELECTABLE_EXECUTION_MODES } from '@shared/constants/agent-mode-selection';
import type { AgentModeAvailability } from '@shared/types/agent-environment';
import type { AgentProfile } from '@shared/types/agent';
import type { SelectOption } from '../../components/ui/select-model';

export function isInstalled(profile: AgentProfile): boolean {
  return profile.detection.availability === 'installed';
}

/**
 * The selected profile when it can no longer run: still the stored choice, so
 * it is shown and flagged rather than silently replaced by another agent.
 */
export function staleProfile(profiles: readonly AgentProfile[], selectedId: string | null): AgentProfile | null {
  const selected = profiles.find((profile) => profile.id === selectedId);
  return selected === undefined || isInstalled(selected) ? null : selected;
}

/**
 * Execution pickers only offer agents that can run. A stale stored choice is
 * not a choice: the trigger names it and the field flags it, but the list
 * never offers it again.
 */
export function agentProfileOptions(profiles: readonly AgentProfile[]): SelectOption[] {
  return profiles.filter(isInstalled).map((profile) => ({ value: profile.id, label: profile.name }));
}

export function agentModelOptions(profile: AgentProfile | undefined): SelectOption[] {
  return [
    { value: '', label: 'Provider default' },
    ...(profile?.availableModels ?? []).map((model) => ({ value: model, label: model })),
  ];
}

function unavailableReason(availability: AgentModeAvailability | undefined): string | undefined {
  if (availability?.available !== false) return undefined;
  return availability.reason ?? 'Unavailable on this system';
}

export function executionModeOptions(modeAvailability: readonly AgentModeAvailability[]): SelectOption<AgentExecutionMode>[] {
  return AGENT_SELECTABLE_EXECUTION_MODES.map((mode) => {
    const reason = unavailableReason(modeAvailability.find((item) => item.mode === mode));
    return {
      value: mode,
      label: AGENT_EXECUTION_MODE_INFO[mode].label,
      ...(reason === undefined ? {} : { description: `Unavailable: ${reason}`, disabled: true }),
    };
  });
}
