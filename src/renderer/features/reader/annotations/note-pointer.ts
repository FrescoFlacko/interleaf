import type { Annotation } from '@shared/types/annotation';
import { applyDomHighlights } from './dom-anchors';

/**
 * Defect 20 pointer-affordance plumbing.
 *
 * CSS Custom Highlight pseudo-elements never receive pointer events, so
 * noted-range hover/click hit-testing is geometric: every adapter repaint
 * registers its live ranges here, and surface-scoped listeners resolve the
 * note under a point from client-rect containment.
 *
 * Surfaces are scoped per owner (the painting adapter instance) and per
 * owning Document. Top-document adapters (PDF, Markdown, DOCX) register the
 * top `document`; the ebook adapters register the live foliate section iframe
 * document and translate iframe-local rects to top-window viewport
 * coordinates at open time, so the popover is positioned in the top frame
 * regardless of where the iframe sits.
 *
 * This module holds ONLY framework-free state:
 *  - pure rect math (`pickNoteAtPoint`, `collectNoteEntries`) unit tests drive,
 *  - a surface registry keyed by owner+document with per-paint rect caches.
 * React wiring lives in `use-note-pointer.ts`.
 */

export type RectLike = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** Structural stand-in for DOM Range so pure tests can use fakes. */
export type RangeLike = {
  getClientRects(): ArrayLike<RectLike>;
};

export type NotePointerEntry = {
  readonly annotationId: string;
  /**
   * Untrusted document text — plain text only, rendered as React text nodes.
   * Never interpreted as HTML or trusted content.
   */
  readonly selectedTextPreview: string;
  readonly ranges: RangeLike[];
};

export type NoteHit = {
  readonly annotationId: string;
  /** Containing fragment rect in the surface's own coordinate space. */
  readonly rect: RectLike;
  /**
   * Identity of the activated fragment so popover reconciliation can follow
   * the same live fragment across reflow instead of always the first rect.
   */
  readonly rangeIndex: number;
  readonly rectIndex: number;
};

const RECT_SLACK_PX = 1;

function rectsOf(range: RangeLike): readonly RectLike[] {
  return Array.from(range.getClientRects()).filter(
    (r) => r.right > r.left && r.bottom > r.top
  );
}

function containsPoint(rect: RectLike, x: number, y: number): boolean {
  return (
    x >= rect.left - RECT_SLACK_PX &&
    x <= rect.right + RECT_SLACK_PX &&
    y >= rect.top - RECT_SLACK_PX &&
    y <= rect.bottom + RECT_SLACK_PX
  );
}

/**
 * Deterministic overlap rule: among every fragment rect containing the point,
 * the smallest area wins; ties break to the earliest entry/rect, so
 * multi-line fragments resolve to the line box under the pointer rather than
 * a full-range union.
 */
export function pickNoteAtPoint(
  entries: readonly NotePointerEntry[],
  x: number,
  y: number,
  rectsFor: (range: RangeLike) => readonly RectLike[] = rectsOf
): NoteHit | null {
  let best: {
    annotationId: string;
    rect: RectLike;
    area: number;
    order: number;
    rangeIndex: number;
    rectIndex: number;
  } | null = null;
  let entryOrder = 0;
  for (const entry of entries) {
    for (const [rangeIndex, range] of entry.ranges.entries()) {
      for (const [rectIndex, rect] of rectsFor(range).entries()) {
        if (!containsPoint(rect, x, y)) continue;
        const area = (rect.right - rect.left) * (rect.bottom - rect.top);
        if (
          best === null ||
          area < best.area ||
          (area === best.area && entryOrder < best.order)
        ) {
          best = { annotationId: entry.annotationId, rect, area, order: entryOrder, rangeIndex, rectIndex };
        }
      }
    }
    entryOrder += 1;
  }
  if (best === null) return null;
  return {
    annotationId: best.annotationId,
    rect: best.rect,
    rangeIndex: best.rangeIndex,
    rectIndex: best.rectIndex,
  };
}

type PaintedRange = { readonly annotation: Annotation; readonly range: RangeLike };

function isPointerNote(annotation: Annotation): boolean {
  return annotation.type === 'note' && !annotation.isLocationNote;
}

/** Only a coloured highlight is painted (see `applyDomHighlights`), so only it can be clicked. */
function isPaintedHighlight(annotation: Annotation): boolean {
  return annotation.type === 'highlight' && annotation.color !== null;
}

/** Groups a fresh adapter paint into note-only entries in registration order. */
export function collectNoteEntries(painted: readonly PaintedRange[]): NotePointerEntry[] {
  return groupPointerEntries(painted, isPointerNote).filter((entry) =>
    // An entry whose ranges expose zero client fragments (e.g. fully hidden)
    // can never be hit-tested, so it must not participate in resolution.
    entry.ranges.some((range) => rectsOf(range).length > 0)
  );
}

/**
 * Groups a fresh adapter paint into painted-highlight entries in registration
 * order. Highlights far outnumber notes, so they are not measured at paint
 * time; hit-testing, focus proxies and repositioning skip a range without
 * client fragments on their own.
 */
function collectHighlightEntries(painted: readonly PaintedRange[]): NotePointerEntry[] {
  return groupPointerEntries(painted, isPaintedHighlight);
}

function groupPointerEntries(
  painted: readonly PaintedRange[],
  include: (annotation: Annotation) => boolean
): NotePointerEntry[] {
  const byId = new Map<string, NotePointerEntry>();
  for (const item of painted) {
    if (!include(item.annotation)) continue;
    const id = item.annotation.id;
    const existing = byId.get(id);
    byId.set(id, existing === undefined
      ? { annotationId: id, selectedTextPreview: (item.annotation.selectedText ?? '').slice(0, 160), ranges: [item.range] }
      : { ...existing, ranges: [...existing.ranges, item.range] });
  }
  // Map iteration follows first insertion, so entries keep registration order.
  return [...byId.values()];
}

/* ---------------------------------------------------------------------------
 * Surface registry. Keyed by owner (the painting adapter instance) and the
 * owning Document, so iframe section swaps and adapter closes detach their
 * own data while top-document adapters keep working untouched.
 * ------------------------------------------------------------------------- */

export type NotePointerSurface = {
  readonly owner: object;
  readonly doc: Document;
  /** Note entry list in paint order; surface-local hit-testing input. */
  entries: readonly NotePointerEntry[];
  /** Painted-highlight entries in paint order; a note under the same point wins. */
  highlightEntries: readonly NotePointerEntry[];
  /** Translates a surface-local rect to top-window viewport coordinates. */
  readonly toTopClientRect: (rect: RectLike) => RectLike;
  /** Bumped on every paint; rect caches compare against it. */
  epoch: number;
  /** Cached fragment rects per range, invalidated by paint or layout shift. */
  readonly rectCache: Map<RangeLike, readonly RectLike[]>;
};

const surfacesByOwner = new Map<object, Map<Document, NotePointerSurface>>();
const surfaceSubscribers = new Set<() => void>();
const repaintSubscribers = new Set<(surface: NotePointerSurface) => void>();

function notifySurfaces(): void {
  for (const subscriber of surfaceSubscribers) subscriber();
}

function notifyRepaint(surface: NotePointerSurface): void {
  for (const subscriber of repaintSubscribers) subscriber(surface);
}

export function getNotePointerSurfaces(): readonly NotePointerSurface[] {
  const all: NotePointerSurface[] = [];
  for (const byDoc of surfacesByOwner.values()) {
    for (const surface of byDoc.values()) all.push(surface);
  }
  return all;
}

export function findNotePointerSurface(doc: Document): NotePointerSurface | null {
  for (const byDoc of surfacesByOwner.values()) {
    const surface = byDoc.get(doc);
    if (surface !== undefined) return surface;
  }
  return null;
}

function cachedRectsFor(surface: NotePointerSurface): (range: RangeLike) => readonly RectLike[] {
  return (range) => {
    const cached = surface.rectCache.get(range);
    if (cached !== undefined) return cached;
    const rects = rectsOf(range);
    surface.rectCache.set(range, rects);
    return rects;
  };
}

/** Hit-test within one surface using its cached fragment rects. */
export function pickNoteAtSurfacePoint(surface: NotePointerSurface, x: number, y: number): NoteHit | null {
  return pickNoteAtPoint(surface.entries, x, y, cachedRectsFor(surface));
}

/** Hit-test the painted highlights within one surface using its cached fragment rects. */
export function pickHighlightAtSurfacePoint(surface: NotePointerSurface, x: number, y: number): NoteHit | null {
  return pickNoteAtPoint(surface.highlightEntries, x, y, cachedRectsFor(surface));
}

export type NotePointerPaintMeta = {
  /** Translates surface-local rects to top-window coords (identity for top docs). */
  readonly toTopClientRect?: (rect: RectLike) => RectLike;
};

/**
 * Register/replace the painted note and highlight entries for one owner+document surface.
 * Any other document painted by the same owner is detached first (section
 * swaps), and the rect cache is dropped (fresh ranges never share rects).
 */
export function notePointerPaint(
  owner: object,
  doc: Document,
  painted: readonly PaintedRange[],
  meta: NotePointerPaintMeta = {}
): void {
  let byDoc = surfacesByOwner.get(owner);
  if (byDoc === undefined) {
    byDoc = new Map();
    surfacesByOwner.set(owner, byDoc);
  }
  for (const existingDoc of [...byDoc.keys()]) {
    if (existingDoc !== doc) {
      const detached = byDoc.get(existingDoc);
      byDoc.delete(existingDoc);
      // Remove the old section before repaint reconciliation runs. An open
      // popover anchored in the discarded iframe must see the registry
      // without that surface and close synchronously, rather than surviving
      // until the next pointer event or Escape key.
      if (detached !== undefined) notifyRepaint(detached);
    }
  }
  const surface: NotePointerSurface = byDoc.get(doc) ?? {
    owner,
    doc,
    entries: [],
    highlightEntries: [],
    toTopClientRect: meta.toTopClientRect ?? ((rect) => rect),
    epoch: 0,
    rectCache: new Map(),
  };
  surface.entries = collectNoteEntries(painted);
  surface.highlightEntries = collectHighlightEntries(painted);
  surface.epoch += 1;
  surface.rectCache.clear();
  byDoc.set(doc, surface);
  notifySurfaces();
  notifyRepaint(surface);
}

export function notePointerDetachOwner(owner: object): void {
  const byDoc = surfacesByOwner.get(owner);
  if (byDoc === undefined) return;
  if (byDoc.size === 0) {
    surfacesByOwner.delete(owner);
    return;
  }
  // Remove from the registry BEFORE notifying: a synchronous reconciliation
  // subscriber must no longer see the detached surface, so an open popover
  // anchored there closes and focus proxies unmount immediately.
  surfacesByOwner.delete(owner);
  for (const surface of byDoc.values()) notifyRepaint(surface);
  notifySurfaces();
}

/** Detach one document's surface (old iframe content discarded). */
export function notePointerDetachDoc(owner: object, doc: Document): void {
  const byDoc = surfacesByOwner.get(owner);
  const surface = byDoc?.get(doc);
  if (byDoc === undefined || surface === undefined) return;
  byDoc.delete(doc);
  if (byDoc.size === 0) surfacesByOwner.delete(owner);
  notifyRepaint(surface);
  notifySurfaces();
}

/** Reset every surface; used on active-document change and reader close. */
export function resetNotePointer(): void {
  if (surfacesByOwner.size === 0) return;
  const detached = getNotePointerSurfaces();
  surfacesByOwner.clear();
  // Repaint subscribers own open-popover reconciliation. Notify after the
  // registry is empty so every detached surface is observed as gone.
  for (const surface of detached) notifyRepaint(surface);
  notifySurfaces();
}

/**
 * Invalidate cached fragment rects after scroll/resize/reflow. Rects recompute
 * lazily on the next hit-test; subscribers may also reposition or close an
 * open popover.
 */
export function notePointerInvalidateLayout(): void {
  for (const surface of getNotePointerSurfaces()) {
    surface.rectCache.clear();
    notifyRepaint(surface);
  }
}

export function subscribeNotePointerSurfaces(callback: () => void): () => void {
  surfaceSubscribers.add(callback);
  return () => { surfaceSubscribers.delete(callback); };
}

export function subscribeNotePointerRepaints(
  callback: (surface: NotePointerSurface) => void
): () => void {
  repaintSubscribers.add(callback);
  return () => { repaintSubscribers.delete(callback); };
}

/**
 * Single repaint integration point shared by every adapter's repaint site, so
 * the pointer registry can never drift from what is painted on screen.
 */
export function paintAnchoredRanges(
  owner: object,
  doc: Document,
  painted: readonly { annotation: Annotation; range: Range }[],
  meta: NotePointerPaintMeta = {}
): boolean {
  const highlighted = applyDomHighlights(doc, painted);
  notePointerPaint(owner, doc, painted, meta);
  return highlighted;
}
