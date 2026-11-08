import type { DatabaseSync } from 'node:sqlite';
import { documentAnchorSchema } from '@shared/schemas/annotation';
import { parsePortableJson } from '@shared/models/portable';
import type { AgentSource } from '@shared/schemas/agent-access';
import type { PracticeSource } from '@shared/schemas/practice';
import { sourceMatchesChunk } from '../agent-access/source-validation';

type Native = Extract<PracticeSource, { kind: 'native' }>;
type Chunk = { id: string; text: string; location_json: string };
type Annotation = { id: string; anchor_json: string; document_hash: string; selected_text: string; status: string };
type SourceRow = { document_id: string | null; quote: string; verified_annotation_id: string | null; verified_chunk_id: string | null };

/** The existing highlight and the published index are separate pieces of evidence. */
function nativeSource(db: DatabaseSync, row: SourceRow, annotationId: string, chunkId: string): Native | null {
  if (!row.document_id) return null;
  const doc = db.prepare(`SELECT d.file_hash, d.format, s.published_total_chunks FROM documents d JOIN document_index_state s ON s.document_id = d.id
    WHERE d.id = ? AND s.published_document_hash = d.file_hash`).get(row.document_id) as { file_hash: string; format: string; published_total_chunks: number } | undefined;
  const annotation = db.prepare(`SELECT id, anchor_json, document_hash, selected_text, status FROM annotations
    WHERE id = ? AND document_id = ? AND type = 'highlight'`).get(annotationId, row.document_id) as Annotation | undefined;
  const chunk = db.prepare('SELECT id, text, location_json FROM document_text_chunks WHERE document_id = ? AND id = ?')
    .get(row.document_id, chunkId) as Chunk | undefined;
  if (!doc || !annotation || !chunk || annotation.status !== 'anchored' || annotation.document_hash !== doc.file_hash || annotation.selected_text !== row.quote) return null;
  const count = db.prepare('SELECT COUNT(*) AS count FROM document_text_chunks WHERE document_id = ?').get(row.document_id) as { count: number };
  if (count.count !== doc.published_total_chunks) return null;
  try {
    const anchor = documentAnchorSchema.parse(parsePortableJson(annotation.anchor_json));
    if (anchor.format !== doc.format || anchor.quote.exact !== row.quote) return null;
    const candidate: AgentSource = { documentId: row.document_id, documentHash: doc.file_hash, chunkId, anchor };
    if (!sourceMatchesChunk(candidate, chunk.location_json, chunk.text)) return null;
    return { kind: 'native', documentId: row.document_id, documentHash: doc.file_hash, annotationId, chunkId, anchor };
  } catch { return null; }
}

/** A verified link remains valid only while its exact native and indexed evidence remains current. */
export function resolveVerifiedSource(db: DatabaseSync, row: SourceRow): Native | null {
  return row.verified_annotation_id && row.verified_chunk_id
    ? nativeSource(db, row, row.verified_annotation_id, row.verified_chunk_id) : null;
}

/** Refuse ambiguous or oversized searches; a title or provider page never establishes an anchor. */
export function findUniqueVerifiedSource(db: DatabaseSync, row: SourceRow): Native | null {
  if (!row.document_id || !row.quote) return null;
  const budget = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(text)), 0) AS chars FROM
    (SELECT text FROM document_text_chunks WHERE document_id = ? LIMIT 1001)`).get(row.document_id) as { count: number; chars: number };
  if (budget.count > 1000 || budget.chars > 20_000_000) return null;
  const chunks = db.prepare('SELECT id, text, location_json FROM document_text_chunks WHERE document_id = ? AND instr(text, ?) > 0 LIMIT 2')
    .all(row.document_id, row.quote) as Chunk[];
  const annotations = db.prepare(`SELECT id, anchor_json, document_hash, selected_text, status FROM annotations
    WHERE document_id = ? AND type = 'highlight' AND selected_text = ? AND status = 'anchored' LIMIT 2`).all(row.document_id, row.quote) as Annotation[];
  if (chunks.length !== 1 || annotations.length !== 1) return null;
  const [chunk] = chunks;
  const [annotation] = annotations;
  if (!chunk || !annotation || chunk.text.indexOf(row.quote) !== chunk.text.lastIndexOf(row.quote)) return null;
  return nativeSource(db, row, annotation.id, chunk.id);
}
