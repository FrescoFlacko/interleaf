import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, MIGRATIONS, runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { HighlightImportService } from '@main/highlight-import/import-service';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { LearningRepository } from '@main/db/repositories/learning-repository';
import { ExternalHighlightRepository } from '@main/db/repositories/external-highlight-repository';
import { PracticeRepository } from '@main/practice/repository';
import { ProposalRepository } from '@main/agent-access/proposal-repository';
import { importedPracticeResolver, indexedPracticeResolver, proposalIntegrationHandlers } from '@main/agent-access/integration-adapters';
import type { AgentSource } from '@shared/schemas/agent-access';

function fixture(db: InterleafDatabase, id: string, text: string): AgentSource {
  new DocumentRepository(db).insert({ id, title: `Title ${id}`, author: null, format: 'pdf', filePath: `/fixture-${id}.pdf`, storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: `hash-${id}`, pageCount: 1 });
  const search = new SearchRepository(db);
  const gen = search.begin(id, `hash-${id}`);
  search.append(id, `hash-${id}`, gen.generationId, [{ ordinal: 0, text, location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null }]);
  search.complete(id, `hash-${id}`, gen.generationId);
  const hit = search.search(id, text)[0];
  if (!hit) throw new Error('Missing indexed fixture');
  return { documentId: id, documentHash: `hash-${id}`, chunkId: hit.chunkId, anchor: { format: 'pdf', pageIndex: 0, quote: { exact: text, prefix: '', suffix: '' }, textStart: 0, textEnd: text.length } };
}

describe('combined learning source contracts', () => {
  it('upgrades the real base chain without changing existing data or foreign keys', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      expect(applyMigrations(db, MIGRATIONS.slice(0, 28))).toBe(28);
      new DocumentRepository(db).insert({ id: 'old', title: 'Old', author: null, format: 'pdf', filePath: '/old.pdf', storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: 'oldhash', pageCount: 1 });
      const base = db.raw.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      expect(runMigrations(db)).toBe(4);
      expect(runMigrations(db)).toBe(0);
      expect(db.raw.prepare('SELECT version, checksum FROM schema_migrations WHERE version <= 28 ORDER BY version').all()).toEqual(base);
      expect(db.raw.prepare('SELECT title FROM documents WHERE id = ?').get('old')).toMatchObject({ title: 'Old' });
      expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('accepts conflict and indexed card atomically, preserving provenance and refusing stale sources', () => {
    const db = InterleafDatabase.open(':memory:'); runMigrations(db);
    try {
      const one = fixture(db, 'one', 'Alpha passage');
      const two = fixture(db, 'two', 'Beta passage');
      const learning = new LearningRepository(db);
      const external = new ExternalHighlightRepository(db);
      const practice = new PracticeRepository(db, importedPracticeResolver(external), undefined, indexedPracticeResolver(db));
      const handlers = proposalIntegrationHandlers(db, learning, practice);
      const proposals = new ProposalRepository(db, { annotation: () => 'unused', ...handlers });
      const conflict = proposals.submit({ kind: 'conflict', source: one, secondSource: two, text: 'Compare.' });
      const accepted = proposals.resolve(conflict.id, 'accept');
      expect(accepted.resultId).toBeTruthy();
      expect(learning.list('one')[0]).toMatchObject({ id: accepted.resultId, provenance: { kind: 'proposal', proposalId: conflict.id }, content: { kind: 'conflict', secondary: { documentId: 'two' } } });
      expect(proposals.resolve(conflict.id, 'accept').resultId).toBe(accepted.resultId);
      const card = proposals.submit({ kind: 'card', source: one, text: 'Recall?' });
      const cardResult = proposals.resolve(card.id, 'accept');
      expect(practice.get(cardResult.resultId!)).toMatchObject({ evidence: 'Alpha passage', source: { kind: 'native', annotationId: null, chunkId: one.chunkId } });
      expect(practice.due({ limit: 20 })).toHaveLength(1);
      db.raw.prepare('UPDATE document_index_state SET published_document_hash = ? WHERE document_id = ?').run('replaced', 'one');
      expect(practice.get(cardResult.resultId!)?.sourceState).toBe('changed');
      db.raw.prepare('UPDATE document_index_state SET published_document_hash = ? WHERE document_id = ?').run('hash-one', 'one');
      const stale = proposals.submit({ kind: 'conflict', source: one, secondSource: two, text: 'Stale?' });
      db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('changed', 'two');
      expect(() => proposals.resolve(stale.id, 'accept')).toThrow();
      expect(proposals.list().map((entry) => entry.id)).toContain(stale.id);
      expect(learning.list('one')).toHaveLength(1);
    } finally { db.close(); }
  });
  it('rolls back domain creation on failure and rejects removed-artifact replay', () => {
    const db = InterleafDatabase.open(':memory:'); runMigrations(db);
    try {
      const source = fixture(db, 'one', 'Alpha passage');
      const learning = new LearningRepository(db);
      const external = new ExternalHighlightRepository(db);
      const practice = new PracticeRepository(db, importedPracticeResolver(external), undefined, indexedPracticeResolver(db));
      const handlers = proposalIntegrationHandlers(db, learning, practice);
      const failing = new ProposalRepository(db, { annotation: () => 'unused', ...handlers, learning: (input, context) => {
        if (!handlers.learning) throw new Error('Missing handler');
        handlers.learning(input, context);
        throw new Error('After creation');
      } });
      const pending = failing.submit({ kind: 'question', source, text: 'Why?' });
      expect(() => failing.resolve(pending.id, 'accept')).toThrow('After creation');
      expect(learning.list('one')).toEqual([]);
      expect(failing.list().map((item) => item.id)).toContain(pending.id);
      const normal = new ProposalRepository(db, { annotation: () => 'unused', ...handlers });
      const accepted = normal.resolve(pending.id, 'accept');
      expect(learning.remove('one', accepted.resultId!)).toBe(true);
      expect(() => normal.resolve(pending.id, 'accept')).toThrow(/no longer available/);
      expect(learning.list('one')).toEqual([]);
    } finally { db.close(); }
  });
  it('verifies an imported quote only against a unique current saved highlight and index', async () => {
    const db = InterleafDatabase.open(':memory:'); runMigrations(db);
    try {
      const source = fixture(db, 'one', 'Exact native quote');
      const annotations = new AnnotationRepository(db);
      const annotation = annotations.create({ documentId: 'one', type: 'highlight', selectedText: 'Exact native quote', color: 'yellow', anchor: source.anchor });
      const duplicate = annotations.create({ documentId: 'one', type: 'highlight', selectedText: 'Exact native quote', color: 'blue', anchor: source.anchor });
      const external = new ExternalHighlightRepository(db);
      external.commit([{ provider: 'kindle', title: 'Book', author: null, quote: 'Exact native quote', note: null, location: 'page 4', date: null }], new Map());
      const record = external.list(0)[0]!;
      external.associate(record.id, 'one');
      let healthy = false;
      const service = new HighlightImportService(external, () => Promise.resolve({ canceled: true, filePaths: [] }), undefined, () => Promise.resolve(healthy));
      await expect(service.verify(record.id)).rejects.toThrow(/unique/);
      annotations.delete('one', duplicate.id);
      db.raw.prepare('UPDATE document_text_chunks SET text = ? WHERE id = ?').run('Exact native quote and Exact native quote', source.chunkId);
      await expect(service.verify(record.id)).rejects.toThrow(/unique/);
      db.raw.prepare('UPDATE document_text_chunks SET text = ? WHERE id = ?').run('Exact native quote', source.chunkId);
      await expect(service.verify(record.id)).rejects.toThrow(/missing or changed/);
      const entered = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<boolean>();
      const delayed = new HighlightImportService(external, () => Promise.resolve({ canceled: true, filePaths: [] }), undefined,
        () => { entered.resolve(undefined); return finish.promise; });
      const pending = delayed.verify(record.id);
      await entered.promise;
      expect(delayed.admission.liveWork()).toBe(1);
      const shutdown = delayed.shutdown();
      finish.resolve(true);
      await expect(pending).rejects.toThrow(/shutting down/);
      await shutdown;
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      const checking = Promise.withResolvers<undefined>();
      const checked = Promise.withResolvers<boolean>();
      const raced = new HighlightImportService(external, () => Promise.resolve({ canceled: true, filePaths: [] }), undefined,
        () => { checking.resolve(undefined); return checked.promise; });
      const racing = raced.verify(record.id);
      await checking.promise;
      const laterDuplicate = annotations.create({ documentId: 'one', type: 'highlight', selectedText: 'Exact native quote', color: 'blue', anchor: source.anchor });
      checked.resolve(true);
      await expect(racing).rejects.toThrow(/ambiguous/);
      annotations.delete('one', laterDuplicate.id);
      await raced.shutdown();
      healthy = true;
      const verified = await service.verify(record.id);
      expect(verified).toMatchObject({ verifiedDocumentHash: 'hash-one', verifiedAnchor: source.anchor, location: 'page 4' });
      const practice = new PracticeRepository(db, importedPracticeResolver(external), undefined, indexedPracticeResolver(db));
      const card = practice.createFromImported({ importedHighlightId: record.id, question: 'What?' });
      expect(card).toMatchObject({ source: { kind: 'imported' }, sourceState: 'available', navigation: { annotationId: annotation.id, documentHash: 'hash-one', anchor: source.anchor } });
      db.raw.prepare('UPDATE document_index_state SET published_total_chunks = ? WHERE document_id = ?').run(2, 'one');
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      db.raw.prepare('UPDATE document_index_state SET published_total_chunks = ? WHERE document_id = ?').run(1, 'one');
      db.raw.prepare('UPDATE document_index_state SET published_document_hash = ? WHERE document_id = ?').run('stale', 'one');
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      expect(practice.get(card.id)).toMatchObject({ sourceState: 'export-only', navigation: null, evidence: 'Exact native quote' });
      db.raw.prepare('UPDATE document_index_state SET published_document_hash = ? WHERE document_id = ?').run('hash-one', 'one');
      const search = new SearchRepository(db);
      const next = search.begin('one', 'hash-one');
      search.append('one', 'hash-one', next.generationId, [{ ordinal: 0, text: 'Exact native quote', location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null }]);
      search.complete('one', 'hash-one', next.generationId);
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      expect((await service.verify(record.id))?.verifiedAnchor).toEqual(source.anchor);
      external.associate(record.id, 'one');
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      await service.verify(record.id);
      annotations.delete('one', annotation.id);
      expect(external.resolveSource(record.id)?.verifiedAnchor).toBeNull();
      await service.shutdown();
    } finally { db.close(); }
  });
  it('turns retained imported quotes into export-only practice evidence', () => {
    const db = InterleafDatabase.open(':memory:'); runMigrations(db);
    try {
      const external = new ExternalHighlightRepository(db);
      external.commit([{ provider: 'readwise', title: 'Book', author: 'Writer', quote: 'Imported quote', note: 'Note', location: 'page 5', date: null }], new Map());
      const record = external.list(0)[0]!;
      const practice = new PracticeRepository(db, importedPracticeResolver(external), undefined, indexedPracticeResolver(db));
      const card = practice.createFromImported({ importedHighlightId: record.id, question: 'What?' });
      expect(card).toMatchObject({ source: { kind: 'imported', importedHighlightId: record.id }, evidence: 'Imported quote', sourceState: 'export-only', navigation: null, exportDetails: { provider: 'readwise', location: 'page 5', note: 'Note' } });
      expect(practice.get(card.id)).toMatchObject({ sourceState: 'export-only', navigation: null });
    } finally { db.close(); }
  });
});
