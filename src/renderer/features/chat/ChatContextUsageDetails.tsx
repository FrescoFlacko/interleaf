import type {
  ChatContextBudget,
  ChatContextBudgetBreakdown,
} from '@shared/types/ai';

export const TITLE_ID = 'chat-context-budget-popover-title';

/**
 * The proportion at which a filling window stops being a detail and starts
 * being a constraint on answer quality, and the proportion at which it is about
 * to bite. Both match the thresholds VS Code's context-usage widget uses, so a
 * reader who knows one indicator reads this one the same way.
 */
const WARNING_PERCENTAGE = 75;
const ERROR_PERCENTAGE = 90;

export type BudgetLevel = 'normal' | 'warning' | 'error';

export function formatExactTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/** Share of the window, to one decimal, or `null` when there is no window. */
export function percentOfWindow(tokens: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return (tokens / total) * 100;
}

function formatPercent(percentage: number): string {
  return `${percentage.toFixed(1)}%`;
}

export function budgetLevel(percentage: number | null): BudgetLevel {
  if (percentage === null) return 'normal';
  if (percentage >= ERROR_PERCENTAGE) return 'error';
  if (percentage >= WARNING_PERCENTAGE) return 'warning';
  return 'normal';
}

type DetailRow = {
  readonly label: string;
  readonly tokens: number;
  /**
   * A part of the row above rather than a charge of its own. It is indented and
   * excluded from the total, so the itemisation still adds up to the aggregate.
   */
  readonly share?: boolean;
};

type DetailGroup = { readonly category: string; readonly rows: readonly DetailRow[] };

/**
 * The itemisation, grouped the way VS Code's context-usage details group theirs:
 * what the application asked for, what the conversation carries, and what is
 * held back before any of it is packed.
 *
 * Interleaf sends the model no tool definitions, so no tool row exists to show
 * and none is invented — the accounting reports charges that were made.
 */
function detailGroups(breakdown: ChatContextBudgetBreakdown): readonly DetailGroup[] {
  return [
    { category: 'System', rows: [{ label: 'System instructions', tokens: breakdown.systemPromptTokens }] },
    {
      category: 'Conversation',
      rows: [
        { label: 'Current prompt', tokens: breakdown.userPromptTokens },
        { label: 'Chat history', tokens: breakdown.historyTokens },
      ],
    },
    {
      category: 'Document context',
      rows: [
        { label: 'Sources and provenance', tokens: breakdown.documentContextTokens },
        { label: 'Serialization overhead', tokens: breakdown.documentSerializationTokens, share: true },
      ],
    },
    {
      category: 'Reserved',
      rows: [
        { label: 'Safety headroom', tokens: breakdown.safetyHeadroomTokens },
        { label: 'Reserved for response', tokens: breakdown.reservedResponseTokens },
      ],
    },
  ];
}

/** A charge of zero is not an omission, so it is simply not listed. */
function visibleGroups(breakdown: ChatContextBudgetBreakdown): readonly DetailGroup[] {
  return detailGroups(breakdown)
    .map((group) => ({ category: group.category, rows: group.rows.filter((row) => row.tokens > 0) }))
    .filter((group) => group.rows.length > 0);
}

/** One row's value: exact tokens, plus its share of the window when one exists. */
function rowValue(tokens: number, total: number | null): string {
  const percentage = percentOfWindow(tokens, total);
  const exact = formatExactTokens(tokens);
  return percentage === null ? `${exact} tokens` : `${exact} · ${formatPercent(percentage)}`;
}

function BudgetBreakdownList({
  breakdown,
  total,
}: {
  readonly breakdown: ChatContextBudgetBreakdown;
  readonly total: number | null;
}) {
  return (
    <div data-testid="chat-context-budget-breakdown" className="chat-design-budget-details">
      {visibleGroups(breakdown).map((group) => (
        <div key={group.category} className="chat-design-budget-category">
          <p className="chat-design-budget-category-header">{group.category}</p>
          <dl>
            {group.rows.map((row) => (
              <div
                key={row.label}
                className="chat-design-budget-row"
                data-budget-row={row.share === true ? 'share' : 'charge'}
              >
                <dt>{row.share === true ? `of which ${row.label.toLowerCase()}` : row.label}</dt>
                <dd>{rowValue(row.tokens, total)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * The window bar: how much of it the last request actually spent, and — as its
 * own band beyond that — the slice held back for the answer.
 *
 * The two bands are drawn from the same aggregate the heading prints, so the
 * bar cannot say the window is fuller or emptier than the numbers above it. The
 * bar carries no accessible text of its own because every figure it draws is
 * already written out beside it.
 */
function BudgetBar({
  usedPercentage,
  reservedPercentage,
}: {
  readonly usedPercentage: number;
  readonly reservedPercentage: number;
}) {
  const use = Math.max(0, Math.min(100, usedPercentage));
  const reserve = Math.max(0, Math.min(100 - use, reservedPercentage));
  return (
    <div className="chat-design-budget-bar" aria-hidden="true">
      <span className="chat-design-budget-bar-use" style={{ width: `${String(use)}%` }} />
      {reserve > 0 && (
        <span
          data-testid="chat-context-budget-reserved-band"
          className="chat-design-budget-bar-reserved"
          style={{ width: `${String(reserve)}%` }}
        />
      )}
    </div>
  );
}

export type ChatContextUsageDetailsProps = {
  readonly budget: ChatContextBudget;
  readonly total: number | null;
  readonly usedPercentage: number | null;
};

/**
 * Panel body: the aggregate, the proportion of the window it occupies, and the
 * itemisation behind it.
 *
 * Every figure comes from main's accounting for one request that was actually
 * packed. The aggregate is what that request charged against the window — the
 * text it carried plus the reserve held back for the answer — and the parts
 * listed below it sum to exactly that, a rule the IPC boundary enforces rather
 * than one this component re-checks.
 */
export function ChatContextUsageDetails({
  budget,
  total,
  usedPercentage,
}: ChatContextUsageDetailsProps) {
  const spentTokens = Math.max(0, budget.usedTokens - budget.reservedOutputTokens);
  const level = budgetLevel(usedPercentage);
  return (
    <>
      <h3 id={TITLE_ID} className="text-xs font-semibold text-text-primary">Context window</h3>
      {/* The numbers below are estimates, so they are labelled as such rather
          than explained in prose. */}
      <p data-testid="chat-context-budget-estimate-label" className="text-2xs leading-snug text-text-secondary">
        Estimated tokens
      </p>
      <div className="chat-design-budget-quota" data-budget-level={level}>
        <div className="chat-design-budget-quota-label">
          <span data-testid="chat-context-budget-tokens">
            {total === null
              ? `${formatExactTokens(budget.usedTokens)} tokens`
              : `${formatExactTokens(budget.usedTokens)} / ${formatExactTokens(total)} tokens`}
          </span>
          {usedPercentage !== null && (
            <span data-testid="chat-context-budget-percentage" className="chat-design-budget-quota-value">
              {`${String(Math.min(100, Math.round(usedPercentage)))}%`}
            </span>
          )}
        </div>
        {usedPercentage !== null && (
          <BudgetBar
            usedPercentage={percentOfWindow(spentTokens, total) ?? 0}
            reservedPercentage={percentOfWindow(budget.reservedOutputTokens, total) ?? 0}
          />
        )}
        {usedPercentage !== null && budget.reservedOutputTokens > 0 && (
          <p className="chat-design-budget-legend">
            <span aria-hidden="true" className="chat-design-budget-legend-swatch" />
            Reserved for response
          </p>
        )}
      </div>
      {total === null && (
        <p data-testid="chat-context-budget-unknown-total" className="text-2xs leading-snug text-text-secondary">
          The total context window for this model is unavailable, so no proportion is shown.
        </p>
      )}
      <BudgetBreakdownList breakdown={budget.breakdown} total={total} />
      {level !== 'normal' && (
        <p data-testid="chat-context-budget-warning" className="chat-design-budget-warning">
          Quality may decline as the limit nears.
        </p>
      )}
    </>
  );
}
