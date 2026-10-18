import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import type { SearchIndexChunkInput } from '@shared/types/search';

const CHUNK_TEXTS = [
  'Leader based replication provides fault tolerance across replicas.',
  'Quorum consensus requires overlapping voter sets to stay correct.',
  'A state machine applies committed log entries in a fixed order.',
] as const;

/** Extracted UTF-16 text units, exactly what `indexed_text_units` accumulates. */
const TOTAL_TEXT_UNITS = CHUNK_TEXTS.reduce((total, text) => total + text.length, 0);
const EXPECTED_TOKENS = Math.ceil(TOTAL_TEXT_UNITS / 4);

function chunkAt(ordinal: number): SearchIndexChunkInput {
  return {
    ordinal,
    text: CHUNK_TEXTS[ordinal] ?? '',
    location: { format: 'pdf', pageIndex: ordinal },
    heading: null,
    pageLabel: String(ordinal + 1),
  };
}

const CHUNKS = CHUNK_TEXTS.map((_, ordinal) => chunkAt(ordinal));

describe('SearchRepository estimated token count', () => {
  let db: InterleafDatabase;
  let search: SearchRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-pdf',
      title: 'Distributed Systems',
      author: 'A. Author',
      format: 'pdf',
      filePath: '/books/distributed.pdf',
      storageMode: 'link',
      fileSize: 9_999_999,
      fileMtimeMs: 1,
      fileHash: 'hash-v1',
      pageCount: 20,
    });
    search = new SearchRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function publish(documentHash: string): void {
    const generation = search.begin('doc-pdf', documentHash);
    search.append('doc-pdf', documentHash, generation.generationId, CHUNKS);
    search.complete('doc-pdf', documentHash, generation.generationId);
  }

  it('derives the estimate from indexed text units divided by four, not file size', () => {
    publish('hash-v1');

    const state = search.getState('doc-pdf');
    expect(state?.status).toBe('ready');
    expect(state?.estimatedTokens).toBe(EXPECTED_TOKENS);
    // File size is 9,999,999 bytes: a size-derived estimate would be far larger.
    expect(state?.estimatedTokens).toBeLessThan(1_000);
    expect(db.raw.prepare('SELECT indexed_text_units AS units FROM document_index_state WHERE document_id = ?')
      .get('doc-pdf')).toMatchObject({ units: TOTAL_TEXT_UNITS });
  });

  it('reports no estimate while indexing is still in progress', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', generation.generationId, CHUNKS);

    const state = search.getState('doc-pdf');
    expect(state?.status).toBe('indexing');
    expect(state?.estimatedTokens).toBeNull();
  });

  it('reports no estimate for a failed index generation', () => {
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.append('doc-pdf', 'hash-v1', generation.generationId, CHUNKS);
    const failed = search.fail('doc-pdf', 'hash-v1', generation.generationId, 'Extraction failed.');

    expect(failed.status).toBe('failed');
    expect(failed.estimatedTokens).toBeNull();
    expect(search.getState('doc-pdf')?.estimatedTokens).toBeNull();
  });

  it('reports no estimate when the index belongs to a superseded document revision', () => {
    publish('hash-v1');
    expect(search.getState('doc-pdf')?.estimatedTokens).toBe(EXPECTED_TOKENS);

    // The file changed on disk: the published index no longer describes the
    // current revision, so a stale estimate must not be shown.
    db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('hash-v2', 'doc-pdf');

    expect(search.getState('doc-pdf')?.estimatedTokens).toBeNull();
  });

  it('reports the exact estimate zero for a ready index that extracted no text', () => {
    // A document whose extraction legitimately produced nothing still has a
    // ready index of the current published revision, so ceil(0 / 4) is a
    // trustworthy answer rather than an unknown one.
    const generation = search.begin('doc-pdf', 'hash-v1');
    search.complete('doc-pdf', 'hash-v1', generation.generationId);

    const state = search.getState('doc-pdf');
    expect(state?.status).toBe('ready');
    expect(state?.estimatedTokens).toBe(0);
  });

  it('returns no state at all for a document that was never indexed', () => {
    expect(search.getState('doc-pdf')).toBeNull();
  });

  it('re-derives the estimate after the document is re-indexed', () => {
    publish('hash-v1');
    db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('hash-v2', 'doc-pdf');

    const generation = search.begin('doc-pdf', 'hash-v2');
    const shortChunk: SearchIndexChunkInput = {
      ordinal: 0,
      text: 'Short revised body.',
      location: { format: 'pdf', pageIndex: 0 },
      heading: null,
      pageLabel: '1',
    };
    search.append('doc-pdf', 'hash-v2', generation.generationId, [shortChunk]);
    search.complete('doc-pdf', 'hash-v2', generation.generationId);

    expect(search.getState('doc-pdf')?.estimatedTokens).toBe(Math.ceil(shortChunk.text.length / 4));
  });
});
