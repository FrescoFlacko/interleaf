import { useMemo, type ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { ScrollArea } from '../../components/ui/scroll-area';
import { AgentActivityHeader } from './AgentActivityHeader';
import { AgentActivityList } from './AgentActivityList';
import { AgentFailureCard } from './AgentFailureCard';
import { AgentResultCard } from './AgentResultCard';
import { AgentResumeComposer } from './AgentResumeComposer';
import { AgentReviewCard } from './AgentReviewCard';
import { AgentRunHeader } from './AgentRunHeader';
import { AgentTaskSummary } from './AgentTaskSummary';
import { normalizeAgentEvents, type NormalizedAgentActivity } from './agent-activity';
import { agentFailureSummary } from './agent-failure-summary';
import { markReportShownAbove } from './agent-follow-ups';
import { environmentActionsReady, isSessionActive } from '../../stores/agent-discard-origin';
import { useActivityFilter } from './use-activity-filter';
import { usePinnedScroll } from './use-pinned-scroll';

/**
 * Reference 6b. One run header states the run's state once, the task is
 * summarised above the feed, and the typed activity timeline is the only
 * scrolling region so the pinned resume composer never moves.
 */
export function AgentSessionView({ session }: { readonly session: AgentSessionDetail }): ReactElement {
  const profiles = useAgentStore((state) => state.profiles);
  const sessions = useAgentStore((state) => state.sessions);
  const events = useAgentStore((state) => state.events);
  const loading = useAgentStore((state) => state.loading);
  const stopping = useAgentStore((state) => state.stopping);

  const activities = useMemo(() => normalizeAgentEvents(events), [events]);
  const filter = useActivityFilter(session.id, activities);
  const viewportRef = usePinnedScroll(session.id, activities.length);

  const profileName = (profileId: string): string =>
    profiles.find((profile) => profile.id === profileId)?.name ?? profileId;
  const sessionProfile = profiles.find((profile) => profile.id === session.profileId) ?? null;
  const active = isSessionActive(session, events);
  const actionsReady = environmentActionsReady(session, active);
  const environment = session.environment;

  return (
    <section aria-labelledby="agent-active-session-heading" className="agent-session-view flex h-full min-h-0 flex-1 flex-col">
      <AgentRunHeader
        session={session}
        profileName={profileName(session.profileId)}
        sessions={sessions}
        resolveProfileName={profileName}
        // Stoppability is a property of this session's own lifecycle. The
        // global `loading` flag also covers a resume request against a
        // finished session, and main refuses to stop a terminal run, so using
        // it here would offer a Stop that could only no-op.
        canStop={active && !stopping}
        stopping={stopping}
        onBack={() => { useAgentStore.getState().deselectSession(); }}
        onStop={() => { void useAgentStore.getState().stop(); }}
        onSelectSession={(sessionId) => { void useAgentStore.getState().selectSession(sessionId); }}
      />

      {/* Run details may shrink and scroll on a short pane (to a minimum that
        * keeps its toggle in view), while the Result card and the feed keep
        * their height, so a long task cannot push the result out of view. */}
      <AgentTaskSummary session={session} />
      <SessionError />

      {/* Output first: the result sits above the feed, outside the scroller
        * that pins to the newest activity, so it is in view when the run ends.
        * The report is shown once, here; a long one scrolls inside the card.
        * The result card and follow-up composer are keyed by the run, so a copy
        * status or follow-up draft never carries over to another session. */}
      <FailedRunCard session={session} activities={activities} />
      {session.finalReport !== null && (
        <div className="shrink-0 px-4">
          <AgentResultCard key={session.id} session={session} report={session.finalReport} actionsReady={actionsReady} />
        </div>
      )}

      <AgentActivityHeader
        category={filter.category}
        matchCount={filter.matchCount}
        totalCount={filter.totalCount}
        onCategoryChange={filter.setCategory}
      />

      <ScrollArea data-testid="agent-activity-scroll" viewportRef={viewportRef} className="agent-activity-feed flex flex-col gap-2 px-4 pt-2 pb-4">
        <AgentActivityList
          entries={markReportShownAbove(filter.entries, session.finalReport)}
          emptyMessage={filter.emptyMessage}
          active={active}
        />
        {environment !== null && (
          <AgentReviewCard session={session} environment={environment} actionsReady={actionsReady} active={active} />
        )}
      </ScrollArea>

      {actionsReady && sessionProfile?.capabilities.sessionResume === true && (
        <AgentResumeComposer
          key={session.id}
          session={session}
          blockedReason={resumeBlockedReason(session)}
          busy={loading || active}
        />
      )}
    </section>
  );
}

/**
 * Why the last action on this run — stop, copy, apply, export, open, discard
 * or refresh — failed. The store only keeps an error that belongs to the open
 * session, so this never shows another run's failure.
 */
function SessionError(): ReactElement | null {
  const error = useAgentStore((state) => state.error);
  if (error === null) return null;
  return (
    <div className="shrink-0 px-4 pt-2">
      <p role="alert" data-testid="agent-session-error" className="text-xs text-danger">{error}</p>
    </div>
  );
}

/** A failed run states what went wrong and what to do next, above the feed. */
function FailedRunCard({ session, activities }: {
  readonly session: AgentSessionDetail;
  readonly activities: readonly NormalizedAgentActivity[];
}): ReactElement | null {
  if (session.status !== 'failed') return null;
  return (
    <div className="shrink-0 px-4">
      <AgentFailureCard session={session} summary={agentFailureSummary(activities)} />
    </div>
  );
}

/**
 * Once an environment has been applied or discarded there is nothing left to
 * resume into, so the composer states that instead of offering an action that
 * main would reject.
 */
function resumeBlockedReason(session: AgentSessionDetail): string | null {
  if (session.environmentState === 'applied' || session.environment?.applied === true) {
    return 'Resume is unavailable because this environment was already applied. Start a new session to continue.';
  }
  if (session.environmentState === 'discarded') {
    return 'Resume is unavailable because this environment was discarded. Start a new session to continue.';
  }
  return null;
}
