// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/shared/types/annotation';
import {
  collectNoteEntries,
  getNotePointerSurfaces,
  notePointerDetachDoc,
  notePointerDetachOwner,
  notePointerInvalidateLayout,
  notePointerPaint,
  pickNoteAtPoint,
  pickNoteAtSurfacePoint,
  resetNotePointer,
  subscribeNotePointerRepaints,
  subscribeNotePointerSurfaces,
  type NotePointerEntry,
  type NotePointerSurface,
  type RangeLike,
  type RectLike,
} from '../../src/renderer/features/reader/annotations/note-pointer';

function base(): Annotation {
  return {
    id: 'base',
    documentId: 'doc-1',
    type: 'highlight',
    color: 'yellow',
    status: 'anchored',
    anchor: { format: 'markdown', quote: { exact: 'x', prefix: '', suffix: '' }, blockIndex: 1 },
    selectedText: 'The reader engine',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  } as Annotation;
}

function annotation(partial: Partial<Annotation>): Annotation {
  return { ...base(), ...partial };
}

/** Deterministic fake range over explicit rect literals. */
function fakeRange(rects: RectLike[]): RangeLike {
  return { getClientRects: () => rects };
}

const RECT_A = { left: 0, top: 0, right: 90, bottom: 10 };
const RECT_B = { left: 0, top: 10, right: 90, bottom: 20 };

describe('note hit targets: entry grouping', () => {
  it('keeps only text notes and merges multi-segment ranges under one id', () => {
    const anchor: Annotation['anchor'] = { format: 'markdown', quote: { exact: '', prefix: '', suffix: '' }, blockIndex: 1 };
    const painted = [
      { annotation: annotation({ id: 'h1', type: 'highlight', color: 'yellow', anchor }), range: fakeRange([RECT_A]) },
      { annotation: annotation({ id: 'n-multi', type: 'note', anchor }), range: fakeRange([RECT_A]) },
      { annotation: annotation({ id: 'loc', type: 'note', isLocationNote: true, anchor }), range: fakeRange([RECT_B]) },
      { annotation: annotation({ id: 'n-multi', type: 'note', anchor }), range: fakeRange([RECT_B]) },
    ];
    const entries = collectNoteEntries(painted);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.annotationId).toBe('n-multi');
    expect(entries[0]?.ranges).toHaveLength(2);
    expect(entries[0]?.selectedTextPreview).toBe('The reader engine');
  });

  it('drops entries whose ranges produced no usable fragments', () => {
    const anchor: Annotation['anchor'] = { format: 'markdown', quote: { exact: '', prefix: '', suffix: '' }, blockIndex: 1 };
    const entries = collectNoteEntries([
      { annotation: annotation({ id: 'blank', type: 'note', anchor }), range: fakeRange([]) },
    ] as never);
    expect(entries).toHaveLength(0);
  });
});

describe('note hit targets: deterministic picking', () => {
  const entry = (id: string, ranges: RangeLike[]): NotePointerEntry => ({
    annotationId: id,
    selectedTextPreview: 'untrusted document text',
    ranges,
  });

  it('resolves the smallest containing rect and breaks ties by order', () => {
    const entries = [
      entry('wide', [fakeRange([{ left: 0, top: 0, right: 100, bottom: 20 }])]),
      entry('line', [fakeRange([RECT_A]), fakeRange([RECT_B])]),
    ];
    expect(pickNoteAtPoint(entries, 50, 5)?.annotationId).toBe('line');
    expect(pickNoteAtPoint(entries, 50, 15)?.annotationId).toBe('line');
    expect(pickNoteAtPoint(entries, 150, 5)).toBeNull();
    expect(pickNoteAtPoint(entries, 20, 10)?.rect).toEqual(RECT_A);
  });

  it('tolerates one pixel of slack at exact boundaries', () => {
    const entries = [entry('edge', [fakeRange([RECT_A])])];
    expect(pickNoteAtPoint(entries, 90, 10)).not.toBeNull();
    expect(pickNoteAtPoint(entries, 92, 10)).toBeNull();
    expect(pickNoteAtPoint(entries, 1, -1)).not.toBeNull();
  });
});

describe('note hit targets: surface registry', () => {
  const ownerA = {};
  const ownerB = {};

  function paintTop(owner: object, doc: Document, ids: string[]): void {
    notePointerPaint(owner, doc, ids.map((id) => ({
      annotation: annotation({ id, type: 'note' }),
      range: fakeRange([RECT_A, RECT_B]),
    })));
  }

  function paintIframe(owner: object, doc: Document, id: string): void {
    notePointerPaint(owner, doc, [
      { annotation: annotation({ id, type: 'note' }), range: fakeRange([{ left: 10, top: 10, right: 60, bottom: 20 }]) },
    ], {
      toTopClientRect: (rect) => ({
        left: 100 + rect.left,
        top: 200 + rect.top,
        right: 100 + rect.right,
        bottom: 200 + rect.bottom,
      }),
    });
  }

  function fakeDoc(): Document {
    return document.implementation.createHTMLDocument('surface');
  }

  it('paints per owner+document and detaches sibling documents of the same owner', () => {
    resetNotePointer();
    const topDoc = document;
    const sectionOne = fakeDoc();
    const sectionTwo = fakeDoc();
    paintTop(ownerA, topDoc, ['md-1']);
    paintIframe(ownerB, sectionOne, 'epub-1');

    expect(getNotePointerSurfaces()).toHaveLength(2);
    const topSurface = getNotePointerSurfaces().find((s) => s.doc === topDoc);
    expect(topSurface?.entries[0]?.annotationId).toBe('md-1');

    // Section swap on the same owner replaces the painted document surface.
    paintIframe(ownerB, sectionTwo, 'epub-2');
    expect(getNotePointerSurfaces().some((s) => s.doc === sectionOne)).toBe(false);
    expect(getNotePointerSurfaces().some((s) => s.doc === sectionTwo)).toBe(true);

    notePointerDetachOwner(ownerB);
    expect(getNotePointerSurfaces().some((s) => s.doc === sectionTwo)).toBe(false);
    expect(getNotePointerSurfaces().some((s) => s.doc === topDoc)).toBe(true);

    paintIframe(ownerB, sectionOne, 'epub-3');
    notePointerDetachDoc(ownerB, sectionOne);
    expect(getNotePointerSurfaces()).toHaveLength(1);
    resetNotePointer();
    expect(getNotePointerSurfaces()).toHaveLength(0);
  });

  it('translates iframe-local rects to top-window coordinates for the popover', () => {
    resetNotePointer();
    const iframeDoc = fakeDoc();
    paintIframe(ownerA, iframeDoc, 'epub-zoom');
    const surface = getNotePointerSurfaces().find((s) => s.doc === iframeDoc);
    expect(surface).not.toBeNull();
    const hit = pickNoteAtSurfacePoint(surface!, 30, 15);
    expect(hit?.annotationId).toBe('epub-zoom');
    const topRect = (surface!).toTopClientRect(hit!.rect);
    expect(topRect.left).toBe(110);
    expect(topRect.top).toBe(210);
    resetNotePointer();
  });

  it('invalidates cached rects on layout invalidation and repaints bump the epoch', () => {
    resetNotePointer();
    const topDoc = document;
    paintTop(ownerA, topDoc, ['cache-1']);
    let surface: NotePointerSurface | null = getNotePointerSurfaces().find((s) => s.doc === topDoc) ?? null;
    const firstEpoch = surface!.epoch;
    expect(surface!.rectCache.size).toBe(0);

    // Hit-testing populates the cache.
    pickNoteAtSurfacePoint(surface!, 50, 5);
    expect(surface!.rectCache.size).toBeGreaterThan(0);

    // Paint bumps the epoch and drops the cache.
    paintTop(ownerA, topDoc, ['cache-1']);
    surface = getNotePointerSurfaces().find((s) => s.doc === topDoc) ?? null;
    expect(surface!.epoch).toBe(firstEpoch + 1);
    expect(surface!.rectCache.size).toBe(0);

    // Layout invalidation clears caches without repainting entries.
    pickNoteAtSurfacePoint(surface!, 50, 5);
    notePointerInvalidateLayout();
    expect(surface!.rectCache.size).toBe(0);
    expect(surface!.entries[0]?.annotationId).toBe('cache-1');
    resetNotePointer();
  });

  it('replaces stale entries on repaint so removed notes stop hit-testing', () => {
    resetNotePointer();
    const topDoc = document;
    paintTop(ownerA, topDoc, ['gone', 'kept']);
    let surface = getNotePointerSurfaces().find((s) => s.doc === topDoc) ?? null;
    expect(surface!.entries).toHaveLength(2);

    paintTop(ownerA, topDoc, ['kept']);
    surface = getNotePointerSurfaces().find((s) => s.doc === topDoc) ?? null;
    expect(surface!.entries).toHaveLength(1);
    expect(pickNoteAtSurfacePoint(surface!, 50, 5)?.annotationId).toBe('kept');
    resetNotePointer();
  });

  it('reconciles section swaps and reset after registry removal, before surface notification', () => {
    resetNotePointer();
    const owner = {};
    const sectionOne = fakeDoc();
    const sectionTwo = fakeDoc();
    const repaintEvents: { surface: NotePointerSurface; stillRegistered: boolean }[] = [];
    const surfaceEvents: number[] = [];
    const unsubscribeRepaints = subscribeNotePointerRepaints((surface) => {
      repaintEvents.push({
        surface,
        stillRegistered: getNotePointerSurfaces().includes(surface),
      });
    });
    const unsubscribeSurfaces = subscribeNotePointerSurfaces(() => {
      surfaceEvents.push(getNotePointerSurfaces().length);
    });
    try {
      paintIframe(owner, sectionOne, 'section-one');
      const firstSurface = getNotePointerSurfaces().find((surface) => surface.doc === sectionOne);
      expect(firstSurface).not.toBeUndefined();
      repaintEvents.length = 0;
      surfaceEvents.length = 0;

      // The old surface is removed before its repaint callback runs. This is
      // the ordering that lets an open popover close synchronously on swaps.
      paintIframe(owner, sectionTwo, 'section-two');
      expect(repaintEvents[0]?.surface).toBe(firstSurface);
      expect(repaintEvents[0]?.stillRegistered).toBe(false);
      expect(surfaceEvents).toEqual([1]);

      const secondSurface = getNotePointerSurfaces().find((surface) => surface.doc === sectionTwo);
      expect(secondSurface).not.toBeUndefined();
      repaintEvents.length = 0;
      surfaceEvents.length = 0;

      // Reset uses the same removal-before-repaint contract and emits one
      // surface notification for the now-empty registry.
      resetNotePointer();
      expect(repaintEvents).toHaveLength(1);
      expect(repaintEvents[0]?.surface).toBe(secondSurface);
      expect(repaintEvents[0]?.stillRegistered).toBe(false);
      expect(surfaceEvents).toEqual([0]);
    } finally {
      unsubscribeRepaints();
      unsubscribeSurfaces();
      resetNotePointer();
    }
  });
});
