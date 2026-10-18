import type { NormalizedAgentActivity } from './agent-activity';
import type { AgentActivityEntry } from './agent-activity-groups';

/** Every category a real timeline row can fall into. */
export type AgentActivityKindCategory = 'messages' | 'commands' | 'files' | 'tests' | 'errors' | 'status';

/** The categories the 6b `All ▾` control offers, including the unfiltered one. */
export type AgentActivityCategory = 'all' | AgentActivityKindCategory;

/**
 * Total mapping from normalized activity kind to filter category. It is
 * declared over the kind union, so a new activity kind fails to typecheck here
 * rather than silently disappearing from every non-`all` view.
 *
 * `final` joins `messages` because the final report is the agent's own prose
 * and the timeline already renders it with the same card. Lifecycle rows, raw
 * stdout/stderr logs and plan updates are the run's status commentary rather
 * than an artefact, so they share one category.
 */
const CATEGORY_BY_KIND: Readonly<Record<NormalizedAgentActivity['kind'], AgentActivityKindCategory>> = {
  message: 'messages',
  final: 'messages',
  command: 'commands',
  file_change: 'files',
  test_run: 'tests',
  error: 'errors',
  lifecycle: 'status',
  log: 'status',
  todo_list: 'status',
};

export const AGENT_ACTIVITY_FILTERS: readonly {
  readonly value: AgentActivityCategory;
  readonly label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Agent messages' },
  { value: 'commands', label: 'Commands' },
  { value: 'files', label: 'Files' },
  { value: 'tests', label: 'Tests' },
  { value: 'errors', label: 'Errors' },
  { value: 'status', label: 'Status & other' },
];

export function categorizeActivity(activity: NormalizedAgentActivity): AgentActivityKindCategory {
  return CATEGORY_BY_KIND[activity.kind];
}

/** An error group is a run of errors, so it belongs to exactly one category. */
function categorizeEntry(entry: AgentActivityEntry): AgentActivityKindCategory {
  return entry.kind === 'single' ? categorizeActivity(entry.activity) : 'errors';
}

/** Narrows an untrusted value back onto the offered categories. */
export function isAgentActivityCategory(value: string): value is AgentActivityCategory {
  return AGENT_ACTIVITY_FILTERS.some((filter) => filter.value === value);
}

/**
 * Filters already-grouped timeline rows. Grouping deliberately runs first: it
 * folds only *consecutive* equivalent errors, so filtering afterwards shows the
 * same groups the unfiltered feed shows and can never fold together two errors
 * that were separated by a command in the real run.
 */
export function filterActivityEntries(
  entries: readonly AgentActivityEntry[],
  category: AgentActivityCategory
): readonly AgentActivityEntry[] {
  if (category === 'all') return entries;
  return entries.filter((entry) => categorizeEntry(entry) === category);
}

/** Events represented by these rows; a folded group counts every error in it. */
export function countActivityEvents(entries: readonly AgentActivityEntry[]): number {
  return entries.reduce(
    (total, entry) => total + (entry.kind === 'single' ? 1 : entry.errors.length),
    0
  );
}

/**
 * The header's count. While everything is shown it stays the plain reference
 * wording; once a filter hides something it states both numbers, so a small
 * count never reads as a short run.
 */
export function activityCountLabel(matched: number, total: number): string {
  const noun = total === 1 ? 'event' : 'events';
  return matched === total ? `${String(total)} ${noun}` : `${String(matched)} of ${String(total)} ${noun}`;
}
