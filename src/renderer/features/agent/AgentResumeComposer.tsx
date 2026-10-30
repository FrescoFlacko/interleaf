import { useState, type ReactElement } from 'react';
import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import type { AgentSessionDetail } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { setAgentFollowUpDraft, useAgentFollowUp } from '../../stores/agent/follow-up-drafts';
import { usePromptHistory } from '../../hooks/use-prompt-history';
import { Button } from '../../components/ui/button';
import { ComposerShell } from '../../components/companion/ComposerShell';
import { Textarea } from '../../components/ui/textarea';
import { AgentResumeFollowUps } from './AgentResumeFollowUps';
import { promptLengthProblem } from './agent-format';

type AgentResumeComposerProps = {
  readonly session: AgentSessionDetail;
  readonly blockedReason: string | null;
  readonly busy: boolean;
};

/**
 * Reference 6b pins resume to the bottom of the panel, like the chat composer,
 * instead of leaving it in the middle of the run. It sits outside the activity
 * scroller, so it stays reachable however long the run gets.
 */
export function AgentResumeComposer({ session, blockedReason, busy }: AgentResumeComposerProps): ReactElement {
  // The draft and the follow-ups already sent outlive this composer, which
  // unmounts while the run is live; see `agent-follow-up-drafts`.
  const { draft, resumedPrompts } = useAgentFollowUp(session.id);
  const setDraft = (value: string): void => { setAgentFollowUpDraft(session.id, value); };
  const [status, setStatus] = useState<string | null>(null);
  // What this run has already been asked, oldest first: its task, then each follow-up.
  const promptHistory = usePromptHistory({
    submitted: [session.userPrompt, ...resumedPrompts],
    onValueChange: setDraft,
    resetKey: session.id,
  });

  if (blockedReason !== null) {
    return (
      <div className="shrink-0 border-t border-border-subtle px-4 pt-3 pb-4">
        <p role="alert" data-testid="agent-resume-blocked" className="text-xs text-text-secondary">
          {blockedReason}
        </p>
      </div>
    );
  }

  // A suggestion only fills the field; the reader still presses Resume.
  const fill = (prompt: string): void => {
    setDraft(prompt);
    window.setTimeout(() => { document.querySelector<HTMLTextAreaElement>('#agent-followup-prompt')?.focus(); }, 0);
  };

  const lengthProblem = promptLengthProblem(draft);
  const describedBy = lengthProblem !== null ? FOLLOW_UP_LENGTH_ID : undefined;

  const submit = (): void => {
    const prompt = draft;
    setStatus(null);
    void (async () => {
      // A resume the run accepts is recorded, and the field cleared, by the store.
      const resumed = await useAgentStore.getState().resume(prompt);
      if (resumed) {
        promptHistory.reset();
        setStatus('Session resumed.');
        return;
      }
      setStatus(takeResumeFailure(session.id));
    })();
  };

  return (
    <div className="shrink-0 border-t border-border-subtle px-4 pt-3 pb-4" data-testid="agent-resume-section">
      <ComposerShell>
        <AgentResumeFollowUps session={session} disabled={busy} onFill={fill} />
        <Textarea
          id="agent-followup-prompt"
          aria-label="Follow-up prompt"
          rows={2}
          value={draft}
          aria-invalid={lengthProblem !== null}
          aria-describedby={describedBy}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={promptHistory.handleKeyDown}
          placeholder="Follow-up instructions to resume in the same workspace…"
          className="companion-readable companion-readable-sm field-sizing-content max-h-40"
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-xs text-text-secondary">
            Same workspace · {AGENT_EXECUTION_MODE_INFO[session.executionMode].label}
          </span>
          <Button
            size="sm"
            variant="primary"
            data-testid="agent-resume-button"
            aria-label="Resume agent"
            className="ml-auto"
            disabled={!canResume(draft, busy)}
            onClick={submit}
          >
            Resume
          </Button>
        </div>
        <FollowUpFeedback lengthProblem={lengthProblem} status={status} />
      </ComposerShell>
    </div>
  );
}

/**
 * This composer reports its own failure, so the session-level alert does not
 * repeat it. Once another session is open, the store's error is not ours.
 */
function takeResumeFailure(sessionId: string): string | null {
  const { activeSession, error } = useAgentStore.getState();
  if (activeSession?.id !== sessionId) return null;
  if (error === null) return 'Could not resume session.';
  useAgentStore.setState({ error: null });
  return `Resume failed: ${error}`;
}

const FOLLOW_UP_LENGTH_ID = 'agent-followup-length';

function canResume(draft: string, busy: boolean): boolean {
  return !busy && draft.trim().length > 0 && promptLengthProblem(draft) === null;
}

/** Why the follow-up cannot be sent yet, and how the last resume went. */
function FollowUpFeedback({ lengthProblem, status }: {
  readonly lengthProblem: string | null;
  readonly status: string | null;
}): ReactElement {
  return (
    <>
      {lengthProblem !== null && (
        <p id={FOLLOW_UP_LENGTH_ID} data-testid="agent-resume-length" className="text-xs text-danger">{lengthProblem}</p>
      )}
      {/* Mounted before any message so screen readers announce the first one. */}
      <div aria-live="polite" className="contents">
        {status !== null && (
          <span className="text-xs text-text-secondary" data-testid="agent-resume-status">{status}</span>
        )}
      </div>
    </>
  );
}
