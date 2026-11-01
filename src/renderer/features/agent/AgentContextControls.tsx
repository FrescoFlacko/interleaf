import { useRef, useState, type ReactElement } from 'react';
import { CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import { takeCodePointPrefix } from '@shared/agent-context';
import type { AgentContextPacket } from '@shared/types/agent';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { useAgentStore } from '../../stores/use-agent-store';
import type { AgentPendingContext } from '../../stores/agent/context-actions';
import { useReaderStore } from '../../stores/use-reader-store';
import { useAnnotationStore } from '../../stores/use-annotation-store';
import { Button } from '../../components/ui/button';
import { WholeDocumentChip } from '../../components/companion/WholeDocumentChip';
import { AgentPageRangeDialog } from './AgentPageRangeDialog';

function defaultLocation(format: string, page: number): DocumentLocation {
  switch (format) {
    case 'pdf':
      return { format: 'pdf', pageIndex: Math.max(0, page - 1), pageLabel: String(page) };
    case 'epub':
      return { format: 'epub', cfi: '/6/2' };
    case 'mobi':
      return { format: 'mobi', sectionIndex: 0 };
    case 'docx':
    case 'pptx':
      return { format, paragraphIndex: 0 };
    default:
      return { format: 'markdown', blockIndex: 0 };
  }
}

/**
 * Attaching or removing context swaps these controls for the summary (or back),
 * so the control that had focus is gone. Once the swap has rendered, continue
 * from its counterpart — unless the reader has already moved focus elsewhere.
 */
function focusAfterSwap(testId: string): void {
  window.setTimeout(() => {
    const active = window.document.activeElement;
    if (active !== null && active !== window.document.body) return;
    window.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
  }, 0);
}

/** Once a capture lands, the summary replaces the control that had focus. */
function focusAttachedContext(didAttach: boolean): void {
  if (didAttach) focusAfterSwap('agent-remove-context');
}

/**
 * The attached-document context controls, integrated into the task card's
 * footer as the reference does. Attaching is always an explicit act: nothing
 * from the open document reaches the agent unless one of these controls is
 * used, and the summary states exactly what was captured.
 */
export function AgentContextControls({ activeDocument }: { readonly activeDocument: DocumentMetadata | null }): ReactElement {
  const contextPacket = useAgentStore((state) => state.contextPacket);
  const pendingContext = useAgentStore((state) => state.pendingContext);
  const currentPage = useReaderStore((state) => state.currentPage);
  const explicitLocation = useReaderStore((state) => state.explicitNavigationLocation);
  const readerSelection = useAnnotationStore((state) => state.selection);
  const [pagesOpen, setPagesOpen] = useState(false);
  const pagesTriggerRef = useRef<HTMLButtonElement>(null);

  const clearContext = (): void => {
    useAgentStore.getState().clearContextPacket();
    focusAfterSwap('agent-attach-entire-doc');
  };

  const status = contextStatus(pendingContext, contextPacket !== null);

  if (contextPacket !== null) {
    return (
      <>
        <AttachedContextSummary packet={contextPacket} onRemove={clearContext} />
        {status}
      </>
    );
  }

  if (activeDocument === null) {
    return (
      <p className="companion-meta" data-testid="agent-no-doc-notice">
        Open a document to attach excerpt context and start agent tasks.
      </p>
    );
  }

  return (
    <>
      {readerSelection?.anchor !== undefined && (
        <Button
          size="inline"
          variant="link"
          data-testid="agent-attach-selection"
          onClick={() => {
            useAgentStore.getState().attachSelection(activeDocument, readerSelection);
            focusAttachedContext(useAgentStore.getState().contextPacket !== null);
          }}
          className="agent-dashed h-[26px] rounded-md border border-accent/40 bg-accent/10 px-2 text-accent"
        >
          + Selection
        </Button>
      )}
      {activeDocument.format === 'pdf' && (
        <Button
          ref={pagesTriggerRef}
          size="inline"
          variant="ghost"
          data-testid="agent-pages-trigger"
          aria-expanded={pagesOpen}
          aria-haspopup="dialog"
          onClick={() => { setPagesOpen((previous) => !previous); }}
          className="agent-dashed h-[26px] rounded-md border border-border-subtle px-2"
        >
          + Pages…
        </Button>
      )}
      <WholeDocumentChip
        attached={false}
        data-testid="agent-attach-entire-doc"
        title="Add the entire document to the task's context."
        onClick={() => {
          const location = explicitLocation ?? defaultLocation(activeDocument.format, currentPage);
          void useAgentStore.getState().attachEntireDocument(activeDocument, location).then(focusAttachedContext);
        }}
      />
      {/* Its own line under the chips, left-aligned with them, in plain words. */}
      {status}
      <AgentPageRangeDialog
        open={pagesOpen}
        document={activeDocument}
        currentPage={currentPage}
        maxRange={CHAT_MAX_PAGE_RANGE}
        triggerRef={pagesTriggerRef}
        onClose={() => {
          setPagesOpen(false);
          window.queueMicrotask(() => { pagesTriggerRef.current?.focus(); });
        }}
        onAttached={() => {
          setPagesOpen(false);
          focusAttachedContext(useAgentStore.getState().contextPacket !== null);
        }}
      />
    </>
  );
}

/**
 * The line under the chips. Reading a long book can take a while: until it
 * lands the reader sees what is being attached and can withdraw it, keeping
 * any prior attachment. With nothing attached or pending, it says so plainly.
 */
function contextStatus(pending: AgentPendingContext | null, keepsContext: boolean): ReactElement | null {
  if (pending !== null) return <PendingContextStatus pending={pending} keepsContext={keepsContext} />;
  if (keepsContext) return null;
  return (
    <p className="companion-meta basis-full" data-testid="agent-no-context-notice">
      No document attached. Nothing from it is sent unless you add it.
    </p>
  );
}

function PendingContextStatus({
  pending,
  keepsContext,
}: {
  readonly pending: AgentPendingContext;
  /** Whether context attached before this capture stays once it is cancelled. */
  readonly keepsContext: boolean;
}): ReactElement {
  const cancel = (): void => {
    useAgentStore.getState().cancelContextCapture();
    focusAfterSwap(keepsContext ? 'agent-remove-context' : 'agent-attach-entire-doc');
  };
  return (
    <div className="flex basis-full items-center gap-2" data-testid="agent-context-pending">
      <p className="companion-meta min-w-0" role="status" aria-live="polite">
        Attaching {pending.label}…
      </p>
      <Button
        size="inline"
        variant="link"
        data-testid="agent-cancel-context"
        aria-label={`Cancel attaching ${pending.label}`}
        onClick={cancel}
        className="shrink-0 text-text-secondary hover:text-danger"
      >
        Cancel
      </Button>
    </div>
  );
}

function AttachedContextSummary({
  packet,
  onRemove,
}: {
  readonly packet: AgentContextPacket;
  readonly onRemove: () => void;
}): ReactElement {
  const quote = packet.selection.exactQuote;
  const characters = quote.length.toLocaleString();

  return (
    <div
      data-testid="agent-context-summary"
      className="flex w-full min-w-0 flex-col gap-1 rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="agent-mono min-w-0 truncate text-2xs font-medium text-accent" title={packet.document.title}>
          {packet.document.title}
        </span>
        {packet.scopeLabel !== undefined && (
          <span className="agent-mono shrink-0 text-2xs text-accent" data-testid="agent-context-range">
            {packet.scopeLabel}
          </span>
        )}
        <Button
          size="inline"
          variant="link"
          data-testid="agent-remove-context"
          aria-label="Remove attached document context"
          onClick={onRemove}
          className="ml-auto shrink-0 text-text-secondary hover:text-danger"
        >
          Remove
        </Button>
      </div>
      <p className="line-clamp-2 text-xs leading-[1.4] text-text-secondary">
        “{takeCodePointPrefix(quote, 240)}{quote.length > 240 ? '…' : ''}”
      </p>
      <p className="agent-mono text-2xs leading-[1.3] text-text-secondary">
        {packet.provenance.truncated
          ? `Attached as untrusted reference (first ${characters} chars, truncated)`
          : `Attached as untrusted reference (${characters} chars)`}
      </p>
    </div>
  );
}
