/** Appended migration; integration must renumber alongside other unshipped work units. */
export const PRACTICE_STATEMENTS: readonly string[] = [
  `CREATE TABLE practice_cards (
    id TEXT PRIMARY KEY, question TEXT NOT NULL, source_json TEXT NOT NULL,
    evidence TEXT NOT NULL, source_label TEXT NOT NULL,
    due_at TEXT NOT NULL, interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_practice_due ON practice_cards(due_at, id)`,
];
