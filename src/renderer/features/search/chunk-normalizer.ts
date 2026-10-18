import type { NormalizedTextChunk } from '@shared/types/document';
import type { SearchIndexChunkInput } from '@shared/types/search';
import { SEARCH_INDEX_MAX_CHUNKS, SEARCH_INDEX_MAX_TEXT_UNITS } from '@shared/constants/search';

const SEARCH_CHUNK_TARGET_UNITS = 8_000;
export const SEARCH_CHUNK_MAX_UNITS = 32_000;
const SEARCH_DOCUMENT_MAX_UNITS = SEARCH_INDEX_MAX_TEXT_UNITS;
const SEARCH_DOCUMENT_MAX_CHUNKS = SEARCH_INDEX_MAX_CHUNKS;

function abortError(): Error {
  const error = new Error('Search indexing was cancelled.');
  error.name = 'AbortError';
  return error;
}

function findSemanticEnd(text: string, start: number): number {
  const hardEnd = Math.min(text.length, start + SEARCH_CHUNK_MAX_UNITS);
  if (hardEnd === text.length) return hardEnd;
  const target = Math.min(hardEnd, start + SEARCH_CHUNK_TARGET_UNITS);
  const minimum = Math.min(target, start + Math.floor(SEARCH_CHUNK_TARGET_UNITS / 2));
  const candidates = ['\n\n', '. ', '! ', '? ', '; ', '\n', ' '];
  for (const marker of candidates) {
    const boundary = text.lastIndexOf(marker, target);
    if (boundary >= minimum) return boundary + marker.length;
  }
  return hardEnd;
}

function locationForSlice(chunk: NormalizedTextChunk, start: number, end: number): SearchIndexChunkInput['location'] {
  switch (chunk.location.format) {
    case 'docx':
    case 'pptx':
    case 'markdown': {
      const base = chunk.location.characterStart ?? 0;
      return { ...chunk.location, characterStart: base + start, characterEnd: base + end };
    }
    case 'pdf':
    case 'epub':
    case 'mobi': {
      const base = chunk.location.textStart ?? 0;
      return { ...chunk.location, textStart: base + start, textEnd: base + end };
    }
  }
}

/**
 * Converts format-adapter output into bounded, sequential, semantic chunks.
 * Adapter-owned ids, ordinals, and token estimates deliberately do not cross
 * the IPC boundary; the main process assigns generation ids and token counts.
 */
export async function* normalizeSearchChunks(
  source: AsyncIterable<NormalizedTextChunk>,
  signal?: AbortSignal
): AsyncIterable<SearchIndexChunkInput> {
  let ordinal = 0;
  let totalUnits = 0;

  for await (const sourceChunk of source) {
    if (signal?.aborted === true) throw abortError();
    totalUnits += sourceChunk.text.length;
    if (totalUnits > SEARCH_DOCUMENT_MAX_UNITS) {
      throw new Error('Document text exceeds the safe indexing size limit.');
    }

    let cursor = 0;
    while (cursor < sourceChunk.text.length) {
      while (cursor < sourceChunk.text.length && /\s/u.test(sourceChunk.text[cursor] ?? '')) cursor += 1;
      if (cursor >= sourceChunk.text.length) break;
      const end = findSemanticEnd(sourceChunk.text, cursor);
      let contentEnd = end;
      while (contentEnd > cursor && /\s/u.test(sourceChunk.text[contentEnd - 1] ?? '')) contentEnd -= 1;
      if (contentEnd > cursor) {
        if (ordinal >= SEARCH_DOCUMENT_MAX_CHUNKS) {
          throw new Error('Document produced too many searchable chunks.');
        }
        yield {
          ordinal,
          text: sourceChunk.text.slice(cursor, contentEnd),
          location: locationForSlice(sourceChunk, cursor, contentEnd),
          heading: sourceChunk.heading?.slice(0, 2_000) ?? null,
          pageLabel: sourceChunk.pageLabel?.slice(0, 256) ?? null,
        };
        ordinal += 1;
      }
      cursor = Math.max(end, cursor + 1);
    }
  }
}
