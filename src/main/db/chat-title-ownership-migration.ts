/**
 * Reader Chat title ownership (v27; docs/DATABASE.md §2).
 *
 * `title_state` records who owns a conversation's title, so automatic naming
 * never has to guess from the text: a reader may well have typed
 * "Conversation 1" themselves.
 *
 * - `default`: the generated "Conversation N" placeholder, still eligible for
 *   one automatic title.
 * - `generating`: one automatic naming call holds the claim in
 *   `title_claim_id`; only that claim may commit.
 * - `generated`: an automatic title was committed.
 * - `manual`: the reader (or an explicit create) chose the title.
 * - `failed`: the one automatic attempt ended without a title, or was
 *   interrupted by a restart; it is never retried.
 *
 * Every pre-existing row becomes `manual`: it was never claimed, and its title
 * is kept exactly as it is. Both columns are main-only and never projected to
 * the renderer.
 *
 * The statement text is a checksum input and must never change.
 */
export const CHAT_TITLE_OWNERSHIP_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_sessions ADD COLUMN title_state TEXT NOT NULL DEFAULT 'manual'
     CHECK (title_state IN ('default', 'generating', 'generated', 'manual', 'failed'))`,
  `ALTER TABLE chat_sessions ADD COLUMN title_claim_id TEXT`,
];
