import type { ChatContextDisclosure, ChatContextItem } from '@shared/types/ai';
import { bandLabelMember } from './nearby-band-label';
import type { PortableRecord } from '@shared/models/portable';

/**
 * Whether a whole-document attachment was asked for by the user or added on
 * their behalf.
 *
 * ADR-0006 treats an explicit override as Level 1 authority: the user pinned the
 * document, so whole ingestion is attempted up to the higher authorized share of
 * the model context window, and past that the turn is built from a bounded band
 * of context around the reader's current location rather than refused. Context
 * that Reader Chat attaches automatically for an otherwise empty question is
 * Level 2, held to the lower share, and falls back to retrieval.
 *
 * The distinction rides on the context item's bounded provenance record, which
 * the repository already persists, so no schema migration and no new IPC
 * surface is involved.
 */
const ATTACHMENT_KEY = 'attachment';
const AUTOMATIC = 'automatic';

/** Provenance for a whole-document attachment of the given intent. */
export function wholeDocumentProvenance(automatic: boolean | undefined): PortableRecord {
  return automatic === true ? { [ATTACHMENT_KEY]: AUTOMATIC } : {};
}

export function isAutomaticProvenance(provenance: PortableRecord): boolean {
  return provenance[ATTACHMENT_KEY] === AUTOMATIC;
}

function isWholeDocument(item: ChatContextItem): boolean {
  return item.pinned && item.kind === 'entire_document';
}

/**
 * True only for a whole-document item the user pinned themselves. An automatic
 * attachment stays subject to the Level-2 ratio instead of carrying explicit
 * pinned authority.
 */
export function hasExplicitWholeDocument(items: readonly ChatContextItem[]): boolean {
  return items.some((item) => isWholeDocument(item) && !isAutomaticProvenance(item.provenance));
}

/**
 * The whole-document item the reader pinned themselves, if any.
 *
 * Its stored location is the fallback anchor for nearby context: a reader who
 * pinned the document from page 300 and then asks without sending a live
 * location still gets context from where they were, not from page 1.
 */
export function explicitWholeDocumentItem(
  items: readonly ChatContextItem[]
): ChatContextItem | undefined {
  return items.find((item) => isWholeDocument(item) && !isAutomaticProvenance(item.provenance));
}

/**
 * Says so, on the turn itself, when a whole-document attachment was too large
 * to ingest whole and something narrower answered the question instead.
 *
 * Without it the composer's “Entire document” chip would be the only thing the
 * reader sees, and it would claim more than was actually sent. The two cases are
 * named apart, because they are not the same promise: an automatic attachment
 * fell back to retrieval across the document, while a pinned one fell back to a
 * bounded band of context around where the reader is.
 */
export function wholeDocumentFallbackDisclosures(
  items: readonly ChatContextItem[],
  outcome: {
    readonly fullDocIncluded: boolean;
    readonly includedChunks: number;
    readonly stats: { readonly chunkCount: number } | null;
    /** Where the included context came from, when the format can say. */
    readonly includedLabel: string | null;
  }
): readonly ChatContextDisclosure[] {
  if (outcome.fullDocIncluded) return [];
  const attached = fallenBackWholeDocument(items);
  if (!attached) return [];
  const totalChunks = outcome.stats?.chunkCount ?? 0;
  const includedChunks = Math.min(Math.max(0, outcome.includedChunks), totalChunks);
  return [
    {
      contextItemId: attached.item.id,
      displayLabel: attached.item.displayLabel,
      totalChunks,
      includedChunks,
      omittedChunks: totalChunks - includedChunks,
      reason: attached.reason,
      ...bandLabelMember(outcome.includedLabel),
    },
  ];
}

/**
 * The whole-document attachment this turn fell back on, with the reason that
 * belongs to it: a pin falls back to a band of nearby context, and an automatic
 * attachment falls back to retrieval bounded by the model context window.
 */
function fallenBackWholeDocument(items: readonly ChatContextItem[]): {
  readonly item: ChatContextItem;
  readonly reason: ChatContextDisclosure['reason'];
} | null {
  const explicit = explicitWholeDocumentItem(items);
  if (explicit) return { item: explicit, reason: 'nearby_context_only' };
  const automatic = items.find((item) => isWholeDocument(item) && isAutomaticProvenance(item.provenance));
  return automatic ? { item: automatic, reason: 'model_context_window' } : null;
}
