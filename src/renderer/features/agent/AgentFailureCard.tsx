import type { ReactElement } from 'react';
import { toSelectableDefaultExecutionMode } from '@shared/constants/agent-mode-selection';
import type { AgentSessionDetail } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { useUiStore } from '../../stores/use-ui-store';
import { Button } from '../../components/ui/button';
import { CardLabel } from '../../components/ui/card';
import type { AgentFailureSummary } from './agent-failure-summary';

type AgentFailureCardProps = {
  readonly session: AgentSessionDetail;
  readonly summary: AgentFailureSummary;
};

/**
 * A failed run states what failed before the feed: the run's own error or
 * exit, its exit code and the last line it wrote to stderr. Retry and Edit task
 * only reopen the new-task view with this run's task and settings; nothing is
 * started here, so Start and every confirmation it requires still apply.
 */
export function AgentFailureCard({ session, summary }: AgentFailureCardProps): ReactElement {
  return (
    <section
      aria-label="Agent run failed"
      data-testid="agent-failure-card"
      className="mt-3 flex shrink-0 flex-col gap-1.5 rounded-lg border border-danger/40 bg-bg-surface px-3 py-3"
    >
      <div className="flex items-center gap-2">
        <CardLabel>What failed</CardLabel>
        {summary.exitCode !== null && (
          <span data-testid="agent-failure-exit-code" className="agent-mono ml-auto text-2xs text-text-secondary">
            Exit code {String(summary.exitCode)}
          </span>
        )}
      </div>
      <p data-testid="agent-failure-reason" className="text-xs leading-[1.45] break-words text-text-primary">
        {summary.reason}
      </p>
      {summary.lastStderr !== null && (
        <p className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs text-text-secondary">Last error output</span>
          <code data-testid="agent-failure-stderr" className="agent-mono text-2xs leading-[1.4] break-words whitespace-pre-wrap text-text-secondary">
            {summary.lastStderr}
          </code>
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          size="chip"
          variant="primary"
          data-testid="agent-failure-retry"
          onClick={() => { reopenTask(session, 'agent-start-button'); }}
        >
          Retry
        </Button>
        <Button
          size="chip"
          variant="outline"
          data-testid="agent-failure-edit"
          onClick={() => { reopenTask(session, 'agent-task-description'); }}
        >
          Edit task
        </Button>
        <span className="text-2xs text-text-secondary">Opens the task again. Nothing runs until you press Start.</span>
      </div>
    </section>
  );
}

/**
 * Returns to the new-task view carrying this run's task, profile and model.
 * A direct-workspace mode is never restored: it must stay a deliberate choice
 * made in the composer, so the composer keeps whatever mode it already has.
 */
function reopenTask(session: AgentSessionDetail, focusId: string): void {
  const agent = useAgentStore.getState();
  if (agent.selectedProfileId !== session.profileId && agent.profiles.some((profile) => profile.id === session.profileId)) {
    agent.setSelectedProfile(session.profileId);
  }
  if (useAgentStore.getState().selectedProfileId === session.profileId) {
    useAgentStore.getState().setSelectedModel(session.effectiveModel);
  }
  const ui = useUiStore.getState();
  const restorableMode = toSelectableDefaultExecutionMode(session.executionMode);
  if (restorableMode === session.executionMode) ui.setComposerExecutionMode(restorableMode);
  ui.setTaskDraft(session.userPrompt);
  useAgentStore.getState().deselectSession();
  requestAnimationFrame(() => {
    const target = document.getElementById(focusId) ?? document.querySelector<HTMLElement>(`[data-testid="${focusId}"]`);
    if (target instanceof HTMLButtonElement && target.disabled) {
      document.getElementById('agent-task-description')?.focus();
      return;
    }
    target?.focus();
  });
}
