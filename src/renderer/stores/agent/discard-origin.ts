import type { AgentEvent, AgentSessionDetail } from '@shared/types/agent';
import { runAttemptOf } from './run-attempts';

function latestEventOrdinal(events: readonly AgentEvent[], type: AgentEvent['type']): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== type || (latest !== undefined && event.ordinal <= latest)) continue;
    latest = event.ordinal;
  }
  return latest;
}

/**
 * A session stays "active" between the cancel request and the process actually
 * ending, so Stop keeps working and the run header does not claim the run is
 * over while the subprocess is still being torn down.
 */
function cancellationIsPending(events: readonly AgentEvent[]): boolean {
  const latestCancelled = latestEventOrdinal(events, 'cancelled');
  if (latestCancelled === undefined) return false;
  const latestEnded = latestEventOrdinal(events, 'ended');
  return latestEnded === undefined || latestCancelled > latestEnded;
}

export function isSessionActive(session: AgentSessionDetail | null, events: readonly AgentEvent[]): boolean {
  if (session === null) return false;
  if (session.status === 'running' || session.status === 'queued' || session.status === 'waiting') return true;
  return session.status === 'cancelled' && cancellationIsPending(events);
}

/** Sandbox actions only apply once the run has actually stopped. */
export function environmentActionsReady(session: AgentSessionDetail, active: boolean): boolean {
  return !active && ['completed', 'failed', 'cancelled', 'interrupted'].includes(session.status);
}

/** The panel state a discard is judged against: the open book, its open run and that run's events. */
type DiscardScope = {
  readonly documentId: string | null;
  readonly activeSession: AgentSessionDetail | null;
  readonly events: readonly AgentEvent[];
};

/** A run whose environment the reader confirmed discarding, frozen as it was then. */
export type AgentDiscardOrigin = {
  readonly sessionId: string;
  readonly documentId: string;
  readonly attempt: number;
  /** Exactly what was under review: workspace, mode, diff and changed files. */
  readonly review: string;
};

/** The exact review a discard would remove, or null while the run has nothing discardable. */
function discardableReview(session: AgentSessionDetail, events: readonly AgentEvent[]): string | null {
  const environment = session.environment;
  if (environment === null || session.environmentState === 'discarded') return null;
  if (!environmentActionsReady(session, isSessionActive(session, events))) return null;
  return JSON.stringify([
    session.documentId, session.targetDirectory.handle, session.executionMode, environment.sessionId, environment.mode,
    environment.workspaceLabel, environment.diffAvailable, environment.diff, environment.changedFiles,
  ]);
}

/** The origin to confirm a discard of the open run against, or null if it cannot be discarded now. */
export function discardOriginOf(scope: DiscardScope): AgentDiscardOrigin | null {
  const session = scope.activeSession;
  if (session === null) return null;
  if (session.documentId !== scope.documentId) return null;
  const review = discardableReview(session, scope.events);
  return review === null ? null : { sessionId: session.id, documentId: session.documentId, attempt: runAttemptOf(session.id), review };
}

/** Whether the panel still shows the run, on the book and in the attempt, the origin was taken from. */
export function discardRunShown(origin: AgentDiscardOrigin, scope: DiscardScope): boolean {
  return scope.activeSession?.id === origin.sessionId && scope.documentId === origin.documentId
    && runAttemptOf(origin.sessionId) === origin.attempt;
}

/**
 * Whether a confirmed discard may still go ahead: the same run, book and
 * attempt, still stopped, with the exact review that was confirmed. Anything
 * else — a changed diff or workspace, a run that started again, an
 * environment already gone — is a different discard and is refused.
 */
export function discardOriginHolds(origin: AgentDiscardOrigin, scope: DiscardScope): boolean {
  const session = scope.activeSession;
  return session !== null && discardRunShown(origin, scope) && discardableReview(session, scope.events) === origin.review;
}
