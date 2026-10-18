import { InterleafError } from '@shared/errors/interleaf-error';
import { REASONING_EFFORT_LABELS } from '@shared/constants/reasoning';
import type { AIModelInfo, AIModelReasoning, AIProviderId, ReasoningEffort } from '@shared/types/ai';

/** The part of the provider gateway that knows which levels a model offers. */
export type ModelReasoningSource = {
  modelReasoning?(providerId: AIProviderId, model: AIModelInfo): Promise<AIModelReasoning | null>;
};

/**
 * The levels main verified for the model a request would actually run against.
 *
 * A gateway that cannot answer falls back to what the resolved model itself
 * carries; a model with no verified metadata offers nothing but Default.
 */
export function reasoningFor(
  source: ModelReasoningSource,
  providerId: AIProviderId,
  model: AIModelInfo
): Promise<AIModelReasoning | null> {
  if (typeof source.modelReasoning === 'function') return source.modelReasoning(providerId, model);
  return Promise.resolve(model.reasoning ?? null);
}

function offers(reasoning: AIModelReasoning | null, effort: ReasoningEffort): boolean {
  return reasoning?.levels.includes(effort) === true;
}

/**
 * Refuses an explicit level the bound model does not offer, before anything is
 * stored. Default (`null`) and an absent choice are always acceptable.
 */
export function requireOfferedEffort(
  reasoning: AIModelReasoning | null,
  effort: ReasoningEffort | null | undefined
): void {
  if (effort === null || effort === undefined || offers(reasoning, effort)) return;
  throw new InterleafError('validation', 'This model does not offer that reasoning effort. Choose another level or Default.');
}

/**
 * The level one turn is sent with: absent for Default, the stored level when the
 * bound model still offers it. A level the model no longer offers is never
 * swapped for another one or dropped — the turn is refused, and the reader
 * chooses again.
 */
export function effortForTurn(
  reasoning: AIModelReasoning | null,
  stored: ReasoningEffort | null
): ReasoningEffort | undefined {
  if (stored === null) return undefined;
  if (offers(reasoning, stored)) return stored;
  throw new InterleafError(
    'validation',
    `This model no longer offers the ${REASONING_EFFORT_LABELS[stored]} reasoning effort. Choose another level or Default, then send again.`
  );
}
