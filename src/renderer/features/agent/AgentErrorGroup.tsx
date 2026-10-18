import type { ReactElement } from 'react';
import { BadgeDot } from '../../components/ui/badge';
import { Collapsible } from '../../components/ui/collapsible';
import type { AgentActivityError } from './agent-activity-groups';
import { ACTIVITY_ITEM_STYLE } from './AgentActivityItems';
import { truncateForDisplay } from './agent-format';

/** Single error row. Untrusted text, rendered as text. */
export function ErrorActivityItem({ error }: { readonly error: AgentActivityError }): ReactElement {
  return (
    <div
      role="alert"
      data-testid={`activity-error-${error.id}`}
      style={ACTIVITY_ITEM_STYLE}
      className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs leading-[1.5] text-danger"
    >
      <BadgeDot className="mt-1.5" />
      <span className="min-w-0 break-words">{truncateForDisplay(error.message, 400)}</span>
    </div>
  );
}

/**
 * A run of repeated equivalent errors, folded into one row with its count.
 * The reference collapses these so a retrying transport failure cannot bury
 * the rest of the timeline; the individual entries stay one activation away
 * and remain in the accessibility tree via the disclosure's controlled region.
 */
export function AgentErrorGroup({
  groupId,
  message,
  errors,
}: {
  readonly groupId: string;
  readonly message: string;
  readonly errors: readonly AgentActivityError[];
}): ReactElement {
  const count = errors.length;
  const summary = `${String(count)} repeated errors`;

  return (
    <div data-testid={`activity-error-group-${groupId}`} style={ACTIVITY_ITEM_STYLE}>
      <Collapsible
        className="rounded-md border border-border-subtle bg-bg-surface px-3 py-2.5"
        triggerClassName="flex w-full items-center gap-2 text-left"
        triggerLabel={`${summary}: ${truncateForDisplay(message, 120)}`}
        contentClassName="mt-2 flex flex-col gap-1.5"
        trigger={(expanded) => (
          <>
            <BadgeDot className="text-danger" />
            <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
              <span className="font-medium">{summary}</span>
              <span className="agent-mono ml-1.5 text-2xs text-text-secondary">{truncateForDisplay(message, 120)}</span>
            </span>
            <span className="shrink-0 text-xs text-accent">{expanded ? 'Hide' : 'Show'}</span>
          </>
        )}
      >
        {errors.map((error) => (
          <ErrorActivityItem key={error.id} error={error} />
        ))}
      </Collapsible>
    </div>
  );
}
