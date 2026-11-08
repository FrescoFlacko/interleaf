import { z } from 'zod';
import type { InterleafDatabase } from '../db/database';
import type { SearchRepository } from '../db/repositories/search-repository';
import type { AnnotationRepository } from '../db/repositories/annotation-repository';
import type { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parsePortableJson } from '@shared/models/portable';
import { documentLocationSchema } from '@shared/schemas/document';
import { searchPassageAnchor } from './search-passage';
import type { PassageReference } from './passage-link';

const id = z.string().min(1).max(128);
export const searchInput = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(20).default(20) }).strict();
export const documentInput = z.object({ documentId: id }).strict();
export const passageInput = documentInput.extend({ documentHash: z.string().min(1).max(256), chunkId: id }).strict();
export const annotationInput = documentInput.extend({ limit: z.number().int().min(1).max(20).default(20), offset: z.number().int().min(0).max(10_000_000).default(0) }).strict();
export const historyInput = z.object({ documentId: id.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
type ChunkRow = { document_id: string; file_hash: string; text: string; location_json: string; heading: string | null; page_label: string | null };
type HistoryRow = { document_id: string; document_hash: string; location_json: string; progress: number; recorded_at: string };

/** Main-owned projections only: no filesystem paths, SQL, or renderer authority. */
export class LibraryReader {
  constructor(private readonly db: InterleafDatabase, private readonly search: SearchRepository,
    private readonly annotations: AnnotationRepository, private readonly positions: ReadingPositionRepository) {}

  searchLibrary(input: z.input<typeof searchInput>) {
    const request = searchInput.parse(input);
    const coverage = this.db.raw.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN s.published_document_hash = d.file_hash THEN 1 ELSE 0 END) AS indexed
      FROM documents d LEFT JOIN document_index_state s ON s.document_id = d.id`).get() as { total: number; indexed: number | null };
    return { hits: this.search.search(undefined, request.query, request.limit),
      coverage: { totalDocuments: coverage.total, indexedDocuments: coverage.indexed ?? 0 } };
  }

  resolvePassage(reference: PassageReference) {
    if (!reference.query) throw new InterleafError('validation', 'This link does not identify an exact passage. Search again to make a new link.');
    const match = this.search.resolveHit(reference.documentId, reference.documentHash, reference.chunkId, reference.query);
    if (!match) throw new InterleafError('validation', 'Passage is unavailable or its document has changed.');
    return { documentId: match.documentId, documentHash: match.documentHash, anchor: searchPassageAnchor(match) };
  }

  getPassage(input: z.input<typeof passageInput>) {
    const request = passageInput.parse(input);
    const row = this.db.raw.prepare(`SELECT d.id AS document_id, d.file_hash, c.text, c.location_json, c.heading, c.page_label
      FROM documents d JOIN document_index_state s ON s.document_id = d.id
      JOIN document_text_chunks c ON c.document_id = d.id
      WHERE d.id = ? AND d.file_hash = ? AND s.published_document_hash = d.file_hash AND c.id = ?`)
      .get(request.documentId, request.documentHash, request.chunkId) as ChunkRow | undefined;
    if (!row) throw new InterleafError('validation', 'Passage is unavailable or its document has changed.');
    const text = row.text.slice(0, 16_000);
    return { documentId: row.document_id, documentHash: row.file_hash, chunkId: request.chunkId,
      text, truncated: text.length < row.text.length, location: documentLocationSchema.parse(parsePortableJson(row.location_json)),
      heading: row.heading, pageLabel: row.page_label };
  }

  getAnnotations(input: z.input<typeof annotationInput>) {
    const request = annotationInput.parse(input);
    const page = this.annotations.page(request.documentId, { limit: request.limit, offset: request.offset });
    return { ...page, items: page.items.map((item) => {
      const anchorTooLarge = JSON.stringify(item.anchor).length > 8_000;
      return { ...item, anchor: anchorTooLarge ? null : item.anchor,
        selectedText: item.selectedText?.slice(0, 4_000) ?? null, note: item.note?.slice(0, 4_000) ?? null,
        truncated: anchorTooLarge || (item.selectedText?.length ?? 0) > 4_000 || (item.note?.length ?? 0) > 4_000 };
    }) };
  }

  getReadingPosition(input: z.input<typeof documentInput>) {
    const request = documentInput.parse(input);
    const row = this.positions.findByDocumentId(request.documentId);
    return row ? { documentId: row.documentId, location: documentLocationSchema.parse(parsePortableJson(row.locationJson)),
      progress: row.progress, updatedAt: row.updatedAt } : null;
  }

  getReadingHistory(input: z.input<typeof historyInput>) {
    const request = historyInput.parse(input);
    const rows = request.documentId
      ? this.db.raw.prepare('SELECT document_id, document_hash, location_json, progress, recorded_at FROM reading_history WHERE document_id = ? ORDER BY id DESC LIMIT ?').all(request.documentId, request.limit)
      : this.db.raw.prepare('SELECT document_id, document_hash, location_json, progress, recorded_at FROM reading_history ORDER BY id DESC LIMIT ?').all(request.limit);
    return { coverage: 'Events recorded after this feature was enabled; earlier history is unavailable.',
      events: (rows as HistoryRow[]).map((row) => ({ documentId: row.document_id, documentHash: row.document_hash,
        location: documentLocationSchema.parse(parsePortableJson(row.location_json)), progress: row.progress, recordedAt: row.recorded_at })) };
  }
}
