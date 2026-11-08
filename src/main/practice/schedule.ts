import type { PracticeRating } from '@shared/schemas/practice';

export type PracticeSchedule = { readonly intervalDays: number; readonly repetitions: number; readonly lapses: number };

/** Deliberately simple self-rated intervals; this does not assess an answer. */
export function nextSchedule(previous: PracticeSchedule, rating: PracticeRating): PracticeSchedule {
  if (rating === 'again') return { intervalDays: 1, repetitions: 0, lapses: previous.lapses + 1 };
  const base = Math.max(1, previous.intervalDays);
  const intervalDays = rating === 'hard' ? Math.max(1, Math.round(base * 1.2))
    : rating === 'good' ? (previous.repetitions === 0 ? 2 : Math.round(base * 2))
      : (previous.repetitions === 0 ? 4 : Math.round(base * 3));
  return { intervalDays: Math.min(3650, intervalDays), repetitions: previous.repetitions + 1, lapses: previous.lapses };
}
