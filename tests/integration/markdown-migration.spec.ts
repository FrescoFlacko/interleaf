import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import {
  applyMigrations,
  MIGRATIONS,
  runMigrations,
} from '@main/db/migrations';

describe('markdown migration (v14)', () => {
  it('rebuilds documents table with markdown format while preserving data', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      // Apply through v13
      applyMigrations(db, MIGRATIONS.slice(0, 13));

      // Insert a document before markdown migration
      db.raw.prepare(
        `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
         VALUES ('pre-md-doc', 'Existing PDF', 'pdf', '/existing.pdf', 'link', 100, 1000, 'existing-hash')`
      ).run();

      // Apply the markdown migration
      expect(runMigrations(db)).toBe(MIGRATIONS.length - 13);

      // Verify the existing document survived the table rebuild
      const doc = db.raw.prepare("SELECT * FROM documents WHERE id = 'pre-md-doc'").get() as {
        id: string; title: string; format: string; file_hash: string;
      };
      expect(doc).toMatchObject({ id: 'pre-md-doc', title: 'Existing PDF', format: 'pdf', file_hash: 'existing-hash' });

      // Verify the new CHECK constraint allows 'markdown'
      expect(() => {
        db.raw.prepare(
          `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
           VALUES ('md-doc', 'Test Markdown', 'markdown', '/test.md', 'link', 50, 2000, 'md-hash')`
        ).run();
      }).not.toThrow();

      // Verify the CHECK constraint still rejects invalid formats
      expect(() => {
        db.raw.prepare(
          `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
           VALUES ('bad-doc', 'Bad', 'txt', '/bad.txt', 'link', 10, 3000, 'bad-hash')`
        ).run();
      }).toThrow();

      // Verify indexes were recreated
      const indexes = (db.raw.prepare("PRAGMA index_list('documents')").all() as { name: string }[])
        .map((i) => i.name);
      expect(indexes).toContain('idx_documents_folder');
      expect(indexes).toContain('idx_documents_unique_hash');
      expect(indexes).toContain('idx_documents_format');
      expect(indexes).toContain('idx_documents_created_at');
      expect(indexes).toContain('idx_documents_updated_at');
      expect(indexes).toContain('idx_documents_title');
    } finally {
      db.close();
    }
  });

  it('preserves foreign key relationships during table rebuild', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 13));

      // Insert a document with dependent data (annotations, reading position)
      db.raw.prepare(
        `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
         VALUES ('fk-doc', 'FK Test', 'pdf', '/fk.pdf', 'link', 100, 1000, 'fk-hash')`
      ).run();
      db.raw.prepare(
        `INSERT INTO reading_positions (document_id, location_json, progress, updated_at)
         VALUES ('fk-doc', '{"format":"pdf","pageIndex":0}', 0.5, '2026-01-01T00:00:00.000Z')`
      ).run();
      db.raw.prepare(
        `INSERT INTO annotations (id, document_id, type, anchor_json, document_hash)
         VALUES ('fk-ann', 'fk-doc', 'bookmark', '{}', 'fk-hash')`
      ).run();

      // Apply v14 migration
      expect(runMigrations(db)).toBe(MIGRATIONS.length - 13);

      // Verify all dependent data survived
      expect(db.raw.prepare("SELECT progress FROM reading_positions WHERE document_id = 'fk-doc'").get())
        .toMatchObject({ progress: 0.5 });
      expect(db.raw.prepare("SELECT id FROM annotations WHERE document_id = 'fk-doc'").get())
        .toMatchObject({ id: 'fk-ann' });
    } finally {
      db.close();
    }
  });
});
