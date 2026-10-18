import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { AppSettings } from "@shared/schemas/settings";
import { persistSettings } from "../app/api-client";
import { useUiStore } from "../stores/use-ui-store";
import { LayoutWillChangeSignal } from "./layout-change-signal";
import {
  SLIDE_COMPLETION_GRACE_MS,
  prefersReducedMotion,
} from "./slide-presence";

export type PanelSide = "left" | "right";

/**
 * The content's fade-out on close, matching `--dur-exit`: the width is
 * committed to 0 only after it, so the band is never seen empty.
 */
const PANEL_EXIT_MS = 100;
/** Matches `--dur-base`, the content's entry animation. */
const PANEL_ENTER_MS = 200;
/** The divider border on the panel's inner edge (`border-r` / `border-l`). */
const PANEL_BORDER_PX = 1;

const PANEL_BOUNDS = {
  left: { min: 220, max: 440 },
  right: { min: 280, max: 560 },
  centerMin: 420,
} as const;

/** Pure clamp used by pointer and keyboard resizing, and by migration tests. */
export function clampPanelWidth(
  side: PanelSide,
  requested: number,
  viewportWidth: number,
  otherOpenWidth: number,
): number {
  const bounds = PANEL_BOUNDS[side];
  const available = Math.max(
    bounds.min,
    viewportWidth - PANEL_BOUNDS.centerMin - Math.max(0, otherOpenWidth),
  );
  const max = Math.min(bounds.max, available);
  const finite = Number.isFinite(requested) ? requested : bounds.min;
  return Math.round(Math.min(max, Math.max(bounds.min, finite)));
}

export function panelMaxWidth(
  side: PanelSide,
  viewportWidth: number,
  otherOpenWidth: number,
): number {
  const bounds = PANEL_BOUNDS[side];
  return Math.min(
    bounds.max,
    Math.max(
      bounds.min,
      viewportWidth - PANEL_BOUNDS.centerMin - Math.max(0, otherOpenWidth),
    ),
  );
}

function persistLayout(side: PanelSide, width: number): void {
  const state = useUiStore.getState();
  // Width changes made before async settings hydration are presentation-only;
  // never write defaults over the user's stored layout.
  if (state.loadedSettings === null) return;
  const base = state.loadedSettings;
  const next: AppSettings = {
    ...base,
    layout: {
      ...base.layout,
      ...(side === "left" ? { leftWidth: width } : { rightWidth: width }),
    },
  };
  state.setLoadedSettings(next);
  persistSettings(next);
}

type PanelPresence = "open" | "closing" | "closed";

/**
 * The panel's open/close phases. Presence mirrors the toggle but keeps closing
 * content mounted long enough for the content slide to run (Defect 22):
 * 'open' → 'closing' → 'closed'. Reduced motion skips straight to 'closed'.
 */
function usePanelPresence(
  open: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
): { presence: PanelPresence; entering: boolean } {
  const [presence, setPresence] = useState<PanelPresence>(() =>
    open ? "open" : "closed",
  );
  // Opening from rest plays the content's entry animation from the very
  // frame that commits the width, so the column is never painted empty while
  // a fade waits to start. Interactivity does not wait for it: the panel is
  // 'open' from the first commit.
  const [entering, setEntering] = useState(false);
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  useLayoutEffect(() => {
    if (open && presenceRef.current === "closed" && !prefersReducedMotion()) {
      setEntering(true);
    }
    if (!open) setEntering(false);
    setPresence((current) => {
      if (open) return current === "open" ? current : "open";
      if (!prefersReducedMotion() && current === "open") return "closing";
      return current === "closed" ? current : "closed";
    });
  }, [open]);

  // The entry animation is dropped once it has played; the timer is only a
  // backstop for an animation that never reports its end (jsdom).
  useEffect(() => {
    if (!entering) return;
    const finish = (): void => { setEntering(false); };
    const content = contentRef.current;
    const onAnimationEnd = (event: AnimationEvent): void => {
      if (event.target === content) finish();
    };
    content?.addEventListener("animationend", onAnimationEnd);
    const timer = window.setTimeout(finish, PANEL_ENTER_MS + SLIDE_COMPLETION_GRACE_MS);
    return () => {
      content?.removeEventListener("animationend", onAnimationEnd);
      window.clearTimeout(timer);
    };
  }, [entering, contentRef]);

  // The width is released the moment the content's fade actually ends, so the
  // reader takes the band back in the frame after the exit rather than waiting
  // out the grace with an empty band on screen. The timer is only a backstop
  // for a fade that never reports its end (jsdom, an interrupted transition).
  useEffect(() => {
    if (presence !== "closing") return;
    const finish = (): void => {
      setPresence((current) => (current === "closing" ? "closed" : current));
    };
    const content = contentRef.current;
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target === content && event.propertyName === "opacity") finish();
    };
    content?.addEventListener("transitionend", onTransitionEnd);
    const timer = window.setTimeout(finish, PANEL_EXIT_MS + SLIDE_COMPLETION_GRACE_MS);
    return () => {
      content?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timer);
    };
  }, [presence, contentRef]);

  return { presence, entering };
}

/**
 * The panel box and its content for one presence phase. The box takes its
 * width in one step and the reader beside it re-wraps once, never frame by
 * frame. Only the content moves, on the compositor: it fades in while sliding
 * a short 20px from the panel's outer edge, and on close it fades out before
 * the width is released, so the band it occupies is never seen empty.
 */
function panelFrame(
  side: PanelSide,
  presence: PanelPresence,
  entering: boolean,
  width: number,
): {
  readonly hiddenAttributes: { readonly inert?: true; readonly "aria-hidden"?: true };
  readonly panelStyle: CSSProperties;
  readonly contentStyle: CSSProperties;
} {
  const closed = presence === "closed";
  const hidden = presence !== "open";
  const hiddenOffset = side === "left" ? "-20px" : "20px";
  // The entry eases out with the plain `ease-out` curve: `--ease-out` covers
  // 90% of the 20px within about 70ms, so the slide would read as a jump.
  let transition = "opacity var(--dur-base) ease-out, transform var(--dur-base) ease-out";
  // Resting closed, the content resets without a transition. Entering keeps
  // the open transition declared, with the entry animation's duration and
  // curve; the animation is what moves the content, as no transition starts
  // on a property an animation is driving.
  if (closed) transition = "none";
  // The width is held until this fade ends, so the fade must stay visible
  // until its last frame. Ease-out and ease-in-out both flatten out near
  // transparent and leave the column looking empty for several frames;
  // ease-in reaches 0 steeply, in the frame the width is released.
  else if (presence === "closing") transition = "opacity var(--dur-exit) ease-in";
  return {
    hiddenAttributes: presence === "open" ? {} : { inert: true, "aria-hidden": true },
    panelStyle: closed ? { width: "0px", visibility: "hidden" } : { width: `${String(width)}px` },
    contentStyle: {
      flexShrink: 0,
      // The box's 1px border is inside its width; the content fills the rest,
      // so it never overhangs the box and can never be scrolled sideways.
      width: `${String(width - PANEL_BORDER_PX)}px`,
      opacity: hidden ? 0 : 1,
      // At rest there is no transform at all: any transform, even an identity
      // one, would make this the containing block of every fixed popover in
      // the panel and clip them to its edges.
      transform: closed ? `translateX(${hiddenOffset})` : "none",
      transition,
      // The entry animation starts from the 20px offset, transparent, on the
      // same frame the width commits; it has no fill, so at rest nothing of it
      // remains.
      animation: entering ? `panel-content-enter-${side} var(--dur-base) ease-out` : "none",
    },
  };
}

type Props = {
  readonly side: PanelSide;
  readonly width: number;
  readonly otherOpenWidth: number;
  readonly onWidthChange: (width: number) => void;
  /** Desktop toggle state. The width changes once, never per frame: opening
   * commits it and fades the content in; closing fades the content out, then
   * commits width 0 and rests hidden/inert while mounted. */
  readonly open: boolean;
  readonly children: ReactNode;
};

export function ResizablePanel({
  side,
  width,
  otherOpenWidth,
  onWidthChange,
  open,
  children,
}: Props) {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1400 : window.innerWidth,
  );
  const [dragging, setDragging] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startRef = useRef<{ pointer: number; width: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingClientXRef = useRef<number | null>(null);
  const isLeft = side === "left";
  const rootRef = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(open);

  // Layout-effect (pre-paint) backstop: a hide that starts while focus sits
  // inside this panel hands it to the owning header toggle within the SAME
  // task, so no intermediate body-focus frame is ever observable. Close-intent
  // paths already move focus synchronously inside the UI-store actions; this
  // backstop covers remaining open->false flips (e.g., focus-mode snapshots).
  useLayoutEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (wasOpen && !open && rootRef.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>(`[data-testid="toggle-${side}-panel"]`)?.focus();
    }
  }, [open, side]);
  const contentRef = useRef<HTMLDivElement>(null);
  const { presence, entering } = usePanelPresence(open, contentRef);

  useEffect(() => {
    const onResize = (): void => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
    };
  }, []);

  const min = PANEL_BOUNDS[side].min;
  const max = panelMaxWidth(side, viewportWidth, otherOpenWidth);
  const effectiveWidth =
    dragging && dragWidth !== null
      ? dragWidth
      : clampPanelWidth(side, width, viewportWidth, otherOpenWidth);

  function cancelScheduledDragFrame(): void {
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
  }

  function updateFromPointer(pointer: number): number {
    const start = startRef.current;
    if (!start) return effectiveWidth;
    const delta = isLeft ? pointer - start.pointer : start.pointer - pointer;
    const next = clampPanelWidth(
      side,
      start.width + delta,
      viewportWidth,
      otherOpenWidth,
    );
    setDragWidth(next);
    return next;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    startRef.current = { pointer: event.clientX, width: effectiveWidth };
    pendingClientXRef.current = null;
    setDragging(true);
    setDragWidth(effectiveWidth);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!startRef.current) return;
    pendingClientXRef.current = event.clientX;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const clientX = pendingClientXRef.current;
      pendingClientXRef.current = null;
      if (clientX === null || !startRef.current) return;
      updateFromPointer(clientX);
    });
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!startRef.current) return;
    // The final pointermove may be coalesced and not yet applied; commit its position, not the event's.
    const flushedX = pendingClientXRef.current ?? event.clientX;
    cancelScheduledDragFrame();
    pendingClientXRef.current = null;
    const finalWidth = updateFromPointer(flushedX);
    startRef.current = null;
    setDragging(false);
    setDragWidth(null);
    onWidthChange(finalWidth);
    persistLayout(side, finalWidth);
  }

  function cancelDrag(): void {
    cancelScheduledDragFrame();
    pendingClientXRef.current = null;
    startRef.current = null;
    setDragging(false);
    setDragWidth(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    let next: number | null = null;
    if (event.key === "ArrowLeft")
      next = isLeft ? effectiveWidth - 16 : effectiveWidth + 16;
    if (event.key === "ArrowRight")
      next = isLeft ? effectiveWidth + 16 : effectiveWidth - 16;
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampPanelWidth(
      side,
      next,
      window.innerWidth,
      otherOpenWidth,
    );
    onWidthChange(clamped);
    persistLayout(side, clamped);
  }
  const frame = panelFrame(side, presence, entering, effectiveWidth);
  const layoutKey = presence === "closed" ? "closed" : String(effectiveWidth);
  return (
    <div
      ref={rootRef}
      data-testid={`resizable-panel-${side}`}
      data-panel-side={side}
      data-panel-state={presence}
      {...frame.hiddenAttributes}
      className={`relative flex shrink-0 flex-col overflow-clip border-border-subtle bg-bg-primary ${isLeft ? "border-r" : "border-l"} ${dragging ? "select-none" : ""}`}
      style={frame.panelStyle}
    >
      <LayoutWillChangeSignal layoutKey={layoutKey} />
      <div
        ref={contentRef}
        data-testid={`resizable-panel-${side}-content`}
        className="flex h-full min-h-0 flex-col"
        style={frame.contentStyle}
      >
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`${isLeft ? "Library" : "Companion"} panel width`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(effectiveWidth)}
        aria-valuetext={`${String(Math.round(effectiveWidth))} pixels`}
        tabIndex={0}
        data-testid={`panel-resizer-${side}`}
        className={`group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none focus:outline-none ${isLeft ? "-right-1" : "-left-1"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent group-focus:bg-focus-ring"
        />
      </div>
    </div>
  );
}
