/** Additive storage for agent proposals and prospective reading history. */
export const AGENT_ACCESS_STATEMENTS: readonly string[] = [
  `CREATE TABLE reading_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    document_hash TEXT NOT NULL,
    location_json TEXT NOT NULL,
    progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),
    recorded_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_reading_history_document ON reading_history(document_id, id DESC)`,
  `CREATE TRIGGER record_reading_history_insert AFTER INSERT ON reading_positions BEGIN
    INSERT INTO reading_history (document_id, document_hash, location_json, progress, recorded_at)
    SELECT NEW.document_id, file_hash, NEW.location_json, NEW.progress, NEW.updated_at
      FROM documents WHERE id = NEW.document_id;
    DELETE FROM reading_history WHERE id <= (SELECT id FROM reading_history ORDER BY id DESC LIMIT 1 OFFSET 10000);
  END`,
  `CREATE TRIGGER record_reading_history_update AFTER UPDATE ON reading_positions BEGIN
    INSERT INTO reading_history (document_id, document_hash, location_json, progress, recorded_at)
    SELECT NEW.document_id, file_hash, NEW.location_json, NEW.progress, NEW.updated_at
      FROM documents WHERE id = NEW.document_id;
    DELETE FROM reading_history WHERE id <= (SELECT id FROM reading_history ORDER BY id DESC LIMIT 1 OFFSET 10000);
  END`,
  `CREATE TABLE agent_proposals (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    document_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('annotation', 'primer', 'question', 'checkpoint', 'conflict', 'card')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    result_id TEXT
  )`,
  `CREATE INDEX idx_agent_proposals_status ON agent_proposals(status, created_at, id)`,
];
