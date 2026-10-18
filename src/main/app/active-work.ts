import type { ActiveWorkSummary } from '@shared/schemas/updates';

/**
 * What an update restart would interrupt, counted by the services that own it.
 *
 * Every count is read synchronously from live service state rather than from
 * durable status rows, so work that has no row yet — a chat preparation or
 * compaction, the chat of a file opened without import, a pending open, an
 * accepted agent operation, or a run whose process group is still being
 * reaped — is counted too. Closing admission refuses new work in every
 * service at once while admitted work, and renderer flushes such as reading
 * position writes, carry on.
 */

type WorkCounter = () => number;

export type ActiveWorkSources = {
  readonly agentSessions: readonly WorkCounter[];
  readonly chatStreams: readonly WorkCounter[];
  readonly imports: readonly WorkCounter[];
  readonly closeAdmission: readonly (() => void)[];
};

export type ActiveWork = {
  readonly probe: () => ActiveWorkSummary;
  readonly closeAdmission: () => void;
};

const sum = (counters: readonly WorkCounter[]): number => counters.reduce((total, count) => total + count(), 0);

export function createActiveWork(sources: ActiveWorkSources): ActiveWork {
  return {
    probe: () => ({
      agentSessions: sum(sources.agentSessions),
      chatStreams: sum(sources.chatStreams),
      imports: sum(sources.imports),
    }),
    closeAdmission: () => { for (const close of sources.closeAdmission) close(); },
  };
}

export function hasActiveWork(summary: ActiveWorkSummary): boolean {
  return summary.agentSessions + summary.chatStreams + summary.imports > 0;
}
