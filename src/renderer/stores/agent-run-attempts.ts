import type { AgentSession } from '@shared/types/agent';

// Bumped for a session each time it is resumed. An action's detail read from
// an earlier run of it must not replace the live one or its list entry.
const runAttempts = new Map<string, number>();

/** Which run of a session is the current one; it changes the moment a resume begins. */
export function runAttemptOf(sessionId: string): number {
  return runAttempts.get(sessionId) ?? 0;
}

export function beginRunAttempt(sessionId: string): void {
  runAttempts.set(sessionId, runAttemptOf(sessionId) + 1);
}

/** The session as it is once main has discarded its environment. */
export function withDiscarded<T extends AgentSession>(session: T, sessionId: string): T {
  return session.id === sessionId ? { ...session, environment: null, environmentState: 'discarded' } : session;
}
