// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  relativeUpdatedAt,
  sessionMetaLine,
} from '../../src/renderer/features/chat/session-labels';

const NOW = new Date('2026-09-05T12:00:00.000Z');

/** Local-time instant `offsetMs` before `NOW`, as a stored ISO timestamp. */
function ago(offsetMs: number): string {
  return new Date(NOW.getTime() - offsetMs).toISOString();
}

describe('conversation card labels', () => {
  it('describes recent updates in the reference vocabulary', () => {
    expect(relativeUpdatedAt(ago(20_000), NOW)).toBe('JUST NOW');
    expect(relativeUpdatedAt(ago(5 * 60_000), NOW)).toBe('5M AGO');
    expect(relativeUpdatedAt(ago(2 * 3_600_000), NOW)).toBe('2H AGO');
  });

  it('uses calendar days rather than elapsed hours for older updates', () => {
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const threeDaysAgo = new Date(NOW);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const lastMonth = new Date(NOW);
    lastMonth.setDate(lastMonth.getDate() - 40);

    expect(relativeUpdatedAt(yesterday.toISOString(), NOW)).toBe('YESTERDAY');
    expect(relativeUpdatedAt(threeDaysAgo.toISOString(), NOW)).toBe('3D AGO');
    expect(relativeUpdatedAt(lastMonth.toISOString(), NOW)).toBe(lastMonth.toISOString().slice(0, 10));
  });

  it('omits the age segment when the stored timestamp cannot be read', () => {
    expect(relativeUpdatedAt('not-a-timestamp', NOW)).toBeNull();
    expect(
      sessionMetaLine({
        messageCount: 3,
        updatedAt: 'not-a-timestamp',
        isArchived: false,
        providerReady: true,
        now: NOW,
      })
    ).toBe('3 MSG');
  });

  it('carries the real count, age, archived and provider facts on one line', () => {
    expect(
      sessionMetaLine({
        messageCount: 6,
        updatedAt: ago(2 * 3_600_000),
        isArchived: false,
        providerReady: true,
        now: NOW,
      })
    ).toBe('6 MSG · 2H AGO');

    expect(
      sessionMetaLine({
        messageCount: 0,
        updatedAt: ago(30_000),
        isArchived: true,
        providerReady: false,
        now: NOW,
      })
    ).toBe('0 MSG · JUST NOW · ARCHIVED · PROVIDER UNAVAILABLE');
  });
});
