import { sourceKey } from '../../highlight-import/source-key';
import { findUniqueVerifiedSource, resolveVerifiedSource } from '../../highlight-import/verified-source';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import type { ImportedSource } from '../../highlight-import/parser';
import type { ImportedHighlight } from '@shared/types/imported-highlight';

type Row = { id: string; provider: 'kindle' | 'readwise'; title: string; author: string | null; quote: string;
  note: string | null; source_location: string | null; source_date: string | null; document_id: string | null;
  verified_annotation_id: string | null; verified_chunk_id: string | null };
function fingerprint(source: ImportedSource): string {
  return createHash('sha256').update(JSON.stringify([source.provider, source.title, source.author, source.quote,
    source.note, source.location, source.date])).digest('hex');
}
function project(row: Row, native: ReturnType<typeof resolveVerifiedSource>): ImportedHighlight {
  return { id: row.id, provider: row.provider, title: row.title, author: row.author, quote: row.quote,
    note: row.note, location: row.source_location, date: row.source_date, documentId: row.document_id,
    verifiedAnchor: native?.anchor ?? null, verifiedDocumentHash: native?.documentHash ?? null };
}
export class ExternalHighlightRepository {
  private readonly db: DatabaseSync;
  constructor(database: InterleafDatabase) { this.db = database.raw; }
  has(source: ImportedSource): boolean {
    return this.db.prepare('SELECT 1 FROM external_highlights WHERE fingerprint = ?').get(fingerprint(source)) !== undefined;
  }
  /** Main-only bounded projection for review; association does not establish a verified passage. */
  resolveSource(id: string): ImportedHighlight | null {
    const row = this.db.prepare('SELECT * FROM external_highlights WHERE id = ?').get(id) as Row | undefined;
    return row ? project(row, resolveVerifiedSource(this.db, row)) : null;
  }
  list(offset: number): readonly ImportedHighlight[] {
    const rows = this.db.prepare('SELECT * FROM external_highlights ORDER BY created_at DESC, id LIMIT 50 OFFSET ?').all(offset) as Row[];
    return rows.map((row) => project(row, resolveVerifiedSource(this.db, row)));
  }
  associate(id: string, documentId: string | null): ImportedHighlight | null {
    if (documentId !== null && !this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(documentId)) throw new Error('The selected library document is no longer available.');
    this.db.prepare('UPDATE external_highlights SET document_id = ?, verified_annotation_id = NULL, verified_chunk_id = NULL WHERE id = ?').run(documentId, id);
    return this.resolveSource(id);
  }
  /** Main-only evidence for a deliberate verified-source action and practice navigation. */
  candidate(id: string) {
    const row = this.db.prepare('SELECT * FROM external_highlights WHERE id = ?').get(id) as Row | undefined;
    return row ? findUniqueVerifiedSource(this.db, row) : null;
  }
  resolveNativeSource(id: string) {
    const row = this.db.prepare('SELECT * FROM external_highlights WHERE id = ?').get(id) as Row | undefined;
    return row ? resolveVerifiedSource(this.db, row) : null;
  }
  verify(id: string, expected: NonNullable<ReturnType<ExternalHighlightRepository['candidate']>>): ImportedHighlight | null {
    const candidate = this.candidate(id);
    if (!candidate || JSON.stringify(candidate) !== JSON.stringify(expected)) throw new Error('The source changed or is ambiguous.');
    this.db.prepare('UPDATE external_highlights SET verified_annotation_id = ?, verified_chunk_id = ? WHERE id = ?')
      .run(candidate.annotationId, candidate.chunkId ?? null, id);
    return this.resolveSource(id);
  }
  commit(records: readonly ImportedSource[], choices: ReadonlyMap<string, string | null>): { inserted: number; duplicates: number } {
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO external_highlights
        (id, fingerprint, provider, title, author, quote, note, source_location, source_date, document_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const record of records) {
        const documentId = choices.get(sourceKey(record)) ?? null;
        if (documentId !== null && !this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(documentId)) throw new Error('The selected library document is no longer available.');
        const result = stmt.run(randomUUID(), fingerprint(record), record.provider, record.title, record.author, record.quote,
          record.note, record.location, record.date, documentId);
        inserted += Number(result.changes);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { inserted, duplicates: records.length - inserted };
  }
}
