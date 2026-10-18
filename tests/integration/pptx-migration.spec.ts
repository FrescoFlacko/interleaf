import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, MIGRATIONS, runMigrations } from '@main/db/migrations';

const INSERT_DOCUMENT = `INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
  VALUES (?, ?, ?, ?, 'link', 10, 1000, ?)`;

describe('pptx document format migration (v25)', () => {
  it('widens the format CHECK while keeping rows, provenance, children, indexes and triggers', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 24));
      db.raw.prepare(INSERT_DOCUMENT).run('docx-doc', 'Existing Word', 'docx', '/a.docx', 'hash-a');
      db.raw.prepare(
        `UPDATE documents SET source_kind = 'web', source_url = 'https://example.test/a', source_captured_at = '2026-01-01T00:00:00Z' WHERE id = 'docx-doc'`
      ).run();
      db.raw.prepare(
        `INSERT INTO reading_positions (document_id, location_json, progress) VALUES ('docx-doc', '{}', 0.5)`
      ).run();
      expect(() => db.raw.prepare(INSERT_DOCUMENT).run('early', 'Deck', 'pptx', '/d.pptx', 'hash-early')).toThrow();

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 24);
      expect(MIGRATIONS[24]).toMatchObject({ version: 25, name: 'pptx_document_format', disableForeignKeys: true });

      expect(db.raw.prepare(`SELECT format, source_kind, source_url FROM documents WHERE id = 'docx-doc'`).get())
        .toEqual({ format: 'docx', source_kind: 'web', source_url: 'https://example.test/a' });
      expect(db.raw.prepare(`SELECT count(*) AS n FROM reading_positions WHERE document_id = 'docx-doc'`).get())
        .toEqual({ n: 1 });
      expect(() => db.raw.prepare(INSERT_DOCUMENT).run('deck', 'Deck', 'pptx', '/d.pptx', 'hash-deck')).not.toThrow();
      expect(() => db.raw.prepare(INSERT_DOCUMENT).run('bad', 'Bad', 'ppt', '/b.ppt', 'hash-bad')).toThrow();

      const indexes = (db.raw.prepare("PRAGMA index_list('documents')").all() as { name: string }[]).map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_documents_folder', 'idx_documents_unique_hash', 'idx_documents_format',
        'idx_documents_created_at', 'idx_documents_updated_at', 'idx_documents_title', 'idx_documents_source_kind',
      ]));
      // The v21 source coherence triggers still guard the rebuilt table.
      expect(() => db.raw.prepare(`UPDATE documents SET source_url = NULL WHERE id = 'docx-doc'`).run()).toThrow(/Incoherent document source/);
      expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // Deleting a document still cascades to children after the rename.
      db.raw.prepare(`DELETE FROM documents WHERE id = 'docx-doc'`).run();
      expect(db.raw.prepare(`SELECT count(*) AS n FROM reading_positions`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
