import type { ReactElement } from 'react';
import { CardLabel } from '../../components/ui/card';
import { Select } from '../../components/ui/select';
import {
  activityCountLabel,
  AGENT_ACTIVITY_FILTERS,
  type AgentActivityCategory,
} from './agent-activity-filter';

type AgentActivityHeaderProps = {
  readonly category: AgentActivityCategory;
  readonly matchCount: number;
  readonly totalCount: number;
  readonly onCategoryChange: (category: AgentActivityCategory) => void;
};

/**
 * Reference 6b's ACTIVITY line: the mono section label, the event count, and
 * the `All ▾` filter pushed to the right edge: the shared listbox select in
 * its borderless inline variant, only as wide as the value it shows.
 */
export function AgentActivityHeader({
  category,
  matchCount,
  totalCount,
  onCategoryChange,
}: AgentActivityHeaderProps): ReactElement {
  return (
    // The row wraps rather than overflowing: at the 280 px minimum a long
    // category name plus both counts cannot share one line. Its rule is the
    // feed's top edge, so a row scrolled under it reads as scrolled, not cut.
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border-subtle px-4 pt-4 pb-2">
      <CardLabel>Activity</CardLabel>
      <span
        className="text-2xs leading-none text-text-secondary"
        data-testid="agent-activity-count"
      >
        {activityCountLabel(matchCount, totalCount)}
      </span>
      <Select
        variant="inline"
        wrapperClassName="ml-auto"
        aria-label="Filter activity by type"
        data-testid="agent-activity-filter"
        value={category}
        options={AGENT_ACTIVITY_FILTERS}
        onValueChange={onCategoryChange}
      />
    </div>
  );
}
