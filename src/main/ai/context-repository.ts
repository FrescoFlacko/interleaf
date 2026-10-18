import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../db/database';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parseDocumentLocation, parseChatSelectionDescriptor } from '@shared/schemas/document';
import type { DocumentFormat, DocumentLocation } from '@shared/types/document';
import { buildFtsQuery, epubSpineIndex } from '../db/repositories/search-repository';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';
import { hasParagraphFormat } from '@shared/document-format-family';

export type ContextDocument = {
  readonly id: string;
  readonly title: string;
  readonly format: DocumentFormat;
  readonly documentHash: string;
  readonly pageCount: number | null;
};

export type ContextChunk = {
  readonly id: string;
  readonly ordinal: number;
  readonly text: string;
  readonly estimatedTokens: number;
  readonly location: DocumentLocation;
  readonly heading: string | null;
  readonly pageLabel: string | null;
};

export type SelectionChunkResolution = {
  readonly chunks: readonly ContextChunk[];
  readonly boundaryOverIncluded: boolean;
};

export type ChatContextSource = {
  getDocument: (documentId: string, documentHash?: string) => ContextDocument;
  getPublishedStats: (documentId: string, documentHash: string) => { readonly chunkCount: number; readonly estimatedTokens: number } | null;
  listPublishedChunks: (documentId: string, documentHash: string) => readonly ContextChunk[];
  retrieve: (
    documentId: string,
    documentHash: string,
    query: string,
    limit: number,
    currentLocation?: DocumentLocation | null
  ) => readonly ContextChunk[];
  resolveSelectionChunks: (
    documentId: string,
    documentHash: string,
    rawDescriptor: PortableValue
  ) => SelectionChunkResolution;
};

type ChunkRow = {
  id: string;
  ordinal: number;
  text: string;
  location_json: string;
  heading: string | null;
  page_label: string | null;
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    // Advance one code unit so overlapping occurrences (for example `aa` in
    // `aaa`) are also treated as ambiguous boundary evidence.
    pos += 1;
  }
  return count;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

type SelectionBoundary = 'start' | 'end';

function descriptorBoundaryOffset(
  descriptor: ReturnType<typeof parseChatSelectionDescriptor>,
  boundary: SelectionBoundary
): number | undefined {
  if (!descriptor) return undefined;
  if (descriptor.format === 'pdf') {
    return boundary === 'start' ? descriptor.startTextOffset : descriptor.endTextOffset;
  }
  if (descriptor.format === 'markdown') {
    return boundary === 'start' ? descriptor.startCharacterOffset : descriptor.endCharacterOffset;
  }
  if (hasParagraphFormat(descriptor)) {
    return boundary === 'start' ? descriptor.startCharacterOffset : descriptor.endCharacterOffset;
  }
  if (descriptor.format === 'mobi') {
    return boundary === 'start' ? descriptor.startOffset : descriptor.endOffset;
  }
  return undefined;
}

function chunkBoundaryOffset(location: DocumentLocation, boundary: SelectionBoundary): number | undefined {
  if (location.format === 'pdf' || location.format === 'epub' || location.format === 'mobi') {
    return boundary === 'start' ? location.textStart : location.textEnd;
  }
  return boundary === 'start' ? location.characterStart : location.characterEnd;
}

/**
 * A quote is safe to use for boundary clamping only when it identifies one
 * exact occurrence and agrees with the native offset, when one was captured.
 * Without a bounded chunk offset, the descriptor offset is relative to the
 * complete indexed unit. With one, it is relative to that chunk's native
 * start. Any uncertainty deliberately keeps the complete boundary chunk.
 */
function findConsistentBoundary(
  chunk: ContextChunk,
  quote: string | undefined,
  descriptor: ReturnType<typeof parseChatSelectionDescriptor>,
  boundary: SelectionBoundary
): number | null {
  if (!quote) return null;
  const first = chunk.text.indexOf(quote);
  if (first < 0 || countOccurrences(chunk.text, quote) !== 1) return null;

  const requestedOffset = descriptorBoundaryOffset(descriptor, boundary);
  if (requestedOffset === undefined) return first;

  const chunkStart = chunkBoundaryOffset(chunk.location, 'start');
  const expected = chunkStart === undefined ? requestedOffset : requestedOffset - chunkStart;
  const actual = boundary === 'start' ? first : first + quote.length;
  if (expected < 0 || actual !== expected) return null;
  return first;
}

function clampSelectionBoundaries(
  chunks: readonly ContextChunk[],
  descriptor: ReturnType<typeof parseChatSelectionDescriptor>
): SelectionChunkResolution {
  if (!descriptor || chunks.length === 0) return { chunks: [], boundaryOverIncluded: false };

  const clamped = [...chunks];
  const first = clamped[0];
  const last = clamped[clamped.length - 1];
  let boundaryOverIncluded = false;
  const startQuote = descriptor.startQuote?.exact;
  const endQuote = descriptor.endQuote?.exact;
  const startIndex = first ? findConsistentBoundary(first, startQuote, descriptor, 'start') : null;
  const endIndex = last ? findConsistentBoundary(last, endQuote, descriptor, 'end') : null;

  if (first && startIndex === null) {
    boundaryOverIncluded = true;
  }
  if (last && endIndex === null) {
    boundaryOverIncluded = true;
  }

  if (clamped.length === 1 && first) {
    // Both endpoint quotes must be valid and ordered before we narrow a
    // single unit. Otherwise retain the whole chunk as a truthful fallback.
    if (startIndex !== null && endIndex !== null && startIndex <= endIndex) {
      const endQuoteLength = endQuote?.length ?? 0;
      const text = first.text.slice(startIndex, endIndex + endQuoteLength);
      clamped[0] = { ...first, text, estimatedTokens: estimateTokens(text) };
    }
    return { chunks: clamped, boundaryOverIncluded };
  }

  if (clamped.length > 1) {
    if (first && startIndex !== null && startIndex > 0) {
      const text = first.text.slice(startIndex);
      clamped[0] = { ...first, text, estimatedTokens: estimateTokens(text) };
    }
    if (last && endIndex !== null) {
      const endQuoteLength = endQuote?.length ?? 0;
      const end = endIndex + endQuoteLength;
      if (end < last.text.length) {
        const text = last.text.slice(0, end);
        clamped[clamped.length - 1] = { ...last, text, estimatedTokens: estimateTokens(text) };
      }
    }
  }

  return { chunks: clamped, boundaryOverIncluded };
}

function mapChunk(row: ChunkRow): ContextChunk {
  let rawLocation: PortableValue;
  try {
    rawLocation = parsePortableJson(row.location_json);
  } catch (error) {
    throw new InterleafError('internal', 'Stored context location is invalid JSON.', { cause: error instanceof Error ? error : null });
  }
  const location = parseDocumentLocation(rawLocation);
  if (!location) throw new InterleafError('internal', 'Stored context location failed validation.');
  return {
    id: row.id,
    ordinal: row.ordinal,
    text: row.text,
    estimatedTokens: estimateTokens(row.text),
    location,
    heading: row.heading,
    pageLabel: row.page_label,
  };
}

export class AIContextRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
  }

  getDocument(documentId: string, documentHash?: string): ContextDocument {
    const row = this.db.prepare(`
      SELECT id, title, format, file_hash, page_count FROM documents WHERE id = ?
    `).get(documentId) as {
      id: string;
      title: string;
      format: DocumentFormat;
      file_hash: string;
      page_count: number | null;
    } | undefined;
    if (!row) throw new InterleafError('validation', 'Document was not found.');
    if (documentHash !== undefined && row.file_hash !== documentHash) {
      throw new InterleafError('validation', 'Document revision changed before context could be assembled.');
    }
    return {
      id: row.id,
      title: row.title,
      format: row.format,
      documentHash: row.file_hash,
      pageCount: row.page_count,
    };
  }

  getPublishedStats(documentId: string, documentHash: string): {
    readonly chunkCount: number;
    readonly estimatedTokens: number;
  } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS chunk_count,
             COALESCE(SUM((length(c.text) + 3) / 4), 0) AS estimated_tokens
        FROM document_text_chunks c
        JOIN document_index_state i ON i.document_id = c.document_id
        JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ?
         AND d.file_hash = ?
         AND i.published_document_hash = d.file_hash
    `).get(documentId, documentHash) as { chunk_count: number; estimated_tokens: number };
    return { chunkCount: row.chunk_count, estimatedTokens: row.estimated_tokens };
  }

  listPublishedChunks(documentId: string, documentHash: string): readonly ContextChunk[] {
    return this.selectPublishedChunks(documentId, documentHash).map(mapChunk);
  }

  listPdfPageRange(
    documentId: string,
    documentHash: string,
    pageStart: number,
    pageEnd: number
  ): readonly ContextChunk[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
        FROM document_text_chunks c
        JOIN document_index_state i ON i.document_id = c.document_id
        JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ?
         AND d.file_hash = ?
         AND d.format = 'pdf'
         AND i.published_document_hash = d.file_hash
         AND json_extract(c.location_json, '$.format') = 'pdf'
         AND CAST(json_extract(c.location_json, '$.pageIndex') AS INTEGER) BETWEEN ? AND ?
       ORDER BY c.ordinal ASC
    `).all(documentId, documentHash, pageStart - 1, pageEnd - 1) as ChunkRow[];
    return rows.map(mapChunk);
  }

  resolveSelectionChunks(
    documentId: string,
    documentHash: string,
    rawDescriptor: PortableValue
  ): SelectionChunkResolution {
    const descriptor = parseChatSelectionDescriptor(rawDescriptor);
    if (!descriptor) return { chunks: [], boundaryOverIncluded: false };

    const docRow = this.db.prepare(`
      SELECT d.id, d.format, d.file_hash, i.status AS index_status, i.published_document_hash
        FROM documents d
        JOIN document_index_state i ON i.document_id = d.id
       WHERE d.id = ? AND d.file_hash = ? AND i.published_document_hash = ? AND i.status = 'ready'
    `).get(documentId, documentHash, documentHash) as {
      id: string;
      format: string;
      file_hash: string;
      index_status: string;
      published_document_hash: string;
    } | undefined;

    if (docRow?.format !== descriptor.format) return { chunks: [], boundaryOverIncluded: false };

    let rawRows: ChunkRow[] = [];

    if (descriptor.format === 'pdf') {
      if (descriptor.startPageIndex > descriptor.endPageIndex || descriptor.startPageIndex < 0) {
        return { chunks: [], boundaryOverIncluded: false };
      }
      rawRows = this.db.prepare(`
        SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
          FROM document_text_chunks c
          JOIN document_index_state i ON i.document_id = c.document_id
          JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
           AND d.file_hash = ?
           AND d.format = 'pdf'
           AND i.published_document_hash = d.file_hash
           AND json_extract(c.location_json, '$.format') = 'pdf'
           AND CAST(json_extract(c.location_json, '$.pageIndex') AS INTEGER) BETWEEN ? AND ?
         ORDER BY c.location_order ASC, c.ordinal ASC
      `).all(documentId, documentHash, descriptor.startPageIndex, descriptor.endPageIndex) as ChunkRow[];
    } else if (descriptor.format === 'markdown') {
      if (descriptor.startBlockIndex > descriptor.endBlockIndex || descriptor.startBlockIndex < 0) {
        return { chunks: [], boundaryOverIncluded: false };
      }
      rawRows = this.db.prepare(`
        SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
          FROM document_text_chunks c
          JOIN document_index_state i ON i.document_id = c.document_id
          JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
           AND d.file_hash = ?
           AND d.format = 'markdown'
           AND i.published_document_hash = d.file_hash
           AND json_extract(c.location_json, '$.format') = 'markdown'
           AND CAST(json_extract(c.location_json, '$.blockIndex') AS INTEGER) BETWEEN ? AND ?
         ORDER BY c.location_order ASC, c.ordinal ASC
      `).all(documentId, documentHash, descriptor.startBlockIndex, descriptor.endBlockIndex) as ChunkRow[];
    } else if (hasParagraphFormat(descriptor)) {
      if (descriptor.startParagraphIndex > descriptor.endParagraphIndex || descriptor.startParagraphIndex < 0) {
        return { chunks: [], boundaryOverIncluded: false };
      }
      rawRows = this.db.prepare(`
        SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
          FROM document_text_chunks c
          JOIN document_index_state i ON i.document_id = c.document_id
          JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
           AND d.file_hash = ?
           AND d.format = ?
           AND i.published_document_hash = d.file_hash
           AND json_extract(c.location_json, '$.format') = ?
           AND CAST(json_extract(c.location_json, '$.paragraphIndex') AS INTEGER) BETWEEN ? AND ?
         ORDER BY c.location_order ASC, c.ordinal ASC
      `).all(documentId, documentHash, descriptor.format, descriptor.format, descriptor.startParagraphIndex, descriptor.endParagraphIndex) as ChunkRow[];
    } else if (descriptor.format === 'epub') {
      const startSpine = descriptor.startCfi ? epubSpineIndex(descriptor.startCfi) : null;
      const endSpine = descriptor.endCfi ? epubSpineIndex(descriptor.endCfi) : null;
      if (startSpine !== null && endSpine !== null) {
        if (startSpine > endSpine) {
          return { chunks: [], boundaryOverIncluded: false };
        }
        const minSpine = Math.min(startSpine, endSpine);
        const maxSpine = Math.max(startSpine, endSpine);
        rawRows = this.db.prepare(`
          SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
            FROM document_text_chunks c
            JOIN document_index_state i ON i.document_id = c.document_id
            JOIN documents d ON d.id = c.document_id
           WHERE c.document_id = ?
             AND d.file_hash = ?
             AND d.format = 'epub'
             AND i.published_document_hash = d.file_hash
             AND json_extract(c.location_json, '$.format') = 'epub'
             AND c.location_order BETWEEN ? AND ?
           ORDER BY c.location_order ASC, c.ordinal ASC
        `).all(documentId, documentHash, minSpine, maxSpine) as ChunkRow[];
      } else {
        rawRows = this.db.prepare(`
          SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
            FROM document_text_chunks c
            JOIN document_index_state i ON i.document_id = c.document_id
            JOIN documents d ON d.id = c.document_id
           WHERE c.document_id = ?
             AND d.file_hash = ?
             AND d.format = 'epub'
             AND i.published_document_hash = d.file_hash
             AND json_extract(c.location_json, '$.format') = 'epub'
             AND (
               json_extract(c.location_json, '$.spineHref') = ?
               OR json_extract(c.location_json, '$.spineHref') = ?
             )
           ORDER BY c.location_order ASC, c.ordinal ASC
        `).all(documentId, documentHash, descriptor.startSpineHref, descriptor.endSpineHref) as ChunkRow[];
      }
    } else {
      if (descriptor.startSectionIndex > descriptor.endSectionIndex || descriptor.startSectionIndex < 0) {
        return { chunks: [], boundaryOverIncluded: false };
      }
      rawRows = this.db.prepare(`
        SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
          FROM document_text_chunks c
          JOIN document_index_state i ON i.document_id = c.document_id
          JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
           AND d.file_hash = ?
           AND d.format = 'mobi'
           AND i.published_document_hash = d.file_hash
           AND json_extract(c.location_json, '$.format') = 'mobi'
           AND CAST(json_extract(c.location_json, '$.sectionIndex') AS INTEGER) BETWEEN ? AND ?
         ORDER BY c.location_order ASC, c.ordinal ASC
      `).all(documentId, documentHash, descriptor.startSectionIndex, descriptor.endSectionIndex) as ChunkRow[];
    }

    if (rawRows.length === 0) return { chunks: [], boundaryOverIncluded: false };
    const chunks = rawRows.map(mapChunk);
    return clampSelectionBoundaries(chunks, descriptor);
  }

  findClosestChunk(
    documentId: string,
    documentHash: string,
    target: DocumentLocation
  ): ContextChunk | null {
    const chunks = this.selectPublishedChunks(documentId, documentHash).map(mapChunk);
    let best: ContextChunk | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const chunk of chunks) {
      const distance = locationDistance(target, chunk.location);
      if (distance < bestDistance) {
        best = chunk;
        bestDistance = distance;
      }
    }
    return Number.isFinite(bestDistance) ? best : null;
  }

  retrieve(
    documentId: string,
    documentHash: string,
    query: string,
    limit: number,
    currentLocation?: DocumentLocation | null
  ): readonly ContextChunk[] {
    const ftsQuery = buildFtsQuery(query);
    const boundedLimit = Math.max(1, Math.min(50, limit));
    const candidateLimit = currentLocation ? Math.max(boundedLimit * 2, 20) : boundedLimit;
    const hits = this.db.prepare(`
      SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label,
             bm25(document_fts, 0.0, 4.0, 1.0) AS rank
        FROM document_fts
        JOIN document_text_chunks c ON c.rowid = document_fts.rowid
        JOIN document_index_state i ON i.document_id = c.document_id
        JOIN documents d ON d.id = c.document_id
       WHERE document_fts MATCH ?
         AND c.document_id = ?
         AND d.file_hash = ?
         AND i.published_document_hash = d.file_hash
       ORDER BY rank ASC, c.ordinal ASC
       LIMIT ?
    `).all(ftsQuery, documentId, documentHash, candidateLimit) as (ChunkRow & { rank: number })[];
    if (hits.length === 0) return [];

    let selectedHits = hits;
    if (currentLocation) {
      selectedHits = [...hits].sort((a, b) => {
        const locA = parseLocationJson(a.location_json);
        const locB = parseLocationJson(b.location_json);
        const distA = locA ? locationDistance(currentLocation, locA) : Number.POSITIVE_INFINITY;
        const distB = locB ? locationDistance(currentLocation, locB) : Number.POSITIVE_INFINITY;
        const proxA = Number.isFinite(distA) ? Math.min(distA, 10) * 0.1 : 1.0;
        const proxB = Number.isFinite(distB) ? Math.min(distB, 10) * 0.1 : 1.0;
        return (a.rank + proxA) - (b.rank + proxB);
      }).slice(0, boundedLimit);
    }

    const ordinals = new Set<number>();
    for (const hit of selectedHits) {
      ordinals.add(hit.ordinal);
      if (hit.ordinal > 0) ordinals.add(hit.ordinal - 1);
      ordinals.add(hit.ordinal + 1);
    }
    const placeholders = [...ordinals].map(() => '?').join(', ');
    const neighbors = this.db.prepare(`
      SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
        FROM document_text_chunks c
        JOIN document_index_state i ON i.document_id = c.document_id
        JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ? AND d.file_hash = ?
         AND i.published_document_hash = d.file_hash
         AND c.ordinal IN (${placeholders})
       ORDER BY c.ordinal ASC
    `).all(documentId, documentHash, ...ordinals) as ChunkRow[];
    return neighbors.map(mapChunk);
  }

  private selectPublishedChunks(documentId: string, documentHash: string): ChunkRow[] {
    return this.db.prepare(`
      SELECT c.id, c.ordinal, c.text, c.location_json, c.heading, c.page_label
        FROM document_text_chunks c
        JOIN document_index_state i ON i.document_id = c.document_id
        JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ?
         AND d.file_hash = ?
         AND i.published_document_hash = d.file_hash
       ORDER BY c.ordinal ASC
    `).all(documentId, documentHash) as ChunkRow[];
  }
}

function sameFormatParagraphDistance(left: DocumentLocation, right: DocumentLocation): number | null {
  if (!hasParagraphFormat(left) || !hasParagraphFormat(right) || left.format !== right.format) return null;
  return Math.abs(left.paragraphIndex - right.paragraphIndex);
}

/**
 * Ordinal distance between two locations in the same document, in that format's
 * own units — pages, paragraphs, blocks, sections. `Infinity` for two locations
 * that cannot be compared, so a caller ordering by nearness drops them rather
 * than treating them as adjacent.
 */
export function locationDistance(left: DocumentLocation, right: DocumentLocation): number {
  if (left.format !== right.format) return Number.POSITIVE_INFINITY;
  if (left.format === 'pdf' && right.format === 'pdf') {
    return Math.abs(left.pageIndex - right.pageIndex);
  }
  const paragraphDistance = sameFormatParagraphDistance(left, right);
  if (paragraphDistance !== null) {
    return paragraphDistance;
  }
  if (left.format === 'markdown' && right.format === 'markdown') {
    return Math.abs(left.blockIndex - right.blockIndex);
  }
  if (left.format === 'mobi' && right.format === 'mobi') {
    return Math.abs(left.sectionIndex - right.sectionIndex);
  }
  if (left.format === 'epub' && right.format === 'epub') {
    if (left.spineHref && right.spineHref && left.spineHref === right.spineHref) {
      return Math.abs((left.progression ?? 0) - (right.progression ?? 0));
    }
    return left.cfi === right.cfi ? 0 : 1;
  }
  return Number.POSITIVE_INFINITY;
}

function parseLocationJson(json: string): DocumentLocation | null {
  try {
    const parsed: PortableValue = parsePortableJson(json);
    return parseDocumentLocation(parsed);
  } catch {
    return null;
  }
}
