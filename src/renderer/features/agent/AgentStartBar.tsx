import type { ReactElement } from 'react';
import type { AgentExecutionMode } from '@shared/constants/agent-modes';
import type { AgentModeAvailability } from '@shared/types/agent-environment';
import type { AgentWorkingDirectory } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import { Button } from '../../components/ui/button';
import { profileBlockedReason, type AgentProfileView } from './agent-profile-view';
import { promptLengthProblem } from './agent-format';

type AgentStartBarProps = {
  readonly activeDocument: DocumentMetadata | null;
  readonly profileView: AgentProfileView;
  readonly workingDirectory: AgentWorkingDirectory | null;
  readonly executionMode: AgentExecutionMode;
  readonly modeAvailability: readonly AgentModeAvailability[];
  readonly taskDraft: string;
  /** Why Start waits on work already under way; see `startBusyReason`. */
  readonly busyReason: string | null;
  readonly error: string | null;
  readonly onStart: () => void;
};

/**
 * A launch is starting, or context the reader chose is still being read. Start
 * waits for that context rather than silently running without it.
 */
export function startBusyReason(loading: boolean, pendingContextLabel: string | null): string | null {
  if (loading) return 'Starting…';
  return pendingContextLabel === null ? null : `Attaching ${pendingContextLabel}… Start once it is attached, or cancel it.`;
}

/**
 * The reference pins the primary action to the bottom of the panel with the
 * one reason it cannot run yet beside it, so the reader never has to scroll to
 * find either. The message names the first unmet precondition rather than a
 * generic "not ready".
 */
export function AgentStartBar({
  activeDocument,
  profileView,
  workingDirectory,
  executionMode,
  modeAvailability,
  taskDraft,
  busyReason,
  error,
  onStart,
}: AgentStartBarProps): ReactElement {
  const availability = modeAvailability.find((item) => item.mode === executionMode);
  const blockedReason = startBlockedReason({
    hasDocument: activeDocument !== null,
    profileReason: profileBlockedReason(profileView),
    modeReason: availability?.available === false ? (availability.reason ?? 'This execution mode is unavailable.') : null,
    hasDirectory: workingDirectory !== null,
    hasTask: taskDraft.trim().length > 0,
    taskReason: promptLengthProblem(taskDraft),
    busyReason,
  });

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-4 pt-3.5 pb-4">
      <p
        className="min-w-0 flex-1 text-xs leading-[1.4] text-text-secondary"
        data-testid="agent-session-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {error ?? blockedReason ?? 'Ready to start.'}
      </p>
      <Button
        size="lg"
        variant="primary"
        data-testid="agent-start-button"
        disabled={blockedReason !== null}
        onClick={onStart}
      >
        Start agent
      </Button>
    </div>
  );
}

type StartPreconditions = {
  readonly hasDocument: boolean;
  readonly profileReason: string | null;
  readonly modeReason: string | null;
  readonly hasDirectory: boolean;
  readonly hasTask: boolean;
  readonly taskReason: string | null;
  readonly busyReason: string | null;
};

function startBlockedReason(preconditions: StartPreconditions): string | null {
  if (preconditions.busyReason !== null) return preconditions.busyReason;
  if (!preconditions.hasDocument) return 'Open a document to start an agent task.';
  if (preconditions.profileReason !== null) return preconditions.profileReason;
  if (preconditions.modeReason !== null) return preconditions.modeReason;
  if (!preconditions.hasDirectory) return 'Choose a working directory to start.';
  if (!preconditions.hasTask) return 'Describe the task to start.';
  return preconditions.taskReason;
}
