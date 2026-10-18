import type {
  AIModelInfo,
  AIProviderId,
  ChatContextBudget,
  ChatContextBudgetBreakdown,
} from '@shared/types/ai';
import type { BuiltChatContext } from './context-builder';

/**
 * Main-owned context-budget accounting for the AI Chat context bar.
 *
 * The published figure is the *last packed request*: the estimate
 * `ChatContextBuilder` produced for the request that was actually sent. It is
 * taken from that build verbatim — the selected history suffix, the question,
 * the explicit/automatic/retrieved sources, the XML provenance serialisation,
 * the fixed system-prompt and headroom charges and the reserved output
 * allowance, all measured against the enforced model window. Nothing here
 * re-derives that arithmetic, so the readout cannot drift from what the builder
 * enforces, and messages the builder excludes (streaming, failed, or history
 * beyond the recent suffix it keeps) are excluded from the readout as well.
 *
 * What it deliberately is not: a forecast of the next request. Forecasting one
 * would mean inventing a question the user has not written and running
 * retrieval for it, so before a session's first request there is nothing
 * truthful to report and the indicator renders nothing at all.
 */

/**
 * Hard ceiling for both the reported estimate and an accepted context window.
 * Sessions are bounded by the database, but a corrupt or absurd figure must not
 * reach the renderer as if it were a real measurement.
 */
const MAX_REPORTABLE_TOKENS = 100_000_000;

/** How many sessions keep a packed-request record in memory. */
const MAX_TRACKED_SESSIONS = 64;

/**
 * The model's context window when the provider layer supplies a usable one,
 * otherwise `null`. A `null` total is a truthful "unknown": callers render no
 * proportion instead of substituting a default denominator.
 */
export function declaredContextWindow(model: AIModelInfo): number | null {
  const total = model.contextWindow;
  if (!Number.isInteger(total) || total <= 0 || total > MAX_REPORTABLE_TOKENS) return null;
  return total;
}

/** A single charge, made safe to report without changing what it says. */
function reportableTokens(value: number, allowance: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Math.max(0, allowance));
}

/**
 * The builder's itemisation, made reportable.
 *
 * Components are taken in a fixed order and each is clamped to what remains of
 * the ceiling, so a corrupt or absurd charge cannot reach the renderer as if it
 * were a measurement, the aggregate still cannot exceed the ceiling, and the
 * parts still sum to the aggregate exactly. Nothing is clamped for any request
 * a model window could actually accept.
 */
function reportableBreakdown(built: BuiltChatContext): {
  readonly breakdown: ChatContextBudgetBreakdown;
  readonly usedTokens: number;
} {
  const raw = built.breakdown;
  let remaining = MAX_REPORTABLE_TOKENS;
  const take = (value: number): number => {
    const taken = reportableTokens(value, remaining);
    remaining -= taken;
    return taken;
  };
  const systemPromptTokens = take(raw.systemPromptTokens);
  const userPromptTokens = take(raw.userPromptTokens);
  const historyTokens = take(raw.historyTokens);
  const documentContextTokens = take(raw.documentContextTokens);
  const safetyHeadroomTokens = take(raw.safetyHeadroomTokens);
  const reservedResponseTokens = take(raw.reservedResponseTokens);
  return {
    breakdown: {
      systemPromptTokens,
      userPromptTokens,
      historyTokens,
      documentContextTokens,
      // Bounded by the envelope it is part of, so a clamped envelope cannot
      // report more framing than envelope.
      documentSerializationTokens: reportableTokens(raw.documentSerializationTokens, documentContextTokens),
      safetyHeadroomTokens,
      reservedResponseTokens,
    },
    usedTokens: MAX_REPORTABLE_TOKENS - remaining,
  };
}

export type PackedRequestBudgetInput = {
  readonly sessionId: string;
  readonly providerId: AIProviderId;
  readonly model: AIModelInfo;
  readonly built: BuiltChatContext;
};

/** Restates one built request as the budget record the renderer may display. */
export function packedRequestBudget(input: PackedRequestBudgetInput): ChatContextBudget {
  const { breakdown, usedTokens } = reportableBreakdown(input.built);
  return {
    sessionId: input.sessionId,
    providerId: input.providerId,
    modelId: input.model.id,
    usedTokens,
    totalTokens: declaredContextWindow(input.model),
    // Character-length estimation, never provider usage accounting. Surfaces
    // are contractually required to say so.
    accuracy: 'estimated',
    // One figure, reported once: the band the renderer draws for the response
    // reserve is the same charge the itemisation carries.
    reservedOutputTokens: breakdown.reservedResponseTokens,
    sourceCount: input.built.sources.length,
    breakdown,
  };
}

/**
 * The most recent packed request per session, bounded so a long-running app
 * cannot accumulate records without limit.
 *
 * A record is only handed back while it still describes the session's current
 * effective provider and model: after a binding change the last request was
 * packed for a different model, so reporting it would attribute one model's
 * usage to another. The reader receives `null` instead until a request is
 * packed under the new binding.
 */
export class PackedRequestBudgets {
  private readonly budgets = new Map<string, ChatContextBudget>();

  record(budget: ChatContextBudget): void {
    this.budgets.delete(budget.sessionId);
    this.budgets.set(budget.sessionId, budget);
    for (const oldest of this.budgets.keys()) {
      if (this.budgets.size <= MAX_TRACKED_SESSIONS) break;
      this.budgets.delete(oldest);
    }
  }

  forBinding(sessionId: string, providerId: AIProviderId, model: AIModelInfo): ChatContextBudget | null {
    const budget = this.budgets.get(sessionId);
    if (budget?.providerId !== providerId || budget.modelId !== model.id) return null;
    return budget;
  }

  forget(sessionId: string): void {
    this.budgets.delete(sessionId);
  }
}
