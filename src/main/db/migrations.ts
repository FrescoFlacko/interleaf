import { createHash } from 'node:crypto';
import { describeError } from '@shared/models/caught-error';
import type { InterleafDatabase } from './database';
import { InterleafError } from '@shared/errors/interleaf-error';
import { DOCUMENT_WEB_SOURCE_STATEMENTS } from './document-web-source-migration';
import { PPTX_DOCUMENT_FORMAT_STATEMENTS } from './pptx-format-migration';
import { AGENT_SESSION_TARGET_AUTHORITY_STATEMENTS, FILE_IDENTITY_BIRTH_TIME_STATEMENTS } from './agent-identity-migrations';
import { CHAT_TITLE_OWNERSHIP_STATEMENTS } from './chat-title-ownership-migration';
import { CHAT_REASONING_EFFORT_STATEMENTS } from './chat-reasoning-effort-migration';
/**
 * Forward-only schema migrations (docs/DATABASE.md §2), each run in BEGIN IMMEDIATE and
 * recorded in `schema_migrations` with a SHA-256 checksum that detects drift.
 *
 * The SQL identifiers `marginlab_document_dedup` and `marginlab_folder_name_key`
 * below keep their pre-rebrand spelling on purpose. Migration statement text is
 * the checksum input, so editing it would make every database created before the
 * Interleaf rename fail drift detection; `marginlab_folder_name_key` is also
 * baked into the `folders_name_key_*_guard` triggers persisted in `sqlite_master`
 * on those databases. `InterleafDatabase.open` therefore keeps registering that
 * exact function name (see src/main/db/database.ts).
 */

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  /** When true, foreign keys are disabled around the transaction (required for table rebuilds). */
  readonly disableForeignKeys?: boolean;
};

export function computeMigrationChecksum(migration: Migration): string {
  const normalizedSql = migration.statements
    .map((statement) => statement.trim().replace(/\r\n/g, '\n'))
    .join(';\n');
  const payload = `${String(migration.version)}:${migration.name}:\n${normalizedSql}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase();
}

const INITIAL_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL CHECK (format IN ('pdf', 'epub', 'mobi', 'docx')),
    file_path TEXT NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('managed', 'link')),
    file_size INTEGER NOT NULL,
    file_mtime_ms INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    page_count INTEGER,
    cover_path TEXT,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash)`,

  `CREATE TABLE IF NOT EXISTS reading_positions (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    location_json TEXT NOT NULL,
    progress REAL NOT NULL CHECK (progress >= 0.0 AND progress <= 1.0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_reading_positions_updated ON reading_positions(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('highlight', 'note', 'bookmark')),
    anchor_json TEXT NOT NULL,
    selected_text TEXT,
    note TEXT,
    label TEXT,
    color TEXT CHECK (color IN ('yellow', 'blue', 'green', 'pink', 'purple')),
    is_location_note INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'anchored' CHECK (status IN ('anchored', 'unanchored')),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(document_id, type)`,

  `CREATE TABLE IF NOT EXISTS document_text_chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    location_json TEXT NOT NULL,
    heading TEXT,
    page_label TEXT,
    UNIQUE(document_id, ordinal)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_text_chunks(document_id, ordinal)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
    document_id UNINDEXED,
    heading,
    text,
    content = 'document_text_chunks',
    content_rowid = 'rowid',
    tokenize = 'porter unicode61'
  )`,

  `CREATE TRIGGER IF NOT EXISTS document_chunks_ai AFTER INSERT ON document_text_chunks BEGIN
    INSERT INTO document_fts(rowid, document_id, heading, text)
    VALUES (new.rowid, new.document_id, new.heading, new.text);
  END`,

  `CREATE TRIGGER IF NOT EXISTS document_chunks_ad AFTER DELETE ON document_text_chunks BEGIN
    INSERT INTO document_fts(document_fts, rowid, document_id, heading, text)
    VALUES ('delete', old.rowid, old.document_id, old.heading, old.text);
  END`,

  `CREATE TRIGGER IF NOT EXISTS document_chunks_au AFTER UPDATE ON document_text_chunks BEGIN
    INSERT INTO document_fts(document_fts, rowid, document_id, heading, text)
    VALUES ('delete', old.rowid, old.document_id, old.heading, old.text);
    INSERT INTO document_fts(rowid, document_id, heading, text)
    VALUES (new.rowid, new.document_id, new.heading, new.text);
  END`,

  `CREATE TABLE IF NOT EXISTS document_index_state (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('not_indexed', 'indexing', 'ready', 'failed')),
    total_chunks INTEGER NOT NULL DEFAULT 0,
    indexed_chunks INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_doc ON chat_sessions(document_id)`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    ordinal INTEGER NOT NULL,
    content TEXT NOT NULL,
    citation_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    UNIQUE(session_id, ordinal)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at ASC)`,

  `CREATE TABLE IF NOT EXISTS chat_context_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('entire_document', 'location', 'range', 'selection', 'retrieved_chunk')),
    source_ref_json TEXT NOT NULL,
    excerpt_text TEXT NOT NULL,
    excerpt_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    anchor_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    display_label TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_context_session ON chat_context_items(session_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS allowed_working_directories (
    handle TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    last_validated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    binary_path TEXT NOT NULL,
    default_args_json TEXT NOT NULL,
    default_model TEXT,
    reasoning_effort TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'normal',
    default_sandbox_mode TEXT NOT NULL DEFAULT 'auto-isolated' CHECK (default_sandbox_mode IN ('auto-isolated', 'isolated-worktree', 'isolated-copy', 'container-sandbox')),
    default_directory_handle TEXT REFERENCES allowed_working_directories(handle) ON DELETE SET NULL,
    env_reference_json TEXT,
    is_custom INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    target_directory_handle TEXT NOT NULL REFERENCES allowed_working_directories(handle),
    canonical_target_path TEXT NOT NULL,
    isolated_workspace_path TEXT,
    sandbox_mode TEXT NOT NULL CHECK (sandbox_mode IN ('isolated-worktree', 'isolated-copy', 'native-restricted', 'container-sandbox', 'active-env')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted')),
    provider_session_id TEXT,
    user_prompt TEXT NOT NULL,
    context_summary TEXT,
    base_commit TEXT,
    baseline_fingerprint TEXT NOT NULL,
    final_report TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    UNIQUE(session_id, ordinal)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, ordinal ASC)`,

  `CREATE TABLE IF NOT EXISTS agent_artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('context_packet', 'diff', 'changed_files', 'test_result', 'log', 'patch', 'recovery_backup')),
    app_relative_path TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    expires_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_agent_artifacts_session ON agent_artifacts(session_id, kind)`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,
];

const SEED_DEFAULTS_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO settings (key, value_json) VALUES ('app', '{"version":1,"appearance":{"palette":"paper"},"agent":{"defaultExecutionMode":"auto-isolated"}}')`,
];

const LIBRARY_INDEXES_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)`,
];

const FOLDER_NAME_CONSTRAINTS_STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_root_name
   ON folders(lower(name)) WHERE parent_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_child_name
   ON folders(parent_id, lower(name)) WHERE parent_id IS NOT NULL`,
];

const UNIQUE_DOCUMENT_HASH_STATEMENTS: readonly string[] = [
  `CREATE TEMP TABLE marginlab_document_dedup AS
   SELECT d.id AS duplicate_id,
          (SELECT survivor.id
             FROM documents survivor
            WHERE survivor.file_hash = d.file_hash
            ORDER BY survivor.rowid DESC
            LIMIT 1) AS survivor_id
     FROM documents d
    WHERE d.rowid <> (SELECT MAX(candidate.rowid)
                        FROM documents candidate
                       WHERE candidate.file_hash = d.file_hash)`,

  // Preserve the newest reading position across every duplicate row.
  `INSERT OR REPLACE INTO reading_positions (document_id, location_json, progress, updated_at)
   SELECT mapping.survivor_id, position.location_json, position.progress, position.updated_at
     FROM marginlab_document_dedup mapping
     JOIN reading_positions position ON position.document_id = mapping.duplicate_id
    WHERE NOT EXISTS (
      SELECT 1 FROM reading_positions survivor_position
       WHERE survivor_position.document_id = mapping.survivor_id
         AND survivor_position.updated_at > position.updated_at
    )
    ORDER BY position.updated_at ASC`,

  // Identical documents may have identical chunk ordinals. Prefer an existing
  // survivor chunk, otherwise retain exactly one duplicate chunk per ordinal.
  `DELETE FROM document_text_chunks
    WHERE rowid IN (
      SELECT chunk.rowid
        FROM document_text_chunks chunk
        JOIN marginlab_document_dedup mapping ON mapping.duplicate_id = chunk.document_id
       WHERE EXISTS (
               SELECT 1 FROM document_text_chunks survivor_chunk
                WHERE survivor_chunk.document_id = mapping.survivor_id
                  AND survivor_chunk.ordinal = chunk.ordinal
             )
          OR EXISTS (
               SELECT 1
                 FROM document_text_chunks earlier_chunk
                 JOIN marginlab_document_dedup earlier_mapping
                   ON earlier_mapping.duplicate_id = earlier_chunk.document_id
                WHERE earlier_mapping.survivor_id = mapping.survivor_id
                  AND earlier_chunk.ordinal = chunk.ordinal
                  AND earlier_chunk.rowid < chunk.rowid
             )
    )`,
  `UPDATE document_text_chunks
      SET document_id = (SELECT survivor_id FROM marginlab_document_dedup
                          WHERE duplicate_id = document_text_chunks.document_id)
    WHERE document_id IN (SELECT duplicate_id FROM marginlab_document_dedup)`,

  // Index state is derived data; retain the most recently updated state.
  `INSERT OR REPLACE INTO document_index_state
     (document_id, status, total_chunks, indexed_chunks, error_message, updated_at)
   SELECT mapping.survivor_id, state.status, state.total_chunks,
          state.indexed_chunks, state.error_message, state.updated_at
     FROM marginlab_document_dedup mapping
     JOIN document_index_state state ON state.document_id = mapping.duplicate_id
    WHERE NOT EXISTS (
      SELECT 1 FROM document_index_state survivor_state
       WHERE survivor_state.document_id = mapping.survivor_id
         AND survivor_state.updated_at > state.updated_at
    )
    ORDER BY state.updated_at ASC`,

  `UPDATE annotations
      SET document_id = (SELECT survivor_id FROM marginlab_document_dedup
                          WHERE duplicate_id = annotations.document_id)
    WHERE document_id IN (SELECT duplicate_id FROM marginlab_document_dedup)`,
  `UPDATE chat_sessions
      SET document_id = (SELECT survivor_id FROM marginlab_document_dedup
                          WHERE duplicate_id = chat_sessions.document_id)
    WHERE document_id IN (SELECT duplicate_id FROM marginlab_document_dedup)`,
  `DELETE FROM documents WHERE id IN (SELECT duplicate_id FROM marginlab_document_dedup)`,
  `DROP TABLE marginlab_document_dedup`,
  `DROP INDEX IF EXISTS idx_documents_hash`,
  `CREATE UNIQUE INDEX idx_documents_unique_hash ON documents(file_hash)`,
];

const UNICODE_FOLDER_NAME_STATEMENTS: readonly string[] = [
  `DROP INDEX IF EXISTS idx_folders_unique_root_name`,
  `DROP INDEX IF EXISTS idx_folders_unique_child_name`,
  `ALTER TABLE folders ADD COLUMN name_key TEXT`,
  `UPDATE folders SET name_key = marginlab_folder_name_key(name)`,
  // v4 used SQLite's ASCII-only lower(). Preserve every legacy display name
  // while giving older Unicode-equivalent siblings an internal unique key.
  `UPDATE folders AS current
      SET name_key = current.name_key || char(31) || current.id
    WHERE EXISTS (
      SELECT 1 FROM folders newer
       WHERE newer.name_key = current.name_key
         AND ((newer.parent_id IS NULL AND current.parent_id IS NULL)
              OR newer.parent_id = current.parent_id)
         AND newer.rowid > current.rowid
    )`,
  `CREATE UNIQUE INDEX idx_folders_unique_root_name
     ON folders(name_key) WHERE parent_id IS NULL`,
  `CREATE UNIQUE INDEX idx_folders_unique_child_name
     ON folders(parent_id, name_key) WHERE parent_id IS NOT NULL`,
  `CREATE TRIGGER folders_name_key_insert_guard
     BEFORE INSERT ON folders
     WHEN NEW.name_key IS NULL OR NEW.name_key <> marginlab_folder_name_key(NEW.name)
     BEGIN
       SELECT RAISE(ABORT, 'folder name key mismatch');
     END`,
  `CREATE TRIGGER folders_name_key_update_guard
     BEFORE UPDATE OF name, name_key ON folders
     WHEN NEW.name_key IS NULL OR NEW.name_key <> marginlab_folder_name_key(NEW.name)
     BEGIN
       SELECT RAISE(ABORT, 'folder name key mismatch');
     END`,
];

const FULL_UNICODE_FOLDER_CASE_FOLD_STATEMENTS: readonly string[] = [
  `DROP INDEX IF EXISTS idx_folders_unique_root_name`,
  `DROP INDEX IF EXISTS idx_folders_unique_child_name`,
  `DROP TRIGGER IF EXISTS folders_name_key_insert_guard`,
  `DROP TRIGGER IF EXISTS folders_name_key_update_guard`,
  `UPDATE folders SET name_key = marginlab_folder_name_key(name)`,
  // v6 used a deliberately small set of fold exceptions. Re-key every row
  // with the pinned full Unicode table and preserve colliding display names.
  `UPDATE folders AS current
      SET name_key = current.name_key || char(31) || current.id
    WHERE EXISTS (
      SELECT 1 FROM folders newer
       WHERE newer.name_key = current.name_key
         AND ((newer.parent_id IS NULL AND current.parent_id IS NULL)
              OR newer.parent_id = current.parent_id)
         AND newer.rowid > current.rowid
    )`,
  `CREATE UNIQUE INDEX idx_folders_unique_root_name
     ON folders(name_key) WHERE parent_id IS NULL`,
  `CREATE UNIQUE INDEX idx_folders_unique_child_name
     ON folders(parent_id, name_key) WHERE parent_id IS NOT NULL`,
  `CREATE TRIGGER folders_name_key_insert_guard
     BEFORE INSERT ON folders
     WHEN NEW.name_key IS NULL OR NEW.name_key <> marginlab_folder_name_key(NEW.name)
     BEGIN
       SELECT RAISE(ABORT, 'folder name key mismatch');
     END`,
  `CREATE TRIGGER folders_name_key_update_guard
     BEFORE UPDATE OF name, name_key ON folders
     WHEN NEW.name_key IS NULL OR NEW.name_key <> marginlab_folder_name_key(NEW.name)
     BEGIN
       SELECT RAISE(ABORT, 'folder name key mismatch');
     END`,
];

const ANNOTATION_DOCUMENT_REVISION_STATEMENTS: readonly string[] = [
  `ALTER TABLE annotations ADD COLUMN document_hash TEXT NOT NULL DEFAULT ''`,
  `UPDATE annotations
      SET document_hash = (SELECT documents.file_hash
                             FROM documents
                            WHERE documents.id = annotations.document_id)`,
  `DROP INDEX IF EXISTS idx_annotations_doc`,
  `CREATE INDEX idx_annotations_doc_updated
     ON annotations(document_id, updated_at DESC, id)`,
];

const SEARCH_INDEX_REVISION_STATEMENTS: readonly string[] = [
  `ALTER TABLE document_index_state ADD COLUMN document_hash TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE document_index_state ADD COLUMN generation_id TEXT`,
  `ALTER TABLE document_index_state ADD COLUMN indexed_text_units INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE document_index_state ADD COLUMN published_document_hash TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE document_index_state ADD COLUMN published_total_chunks INTEGER NOT NULL DEFAULT 0`,
  `UPDATE document_index_state
      SET document_hash = (SELECT documents.file_hash
                             FROM documents
                            WHERE documents.id = document_index_state.document_id)`,
  `UPDATE document_index_state
      SET published_document_hash = document_hash,
          published_total_chunks = total_chunks
    WHERE status = 'ready'`,
  `UPDATE document_index_state
      SET status = 'failed', generation_id = NULL,
          error_message = 'Indexing was interrupted before completion.'
    WHERE status = 'indexing'`,
  `CREATE TABLE document_index_staging_chunks (
    generation_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    location_json TEXT NOT NULL,
    heading TEXT,
    page_label TEXT,
    PRIMARY KEY(generation_id, ordinal)
  )`,
  `CREATE INDEX idx_index_staging_document
     ON document_index_staging_chunks(document_id, generation_id, ordinal)`,
];

const SEARCH_LOCATION_ORDER_STATEMENTS: readonly string[] = [
  // Derived, main-owned reading-order keys keep FTS LIMIT application correct:
  // the database can order every match before applying the bounded result
  // limit. A negative value marks a legacy chunk; SearchRepository falls back
  // to its contiguous ordinal for those rows.
  `ALTER TABLE document_text_chunks ADD COLUMN location_order INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE document_text_chunks ADD COLUMN location_detail INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE document_text_chunks ADD COLUMN location_offset INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE document_index_staging_chunks ADD COLUMN location_order INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE document_index_staging_chunks ADD COLUMN location_detail INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE document_index_staging_chunks ADD COLUMN location_offset INTEGER NOT NULL DEFAULT -1`,
  `CREATE INDEX idx_chunks_doc_location_order
     ON document_text_chunks(document_id, location_order, location_detail, location_offset, ordinal, id)`,
];

const SEARCH_NATIVE_ANCHOR_FORMAT_STATEMENTS: readonly string[] = [
  // Search chunks are derivative data. v16 rows may be ready but lack the
  // native text offsets required for exact transient highlighting, so clear
  // only the derivative chunks/FTS and let the normal open-document indexer
  // rebuild them from the preserved source files.
  `DELETE FROM document_index_staging_chunks`,
  `DELETE FROM document_text_chunks`,
  `INSERT INTO document_fts(document_fts) VALUES ('rebuild')`,
  `UPDATE document_index_state
      SET status = 'not_indexed', total_chunks = 0, indexed_chunks = 0,
          indexed_text_units = 0, generation_id = NULL,
          published_document_hash = '', published_total_chunks = 0,
          error_message = 'Search index format upgrade requires a rebuild.'`,
];

const CHAT_REVISION_AND_STREAMING_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_sessions ADD COLUMN document_hash TEXT NOT NULL DEFAULT ''`,
  `UPDATE chat_sessions
      SET document_hash = (SELECT documents.file_hash
                             FROM documents
                            WHERE documents.id = chat_sessions.document_id)`,
  `DROP INDEX IF EXISTS idx_chat_doc`,
  `CREATE INDEX idx_chat_sessions_doc_updated
     ON chat_sessions(document_id, updated_at DESC, id)`,
  `ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
     CHECK (status IN ('complete', 'streaming', 'cancelled', 'failed'))`,
  `ALTER TABLE chat_messages ADD COLUMN request_id TEXT`,
  `ALTER TABLE chat_messages ADD COLUMN token_count INTEGER`,
  `ALTER TABLE chat_messages ADD COLUMN error_message TEXT`,
  `CREATE UNIQUE INDEX idx_chat_messages_request
     ON chat_messages(request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX idx_chat_messages_session_ordinal
     ON chat_messages(session_id, ordinal ASC)`,
  `DROP INDEX IF EXISTS idx_chat_context_session`,
  `CREATE INDEX idx_chat_context_session_pinned
     ON chat_context_items(session_id, pinned DESC, created_at ASC, id)`,
  `CREATE TABLE chat_message_sources (
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    document_hash TEXT NOT NULL,
    chunk_id TEXT,
    context_item_id TEXT REFERENCES chat_context_items(id) ON DELETE SET NULL,
    location_json TEXT NOT NULL,
    excerpt_text TEXT NOT NULL,
    excerpt_hash TEXT NOT NULL,
    heading TEXT,
    page_label TEXT,
    display_label TEXT NOT NULL,
    PRIMARY KEY(message_id, source_id),
    UNIQUE(message_id, ordinal)
  )`,
  `CREATE INDEX idx_chat_sources_document
     ON chat_message_sources(document_id, document_hash, message_id)`,
  `UPDATE chat_messages
      SET status = 'failed', error_message = 'Generation was interrupted before completion.'
    WHERE status = 'streaming'`,
];

const CUSTOM_AGENT_PROFILE_STORAGE_STATEMENTS: readonly string[] = [
  // Custom profile configuration is versioned in JSON (config.version) while
  // these additive columns keep main-owned executable identity and config
  // attached to the existing profile row. This is a distinct forward-only
  // migration so already-applied chat migration checksums never change.
  `ALTER TABLE agent_profiles ADD COLUMN custom_config_json TEXT`,
  `ALTER TABLE agent_profiles ADD COLUMN executable_identity_json TEXT`,
  `ALTER TABLE agent_profiles ADD COLUMN deleted_at TEXT`,
];

const AGENT_SESSION_EFFECTIVE_CONFIG_STATEMENTS: readonly string[] = [
  // Persist the exact effective model and reasoning effort chosen for each
  // newly started agent session so subsequent resumes faithfully preserve the
  // original session snapshot rather than a potentially edited profile default.
  `ALTER TABLE agent_sessions ADD COLUMN effective_model TEXT`,
  `ALTER TABLE agent_sessions ADD COLUMN effective_reasoning_effort TEXT`,
];

const AGENT_SESSION_ENVIRONMENT_LIFECYCLE_STATEMENTS: readonly string[] = [
  // Persist whether the prepared environment is still resumable. Applied and
  // discarded environments must fail closed on resume, including after restart.
  `ALTER TABLE agent_sessions ADD COLUMN environment_lifecycle TEXT
     CHECK (environment_lifecycle IN ('prepared', 'applied', 'discarded'))`,
];

const MARKDOWN_DOCUMENT_FORMAT_STATEMENTS: readonly string[] = [
  `CREATE TABLE documents_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL CHECK (format IN ('pdf', 'epub', 'mobi', 'docx', 'markdown')),
    file_path TEXT NOT NULL,
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('managed', 'link')),
    file_size INTEGER NOT NULL,
    file_mtime_ms INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    page_count INTEGER,
    cover_path TEXT,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`,
  `INSERT INTO documents_new SELECT id, title, author, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash, page_count, cover_path, folder_id, created_at, updated_at FROM documents`,
  `DROP TABLE documents`,
  `ALTER TABLE documents_new RENAME TO documents`,
  `CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_hash ON documents(file_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_format ON documents(format)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title COLLATE NOCASE)`,
];
const CLEANUP_DATA_URL_COVER_PATHS_STATEMENTS: readonly string[] = [
  `UPDATE documents SET cover_path = NULL WHERE cover_path LIKE 'data:%'`,
];
const CHAT_DISCLOSURES_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_messages ADD COLUMN disclosures_json TEXT`,
];
/**
 * Provider-hosted search results are stored in their own column rather than
 * inside `content`, so the model-authored transcript replayed as history stays
 * free of untrusted webpage titles.
 */
const CHAT_WEB_SOURCES_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_messages ADD COLUMN web_sources_json TEXT`,
];
const AGENT_SESSION_DOCUMENT_BINDING_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_sessions ADD COLUMN document_id TEXT REFERENCES documents(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_document_id ON agent_sessions(document_id, created_at DESC)`,
];

/**
 * The images a captured snapshot refers to.
 *
 * A web-article snapshot is Markdown that names its pictures by durable
 * `interleaf-asset:<sha256><ext>` references, and this table is what turns one
 * of those back into a managed file at open time. It exists as a table rather
 * than as text inside the snapshot because two other jobs need it: storage
 * reconciliation has to know which managed files are still referenced before it
 * deletes anything, and re-importing an article has to know exactly which files
 * the previous capture owned.
 *
 * `reference` is unique per document, so a snapshot cannot name one identity
 * twice with different bytes, while the same hash may legitimately be shared
 * across documents — content-addressed storage keeps exactly one file for it.
 * Rows cascade on document delete, which is what makes the deleted document's
 * images become reconcilable orphans.
 */
const DOCUMENT_ASSETS_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS document_assets (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reference TEXT NOT NULL,
    asset_hash TEXT NOT NULL CHECK(length(asset_hash) = 64),
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size > 0),
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0),
    position INTEGER NOT NULL CHECK(position >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    PRIMARY KEY (document_id, reference)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_document_assets_hash ON document_assets(asset_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_document_assets_document
     ON document_assets(document_id, position)`,
];

/**
 * Conversation compaction state, and the standing nature of attached context.
 *
 * `Clean Context` stores one bounded model-authored summary per session plus the
 * ordinal it summarised through; both are nullable, so every existing session
 * upgrades to "never compacted" without a rewrite. The summary is untrusted
 * conversation data at rest exactly as it is in a request — nothing reads it as
 * an instruction.
 *
 * `attached_origin` records that a stored answer source came from a context item
 * the reader attached. Attached context is now persistent rather than consumed
 * by the turn that sends it, so the live item is what supplies the passage and
 * its snapshot must never be replayed on top of it — and, once the reader
 * removes the item, must never be replayed at all. The snapshot row itself stays
 * for citation resolution and audit.
 */
const CHAT_CONTEXT_COMPACTION_STATEMENTS: readonly string[] = [
  `ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT`,
  `ALTER TABLE chat_sessions ADD COLUMN context_summary_updated_at TEXT`,
  `ALTER TABLE chat_sessions ADD COLUMN compacted_through_ordinal INTEGER`,
  `ALTER TABLE chat_message_sources ADD COLUMN attached_origin INTEGER NOT NULL DEFAULT 0`,
  // Sources already stored against a surviving context item were attached ones.
  // A source whose item was consumed by the old one-turn rule cannot be
  // recovered here, and is left replayable exactly as it is today.
  `UPDATE chat_message_sources SET attached_origin = 1 WHERE context_item_id IS NOT NULL`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', statements: INITIAL_SCHEMA_STATEMENTS },
  { version: 2, name: 'seed_default_settings', statements: SEED_DEFAULTS_STATEMENTS },
  { version: 3, name: 'library_performance_indexes', statements: LIBRARY_INDEXES_STATEMENTS },
  { version: 4, name: 'folder_sibling_name_constraints', statements: FOLDER_NAME_CONSTRAINTS_STATEMENTS },
  { version: 5, name: 'unique_logical_document_hash', statements: UNIQUE_DOCUMENT_HASH_STATEMENTS },
  { version: 6, name: 'unicode_folder_name_keys', statements: UNICODE_FOLDER_NAME_STATEMENTS },
  { version: 7, name: 'full_unicode_folder_case_fold', statements: FULL_UNICODE_FOLDER_CASE_FOLD_STATEMENTS },
  { version: 8, name: 'annotation_document_revision', statements: ANNOTATION_DOCUMENT_REVISION_STATEMENTS },
  { version: 9, name: 'search_index_revision', statements: SEARCH_INDEX_REVISION_STATEMENTS },
  { version: 10, name: 'chat_revision_and_streaming', statements: CHAT_REVISION_AND_STREAMING_STATEMENTS },
  { version: 11, name: 'custom_agent_profile_storage', statements: CUSTOM_AGENT_PROFILE_STORAGE_STATEMENTS },
  { version: 12, name: 'agent_session_effective_config', statements: AGENT_SESSION_EFFECTIVE_CONFIG_STATEMENTS },
  { version: 13, name: 'agent_session_environment_lifecycle', statements: AGENT_SESSION_ENVIRONMENT_LIFECYCLE_STATEMENTS },
  { version: 14, name: 'markdown_document_format', statements: MARKDOWN_DOCUMENT_FORMAT_STATEMENTS, disableForeignKeys: true },
  { version: 15, name: 'cleanup_data_url_cover_paths', statements: CLEANUP_DATA_URL_COVER_PATHS_STATEMENTS },
  { version: 16, name: 'search_location_order', statements: SEARCH_LOCATION_ORDER_STATEMENTS },
  { version: 17, name: 'search_native_anchor_format', statements: SEARCH_NATIVE_ANCHOR_FORMAT_STATEMENTS },
  { version: 18, name: 'chat_disclosures_storage', statements: CHAT_DISCLOSURES_STORAGE_STATEMENTS },
  { version: 19, name: 'agent_session_document_binding', statements: AGENT_SESSION_DOCUMENT_BINDING_STATEMENTS },
  { version: 20, name: 'chat_web_sources_storage', statements: CHAT_WEB_SOURCES_STORAGE_STATEMENTS },
  { version: 21, name: 'document_web_source_provenance', statements: DOCUMENT_WEB_SOURCE_STATEMENTS },
  { version: 22, name: 'document_managed_assets', statements: DOCUMENT_ASSETS_STATEMENTS },
  { version: 23, name: 'chat_context_compaction', statements: CHAT_CONTEXT_COMPACTION_STATEMENTS },
  { version: 24, name: 'agent_session_target_authority', statements: AGENT_SESSION_TARGET_AUTHORITY_STATEMENTS },
  { version: 25, name: 'pptx_document_format', statements: PPTX_DOCUMENT_FORMAT_STATEMENTS, disableForeignKeys: true },
  { version: 26, name: 'file_identity_birth_time', statements: FILE_IDENTITY_BIRTH_TIME_STATEMENTS },
  { version: 27, name: 'chat_session_title_ownership', statements: CHAT_TITLE_OWNERSHIP_STATEMENTS },
  { version: 28, name: 'chat_session_reasoning_effort', statements: CHAT_REASONING_EFFORT_STATEMENTS },
];

/**
 * Applies all pending migrations in order with checksum verification.
 * Returns the number of newly applied migrations.
 */
export function runMigrations(db: InterleafDatabase): number {
  return applyMigrations(db, MIGRATIONS);
}

export function applyMigrations(
  db: InterleafDatabase,
  migrations: readonly Migration[]
): number {
  validateMigrationDefinitions(migrations);
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )`);

  const appliedRows = raw
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string; checksum: string }[];

  const appliedMap = new Map<number, { name: string; checksum: string }>();
  for (const row of appliedRows) {
    appliedMap.set(row.version, { name: row.name, checksum: row.checksum });
  }

  // Applied rows must be an exact prefix of this binary's migration list.
  if (appliedRows.length > migrations.length) {
    throw new InterleafError('internal', 'The database was created by a newer Interleaf schema.');
  }
  for (const [index, applied] of appliedRows.entries()) {
    const migration = migrations[index];
    if (migration?.version !== applied.version) {
      throw new InterleafError('internal', 'The database migration history has a gap or unknown version.');
    }
    const expectedChecksum = computeMigrationChecksum(migration);
    if (applied.name !== migration.name || applied.checksum !== expectedChecksum) {
      throw new InterleafError(
        'internal',
        `Schema migration drift detected for version ${String(migration.version)} (${migration.name}).`
      );
    }
  }

  let appliedCount = 0;
  for (const migration of migrations) {
    if (appliedMap.has(migration.version)) {
      continue;
    }

    const checksum = computeMigrationChecksum(migration);
    const needsFkBypass = migration.disableForeignKeys === true;
    if (needsFkBypass) raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) {
        raw.exec(statement);
      }
      runMigrationPostconditions(raw);
      raw
        .prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, checksum);
      raw.exec('COMMIT');
      if (needsFkBypass) raw.exec('PRAGMA foreign_keys = ON');
      appliedCount += 1;
    } catch (error) {
      raw.exec('ROLLBACK');
      if (needsFkBypass) raw.exec('PRAGMA foreign_keys = ON');
      throw migrationFailure(migration, error instanceof Error ? error : null);
    }
  }

  return appliedCount;
}

function validateMigrationDefinitions(migrations: readonly Migration[]): void {
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1 || names.has(migration.name)) {
      throw new InterleafError(
        'internal',
        'Compiled migration definitions must have contiguous versions and unique names.'
      );
    }
    names.add(migration.name);
  }
}

function runMigrationPostconditions(raw: InterleafDatabase['raw']): void {
  const foreignKeyFailures = raw.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length !== 0) {
    throw new Error('Foreign-key postcondition failed.');
  }
  const ftsExists = raw
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'document_fts'")
    .get();
  if (ftsExists !== undefined) {
    raw.exec("INSERT INTO document_fts(document_fts) VALUES ('integrity-check')");
  }
}

/** One failed migration, reported with the version, name and cause it failed with. */
function migrationFailure(migration: Migration, caught: Error | null): InterleafError {
  const detail = describeError(caught).message;
  return new InterleafError(
    'internal',
    `Migration version ${String(migration.version)} (${migration.name}) failed: ${detail}`,
    { cause: caught },
  );
}
