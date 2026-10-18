import type { AgentSessionStatus } from '@shared/types/agent';
import { AGENT_MAX_PROMPT_LENGTH } from '@shared/schemas/agent';

/** Says so before submit when a task or follow-up is longer than main accepts. */
export function promptLengthProblem(prompt: string): string | null {
  const length = prompt.trim().length;
  if (length <= AGENT_MAX_PROMPT_LENGTH) return null;
  return `Shorten the prompt to ${AGENT_MAX_PROMPT_LENGTH.toLocaleString('en-US')} characters or fewer (currently ${length.toLocaleString('en-US')}).`;
}

/** Longest run of untrusted text this panel will paint in one place. */
const MAX_REVIEW_TEXT = 320;

/**
 * Bounds untrusted text before it is rendered. Everything the agent, its
 * subprocesses or the reviewed workspace produce reaches the DOM as plain text
 * through React, never as markup.
 */
export function truncateForDisplay(value: string, limit = MAX_REVIEW_TEXT): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

/** Short badge label; the reference's run header shows one word. */
export function sessionStatusLabel(status: AgentSessionStatus): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

/** Full sentence used by the panel's polite live region. */
export function sessionStatusSentence(status: AgentSessionStatus): string {
  return `Session ${status}.`;
}

export type SessionStatusTone = 'accent' | 'success' | 'danger' | 'neutral';

export function sessionStatusTone(status: AgentSessionStatus): SessionStatusTone {
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting':
      return 'accent';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'cancelled':
    case 'interrupted':
      return 'neutral';
  }
}

/**
 * Reference run header runtime, `4M 12S`. Derived from the session's own
 * `createdAt` / `updatedAt` timestamps, so no new IPC surface is needed.
 * Returns null when either timestamp is unusable or the span is negative,
 * rather than displaying a fabricated duration.
 */
export function formatRuntime(createdAt: string, updatedAt: string): string | null {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}
