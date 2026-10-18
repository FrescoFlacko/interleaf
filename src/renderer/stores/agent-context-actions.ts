import type { AgentContextPacket } from '@shared/types/agent';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import type { DocumentAdapter } from '../features/reader/types';
import {
  captureEntireDocument,
  capturePageRange,
  captureSection,
  claimAgentContext,
  ENTIRE_DOCUMENT_SCOPE,
  holdsAgentContext,
  releaseAgentContext,
  type AgentContextCapture,
  type AgentContextClaim,
} from './agent-context-attach';

/** A capture still reading the book, shown to the reader until it lands or is cancelled. */
export type AgentPendingContext = { readonly revision: number; readonly label: string };

type AgentContextCaptureOptions = {
  /** Aborting withdraws this capture only; a newer choice is never undone. */
  readonly signal?: AbortSignal;
  /** Receives a failure instead of the panel's error, for a caller that explains it itself. */
  readonly onFailure?: (message: string) => void;
};

type OutlineSectionReader = (adapter: DocumentAdapter) => Promise<{ readonly text: string; readonly truncated: boolean; readonly scopeLabel: string }>;

type ContextState = {
  readonly contextPacket: AgentContextPacket | null;
  readonly pendingContext: AgentPendingContext | null;
  readonly error: string | null;
};

/**
 * Context captures resolve `true` once attached. `false` means nothing was
 * attached: the failure went to `onFailure` or `error`, or a newer explicit
 * choice (attach, remove, cancel, another book) superseded the capture.
 */
export type AgentContextActions = {
  attachPageRange(document: DocumentMetadata, pageStart: number, pageEnd: number, explicitText?: string, options?: AgentContextCaptureOptions): Promise<boolean>;
  attachSectionContext(document: DocumentMetadata, location: DocumentLocation, scopeLabel: string, explicitText: string, sourceTruncated?: boolean, options?: AgentContextCaptureOptions): Promise<boolean>;
  /** Reads an outline section from the open book; the label is known once its extent is. */
  attachOutlineSection(document: DocumentMetadata, location: DocumentLocation, read: OutlineSectionReader, options?: AgentContextCaptureOptions): Promise<boolean>;
  attachEntireDocument(document: DocumentMetadata, location: DocumentLocation, explicitText?: string, options?: AgentContextCaptureOptions): Promise<boolean>;
  /** Withdraws the capture in progress, keeping whatever was attached before it. */
  cancelContextCapture(): void;
};

function pageLabel(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd ? `Page ${String(pageStart)}` : `Pages ${String(pageStart)}–${String(pageEnd)}`;
}

/**
 * The context actions of the Agent store. The claim taken when a capture
 * begins is checked again at the synchronous commit, after every await, so a
 * Remove, a cancel, a newer capture or another book always wins.
 */
export function createContextActions(
  set: (patch: Partial<ContextState>) => void,
  get: () => ContextState,
): AgentContextActions {
  /** The claim behind `pendingContext`, so Cancel withdraws exactly the capture it shows. */
  let pendingClaim: AgentContextClaim | null = null;
  const run = async (
    document: DocumentMetadata,
    label: string,
    options: AgentContextCaptureOptions,
    produce: (claim: AgentContextClaim) => Promise<AgentContextCapture>,
  ): Promise<boolean> => {
    const claim = claimAgentContext(document, options.signal);
    if (claim === null) return false;
    const withdraw = (): void => {
      if (releaseAgentContext(claim) && get().pendingContext?.revision === claim.revision) set({ pendingContext: null });
    };
    options.signal?.addEventListener('abort', withdraw, { once: true });
    pendingClaim = claim;
    set({ pendingContext: { revision: claim.revision, label } });
    const result = await produce(claim);
    options.signal?.removeEventListener('abort', withdraw);
    if (pendingClaim === claim) pendingClaim = null;
    if (!commit(claim, result, options) || result.kind !== 'attached') return false;
    // The caller hears whether its context is still attached by then: a
    // Remove made in the moment after landing has the last word.
    await Promise.resolve();
    return get().contextPacket === result.packet;
  };

  /** A failed capture keeps the prior attachment; only a successful one replaces it. */
  const commit = (claim: AgentContextClaim, result: AgentContextCapture, options: AgentContextCaptureOptions): boolean => {
    const ownsPending = get().pendingContext?.revision === claim.revision;
    if (!holdsAgentContext(claim)) {
      if (ownsPending) set({ pendingContext: null });
      return false;
    }
    if (result.kind === 'attached') {
      set({ contextPacket: result.packet, pendingContext: null, error: null });
      return true;
    }
    if (options.onFailure === undefined) set({ pendingContext: null, error: result.message });
    else {
      set({ pendingContext: null });
      options.onFailure(result.message);
    }
    return false;
  };

  return {
    attachPageRange: (document, pageStart, pageEnd, explicitText, options = {}) =>
      run(document, pageLabel(pageStart, pageEnd), options, (claim) => capturePageRange(claim, document, pageStart, pageEnd, explicitText)),
    attachSectionContext: (document, location, scopeLabel, explicitText, sourceTruncated = false, options = {}) =>
      run(document, scopeLabel, options, (claim) => captureSection(claim, document, location, { text: explicitText, truncated: sourceTruncated, scopeLabel })),
    attachOutlineSection: (document, location, read, options = {}) =>
      run(document, 'Section', options, (claim) => captureSection(claim, document, location, { read })),
    attachEntireDocument: (document, location, explicitText, options = {}) =>
      run(document, ENTIRE_DOCUMENT_SCOPE, options, (claim) => captureEntireDocument(claim, document, location, explicitText)),
    cancelContextCapture: () => {
      const claim = pendingClaim;
      if (claim === null || get().pendingContext?.revision !== claim.revision) return;
      releaseAgentContext(claim);
      set({ pendingContext: null });
    },
  };
}
