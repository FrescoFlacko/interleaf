import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import type { ChatContextItem } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { AppIcon } from '../../components/AppIcon';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import type { SlidePhase } from '../../components/slide-presence';
import { defaultLocation, validatePageRange } from './chat-labels';
import { useShelfPopover, useShelfPopoverState } from './use-shelf-popover';

type ChatAddContextMenuProps = {
  readonly activeDocument: DocumentMetadata;
  readonly currentPage: number;
  readonly explicitLocation: DocumentLocation | null;
  readonly contextItems: readonly ChatContextItem[];
  /** A running clean, a stream or an archived session withholds every context change. */
  readonly disabled: boolean;
  /**
   * The composer's Add button. The shelf moves focus here once its last item is
   * removed, so the panel hands the same ref to both.
   */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly addEntireDocument: (document: DocumentMetadata, location: DocumentLocation) => Promise<boolean>;
  readonly addPageRange: (document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>;
};

const POPOVER_ID = 'chat-pages-popover';
const FIELD_CLASS =
  'mt-1 block w-full min-w-0 rounded border border-border-subtle bg-bg-primary p-1.5 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring';

/**
 * The composer footer's Add context button, and the popover it opens: attach
 * the entire document, or — in a PDF — a page range. What is already attached,
 * the whole document included, is shown and removed in the context shelf.
 */
export function ChatAddContextMenu(props: ChatAddContextMenuProps) {
  const { disabled, triggerRef } = props;
  const popover = useShelfPopoverState(triggerRef);
  const presence = usePopoverPresence(popover.open);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="chat-pages-trigger"
        aria-label="Add context"
        title="Add context"
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? POPOVER_ID : undefined}
        disabled={disabled}
        onClick={popover.toggle}
        className="chat-add-context-trigger"
      >
        <AppIcon name="add" size={16} />
      </button>
      {presence.present && (
        <AddContextPopover {...props} phase={presence.phase} onClose={popover.close} />
      )}
    </>
  );
}

type AddContextPopoverProps = ChatAddContextMenuProps & {
  readonly phase: SlidePhase;
  readonly onClose: () => void;
};

function AddContextPopover({
  activeDocument,
  currentPage,
  explicitLocation,
  contextItems,
  disabled,
  triggerRef,
  addEntireDocument,
  addPageRange,
  phase,
  onClose,
}: AddContextPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, popoverRef, 'top');
  const handleKeyDown = useShelfPopover({ popoverRef, triggerRef, leaving: phase === 'exiting', onClose });
  const wholeDocumentAttached = contextItems.some((item) => item.kind === 'entire_document');

  const handleAddEntireDocument = async (): Promise<void> => {
    const location = explicitLocation ?? defaultLocation(activeDocument.format, currentPage);
    if (await addEntireDocument(activeDocument, location)) onClose();
  };

  return createPortal(
    <div
      ref={popoverRef}
      {...phaseAttributes(phase)}
      id={POPOVER_ID}
      data-testid={POPOVER_ID}
      role="dialog"
      aria-labelledby="chat-pages-title"
      onKeyDown={handleKeyDown}
      style={anchorStyle}
      className="ui-popover chat-design-popover chat-context-popover"
    >
      <h3 id="chat-pages-title" className="text-xs font-semibold text-text-primary">Add context</h3>
      <button
        type="button"
        data-testid="chat-add-entire-document"
        aria-describedby={wholeDocumentAttached ? 'chat-add-entire-document-note' : undefined}
        disabled={disabled || wholeDocumentAttached}
        onClick={() => { void handleAddEntireDocument(); }}
        className="chat-add-context-option"
      >
        <AppIcon name="open-file" size={14} />
        <span className="chat-add-context-option-label">Entire document</span>
        {wholeDocumentAttached && (
          <span id="chat-add-entire-document-note" aria-hidden="true" className="chat-add-context-option-note">Added</span>
        )}
      </button>
      {activeDocument.format === 'pdf' && (
        <PageRangeForm activeDocument={activeDocument} currentPage={currentPage} disabled={disabled} addPageRange={addPageRange} onAdded={onClose} />
      )}
      <p className="text-2xs text-text-secondary">Select text in the document or use a note’s chat action to attach it here.</p>
      <button type="button" className="chat-context-close" onClick={() => { onClose(); }}>Close</button>
    </div>,
    document.body
  );
}

function PageRangeForm({
  activeDocument,
  currentPage,
  disabled,
  addPageRange,
  onAdded,
}: Pick<ChatAddContextMenuProps, 'activeDocument' | 'currentPage' | 'disabled' | 'addPageRange'> & {
  readonly onAdded: () => void;
}) {
  const pageCount = activeDocument.pageCount;
  const initialPage = String(Math.max(1, Math.min(currentPage, pageCount ?? currentPage)));
  const [pageStart, setPageStart] = useState(initialPage);
  const [pageEnd, setPageEnd] = useState(initialPage);
  const [rangeError, setRangeError] = useState<string | null>(null);

  // A page turn or a new page count restarts the range from the current page.
  useEffect(() => {
    setPageStart(initialPage);
    setPageEnd(initialPage);
    setRangeError(null);
  }, [activeDocument.id, initialPage]);

  const handleAddPages = async (): Promise<void> => {
    const validation = validatePageRange(pageStart, pageEnd, pageCount);
    setRangeError(validation);
    if (validation !== null || disabled) return;
    if (await addPageRange(activeDocument, Number(pageStart), Number(pageEnd))) onAdded();
  };

  const errorProps = {
    'aria-invalid': rangeError !== null,
    'aria-describedby': rangeError !== null ? 'chat-pages-error' : undefined,
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        // Portalled out of the composer in the DOM but not in React's tree,
        // so the composer's own form must not see this submit as a send.
        event.preventDefault();
        event.stopPropagation();
        void handleAddPages();
      }}
      className="chat-context-range"
    >
      <p className="text-2xs text-text-secondary">
        Or add up to {String(CHAT_MAX_PAGE_RANGE)} consecutive PDF pages.
        {pageCount !== null ? ` This document has ${String(pageCount)} pages.` : ''}
      </p>
      <div className="flex min-w-0 items-end gap-2">
        <label className="min-w-0 flex-1 text-2xs text-text-secondary">
          Start page
          <input type="number" inputMode="numeric" min={1} max={pageCount ?? 10_000_000} value={pageStart}
            aria-label="Start page for context" {...errorProps}
            onChange={(event) => { setPageStart(event.target.value); setRangeError(null); }}
            className={FIELD_CLASS} />
        </label>
        <span aria-hidden="true" className="pb-2 text-xs text-text-secondary">to</span>
        <label className="min-w-0 flex-1 text-2xs text-text-secondary">
          End page
          <input type="number" inputMode="numeric" min={1} max={pageCount ?? 10_000_000} value={pageEnd}
            aria-label="End page for context" {...errorProps}
            onChange={(event) => { setPageEnd(event.target.value); setRangeError(null); }}
            className={FIELD_CLASS} />
        </label>
      </div>
      <button type="submit" data-testid="chat-pages-submit" disabled={disabled} className="chat-context-range-submit">
        Add range
      </button>
      {rangeError !== null && (
        <p id="chat-pages-error" data-testid="chat-pages-error" role="alert" className="text-2xs text-danger">{rangeError}</p>
      )}
    </form>
  );
}
