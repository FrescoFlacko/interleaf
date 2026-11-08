import { describe, expect, it } from 'vitest';
import { nextSchedule } from '@main/practice/schedule';

describe('practice scheduling', () => {
  it('gives each self-rating a deterministic interval and records lapses', () => {
    const initial = { intervalDays: 0, repetitions: 0, lapses: 0 };
    expect(nextSchedule(initial, 'again')).toEqual({ intervalDays: 1, repetitions: 0, lapses: 1 });
    expect(nextSchedule(initial, 'hard').intervalDays).toBe(1);
    expect(nextSchedule(initial, 'good').intervalDays).toBe(2);
    expect(nextSchedule(initial, 'easy').intervalDays).toBe(4);
    expect(nextSchedule({ intervalDays: 4, repetitions: 1, lapses: 2 }, 'again')).toEqual({ intervalDays: 1, repetitions: 0, lapses: 3 });
    expect(nextSchedule({ intervalDays: 2000, repetitions: 5, lapses: 0 }, 'easy').intervalDays).toBe(3650);
  });
});
