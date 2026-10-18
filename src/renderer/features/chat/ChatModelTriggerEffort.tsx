import { REASONING_EFFORT_LABELS } from '@shared/constants/reasoning';
import type { AIProviderId, AIProviderStatus, ReasoningEffort } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { isEffortStale } from '../../stores/chat-reasoning';
import type { OpenRouterCatalogState } from './use-openrouter-catalog';
import type { PickerRow } from './model-picker-options';

type Binding = {
  readonly providerId: AIProviderId;
  readonly modelId: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
};

/** The bound level as the trigger names it; `label` is null for Default. */
export type TriggerEffort = {
  readonly label: string | null;
  readonly stale: boolean;
};

/**
 * OpenRouter's catalog models are only known once main has listed them, so a
 * saved level is judged against the listed row rather than provider status.
 */
function staleInCatalog(binding: Binding, catalogState: OpenRouterCatalogState, boundRow: PickerRow | undefined): boolean {
  if (binding.providerId !== 'openrouter' || catalogState !== 'ready') return false;
  if (boundRow === undefined || binding.reasoningEffort === null) return false;
  return boundRow.reasoning?.levels.includes(binding.reasoningEffort) !== true;
}

export function triggerEffort(
  providers: readonly AIProviderStatus[],
  binding: Binding,
  catalogState: OpenRouterCatalogState,
  boundRow: PickerRow | undefined
): TriggerEffort {
  const effort = binding.reasoningEffort;
  return {
    label: effort === null ? null : REASONING_EFFORT_LABELS[effort],
    stale: isEffortStale(providers, binding) || staleInCatalog(binding, catalogState, boundRow),
  };
}

function effortPhrase(effort: TriggerEffort): string | null {
  if (effort.label === null) return null;
  const staleNote = effort.stale ? ', no longer offered by this model' : '';
  return `reasoning effort ${effort.label}${staleNote}`;
}

/** The trigger's accessible name: model, provider, level and readiness. */
export function triggerAriaLabel(
  label: { readonly model: string; readonly provider: string | null },
  effort: TriggerEffort,
  unavailable: boolean
): string {
  return ['AI model: ' + label.model, label.provider, effortPhrase(effort), unavailable ? 'unavailable' : null]
    .filter((part) => part !== null)
    .join(', ');
}

/** Whether a choice repeats the binding exactly, which only closes the list. */
export function repeatsBinding(row: PickerRow, effort: ReasoningEffort | null, binding: Binding): boolean {
  return row.providerId === binding.providerId && row.modelId === binding.modelId && effort === binding.reasoningEffort;
}

/** The trigger's level badge; Default shows none. */
export function ChatModelTriggerEffort({ effort }: { readonly effort: TriggerEffort }) {
  if (effort.label === null) return null;
  return (
    <span data-testid="chat-model-trigger-effort" data-stale={effort.stale ? 'true' : undefined} className="chat-model-trigger-effort">
      <AppIcon name={effort.stale ? 'warning' : 'reasoning-effort'} size={11} className="chat-model-trigger-effort-icon" />
      {effort.label}
    </span>
  );
}
