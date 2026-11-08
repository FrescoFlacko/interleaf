export const LEARNING_STATEMENTS: readonly string[] = [
  `CREATE TABLE learning_items (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    proposal_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('active', 'dismissed', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_learning_document ON learning_items(document_id, status, created_at, id)`,
];
