import type { ChatContextBudget } from '@shared/types/ai';
import { budgetLevel, formatExactTokens, percentOfWindow, type BudgetLevel } from './ChatContextUsageDetails';

/**
 * Everything the wheel and its panel draw about the window, derived once from
 * main's accounting for the last packed request — or from the absence of it.
 *
 * The accounting is held in memory by main, so a conversation that was restored,
 * rebound to another model, or simply not packed yet has no figures at all. That
 * is a real state rather than a zero: nothing about the window is claimed for it.
 */
export type ContextWindowReadout = {
  readonly budget: ChatContextBudget | null;
  readonly total: number | null;
  readonly usedPercentage: number | null;
  /** The proportion the ring draws, or nothing to draw. */
  readonly fraction: number | null;
  readonly level: BudgetLevel;
  readonly totalState: 'known' | 'unavailable';
  readonly label: string;
};

const UNAVAILABLE: Omit<ContextWindowReadout, 'budget'> = {
  total: null,
  usedPercentage: null,
  fraction: null,
  level: 'normal',
  totalState: 'unavailable',
  label: 'Context window: usage statistics unavailable',
};

/**
 * The wheel's name and hover tooltip: short enough to be one, leads with the
 * proportion the ring draws, and still says which request it counts and that
 * the count is an estimate. The rest is one activation away.
 */
function budgetLabel(budget: ChatContextBudget, total: number | null, usedPercentage: number | null): string {
  const used = formatExactTokens(budget.usedTokens);
  return total === null || usedPercentage === null
    ? `Context window: last request used ${used} tokens, total unavailable (estimated)`
    : `Context window: ${String(Math.round(usedPercentage))}% used, last request used ${used} of ${formatExactTokens(total)} tokens (estimated)`;
}

export function contextWindowReadout(budget: ChatContextBudget | null): ContextWindowReadout {
  if (budget === null) return { budget, ...UNAVAILABLE };
  const total = budget.totalTokens;
  const usedPercentage = percentOfWindow(budget.usedTokens, total);
  return {
    budget,
    total,
    usedPercentage,
    // Clamped to a full ring when the packed request already fills the window:
    // the builder truncates in that case, so more than a full ring would claim
    // something untrue about what gets sent.
    fraction: total === null ? null : Math.min(1, budget.usedTokens / total),
    level: budgetLevel(usedPercentage),
    totalState: total === null ? 'unavailable' : 'known',
    label: budgetLabel(budget, total, usedPercentage),
  };
}

/**
 * Whether the composer offers the context wheel at all.
 *
 * Figures are one reason to open the panel and compaction is the other, so the
 * wheel survives the absence of either. With neither there is nothing behind it
 * and it is not rendered.
 */
export function showsContextWindow(
  budget: ChatContextBudget | null,
  cleanContext: { readonly control: { readonly present: boolean } }
): boolean {
  return budget !== null || cleanContext.control.present;
}
