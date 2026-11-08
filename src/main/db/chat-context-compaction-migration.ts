export const CHAT_CONTEXT_COMPACTION_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT`,
  `ALTER TABLE chat_sessions ADD COLUMN context_summary_updated_at TEXT`,
  `ALTER TABLE chat_sessions ADD COLUMN compacted_through_ordinal INTEGER`,
  `ALTER TABLE chat_message_sources ADD COLUMN attached_origin INTEGER NOT NULL DEFAULT 0`,
  // Sources already stored against a surviving context item were attached ones.
  // A source whose item was consumed by the old one-turn rule cannot be
  // recovered here, and is left replayable exactly as it is today.
  `UPDATE chat_message_sources SET attached_origin = 1 WHERE context_item_id IS NOT NULL`,
];
