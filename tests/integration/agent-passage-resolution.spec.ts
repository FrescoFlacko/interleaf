import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { ReadingPositionRepository } from '@main/db/repositories/reading-position-repository';
import { LibraryReader } from '@main/agent-access/library-reader';
import { makePassageLink, parsePassageLink } from '@main/agent-access/passage-link';

describe('revision-bound exact passage resolution', () => {
  it('re-resolves the actual matched token beyond bounded passage output and rejects tampering and stale revisions', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      new DocumentRepository(db).insert({ id: 'doc', title: 'Long fixture', author: null, format: 'markdown', filePath: '/fixture.md', storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: 'hash', pageCount: 1 });
      const search = new SearchRepository(db);
      const text = `${'ordinary '.repeat(2000)}EXACTPASSAGEMARKER tail`;
      const generation = search.begin('doc', 'hash');
      search.append('doc', 'hash', generation.generationId, [{ ordinal: 0, text, location: { format: 'markdown', blockIndex: 1, characterStart: 250, characterEnd: 250 + text.length }, heading: null, pageLabel: null }]);
      search.complete('doc', 'hash', generation.generationId);
      const hit = search.search('doc', 'EXACTPASSAGEMARKER')[0];
      if (!hit) throw new Error('missing search hit');
      const reader = new LibraryReader(db, search, new AnnotationRepository(db), new ReadingPositionRepository(db));
      const reference = parsePassageLink(makePassageLink({ documentId: 'doc', documentHash: 'hash', chunkId: hit.chunkId, query: 'EXACTPASSAGEMARKER' }));
      expect(reader.getPassage({ documentId: reference.documentId, documentHash: reference.documentHash, chunkId: reference.chunkId }).truncated).toBe(true);
      expect(reader.resolvePassage(reference)).toEqual({ documentId: 'doc', documentHash: 'hash', anchor: { format: 'markdown', blockIndex: 1, characterStart: 18250, characterEnd: 18268, quote: { exact: 'EXACTPASSAGEMARKER', prefix: '', suffix: '' } } });
      expect(() => reader.resolvePassage({ ...reference, query: 'absent' })).toThrow(/unavailable/);
      expect(() => reader.resolvePassage({ documentId: 'doc', documentHash: 'hash', chunkId: hit.chunkId })).toThrow(/exact passage/);
      db.raw.prepare("UPDATE documents SET file_hash = 'changed' WHERE id = 'doc'").run();
      expect(() => reader.resolvePassage(reference)).toThrow(/changed/);
    } finally { db.close(); }
  });
});
