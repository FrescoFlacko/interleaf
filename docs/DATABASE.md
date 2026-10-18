# Interleaf — Database Architecture & Schema Specification

> **Read. Think. Build.**  
> Embedded SQLite 3 Storage, WAL Configuration, Relational Schemas, and FTS5 Search Indexing.

---

## 1. Database Architecture & Ownership

Interleaf relies on an embedded SQLite 3 database as the single source of truth for library metadata, annotations, chat conversations, agent runs, and lexical search indexes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SQLITE DATABASE ENGINE                          │
│            Location: <userData>/database/interleaf.sqlite              │
├───────────────────────────────────┬────────────────────────────────────┤
│ Connection & Concurrency Mode     │ Sole Ownership Invariant           │
├───────────────────────────────────┼────────────────────────────────────┤
│ • PRAGMA journal_mode = WAL;      │ The Electron Main Process is the   │
│ • PRAGMA synchronous = NORMAL;    │ EXCLUSIVE owner of SQLite access.  │
│ • PRAGMA foreign_keys = ON;       │ Zero raw SQL is passed over IPC.   │
│ • PRAGMA busy_timeout = 5000;     │ All access runs through typed      │
│ • PRAGMA cache_size = -64000;     │ Domain Repositories.               │
└───────────────────────────────────┴────────────────────────────────────┘
```

---

### Files opened without importing

A file opened without importing it (ADR 0014) uses a separate
`InterleafDatabase.open(':memory:')` with the full migration chain. Its
document row, reading position, annotations, search chunks and chats live
only there and are discarded when the file is closed or the app quits; the
library database is never written for it.

## 2. Complete Relational Database Schema (DDL)

```sql
-- Schema Migration Tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Virtual Folder Hierarchy
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Document Library Metadata
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  format TEXT NOT NULL CHECK (format IN ('pdf', 'epub', 'mobi', 'docx', 'markdown', 'pptx')),
  file_path TEXT NOT NULL,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('managed', 'link')),
  file_size INTEGER NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  file_hash TEXT NOT NULL, -- SHA-256 for deduplication
  page_count INTEGER,
  cover_path TEXT,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  source_kind TEXT, -- v21: 'web' or NULL
  source_url TEXT, -- v21: Bounded canonical public URL
  source_site_name TEXT, -- v21: Bounded site title
  source_captured_at TEXT, -- v21: ISO timestamp of capture
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);

-- v22: Managed images a captured web article's snapshot refers to.
-- The snapshot cites `reference` (`interleaf-asset:<sha256><ext>`); this table is
-- the only place that reference is resolved to a managed file, and it is what
-- decides whether a file is still owned or has become an orphan.
CREATE TABLE IF NOT EXISTS document_assets (
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
);

CREATE INDEX IF NOT EXISTS idx_document_assets_hash ON document_assets(asset_hash);
CREATE INDEX IF NOT EXISTS idx_document_assets_document
  ON document_assets(document_id, position);
-- Debounced per-document reading state
CREATE TABLE IF NOT EXISTS reading_positions (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  location_json TEXT NOT NULL,
  progress REAL NOT NULL CHECK (progress >= 0.0 AND progress <= 1.0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_reading_positions_updated ON reading_positions(updated_at DESC);

-- Normalized Unified Annotations
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_hash TEXT NOT NULL, -- Revision against which anchor_json was resolved (added/backfilled in v8)
  type TEXT NOT NULL CHECK (type IN ('highlight', 'note', 'bookmark')),
  anchor_json TEXT NOT NULL, -- Serialized DocumentAnchor
  selected_text TEXT,
  note TEXT,
  label TEXT,
  color TEXT CHECK (color IN ('yellow', 'blue', 'green', 'pink', 'purple')),
  is_location_note INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'anchored' CHECK (status IN ('anchored', 'unanchored')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_doc_updated ON annotations(document_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(document_id, type);

-- Document Normalized Text Chunks (For FTS5 & AI Context)
CREATE TABLE IF NOT EXISTS document_text_chunks (
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
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_text_chunks(document_id, ordinal);

-- Full-Text Lexical Search Virtual Table (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
  document_id UNINDEXED,
  heading,
  text,
  content = 'document_text_chunks',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS document_chunks_ai AFTER INSERT ON document_text_chunks BEGIN
  INSERT INTO document_fts(rowid, document_id, heading, text)
  VALUES (new.rowid, new.document_id, new.heading, new.text);
END;
CREATE TRIGGER IF NOT EXISTS document_chunks_ad AFTER DELETE ON document_text_chunks BEGIN
  INSERT INTO document_fts(document_fts, rowid, document_id, heading, text)
  VALUES ('delete', old.rowid, old.document_id, old.heading, old.text);
END;
CREATE TRIGGER IF NOT EXISTS document_chunks_au AFTER UPDATE ON document_text_chunks BEGIN
  INSERT INTO document_fts(document_fts, rowid, document_id, heading, text)
  VALUES ('delete', old.rowid, old.document_id, old.heading, old.text);
  INSERT INTO document_fts(rowid, document_id, heading, text)
  VALUES (new.rowid, new.document_id, new.heading, new.text);
END;

-- Ingestion & Indexing Lifecycle State
CREATE TABLE IF NOT EXISTS document_index_state (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  document_hash TEXT NOT NULL, -- Source revision owned by the active/ready generation (added/backfilled in v9)
  generation_id TEXT, -- Main-issued UUID while status = 'indexing' (added in v9)
  indexed_text_units INTEGER NOT NULL DEFAULT 0, -- Main-owned cumulative attempt bound
  published_document_hash TEXT NOT NULL DEFAULT '', -- Last atomically committed revision
  published_total_chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('not_indexed', 'indexing', 'ready', 'failed')),
  total_chunks INTEGER NOT NULL DEFAULT 0,
  indexed_chunks INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Generation-scoped staging keeps the prior committed index intact until swap.
CREATE TABLE IF NOT EXISTS document_index_staging_chunks (
  generation_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  location_json TEXT NOT NULL,
  heading TEXT,
  page_label TEXT,
  PRIMARY KEY(generation_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_index_staging_document
  ON document_index_staging_chunks(document_id, generation_id, ordinal);

-- AI Chat Sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_hash TEXT NOT NULL, -- v10: revision owned by the session
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  -- v27 adds title_state (default/generating/generated/manual/failed) and title_claim_id
  -- v28 adds nullable reasoning_effort (NULL = Default; CHECK to the shared vocabulary)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_doc_updated
  ON chat_sessions(document_id, updated_at DESC, id);

-- AI Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  citation_json TEXT, -- Serialized citation references
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'streaming', 'cancelled', 'failed')), -- v10
  request_id TEXT, -- v10: unique active/completed request identity
  token_count INTEGER, -- v10
  error_message TEXT, -- v10: typed user-safe failure detail
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  UNIQUE(session_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_request
  ON chat_messages(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ordinal
  ON chat_messages(session_id, ordinal ASC);

CREATE TABLE IF NOT EXISTS chat_context_items (
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
);

CREATE INDEX IF NOT EXISTS idx_chat_context_session_pinned
  ON chat_context_items(session_id, pinned DESC, created_at ASC, id);

-- Immutable source envelope captured for each assistant message (v10)
CREATE TABLE IF NOT EXISTS chat_message_sources (
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
);

CREATE INDEX IF NOT EXISTS idx_chat_sources_document
  ON chat_message_sources(document_id, document_hash, message_id);

CREATE TABLE IF NOT EXISTS allowed_working_directories (
  handle TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  last_validated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Persistent Agent Profiles
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  default_args_json TEXT NOT NULL,
  default_model TEXT,
  reasoning_effort TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'normal',
  default_sandbox_mode TEXT NOT NULL DEFAULT 'auto-isolated' CHECK (default_sandbox_mode IN ('auto-isolated', 'isolated-worktree', 'isolated-copy', 'container-sandbox')),
  default_directory_handle TEXT REFERENCES allowed_working_directories(handle) ON DELETE SET NULL,
  env_reference_json TEXT, -- Non-secret names and secure-vault references only
  is_custom INTEGER NOT NULL DEFAULT 0,
  custom_config_json TEXT, -- v11: versioned custom profile config; main-owned JSON
  executable_identity_json TEXT, -- v11: device/inode/size/mtime/SHA-256 identity
  deleted_at TEXT, -- v11: nullable soft-delete timestamp; preserves session history
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Agent Execution Sessions
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  target_directory_handle TEXT NOT NULL REFERENCES allowed_working_directories(handle),
  canonical_target_path TEXT NOT NULL, -- Main-process audit data; never returned over IPC
  isolated_workspace_path TEXT,
  sandbox_mode TEXT NOT NULL CHECK (sandbox_mode IN ('isolated-worktree', 'isolated-copy', 'native-restricted', 'container-sandbox', 'active-env')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted')),
  provider_session_id TEXT,
  user_prompt TEXT NOT NULL,
  context_summary TEXT,
  base_commit TEXT,
  baseline_fingerprint TEXT NOT NULL,
  final_report TEXT,
  environment_json TEXT, -- Runtime environment review DTO; compatibility column added idempotently by AgentRepository
  environment_workspace_path TEXT, -- Main-only/app-owned review path metadata
  environment_updated_at TEXT, -- Compatibility-column timestamp
  effective_model TEXT, -- v12: exact effective model snapshot captured on session start
  effective_reasoning_effort TEXT, -- v12: exact effective reasoning effort snapshot captured on session start
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- Agent Session Events Stream
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  UNIQUE(session_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, ordinal ASC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('context_packet', 'diff', 'changed_files', 'test_result', 'log', 'patch', 'recovery_backup')),
  app_relative_path TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_session ON agent_artifacts(session_id, kind);

-- Application Settings KV Store
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);
```

### Migration and Transaction Invariants

- Migrations are ordered, checksummed, applied once under `BEGIN IMMEDIATE`, and recorded in `schema_migrations` only after every statement and postcondition succeeds. The checksum is lowercase SHA-256 over UTF-8 bytes of the migration's canonical LF-normalized SQL plus its version and name; changing an applied migration is forbidden. Startup recomputes every known checksum and stops with a typed recovery error on drift or partial failure; destructive changes use additive/backfill/swap migrations with a tested backup/rollback path.
- The current implemented chain is contiguous: v1 `initial_schema`, v2 `seed_default_settings`, v3 `library_performance_indexes`, v4 `folder_sibling_name_constraints`, v5 `unique_logical_document_hash`, v6 `unicode_folder_name_keys`, v7 `full_unicode_folder_case_fold`, v8 `annotation_document_revision`, v9 `search_index_revision`, v10 `chat_revision_and_streaming`, v11 `custom_agent_profile_storage`, v12 `agent_session_effective_config`, v13 `agent_session_environment_lifecycle`, v14 `markdown_document_format`, v15 `cleanup_data_url_cover_paths`, v16 `search_location_order`, v17 `search_native_anchor_format`, v18 `chat_disclosures_storage`, v19 `agent_session_document_binding`, v20 `chat_web_sources_storage`, v21 `document_web_source_provenance`, v22 `document_managed_assets`, v23 `chat_context_compaction`, v24 `agent_session_target_authority`, v25 `pptx_document_format`, v26 `file_identity_birth_time`, v27 `chat_session_title_ownership`, and v28 `chat_session_reasoning_effort`. V10 remains checksum-protected and contains only chat changes. V11 adds `agent_profiles.custom_config_json`, `agent_profiles.executable_identity_json`, and nullable `agent_profiles.deleted_at` for soft deletion. V12 adds `agent_sessions.effective_model` and `agent_sessions.effective_reasoning_effort`. V13 adds `agent_sessions.environment_lifecycle`. V14 adds native `markdown` document format support. V17 adds native anchor formats for PDF, EPUB, MOBI, and Markdown.
- Migration v21 (`document_web_source_provenance`, ADR 0012) adds additive provenance columns (`source_kind`, `source_url`, `source_site_name`, `source_captured_at`) to `documents` for captured web articles, indexed by `idx_documents_source_kind`. Insert and update triggers (`validate_documents_source_coherence_insert` and `validate_documents_source_coherence_update`) enforce source coherence: web documents require `source_url` and `source_captured_at`, while non-web documents must retain null across all source columns. Existing user-imported files retain `NULL` provenance. Web articles reuse the existing reflowable Markdown adapter format without altering anchor schemas or document deduplication.
- Migration v22 (`document_managed_assets`, ADR 0012) adds `document_assets`, relating a captured web article to the managed image files its snapshot refers to. `reference` is the durable `interleaf-asset:<sha256><ext>` citation that appears in the Markdown; `file_path` is the managed location it resolves to, and `position` preserves source order. The primary key `(document_id, reference)` makes an image cited twice one row, and `ON DELETE CASCADE` removes the rows with the document. `idx_document_assets_hash` answers "does any surviving document still own this file?", which is the check that gates deleting a superseded or failed capture's bytes; `idx_document_assets_document` serves ordered reads when a document opens. Rows exist only for captured web articles, so a user-imported Markdown file has none and behaves exactly as before. Re-importing a captured URL replaces that document's asset rows and its `documents` row in one transaction; superseded managed files are deleted only after that commit and only when unreferenced, with managed-storage reconciliation as the backstop.
- Migration v25 (`pptx_document_format`, ADR 0014) widens the `documents.format` CHECK to admit `pptx`. SQLite cannot alter a CHECK, so it rebuilds `documents` with foreign keys disabled exactly as v14 did, copies every column by name including the v21 source columns, and recreates the v14 indexes plus the v21 `idx_documents_source_kind` index and both source-coherence triggers from the same statements v21 used. The statements live in `src/main/db/pptx-format-migration.ts`; `tests/integration/pptx-migration.spec.ts` covers row, child-row, index, trigger, cascade and foreign-key integrity.
- Migration v27 (`chat_session_title_ownership`) adds `chat_sessions.title_state` (`NOT NULL DEFAULT 'manual'`, CHECK in `default`, `generating`, `generated`, `manual`, `failed`) and nullable `chat_sessions.title_claim_id` for automatic Reader Chat naming (docs/AI_ARCHITECTURE.md §1.4). Every pre-existing row becomes `manual` and is never renamed. `ChatRepository.createSession` stores an explicit title as `manual` and the generated "Conversation N" placeholder as `default`; any title written through `updateSession` moves the row to `manual`, even when the text is unchanged. `ChatTitleRepository` owns the remaining transitions, each one conditional statement: `claim` moves `default` → `generating` with a fresh claim ID only while the session is on the document's current `file_hash` and holds exactly one complete assistant message; `commit` writes the title and `generated` only while that same claim still owns a `generating` row on the current revision (it never touches `updated_at`); `fail` moves the claim to `failed` — also used when a run is retired because the asking window was destroyed or the saved naming mode changed. A manual rename, deletion or archive therefore makes a late commit match no row. Opening the repository retires any `generating` row left by a previous run to `failed`, so a session gets at most one attempt. Both columns are main-only and never projected to the renderer. The statements live in `src/main/db/chat-title-ownership-migration.ts`; coverage is in `tests/unit/conversation-titling.spec.ts`.
- Migration v28 (`chat_session_reasoning_effort`) adds nullable `chat_sessions.reasoning_effort`, with a CHECK limiting it to `off`, `none`, `on`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` (`src/shared/constants/reasoning.ts`). `NULL` is Default: no override is sent, so every pre-existing row behaves as before. `ChatRepository` writes provider, model and level in one `updateSession` statement, and `createSession` stores a draft's level with the conversation. Whether a stored level is still offered by the bound model is decided by main at send time, never by the column; a stale level is kept and the turn is refused (docs/AI_ARCHITECTURE.md §1.5). The statement lives in `src/main/db/chat-reasoning-effort-migration.ts`.
- Logical import reconciliation, annotation repair, chat append/context snapshot, indexing batches, and agent state/event/artifact transitions are repository transactions. Binary ingestion is staged atomically before the short SQLite transaction; startup removes abandoned temp files and old unreferenced hash blobs after a conservative grace period. Renderer IPC never controls transaction boundaries.
- FTS5 uses the external-content table and triggers above. Migrations and integration tests run `INSERT INTO document_fts(document_fts) VALUES ('integrity-check')` and verify update/delete propagation. The main-owned repository retains an internal `rebuild` plus `integrity-check` recovery operation; it is not exposed to the renderer.
- User-facing search is exact and whole-token. `document_fts` stays tokenized with `porter unicode61`, so `MATCH` is a recall superset used only to select candidate rows: the quoted, non-prefix expression from `buildExactFtsQuery` narrows it, and the deterministic `interleaf_search_exact_terms(text, heading, query)` function (registered in `InterleafDatabase.open`) applies the authoritative folded whole-token AND relation inside the same statement, before `ORDER BY` and `LIMIT`. Result excerpts are built in JavaScript from those same exact matches rather than by `snippet()`, whose window is centred on the stemmed hit and can exclude the searched token entirely. `buildFtsQuery` keeps its prefix semantics for ADR-0006 Level-3 AI retrieval only. No reindex or migration is involved.
- Search indexing is generation-, active-capability-, and revision-owned: the main process issues UUIDs, requires the document to be active in the renderer scope, validates the current `documents.file_hash` and format on every batch, computes token counts, enforces cumulative generation caps transactionally, requires contiguous ordinals, and atomically swaps staging rows into `document_text_chunks`.
- Attempt state is separate from published state. During same-revision reindexing or after a failed/interrupted attempt, the last atomically published chunks remain searchable. Search and result navigation require `published_document_hash = documents.file_hash`; a narrow main-side hit resolver revalidates the document revision and committed chunk before the renderer navigates.
- `annotations` is the sole source of truth for highlights, notes, and bookmarks. A bookmark is `type = 'bookmark'` with `label`; there is no competing bookmarks table. Main-owned repository validation preserves type semantics on creation, edit, and repair; every read/write is scoped by both document ID and annotation ID. Anchor repair runs under `BEGIN IMMEDIATE`, verifies the renderer-opened revision hash still matches `documents.file_hash`, and only then updates anchor, status, and revision together.
- Annotation browsing uses repository-computed counts and bounded 50-item pages; offsets are validated and sorting/filtering stay in prepared SQL. Reader painting is queried separately by format-native page/spine/section scope, while rows with an older `document_hash` are included for revision-shrink repair or Stage-4 unanchoring.
- `auto-isolated` is the persisted agent profile default. Main resolves it per registered target: Git → `isolated-worktree`, non-Git → `isolated-copy`, preparation failure → fail closed. It never degrades to `active-env`.
- Direct-workspace modes (`native-restricted` and `active-env`) are resolved session values only and are rejected as profile/settings defaults. Both require a bound, expiring, single-use confirmation grant covering the exact mode, profile fingerprint, effective permission policy, target identity, and draft. `native-restricted` additionally requires a main-owned capability probe proving the exact adapter profile provides the promised native sandbox.
- `env_reference_json` contains variable names and secure-vault record IDs only. Secret values never enter SQLite, renderer payloads, logs, or artifacts.
- `custom_config_json` is validated as `CustomAgentProfileConfig` with `version: 1`. It contains a discriminated `executionKind`: normal tokenized argv templates or expert shell execution. Normal mode rejects shell-only fields and direct shell binaries (`bash`, `sh`, `pwsh`, `cmd`, etc.) or direct eval flags (`-c`, `/c`, `-Command`). Expert mode configures a shell family (`posix`, `powershell`, `cmd`), static shell command, and optional static resume command. Arguments templates and prompt files are rejected in expert mode; prompt delivery is strictly `stdin`. `executable_identity_json` stores the validated device, inode, size, mtime, and SHA-256 identity used to stop execution when the selected binary changes. Selection and rehydration stream the bounded file through a worker-thread hasher with before/after identity checks and a timeout; the immediate synchronous spawn guard checks only canonical path and metadata, after an async worker verification in the main service. Renderer payloads receive an opaque executable handle/display name/fingerprint, never the canonical path. Deletion sets `deleted_at` and retains rows for historical sessions.
- `agent_sessions.environment_json`, `environment_workspace_path`, and `environment_updated_at` remain idempotent compatibility columns added by `AgentRepository.ensureEnvironmentColumns()` for older fixtures. The persisted `environment_lifecycle` field is owned by forward migration v13 and remains nullable for legacy rows.
- Migration coverage is exercised by `tests/integration/database.spec.ts` (including the v9-to-v10 chat upgrade and v12-to-v13 agent session upgrade), `tests/unit/custom-agent-profile.spec.ts`, and `tests/unit/agent-session-effective-resume.spec.ts`.
- `chat_context_items` is an immutable historical snapshot: excerpt text/hash, document revision hash, normalized anchor, and provenance metadata are captured transactionally when attached. Re-indexing or replacing a document never rewrites an old conversation's context rows.
