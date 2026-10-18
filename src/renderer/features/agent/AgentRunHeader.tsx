import type { ReactElement } from 'react';
import { AGENT_EXECUTION_MODE_INFO, type AgentExecutionMode } from '@shared/constants/agent-modes';
import type { AgentSession, AgentSessionDetail } from '@shared/types/agent';
import { AppIcon } from '../../components/AppIcon';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { AgentRunMenu } from './AgentRunMenu';
import { formatRuntime, sessionStatusLabel, sessionStatusSentence, sessionStatusTone } from './agent-format';

const META = 'agent-mono text-2xs leading-[1.3] text-text-secondary';
/**
 * One meta chip. Chips wrap as whole units and never shrink to share a line, so
 * an ordinary value is always shown in full; only a value longer than the whole
 * row truncates, and it keeps the row's full width. The full text stays in the
 * accessible name and the tooltip. Values keep their own case — a profile,
 * model or folder name is user data, not a label to restyle.
 */
const META_CHIP = `${META} max-w-full shrink-0 truncate rounded-sm bg-bg-surface px-1.5 py-0.5`;

/** Modes that operate on the user's own directory rather than a copy of it. */
const DIRECT_MODES = new Set<AgentExecutionMode>(['active-env', 'native-restricted']);

type AgentRunHeaderProps = {
  readonly session: AgentSessionDetail;
  readonly profileName: string;
  readonly sessions: readonly AgentSession[];
  readonly resolveProfileName: (profileId: string) => string;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onBack: () => void;
  readonly onStop: () => void;
  readonly onSelectSession: (sessionId: string) => void;
};

/**
 * Reference 6b's single run header: two rows, then the body. Status, provider,
 * effective model, target directory and runtime are stated here once; nothing
 * below repeats them. Every value comes from the selected session's own
 * persisted record rather than from the composer's current state, so opening a
 * historical run cannot describe it with settings chosen since.
 */
export function AgentRunHeader({
  session,
  profileName,
  sessions,
  resolveProfileName,
  canStop,
  stopping,
  onBack,
  onStop,
  onSelectSession,
}: AgentRunHeaderProps): ReactElement {
  const runtime = formatRuntime(session.createdAt, session.updatedAt);
  const stoppable = canStop || stopping;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border-subtle px-4 pt-3 pb-3">
      {/* One row at the reference width. The panel narrows to 280 px, where
          the controls no longer fit side by side, so the row wraps rather than
          pushing anything past the panel edge. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Button
          size="inline"
          variant="ghost"
          data-testid="agent-back-button"
          aria-label="Back to all sessions and new task"
          onClick={onBack}
          className="h-7 gap-1.5 rounded-md px-1.5 text-xs"
        >
          <AppIcon name="back" size={13} />
          New task
        </Button>
        <h2
          id="agent-active-session-heading"
          className="mr-auto min-w-[72px] flex-1 truncate text-base leading-[1.2] font-semibold tracking-[-0.012em] text-text-primary"
        >
          Agent session
        </h2>
        <Badge size="pill" tone={sessionStatusTone(session.status)} data-testid="agent-session-status-badge">
          <BadgeDot />
          {sessionStatusLabel(session.status)}
        </Badge>
        {/* The actions wrap as one cluster held to the trailing edge, so the
            overflow control never lands alone under "New task" with its panel
            opening past the companion's leading edge. The reference's
            completed header carries no action but the overflow control, so
            Stop appears only while there is a run to stop. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {stoppable && (
            <Button
              size="inline"
              variant="danger"
              data-testid="agent-stop-button"
              disabled={!canStop}
              onClick={onStop}
              className="h-7 rounded-md px-2.5"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
          <AgentRunMenu
            sessions={sessions}
            activeSessionId={session.id}
            profileName={resolveProfileName}
            onSelect={onSelectSession}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="agent-session-meta">
        <MetaChip testId="agent-active-session-profile" label="Profile" value={profileName} />
        <MetaChip testId="agent-active-session-model" label="Model" value={session.effectiveModel ?? 'Provider default'} />
        <MetaChip testId="agent-active-session-directory" label="Working directory" value={session.targetDirectory.displayName} />
        <MetaChip testId="agent-active-session-mode" label="Mode" value={AGENT_EXECUTION_MODE_INFO[session.executionMode].label} />
        {runtime !== null && (
          <span className={`${META} ml-auto shrink-0 pl-1`} data-testid="agent-session-runtime" title={`Runtime ${runtime}`}>{runtime}</span>
        )}
      </div>

      {/* The design collapses the old "Selected working directory / HIGH RISK"
          panel into one inline warning. It is derived from this session's own
          recorded execution mode, so a historical run keeps the warning it ran
          under whatever the composer is set to now. */}
      {DIRECT_MODES.has(session.executionMode) && (
        <p role="note" data-testid="agent-direct-mode-warning" className="text-2xs leading-[1.4] text-danger">
          Ran directly in the selected working directory.
        </p>
      )}

      {/* The visible pill is a status chip; the run's state is also announced
          once, politely, so a screen reader hears it change without the
          timeline being re-read. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="agent-session-status">
        {sessionStatusSentence(session.status)}
      </p>
    </div>
  );
}

function MetaChip({ testId, label, value }: { readonly testId: string; readonly label: string; readonly value: string }): ReactElement {
  return (
    <span className={META_CHIP} title={`${label}: ${value}`}>
      <span className="sr-only">{label}: </span>
      <span data-testid={testId}>{value}</span>
    </span>
  );
}
