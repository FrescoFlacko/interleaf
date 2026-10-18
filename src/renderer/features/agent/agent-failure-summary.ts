import type { NormalizedAgentActivity } from './agent-activity';
import { truncateForDisplay } from './agent-format';

/** Longest single line of agent output the failure card repeats. */
const MAX_FAILURE_LINE = 200;

export type AgentFailureSummary = {
  /** One sentence saying what failed, from the run's own error or exit. */
  readonly reason: string;
  readonly exitCode: number | null;
  /** The last non-empty stderr line, bounded; null when it would repeat `reason`. */
  readonly lastStderr: string | null;
};

/**
 * Summarises the newest run of a failed session from its normalized activity.
 * Only the activity after the last `started` marker counts, so a resumed run
 * that failed is not described with an earlier run's error. Everything here is
 * agent or subprocess output: it is bounded and rendered as plain text.
 */
export function agentFailureSummary(activities: readonly NormalizedAgentActivity[]): AgentFailureSummary {
  let start = 0;
  activities.forEach((activity, index) => {
    if (activity.kind === 'lifecycle' && activity.eventType === 'started') start = index;
  });
  const run = activities.slice(start);

  let errorMessage: string | null = null;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let stderr: string | null = null;
  for (const activity of run) {
    if (activity.kind === 'error') errorMessage = activity.message;
    if (activity.kind === 'lifecycle' && activity.eventType === 'ended') {
      exitCode = activity.exitCode ?? null;
      signal = activity.signal ?? null;
    }
    if (activity.kind === 'log' && activity.stream === 'stderr') {
      stderr = lastLine(activity.text) ?? stderr;
    }
  }

  const reason = errorMessage !== null
    ? truncateForDisplay(errorMessage.trim(), MAX_FAILURE_LINE)
    : exitCode !== null && exitCode !== 0
      ? `The agent exited with code ${String(exitCode)}.`
      : signal !== null
        ? `The agent was stopped by ${signal}.`
        : 'The agent stopped before it finished.';
  const lastStderr = stderr === null ? null : truncateForDisplay(stderr, MAX_FAILURE_LINE);
  return { reason, exitCode, lastStderr: lastStderr === reason ? null : lastStderr };
}

function lastLine(text: string): string | null {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}
