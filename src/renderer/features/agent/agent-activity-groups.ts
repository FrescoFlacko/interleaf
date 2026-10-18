import type { NormalizedAgentActivity } from './agent-activity';

export type AgentActivityError = Extract<NormalizedAgentActivity, { kind: 'error' }>;

/**
 * One row of the 6b timeline: either a single normalized activity, or a run of
 * repeated equivalent errors folded into one collapsed group with a count.
 */
export type AgentActivityEntry =
  | { readonly kind: 'single'; readonly id: string; readonly activity: NormalizedAgentActivity }
  | {
      readonly kind: 'error_group';
      readonly id: string;
      /** Shared, already-bounded message the grouped errors have in common. */
      readonly message: string;
      readonly code: string | null;
      readonly errors: readonly AgentActivityError[];
    };

/** Smallest run of equivalent errors that is worth folding away. */
const MIN_GROUP_SIZE = 2;

/**
 * A leading ISO-8601 timestamp, optionally bracketed, as CLIs prefix to each
 * emitted line. Two otherwise identical failures logged a second apart are the
 * same failure, so this prefix is the only part of the message the signature
 * discards.
 */
const LEADING_TIMESTAMP =
  /^[[(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?[\])]?\s*[-:|]?\s*/u;

/**
 * Equivalence key for two errors reporting the same failure. Only a leading
 * timestamp and runs of whitespace are normalized away: every digit in the
 * message body is significant — `HTTP 401` and `HTTP 503`, two exit codes, two
 * byte offsets and two paths ending in different numbers are different
 * failures, and folding them into one row would hide the difference. The text
 * shown to the reader is always one of the real messages, never this key.
 */
function errorSignature(error: AgentActivityError): string {
  const message = error.message
    .replace(LEADING_TIMESTAMP, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  return `${error.code ?? ''}|${message}`;
}

/**
 * Folds each run of consecutive equivalent errors into a single group. Only
 * consecutive errors are folded, so the timeline's ordering is never rewritten
 * and no unrelated event is hidden inside a group.
 */
export function groupRepeatedErrors(
  activities: readonly NormalizedAgentActivity[]
): readonly AgentActivityEntry[] {
  const entries: AgentActivityEntry[] = [];
  let run: AgentActivityError[] = [];
  let signature: string | null = null;

  const flush = (): void => {
    const first = run[0];
    if (first === undefined) return;
    entries.push(
      run.length < MIN_GROUP_SIZE
        ? { kind: 'single', id: first.id, activity: first }
        : { kind: 'error_group', id: `group-${first.id}`, message: first.message, code: first.code ?? null, errors: run }
    );
    run = [];
    signature = null;
  };

  for (const activity of activities) {
    if (activity.kind !== 'error') {
      flush();
      entries.push({ kind: 'single', id: activity.id, activity });
      continue;
    }
    const next = errorSignature(activity);
    if (signature !== null && signature !== next) flush();
    signature = next;
    run.push(activity);
  }
  flush();

  return entries;
}
