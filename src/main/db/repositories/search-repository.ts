import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parseDocumentLocation } from '@shared/schemas/document';
import {
  appendDocumentIndexRequestSchema,
  beginDocumentIndexRequestSchema,
  failDocumentIndexRequestSchema,
  finishDocumentIndexRequestSchema,
  resolveSearchHitRequestSchema,
  searchRequestSchema,
} from '@shared/schemas/search';
import type {
  DocumentIndexState,
  IndexGeneration,
  SearchHit,
  SearchIndexChunkInput,
} from '@shared/types/search';
import type { DocumentFormat } from '@shared/types/document';
import type { DocumentLocation } from '@shared/types/document';
import { SEARCH_INDEX_MAX_CHUNKS, SEARCH_INDEX_MAX_TEXT_UNITS } from '@shared/constants/search';
import { createSearchMatchAnchor, tokenizeSearchTerms } from '@shared/search/match-anchor';
import { buildSearchExcerpt } from '@shared/search/text-match';
import type { SearchMatchAnchor } from '@shared/types/search';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';
import { hasParagraphFormat } from '@shared/document-format-family';

type DocumentIdentityRow = { file_hash: string; format: DocumentFormat };
type IndexStateRow = {
  document_id: string;
  document_hash: string;
  generation_id: string | null;
  indexed_text_units: number;
  published_document_hash: string;
  published_total_chunks: number;
  status: DocumentIndexState['status'];
  total_chunks: number;
  indexed_chunks: number;
  error_message: string | null;
  updated_at: string;
};

/**
 * The order keys are persisted with each published chunk so SQLite can apply
 * the bounded LIMIT after ordering all FTS matches. A negative key means that
 * the row predates migration 16; search then uses the contiguous chunk ordinal
 * as a deterministic, source-order fallback.
 */
type SearchLocationOrder = {
  readonly locationOrder: number;
  readonly locationDetail: number;
  readonly locationOffset: number;
};

const LOCATION_ORDER_FALLBACK = -1;
const PROGRESSION_SCALE = 1_000_000_000;

function scaledProgression(progression: number | undefined): number {
  if (progression === undefined || !Number.isFinite(progression)) return LOCATION_ORDER_FALLBACK;
  return Math.max(0, Math.min(PROGRESSION_SCALE, Math.round(progression * PROGRESSION_SCALE)));
}

/**
 * EPUB locations do not expose a section index in the shared contract. The
 * EPUB CFI package path does: `/6/<even-spine-step>`. This intentionally
 * parses only that bounded numeric component and falls back to ordinal for a
 * legacy/corrupt CFI rather than guessing from an href or title.
 */
export function epubSpineIndex(cfi: string): number | null {
  const wrapperMatch = /^epubcfi\((.*)\)$/u.exec(cfi);
  const unwrapped = wrapperMatch?.[1] ?? cfi;
  const packagePath = unwrapped.split('!')[0] ?? '';
  const match = /\/6\/(\d+)(?:\[|\/|$)/u.exec(packagePath);
  if (!match?.[1]) return null;
  const step = Number(match[1]);
  if (!Number.isSafeInteger(step) || step < 2 || step % 2 !== 0) return null;
  const index = step / 2 - 1;
  return index >= 0 && index <= 10_000_000 ? index : null;
}

function searchLocationOrder(location: DocumentLocation): SearchLocationOrder {
  if (hasParagraphFormat(location)) {
    return {
      locationOrder: location.renderedPageIndex ?? location.paragraphIndex,
      locationDetail: location.paragraphIndex,
      locationOffset: location.characterStart ?? LOCATION_ORDER_FALLBACK,
    };
  }
  switch (location.format) {
    case 'pdf':
      return { locationOrder: location.pageIndex, locationDetail: 0, locationOffset: 0 };
    case 'markdown':
      return {
        locationOrder: location.blockIndex,
        locationDetail: location.lineIndex ?? LOCATION_ORDER_FALLBACK,
        locationOffset: location.characterStart ?? LOCATION_ORDER_FALLBACK,
      };
    case 'epub':
      return {
        locationOrder: epubSpineIndex(location.cfi) ?? LOCATION_ORDER_FALLBACK,
        locationDetail: scaledProgression(location.progression),
        locationOffset: 0,
      };
    case 'mobi':
      return {
        locationOrder: location.sectionIndex,
        locationDetail: location.byteOffset ?? scaledProgression(location.progression),
        locationOffset: 0,
      };
  }
}

/**
 * Approximate tokens from the extracted text length that indexing already
 * recorded. Four UTF-16 units per token is the coarse ratio used across the
 * app; it is only ever an estimate, so it is reported exclusively for a ready
 * index whose published revision is still the document's current revision.
 * A stale, in-progress, or failed index has no trustworthy estimate and reports
 * `null` rather than a plausible-looking number. A ready index of the current
 * published revision is trustworthy even when it extracted nothing, so an empty
 * document reports the exact estimate `0` rather than hiding behind `null`.
 */
const TEXT_UNITS_PER_ESTIMATED_TOKEN = 4;

function readyEstimatedTokens(row: IndexStateRow, currentFileHash: string | null): number | null {
  if (currentFileHash === null) return null;
  if (row.document_hash !== currentFileHash || row.published_document_hash !== currentFileHash) return null;
  return Math.ceil(Math.max(0, row.indexed_text_units) / TEXT_UNITS_PER_ESTIMATED_TOKEN);
}

/** Shown for a failed row that recorded no reason; every current writer records one. */
const UNRECORDED_INDEX_FAILURE = 'Indexing failed.';

/**
 * Projects a row onto the status it claims. Every writer keeps the row
 * consistent; this keeps a legacy or hand-edited row from reaching the
 * renderer as a state no status allows.
 */
function mapState(row: IndexStateRow, currentFileHash: string | null): DocumentIndexState {
  const common = {
    documentId: row.document_id,
    documentHash: row.document_hash,
    totalChunks: row.total_chunks,
    indexedChunks: row.indexed_chunks,
    updatedAt: row.updated_at,
  };
  switch (row.status) {
    case 'ready':
      return { ...common, status: 'ready', estimatedTokens: readyEstimatedTokens(row, currentFileHash), errorMessage: null };
    case 'failed':
      return { ...common, status: 'failed', estimatedTokens: null, errorMessage: row.error_message ?? UNRECORDED_INDEX_FAILURE };
    case 'not_indexed':
      return { ...common, status: 'not_indexed', estimatedTokens: null, errorMessage: row.error_message };
    case 'indexing':
      return { ...common, status: 'indexing', estimatedTokens: null, errorMessage: null };
  }
}

function tokenCount(text: string): number {
  return Math.max(1, Math.min(1_000_000, text.trim().split(/\s+/u).length));
}

/**
 * Recall-oriented FTS expression: every term is a prefix phrase. Retained for
 * ADR-0006 Level-3 lexical retrieval (`src/main/ai/context-repository.ts`),
 * where a broad candidate set feeds a re-ranker and morphological variants of
 * a concept are wanted. User-facing search must not use this — see
 * {@link buildExactFtsQuery}.
 */
export function buildFtsQuery(query: string): string {
  const terms = tokenizeSearchTerms(query);
  if (terms.length === 0) {
    throw new InterleafError('validation', 'Search requires at least one letter or number.');
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
}

const FTS_INDEXABLE_RE = /[\p{L}\p{N}]/u;

/**
 * Candidate expression for user-facing search: quoted phrases with no prefix
 * operator. This is deliberately still a superset of the answer rather than the
 * answer itself, because `document_fts` is tokenized with `porter unicode61`
 * and stems `formats`/`formatting` onto `format`. `interleaf_search_exact_terms`
 * applies the exact whole-token relation to the stored text in the same
 * statement; dropping `*` here only shrinks the rows that filter has to read.
 *
 * A term with no letter or digit (`___`) indexes to nothing under unicode61, so
 * emitting it as a phrase would be an FTS5 syntax error rather than a search.
 */
export function buildExactFtsQuery(query: string): string {
  const terms = tokenizeSearchTerms(query).filter((term) => FTS_INDEXABLE_RE.test(term));
  if (terms.length === 0) {
    throw new InterleafError('validation', 'Search requires at least one letter or number.');
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

export class SearchRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        DELETE FROM document_index_staging_chunks
         WHERE generation_id IN (
           SELECT generation_id FROM document_index_state WHERE status = 'indexing'
         )
      `).run();
      this.db.prepare(`
        UPDATE document_index_state
           SET status = 'failed', generation_id = NULL,
               error_message = 'Indexing was interrupted before completion.',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status = 'indexing'
      `).run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  begin(documentId: string, documentHash: string): IndexGeneration {
    const request = beginDocumentIndexRequestSchema.parse({ documentId, documentHash });
    const generationId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireDocument(request.documentId, request.documentHash);
      this.db.prepare('DELETE FROM document_index_staging_chunks WHERE document_id = ?').run(request.documentId);
      this.db.prepare(`
        INSERT INTO document_index_state (
          document_id, status, total_chunks, indexed_chunks, error_message,
          document_hash, generation_id, indexed_text_units, updated_at
        ) VALUES (?, 'indexing', 0, 0, NULL, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(document_id) DO UPDATE SET
          status = 'indexing', total_chunks = 0, indexed_chunks = 0,
          error_message = NULL, document_hash = excluded.document_hash,
          indexed_text_units = 0,
          generation_id = excluded.generation_id, updated_at = excluded.updated_at
      `).run(request.documentId, request.documentHash, generationId);
      const state = this.requireGeneration(request.documentId, request.documentHash, generationId);
      this.db.exec('COMMIT');
      return { ...mapState(state, this.currentFileHash(request.documentId)), generationId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  append(
    documentId: string,
    documentHash: string,
    generationId: string,
    chunks: readonly SearchIndexChunkInput[]
  ): DocumentIndexState {
    const request = appendDocumentIndexRequestSchema.parse({ documentId, documentHash, generationId, chunks });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const document = this.requireDocument(request.documentId, request.documentHash);
      const state = this.requireGeneration(request.documentId, request.documentHash, request.generationId);
      const batchTextUnits = request.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
      if (state.indexed_chunks + request.chunks.length > SEARCH_INDEX_MAX_CHUNKS) {
        throw new InterleafError('validation', 'Document produced too many searchable chunks.');
      }
      if (state.indexed_text_units + batchTextUnits > SEARCH_INDEX_MAX_TEXT_UNITS) {
        throw new InterleafError('validation', 'Document text exceeds the safe indexing size limit.');
      }
      for (const [index, chunk] of request.chunks.entries()) {
        const expectedOrdinal = state.indexed_chunks + index;
        if (chunk.ordinal !== expectedOrdinal) {
          throw new InterleafError('validation', `Index chunks must be contiguous from ordinal ${String(state.indexed_chunks)}.`);
        }
        const location = parseDocumentLocation(chunk.location);
        if (!location) {
          throw new InterleafError('validation', 'Index chunk location failed validation.');
        }
        if (location.format !== document.format) {
          throw new InterleafError('validation', 'Index chunk location format does not match the document.');
        }
        const order = searchLocationOrder(location);
        this.db.prepare(`
          INSERT INTO document_index_staging_chunks (
            generation_id, document_id, ordinal, text, token_count,
            location_json, heading, page_label,
            location_order, location_detail, location_offset
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.generationId,
          request.documentId,
          chunk.ordinal,
          chunk.text,
          tokenCount(chunk.text),
          JSON.stringify(location),
          chunk.heading,
          chunk.pageLabel,
          order.locationOrder,
          order.locationDetail,
          order.locationOffset
        );
      }
      const nextCount = state.indexed_chunks + request.chunks.length;
      this.db.prepare(`
        UPDATE document_index_state
           SET indexed_chunks = ?, total_chunks = ?, indexed_text_units = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE document_id = ? AND generation_id = ?
      `).run(nextCount, nextCount, state.indexed_text_units + batchTextUnits, request.documentId, request.generationId);
      const next = this.requireGeneration(request.documentId, request.documentHash, request.generationId);
      this.db.exec('COMMIT');
      return mapState(next, this.currentFileHash(request.documentId));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(documentId: string, documentHash: string, generationId: string): DocumentIndexState {
    const request = finishDocumentIndexRequestSchema.parse({ documentId, documentHash, generationId });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireDocument(request.documentId, request.documentHash);
      const state = this.requireGeneration(request.documentId, request.documentHash, request.generationId);
      const staged = this.db.prepare(`
        SELECT COUNT(*) AS count FROM document_index_staging_chunks
         WHERE document_id = ? AND generation_id = ?
      `).get(request.documentId, request.generationId) as { count: number };
      if (staged.count !== state.indexed_chunks) {
        throw new InterleafError('validation', 'The staged index is incomplete.');
      }
      this.db.prepare('DELETE FROM document_text_chunks WHERE document_id = ?').run(request.documentId);
      this.db.prepare(`
        INSERT INTO document_text_chunks (
          id, document_id, ordinal, text, token_count, location_json, heading, page_label,
          location_order, location_detail, location_offset
        )
        SELECT generation_id || ':' || ordinal, document_id, ordinal, text,
               token_count, location_json, heading, page_label,
               location_order, location_detail, location_offset
          FROM document_index_staging_chunks
         WHERE document_id = ? AND generation_id = ?
         ORDER BY ordinal
      `).run(request.documentId, request.generationId);
      this.db.prepare(`
        DELETE FROM document_index_staging_chunks
         WHERE document_id = ? AND generation_id = ?
      `).run(request.documentId, request.generationId);
      this.db.prepare(`
        UPDATE document_index_state
           SET status = 'ready', generation_id = NULL, error_message = NULL,
               total_chunks = indexed_chunks,
               published_document_hash = document_hash,
               published_total_chunks = indexed_chunks,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE document_id = ? AND generation_id = ?
      `).run(request.documentId, request.generationId);
      const ready = this.getState(request.documentId);
      if (ready?.status !== 'ready') throw new Error('Failed to complete the document index.');
      this.db.exec("INSERT INTO document_fts(document_fts) VALUES ('integrity-check')");
      this.db.exec('COMMIT');
      return ready;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  fail(documentId: string, documentHash: string, generationId: string, errorMessage: string): DocumentIndexState {
    const request = failDocumentIndexRequestSchema.parse({ documentId, documentHash, generationId, errorMessage });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireGeneration(request.documentId, request.documentHash, request.generationId);
      this.db.prepare(`DELETE FROM document_index_staging_chunks WHERE document_id = ? AND generation_id = ?`)
        .run(request.documentId, request.generationId);
      this.db.prepare(`
        UPDATE document_index_state
           SET status = 'failed', generation_id = NULL, error_message = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE document_id = ? AND generation_id = ?
      `).run(request.errorMessage, request.documentId, request.generationId);
      const failed = this.getState(request.documentId);
      if (!failed) throw new Error('Failed to record index failure.');
      this.db.exec('COMMIT');
      return failed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getState(documentId: string): DocumentIndexState | null {
    const row = this.db.prepare('SELECT * FROM document_index_state WHERE document_id = ?')
      .get(documentId) as IndexStateRow | undefined;
    return row ? mapState(row, this.currentFileHash(documentId)) : null;
  }

  search(documentId: string | undefined, query: string, limit = 50): readonly SearchHit[] {
    const request = searchRequestSchema.parse({ ...(documentId ? { documentId } : {}), query, limit });
    const ftsQuery = buildExactFtsQuery(request.query);
    const boundedLimit = Math.max(1, Math.min(100, request.limit ?? 50));
    const params: (string | number)[] = [ftsQuery, request.query];
    const documentClause = request.documentId ? 'AND c.document_id = ?' : '';
    if (request.documentId) params.push(request.documentId);
    params.push(boundedLimit);
    const orderBy = request.documentId
      ? `
       ORDER BY
         CASE WHEN c.location_order >= 0 THEN c.location_order ELSE c.ordinal END ASC,
         CASE WHEN c.location_detail >= 0 THEN c.location_detail ELSE 0 END ASC,
         CASE WHEN c.location_offset >= 0 THEN c.location_offset ELSE 0 END ASC,
         c.ordinal ASC,
         c.id COLLATE BINARY ASC`
      : `
       ORDER BY d.title COLLATE NOCASE ASC, d.id COLLATE BINARY ASC,
         CASE WHEN c.location_order >= 0 THEN c.location_order ELSE c.ordinal END ASC,
         CASE WHEN c.location_detail >= 0 THEN c.location_detail ELSE 0 END ASC,
         CASE WHEN c.location_offset >= 0 THEN c.location_offset ELSE 0 END ASC,
         c.ordinal ASC,
         c.id COLLATE BINARY ASC`;
    const rows = this.db.prepare(`
      SELECT c.id AS chunk_id, c.document_id, d.title AS document_title,
             d.author AS document_author, s.published_document_hash AS document_hash, c.ordinal,
             c.location_json, c.text, c.heading, c.page_label,
             bm25(document_fts, 0.0, 4.0, 1.0) AS rank
        FROM document_fts
        JOIN document_text_chunks c ON c.rowid = document_fts.rowid
        JOIN documents d ON d.id = c.document_id
        JOIN document_index_state s ON s.document_id = c.document_id
       WHERE document_fts MATCH ?
         AND interleaf_search_exact_terms(c.text, c.heading, ?) = 1
         AND s.published_document_hash = d.file_hash
         ${documentClause}
       ${orderBy}
       LIMIT ?
    `).all(...params) as {
      chunk_id: string;
      document_id: string;
      document_title: string;
      document_author: string | null;
      document_hash: string;
      ordinal: number;
      location_json: string;
      text: string;
      heading: string | null;
      page_label: string | null;
      rank: number;
    }[];
    return rows.map((row) => {
      let rawLocation: PortableValue;
      try {
        rawLocation = parsePortableJson(row.location_json);
      } catch (error) {
        throw new InterleafError('internal', 'Stored search location is not valid JSON.', { cause: error instanceof Error ? error : null });
      }
      const location = parseDocumentLocation(rawLocation);
      if (!location) throw new InterleafError('internal', 'Stored search location failed validation.');
      const anchor = createSearchMatchAnchor({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        documentHash: row.document_hash,
        location,
        text: row.text,
        query: request.query,
      });
      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        documentTitle: row.document_title,
        documentAuthor: row.document_author,
        documentHash: row.document_hash,
        ordinal: row.ordinal,
        // Built from the same exact matches the result card marks, not from
        // `snippet()`: an FTS5 window centred on a stem-only hit can contain
        // no occurrence of the searched token at all.
        excerpt: buildSearchExcerpt(row.text, request.query),
        location,
        heading: row.heading,
        pageLabel: row.page_label,
        rank: row.rank,
        anchor,
      };
    });
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO document_fts(document_fts) VALUES ('rebuild')");
    this.db.exec("INSERT INTO document_fts(document_fts) VALUES ('integrity-check')");
  }

  resolveHit(documentId: string, documentHash: string, chunkId: string, query: string): SearchMatchAnchor | null {
    const request = resolveSearchHitRequestSchema.parse({ documentId, documentHash, chunkId, query });
    const row = this.db.prepare(`
      SELECT c.location_json, c.text
        FROM document_text_chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN document_index_state s ON s.document_id = c.document_id
       WHERE c.id = ? AND c.document_id = ?
         AND d.file_hash = ? AND s.published_document_hash = d.file_hash
    `).get(request.chunkId, request.documentId, request.documentHash) as { location_json: string; text: string } | undefined;
    if (!row) return null;
    try {
      const location = parseDocumentLocation(parsePortableJson(row.location_json));
      if (!location) return null;
      return createSearchMatchAnchor({
        chunkId: request.chunkId,
        documentId: request.documentId,
        documentHash: request.documentHash,
        location,
        text: row.text,
        query: request.query,
      });
    } catch {
      return null;
    }
  }

  /** The document's current content hash, or null when it no longer exists. */
  private currentFileHash(documentId: string): string | null {
    const row = this.db.prepare('SELECT file_hash FROM documents WHERE id = ?')
      .get(documentId) as { file_hash: string } | undefined;
    return row?.file_hash ?? null;
  }

  private requireDocument(documentId: string, documentHash: string): DocumentIdentityRow {
    const document = this.db.prepare('SELECT file_hash, format FROM documents WHERE id = ?')
      .get(documentId) as DocumentIdentityRow | undefined;
    if (!document) throw new InterleafError('validation', 'The indexed document does not exist.');
    if (document.file_hash !== documentHash) {
      throw new InterleafError('validation', 'The document changed during indexing.');
    }
    return document;
  }

  private requireGeneration(documentId: string, documentHash: string, generationId: string): IndexStateRow {
    const state = this.db.prepare(`
      SELECT * FROM document_index_state
       WHERE document_id = ? AND document_hash = ? AND generation_id = ? AND status = 'indexing'
    `).get(documentId, documentHash, generationId) as IndexStateRow | undefined;
    if (!state) throw new InterleafError('validation', 'The indexing generation is stale or unavailable.');
    return state;
  }
}
