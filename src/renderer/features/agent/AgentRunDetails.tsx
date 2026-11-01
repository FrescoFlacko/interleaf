import { useState, type ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { useUiStore } from '../../stores/use-ui-store';
import { Badge } from '../../components/ui/badge';
import { bridge } from '../../app/api-client';
import { Button } from '../../components/ui/button';
import { CardLabel } from '../../components/ui/card';
import { Collapsible } from '../../components/ui/collapsible';
import { truncateForDisplay } from './agent-format';

type AgentRunDetailsProps = {
  readonly session: AgentSessionDetail;
};

/**
 * Moves a past task into the new-task field and leaves the run view. It only
 * places a draft: the reader reviews it and starts the run themselves.
 */
function reuseAsNewTask(prompt: string): void {
  useUiStore.getState().setTaskDraft(prompt);
  useAgentStore.getState().deselectSession();
  window.setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>('#agent-task-description')?.focus();
  }, 0);
}

/**
 * Reference 6b's task block as Run details (DESIGN.md, Prompt details): the
 * full task prompt, its attached context, and actions to copy or reuse the
 * prompt. Profile, model, directory and mode are stated once, in the run
 * header above, so they are not repeated here. The prompt and context are operator- and
 * document-supplied text, rendered as text only.
 */
export function AgentRunDetails({ session }: AgentRunDetailsProps): ReactElement {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyPrompt = async (): Promise<void> => {
    try {
      await bridge.clipboard.writeText(session.userPrompt);
      setCopyStatus('Prompt copied.');
    } catch {
      setCopyStatus('Could not copy prompt.');
    }
  };

  return (
    <Collapsible
      defaultExpanded
      className="flex flex-col gap-2"
      contentClassName="flex min-w-0 flex-col gap-2"
      triggerClassName="flex w-full items-baseline gap-2"
      trigger={(expanded) => (
        <>
          <CardLabel className="mr-auto">Run details</CardLabel>
          <span className="text-xs leading-none text-accent">{expanded ? 'Collapse' : 'Expand'}</span>
        </>
      )}
      triggerLabel="Run details"
    >
      {/* A long task scrolls inside its own bounded, keyboard-reachable region
        * so it can never push the Result card and the timeline out of view.
        * Copy prompt still copies the full value. */}
      <div role="region" aria-label="Task prompt" tabIndex={0} data-testid="agent-run-prompt" className="agent-run-prompt">
        <p className="companion-readable companion-readable-sm leading-[1.55] break-words whitespace-pre-wrap text-text-primary" data-testid="agent-active-session-title">
          {truncateForDisplay(session.userPrompt, 20_000)}
        </p>
      </div>
      {session.contextSummary !== null && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge size="pill" tone="accent" data-testid="agent-session-context-summary" className="max-w-full">
            <span className="min-w-0 truncate">{truncateForDisplay(session.contextSummary, 200)}</span>
          </Badge>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="inline" variant="link" data-testid="agent-copy-prompt-button" onClick={() => { void copyPrompt(); }}>
          Copy prompt
        </Button>
        <Button size="inline" variant="link" data-testid="agent-use-as-new-task-button" onClick={() => { reuseAsNewTask(session.userPrompt); }}>
          Use as new task
        </Button>
        {copyStatus !== null && (
          <span aria-live="polite" className="text-2xs text-text-secondary">{copyStatus}</span>
        )}
      </div>
    </Collapsible>
  );
}
