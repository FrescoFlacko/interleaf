/**
 * Reader Chat reasoning effort (v28; docs/DATABASE.md §2).
 *
 * `reasoning_effort` is the level the reader asked a conversation's model to
 * reason at. `NULL` means no level was chosen and the model decides, so every
 * pre-existing row keeps exactly the behaviour it had. The CHECK admits the
 * shared vocabulary only (`src/shared/constants/reasoning.ts`); whether a
 * stored level is still valid for the bound model is decided by main at send
 * time, never by this column.
 *
 * The statement text is a checksum input and must never change.
 */
export const CHAT_REASONING_EFFORT_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT
     CHECK (reasoning_effort IS NULL OR reasoning_effort IN
       ('off', 'none', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))`,
];
