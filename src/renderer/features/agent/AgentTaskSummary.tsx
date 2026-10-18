import type { ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import { AgentRunDetails } from './AgentRunDetails';

/**
 * Reference 6b's task block. The prompt and the context attached to the run
 * are shown once, above the timeline, in a Run details
 * disclosure that can be collapsed so a long task never pushes the activity
 * out of view.
 */
export function AgentTaskSummary({ session }: { readonly session: AgentSessionDetail }): ReactElement {
  return (
    <div data-testid="agent-run-summary" className="agent-run-summary flex flex-col gap-2 border-b border-border-subtle px-4 pt-3 pb-3">
      <AgentRunDetails session={session} />
    </div>
  );
}
