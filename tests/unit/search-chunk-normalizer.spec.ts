import { describe, expect, it } from 'vitest';
import type { NormalizedTextChunk } from '@shared/types/document';
import { normalizeSearchChunks, SEARCH_CHUNK_MAX_UNITS } from '../../src/renderer/features/search/chunk-normalizer';

async function collect(source: readonly NormalizedTextChunk[], signal?: AbortSignal) {
  async function* stream() {
    await Promise.resolve();
    for (const chunk of source) yield chunk;
  }
  const chunks = [];
  for await (const chunk of normalizeSearchChunks(stream(), signal)) chunks.push(chunk);
  return chunks;
}

describe('search chunk normalization', () => {
  it('re-numbers adapter chunks and splits long text at bounded semantic boundaries', async () => {
    const sentence = 'A meaningful sentence about distributed consensus. ';
    const text = sentence.repeat(900);
    const chunks = await collect([{
      id: 'adapter-controlled',
      documentId: 'doc',
      ordinal: 99,
      text,
      tokenCount: -1,
      location: { format: 'pdf', pageIndex: 4 },
      heading: 'Heading',
      pageLabel: '5',
    }]);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.text.length <= SEARCH_CHUNK_MAX_UNITS)).toBe(true);
    expect(chunks.every((chunk) => chunk.location.format === 'pdf' && chunk.location.pageIndex === 4)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(' ').replace(/\s+/gu, ' ')).toBe(
      text.trim().replace(/\s+/gu, ' ')
    );
  });

  it('creates precise DOCX character ranges for split paragraphs', async () => {
    const text = 'word '.repeat(7_000).trim();
    const chunks = await collect([{
      id: 'docx-source',
      documentId: 'docx',
      ordinal: 0,
      text,
      tokenCount: 7_000,
      location: { format: 'docx', paragraphIndex: 3, renderedPageIndex: 1 },
      heading: null,
      pageLabel: 'Rendered page 2',
    }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.location).toMatchObject({
      format: 'docx', paragraphIndex: 3, characterStart: 0, renderedPageIndex: 1,
    });
    for (const chunk of chunks) {
      if (chunk.location.format !== 'docx') throw new Error('Expected DOCX location.');
      expect(chunk.location.characterEnd).toBeGreaterThan(chunk.location.characterStart ?? -1);
      expect(text.slice(chunk.location.characterStart, chunk.location.characterEnd)).toBe(chunk.text);
    }
  });

  it('stops promptly when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect([{
      id: 'source', documentId: 'doc', ordinal: 0, text: 'text', tokenCount: 1,
      location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null,
    }], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
