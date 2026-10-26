import { useState, type CSSProperties, type ReactElement } from 'react';
import { AppIcon, type AppIconName } from '../../components/AppIcon';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { MarkdownContent } from '../../components/markdown/MarkdownContent';
import type { ActivityItemStatus, ActivityTodoItem, NormalizedAgentActivity } from './agent-activity';

/**
 * Timeline rows for the 6b activity feed. Every value below originates in a
 * subprocess or a model, so each one is rendered as React text content; no
 * branch in this file produces markup from agent output. Agent messages go
 * through the shared safe Markdown renderer, which keeps that guarantee and
 * draws complete Mermaid fences as sanitized, inert images.
 */

/** Keeps a long feed cheap to paint without virtualising it. */
export const ACTIVITY_ITEM_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 48px',
};

/** Reference row shell: 9px/11px padding, 9px radius, hairline border. */
const ROW = 'flex items-center gap-2 rounded-md border border-border-subtle px-3 py-2';

function statusTone(status: ActivityItemStatus): 'accent' | 'success' | 'danger' {
  switch (status) {
    case 'running':
      return 'accent';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
  }
}

function statusLabel(status: ActivityItemStatus, exitCode?: number | null): string {
  if (status === 'running') return 'Running…';
  if (exitCode !== null && exitCode !== undefined) return `Exit ${String(exitCode)}`;
  return status === 'failed' ? 'Failed' : 'Done';
}

export function CommandActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'command' }>;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const outputId = `activity-output-${activity.id}`;
  const hasOutput = typeof activity.output === 'string' && activity.output.trim().length > 0;

  return (
    <div data-testid={`activity-command-${activity.id}`} style={ACTIVITY_ITEM_STYLE} className="flex flex-col gap-2">
      <div className={ROW}>
        <span aria-hidden="true" className="agent-mono shrink-0 text-xs text-text-secondary">$</span>
        <span className="agent-mono companion-readable companion-readable-2xs min-w-0 flex-1 truncate leading-[1.4] text-text-primary" title={activity.command}>
          {activity.command}
        </span>
        <Badge tone={statusTone(activity.status)}>{statusLabel(activity.status, activity.exitCode)}</Badge>
      </div>
      {hasOutput && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={outputId}
            onClick={() => { setExpanded((previous) => !previous); }}
            className="self-start rounded text-xs text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {expanded ? 'Hide output' : 'Show output'}
          </button>
          <pre
            id={outputId}
            hidden={!expanded}
            tabIndex={0}
            aria-label="Command output"
            className="agent-mono companion-readable companion-readable-3xs max-h-40 overflow-auto rounded-md bg-bg-surface p-2.5 leading-[1.5] break-all whitespace-pre-wrap text-text-secondary"
          >
            {activity.output}
          </pre>
        </div>
      )}
    </div>
  );
}

export function FileChangeActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'file_change' }>;
}): ReactElement {
  const { additions, deletions } = activity;
  const hasCounts = additions !== null && additions !== undefined && deletions !== null && deletions !== undefined;

  return (
    <div data-testid={`activity-file-${activity.id}`} style={ACTIVITY_ITEM_STYLE} className={ROW}>
      <AppIcon name="file-edit" size={13} className="shrink-0 text-text-secondary" />
      <span className="agent-mono companion-readable companion-readable-2xs min-w-0 flex-1 truncate leading-[1.4] text-text-primary" title={activity.path}>
        {activity.path}
      </span>
      {hasCounts ? (
        <span className="agent-mono flex shrink-0 items-center gap-1.5 text-2xs">
          <span className="font-medium text-success">+{String(additions)}</span>
          <span className="font-medium text-danger">-{String(deletions)}</span>
        </span>
      ) : (
        <Badge tone={activity.status === 'added' ? 'success' : 'neutral'}>{activity.status ?? 'modified'}</Badge>
      )}
    </div>
  );
}

export function MessageActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'message' | 'final' }>;
}): ReactElement {
  const isFinal = activity.kind === 'final';
  return (
    <div
      data-testid={`activity-${isFinal ? 'final' : 'message'}-${activity.id}`}
      style={ACTIVITY_ITEM_STYLE}
      className="flex flex-col gap-1.5 rounded-lg bg-bg-surface px-3 py-3"
    >
      <span className="flex items-center gap-1.5 text-accent">
        <BadgeDot />
        <span className="text-2xs font-medium text-text-secondary leading-none">
          {isFinal ? 'Final output' : 'Agent'}
        </span>
      </span>
      <div className="companion-readable companion-readable-xs min-w-0 leading-[1.6] break-words text-text-primary">
        <MarkdownContent content={activity.text} diagrams />
      </div>
    </div>
  );
}

export function TestRunActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'test_run' }>;
}): ReactElement {
  return (
    <div data-testid={`activity-tests-${activity.id}`} style={ACTIVITY_ITEM_STYLE} className={ROW}>
      <span className="shrink-0 text-2xs font-medium text-text-secondary">Tests</span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
        {activity.summary ?? `${String(activity.passed ?? 0)} passed, ${String(activity.failed ?? 0)} failed`}
      </span>
      <Badge tone={testRunTone(activity)}>{testRunLabel(activity)}</Badge>
    </div>
  );
}

/**
 * A test report with no counted results is not a pass, so it is not painted
 * as one: only counted passes read as success.
 */
function testRunLabel(activity: Extract<NormalizedAgentActivity, { kind: 'test_run' }>): string {
  if (activity.status !== 'completed') return statusLabel(activity.status);
  return (activity.passed ?? 0) > 0 ? 'Passed' : 'No results';
}

function testRunTone(activity: Extract<NormalizedAgentActivity, { kind: 'test_run' }>): ReturnType<typeof statusTone> | 'neutral' {
  if (activity.status !== 'completed') return statusTone(activity.status);
  return (activity.passed ?? 0) > 0 ? 'success' : 'neutral';
}

/**
 * Each checklist mark is the only thing that says where that step stands, so
 * the glyph carries its own name rather than leaving the state visual-only.
 */
const TODO_STATUS_ICONS: Record<ActivityTodoItem['status'], { name: AppIconName; label: string }> = {
  completed: { name: 'status-complete', label: 'Completed' },
  in_progress: { name: 'status-in-progress', label: 'In progress' },
  failed: { name: 'status-failed', label: 'Failed' },
  pending: { name: 'status-pending', label: 'Pending' },
};

export function TodoListActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'todo_list' }>;
}): ReactElement {
  return (
    <div
      data-testid={`activity-todos-${activity.id}`}
      style={ACTIVITY_ITEM_STYLE}
      className="flex flex-col gap-2 rounded-lg bg-bg-surface px-3 py-3"
    >
      <span className="text-2xs font-medium text-text-secondary leading-none">Plan</span>
      <ul className="flex flex-col gap-1" aria-label="Agent checklist">
        {activity.todos.map((todo, index) => (
          <li key={`todo-${String(index)}-${todo.task.slice(0, 24)}`} className="flex items-start gap-2 text-xs leading-[1.5]">
            <span className={`flex shrink-0 items-center pt-1 ${todo.status === 'failed' ? 'text-danger' : 'text-text-secondary'}`}>
              <AppIcon name={TODO_STATUS_ICONS[todo.status].name} size={12} label={TODO_STATUS_ICONS[todo.status].label} />
            </span>
            <span className={todo.status === 'completed' ? 'text-text-secondary line-through' : 'text-text-primary'}>{todo.task}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LifecycleActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'lifecycle' }>;
}): ReactElement {
  const text =
    activity.eventType === 'started'
      ? 'Agent started.'
      : activity.eventType === 'ended'
        ? `Agent process ended (exit code ${String(activity.exitCode ?? 0)}).`
        : 'Agent execution was cancelled.';
  return (
    <p
      data-testid={`activity-lifecycle-${activity.id}`}
      style={ACTIVITY_ITEM_STYLE}
      className="px-1 text-2xs text-text-secondary"
    >
      {text}
    </p>
  );
}

export function LogActivityItem({
  activity,
}: {
  readonly activity: Extract<NormalizedAgentActivity, { kind: 'log' }>;
}): ReactElement {
  return (
    <p
      data-testid={`activity-log-${activity.id}`}
      style={ACTIVITY_ITEM_STYLE}
      className="agent-mono companion-readable companion-readable-3xs px-1 leading-[1.5] break-all whitespace-pre-wrap text-text-secondary"
    >
      {activity.text}
    </p>
  );
}
