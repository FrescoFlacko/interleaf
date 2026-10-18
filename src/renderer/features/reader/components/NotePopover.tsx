import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownContent } from '../../../components/markdown/MarkdownContent';
import { AppIcon } from '../../../components/AppIcon';
import { phaseAttributes } from '../../../components/ui/popover-presence';
import type { SlidePhase } from '../../../components/slide-presence';
import {
  computeNotePopoverPlacement,
  POPOVER_INSET_PX,
} from '../annotations/note-popover-placement';
import type { RectLike } from '../annotations/note-pointer';

type NotePopoverContent = {
  /**
   * Persisted note source. Rendered through the shared safe Markdown renderer:
   * React text nodes only, never HTML strings, so raw HTML stays visible text
   * and images/unsafe links stay inert.
   */
  readonly note: string;
};

type NotePopoverCloseReason = 'escape' | 'close-button' | 'outside-click';

type Props = {
  /** `exiting` while it fades out, inert, after the note closed. */
  readonly phase: SlidePhase;
  readonly rect: RectLike;
  readonly content: NotePopoverContent;
  readonly onClose: (reason: NotePopoverCloseReason) => void;
};

const WIDTH_MAX = 320;
/** Conservative first-paint estimate; the layout effect corrects pre-paint. */
const HEIGHT_FIRST_PAINT_ESTIMATE = 96;

/**
 * In-reader note bubble anchored above the noted fragment (Defect 20).
 *
 * The panel shows only the saved note: the quoted fragment is already visible
 * in the document directly beneath the bubble, so echoing it here was pure
 * redundancy. Keyboard users still get the noted text through the reader's
 * focus-proxy accessible labels.
 *
 * The note body renders as safe Markdown through the shared token renderer
 * (no HTML strings, no `dangerouslySetInnerHTML`); plain-text notes are
 * unaffected. The panel is intentionally NON-MODAL: it never
 * takes focus. Keyboard users reach the direct noted-text route through the
 * reader's live focus proxies; the Annotations sidebar remains an additional
 * browse/edit route. Escape and the close button report their reason so the
 * controller can restore opener focus; an outside pointerdown reports
 * 'outside-click' and must not steal focus from the clicked control.
 *
 * Positioning is render-and-measure: the real box (wrapping, explicit
 * newlines, max-height clamping) is measured with useLayoutEffect +
 * ResizeObserver and placed by the pure placement math, re-placed on content
 * or window resize. This stays correct at 200% zoom and for very long or
 * maximum-length notes because the panel scrolls internally under max-height.
 */
export function NotePopover({ phase, rect, content, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number }>({
    width: Math.min(WIDTH_MAX, (typeof window === 'undefined' ? 1024 : window.innerWidth) - POPOVER_INSET_PX * 2),
    height: HEIGHT_FIRST_PAINT_ESTIMATE,
  });
  // Viewport size is explicit reactive state: a runtime window shrink must
  // rerender placement even when the panel's own measured size is unchanged.
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() => ({
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));

  const measure = useCallback((): void => {
    const panel = panelRef.current;
    if (panel === null) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    if (width <= 0 || height <= 0) return;
    setMeasured((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height }
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(() => { measure(); });
    if (panelRef.current !== null) observer.observe(panelRef.current);
    return () => { observer.disconnect(); };
  }, [measure, content.note]);

  useEffect(() => {
    if (phase === 'exiting') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose('escape');
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose('outside-click');
    };
    const onWindowResize = (): void => {
      measure();
      setViewport((previous) => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        return previous.width === width && previous.height === height ? previous : { width, height };
      });
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onWindowResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [onClose, measure, phase]);

  const { left, top } = computeNotePopoverPlacement(rect, measured, viewport);

  return (
    <div
      ref={panelRef}
      data-testid="note-popover"
      data-top-layer="note-popover"
      role="dialog"
      aria-label="Reader note"
      {...phaseAttributes(phase)}
      className="ui-popover fixed z-30 max-h-[40vh] w-[320px] max-w-[calc(100vw-16px)] origin-bottom overflow-auto rounded-md border border-border-subtle bg-bg-surface-elevated p-3 pr-9 text-xs shadow-popover"
      style={{ left, top }}
    >
      <button
        type="button"
        data-testid="note-popover-close"
        aria-label="Close note popover"
        onClick={() => { onClose('close-button'); }}
        className="absolute right-2 top-2 shrink-0 rounded p-0.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      >
        <AppIcon name="close" size={13} />
      </button>
      <div className="leading-relaxed text-text-primary" data-testid="note-popover-body">
        <MarkdownContent content={content.note} />
      </div>
    </div>
  );
}
