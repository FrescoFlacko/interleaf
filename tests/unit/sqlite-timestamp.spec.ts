import { describe, expect, it } from 'vitest';
import { normalizeSqliteTimestamp } from '@main/db/sqlite-timestamp';

describe('normalizeSqliteTimestamp', () => {
  it("presents SQLite's datetime('now', 'utc') text as ISO-8601 UTC", () => {
    expect(normalizeSqliteTimestamp('2026-10-30 02:23:02')).toBe('2026-10-30T02:23:02.000Z');
  });

  it.each([
    ['an ISO timestamp', '2026-10-30T02:23:02.000Z'],
    ['fractional SQLite text', '2026-10-30 02:23:02.123'],
    ['a date alone', '2026-10-30'],
    ['an empty string', ''],
  ])('passes %s through unchanged', (_description, value) => {
    expect(normalizeSqliteTimestamp(value)).toBe(value);
  });
});
