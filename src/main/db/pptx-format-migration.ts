import { DOCUMENT_WEB_SOURCE_STATEMENTS } from './document-web-source-migration';

/**
 * Widens the `documents.format` CHECK to admit `pptx` (docs/DATABASE.md §2).
 *
 * SQLite cannot alter a CHECK in place, so the table is rebuilt with foreign
 * keys disabled, exactly as the markdown migration did. Every column added since
 * then (web source provenance) is copied by name, and the indexes and source
 * coherence triggers dropped with the old table are recreated from the same
 * statements v21 used.
 */
export const PPTX_DOCUMENT_FORMAT_STATEMENTS: readonly string[] = [
  `CREATE TABLE documents_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL CHECK (format IN ('pdf', 'epub', 'mobi', 'docx', 'markdown', 'pptx')),
    file_path TEXT NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('managed', 'link')),
    file_size INTEGER NOT NULL,
    file_mtime_ms INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    page_count INTEGER,
    cover_path TEXT,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    source_kind TEXT CHECK(source_kind IS NULL OR source_kind IN ('web')),
    source_url TEXT,
    source_site_name TEXT,
    source_captured_at TEXT
  )`,
  `INSERT INTO documents_new (id, title, author, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash, page_count, cover_path, folder_id, created_at, updated_at, source_kind, source_url, source_site_name, source_captured_at)
   SELECT id, title, author, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash, page_count, cover_path, folder_id, created_at, updated_at, source_kind, source_url, source_site_name, source_captured_at FROM documents`,
  `DROP TABLE documents`,
  `ALTER TABLE documents_new RENAME TO documents`,
  `CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_hash ON documents(file_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_format ON documents(format)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title COLLATE NOCASE)`,
  // The source_kind index and both coherence triggers, as v21 created them.
  ...DOCUMENT_WEB_SOURCE_STATEMENTS.slice(4),
];
