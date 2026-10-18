import { createHash } from 'node:crypto';
import type { ChatContextItem, ChatSourceEnvelopeItem } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import type { ContextChunk, ContextDocument } from './context-repository';

/** One source of a request, before the request assigns its local source ID. */
export type SourceDraft = Omit<ChatSourceEnvelopeItem, 'sourceId'>;

/**
 * A document source an earlier accepted turn in this conversation sent, as it
 * was stored beside that turn's answer.
 *
 * It carries no source ID and no document identity of its own: identifiers are
 * request-local, and the document header of the request that resends it is the
 * one that applies.
 */
export type ReplayedChatSource = Omit<
  ChatSourceEnvelopeItem,
  'sourceId' | 'documentTitle' | 'documentFormat'
>;

/**
 * The three shapes a request's document context arrives in — a pinned context
 * item, a stored snapshot of an earlier turn, and an indexed chunk — restated
 * as the one shape the envelope is serialized from.
 */
export function contextItemToSource(documentInfo: ContextDocument, item: ChatContextItem): SourceDraft {
  const pageLabel =
    typeof item.provenance.pageLabel === 'string'
      ? item.provenance.pageLabel
      : null;
  const heading =
    typeof item.provenance.heading === 'string'
      ? item.provenance.heading
      : null;
  return {
    documentId: documentInfo.id,
    documentHash: documentInfo.documentHash,
    documentTitle: documentInfo.title,
    documentFormat: documentInfo.format,
    chunkId: null,
    contextItemId: item.id,
    location: item.location,
    excerptText: item.excerptText,
    excerptHash: item.excerptHash,
    heading,
    pageLabel,
    label: item.displayLabel,
  };
}

/**
 * A stored snapshot, re-stated as a source of the request that resends it.
 *
 * The document header comes from this request, and the item is deliberately
 * not attributed to a context item: the snapshot belongs to the turn that sent
 * it, whose context item may since have been removed, and a replayed passage is
 * not this turn's explicit context either way. Its source ID is assigned by the
 * caller, request-locally.
 */
export function replayToSource(documentInfo: ContextDocument, prior: ReplayedChatSource): SourceDraft {
  return {
    documentId: documentInfo.id,
    documentHash: documentInfo.documentHash,
    documentTitle: documentInfo.title,
    documentFormat: documentInfo.format,
    chunkId: prior.chunkId,
    contextItemId: null,
    location: prior.location,
    excerptText: prior.excerptText,
    excerptHash: prior.excerptHash,
    heading: prior.heading,
    pageLabel: prior.pageLabel,
    label: prior.label,
  };
}

export function chunkToSource(documentInfo: ContextDocument, chunk: ContextChunk): SourceDraft {
  const excerptHash = createHash('sha256').update(chunk.text, 'utf8').digest('hex');
  return {
    documentId: documentInfo.id,
    documentHash: documentInfo.documentHash,
    documentTitle: documentInfo.title,
    documentFormat: documentInfo.format,
    chunkId: chunk.id,
    contextItemId: null,
    location: chunk.location,
    excerptText: chunk.text,
    excerptHash,
    heading: chunk.heading,
    pageLabel: chunk.pageLabel,
    label: formatSourceLabel(chunk.pageLabel, chunk.heading, chunk.location),
  };
}

export function formatSourceLabel(
  pageLabel: string | null,
  heading: string | null,
  location: DocumentLocation
): string {
  const trimmedPage = pageLabel?.trim();
  const trimmedHeading = heading?.trim();
  if (trimmedPage && trimmedHeading) {
    return `Page ${trimmedPage} · ${trimmedHeading}`;
  }
  if (trimmedPage) {
    return `Page ${trimmedPage}`;
  }
  if (trimmedHeading) {
    return trimmedHeading;
  }
  return fallbackLocationLabel(location);
}

function fallbackLocationLabel(location: DocumentLocation): string {
  if (location.format === 'pdf') {
    return `Page ${String(location.pageIndex + 1)}`;
  }
  if (location.format === 'pptx') {
    return `Slide ${String((location.renderedPageIndex ?? 0) + 1)}`;
  }
  if (location.format === 'docx') {
    return `Paragraph ${String(location.paragraphIndex + 1)}`;
  }
  if (location.format === 'markdown') {
    return `Block ${String(location.blockIndex + 1)}`;
  }
  return 'Document passage';
}
