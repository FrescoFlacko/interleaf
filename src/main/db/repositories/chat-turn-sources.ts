import { parseDocumentLocation } from '@shared/schemas/document';
import type { ChatSourceEnvelopeItem } from '@shared/types/ai';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';

/**
 * One document source a previous accepted turn sent, as it was stored beside
 * that turn's answer. It carries no source ID: identifiers are request-local,
 * so a replayed snapshot is renumbered for the request that resends it.
 */
export type StoredTurnSource = Omit<ChatSourceEnvelopeItem, 'sourceId' | 'documentTitle' | 'documentFormat'>;

export type TurnSourceRow = {
  readonly document_id: string;
  readonly document_hash: string;
  readonly chunk_id: string | null;
  readonly context_item_id: string | null;
  readonly location_json: string;
  readonly excerpt_text: string;
  readonly excerpt_hash: string;
  readonly heading: string | null;
  readonly page_label: string | null;
  readonly display_label: string;
  readonly message_ordinal: number;
  readonly source_ordinal: number;
};

function parseTurnSourceLocation(json: string): PortableValue {
  try {
    return parsePortableJson(json);
  } catch {
    return null;
  }
}

/**
 * Maps the bounded rows SQLite selected. Ordering, unique-source
 * deduplication, and the hard limit all happened in the query; a row whose
 * stored location cannot be parsed is dropped here as the last guard, because
 * a snapshot that cannot be re-anchored is not a source worth replaying.
 */
export function mapTurnSourceRows(rows: readonly TurnSourceRow[]): readonly StoredTurnSource[] {
  const sources: StoredTurnSource[] = [];
  for (const row of rows) {
    const rawLocation = parseTurnSourceLocation(row.location_json);
    const location = parseDocumentLocation(rawLocation);
    if (!location) continue;
    sources.push({
      documentId: row.document_id,
      documentHash: row.document_hash,
      chunkId: row.chunk_id,
      contextItemId: row.context_item_id,
      location,
      excerptText: row.excerpt_text,
      excerptHash: row.excerpt_hash,
      heading: row.heading,
      pageLabel: row.page_label,
      label: row.display_label,
    });
  }
  return sources;
}
