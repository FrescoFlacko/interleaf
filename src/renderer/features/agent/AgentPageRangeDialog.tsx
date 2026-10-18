import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from 'react';
import type { DocumentMetadata } from '@shared/types/document';
import { useAgentStore } from '../../stores/use-agent-store';
import { pageRangeProblem } from '../../stores/agent-context-attach';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import type { SlidePhase } from '../../components/slide-presence';

type AgentPageRangeDialogProps = {
  /** Kept mounted, inert, through the 100ms exit after this turns false. */
  readonly open: boolean;
  readonly document: DocumentMetadata;
  readonly currentPage: number;
  readonly maxRange: number;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onAttached: () => void;
};

/**
 * Bounded page-range picker for PDF context. The range is validated here and
 * again by the store before anything is captured, and the attached excerpt is
 * always described to the reader afterwards.
 */
export function AgentPageRangeDialog({ open, ...props }: AgentPageRangeDialogProps): ReactElement | null {
  const presence = usePopoverPresence(open);
  // Reopening during the exit animation would otherwise revive the closing
  // popover with its old range and error, and without focusing Start.
  const [openCount, setOpenCount] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenCount((count) => count + 1);
  }
  return presence.present ? <PageRangePopover key={openCount} {...props} phase={presence.phase} /> : null;
}

/** Whole digits only: "2.5" or "1e2" is not a page, though parseInt reads one. */
function wholePage(text: string): number {
  return /^\d+$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

type PageRangePopoverProps = Omit<AgentPageRangeDialogProps, 'open'> & { readonly phase: SlidePhase };

function PageRangePopover({
  phase,
  document: activeDocument,
  currentPage,
  maxRange,
  triggerRef,
  onClose,
  onAttached,
}: PageRangePopoverProps): ReactElement {
  const initialPage = String(Math.max(1, currentPage));
  const [pageStart, setPageStart] = useState(initialPage);
  const [pageEnd, setPageEnd] = useState(initialPage);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pageStartRef = useRef<HTMLInputElement>(null);
  // This dialog's own capture. Closing the dialog in any way withdraws it, and
  // only it: a choice made elsewhere since then is never undone.
  const captureRef = useRef<AbortController | null>(null);
  // The task card clips its overflow, so a popover positioned inside it was
  // drawn above the card and cut off. Fixed coordinates taken from the trigger
  // escape that clip while the popover stays in place in the DOM, inside the
  // drawer's focus scope.
  const anchorStyle = useAnchoredPosition(triggerRef, popoverRef, 'top');

  useEffect(() => {
    window.queueMicrotask(() => { pageStartRef.current?.focus(); });
    return () => { captureRef.current?.abort(); };
  }, []);

  const close = (): void => {
    captureRef.current?.abort();
    onClose();
  };

  useEffect(() => {
    if (phase === 'exiting') return undefined;
    const handleOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      captureRef.current?.abort();
      onClose();
    };
    window.document.addEventListener('pointerdown', handleOutsidePointer);
    return () => { window.document.removeEventListener('pointerdown', handleOutsidePointer); };
  }, [onClose, phase, triggerRef]);

  const submit = async (): Promise<void> => {
    if (attaching) return;
    const start = wholePage(pageStart);
    const end = wholePage(pageEnd);
    const problem = pageRangeProblem(activeDocument, start, end, maxRange);
    setRangeError(problem);
    if (problem !== null) return;
    const capture = new AbortController();
    captureRef.current = capture;
    setAttaching(true);
    // A failed capture is explained here, where the reader asked for it, and
    // never through the panel's error, which may belong to something else.
    const failure: { message: string | null } = { message: null };
    const attached = await useAgentStore.getState().attachPageRange(activeDocument, start, end, undefined, {
      signal: capture.signal,
      onFailure: (message) => { failure.message = message; },
    });
    // Landed: the summary replaces this dialog, and that unmount withdraws nothing.
    if (attached) { onAttached(); return; }
    // Closed or cancelled while reading: this dialog has nothing left to say.
    if (capture.signal.aborted) return;
    captureRef.current = null;
    setAttaching(false);
    // With no failure it was superseded by a newer choice, so there is nothing to add.
    if (failure.message === null) { onAttached(); return; }
    setRangeError(failure.message);
  };

  const describedBy = rangeError !== null ? RANGE_ERROR_ID : undefined;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Add pages to agent context"
      onKeyDown={handleKeyDown}
      {...phaseAttributes(phase)}
      style={anchorStyle}
      className={cn(
        'ui-popover fixed z-30 flex w-72 max-w-[calc(100vw-16px)] flex-col gap-2',
        'rounded-md border border-border-subtle bg-bg-surface-elevated p-3 shadow-popover'
      )}
    >
      <div>
        <h4 className="text-xs font-semibold text-text-primary">Add pages to agent context</h4>
        <p className="mt-0.5 text-2xs text-text-secondary">
          Attach up to {String(maxRange)} consecutive pages.
          {activeDocument.pageCount !== null ? ` Document has ${String(activeDocument.pageCount)} pages.` : ''}
        </p>
      </div>
      <form
        noValidate
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="min-w-0 flex-1 text-2xs text-text-secondary">
          Start
          <input
            ref={pageStartRef}
            type="number"
            min={1}
            max={activeDocument.pageCount ?? 10_000_000}
            value={pageStart}
            aria-invalid={rangeError !== null}
            aria-describedby={describedBy}
            onChange={(event) => { setPageStart(event.target.value); setRangeError(null); }}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-primary p-1.5 text-xs text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </label>
        <span className="pb-2 text-xs text-text-secondary">to</span>
        <label className="min-w-0 flex-1 text-2xs text-text-secondary">
          End
          <input
            type="number"
            min={1}
            max={activeDocument.pageCount ?? 10_000_000}
            value={pageEnd}
            aria-invalid={rangeError !== null}
            aria-describedby={describedBy}
            onChange={(event) => { setPageEnd(event.target.value); setRangeError(null); }}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-primary p-1.5 text-xs text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </label>
        <div className="flex w-full justify-end gap-1.5">
          <Button size="inline" variant="ghost" onClick={close} className="h-7 px-2">
            Cancel
          </Button>
          <Button size="inline" variant="primary" type="submit" data-testid="agent-pages-submit" disabled={attaching} className="h-7 px-2.5">
            {attaching ? 'Attaching…' : 'Attach range'}
          </Button>
        </div>
      </form>
      <RangeError message={rangeError} />
    </div>
  );
}

const RANGE_ERROR_ID = 'agent-pages-error';

function RangeError({ message }: { readonly message: string | null }): ReactElement | null {
  if (message === null) return null;
  return (
    <p id={RANGE_ERROR_ID} role="alert" data-testid="agent-pages-error" className="text-2xs text-danger">
      {message}
    </p>
  );
}
