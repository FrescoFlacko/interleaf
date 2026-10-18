/**
 * Pure label helpers for the conversation cards. Every value here is derived
 * from a stored session field; nothing is synthesized when data is absent.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;

/** Whole calendar days between two instants in local time (0 = same day). */
function calendarDaysApart(now: Date, then: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const other = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  return Math.round((today - other) / DAY_MS);
}

function elapsedWithinDay(elapsedMs: number, daysApart: number): string {
  if (elapsedMs < MINUTE_MS) return 'JUST NOW';
  if (elapsedMs < HOUR_MS) return `${String(Math.floor(elapsedMs / MINUTE_MS))}M AGO`;
  return daysApart === 0 ? `${String(Math.floor(elapsedMs / HOUR_MS))}H AGO` : 'YESTERDAY';
}

/**
 * Uppercase relative age of a stored timestamp, in the reference's
 * `2H AGO` / `YESTERDAY` vocabulary. Older entries fall back to the stored
 * calendar date. An unparseable timestamp yields `null` so the caller omits
 * the segment rather than printing a placeholder.
 */
export function relativeUpdatedAt(isoTimestamp: string, now: Date): string | null {
  const updated = new Date(isoTimestamp);
  if (Number.isNaN(updated.getTime())) return null;
  const elapsedMs = now.getTime() - updated.getTime();
  const daysApart = calendarDaysApart(now, updated);
  if (daysApart <= 1) return elapsedWithinDay(elapsedMs, daysApart);
  if (daysApart < WEEK_DAYS) return `${String(daysApart)}D AGO`;
  return isoTimestamp.slice(0, 10);
}

/**
 * Card metadata line: real message count and update time, plus the archived and
 * provider-unavailable facts that used to live in a separate panel.
 */
export function sessionMetaLine(input: {
  readonly messageCount: number;
  readonly updatedAt: string;
  readonly isArchived: boolean;
  /** `null` while provider discovery is still running: unknown, not unavailable. */
  readonly providerReady: boolean | null;
  readonly now: Date;
}): string {
  const parts = [`${String(input.messageCount)} MSG`];
  const relative = relativeUpdatedAt(input.updatedAt, input.now);
  if (relative !== null) parts.push(relative);
  if (input.isArchived) parts.push('ARCHIVED');
  if (input.providerReady === false) parts.push('PROVIDER UNAVAILABLE');
  return parts.join(' · ');
}
