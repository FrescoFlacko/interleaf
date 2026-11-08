export const EXTERNAL_HIGHLIGHT_STATEMENTS: readonly string[] = [
  `CREATE TABLE external_highlights (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL CHECK (provider IN ('kindle', 'readwise')),
    title TEXT NOT NULL,
    author TEXT,
    quote TEXT NOT NULL,
    note TEXT,
    source_location TEXT,
    source_date TEXT,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    verified_annotation_id TEXT REFERENCES annotations(id) ON DELETE SET NULL,
    verified_chunk_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,
  `CREATE INDEX idx_external_highlights_document ON external_highlights(document_id, id)`,
];
