import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_MAX_PAGE_RANGE } from '@shared/constants/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import type { SlidePhase } from '../../components/slide-presence';
import { validatePageRange } from './chat-labels';

type ChatContextMenuProps = {
  readonly activeDocument: DocumentMetadata;
  readonly currentPage: number;
  /** A running clean, a stream or an archived session withholds every context change. */
  readonly disabled: boolean;
  readonly addPageRange: (document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>;
};

const FIELD_CLASS =
  'mt-1 block w-full min-w-0 rounded border border-border-subtle bg-bg-primary p-1.5 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring';

/**
 * The `@ Add context` pill that leads the context row (DESIGN.md, Inline
 * context), and the page-range popover it opens. The popover is portalled and
 * anchored to the pill, so a narrow or zoomed panel never clips it. What is
 * attached, the whole document included, is shown by the row itself.
 */
export function ChatContextMenu(props: ChatContextMenuProps) {
  const { activeDocument, disabled } = props;
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = activeDocument.format === 'pdf' ? 'Add pages to AI context' : 'Add context';

  const close = (returnFocus = true): void => {
    setOpen(false);
    if (returnFocus) window.queueMicrotask(() => { triggerRef.current?.focus(); });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="chat-pages-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'chat-pages-popover' : undefined}
        disabled={disabled}
        onClick={() => { if (open) close(); else setOpen(true); }}
        className="chat-design-context-add"
      >
        {/* The accessible name stays the specific one; the short visible word
          * keeps the pill on one line. */}
        <span aria-hidden="true" className="chat-design-context-add-at">@</span>
        <span>Add context</span>
      </button>
      {presence.present && (
        <ContextPopover {...props} phase={presence.phase} triggerRef={triggerRef} onClose={close} />
      )}
    </>
  );
}

type ContextPopoverProps = ChatContextMenuProps & {
  readonly phase: SlidePhase;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: (returnFocus?: boolean) => void;
};

function ContextPopover({
  activeDocument,
  currentPage,
  disabled,
  addPageRange,
  phase,
  triggerRef,
  onClose,
}: ContextPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, popoverRef, 'top');
  const pageCount = activeDocument.pageCount;
  const initialPage = String(Math.max(1, Math.min(currentPage, pageCount ?? currentPage)));
  const [pageStart, setPageStart] = useState(initialPage);
  const [pageEnd, setPageEnd] = useState(initialPage);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const isPdf = activeDocument.format === 'pdf';

  // A page turn or a new page count restarts the range from the current page.
  useEffect(() => {
    setPageStart(initialPage);
    setPageEnd(initialPage);
    setRangeError(null);
  }, [activeDocument.id, initialPage]);

  const leaving = phase === 'exiting';
  useEffect(() => {
    if (leaving) return;
    // A PDF opens on its range; otherwise on the first action.
    const popover = popoverRef.current;
    (popover?.querySelector<HTMLElement>('input') ?? popover?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
  }, [leaving]);

  useEffect(() => {
    if (leaving) return undefined;
    const handleOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handleOutsidePointer);
    return () => { document.removeEventListener('pointerdown', handleOutsidePointer); };
  }, [leaving, onClose, triggerRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Closes this popover only; the drawer around it never sees the key.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(popoverRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleAddPages = async (): Promise<void> => {
    const validation = validatePageRange(pageStart, pageEnd, pageCount);
    setRangeError(validation);
    if (validation !== null || disabled) return;
    const added = await addPageRange(activeDocument, Number(pageStart), Number(pageEnd));
    if (added) onClose();
  };

  const errorProps = {
    'aria-invalid': rangeError !== null,
    'aria-describedby': rangeError !== null ? 'chat-pages-error' : undefined,
  };

  return createPortal(
    <div
      ref={popoverRef}
      {...phaseAttributes(phase)}
      id="chat-pages-popover"
      data-testid="chat-pages-popover"
      role="dialog"
      aria-labelledby="chat-pages-title"
      onKeyDown={handleKeyDown}
      style={anchorStyle}
      className="ui-popover chat-design-popover chat-context-popover"
    >
      <h3 id="chat-pages-title" className="text-xs font-semibold text-text-primary">Add context</h3>
      {isPdf && (
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
            Add up to {String(CHAT_MAX_PAGE_RANGE)} consecutive PDF pages.
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
        </form>
      )}
      {rangeError !== null && (
        <p id="chat-pages-error" data-testid="chat-pages-error" role="alert" className="text-2xs text-danger">{rangeError}</p>
      )}
      <p className="text-2xs text-text-secondary">Select text in the document or use a note’s chat action to attach it here.</p>
      <button type="button" className="chat-context-close" onClick={() => { onClose(); }}>Close</button>
    </div>,
    document.body
  );
}
