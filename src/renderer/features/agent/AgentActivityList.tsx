import type { ReactElement } from 'react';
import type { NormalizedAgentActivity } from './agent-activity';
import type { AgentActivityEntry } from './agent-activity-groups';
import { AgentErrorGroup, ErrorActivityItem } from './AgentErrorGroup';
import {
  CommandActivityItem,
  FileChangeActivityItem,
  LifecycleActivityItem,
  LogActivityItem,
  MessageActivityItem,
  TestRunActivityItem,
  TodoListActivityItem,
} from './AgentActivityItems';

type AgentActivityListProps = {
  /** Already grouped and filtered by the session view. */
  readonly entries: readonly AgentActivityEntry[];
  readonly emptyMessage: string;
  /** Whether the newest run is still in progress, which names its divider. */
  readonly active?: boolean;
};

function renderActivity(activity: NormalizedAgentActivity): ReactElement {
  switch (activity.kind) {
    case 'message':
    case 'final':
      return <MessageActivityItem activity={activity} />;
    case 'command':
      return <CommandActivityItem activity={activity} />;
    case 'file_change':
      return <FileChangeActivityItem activity={activity} />;
    case 'todo_list':
      return <TodoListActivityItem activity={activity} />;
    case 'test_run':
      return <TestRunActivityItem activity={activity} />;
    case 'error':
      return <ErrorActivityItem error={activity} />;
    case 'lifecycle':
      return <LifecycleActivityItem activity={activity} />;
    case 'log':
      return <LogActivityItem activity={activity} />;
  }
}

function renderEntry(entry: AgentActivityEntry): ReactElement {
  return entry.kind === 'single' ? (
    renderActivity(entry.activity)
  ) : (
    <AgentErrorGroup groupId={entry.id} message={entry.message} errors={entry.errors} />
  );
}

/**
 * The 6b typed timeline. Each event kind gets its own row shape, and runs of
 * repeated equivalent errors are folded into one collapsed group so a retrying
 * transport failure cannot bury the rest of the run.
 *
 * The list is not itself the scroller: the session view owns one scroll region
 * for the whole feed, so the pinned resume composer stays outside it. Grouping
 * and category filtering happen there too, so the rows arrive ready to render.
 */
export function AgentActivityList({
  entries,
  emptyMessage,
  active = false,
}: AgentActivityListProps): ReactElement {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg bg-bg-surface px-3 py-3 text-center text-xs text-text-secondary" data-testid="agent-activity-empty">
        {emptyMessage}
      </p>
    );
  }

  const runLabels = runDividerLabels(entries, active);
  return (
    <div role="log" aria-label="Agent event log" data-testid="agent-activity-list" className="flex flex-col gap-2">
      {entries.map((entry) => (
        <div key={entry.id}>
          <RunDivider label={runLabels.get(entry.id)} />
          {renderEntry(entry)}
        </div>
      ))}
    </div>
  );
}

/**
 * A resumed session keeps every earlier run in its history. When there is more
 * than one, each run opens with a divider so the earlier run's output and exit
 * cannot be read as the one in progress.
 */
function runDividerLabels(entries: readonly AgentActivityEntry[], active: boolean): ReadonlyMap<string, string> {
  const starts = entries.filter((entry) =>
    entry.kind === 'single' && entry.activity.kind === 'lifecycle' && entry.activity.eventType === 'started'
  );
  if (starts.length < 2) return new Map();
  const latest = latestRunLabel(active);
  return new Map(starts.map((entry, index) => [entry.id, index < starts.length - 1 ? 'Earlier run' : latest]));
}

function latestRunLabel(active: boolean): string {
  return active ? 'Current run' : 'Latest run';
}

function RunDivider({ label }: { readonly label: string | undefined }): ReactElement | null {
  if (label === undefined) return null;
  return (
    <p data-testid="agent-run-divider" className="mt-1 flex items-center gap-2 text-2xs font-medium text-text-secondary">
      {label}
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
    </p>
  );
}
