/**
 * SQLite's `datetime('now', 'utc')` writes `YYYY-MM-DD HH:MM:SS` with no zone
 * or fraction. Rows read back are presented as ISO-8601 UTC so every timestamp
 * crossing IPC has one shape; values already in another shape pass unchanged.
 */
export function normalizeSqliteTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return `${value.replace(' ', 'T')}.000Z`;
  return value;
}
