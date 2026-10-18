import { useEffect, useState, type ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import { useAgentStore } from '../../stores/use-agent-store';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { AgentDisclosure } from './AgentDisclosure';
import { DiscardSandboxAction } from './AgentDiscardConfirm';
import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import { truncateForDisplay } from './agent-format';
import { reviewDiffIdentity } from './agent-session-state';

const MAX_REVIEW_FILES = 100;
const MAX_REVIEW_TESTS = 64;
const MAX_REVIEW_DIFF = 50_000;

type AgentReviewCardProps = {
  readonly session: AgentSessionDetail;
  readonly environment: AgentSessionEnvironment;
  readonly actionsReady: boolean;
  /**
   * A resumed run is still writing to this workspace, so what the card holds is
   * the previous run's review. It says so, and its test outcomes wait.
   */
  readonly active?: boolean;
};

/**
 * Sandbox review. Risk level, the direct-modification alert and the session
 * context stay in view at all times because they are what tells the reader
 * whether opening the rest is safe; the file detail, diff and the actions that
 * act on the sandbox open on request.
 */
export function AgentReviewCard({ session, environment, actionsReady, active = false }: AgentReviewCardProps): ReactElement {
  const [showDiff, setShowDiff] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  // Tagged with its run so a late export never reports on another session.
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const diffIdentity = reviewDiffIdentity(session.id, environment);

  useEffect(() => { setShowDiff(false); }, [diffIdentity]);

  const runAction = (operation: () => Promise<void>): void => {
    if (actionInFlight) return;
    setActionInFlight(true);
    setActionStatus(null);
    void operation().finally(() => { setActionInFlight(false); });
  };
  const exportPatch = async (): Promise<void> => {
    const sessionId = session.id;
    const text = await useAgentStore.getState().exportPatch();
    setActionStatus(text === null ? null : { sessionId, text });
  };
  const disabled = !actionsReady || actionInFlight;

  return (
    <div
      data-testid="agent-environment-review"
      className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="agent-mono min-w-0 truncate text-2xs text-text-secondary">
          {truncateForDisplay(environment.workspaceLabel, 160)}
        </span>
        <Badge tone={environment.riskLevel === 'low' ? 'neutral' : 'danger'}>{environment.riskLevel} risk</Badge>
      </div>
      <p className="agent-mono text-2xs leading-[1.4] text-text-secondary" data-testid="agent-review-session-context">
        Working directory: {truncateForDisplay(session.targetDirectory.displayName, 160)} · Execution mode: {AGENT_EXECUTION_MODE_INFO[session.executionMode].label}
      </p>
      <StaleReviewNote active={active} />
      <p className="text-xs text-text-secondary">
        {environment.changedFiles.length} changed file{environment.changedFiles.length === 1 ? '' : 's'}
      </p>
      {environment.activeWorkspaceModified && (
        <p role="alert" className="text-xs font-medium text-danger">
          Active workspace modified directly.
        </p>
      )}
      {environment.applyDisabledReason !== null && (
        <p className="text-xs text-text-secondary">{truncateForDisplay(environment.applyDisabledReason)}</p>
      )}

      <AgentDisclosure regionId="agent-review-region" label="Review" testId="agent-review-details">
        <div className="mt-1.5" data-testid="agent-review-files">
          <p className="text-2xs font-medium text-text-secondary">Changed files</p>
          {environment.changedFiles.length === 0 ? (
            <p className="mt-1 text-xs text-text-secondary">No changed files reported.</p>
          ) : (
            <ul aria-label="Changed files" className="companion-readable companion-readable-2xs mt-1 max-h-40 overflow-auto">
              {environment.changedFiles.slice(0, MAX_REVIEW_FILES).map((change) => (
                <li
                  key={`${change.path}-${change.kind}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border-subtle py-1 last:border-b-0"
                >
                  <span className="agent-mono min-w-0 truncate" title={truncateForDisplay(change.path, 240)}>
                    {truncateForDisplay(change.path, 240)}
                  </span>
                  <span className="shrink-0 text-text-secondary">
                    {change.kind} · +{String(change.additions)} / −{String(change.deletions)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {environment.changedFiles.length > MAX_REVIEW_FILES && (
            <p className="mt-1 text-2xs text-text-secondary">
              Showing the first {String(MAX_REVIEW_FILES)} of {String(environment.changedFiles.length)} changed files.
            </p>
          )}
        </div>
        {environment.diffAvailable && environment.diff !== null && (
          <>
            <Button
              size="inline"
              aria-expanded={showDiff}
              aria-controls="agent-environment-diff"
              data-testid="agent-view-diff-button"
              onClick={() => { setShowDiff((expanded) => !expanded); }}
              className="mt-2 h-7 rounded-md border border-border-subtle px-2.5"
            >
              View Diff
            </Button>
            {showDiff && (
              <pre
                id="agent-environment-diff"
                data-testid="agent-environment-diff"
                className="agent-mono companion-readable companion-readable-3xs mt-2 max-h-40 overflow-auto rounded-md bg-bg-primary p-2 whitespace-pre-wrap text-text-secondary"
              >
                {truncateForDisplay(environment.diff, MAX_REVIEW_DIFF)}
              </pre>
            )}
          </>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5" aria-busy={actionInFlight}>
          {environment.applyAllowed && (
            <Button size="chip" disabled={disabled} onClick={() => { runAction(() => useAgentStore.getState().applyChanges()); }}>
              Apply Changes
            </Button>
          )}
          {environment.patchAvailable && (
            <Button size="chip" disabled={disabled} onClick={() => { runAction(exportPatch); }}>
              Export Patch…
            </Button>
          )}
          <Button size="chip" disabled={disabled} onClick={() => { runAction(() => useAgentStore.getState().openFolder()); }}>
            Open Folder
          </Button>
          <DiscardSandboxAction session={session} environment={environment} disabled={disabled} />
          <Button size="chip" disabled={disabled} onClick={() => { runAction(() => useAgentStore.getState().refreshEnvironment()); }}>
            Refresh
          </Button>
        </div>
        <ReviewActionStatus status={actionStatus} sessionId={session.id} />
      </AgentDisclosure>

      <AgentDisclosure regionId="agent-review-tests-region" label="Test outcomes" testId="agent-review-tests">
        <ReviewTestOutcomes tests={environment.tests} active={active} />
      </AgentDisclosure>
    </div>
  );
}

/** Shown while a resumed run is still writing, so the card is not read as current. */
function StaleReviewNote({ active }: { readonly active: boolean }): ReactElement | null {
  if (!active) return null;
  return (
    <p data-testid="agent-review-stale" className="text-xs text-text-secondary">
      From the previous run. This review updates when the current run ends.
    </p>
  );
}

/** Test outcomes wait for the current run; until then they read as running, not as the old result. */
function ReviewTestOutcomes({ tests, active }: {
  readonly tests: AgentSessionEnvironment['tests'];
  readonly active: boolean;
}): ReactElement {
  if (active) {
    return <p data-testid="agent-review-tests-running" className="mt-1 text-xs text-text-secondary">Running…</p>;
  }
  if (tests.length === 0) {
    return <p className="mt-1 text-xs text-text-secondary">No test results reported.</p>;
  }
  return (
    <>
      <ul aria-label="Test outcomes" className="companion-readable companion-readable-2xs mt-1 max-h-32 overflow-auto">
        {tests.slice(0, MAX_REVIEW_TESTS).map((test, index) => (
          <li key={`${test.status}-${String(index)}-${test.summary.slice(0, 32)}`} className="py-0.5">
            <span className="font-semibold">{test.status}</span>: {truncateForDisplay(test.summary)}
            {test.exitCode !== null ? ` · exit ${String(test.exitCode)}` : ''}
            {test.durationMs !== null ? ` · ${String(test.durationMs)} ms` : ''}
          </li>
        ))}
      </ul>
      {tests.length > MAX_REVIEW_TESTS && (
        <p className="mt-1 text-2xs text-text-secondary">
          Showing the first {String(MAX_REVIEW_TESTS)} of {String(tests.length)} test results.
        </p>
      )}
    </>
  );
}

type ActionStatus = { readonly sessionId: string; readonly text: string };

/** The outcome of the last review action, shown only on the run it belongs to. */
function ReviewActionStatus({ status, sessionId }: { readonly status: ActionStatus | null; readonly sessionId: string }): ReactElement {
  return (
    <div aria-live="polite" className="contents">
      {status?.sessionId === sessionId && (
        <p data-testid="agent-review-action-status" className="mt-1.5 text-2xs text-text-secondary">{truncateForDisplay(status.text)}</p>
      )}
    </div>
  );
}
