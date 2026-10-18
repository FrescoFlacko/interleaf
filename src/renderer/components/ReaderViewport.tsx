import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../stores/use-ui-store";
import { isReaderReady, selectActiveDocument, useReaderStore } from "../stores/use-reader-store";
import { LibraryView } from "../features/library/LibraryView";
import { ReaderView } from "../features/reader/ReaderView";

const FOCUS_HINT_FADE_MS = 2500;
const REVEAL_EDGE_PX = 12;
const REVEAL_HIDE_MS = 1500;

function FocusHint() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => { setVisible(false); }, FOCUS_HINT_FADE_MS);
    return () => { window.clearTimeout(timer); };
  }, []);

  return (
    <div
      role="status"
      className={
        // Fades in over 150ms and, after the hold, out over 200ms.
        "pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-bg-surface px-4 py-1.5 text-xs text-text-secondary transition-opacity ease-(--ease-out) starting:opacity-0 " +
        (visible ? "opacity-100 duration-(--dur-fast)" : "opacity-0 duration-(--dur-base)")
      }
    >
      Focus Reading Mode — press Esc to exit
    </div>
  );
}

export function ReaderViewport() {
  const activeDocument = useReaderStore(selectActiveDocument);
  const readerReady = useReaderStore(isReaderReady);
  const currentPage = useReaderStore((state) => state.currentPage);
  const pageCount = useReaderStore((state) => state.pageCount);
  const focusMode = useUiStore((state) => state.focusMode);
  const toggleFocusMode = useUiStore((state) => state.toggleFocusMode);
  const [revealVisible, setRevealVisible] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    },
    [],
  );

  function scheduleRevealHide(): void {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => { setRevealVisible(false); }, REVEAL_HIDE_MS);
  }

  function handleMouseMove(event: React.MouseEvent<HTMLElement>): void {
    if (!focusMode) {
      return;
    }
    if (event.clientY <= REVEAL_EDGE_PX) {
      setRevealVisible(true);
      scheduleRevealHide();
    }
  }

  return (
    <main
      id="main-content"
      data-testid="reader-viewport"
      tabIndex={-1}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { setRevealVisible(false); }}
      className="relative flex flex-1 flex-col overflow-hidden bg-bg-reader"
    >
      {focusMode && readerReady && revealVisible && (
        <div
          data-testid="focus-reveal"
          className="absolute inset-x-0 top-0 z-30 flex items-center justify-between border-b border-border-subtle bg-bg-primary/95 px-4 py-2 shadow-sm backdrop-blur-sm"
        >
          <span className="text-xs text-text-secondary">{activeDocument?.title ?? 'Focus Reading'} · {String(currentPage)} / {String(Math.max(pageCount, 1))}</span>
          <button
            type="button"
            data-testid="focus-exit"
            onClick={() => { toggleFocusMode(); }}
            className="rounded-md border border-border-subtle px-3 py-1 text-sm hover:bg-bg-surface"
          >
            Exit Focus
          </button>
        </div>
      )}

      {activeDocument ? <ReaderView /> : <LibraryView />}

      {focusMode && readerReady && pageCount > 0 && (
        <div
          data-testid="focus-progress"
          aria-label={`Reading progress: ${String(Math.round((currentPage / pageCount) * 100))}%`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((currentPage / pageCount) * 100)}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 bg-border-subtle"
        >
          {/* Scaled rather than resized, so progress never relays out. */}
          <div className="h-full w-full origin-left bg-accent transition-transform duration-(--dur-base) ease-(--ease-out)" style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, currentPage / pageCount)))})` }} />
        </div>
      )}

      {focusMode && readerReady && <FocusHint />}
    </main>
  );
}
