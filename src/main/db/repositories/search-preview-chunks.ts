import type { SQLInputValue } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import type { DocumentLocation } from '@shared/types/document';
import { hasParagraphFormat } from '@shared/document-format-family';

/** An indexed chunk's text for a library preview, with the page label it was indexed under. */
export type PreviewChunk = { readonly text: string; readonly pageLabel: string | null };

/** A complete, constant statement and its bound values; no caller contributes SQL. */
type ChunkQuery = { readonly sql: string; readonly params: readonly SQLInputValue[] };

/** The query for a chunk at a reading location, or `null` when a location cannot name a chunk. */
function chunkQuery(location: DocumentLocation): ChunkQuery | null {
  if (location.format === 'pdf') {
    return {
      sql: `SELECT text, page_label FROM document_text_chunks
             WHERE document_id = ? AND json_extract(location_json, '$.format') = 'pdf'
               AND json_extract(location_json, '$.pageIndex') = ? LIMIT 1`,
      params: [location.pageIndex],
    };
  }
  if (location.format === 'markdown') {
    return location.headingId
      ? {
          sql: `SELECT text, page_label FROM document_text_chunks
                 WHERE document_id = ? AND json_extract(location_json, '$.format') = 'markdown'
                   AND (json_extract(location_json, '$.headingId') = ? OR json_extract(location_json, '$.blockIndex') = ?) LIMIT 1`,
          params: [location.headingId, location.blockIndex],
        }
      : {
          sql: `SELECT text, page_label FROM document_text_chunks
                 WHERE document_id = ? AND json_extract(location_json, '$.format') = 'markdown'
                   AND json_extract(location_json, '$.blockIndex') = ? LIMIT 1`,
          params: [location.blockIndex],
        };
  }
  if (hasParagraphFormat(location)) {
    return {
      sql: `SELECT text, page_label FROM document_text_chunks
             WHERE document_id = ? AND json_extract(location_json, '$.format') = ?
               AND json_extract(location_json, '$.paragraphIndex') = ? LIMIT 1`,
      params: [location.format, location.paragraphIndex],
    };
  }
  if (location.format === 'epub' && location.spineHref) {
    return {
      sql: `SELECT text, page_label FROM document_text_chunks
             WHERE document_id = ? AND json_extract(location_json, '$.format') = 'epub'
               AND json_extract(location_json, '$.spineHref') = ? LIMIT 1`,
      params: [location.spineHref],
    };
  }
  return null;
}

type PreviewChunkRow = { readonly text: string; readonly page_label: string | null };

/**
 * Library previews read from the search index's committed chunk text. The
 * chunk table and its location JSON belong to the search index, so this is the
 * one place outside `SearchRepository` that knows their shape: a read-only,
 * parameterized, single-row query, never handed a SQL fragment by a caller.
 */
export class SearchPreviewChunks {
  constructor(private readonly db: InterleafDatabase) {}

  /** The document's first chunk in reading order. */
  first(documentId: string): PreviewChunk | null {
    const row = this.db.raw
      .prepare('SELECT text, page_label FROM document_text_chunks WHERE document_id = ? ORDER BY ordinal ASC LIMIT 1')
      .get(documentId) as PreviewChunkRow | undefined;
    return row === undefined ? null : { text: row.text, pageLabel: row.page_label };
  }

  /** A chunk at `location`, or `null` when none was indexed there or the location names no chunk. */
  at(documentId: string, location: DocumentLocation): PreviewChunk | null {
    const query = chunkQuery(location);
    if (query === null) return null;
    const row = this.db.raw.prepare(query.sql).get(documentId, ...query.params) as PreviewChunkRow | undefined;
    return row === undefined ? null : { text: row.text, pageLabel: row.page_label };
  }
}
