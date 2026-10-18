import {
  CHAT_EXPLICIT_FULL_DOCUMENT_RATIO,
  CHAT_MAX_SOURCES_PER_REQUEST,
} from '@shared/constants/ai';
import type { ChatSourceEnvelopeItem } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import { locationDistance, type ContextChunk } from './context-repository';
import { estimateChatTokens, estimateSourceEnvelopeTokens } from './context-tokens';
import { serializeProvenanceXml, type ProvenanceDocument } from './provenance-serializer';

/** The indexed size of the pinned document, as the index recorded it. */
type PublishedChunkStats = {
  readonly chunkCount: number;
  readonly estimatedTokens: number;
};

type SourceDraft = Omit<ChatSourceEnvelopeItem, 'sourceId'>;

export type PinnedWholeDocumentInput = {
  readonly docHeader: ProvenanceDocument;
  readonly chunks: readonly ContextChunk[];
  readonly stats: PublishedChunkStats;
  /** Turns one indexed chunk into a source of the request being built. */
  readonly toSource: (chunk: ContextChunk) => SourceDraft;
  /** Explicit selections already packed; the band is added after them. */
  readonly explicitDrafts: readonly ChatSourceEnvelopeItem[];
  /** Where the reader is now, or where they were when they pinned it. */
  readonly anchor: DocumentLocation | null;
  readonly contextWindow: number;
  /** Framing, question, history, response reserve and headroom, already charged. */
  readonly baseTokens: number;
};

export type PinnedWholeDocumentResult = {
  readonly sources: readonly ChatSourceEnvelopeItem[];
  readonly fullDocIncluded: boolean;
};

/**
 * The sources to send for a whole document the reader pinned themselves.
 *
 * Whole ingestion is authorized only while the indexed estimate stays under the
 * share of the window ADR-0006 allows a Level-1 pin, and even then only if the
 * exact packed request fits. Past either bound the turn is not refused and the
 * document is not sent whole: it is answered from a bounded band of context
 * around where the reader is, disclosed as such on the turn itself.
 */
export function packPinnedWholeDocument(input: PinnedWholeDocumentInput): PinnedWholeDocumentResult {
  const whole = packWholeDocument(input);
  if (whole !== null) return { sources: whole, fullDocIncluded: true };
  return { sources: packNearbyContext(input), fullDocIncluded: false };
}

/** The whole document, or null when it does not fit within either bound. */
function packWholeDocument(input: PinnedWholeDocumentInput): readonly ChatSourceEnvelopeItem[] | null {
  const { explicitDrafts, stats } = input;
  const withinRatio =
    stats.estimatedTokens <= Math.floor(input.contextWindow * CHAT_EXPLICIT_FULL_DOCUMENT_RATIO);
  const withinSourceLimit = stats.chunkCount <= CHAT_MAX_SOURCES_PER_REQUEST - explicitDrafts.length;
  if (!withinRatio || !withinSourceLimit) return null;

  // The whole document subsumes anything replayed from earlier turns, so the
  // replayed sources are dropped rather than sent twice.
  const candidates = [
    ...explicitDrafts,
    ...input.chunks.map((chunk, index) => ({
      ...input.toSource(chunk),
      sourceId: `src-${String(explicitDrafts.length + index + 1)}`,
    })),
  ];
  const candidateXml = serializeProvenanceXml(input.docHeader, candidates);
  const totalTokens = input.baseTokens + estimateChatTokens(candidateXml);
  return totalTokens <= input.contextWindow ? candidates : null;
}

/**
 * A bounded band of document context centred on the reader's position.
 *
 * Candidates are considered outward from the anchor — the anchor chunk, then the
 * one before it, then the one after, and so on — and packing stops at the first
 * candidate that does not fit. Stopping rather than skipping is what keeps the
 * band contiguous: every prefix of that ordering is an unbroken run of ordinals.
 * The result is re-sorted into document order, because the model reads the
 * envelope as a passage of the document and not as a ranked list.
 *
 * Every candidate is charged against the exact serialized request — framing,
 * question, history, response reserve and headroom already subtracted — and
 * against the per-request source limit, so the packed envelope cannot exceed
 * either bound.
 */
function packNearbyContext(input: PinnedWholeDocumentInput): readonly ChatSourceEnvelopeItem[] {
  const { chunks, explicitDrafts } = input;
  const maxSources = Math.max(0, CHAT_MAX_SOURCES_PER_REQUEST - explicitDrafts.length);
  if (maxSources === 0 || chunks.length === 0) return explicitDrafts;

  const chosen = chooseNearbyChunks(input, maxSources);
  return [
    ...explicitDrafts,
    ...chosen.map((chunk, index) => ({
      ...input.toSource(chunk),
      sourceId: `src-${String(explicitDrafts.length + index + 1)}`,
    })),
  ];
}

/** The chunks of the band, in document order, that the budget actually allows. */
function chooseNearbyChunks(
  input: PinnedWholeDocumentInput,
  maxSources: number
): readonly ContextChunk[] {
  const { chunks, explicitDrafts } = input;
  const anchor = anchorOrdinal(chunks, input.anchor);
  const ordered = chunks.toSorted((left, right) => {
    const distance = Math.abs(left.ordinal - anchor) - Math.abs(right.ordinal - anchor);
    return distance !== 0 ? distance : left.ordinal - right.ordinal;
  });

  // Charged one source at a time against the same per-source estimate the
  // explicit-selection packer uses, which bounds the serialized envelope from
  // above; a whole-envelope serialization per candidate would be quadratic in
  // the chunk count, and this document is large by definition.
  let used = estimateChatTokens(serializeProvenanceXml(input.docHeader, explicitDrafts));
  const chosen: ContextChunk[] = [];
  for (const chunk of ordered) {
    if (chosen.length >= maxSources) break;
    const candidate: ChatSourceEnvelopeItem = {
      ...input.toSource(chunk),
      sourceId: `src-${String(explicitDrafts.length + chosen.length + 1)}`,
    };
    const cost = estimateSourceEnvelopeTokens(candidate);
    if (input.baseTokens + used + cost > input.contextWindow) break;
    used += cost;
    chosen.push(chunk);
  }
  return chosen.toSorted((left, right) => left.ordinal - right.ordinal);
}

/**
 * The ordinal of the indexed chunk closest to where the reader is.
 *
 * Distance is measured in each format's own units, and a location the format
 * cannot compare — a stale anchor, an EPUB CFI from another spine item — yields
 * no finite distance at all. Rather than guess, that case anchors at the start
 * of the document, which is a bounded, ordered, truthful band like any other.
 */
function anchorOrdinal(chunks: readonly ContextChunk[], anchor: DocumentLocation | null): number {
  let best = chunks[0]?.ordinal ?? 0;
  if (!anchor) return best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    const distance = locationDistance(anchor, chunk.location);
    if (distance < bestDistance) {
      best = chunk.ordinal;
      bestDistance = distance;
    }
  }
  return best;
}
