import { CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { ChatContextAttachInput } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import type { ChatRepository } from '../db/repositories/chat-repository';
import type { ContextChunk } from './context-repository';
import { wholeDocumentProvenance } from './whole-document-intent';
import { descriptorSpansMultipleUnits, descriptorToDisplayLabel, descriptorToLocation } from './selection-descriptor';

type StoredContext = Omit<Parameters<ChatRepository['createContext']>[0], 'sessionId' | 'documentId' | 'documentHash'>;
type AttachInput<K extends ChatContextAttachInput['kind']> = Extract<ChatContextAttachInput, { kind: K }>;

/** The quoted start of a short selection, or the descriptor's own label. */
function selectionLabel(input: AttachInput<'selection'>, cleanSnippet: string): string {
  if (descriptorSpansMultipleUnits(input.descriptor) || cleanSnippet.length === 0) {
    return descriptorToDisplayLabel(input.descriptor);
  }
  const ellipsis = cleanSnippet.length > 72 ? '…' : '';
  return `“${cleanSnippet.slice(0, 72)}${ellipsis}”`;
}

function selectionContext(input: AttachInput<'selection'>, documentFormat: string): StoredContext {
  if (input.descriptor.format !== documentFormat) {
    throw new InterleafError('validation', 'Selected context does not match the active document.');
  }
  const rawSnippet = input.descriptor.selectedTextSnippet ??
    input.descriptor.startQuote?.exact ??
    '';
  const cleanSnippet = rawSnippet.replace(/\s+/gu, ' ').trim();
  return {
    kind: 'selection',
    // Keep the chat selection descriptor as the durable source reference.
    // It is deliberately separate from annotation anchors: large Chat
    // selections may not have a valid annotation anchor, but the descriptor
    // still lets ContextBuilder resolve every indexed chunk after reload.
    sourceRef: { descriptor: input.descriptor },
    excerptText: rawSnippet,
    location: descriptorToLocation(input.descriptor),
    // Only a paged format has a page label; for the others the member is
    // left out rather than written as an absent one, which is the same
    // record once it has been stored as JSON.
    provenance: input.descriptor.format === 'pdf'
      ? { pageLabel: input.descriptor.startPageLabel ?? String(input.descriptor.startPageIndex + 1) }
      : {},
    displayLabel: selectionLabel(input, cleanSnippet),
  };
}

function requireValidPageRange(input: AttachInput<'range'>, documentFormat: string, documentPageCount: number | null): void {
  if (documentFormat !== 'pdf') {
    throw new InterleafError('validation', 'Page ranges are currently available for PDF documents.');
  }
  if (!Number.isSafeInteger(input.pageStart) || !Number.isSafeInteger(input.pageEnd) || input.pageStart < 1 || input.pageEnd < 1) {
    throw new InterleafError('validation', 'Page range values must be positive whole numbers.');
  }
  if (input.pageEnd < input.pageStart) {
    throw new InterleafError('validation', 'End page must be greater than or equal to start page.');
  }
  if (input.pageEnd - input.pageStart + 1 > CHAT_MAX_PAGE_RANGE) {
    throw new InterleafError('validation', `Page range exceeds the safe maximum of ${String(CHAT_MAX_PAGE_RANGE)} pages.`);
  }
  if (documentPageCount !== null && input.pageEnd > documentPageCount) {
    throw new InterleafError('validation', `Page range exceeds this document's ${String(documentPageCount)} pages.`);
  }
}

function rangeContext(input: AttachInput<'range'>, chunks: readonly ContextChunk[]): StoredContext {
  const first = chunks[0];
  if (!first) throw new InterleafError('validation', 'The requested pages are not available in the current search index.');
  return {
    kind: 'range',
    sourceRef: { format: 'pdf', pageStart: input.pageStart, pageEnd: input.pageEnd },
    excerptText: chunks.map((chunk) => chunk.text).join('\n\n'),
    location: first.location,
    provenance: { pageLabel: `${String(input.pageStart)}–${String(input.pageEnd)}` },
    displayLabel: input.pageStart === input.pageEnd
      ? `Page ${String(input.pageStart)}`
      : `Pages ${String(input.pageStart)}–${String(input.pageEnd)}`,
  };
}

function locationContext(input: AttachInput<'location'>, chunk: ContextChunk | null): StoredContext {
  if (!chunk) throw new InterleafError('validation', 'The current location is not available in the search index.');
  return {
    kind: 'location',
    sourceRef: { location: input.location },
    excerptText: chunk.text,
    location: chunk.location,
    provenance: { pageLabel: chunk.pageLabel, heading: chunk.heading },
    displayLabel: chunk.pageLabel ? `Page ${chunk.pageLabel}` : chunk.heading ?? 'Current location',
  };
}

function requireDocumentLocation(location: DocumentLocation, documentFormat: string): void {
  if (location.format !== documentFormat) {
    throw new InterleafError('validation', 'Context location does not match the active document.');
  }
}

/**
 * The stored form of one attach request: what the item is, its excerpt, its
 * location and its label, derived in main from the reader's descriptor and the
 * document's own index rather than taken from the renderer.
 */
export function deriveContext(
  input: ChatContextAttachInput,
  documentFormat: string,
  documentPageCount: number | null,
  pageRange: (start: number, end: number) => readonly ContextChunk[],
  closest: (location: DocumentLocation) => ContextChunk | null
): StoredContext {
  if (input.kind === 'selection') return selectionContext(input, documentFormat);
  if (input.kind === 'range') {
    requireValidPageRange(input, documentFormat, documentPageCount);
    return rangeContext(input, pageRange(input.pageStart, input.pageEnd));
  }
  requireDocumentLocation(input.location, documentFormat);
  if (input.kind === 'location') return locationContext(input, closest(input.location));
  return {
    kind: 'entire_document',
    sourceRef: { entireDocument: true },
    excerptText: '',
    location: input.location,
    // Records whether the user pinned the document or Reader Chat attached it
    // for them; the context builder reads it to decide which ADR-0006 level
    // the attachment carries.
    provenance: wholeDocumentProvenance(input.automatic),
    displayLabel: 'Entire document',
  };
}
