import type { ChatContextAttachInput, ChatContextItem } from '@shared/types/ai';
import type { ChatSelectionDescriptor, DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { bridge } from '../../app/api-client';
import { errorMessage, sameDocumentLoad, type ChatRuntime } from './runtime';
import { ensureSessionForDocument } from './session-actions';
import { upsertContextItem } from './transcript';
import { useReaderStore } from '../use-reader-store';
import type { ChatState } from '../use-chat-store';

export const ATTACH_FAILED_ERROR = 'Could not add nearby document context.';
const AUTOMATIC_PDF_PAGE_RADIUS = 10;

/**
 * The result of one attachment request. `error` is the message the caller may
 * show, left for the caller to place because an attachment made on the user's
 * behalf must only ever be reported to the conversation that asked for it —
 * never to whichever session happens to be on screen when the request settles.
 */
type AttachOutcome = { readonly attached: boolean; readonly error: string | null };

/**
 * True while the store still shows the session and document revision an
 * attachment was requested for. A session or document switch that lands during
 * the request must not write its result into the conversation now on screen.
 */
function attachmentStillCurrent(state: ChatState, sessionId: string, document: DocumentMetadata): boolean {
  return state.activeSessionId === sessionId && sameDocumentLoad(state, document.id, document.fileHash);
}

/** The chip in the context bar is the confirmation; no status line repeats it. */
function publishAttached(runtime: ChatRuntime, item: ChatContextItem, extra: Partial<ChatState> = {}): void {
  runtime.set((state) => ({
    contextItems: upsertContextItem(state.contextItems, item),
    error: null,
    statusMessage: '',
    ...extra,
  }));
}

/**
 * Ensures a conversation, attaches `input` to it, and publishes the chip if the
 * conversation is still the one on screen. Failure is returned, not reported.
 */
async function attachToDocument(
  runtime: ChatRuntime,
  document: DocumentMetadata,
  input: ChatContextAttachInput | (() => ChatContextAttachInput),
  fallbackError: string
): Promise<{ readonly outcome: AttachOutcome; readonly item: ChatContextItem | null }> {
  const session = await ensureSessionForDocument(runtime, document);
  if (!session) return { outcome: { attached: false, error: null }, item: null };
  try {
    const item = await bridge.chat.attachContext({
      sessionId: session.id,
      documentId: document.id,
      documentHash: document.fileHash,
      input: typeof input === 'function' ? input() : input,
    });
    if (!attachmentStillCurrent(runtime.get(), session.id, document)) {
      return { outcome: { attached: false, error: null }, item: null };
    }
    return { outcome: { attached: true, error: null }, item };
  } catch (error) {
    return { outcome: { attached: false, error: errorMessage(error instanceof Error ? error : null, fallbackError) }, item: null };
  }
}

export async function addSelectionContext(
  runtime: ChatRuntime,
  document: DocumentMetadata,
  descriptor: ChatSelectionDescriptor,
  focusComposer: boolean
): Promise<boolean> {
  const { outcome, item } = await attachToDocument(
    runtime,
    document,
    { kind: 'selection', descriptor },
    'Could not add the selection to AI context.'
  );
  if (item !== null) {
    const focus = focusComposer
      ? { composerFocusNonce: runtime.get().composerFocusNonce + 1, composerPlaceholder: 'Ask something about this passage…' }
      : {};
    publishAttached(runtime, item, focus);
  }
  if (outcome.error !== null) runtime.set({ error: outcome.error });
  return outcome.attached;
}

export async function addPageRange(
  runtime: ChatRuntime,
  document: DocumentMetadata,
  pageStart: number,
  pageEnd: number
): Promise<boolean> {
  const { outcome, item } = await attachToDocument(
    runtime,
    document,
    { kind: 'range', format: 'pdf', pageStart, pageEnd },
    'Could not add the page range to AI context.'
  );
  if (item !== null) publishAttached(runtime, item);
  if (outcome.error !== null) runtime.set({ error: outcome.error });
  return outcome.attached;
}

export async function addEntireDocument(
  runtime: ChatRuntime,
  document: DocumentMetadata,
  location: DocumentLocation,
  automatic: boolean
): Promise<boolean> {
  const { outcome, item } = await attachToDocument(
    runtime,
    document,
    // `automatic` marks context Reader Chat attached on the user's behalf,
    // which stays subject to the ADR-0006 Level-2 ingestion ratio. The
    // explicit action sends the request unchanged and keeps its pinned
    // authority.
    { kind: 'entire_document', location, ...(automatic ? { automatic } : {}) },
    ATTACH_FAILED_ERROR
  );
  if (item !== null) publishAttached(runtime, item);
  // The user asked for this attachment and is waiting on it, so its failure
  // belongs on screen right away.
  if (outcome.error !== null) runtime.set({ error: outcome.error });
  return outcome.attached;
}

/** The PDF range or reflowable location around where the reader is. */
function nearbyInput(document: DocumentMetadata, fallbackLocation: DocumentLocation | null): ChatContextAttachInput {
  const reader = useReaderStore.getState();
  const location = fallbackLocation?.format === document.format
    ? fallbackLocation
    : defaultLocation(document.format, reader.currentPage);
  if (document.format !== 'pdf') return { kind: 'location', location };
  const currentPage = location.format === 'pdf' ? location.pageIndex + 1 : Math.max(1, reader.currentPage);
  const pageCount = document.pageCount ?? reader.pageCount;
  const pageStart = Math.max(1, currentPage - AUTOMATIC_PDF_PAGE_RADIUS);
  const pageEnd = Math.max(
    pageStart,
    Math.min(pageCount > 0 ? pageCount : currentPage, currentPage + AUTOMATIC_PDF_PAGE_RADIUS)
  );
  return { kind: 'range', format: 'pdf', pageStart, pageEnd };
}

/**
 * Attaches a bounded automatic context window without claiming Whole doc. The
 * reader's position is read once the conversation exists, as it always was.
 */
export async function attachNearbyContext(
  runtime: ChatRuntime,
  document: DocumentMetadata,
  fallbackLocation: DocumentLocation | null
): Promise<AttachOutcome> {
  const { outcome, item } = await attachToDocument(
    runtime,
    document,
    () => nearbyInput(document, fallbackLocation),
    ATTACH_FAILED_ERROR
  );
  if (item !== null) publishAttached(runtime, item);
  return outcome;
}

export async function removeContext(runtime: ChatRuntime, contextItemId: string): Promise<void> {
  const sessionId = runtime.get().activeSessionId;
  if (!sessionId) return;
  try {
    await bridge.chat.removeContext(sessionId, contextItemId);
    runtime.set((state) => ({
      contextItems: state.contextItems.filter((item) => item.id !== contextItemId),
      // The chip disappearing is the confirmation; a status line would only
      // linger into the next conversation.
      statusMessage: '',
    }));
  } catch (error) {
    runtime.set({ error: errorMessage(error instanceof Error ? error : null, 'Could not remove AI context.') });
  }
}

/** The reader's live location, falling back to the start of the open document. */
export function readingLocation(): DocumentLocation | null {
  const reader = useReaderStore.getState();
  const live = reader.currentLocation ?? reader.explicitNavigationLocation ?? reader.session?.initialLocation;
  if (live) return live;
  const format = reader.session?.document.format;
  return format ? defaultLocation(format, reader.currentPage) : null;
}

function defaultLocation(format: DocumentMetadata['format'], page: number): DocumentLocation {
  if (format === 'pdf') {
    return { format: 'pdf', pageIndex: Math.max(0, page - 1) };
  }
  if (format === 'docx' || format === 'pptx') {
    return { format, paragraphIndex: 0 };
  }
  if (format === 'markdown') {
    return { format: 'markdown', blockIndex: 0 };
  }
  if (format === 'mobi') {
    return { format: 'mobi', sectionIndex: 0 };
  }
  return { format: 'epub', cfi: '' };
}
