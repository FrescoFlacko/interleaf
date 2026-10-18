import type { AgentContextPacket } from '@shared/types/agent';
import type { DocumentAnchor } from '@shared/types/annotation';
import type { DocumentLocation, DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';
import { CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { fitAgentContextPacketToByteBudget, takeCodePointPrefix } from '@shared/agent-context';
import type { DocumentAdapter } from '../features/reader/types';
import { selectActiveDocument, selectAdapter, useReaderStore } from './use-reader-store';
import { buildFallbackAnchor } from './agent-anchor-location';

/**
 * Agent context is captured from the open book, sometimes over many pages.
 * Every explicit choice — attach, remove, cancel, a document change — takes a
 * new revision. A capture holds a claim on the revision it took and on the
 * reader it reads from, and lands only while it still holds both, so a slow
 * extraction can never undo a newer choice or reach another book.
 */
let contextRevision = 0;

export function nextAgentContextRevision(): number {
  contextRevision += 1;
  return contextRevision;
}

/** One capture's claim: the choice it made, the reader it reads, and who may withdraw it. */
export type AgentContextClaim = {
  readonly revision: number;
  readonly documentId: string;
  readonly adapter: DocumentAdapter | null;
  readonly signal: AbortSignal | undefined;
};

/** Takes the latest revision for a capture of `document`, unless it was withdrawn before it began. */
export function claimAgentContext(document: DocumentMetadata, signal?: AbortSignal): AgentContextClaim | null {
  if (signal?.aborted === true) return null;
  return { revision: nextAgentContextRevision(), documentId: document.id, adapter: selectAdapter(useReaderStore.getState()), signal };
}

/** Whether nothing has superseded or withdrawn this capture, and the same reader is still open. */
export function holdsAgentContext(claim: AgentContextClaim): boolean {
  if (claim.revision !== contextRevision || claim.signal?.aborted === true) return false;
  const reader = useReaderStore.getState();
  return selectActiveDocument(reader)?.id === claim.documentId && selectAdapter(reader) === claim.adapter;
}

/** Withdraws a capture, but only while it is still the latest choice: a newer one is never undone. */
export function releaseAgentContext(claim: AgentContextClaim): boolean {
  if (claim.revision !== contextRevision) return false;
  nextAgentContextRevision();
  return true;
}

type ExtractedContext = { readonly text: string; readonly truncated: boolean; readonly scopeLabel?: string };

/** What a capture produced. Whether it may still land is the claim's to say. */
export type AgentContextCapture =
  | { readonly kind: 'attached'; readonly packet: AgentContextPacket }
  | { readonly kind: 'failed'; readonly message: string };

const READER_NOT_READY = 'The document reader is not ready. Try again once the book has opened.';

/**
 * Reads the book's text up to the Agent context limit. Reading stops as soon
 * as the limit is reached or `isPastEnd` says no later chunk can match, so a
 * small range near the start of a long book does not walk the whole book.
 */
async function accumulateText(
  adapter: DocumentAdapter,
  matches: (chunk: NormalizedTextChunk) => boolean = () => true,
  isPastEnd: (chunk: NormalizedTextChunk) => boolean = () => false,
): Promise<ExtractedContext> {
  const chunks: string[] = [];
  let length = 0;
  for await (const chunk of adapter.extractText()) {
    if (isPastEnd(chunk)) break;
    if (!matches(chunk) || chunk.text.length === 0) continue;
    const separator = chunks.length > 0 ? 2 : 0;
    const remaining = AGENT_MAX_CONTEXT_TEXT_LENGTH - length - separator;
    if (chunk.text.length > remaining) {
      if (remaining > 0) chunks.push(takeCodePointPrefix(chunk.text, remaining));
      return { text: chunks.join('\n\n'), truncated: true };
    }
    chunks.push(chunk.text);
    length += separator + chunk.text.length;
  }
  return { text: chunks.join('\n\n'), truncated: false };
}

function boundExplicitText(text: string, sourceTruncated = false): ExtractedContext {
  return {
    text: takeCodePointPrefix(text, AGENT_MAX_CONTEXT_TEXT_LENGTH),
    truncated: sourceTruncated || text.length > AGENT_MAX_CONTEXT_TEXT_LENGTH,
  };
}

/** The one rule for a PDF page range, shared by the page dialog and the store. */
export function pageRangeProblem(
  document: DocumentMetadata,
  pageStart: number,
  pageEnd: number,
  maxRange: number = CHAT_MAX_PAGE_RANGE,
): string | null {
  if (document.format !== 'pdf') return 'Page ranges are only available for PDF documents.';
  if (!Number.isSafeInteger(pageStart) || !Number.isSafeInteger(pageEnd) || pageStart < 1 || pageEnd < 1) {
    return 'Page numbers must be positive whole numbers.';
  }
  if (pageEnd < pageStart) return 'End page must be greater than or equal to start page.';
  if (pageEnd - pageStart + 1 > maxRange) return `Page range cannot exceed ${String(maxRange)} pages.`;
  if (document.pageCount !== null && pageEnd > document.pageCount) {
    return `End page exceeds document total (${String(document.pageCount)} pages).`;
  }
  return null;
}

type CaptureRequest = {
  readonly document: DocumentMetadata;
  /** Text the caller already holds; when absent the open book is read. */
  readonly explicit?: ExtractedContext;
  readonly extract: (adapter: DocumentAdapter) => Promise<ExtractedContext>;
  readonly emptyMessage: string;
  readonly fallbackError: string;
  readonly packet: (exactQuote: string, extracted: ExtractedContext) => AgentContextPacket;
};

/**
 * Even text the caller already holds is only taken from the book the reader
 * has open, so a choice made for one book cannot attach while another opens.
 */
async function capture(request: CaptureRequest, claim: AgentContextClaim): Promise<AgentContextCapture> {
  const adapter = claim.adapter;
  if (adapter === null || selectActiveDocument(useReaderStore.getState())?.id !== request.document.id) {
    return { kind: 'failed', message: READER_NOT_READY };
  }
  try {
    const extracted = request.explicit ?? await request.extract(adapter);
    if (extracted.text.trim().length === 0) return { kind: 'failed', message: request.emptyMessage };
    return { kind: 'attached', packet: fitAgentContextPacketToByteBudget(request.packet(extracted.text, extracted), extracted.truncated) };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : request.fallbackError };
  }
}

function contextPacket(
  document: DocumentMetadata,
  exactQuote: string,
  truncated: boolean,
  target: { readonly anchor: DocumentAnchor; readonly location: DocumentLocation; readonly scopeLabel?: string },
): AgentContextPacket {
  return {
    version: 1,
    ...(target.scopeLabel !== undefined ? { scopeLabel: takeCodePointPrefix(target.scopeLabel, 256) } : {}),
    document: { id: document.id, hash: document.fileHash, title: document.title, author: document.author },
    selection: { exactQuote, anchor: target.anchor, location: target.location, surroundingText: null },
    provenance: {
      source: 'interleaf-reader-selection',
      capturedAt: new Date().toISOString(),
      contentIsUntrustedReference: true,
      truncated,
    },
  };
}

export async function capturePageRange(
  claim: AgentContextClaim,
  document: DocumentMetadata,
  pageStart: number,
  pageEnd: number,
  explicitText?: string,
): Promise<AgentContextCapture> {
  const problem = pageRangeProblem(document, pageStart, pageEnd);
  if (problem !== null) return { kind: 'failed', message: problem };
  const label = pageStart === pageEnd ? `Page ${String(pageStart)}` : `Pages ${String(pageStart)}–${String(pageEnd)}`;
  const inRange = (chunk: NormalizedTextChunk): boolean =>
    chunk.location.format === 'pdf' && chunk.location.pageIndex >= pageStart - 1 && chunk.location.pageIndex <= pageEnd - 1;
  return capture({
    document,
    ...(explicitText !== undefined ? { explicit: boundExplicitText(explicitText) } : {}),
    // PDF text is yielded in page order, so nothing after the last page can match.
    extract: (adapter) => accumulateText(adapter, inRange, (chunk) => chunk.location.format === 'pdf' && chunk.location.pageIndex > pageEnd - 1),
    emptyMessage: `${label} ${pageStart === pageEnd ? 'has' : 'have'} no readable text to attach to Agent context.`,
    fallbackError: 'Could not attach the page range to Agent context.',
    packet: (exactQuote, { truncated }) => {
      const location: DocumentLocation = { format: 'pdf', pageIndex: pageStart - 1, pageLabel: String(pageStart) };
      const anchor: DocumentAnchor = { ...location, quote: { exact: exactQuote, prefix: '', suffix: '' } };
      return contextPacket(document, exactQuote, truncated, { anchor, location, scopeLabel: label });
    },
  }, claim);
}

/** A section's text, read by the caller or from the open book, and how to name it. */
export type SectionSource =
  | { readonly text: string; readonly truncated?: boolean; readonly scopeLabel: string }
  | { readonly read: (adapter: DocumentAdapter) => Promise<{ readonly text: string; readonly truncated: boolean; readonly scopeLabel: string }> };

export function captureSection(
  claim: AgentContextClaim,
  document: DocumentMetadata,
  location: DocumentLocation,
  source: SectionSource,
): Promise<AgentContextCapture> {
  return capture({
    document,
    ...('text' in source ? { explicit: { ...boundExplicitText(source.text, source.truncated), scopeLabel: source.scopeLabel } } : {}),
    extract: async (adapter) => {
      if ('text' in source) return { text: '', truncated: false };
      const read = await source.read(adapter);
      return { ...boundExplicitText(read.text, read.truncated), scopeLabel: read.scopeLabel };
    },
    emptyMessage: 'This section has no readable text to attach to Agent context.',
    fallbackError: 'Could not attach the section to Agent context.',
    // Section text is the canonical payload. Keep the anchor's location for
    // re-anchoring, but do not serialize the same quote twice into the packet.
    packet: (exactQuote, { truncated, scopeLabel }) => contextPacket(document, exactQuote, truncated, {
      anchor: buildFallbackAnchor(document.format, location, exactQuote, false),
      location,
      ...(scopeLabel !== undefined ? { scopeLabel } : {}),
    }),
  }, claim);
}

export const ENTIRE_DOCUMENT_SCOPE = 'Entire document';

export function captureEntireDocument(
  claim: AgentContextClaim,
  document: DocumentMetadata,
  location: DocumentLocation,
  explicitText?: string,
): Promise<AgentContextCapture> {
  return capture({
    document,
    ...(explicitText !== undefined ? { explicit: boundExplicitText(explicitText) } : {}),
    extract: (adapter) => accumulateText(adapter),
    emptyMessage: 'This document has no readable text to attach to Agent context.',
    fallbackError: 'Could not attach the entire document to Agent context.',
    packet: (exactQuote, { truncated }) => contextPacket(document, exactQuote, truncated, {
      anchor: buildFallbackAnchor(document.format, location, exactQuote),
      location,
      scopeLabel: ENTIRE_DOCUMENT_SCOPE,
    }),
  }, claim);
}
