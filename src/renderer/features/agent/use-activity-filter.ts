import { useEffect, useMemo, useState } from 'react';
import type { NormalizedAgentActivity } from './agent-activity';
import { groupRepeatedErrors, type AgentActivityEntry } from './agent-activity-groups';
import {
  countActivityEvents,
  filterActivityEntries,
  type AgentActivityCategory,
} from './agent-activity-filter';

export type ActivityFilterState = {
  readonly category: AgentActivityCategory;
  /** Grouped rows that survive the current category. */
  readonly entries: readonly AgentActivityEntry[];
  readonly matchCount: number;
  readonly totalCount: number;
  readonly emptyMessage: string;
  readonly setCategory: (category: AgentActivityCategory) => void;
};

/**
 * Client-side state for the 6b activity filter. Nothing crosses the bridge and
 * nothing is persisted: the timeline is already normalized in the renderer.
 *
 * The selection is stored together with the session it was made for, and every
 * switch of the selected session resets it to `all`: carrying a category across
 * runs could present a busy run as an empty feed.
 *
 * The reset has two halves because the view is reused rather than remounted per
 * session, and each half alone is wrong:
 *
 * - Deriving the category in render means the new run is never painted through
 *   the old run's category, not even for one frame.
 * - Committing the reset in an effect means the old selection is actually
 *   dropped. Without it the stale category is only masked, so returning to the
 *   earlier run would silently restore its filter.
 */
export function useActivityFilter(
  sessionId: string,
  activities: readonly NormalizedAgentActivity[]
): ActivityFilterState {
  const [selection, setSelection] = useState<{
    readonly sessionId: string;
    readonly category: AgentActivityCategory;
  }>({ sessionId, category: 'all' });

  const category: AgentActivityCategory = selection.sessionId === sessionId ? selection.category : 'all';

  useEffect(() => {
    setSelection((current) => (
      current.sessionId === sessionId ? current : { sessionId, category: 'all' }
    ));
  }, [sessionId]);

  const grouped = useMemo(() => groupRepeatedErrors(activities), [activities]);
  const entries = useMemo(() => filterActivityEntries(grouped, category), [grouped, category]);

  return {
    category,
    entries,
    matchCount: countActivityEvents(entries),
    totalCount: activities.length,
    emptyMessage: category === 'all' ? 'Waiting for agent activity…' : 'No events match this filter.',
    setCategory: (next) => { setSelection({ sessionId, category: next }); },
  };
}
