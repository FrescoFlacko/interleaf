import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation } from '@shared/types/annotation';
import {
  findNotePointerSurface,
  getNotePointerSurfaces,
  notePointerDetachDoc,
  notePointerInvalidateLayout,
  pickNoteAtSurfacePoint,
  resetNotePointer,
  subscribeNotePointerRepaints,
  subscribeNotePointerSurfaces,
  type NotePointerSurface,
  type RectLike,
} from './note-pointer';

const DRAG_SUPPRESSION_PX = 6;
const NOTE_FOCUS_FALLBACK_LABEL = 'noted text';

export type NoteCloseReason =
  | 'escape'
  | 'close-button'
  | 'outside-click'
  | 'scroll'
  | 'repaint'
  | 'document-change';

export type OpenNote = {
  readonly annotationId: string;
  /** Anchor fragment rect in top-window viewport coordinates. */
  readonly rect: RectLike;
  /**
   * Identity of the activated fragment (range + rect index within the
   * painted entry). Null when the anchor is the entry as a whole (keyboard
   * activation); reconciliation then tracks the nearest live fragment.
   */
  readonly fragment: { readonly rangeIndex: number; readonly rectIndex: number } | null;
};

/**
 * A keyboard activation route for one saved note: a focusable, invisible
 * proxy rendered in the TOP document over the note's live fragment geometry
 * (translated out of iframe surfaces). Pointer events pass straight through
 * it, so mouse selection and clicks behave exactly as before.
 */
export type NoteFocusProxy = {
  readonly annotationId: string;
  /** Untrusted note text preview — plain text for an aria-label, never HTML. */
  readonly label: string;
  /** Union of live fragment rects in top-window viewport coordinates. */
  readonly rect: RectLike;
};

type OpenMeta = { readonly opener: Element | null };

/**
 * Defect 20 reader wiring: pointer cursor over exactly-noted text and a click
 * affordance that opens the note popover — while never disturbing text
 * selection, the selection toolbar, or drag-to-select flows.
 *
 * Listeners attach per registered surface. Top-document surfaces (PDF,
 * Markdown, DOCX) attach to the reader viewport root; ebook surfaces attach
 * inside each live foliate section iframe document, whose pointer coordinates
 * and Range rects are iframe-local (translated to top-window coordinates only
 * for popover positioning). Surface lifecycle follows adapter paints: section
 * swaps detach the previous iframe document, adapter close detaches the owner,
 * and active-document changes reset everything.
 *
 * Focus policy (non-modal popover): the popover never takes focus. Opening
 * records the focused element as the opener. Escape and the explicit close
 * button restore focus to the opener; outside click, scroll, repaint loss,
 * and document changes close without touching focus so they never steal it
 * from whatever the user just interacted with. Keyboard users can activate
 * the live note focus proxies in the reader itself; the Annotations sidebar
 * remains an additional browse/edit route.
 */
export function useNotePointer(
  containerRef: React.RefObject<HTMLElement | null>,
  annotations: readonly Annotation[],
  documentId: string | null
): {
  readonly openNote: OpenNote | null;
  readonly closeNote: (reason?: NoteCloseReason) => void;
  readonly openAnnotation: Annotation | null;
  readonly noteFocusProxies: readonly NoteFocusProxy[];
  readonly openFromProxy: (annotationId: string, opener: Element | null) => void;
} {
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  const openMetaRef = useRef<OpenMeta | null>(null);
  const controllersRef = useRef(new Map<Document, SurfaceController>());
  const openNoteRef = useRef<OpenNote | null>(null);
  openNoteRef.current = openNote;

  const closeNote = useCallback((reason: NoteCloseReason = 'close-button'): void => {
    const meta = openMetaRef.current;
    openMetaRef.current = null;
    setOpenNote(null);
    // Focus restoration is intentional and limited: Escape and the explicit
    // close button return focus to the opener. Every other close reason must
    // not steal focus from whatever the user just clicked or focused.
    if ((reason === 'escape' || reason === 'close-button') && meta !== null) {
      if (meta.opener instanceof HTMLElement) meta.opener.focus();
    }
  }, []);

  // Open-popover reconciliation across paints/sections/reflow:
  //  - the note leaving every surface closes the popover (no focus change),
  //  - a still-painted note repositions onto the SAME live fragment when it
  //    still exists, else the live fragment nearest the previous anchor.
  useEffect(() => {
    const unsubscribe = subscribeNotePointerRepaints((surface) => {
      // Layout invalidation/repaint can move a noted range under a stationary
      // pointer. The controller owns the hover cursor for its surface, so
      // reconcile that retained point before updating the popover anchor.
      controllersRef.current.get(surface.doc)?.reconcileHover(surface);
      const current = openNoteRef.current;
      if (current === null) return;
      const nextRect = repositionFromSurfaces(
        current.annotationId,
        current.fragment,
        current.rect
      );
      if (nextRect === null) {
        openMetaRef.current = null;
        setOpenNote(null);
        return;
      }
      setOpenNote({
        annotationId: current.annotationId,
        rect: nextRect.rect,
        fragment: nextRect.fragment,
      });
    });
    return unsubscribe;
  }, []);

  // Annotations removed from the active document close the popover too.
  useEffect(() => {
    const current = openNoteRef.current;
    if (current !== null && !annotations.some((a) => a.id === current.annotationId)) {
      closeNote('repaint');
    }
  }, [annotations, closeNote]);

  // Active-document switch: nothing may survive across documents. The first
  // mount does NOT reset — paints that landed before this effect (e.g.
  // adapter paints racing the hook) must survive.
  const previousDocumentIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousDocumentIdRef.current;
    previousDocumentIdRef.current = documentId;
    if (previous === undefined || previous === documentId) return undefined;
    resetNotePointer();
    if (openNoteRef.current !== null) closeNote('document-change');
    return undefined;
  }, [documentId, closeNote]);

  // Runtime window resizes reflow painted geometry: invalidate cached rect
  // snapshots so hit-testing and the open popover's anchor recompute (the
  // popover itself repositions from its own viewport state).
  useEffect(() => {
    const onResize = (): void => { notePointerInvalidateLayout(); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);

  // Keyboard activation routes: one proxy per painted note, tracking live
  // fragment geometry. Every registry change (paint, scroll, reflow, section
  // swap, detach) repaints and recomputes; proxies whose geometry leaves the
  // viewport disappear so they can never become invisible tab stops.
  const [noteFocusProxies, setNoteFocusProxies] = useState<readonly NoteFocusProxy[]>([]);
  useEffect(() => {
    const refresh = (): void => { setNoteFocusProxies(computeFocusProxies()); };
    refresh();
    const unsubscribeRepaints = subscribeNotePointerRepaints(refresh);
    const unsubscribeSurfaces = subscribeNotePointerSurfaces(refresh);
    return () => {
      unsubscribeRepaints();
      unsubscribeSurfaces();
    };
  }, []);

  const openFromProxy = useCallback((annotationId: string, opener: Element | null): void => {
    // Keyboard activation has no pointer-selected line. Choose the first
    // topmost live fragment deterministically; the resulting identity is
    // retained across subsequent repaint/reflow reconciliation.
    const next = repositionFromSurfaces(annotationId, null, null);
    if (next === null) return;
    openMetaRef.current = { opener };
    setOpenNote({ annotationId, rect: next.rect, fragment: next.fragment });
  }, []);

  // Escape closes intentionally and restores opener focus (see focus policy).
  // While the popover is open the listener spans the top document AND every
  // live surface document: focus may sit inside a section iframe after an
  // iframe click, and the keydown must be caught wherever focus lives.
  useEffect(() => {
    if (openNote === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeNote('escape');
    };
    const docs = new Set<Document>([document, ...getNotePointerSurfaces().map((s) => s.doc)]);
    for (const doc of docs) doc.addEventListener('keydown', onKeyDown, true);
    return () => {
      for (const doc of docs) doc.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openNote, closeNote]);

  // Attach/detach one controller per live surface document.
  useEffect(() => {
    const controllers = controllersRef.current;
    const sync = (): void => {
      const liveDocs = new Set<Document>();
      for (const surface of getNotePointerSurfaces()) {
        liveDocs.add(surface.doc);
        if (controllers.has(surface.doc)) continue;
        const root = resolveRoot(surface, containerRef.current);
        if (root === null) continue;
        const controller = new SurfaceController(surface, root, {
          onOpen: (next, opener) => {
            openMetaRef.current = { opener };
            setOpenNote(next);
          },
          isOpen: () => openNoteRef.current !== null,
          onClose: closeNote,
        });
        controller.attach();
        controllers.set(surface.doc, controller);
      }
      for (const [doc, controller] of [...controllers.entries()]) {
        if (!liveDocs.has(doc) || findNotePointerSurface(doc) === null) {
          controller.detach();
          controllers.delete(doc);
        }
      }
    };
    const unsubscribe = subscribeNotePointerSurfaces(sync);
    sync();
    return () => {
      unsubscribe();
      for (const controller of controllers.values()) controller.detach();
      controllers.clear();
      resetNotePointer();
    };
  }, [containerRef, closeNote]);

  const openAnnotation: Annotation | null =
    openNote === null
      ? null
      : annotations.find((a) => a.id === openNote.annotationId)
        ?? null;

  return { openNote, closeNote, openAnnotation, noteFocusProxies, openFromProxy };
}

type FragmentIdentity = { readonly rangeIndex: number; readonly rectIndex: number } | null;

/**
 * One proxy per painted note across all live surfaces: the union of its live
 * fragment rects, translated to top-window viewport coordinates. Notes whose
 * geometry sits entirely outside the viewport are omitted — an invisible
 * tab stop would be worse than none.
 */
function computeFocusProxies(): NoteFocusProxy[] {
  const byId = new Map<string, NoteFocusProxy>();
  const viewport = typeof window === 'undefined'
    ? { width: 0, height: 0 }
    : { width: window.innerWidth, height: window.innerHeight };
  for (const surface of getNotePointerSurfaces()) {
    for (const entry of surface.entries) {
      const topRects: RectLike[] = [];
      for (const range of entry.ranges) {
        for (const rect of Array.from(range.getClientRects())) {
          if (!isUsableRect(rect)) continue;
          const topRect = surface.toTopClientRect(rect);
          if (!isUsableRect(topRect)) continue;
          // Keep only the actually visible portion. A proxy that is entirely
          // outside the viewport would create an invisible tab stop, and a
          // union spanning far-off fragments would make its focus ring just as
          // misleading. Pointer events remain disabled on the proxy itself.
          const clipped = clipToViewport(topRect, viewport.width, viewport.height);
          if (clipped !== null) topRects.push(clipped);
        }
      }
      if (topRects.length === 0) continue;
      const left = Math.min(...topRects.map((r) => r.left));
      const right = Math.max(...topRects.map((r) => r.right));
      const top = Math.min(...topRects.map((r) => r.top));
      const bottom = Math.max(...topRects.map((r) => r.bottom));
      const union: RectLike = { left, top, right, bottom };
      const existing = byId.get(entry.annotationId);
      if (existing === undefined) {
        byId.set(entry.annotationId, {
          annotationId: entry.annotationId,
          // A location/empty quote can legitimately have no selected text;
          // keep its native focus target meaningfully named for assistive
          // technology instead of exposing an unlabeled "Open reader note: ".
          label: entry.selectedTextPreview.trim() || NOTE_FOCUS_FALLBACK_LABEL,
          rect: union,
        });
        continue;
      }
      byId.set(entry.annotationId, {
        ...existing,
        rect: {
          left: Math.min(existing.rect.left, union.left),
          top: Math.min(existing.rect.top, union.top),
          right: Math.max(existing.rect.right, union.right),
          bottom: Math.max(existing.rect.bottom, union.bottom),
        },
      });
    }
  }
  return [...byId.values()];
}

type PointerLikeEvent = Event & {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
};

type StyleLike = { cursor: string };

/**
 * Reads an element's inline style structurally.
 *
 * An iframe body is not an `instanceof` the top realm's `HTMLElement`, so a
 * class check would silently skip it; the member is probed instead, and a node
 * without a usable inline style simply keeps its cursor.
 */
function isInlineStyled(node: Element): node is Element & { readonly style: StyleLike } {
  if (!('style' in node)) return false;
  const style = node.style;
  if (typeof style !== 'object' || style === null) return false;
  return 'cursor' in style && typeof style.cursor === 'string';
}

function inlineStyle(node: Element): StyleLike | null {
  return isInlineStyled(node) ? node.style : null;
}

/**
 * `Document.elementFromPoint`, which jsdom does not implement.
 *
 * The member is probed rather than called directly so the production
 * enhancement stays optional in lightweight DOM test environments.
 */
function elementFromPointOf(doc: Document): ((x: number, y: number) => Element | null) | null {
  if (!('elementFromPoint' in doc)) return null;
  return (x, y) => doc.elementFromPoint(x, y);
}

/** The inline style of the element under a point, when it is not the root. */
function hitTargetStyle(doc: Document, root: Element, point: { readonly x: number; readonly y: number }): StyleLike | null {
  const target = elementFromPointOf(doc)?.(point.x, point.y) ?? null;
  return target !== null && target !== root ? inlineStyle(target) : null;
}

function isUsableRect(rect: RectLike): boolean {
  return Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) && Number.isFinite(rect.bottom) &&
    rect.right > rect.left && rect.bottom > rect.top;
}

function clipToViewport(rect: RectLike, width: number, height: number): RectLike | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(width, rect.right);
  const bottom = Math.min(height, rect.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}


function repositionFromSurfaces(
  annotationId: string,
  fragment: FragmentIdentity,
  previousRect: RectLike | null
): { rect: RectLike; fragment: FragmentIdentity } | null {
  for (const surface of getNotePointerSurfaces()) {
    const entry = surface.entries.find((candidate) => candidate.annotationId === annotationId);
    if (entry === undefined) continue;
    // Flatten the live fragments with their identities.
    const live: { rect: RectLike; topRect: RectLike; rangeIndex: number; rectIndex: number }[] = [];
    for (const [rangeIndex, range] of entry.ranges.entries()) {
      for (const [rectIndex, rect] of Array.from(range.getClientRects()).entries()) {
        if (!isUsableRect(rect)) continue;
        const topRect = surface.toTopClientRect(rect);
        if (isUsableRect(topRect)) live.push({ rect, topRect, rangeIndex, rectIndex });
      }
    }
    if (live.length === 0) continue;
    let chosen: (typeof live)[number] | undefined;
    if (fragment !== null) {
      chosen = live.find(
        (candidate) =>
          candidate.rangeIndex === fragment.rangeIndex && candidate.rectIndex === fragment.rectIndex
      );
    }
    if (chosen === undefined) {
      if (previousRect === null) {
        // Keyboard activation has no single pointer location. DOM Range
        // fragments are normally ordered top-to-bottom, but sorting makes
        // this deterministic even when an adapter returns a different order.
        chosen = live.reduce((best, candidate) => {
          const candidateTop = candidate.topRect.top;
          const bestTop = best.topRect.top;
          if (candidateTop !== bestTop) return candidateTop < bestTop ? candidate : best;
          if (candidate.topRect.left !== best.topRect.left) {
            return candidate.topRect.left < best.topRect.left ? candidate : best;
          }
          if (candidate.rangeIndex !== best.rangeIndex) {
            return candidate.rangeIndex < best.rangeIndex ? candidate : best;
          }
          return candidate.rectIndex < best.rectIndex ? candidate : best;
        });
      } else {
        // Closest-fragment fallback: reflow can merge or drop lines, so the
        // activated identity may no longer exist; compare in TOP-WINDOW
        // coordinates because previousRect is stored after iframe translation.
        const previousCenterX = (previousRect.left + previousRect.right) / 2;
        const previousCenterY = (previousRect.top + previousRect.bottom) / 2;
        chosen = live.reduce((best, candidate) => {
          const candidateCenterX = (candidate.topRect.left + candidate.topRect.right) / 2;
          const candidateCenterY = (candidate.topRect.top + candidate.topRect.bottom) / 2;
          const bestCenterX = (best.topRect.left + best.topRect.right) / 2;
          const bestCenterY = (best.topRect.top + best.topRect.bottom) / 2;
          const candidateDistance = Math.hypot(candidateCenterX - previousCenterX, candidateCenterY - previousCenterY);
          const bestDistance = Math.hypot(bestCenterX - previousCenterX, bestCenterY - previousCenterY);
          return candidateDistance < bestDistance ? candidate : best;
        });
      }
    }
    return {
      rect: chosen.topRect,
      fragment: { rangeIndex: chosen.rangeIndex, rectIndex: chosen.rectIndex },
    };
  }
  return null;
}

function resolveRoot(surface: NotePointerSurface, container: HTMLElement | null): Element | null {
  // Top-document surfaces listen on the reader viewport root; iframe surfaces
  // listen on the iframe body (events inside a sandboxed iframe never bubble
  // to the top document).
  if (surface.doc === document) return container;
  return surface.doc.body;
}

/**
 * Structural coordinate guard instead of `instanceof`: events dispatched by
 * the sandboxed ebook iframe belong to the iframe's realm, so they FAIL
 * top-realm `instanceof PointerEvent`/`MouseEvent` checks. Validate the
 * numeric contract strictly instead — no realm assumptions, no unsafe casts.
 */
function isCoordinateEvent(event: Event): event is PointerLikeEvent {
  const candidate = event as PointerLikeEvent;
  return (
    typeof candidate.clientX === 'number' && Number.isFinite(candidate.clientX) &&
    typeof candidate.clientY === 'number' && Number.isFinite(candidate.clientY) &&
    typeof candidate.buttons === 'number' && Number.isFinite(candidate.buttons)
  );
}

type SurfaceControllerCallbacks = {
  readonly onOpen: (next: OpenNote, opener: Element | null) => void;
  readonly isOpen: () => boolean;
  readonly onClose: (reason?: NoteCloseReason) => void;
};

/**
 * One listener set per surface document. Coordinates and rects stay in the
 * surface's own space for hit-testing; only the popover anchor rect is
 * translated to top-window coordinates at open time.
 */
class SurfaceController {
  private readonly surface: NotePointerSurface;
  private readonly root: Element;
  private readonly doc: Document;
  private readonly callbacks: SurfaceControllerCallbacks;
  private pointerDown: { x: number; y: number } | null = null;
  private dragDistance = 0;
  /**
   * Set when the pointer leaves the surface while a button is still held.
   * Any resulting click on this surface stays suppressed until a terminal
   * click / pointercancel / lostpointercapture / fresh pointerdown consumes
   * or clears it — a re-entering release must never open a note.
   */
  private leftWhilePressed = false;
  private latestPoint: { x: number; y: number; buttons: number } | null = null;
  /** Last pointer location survives the hover rAF for stationary re-hit-tests. */
  private lastHoverPoint: { x: number; y: number; buttons: number } | null = null;
  private hoverFrame: number | null = null;
  private cursorActive = false;
  private cursorTarget: { readonly style: StyleLike; readonly previous: string } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean?][] = [];

  constructor(
    surface: NotePointerSurface,
    root: Element,
    callbacks: SurfaceControllerCallbacks
  ) {
    this.surface = surface;
    this.root = root;
    this.doc = surface.doc;
    this.callbacks = callbacks;
  }

  attach(): void {
    const root = this.root;
    // Display-setting reflows (typography, margins, zoom, content width)
    // move painted fragments without any scroll event; observing the
    // surface root invalidates rect caches when its box actually changes.
    this.resizeObserver = new ResizeObserver(() => { notePointerInvalidateLayout(); });
    this.resizeObserver.observe(root);
    this.listen(root, 'pointerdown', this.onPointerDown);
    this.listen(root, 'pointermove', this.onPointerMove);
    this.listen(root, 'pointerup', this.onPointerUp);
    this.listen(root, 'pointercancel', this.onPointerReset);
    this.listen(root, 'lostpointercapture', this.onPointerReset);
    this.listen(root, 'pointerleave', this.onPointerLeave);
    this.listen(root, 'click', this.onClick);
    // Scroll inside the surface moves the painted geometry under the popover.
    this.listen(this.doc, 'scroll', this.onScroll, true);
    // A discarded section document detaches its own listeners.
    this.listen(this.doc, 'pagehide', this.onPageHide, true);
  }

  detach(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const [target, type, listener, capture] of this.listeners) {
      target.removeEventListener(type, listener, capture);
    }
    this.listeners.length = 0;
    if (this.hoverFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = null;
    }
    this.latestPoint = null;
    this.lastHoverPoint = null;
    this.setCursor(false);
  }

  /**
   * Re-hit-test the retained pointer location after this surface repaints or
   * invalidates its layout. A repaint can move/remove a range beneath a
   * stationary pointer, so waiting for another pointermove would leave the
   * cursor stale. Detached surfaces are explicitly cleared before their
   * repaint notification is delivered by the registry.
   */
  reconcileHover(surface: NotePointerSurface): void {
    if (surface !== this.surface) return;
    if (!getNotePointerSurfaces().includes(this.surface)) {
      this.cancelPendingHoverFrame();
      this.setCursor(false);
      return;
    }
    this.cancelPendingHoverFrame();
    const point = this.lastHoverPoint;
    if (point?.buttons !== 0) {
      this.setCursor(false);
      return;
    }
    const hit = pickNoteAtSurfacePoint(this.surface, point.x, point.y);
    this.setCursor(hit !== null, point);
  }

  private cancelPendingHoverFrame(): void {
    if (this.hoverFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = null;
    }
    this.latestPoint = null;
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture = false
  ): void {
    target.addEventListener(type, listener, capture);
    this.listeners.push([target, type, listener, capture]);
  }

  private setCursor(active: boolean, point?: { readonly x: number; readonly y: number }): void {
    if (this.cursorActive === active && (!active || point === undefined)) return;
    const rootStyle = inlineStyle(this.root);
    if (rootStyle !== null) rootStyle.cursor = active ? 'pointer' : '';
    if (!active) {
      if (this.cursorTarget !== null) {
        this.cursorTarget.style.cursor = this.cursorTarget.previous;
        this.cursorTarget = null;
      }
    } else if (point !== undefined) {
      // Some reader surfaces (notably PDF.js text-layer spans) explicitly set
      // cursor: text on their child elements. Update only the element under
      // the hit point, retaining and restoring its prior inline cursor, so a
      // note really presents a pointer glyph without changing reader-wide
      // selection affordances.
      // jsdom does not implement elementFromPoint, while Chromium does, so the
      // lookup stays optional without weakening the root cursor.
      const targetStyle = hitTargetStyle(this.doc, this.root, point);
      if (targetStyle !== null) {
        if (this.cursorTarget?.style !== targetStyle) {
          if (this.cursorTarget !== null) this.cursorTarget.style.cursor = this.cursorTarget.previous;
          this.cursorTarget = { style: targetStyle, previous: targetStyle.cursor };
        }
        targetStyle.cursor = 'pointer';
      }
    }
    this.cursorActive = active;
  };

  private readonly onPointerDown = (event: Event): void => {
    if (!isCoordinateEvent(event)) return;
    this.pointerDown = { x: event.clientX, y: event.clientY };
    this.dragDistance = 0;
    this.leftWhilePressed = false;
    this.lastHoverPoint = { x: event.clientX, y: event.clientY, buttons: event.buttons };
  };

  private readonly onPointerMove = (event: Event): void => {
    if (!isCoordinateEvent(event)) return;
    // Drag distance is measured continuously while buttons are held; it is
    // deliberately NOT cleared on pointerup because the browser fires `click`
    // after `pointerup`, so drag evidence must survive until the click runs.
    const start = this.pointerDown;
    if (start !== null && event.buttons !== 0) {
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (distance > this.dragDistance) this.dragDistance = distance;
    }
    // Always remember the latest point and coalesce into one rAF; the frame
    // consumes the LATEST coordinates (and button state) so note→outside
    // moves never latch the cursor onto a stale interior point.
    const point = { x: event.clientX, y: event.clientY, buttons: event.buttons };
    this.latestPoint = point;
    this.lastHoverPoint = point;
    if (this.hoverFrame !== null || typeof window === 'undefined') return;
    this.hoverFrame = window.requestAnimationFrame(() => {
      this.hoverFrame = null;
      const point = this.latestPoint;
      this.latestPoint = null;
      if (point === null) return;
      // Only an actively-held pointer hides the cursor; a stale (e.g.
      // just-saved) selection must not suppress the pointer affordance.
      if (point.buttons !== 0) {
        this.setCursor(false);
        return;
      }
      const hit = pickNoteAtSurfacePoint(this.surface, point.x, point.y);
      this.setCursor(hit !== null, point);
    });
  };

  private readonly onPointerUp = (event: Event): void => {
    this.pointerDown = null;
    if (isCoordinateEvent(event)) {
      this.lastHoverPoint = { x: event.clientX, y: event.clientY, buttons: 0 };
    }
  };

  private readonly onPointerReset = (): void => {
    // pointercancel / lostpointercapture: the drag never produces a click.
    this.pointerDown = null;
    this.dragDistance = 0;
    this.leftWhilePressed = false;
    this.lastHoverPoint = null;
    this.latestPoint = null;
    this.setCursor(false);
  };

  private readonly onPointerLeave = (event: Event): void => {
    // Leaving the surface with the pointer STILL held is a drag leave: the
    // pointer may re-enter and release here, so the explicit suppression
    // state engages — any resulting click on this surface is prevented
    // until a terminal click / reset consumes or clears it.
    if (isCoordinateEvent(event) && event.buttons !== 0) {
      this.leftWhilePressed = true;
      this.latestPoint = null;
      this.lastHoverPoint = null;
      this.setCursor(false);
      return;
    }
    // A plain hover exit is a clean stop; the next pointerdown re-seeds.
    this.pointerDown = null;
    this.dragDistance = 0;
    this.leftWhilePressed = false;
    this.latestPoint = null;
    this.lastHoverPoint = null;
    this.setCursor(false);
  };

  private readonly onScroll = (): void => {
    notePointerInvalidateLayout();
    if (this.callbacks.isOpen()) this.callbacks.onClose('scroll');
  };

  private readonly onPageHide = (): void => {
    // The iframe document can disappear before the next adapter paint. Detach
    // it immediately so an already-open top-frame popover cannot outlive its
    // section, and then remove this controller's listeners.
    this.detach();
    notePointerDetachDoc(this.surface.owner, this.surface.doc);
  };

  private readonly onClick = (event: Event): void => {
    if (!isCoordinateEvent(event)) return;
    // Drag-to-select must never flip into "open note". The retained pointer
    // travel distance is the actual guard: it is measured on every held-button
    // pointermove and survives the intervening pointerup. A live selection is
    // deliberately NOT a click guard here — Chromium fires the click before a
    // pre-existing selection collapses, which would suppress legitimate opens.
    // Suppression evidence is explicit: retained pointer travel OR a leave
    // while the button was still held (re-entry release). Both are consumed
    // here — the terminal click for this press.
    const dragged =
      this.leftWhilePressed || this.dragDistance > DRAG_SUPPRESSION_PX;
    this.pointerDown = null;
    this.dragDistance = 0;
    this.leftWhilePressed = false;
    if (dragged) {
      this.setCursor(false);
      return;
    }
    const hit = pickNoteAtSurfacePoint(this.surface, event.clientX, event.clientY);
    if (hit === null) {
      if (this.callbacks.isOpen()) this.callbacks.onClose('outside-click');
      return;
    }
    // Record the top-document focused element as the opener (an iframe click
    // focuses the iframe element in the top document) for intentional restore.
    const opener = document.activeElement;
    this.callbacks.onOpen(
      {
        annotationId: hit.annotationId,
        rect: this.surface.toTopClientRect(hit.rect),
        fragment: { rangeIndex: hit.rangeIndex, rectIndex: hit.rectIndex },
      },
      opener
    );
  };
}
