import { InterleafError } from '@shared/errors/interleaf-error';
import type { AIModelInfo, AIProviderId, ReasoningEffort } from '@shared/types/ai';

/**
 * The levels each CLI's own flag documents. A level outside its CLI's set is
 * refused even if a catalog somehow advertised it, so a parser fault can never
 * become an argv the CLI was not documented to take.
 */
const CLI_EFFORTS: Partial<Record<AIProviderId, ReadonlySet<ReasoningEffort>>> = {
  // `model_reasoning_effort`; `ultra` delegates to sub-agents and is never offered.
  codex: new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  // `--effort`: "low, medium, high, xhigh, max".
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  // `--thinking`: "off, minimal, low, medium, high, xhigh, max".
  pi: new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  // `--thinking`, without `auto`, which no model lists.
  omp: new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
};

/**
 * The argv tokens that carry one turn's reasoning level, appended after the
 * adapter's own fixed flags. Default sends nothing at all.
 *
 * The level is checked again here, against the catalog entry the turn will run
 * on — the same entry the adapter's own `--model` selection uses — so a level
 * that model does not offer stops the turn before anything is spawned.
 */
export function cliReasoningArgs(
  providerId: AIProviderId,
  modelId: string | null,
  models: readonly AIModelInfo[],
  effort: ReasoningEffort | undefined
): readonly string[] {
  if (effort === undefined) return [];
  const selectedId = modelId ?? models[0]?.id;
  const model = models.find((candidate) => candidate.id === selectedId);
  const offered = model?.reasoning?.levels.includes(effort) === true && CLI_EFFORTS[providerId]?.has(effort) === true;
  if (!offered) {
    throw new InterleafError('validation', 'This model does not offer that reasoning effort. Choose another level or Default.');
  }
  if (providerId === 'codex') return ['-c', `model_reasoning_effort="${effort}"`];
  if (providerId === 'claude') return ['--effort', effort];
  return ['--thinking', effort];
}
