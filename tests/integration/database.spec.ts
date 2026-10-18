import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { InterleafDatabase, DATABASE_FILE_NAME } from '@main/db/database';
import { applyMigrations, computeMigrationChecksum, MIGRATIONS, runMigrations, type Migration } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { FolderRepository } from '@main/db/repositories/folder-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { documentSourceSchema } from '@shared/schemas/document';
import type { PortableRecord, PortableValue } from '@shared/models/portable';
import { silentLogger } from '../helpers/silent-logger';

function makeTempDbPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'interleaf-db-')), DATABASE_FILE_NAME);
}

function withTempDatabase(use: (db: InterleafDatabase) => void): void {
  const dbPath = makeTempDbPath();
  const db = InterleafDatabase.open(dbPath);
  try {
    use(db);
  } finally {
    db.close();
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
}

describe('SQLite bootstrap and migrations', () => {
  it('opens with WAL and foreign keys enabled', () => {
    withTempDatabase((db) => {
      expect(db.raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      expect(db.raw.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    });
  });

  it('applies the initial schema and is idempotent on re-run', () => {
    withTempDatabase((db) => {
      const firstRun = runMigrations(db);
      expect(firstRun).toBeGreaterThanOrEqual(2);
      const secondRun = runMigrations(db);
      expect(secondRun).toBe(0);

      const tables = (
        db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);

      const expectedTables = [
        'schema_migrations',
        'folders',
        'documents',
        'reading_positions',
        'annotations',
        'document_text_chunks',
        'document_index_state',
        'document_index_staging_chunks',
        'chat_sessions',
        'chat_messages',
        'chat_context_items',
        'chat_message_sources',
        'allowed_working_directories',
        'agent_profiles',
        'agent_sessions',
        'agent_events',
        'agent_artifacts',
        'settings',
      ];

      for (const expected of expectedTables) {
        expect(tables).toContain(expected);
      }

      // No competing standalone bookmarks table (DATABASE.md invariant)
      expect(tables).not.toContain('bookmarks');

      // Test document insertion
      db.raw
        .prepare(
          `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
           VALUES ('d1', 'Test Book', 'pdf', '/path/doc.pdf', 'managed', 1024, 123456, 'hash-d1')`
        )
        .run();

      // Test FTS5 external content insertion via triggers
      db.raw
        .prepare(
          `INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading)
           VALUES ('c1', 'd1', 0, 'leader based replication in distributed systems', 6, '{}', 'Replication')`
        )
        .run();

      const hits = db.raw
        .prepare("SELECT rowid, heading, text FROM document_fts WHERE document_fts MATCH 'replication'")
        .all() as { rowid: number; heading: string; text: string }[];
      expect(hits).toHaveLength(1);
      expect(hits[0]?.heading).toBe('Replication');

      db.raw
        .prepare("UPDATE document_text_chunks SET text = 'consensus quorum', heading = 'Consensus' WHERE id = 'c1'")
        .run();
      expect(
        db.raw.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH 'replication'").all()
      ).toHaveLength(0);
      expect(
        db.raw.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH 'quorum'").all()
      ).toHaveLength(1);

      // Deleting the chunk automatically deletes from FTS5
      db.raw.prepare('DELETE FROM document_text_chunks WHERE id = ?').run('c1');
      const hitsAfterDelete = db.raw
        .prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH 'replication'")
        .all();
      expect(hitsAfterDelete).toHaveLength(0);
      expect(() => {
        db.raw.exec("INSERT INTO document_fts(document_fts) VALUES ('integrity-check')");
      }).not.toThrow();
    });
  });

  it('upgrades a historical v10 database through v13 and SettingsRepository materializes defaults while preserving preferences', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      // Apply historical v10 migrations (which includes the pinned historical v2 definition)
      const v10Migrations = MIGRATIONS.slice(0, 10);
      expect(applyMigrations(db, v10Migrations)).toBe(10);

      // Verify v2 was applied with the exact historical checksum
      const v2Row = db.raw
        .prepare('SELECT version, name, checksum FROM schema_migrations WHERE version = 2')
        .get() as { version: number; name: string; checksum: string };
      expect(v2Row).toEqual({
        version: 2,
        name: 'seed_default_settings',
        checksum: 'e7f7a8ea0a19baf367a5594a946cb6abead970173a58bad0170488b906c465de',
      });

      // Store legitimate customized preferences using minimal legacy shape
      db.raw
        .prepare("UPDATE settings SET value_json = ? WHERE key = 'app'")
        .run(
          JSON.stringify({
            version: 1,
            appearance: { palette: 'midnight' },
            agent: { defaultExecutionMode: 'isolated-copy' },
          })
        );

      // Upgrade from v10 through current v13
      const newlyApplied = runMigrations(db);
      expect(newlyApplied).toBe(MIGRATIONS.length - 10);

      const totalApplied = db.raw
        .prepare('SELECT COUNT(*) as count FROM schema_migrations')
        .get() as { count: number };
      expect(totalApplied.count).toBe(MIGRATIONS.length);

      // Verify SettingsRepository.get() materializes defaults while preserving stored preferences
      const repo = new SettingsRepository(db, silentLogger);
      const settings = repo.get();
      expect(settings.version).toBe(1);
      expect(settings.appearance.palette).toBe('midnight');
      expect(settings.agent.defaultExecutionMode).toBe('isolated-copy');
      expect(settings.agent.workingDirectories).toEqual([]);
      expect(settings.agent.defaultWorkingDirectoryByProfile).toEqual({});
      expect(settings.agent.profiles).toEqual({});
      expect(settings.reader).toEqual(DEFAULT_APP_SETTINGS.reader);
      expect(settings.layout).toEqual(DEFAULT_APP_SETTINGS.layout);
      expect(settings.ai).toEqual(DEFAULT_APP_SETTINGS.ai);
    } finally {
      db.close();
    }
  });

  it('initializes a fresh database through v13 and materializes complete default settings', () => {
    withTempDatabase((db) => {
      const applied = runMigrations(db);
      expect(applied).toBe(MIGRATIONS.length);

      const rows = db.raw
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
        .all() as { version: number; name: string; checksum: string }[];
      expect(rows).toHaveLength(MIGRATIONS.length);
      // Every applied migration records a 64-character lowercase hex checksum.
      expect(rows.filter((row) => !/^[a-f0-9]{64}$/.test(row.checksum))).toEqual([]);
      expect(rows[1]).toEqual({
        version: 2,
        name: 'seed_default_settings',
        checksum: 'e7f7a8ea0a19baf367a5594a946cb6abead970173a58bad0170488b906c465de',
      });

      const rawRow = db.raw
        .prepare("SELECT value_json FROM settings WHERE key = 'app'")
        .get() as { value_json: string };
      expect(JSON.parse(rawRow.value_json)).toEqual({
        version: 1,
        appearance: { palette: 'paper' },
        agent: { defaultExecutionMode: 'auto-isolated' },
      });

      const repo = new SettingsRepository(db, silentLogger);
      expect(repo.get()).toEqual(DEFAULT_APP_SETTINGS);
    });
  });

  it('backfills annotation document revisions when upgrading from schema v7', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 7));
      db.raw.exec(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('legacy-doc', 'Legacy', 'pdf', '/legacy.pdf', 'link', 10, 1, 'legacy-hash');
        INSERT INTO annotations (id, document_id, type, anchor_json)
        VALUES ('legacy-ann', 'legacy-doc', 'bookmark', '{}');
      `);

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 7);
      expect(
        db.raw.prepare("SELECT document_hash FROM annotations WHERE id = 'legacy-ann'").get()
      ).toMatchObject({ document_hash: 'legacy-hash' });
      const indexes = db.raw.prepare("PRAGMA index_list('annotations')").all() as { name: string }[];
      expect(indexes.map((index) => index.name)).toContain('idx_annotations_doc_updated');
      expect(
        db.raw.prepare("SELECT document_hash FROM document_index_state WHERE document_id = 'legacy-doc'").get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('upgrades v8 search state with revision ownership and interrupted-generation recovery', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 8));
      db.raw.exec(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES
          ('ready-doc', 'Ready', 'pdf', '/ready.pdf', 'link', 10, 1, 'ready-hash'),
          ('active-doc', 'Active', 'docx', '/active.docx', 'link', 10, 1, 'active-hash');
        INSERT INTO document_index_state
          (document_id, status, total_chunks, indexed_chunks, error_message)
        VALUES
          ('ready-doc', 'ready', 2, 2, NULL),
          ('active-doc', 'indexing', 3, 1, NULL);
      `);

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 8);
      expect(db.raw.prepare("SELECT document_hash, published_document_hash, published_total_chunks, generation_id, status FROM document_index_state WHERE document_id = 'ready-doc'").get())
        .toMatchObject({
          document_hash: 'ready-hash', published_document_hash: '',
          published_total_chunks: 0, generation_id: null, status: 'not_indexed',
        });
      expect(db.raw.prepare("SELECT document_hash, generation_id, status, error_message FROM document_index_state WHERE document_id = 'active-doc'").get())
        .toMatchObject({
          document_hash: 'active-hash',
          generation_id: null,
          status: 'not_indexed',
          error_message: 'Search index format upgrade requires a rebuild.',
        });
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_index_staging_chunks'").get())
        .toMatchObject({ name: 'document_index_staging_chunks' });
    } finally {
      db.close();
    }
  });

  it('upgrades v9 chat data with revision ownership, lifecycle columns, and immutable sources', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 9));
      db.raw.exec(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('chat-doc', 'Chat', 'pdf', '/chat.pdf', 'link', 10, 1, 'chat-hash');
        INSERT INTO chat_sessions (id, document_id, title, provider_id)
        VALUES ('legacy-chat', 'chat-doc', 'Legacy chat', 'fake');
        INSERT INTO chat_messages (id, session_id, role, ordinal, content)
        VALUES ('legacy-message', 'legacy-chat', 'user', 0, 'Question');
      `);

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 9);
      expect(db.raw.prepare("SELECT document_hash FROM chat_sessions WHERE id = 'legacy-chat'").get())
        .toMatchObject({ document_hash: 'chat-hash' });
      expect(db.raw.prepare("SELECT status, request_id, token_count FROM chat_messages WHERE id = 'legacy-message'").get())
        .toMatchObject({ status: 'complete', request_id: null, token_count: null });
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_message_sources'").get())
        .toMatchObject({ name: 'chat_message_sources' });
      const sessionIndexes = db.raw.prepare("PRAGMA index_list('chat_sessions')").all() as { name: string }[];
      expect(sessionIndexes.map((index) => index.name)).toContain('idx_chat_sessions_doc_updated');
    } finally {
      db.close();
    }
  });
  it('upgrades v12 agent data with a forward-only lifecycle migration', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 12));
      const oldColumns = (db.raw.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[]).map((row) => row.name);
      expect(oldColumns).not.toContain('environment_lifecycle');
      const before = db.raw.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version BETWEEN 10 AND 12 ORDER BY version').all();

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 12);
      const newColumns = (db.raw.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[]).map((row) => row.name);
      expect(newColumns).toContain('environment_lifecycle');
      expect(db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'").get()).toMatchObject({ sql: expect.stringContaining("'prepared', 'applied', 'discarded'") });
      const after = db.raw.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version BETWEEN 10 AND 12 ORDER BY version').all();
      expect(after).toEqual(before);
      expect(db.raw.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version = 13').get()).toMatchObject({ version: 13, name: 'agent_session_environment_lifecycle', checksum: computeMigrationChecksum(MIGRATIONS[12]!) });
    } finally {
      db.close();
    }
  });

  it('migrates a live v15 search database to v16 without losing published FTS data or staging lifecycle state', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      expect(applyMigrations(db, MIGRATIONS.slice(0, 15))).toBe(15);
      const historyBefore = db.raw
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all() as { version: number; name: string; checksum: string }[];
      expect(historyBefore).toHaveLength(15);
      expect(historyBefore.map((row) => row.checksum)).toEqual(
        MIGRATIONS.slice(0, 15).map((migration) => computeMigrationChecksum(migration))
      );

      // A ready, published index represents the data that must remain
      // searchable while the additive location-order columns are introduced.
      db.raw.exec(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES
          ('v15-ready', 'V15 Ready', 'pdf', '/v15-ready.pdf', 'link', 10, 1, 'v15-ready-hash'),
          ('v15-staging', 'V15 Staging', 'pdf', '/v15-staging.pdf', 'link', 10, 1, 'v15-staging-hash');
        INSERT INTO document_index_state
          (document_id, status, total_chunks, indexed_chunks, error_message,
           document_hash, generation_id, indexed_text_units,
           published_document_hash, published_total_chunks)
        VALUES
          ('v15-ready', 'ready', 2, 2, NULL, 'v15-ready-hash', NULL, 48, 'v15-ready-hash', 2),
          ('v15-staging', 'indexing', 1, 1, NULL, 'v15-staging-hash', 'v15-generation', 20, '', 0);
        INSERT INTO document_text_chunks
          (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
        VALUES
          ('v15-chunk-0', 'v15-ready', 0, 'legacy migration needle on the last page', 6,
           '{"format":"pdf","pageIndex":9,"pageLabel":"Page 10"}', NULL, 'Page 10'),
          ('v15-chunk-1', 'v15-ready', 1, 'legacy migration needle on the first page', 6,
           '{"format":"pdf","pageIndex":0,"pageLabel":"Page 1"}', NULL, 'Page 1');
        INSERT INTO document_index_staging_chunks
          (generation_id, document_id, ordinal, text, token_count, location_json, heading, page_label)
        VALUES
          ('v15-generation', 'v15-staging', 0, 'staging row survives migration', 5,
           '{"format":"pdf","pageIndex":0,"pageLabel":"Page 1"}', NULL, 'Page 1');
      `);

      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_text_chunks WHERE document_id = 'v15-ready'").get())
        .toMatchObject({ count: 2 });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_index_staging_chunks WHERE generation_id = 'v15-generation'").get())
        .toMatchObject({ count: 1 });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_fts WHERE document_fts MATCH 'needle'").get())
        .toMatchObject({ count: 2 });

      // Apply only v16 here; v17's derivative invalidation is covered by the
      // native-anchor upgrade test below.
      expect(applyMigrations(db, MIGRATIONS.slice(0, 16))).toBe(1);
      const historyAfter = db.raw
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all() as { version: number; name: string; checksum: string }[];
      expect(historyAfter.slice(0, 15)).toEqual(historyBefore);
      expect(historyAfter[15]).toEqual({
        version: 16,
        name: 'search_location_order',
        checksum: computeMigrationChecksum(MIGRATIONS[15]!),
      });

      const chunkColumns = (db.raw.prepare("PRAGMA table_info(document_text_chunks)").all() as { name: string }[])
        .map((column) => column.name);
      const stagingColumns = (db.raw.prepare("PRAGMA table_info(document_index_staging_chunks)").all() as { name: string }[])
        .map((column) => column.name);
      expect(chunkColumns).toEqual(expect.arrayContaining(['location_order', 'location_detail', 'location_offset']));
      expect(stagingColumns).toEqual(expect.arrayContaining(['location_order', 'location_detail', 'location_offset']));
      const chunkIndexes = db.raw.prepare("PRAGMA index_list('document_text_chunks')").all() as { name: string }[];
      expect(chunkIndexes.map((index) => index.name)).toContain('idx_chunks_doc_location_order');

      // Existing content and the external-content FTS rows survive the ALTERs.
      expect(db.raw.prepare("SELECT ordinal, text FROM document_text_chunks WHERE document_id = 'v15-ready' ORDER BY ordinal").all())
        .toEqual([
          { ordinal: 0, text: 'legacy migration needle on the last page' },
          { ordinal: 1, text: 'legacy migration needle on the first page' },
        ]);
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_fts WHERE document_fts MATCH 'needle'").get())
        .toMatchObject({ count: 2 });
      expect(db.raw.prepare("SELECT location_order, location_detail, location_offset FROM document_text_chunks WHERE id = 'v15-chunk-0'").get())
        .toEqual({ location_order: -1, location_detail: -1, location_offset: -1 });

      // Startup recovery handles an interrupted v15 staging generation
      // consistently: it removes unpublished rows and records a failure, while
      // the already published index remains searchable with ordinal fallback.
      const search = new SearchRepository(db);
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_index_staging_chunks WHERE generation_id = 'v15-generation'").get())
        .toMatchObject({ count: 0 });
      expect(db.raw.prepare("SELECT status, error_message FROM document_index_state WHERE document_id = 'v15-staging'").get())
        .toEqual({ status: 'failed', error_message: 'Indexing was interrupted before completion.' });
      expect(search.search('v15-ready', 'needle', 2).map((hit) => hit.ordinal)).toEqual([0, 1]);

      // A separate fresh database must receive exactly the same v16 shape.
      const fresh = InterleafDatabase.open(':memory:');
      try {
        expect(runMigrations(fresh)).toBe(MIGRATIONS.length);
        const freshColumns = (fresh.raw.prepare("PRAGMA table_info(document_text_chunks)").all() as { name: string }[])
          .map((column) => column.name);
        const freshStagingColumns = (fresh.raw.prepare("PRAGMA table_info(document_index_staging_chunks)").all() as { name: string }[])
          .map((column) => column.name);
        expect(freshColumns).toEqual(expect.arrayContaining(['location_order', 'location_detail', 'location_offset']));
        expect(freshStagingColumns).toEqual(expect.arrayContaining(['location_order', 'location_detail', 'location_offset']));
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });

  it('upgrades v16 derivative indexes to native-anchor format without stranding documents', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      expect(applyMigrations(db, MIGRATIONS.slice(0, 16))).toBe(16);
      db.raw.exec(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('anchor-doc', 'Anchor', 'pdf', '/anchor.pdf', 'link', 10, 1, 'anchor-hash');
        INSERT INTO reading_positions (document_id, location_json, progress)
        VALUES ('anchor-doc', '{"format":"pdf","pageIndex":2}', 0.4);
        INSERT INTO annotations (id, document_id, type, anchor_json, selected_text, color, document_hash)
        VALUES ('anchor-ann', 'anchor-doc', 'highlight', '{}', 'kept', 'yellow', 'anchor-hash');
        INSERT INTO document_index_state
          (document_id, status, total_chunks, indexed_chunks, error_message,
           document_hash, generation_id, indexed_text_units,
           published_document_hash, published_total_chunks)
        VALUES ('anchor-doc', 'ready', 1, 1, NULL, 'anchor-hash', NULL, 18, 'anchor-hash', 1);
        INSERT INTO document_text_chunks
          (id, document_id, ordinal, text, token_count, location_json, heading, page_label,
           location_order, location_detail, location_offset)
        VALUES ('anchor-chunk', 'anchor-doc', 0, 'legacy needle', 2,
          '{"format":"pdf","pageIndex":0}', NULL, 'Page 1', 0, 0, 0);
        INSERT INTO document_index_staging_chunks
          (generation_id, document_id, ordinal, text, token_count, location_json, heading, page_label,
           location_order, location_detail, location_offset)
        VALUES ('anchor-generation', 'anchor-doc', 0, 'staging needle', 2,
          '{"format":"pdf","pageIndex":1}', NULL, 'Page 2', 1, 0, 0);
      `);
      const historyBefore = db.raw.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      expect(runMigrations(db)).toBe(MIGRATIONS.length - 16);
      expect(db.raw.prepare('SELECT version, checksum FROM schema_migrations WHERE version < 17 ORDER BY version').all())
        .toEqual(historyBefore);
      expect(db.raw.prepare("SELECT title, file_path, file_hash FROM documents WHERE id = 'anchor-doc'").get())
        .toEqual({ title: 'Anchor', file_path: '/anchor.pdf', file_hash: 'anchor-hash' });
      expect(db.raw.prepare("SELECT location_json, progress FROM reading_positions WHERE document_id = 'anchor-doc'").get())
        .toEqual({ location_json: '{"format":"pdf","pageIndex":2}', progress: 0.4 });
      expect(db.raw.prepare("SELECT selected_text, color, document_hash FROM annotations WHERE id = 'anchor-ann'").get())
        .toEqual({ selected_text: 'kept', color: 'yellow', document_hash: 'anchor-hash' });
      expect(db.raw.prepare("SELECT status, total_chunks, indexed_chunks, published_document_hash FROM document_index_state WHERE document_id = 'anchor-doc'").get())
        .toEqual({ status: 'not_indexed', total_chunks: 0, indexed_chunks: 0, published_document_hash: '' });
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_text_chunks').get()).toEqual({ count: 0 });
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_index_staging_chunks').get()).toEqual({ count: 0 });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_fts WHERE document_fts MATCH 'needle'").get()).toEqual({ count: 0 });

      const search = new SearchRepository(db);
      const generation = search.begin('anchor-doc', 'anchor-hash');
      const text = 'rebuilt needle';
      search.append('anchor-doc', 'anchor-hash', generation.generationId, [{
        ordinal: 0, text,
        location: { format: 'pdf', pageIndex: 0, textStart: 0, textEnd: text.length },
        heading: null, pageLabel: 'Page 1',
      }]);
      search.complete('anchor-doc', 'anchor-hash', generation.generationId);
      expect(search.search('anchor-doc', 'needle')[0]?.anchor?.ranges[0]?.text).toBe('needle');
      const fresh = InterleafDatabase.open(':memory:');
      try {
        expect(runMigrations(fresh)).toBe(MIGRATIONS.length);
        expect(fresh.raw.prepare('SELECT version, name FROM schema_migrations WHERE version = 17').get())
          .toEqual({ version: 17, name: 'search_native_anchor_format' });
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });
  const PROVENANCE_INSERT_SQL = `INSERT INTO documents
           (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash,
            source_kind, source_url, source_site_name, source_captured_at)
         VALUES (?, ?, 'markdown', ?, 'managed', 10, 1000, ?, ?, ?, ?, ?)`;
  const CAPTURED_AT = '2026-09-06T00:00:00.000Z';

  function withMigratedDatabase(use: (db: InterleafDatabase) => void): void {
    const db = InterleafDatabase.open(':memory:');
    try {
      expect(runMigrations(db)).toBe(MIGRATIONS.length);
      use(db);
    } finally {
      db.close();
    }
  }

  it('enforces Migration 21 provenance invariants and column coherence triggers', () => {
    withMigratedDatabase((db) => {
      const insertSql = PROVENANCE_INSERT_SQL;

      // 1. User document with null provenance succeeds
      db.raw.prepare(insertSql).run('user-doc', 'User File', '/user.md', 'hash-user', null, null, null, null);
      const userRow = db.raw.prepare('SELECT source_kind, source_url FROM documents WHERE id = ?').get('user-doc') as { source_kind: string | null; source_url: string | null };
      expect(userRow.source_kind).toBeNull();
      expect(userRow.source_url).toBeNull();

      // 2. Web document with valid provenance succeeds
      db.raw.prepare(insertSql).run(
        'web-doc',
        'Web Article',
        '/web.md',
        'hash-web',
        'web',
        'https://example.com/article',
        'Example Site',
        '2026-09-06T00:00:00.000Z'
      );
      const webRow = db.raw.prepare('SELECT source_kind, source_url, source_site_name FROM documents WHERE id = ?').get('web-doc') as { source_kind: string; source_url: string; source_site_name: string };
      expect(webRow.source_kind).toBe('web');
      expect(webRow.source_url).toBe('https://example.com/article');
      expect(webRow.source_site_name).toBe('Example Site');

      // 3. Incoherent insert: web doc missing source_url fails
      expect(() => {
        db.raw.prepare(insertSql).run('bad-web-1', 'Bad', '/b1.md', 'h-b1', 'web', null, 'Site', '2026-09-06T00:00:00.000Z');
      }).toThrow(/Incoherent document source/i);

      // 4. Incoherent insert: web doc missing source_captured_at fails
      expect(() => {
        db.raw.prepare(insertSql).run('bad-web-2', 'Bad', '/b2.md', 'h-b2', 'web', 'https://example.com', 'Site', null);
      }).toThrow(/Incoherent document source/i);

      // 5. Incoherent insert: user doc (source_kind null) with source_url populated fails
      expect(() => {
        db.raw.prepare(insertSql).run('bad-user-1', 'Bad', '/b3.md', 'h-b3', null, 'https://example.com', null, null);
      }).toThrow(/Incoherent document source/i);

      // 6. Incoherent update: setting source_url while source_kind is null fails
      expect(() => {
        db.raw.prepare("UPDATE documents SET source_url = 'https://hostile.example' WHERE id = 'user-doc'").run();
      }).toThrow(/Incoherent document source/i);

      // 7. Rewriting an existing web document's provenance is checked the same
      // way, so history cannot be edited into a shape the reader must distrust.
      expect(() => {
        db.raw.prepare("UPDATE documents SET source_url = 'https://user:pw@evil.example/x' WHERE id = 'web-doc'").run();
      }).toThrow(/Incoherent document source/i);
      expect(() => {
        db.raw.prepare("UPDATE documents SET source_url = NULL WHERE id = 'web-doc'").run();
      }).toThrow(/Incoherent document source/i);
      expect(() => {
        db.raw.prepare("UPDATE documents SET source_captured_at = 'whenever' WHERE id = 'web-doc'").run();
      }).toThrow(/Incoherent document source/i);
      expect(() => {
        db.raw.prepare("UPDATE documents SET source_kind = NULL WHERE id = 'web-doc'").run();
      }).toThrow(/Incoherent document source/i);

      // The row that survived all of that is untouched.
      const untouched = db.raw
        .prepare('SELECT source_kind, source_url, source_captured_at FROM documents WHERE id = ?')
        .get('web-doc') as { source_kind: string; source_url: string; source_captured_at: string };
      expect(untouched).toEqual({
        source_kind: 'web',
        source_url: 'https://example.com/article',
        source_captured_at: '2026-09-06T00:00:00.000Z',
      });
    });
  });

  // A source_url the reader could not trust is refused by the table itself, not
  // only by the schema above it. Each case is a shape a caller that skipped the
  // schema could otherwise have written straight into the column.
  it.each([
    { why: 'credentials in the authority', url: 'https://user:pw@example.com/article' },
    { why: 'bare userinfo', url: 'https://user@example.com/article' },
    { why: 'a fragment', url: 'https://example.com/article#section' },
    { why: 'a non-http scheme', url: 'file:///etc/passwd' },
    { why: 'a javascript scheme', url: 'javascript:alert(1)' },
    { why: 'no host', url: 'https:///article' },
    { why: 'no authority terminator', url: 'https://example.com' },
    { why: 'embedded whitespace', url: 'https://example.com/a b' },
    { why: 'an embedded newline', url: 'https://example.com/a\nb' },
    { why: 'excess length', url: `https://example.com/${'a'.repeat(2100)}` },
  ])('refuses a stored source_url with $why', ({ url }) => {
    withMigratedDatabase((db) => {
      expect(() => {
        db.raw
          .prepare(PROVENANCE_INSERT_SQL)
          .run('bad-url', 'Bad', '/bad.md', 'hash-bad', 'web', url, 'Site', CAPTURED_AT);
      }).toThrow(/Incoherent document source/i);
    });
  });

  it.each([
    { why: 'a vague word', capturedAt: 'yesterday' },
    { why: 'a date without a time', capturedAt: '2026-09-06' },
    { why: 'nothing at all', capturedAt: '' },
    { why: 'trailing text', capturedAt: '2026-09-06T00:00:00.000Z and then some more text here' },
  ])('refuses a stored source_captured_at that is $why', ({ capturedAt }) => {
    withMigratedDatabase((db) => {
      expect(() => {
        db.raw
          .prepare(PROVENANCE_INSERT_SQL)
          .run('bad-time', 'Bad', '/bad.md', 'hash-bad', 'web', 'https://example.com/a', 'Site', capturedAt);
      }).toThrow(/Incoherent document source/i);
    });
  });

  it.each([
    { why: 'empty', siteName: '' },
    { why: 'overlong', siteName: 'x'.repeat(257) },
    { why: 'multi-line', siteName: 'Site\nName' },
  ])('refuses a stored source_site_name that is $why', ({ siteName }) => {
    withMigratedDatabase((db) => {
      expect(() => {
        db.raw
          .prepare(PROVENANCE_INSERT_SQL)
          .run('bad-site', 'Bad', '/bad.md', 'hash-bad', 'web', 'https://example.com/a', siteName, CAPTURED_AT);
      }).toThrow(/Incoherent document source/i);
    });
  });

  it('validates documentSourceSchema and rejects extra or missing fields', () => {
    const valid = documentSourceSchema.parse({
      kind: 'web',
      url: 'https://example.com/article',
      siteName: 'Example Site',
      capturedAt: '2026-09-06T00:00:00.000Z',
    });
    expect(valid.kind).toBe('web');

    expect(() => documentSourceSchema.parse({
      kind: 'rss',
      url: 'https://example.com/feed',
    })).toThrow();

    expect(() => documentSourceSchema.parse({
      kind: 'web',
      url: 'https://example.com/article',
      siteName: 'Example',
      capturedAt: '2026-09-06T00:00:00.000Z',
      extraField: 'not-allowed',
    })).toThrow();

    expect(() => documentSourceSchema.parse({
      kind: 'web',
      url: 'https://example.com/article',
      siteName: 'Example',
    })).toThrow();
  });

  const webSource = (url: string, siteName: PortableValue = 'Example Site'): PortableRecord => ({
    kind: 'web',
    url,
    siteName,
    capturedAt: CAPTURED_AT,
  });

  it.each([
    'https://example.com/article',
    'http://example.com/',
    'https://example.com/a?utm_source=x&b=1',
    'https://example.com:8443/article',
    'https://xn--bcher-kva.example/a',
  ])('stores the canonical source URL %s', (url) => {
    expect(() => documentSourceSchema.parse(webSource(url))).not.toThrow();
  });

  it.each([
    // Credentials, which must never be persisted or shown back to the user.
    { why: 'carries credentials', url: 'https://user:pw@example.com/a' },
    { why: 'carries bare userinfo', url: 'https://user@example.com/a' },
    // Fragments, which are not part of what was fetched.
    { why: 'carries a fragment', url: 'https://example.com/a#top' },
    { why: 'carries an empty fragment', url: 'https://example.com/a#' },
    // Schemes the fetcher would never have used.
    { why: 'is a file URL', url: 'file:///etc/passwd' },
    { why: 'is a javascript URL', url: 'javascript:alert(1)' },
    { why: 'is a data URL', url: 'data:text/html,<script>' },
    { why: 'is an app asset URL', url: 'interleaf-asset://x/y' },
    // Not a URL, or not absolute.
    { why: 'is a bare path', url: '/relative/path' },
    { why: 'has no scheme', url: 'example.com/a' },
    { why: 'is empty', url: '' },
    // Not canonical: a second spelling of an address already storable above.
    { why: 'uppercases the scheme', url: 'HTTPS://example.com/a' },
    { why: 'uppercases the host', url: 'https://EXAMPLE.com/a' },
    { why: 'omits the authority terminator', url: 'https://example.com' },
    { why: 'states the default port', url: 'https://example.com:443/a' },
    { why: 'uses unencoded unicode', url: 'https://bücher.example/a' },
    { why: 'is padded with whitespace', url: ' https://example.com/a' },
    // Unbounded.
    { why: 'exceeds the length bound', url: `https://example.com/${'a'.repeat(2100)}` },
  ])('refuses a source URL that $why', ({ url }) => {
    expect(() => documentSourceSchema.parse(webSource(url))).toThrow();
  });

  it('accepts a site name that is single-line text or nothing at all', () => {
    expect(() => documentSourceSchema.parse(webSource('https://example.com/article', null))).not.toThrow();
    expect(() =>
      documentSourceSchema.parse(webSource('https://example.com/article', 'Example Site'))
    ).not.toThrow();
  });

  it.each([
    { why: 'empty', siteName: '' },
    { why: 'only whitespace', siteName: '   ' },
    { why: 'padded at the front', siteName: ' Example' },
    { why: 'padded at the end', siteName: 'Example ' },
    { why: 'multi-line', siteName: 'Example\nSite' },
    { why: 'carrying a control character', siteName: 'Example\u0000Site' },
    { why: 'overlong', siteName: 'x'.repeat(257) },
  ])('refuses a site name that is $why', ({ siteName }) => {
    expect(() => documentSourceSchema.parse(webSource('https://example.com/article', siteName))).toThrow();
  });

  it('consolidates legacy duplicate hashes before enforcing uniqueness', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 4));
      const insertSql = `INSERT INTO documents
           (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
         VALUES (?, ?, 'pdf', ?, 'link', 10, 1000, 'shared-hash')`;
      db.raw.prepare(insertSql).run('duplicate-old', 'Old', '/old.pdf');
      db.raw.prepare(insertSql).run('duplicate-new', 'New', '/new.pdf');
      db.raw.prepare(
        `INSERT INTO reading_positions (document_id, location_json, progress, updated_at)
         VALUES ('duplicate-old', '{"format":"pdf","pageIndex":7}', 0.7, '2026-01-02T00:00:00.000Z')`
      ).run();
      db.raw.prepare(
        `INSERT INTO annotations (id, document_id, type, anchor_json)
         VALUES ('legacy-annotation', 'duplicate-old', 'highlight', '{}')`
      ).run();
      db.raw.prepare(
        `INSERT INTO document_text_chunks
           (id, document_id, ordinal, text, token_count, location_json)
         VALUES ('legacy-chunk', 'duplicate-old', 0, 'legacy text', 2, '{}')`
      ).run();

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 4);
      const documents = db.raw
        .prepare("SELECT id FROM documents WHERE file_hash = 'shared-hash'")
        .all() as { id: string }[];
      expect(documents).toEqual([{ id: 'duplicate-new' }]);
      expect(
        db.raw.prepare("SELECT document_id FROM annotations WHERE id = 'legacy-annotation'").get()
      ).toMatchObject({ document_id: 'duplicate-new' });
      expect(
        db.raw.prepare("SELECT document_id FROM document_text_chunks WHERE id = 'legacy-chunk'").get()
      ).toBeUndefined();
      expect(
        db.raw.prepare("SELECT progress FROM reading_positions WHERE document_id = 'duplicate-new'").get()
      ).toMatchObject({ progress: 0.7 });
      // Verify unique constraint is enforced after migration
      expect(() => db.raw.prepare(insertSql).run('duplicate-third', 'Third', '/third.pdf')).toThrow();
    } finally {
      db.close();
    }
  });

  it('migrates Unicode-equivalent legacy folder names without suffix collisions', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 5));
      const insertLegacy = db.raw.prepare(
        `INSERT INTO folders (id, name, parent_id) VALUES (?, ?, NULL)`
      );
      insertLegacy.run('legacy-a', 'Résumé');
      insertLegacy.run('legacy-b', 'RÉSUMÉ');
      insertLegacy.run('legacy-c', 'Résumé (duplicate 1)');
      insertLegacy.run('legacy-greek-1', 'ΟΔΥΣΣΕΥΣ');
      insertLegacy.run('legacy-greek-2', 'οδυσσευσ');
      expect(runMigrations(db)).toBe(MIGRATIONS.length - 5);
      const rows = db.raw
        .prepare('SELECT id, name, name_key FROM folders ORDER BY id')
        .all() as { id: string; name: string; name_key: string }[];
      expect(rows.map((row) => row.name)).toEqual([
        'Résumé',
        'RÉSUMÉ',
        'Résumé (duplicate 1)',
        'ΟΔΥΣΣΕΥΣ',
        'οδυσσευσ',
      ]);
      expect(new Set(rows.map((row) => row.name_key)).size).toBe(5);
      const indexes = db.raw.prepare("PRAGMA index_list('folders')").all() as {
        name: string;
        unique: number;
      }[];
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'idx_folders_unique_root_name', unique: 1 }),
          expect.objectContaining({ name: 'idx_folders_unique_child_name', unique: 1 }),
        ])
      );

      const folders = new FolderRepository(db);
      expect(() => folders.create('legacy-d', 'résumé')).toThrow(/already exists/i);
      expect(() => folders.create('legacy-greek-3', 'οδυσσευς')).toThrow(/already exists/i);
      expect(() =>
        db.raw
          .prepare(
            "INSERT INTO folders (id, name, name_key, parent_id) VALUES ('duplicate-key', 'résumé', 'résumé', NULL)"
          )
          .run()
      ).toThrow(/unique/i);
      expect(() =>
        db.raw.prepare("INSERT INTO folders (id, name, parent_id) VALUES ('bad-key', 'New', NULL)").run()
      ).toThrow(/key mismatch/i);
    } finally {
      db.close();
    }
  });

  it('re-keys persisted v6 folders with the pinned full Unicode case-fold table', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 6));
      db.raw.exec(`
        DROP TRIGGER folders_name_key_insert_guard;
        DROP TRIGGER folders_name_key_update_guard;
        DROP INDEX idx_folders_unique_root_name;
        DROP INDEX idx_folders_unique_child_name;
      `);
      db.raw
        .prepare('INSERT INTO folders (id, name, name_key, parent_id) VALUES (?, ?, ?, NULL)')
        .run('v6-ligature', 'ﬀ', 'ﬀ');
      db.raw
        .prepare('INSERT INTO folders (id, name, name_key, parent_id) VALUES (?, ?, ?, NULL)')
        .run('v6-ascii', 'ff', 'ff');
      db.raw.exec(`
        CREATE UNIQUE INDEX idx_folders_unique_root_name
          ON folders(name_key) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX idx_folders_unique_child_name
          ON folders(parent_id, name_key) WHERE parent_id IS NOT NULL;
      `);

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 6);
      const rows = db.raw
        .prepare("SELECT name, name_key FROM folders WHERE id LIKE 'v6-%' ORDER BY id")
        .all() as { name: string; name_key: string }[];
      expect(rows.map((row) => row.name)).toEqual(['ff', 'ﬀ']);
      expect(new Set(rows.map((row) => row.name_key)).size).toBe(2);
      expect(() => new FolderRepository(db).create('new-ff', 'FF')).toThrow(/already exists/i);
    } finally {
      db.close();
    }
  });

  it('detects migration drift when an applied migration checksum changes', () => {
    withTempDatabase((db) => {
      runMigrations(db);
      // Tamper with checksum in schema_migrations
      db.raw
        .prepare("UPDATE schema_migrations SET checksum = '0000000000000000000000000000000000000000000000000000000000000000' WHERE version = 1")
        .run();
      expect(() => runMigrations(db)).toThrow(/drift detected/i);
    });
  });

  it('rejects unknown future migration versions before applying changes', () => {
    withTempDatabase((db) => {
      runMigrations(db);
      db.raw
        .prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future', ?)")
        .run('f'.repeat(64));
      expect(() => runMigrations(db)).toThrow(/newer|unknown|gap/i);
    });
  });

  it('rolls back an entire failing migration transaction', () => {
    const db = InterleafDatabase.open(':memory:');
    const failing: readonly Migration[] = [
      {
        version: 1,
        name: 'failing_migration',
        statements: ['CREATE TABLE must_rollback (id INTEGER)', 'THIS IS NOT SQL'],
      },
    ];
    try {
      expect(() => applyMigrations(db, failing)).toThrow(/failed/i);
      expect(
        db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get()
      ).toBeUndefined();
      expect(
        db.raw.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('enforces foreign key cascades', () => {
    withTempDatabase((db) => {
      runMigrations(db);
      db.raw
        .prepare(
          `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
           VALUES ('doc-1', 'Sample', 'pdf', '/library/sample.pdf', 'managed', 10, 1000, 'hash-1')`
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO annotations (id, document_id, type, anchor_json)
           VALUES ('ann-1', 'doc-1', 'highlight', '{}')`
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO document_text_chunks
             (id, document_id, ordinal, text, token_count, location_json)
           VALUES ('cascade-chunk', 'doc-1', 0, 'cascade sentinel', 2, '{}')`
        )
        .run();
      db.raw.prepare('DELETE FROM documents WHERE id = ?').run('doc-1');
      const remaining = db.raw.prepare('SELECT COUNT(*) AS n FROM annotations').get() as { n: number };
      expect(remaining.n).toBe(0);
      expect(
        db.raw.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH 'sentinel'").all()
      ).toHaveLength(0);
    });
  });
});

describe('default settings behavior', () => {
  it('database constraints reject direct-workspace profile defaults', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      for (const unsafeMode of ['active-env', 'native-restricted']) {
        expect(() => {
          db.raw
            .prepare(
              `INSERT INTO agent_profiles
                 (id, name, binary_path, default_args_json, default_sandbox_mode)
               VALUES (?, 'Unsafe', '/bin/agent', '[]', ?)`
            )
            .run(`profile-${unsafeMode}`, unsafeMode);
        }).toThrow();
      }
    } finally {
      db.close();
    }
  });
});

describe('settings repository', () => {
  it('degrades to defaults when stored JSON is corrupt — without crashing', () => {
    withTempDatabase((db) => {
      runMigrations(db);
      db.raw
        .prepare("UPDATE settings SET value_json = '{not json' WHERE key = 'app'")
        .run();
      const repo = new SettingsRepository(db, silentLogger);
      expect(repo.get()).toEqual(DEFAULT_APP_SETTINGS);
    });
  });
});
