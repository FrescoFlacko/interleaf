import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { buildExactFtsQuery, buildFtsQuery, SearchRepository } from '@main/db/repositories/search-repository';
import type { SearchIndexChunkInput } from '@shared/types/search';

function pdfChunk(ordinal: number, text: string, pageIndex = ordinal): SearchIndexChunkInput {
  return {
    ordinal,
    text,
    location: { format: 'pdf', pageIndex },
    heading: `Section ${String(ordinal + 1)}`,
    pageLabel: String(pageIndex + 1),
  };
}

function chunk(
  ordinal: number,
  text: string,
  location: SearchIndexChunkInput['location'],
  pageLabel: string | null = null
): SearchIndexChunkInput {
  return { ordinal, text, location, heading: null, pageLabel };
}

function publish(
  repository: SearchRepository,
  documentId: string,
  documentHash: string,
  chunks: readonly SearchIndexChunkInput[]
): void {
  const generation = repository.begin(documentId, documentHash);
  repository.append(documentId, documentHash, generation.generationId, chunks);
  repository.complete(documentId, documentHash, generation.generationId);
}

describe('SearchRepository', () => {
  let db: InterleafDatabase;
  let search: SearchRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    const documents = new DocumentRepository(db);
    documents.insert({
      id: 'doc-pdf',
      title: 'Distributed Systems',
      author: 'A. Author',
      format: 'pdf',
      filePath: '/books/distributed.pdf',
      storageMode: 'link',
      fileSize: 100,
      fileMtimeMs: 1,
      fileHash: 'hash-v1',
      pageCount: 20,
    });
    documents.insert({
      id: 'doc-docx',
      title: 'Consensus Notes',
      author: null,
      format: 'docx',
      filePath: '/books/notes.docx',
      storageMode: 'link',
      fileSize: 80,
      fileMtimeMs: 1,
      fileHash: 'docx-hash',
      pageCount: null,
    });
    search = new SearchRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('publishes staged chunks atomically and returns provenance for document and library search', () => {
    const first = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', first.generationId, [
      pdfChunk(0, 'Leader based replication provides fault tolerance.'),
      pdfChunk(1, 'Quorum consensus requires overlapping voters.'),
    ]);

    expect(search.search('doc-pdf', 'replication')).toEqual([]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_text_chunks WHERE document_id = 'doc-pdf'").get())
      .toMatchObject({ count: 0 });

    expect(search.complete('doc-pdf', 'hash-v1', first.generationId)).toMatchObject({
      status: 'ready',
      totalChunks: 2,
      indexedChunks: 2,
      documentHash: 'hash-v1',
    });
    expect(search.search('doc-pdf', 'replication')).toEqual([
      expect.objectContaining({
        documentId: 'doc-pdf',
        documentTitle: 'Distributed Systems',
        documentAuthor: 'A. Author',
        documentHash: 'hash-v1',
        heading: 'Section 1',
        pageLabel: '1',
        location: { format: 'pdf', pageIndex: 0 },
      }),
    ]);
    expect(search.search(undefined, 'consensus')).toHaveLength(1);

    const replacement = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', replacement.generationId, [
      pdfChunk(0, 'A state machine applies committed log entries.'),
    ]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_text_chunks WHERE document_id = 'doc-pdf'").get())
      .toMatchObject({ count: 2 });
    expect(search.search('doc-pdf', 'replication')).toHaveLength(1);
    search.complete('doc-pdf', 'hash-v1', replacement.generationId);
    expect(search.search('doc-pdf', 'replication')).toEqual([]);
    expect(search.search('doc-pdf', 'committed')).toHaveLength(1);
  });

  it('orders document hits by native page location even when BM25 prefers a later page', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', generation.generationId, [
      pdfChunk(0, 'location needle'),
      pdfChunk(1, 'location needle needle'),
      pdfChunk(2, 'location needle needle needle needle needle needle', 9),
    ]);
    search.complete('doc-pdf', 'hash-v1', generation.generationId);

    const hits = search.search('doc-pdf', 'needle');
    expect(hits.map((hit) => hit.location)).toEqual([
      { format: 'pdf', pageIndex: 0 },
      { format: 'pdf', pageIndex: 1 },
      { format: 'pdf', pageIndex: 9 },
    ]);
    // The fixture deliberately makes page 10 the strongest BM25 match. Rank
    // remains available as metadata while location owns visible ordering.
    expect(hits[2]?.rank).toBeLessThan(hits[0]?.rank ?? Number.POSITIVE_INFINITY);
  });

  it('returns all hash-bound exact term ranges in chunk-relative native order', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    const text = 'Architecture comes first; a catalogue follows.';
    search.append('doc-pdf', 'hash-v1', generation.generationId, [{
      ...pdfChunk(0, text),
      location: { format: 'pdf', pageIndex: 0, textStart: 0, textEnd: text.length },
    }]);
    search.complete('doc-pdf', 'hash-v1', generation.generationId);
    const [hit] = search.search('doc-pdf', 'catalogue architecture');
    expect(hit?.anchor?.ranges.map((range) => range.text)).toEqual(['Architecture', 'catalogue']);
    expect(hit?.anchor?.documentHash).toBe('hash-v1');
    expect(search.resolveHit('doc-pdf', 'hash-v1', hit!.chunkId, 'catalogue architecture')?.ranges)
      .toEqual(hit?.anchor?.ranges);
    // Multi-word search stays AND over exact tokens: a term the chunk lacks
    // removes the result entirely rather than degrading to a partial match.
    expect(search.search('doc-pdf', 'catalogue consensus')).toEqual([]);
    expect(search.search('doc-pdf', 'cat arch')).toEqual([]);
  });

  it('retrieves only exact whole-token matches, in any casing, past the porter-stemmed index', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    const exactText = 'The FoRmAt of the report is fixed.';
    search.append('doc-pdf', 'hash-v1', generation.generationId, [
      {
        ...pdfChunk(0, exactText),
        location: { format: 'pdf', pageIndex: 0, textStart: 0, textEnd: exactText.length },
      },
      pdfChunk(1, 'Several formats, formatted output and formatting rules apply.'),
      pdfChunk(2, 'Cluster formation completes.'),
    ]);
    search.complete('doc-pdf', 'hash-v1', generation.generationId);

    // Every one of these chunks is an FTS5 `MATCH` candidate for `format`,
    // because `porter` stems formats/formatted/formatting onto the same term.
    const candidates = db.raw
      .prepare("SELECT COUNT(*) AS count FROM document_fts WHERE document_fts MATCH '\"format\"'")
      .get() as { count: number };
    expect(candidates.count).toBeGreaterThan(1);

    for (const query of ['format', 'FORMAT', 'Format', 'FoRmAt']) {
      const hits = search.search('doc-pdf', query);
      expect(hits.map((hit) => hit.ordinal)).toEqual([0]);
      expect(hits[0]?.anchor?.ranges.map((range) => range.text)).toEqual(['FoRmAt']);
      expect(hits[0]?.excerpt).toContain('FoRmAt');
    }
    expect(search.search('doc-pdf', 'formats').map((hit) => hit.ordinal)).toEqual([1]);
    expect(search.search('doc-pdf', 'formation').map((hit) => hit.ordinal)).toEqual([2]);
    expect(search.search('doc-pdf', 'formatter')).toEqual([]);
  });

  it('uses native order and deterministic ties for every supported document format', () => {
    const documents = new DocumentRepository(db);
    const fixtures = [
      {
        id: 'doc-markdown', title: 'Markdown', format: 'markdown' as const, hash: 'markdown-hash',
        chunks: [
          chunk(0, 'markdown needle', { format: 'markdown', blockIndex: 4, lineIndex: 2, characterStart: 10, characterEnd: 24 }),
          chunk(1, 'markdown needle', { format: 'markdown', blockIndex: 1, lineIndex: 8 }),
          chunk(2, 'markdown needle', { format: 'markdown', blockIndex: 1, lineIndex: 8, characterStart: 20, characterEnd: 34 }),
        ],
      },
      {
        id: 'doc-epub', title: 'EPUB', format: 'epub' as const, hash: 'epub-hash',
        chunks: [
          chunk(0, 'epub needle', { format: 'epub', cfi: 'epubcfi(/6/6)', progression: 0.1 }),
          chunk(1, 'epub needle', { format: 'epub', cfi: 'epubcfi(/6/2)', progression: 0.8 }),
          chunk(2, 'epub needle', { format: 'epub', cfi: 'epubcfi(/6/2)', progression: 0.2 }),
        ],
      },
      {
        id: 'doc-mobi', title: 'MOBI', format: 'mobi' as const, hash: 'mobi-hash',
        chunks: [
          chunk(0, 'mobi needle', { format: 'mobi', sectionIndex: 4, byteOffset: 10 }),
          chunk(1, 'mobi needle', { format: 'mobi', sectionIndex: 1, byteOffset: 20 }),
          chunk(2, 'mobi needle', { format: 'mobi', sectionIndex: 1, byteOffset: 5 }),
        ],
      },
      {
        id: 'doc-docx-order', title: 'DOCX order', format: 'docx' as const, hash: 'docx-order-hash',
        chunks: [
          chunk(0, 'docx needle', { format: 'docx', paragraphIndex: 4, renderedPageIndex: 2 }),
          chunk(1, 'docx needle', { format: 'docx', paragraphIndex: 1, renderedPageIndex: 1 }),
          chunk(2, 'docx needle', { format: 'docx', paragraphIndex: 0, renderedPageIndex: 1, characterStart: 20, characterEnd: 34 }),
        ],
      },
    ] as const;

    for (const fixture of fixtures) {
      documents.insert({
        id: fixture.id, title: fixture.title, author: null, format: fixture.format,
        filePath: `/books/${fixture.id}`, storageMode: 'link', fileSize: 10, fileMtimeMs: 1,
        fileHash: fixture.hash, pageCount: null,
      });
      publish(search, fixture.id, fixture.hash, fixture.chunks);
      expect(search.search(fixture.id, 'needle')).toHaveLength(fixture.chunks.length);
    }

    expect(search.search('doc-markdown', 'needle').map((hit) => hit.location)).toEqual([
      { format: 'markdown', blockIndex: 1, lineIndex: 8 },
      { format: 'markdown', blockIndex: 1, lineIndex: 8, characterStart: 20, characterEnd: 34 },
      { format: 'markdown', blockIndex: 4, lineIndex: 2, characterStart: 10, characterEnd: 24 },
    ]);
    expect(search.search('doc-epub', 'needle').map((hit) => hit.location)).toEqual([
      { format: 'epub', cfi: 'epubcfi(/6/2)', progression: 0.2 },
      { format: 'epub', cfi: 'epubcfi(/6/2)', progression: 0.8 },
      { format: 'epub', cfi: 'epubcfi(/6/6)', progression: 0.1 },
    ]);
    expect(search.search('doc-mobi', 'needle').map((hit) => hit.location)).toEqual([
      { format: 'mobi', sectionIndex: 1, byteOffset: 5 },
      { format: 'mobi', sectionIndex: 1, byteOffset: 20 },
      { format: 'mobi', sectionIndex: 4, byteOffset: 10 },
    ]);
    expect(search.search('doc-docx-order', 'needle').map((hit) => hit.location)).toEqual([
      { format: 'docx', paragraphIndex: 0, renderedPageIndex: 1, characterStart: 20, characterEnd: 34 },
      { format: 'docx', paragraphIndex: 1, renderedPageIndex: 1 },
      { format: 'docx', paragraphIndex: 4, renderedPageIndex: 2 },
    ]);
  });

  it('orders library hits by title, then native location, with stable same-location ties', () => {
    const documents = new DocumentRepository(db);
    documents.insert({
      id: 'doc-library-zulu', title: 'Zulu Research', author: null, format: 'pdf',
      filePath: '/books/zulu.pdf', storageMode: 'link', fileSize: 10, fileMtimeMs: 1,
      fileHash: 'zulu-hash', pageCount: 12,
    });
    documents.insert({
      id: 'doc-library-alpha', title: 'Alpha Research', author: null, format: 'pdf',
      filePath: '/books/alpha.pdf', storageMode: 'link', fileSize: 10, fileMtimeMs: 1,
      fileHash: 'alpha-hash', pageCount: 12,
    });
    publish(search, 'doc-library-zulu', 'zulu-hash', [
      pdfChunk(0, 'shared needle', 9),
      pdfChunk(1, 'shared needle', 1),
    ]);
    publish(search, 'doc-library-alpha', 'alpha-hash', [
      pdfChunk(0, 'shared needle', 2),
      pdfChunk(1, 'shared needle', 2),
    ]);

    const hits = search.search(undefined, 'needle');
    expect(hits.map((hit) => `${hit.documentTitle}:${String(hit.location.format === 'pdf' ? hit.location.pageIndex : -1)}:${String(hit.ordinal)}`)).toEqual([
      'Alpha Research:2:0',
      'Alpha Research:2:1',
      'Zulu Research:1:1',
      'Zulu Research:9:0',
    ]);
    expect(hits.every((hit) => typeof hit.rank === 'number')).toBe(true);
  });

  it('falls back to ordinal for legacy chunks without derived location keys and keeps the limit bounded', () => {
    const documents = new DocumentRepository(db);
    documents.insert({
      id: 'doc-legacy', title: 'Legacy', author: null, format: 'pdf',
      filePath: '/books/legacy.pdf', storageMode: 'link', fileSize: 10, fileMtimeMs: 1,
      fileHash: 'legacy-hash', pageCount: 20,
    });
    db.raw.prepare(`
      INSERT INTO document_index_state (
        document_id, status, total_chunks, indexed_chunks, error_message,
        document_hash, published_document_hash, published_total_chunks
      ) VALUES ('doc-legacy', 'ready', 3, 3, NULL, 'legacy-hash', 'legacy-hash', 3)
    `).run();
    const insert = db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES (?, 'doc-legacy', ?, ?, 2, ?, NULL, NULL)
    `);
    insert.run('legacy:0', 0, 'legacy needle', JSON.stringify({ format: 'pdf', pageIndex: 10 }));
    insert.run('legacy:1', 1, 'legacy needle', JSON.stringify({ format: 'pdf', pageIndex: 1 }));
    insert.run('legacy:2', 2, 'legacy needle', JSON.stringify({ format: 'pdf', pageIndex: 2 }));
    search.rebuildFts();

    expect(search.search('doc-legacy', 'needle', 2).map((hit) => hit.ordinal)).toEqual([0, 1]);
    expect(search.search('doc-legacy', 'needle', 100)).toHaveLength(3);
  });

  it('rejects stale revisions, replayed generations, gaps, and cross-format locations', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    expect(() => search.append('doc-pdf', 'hash-v1', generation.generationId, [pdfChunk(1, 'gap')]))
      .toThrow(/contiguous/i);
    expect(() =>
      search.append('doc-pdf', 'hash-v1', generation.generationId, [{
        ordinal: 0,
        text: 'wrong format',
        location: { format: 'docx', paragraphIndex: 0 },
        heading: null,
        pageLabel: null,
      }])
    ).toThrow(/format/i);

    const superseding = search.begin('doc-pdf', 'hash-v1');
    expect(() => search.append('doc-pdf', 'hash-v1', generation.generationId, [pdfChunk(0, 'replay')]))
      .toThrow(/stale|unavailable/i);
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-pdf'").run();
    expect(() => search.append('doc-pdf', 'hash-v1', superseding.generationId, [pdfChunk(0, 'stale')]))
      .toThrow(/changed/i);
    expect(() => search.complete('doc-pdf', 'hash-v1', superseding.generationId)).toThrow(/changed/i);
  });

  it('bounds and sanitizes FTS syntax rather than passing raw MATCH expressions', () => {
    // Recall-oriented builder, still used by ADR-0006 Level-3 AI retrieval.
    expect(buildFtsQuery('  C++ distributed-system "quoted"  ')).toBe('"C"* AND "distributed"* AND "system"* AND "quoted"*');
    expect(() => buildFtsQuery('*** "" ()')).toThrow(/letter or number/i);
    // User-facing builder: same quoting and AND, no prefix operator.
    expect(buildExactFtsQuery('  C++ distributed-system "quoted"  ')).toBe('"C" AND "distributed" AND "system" AND "quoted"');
    expect(buildExactFtsQuery('say "hi" there')).toBe('"say" AND "hi" AND "there"');
    // `___` is a token here but indexes to nothing under unicode61, so it must
    // not reach FTS5 as an empty phrase.
    expect(() => buildExactFtsQuery('___')).toThrow(/letter or number/i);
    expect(() => search.search(undefined, '***')).toThrow(/letter or number/i);
    expect(() => search.search(undefined, '___')).toThrow(/letter or number/i);
  });

  it('cleans failed and interrupted staging while retaining the last committed chunks', () => {
    const initial = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', initial.generationId, [pdfChunk(0, 'durable committed evidence')]);
    search.complete('doc-pdf', 'hash-v1', initial.generationId);

    const failed = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', failed.generationId, [pdfChunk(0, 'temporary staging')]);
    expect(search.fail('doc-pdf', 'hash-v1', failed.generationId, 'Extraction failed.')).toMatchObject({
      status: 'failed',
      errorMessage: 'Extraction failed.',
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM document_text_chunks WHERE document_id = 'doc-pdf'").get())
      .toMatchObject({ count: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_index_staging_chunks').get())
      .toMatchObject({ count: 0 });
    expect(search.search('doc-pdf', 'durable')).toHaveLength(1);

    const interrupted = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', interrupted.generationId, [pdfChunk(0, 'interrupted staging')]);
    search = new SearchRepository(db);
    expect(search.getState('doc-pdf')).toMatchObject({
      status: 'failed',
      errorMessage: 'Indexing was interrupted before completion.',
    });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_index_staging_chunks').get())
      .toMatchObject({ count: 0 });
  });

  it('rebuilds and integrity-checks the external-content FTS index', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', generation.generationId, [pdfChunk(0, 'rebuild target')]);
    search.complete('doc-pdf', 'hash-v1', generation.generationId);
    expect(() => { search.rebuildFts(); }).not.toThrow();
    expect(search.search(undefined, 'rebuild')).toHaveLength(1);
  });

  it('enforces cumulative generation limits in the main-owned transaction', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    db.raw.prepare(`
      UPDATE document_index_state SET indexed_chunks = 100000, total_chunks = 100000
       WHERE document_id = 'doc-pdf'
    `).run();
    expect(() => search.append('doc-pdf', 'hash-v1', generation.generationId, [
      pdfChunk(100000, 'one more chunk'),
    ])).toThrow(/too many searchable chunks/i);

    db.raw.prepare(`
      UPDATE document_index_state
         SET indexed_chunks = 0, total_chunks = 0, indexed_text_units = 100000000
       WHERE document_id = 'doc-pdf'
    `).run();
    expect(() => search.append('doc-pdf', 'hash-v1', generation.generationId, [
      pdfChunk(0, 'one more unit'),
    ])).toThrow(/safe indexing size limit/i);
  });

  it('revalidates a result revision and committed chunk before navigation', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', generation.generationId, [{
      ...pdfChunk(0, 'revision bound result'),
      location: { format: 'pdf', pageIndex: 0, textStart: 0, textEnd: 'revision bound result'.length },
    }]);
    search.complete('doc-pdf', 'hash-v1', generation.generationId);
    const [hit] = search.search('doc-pdf', 'revision');
    expect(hit).toBeDefined();
    const anchor = search.resolveHit('doc-pdf', 'hash-v1', hit!.chunkId, 'revision');
    expect(anchor?.location).toEqual({ format: 'pdf', pageIndex: 0, textStart: 0, textEnd: 'revision bound result'.length });
    expect(anchor?.ranges[0]?.text).toBe('revision');
    expect(search.resolveHit('doc-pdf', 'wrong-hash', hit!.chunkId, 'revision')).toBeNull();
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-pdf'").run();
    expect(search.resolveHit('doc-pdf', 'hash-v1', hit!.chunkId, 'revision')).toBeNull();
  });
});
