import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, MIGRATIONS, runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
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
      const handlers = proposalIntegrationHandlers(learning, practice);
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
      const stale = proposals.submit({ kind: 'conflict', source: one, secondSource: two, text: 'Stale?' });
      db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('changed', 'two');
      expect(() => proposals.resolve(stale.id, 'accept')).toThrow();
      expect(proposals.list().map((entry) => entry.id)).toContain(stale.id);
      expect(learning.list('one')).toHaveLength(1);
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
