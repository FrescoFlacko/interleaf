import { REASONING_EFFORT_LABELS } from '@shared/constants/reasoning';
import type { AIModelReasoning, AIProviderId, AIProviderStatus, ReasoningEffort } from '@shared/types/ai';

/**
 * The reasoning levels main published for the model a binding names.
 *
 * `undefined` means this store cannot see the model at all — an OpenRouter
 * catalog id is not part of the provider's status — and only main can then say
 * whether a saved level still applies. `null` means the model is listed and
 * offers no reasoning control.
 */
export function publishedReasoning(
  providers: readonly AIProviderStatus[],
  providerId: AIProviderId,
  modelId: string | null
): AIModelReasoning | null | undefined {
  const models = providers.find((provider) => provider.id === providerId)?.models;
  if (models === undefined) return undefined;
  const model = modelId === null ? models[0] : models.find((candidate) => candidate.id === modelId);
  if (model === undefined) return undefined;
  return model.reasoning ?? null;
}

/**
 * Whether a saved level is one the bound model no longer offers. It stays
 * saved and shown, never silently swapped: the reader chooses again.
 */
export function isEffortStale(
  providers: readonly AIProviderStatus[],
  binding: { readonly providerId: AIProviderId; readonly modelId: string | null; readonly reasoningEffort: ReasoningEffort | null }
): boolean {
  if (binding.reasoningEffort === null) return false;
  const reasoning = publishedReasoning(providers, binding.providerId, binding.modelId);
  if (reasoning === undefined) return false;
  return reasoning?.levels.includes(binding.reasoningEffort) !== true;
}

/** Mirrors main's own refusal, which is the authority on this. */
export function staleEffortMessage(effort: ReasoningEffort): string {
  return `This model no longer offers the ${REASONING_EFFORT_LABELS[effort]} reasoning effort. Choose another level or Default, then send again.`;
}
