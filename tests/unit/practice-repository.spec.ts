import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { PracticeRepository } from '@main/practice/repository';

describe('practice repository', () => {
  it('scopes highlights to their document, persists scheduling, and reports a deleted source', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      for (const id of ['one', 'two']) db.raw.prepare(`INSERT INTO documents
        (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES (?, ?, 'pdf', '/fixture', 'managed', 1, 1, ?)`).run(id, id, `${id}-hash`);
      const annotations = new AnnotationRepository(db);
      const highlight = annotations.create({ documentId: 'one', type: 'highlight',
        anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'evidence', prefix: '', suffix: '' } },
        selectedText: 'evidence', color: 'yellow' });
      let time = new Date('2026-01-01T00:00:00.000Z');
      const repo = new PracticeRepository(db, () => null, () => time);
      expect(() => repo.createFromHighlight({ documentId: 'two', annotationId: highlight.id, question: 'Why?' })).toThrow();
      const card = repo.createFromHighlight({ documentId: 'one', annotationId: highlight.id, question: 'Why?' });
      expect(repo.due({ limit: 10 })).toHaveLength(1);
      const rated = repo.rate({ cardId: card.id, revision: 0, rating: 'good' });
      expect(rated.intervalDays).toBe(2);
      expect(() => repo.rate({ cardId: card.id, revision: 0, rating: 'easy' })).toThrow();
      expect(repo.due({ limit: 10 })).toHaveLength(0);
      time = new Date('2026-01-03T00:00:00.000Z');
      expect(new PracticeRepository(db, () => null, () => time).due({ limit: 10 })).toHaveLength(1);
      annotations.delete('one', highlight.id);
      expect(repo.get(card.id)?.sourceState).toBe('missing');
    } finally { db.close(); }
  });
  it('accepts verified proposal passages idempotently inside the caller transaction', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      db.raw.prepare(`INSERT INTO documents (id,title,format,file_path,storage_mode,file_size,file_mtime_ms,file_hash)
        VALUES ('doc','Book','pdf','/fixture','managed',1,1,'hash')`).run();
      const repo = new PracticeRepository(db, () => null, () => new Date('2026-01-01T00:00:00Z'), (_source, chunk) =>
        chunk === 'chunk' ? { evidence: 'Verified text', label: 'Book' } : null);
      const source = { kind: 'native' as const, documentId: 'doc', documentHash: 'hash', annotationId: null,
        anchor: { format: 'pdf' as const, pageIndex: 0, quote: { exact: 'Verified text', prefix: '', suffix: '' } } };
      const input = { source, chunkId: 'chunk', question: 'Why?', idempotencyKey: 'proposal' };
      db.raw.exec('BEGIN IMMEDIATE');
      repo.acceptVerifiedPassage(input);
      db.raw.exec('ROLLBACK');
      expect(repo.due({ limit: 10 })).toHaveLength(0);
      db.raw.exec('BEGIN IMMEDIATE');
      const card = repo.acceptVerifiedPassage(input);
      db.raw.exec('COMMIT');
      expect(repo.acceptVerifiedPassage(input).id).toBe(card.id);
      expect(() => repo.acceptVerifiedPassage({ ...input, question: 'Different?' })).toThrow();
      expect(repo.due({ limit: 10 })).toHaveLength(1);
    } finally { db.close(); }
  });
  it('retains maximum-sized import evidence and metadata without inventing a native location', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      const quote = 'q'.repeat(20000);
      const details = { provider: 'readwise' as const, title: 't'.repeat(250), author: 'a'.repeat(150),
        location: 'l'.repeat(32000), date: null, note: 'n'.repeat(32000) };
      let present = true;
      const repo = new PracticeRepository(db, () => present ? ({ evidence: quote, label: `Readwise: ${details.title} — ${details.author}`, details, native: null }) : null);
      const card = repo.createFromImported({ importedHighlightId: 'imported', question: 'Why?' });
      expect(card.evidence).toBe(quote);
      expect(card.exportDetails).toEqual(details);
      expect(card.sourceState).toBe('export-only');
      expect(card.navigation).toBeNull();
      present = false;
      expect(repo.get(card.id)?.sourceState).toBe('missing');
    } finally { db.close(); }
  });
});
