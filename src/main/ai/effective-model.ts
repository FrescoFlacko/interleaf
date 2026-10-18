import type { AIModelInfo, AIProviderId } from '@shared/types/ai';

/** Just enough of the provider gateway to answer the binding question. */
export type EffectiveModelDeps = {
  readonly resolveModel: (providerId: AIProviderId, modelId: string | null) => Promise<AIModelInfo>;
  /** Resolves the persisted, non-secret OpenRouter model identifier from settings. */
  readonly resolveOpenRouterModelId: () => Promise<string | null>;
};

/**
 * The model a request for this session would actually run against.
 *
 * A pinned session model wins; otherwise OpenRouter uses the model identifier
 * the user configured in settings, validated by the provider rather than
 * silently substituted. The send path and every read that has to agree with it
 * — the context-budget endpoint included — resolve the binding through this one
 * function, so no surface can name a different model from the one that answers.
 */
export async function resolveEffectiveModel(
  deps: EffectiveModelDeps,
  providerId: AIProviderId,
  sessionModelId: string | null
): Promise<AIModelInfo> {
  let requestedModelId = sessionModelId;
  if (providerId === 'openrouter') {
    const configured = await deps.resolveOpenRouterModelId();
    if (!requestedModelId || requestedModelId === 'openrouter/auto') {
      requestedModelId = configured ?? requestedModelId;
    }
  }
  return deps.resolveModel(providerId, requestedModelId);
}
