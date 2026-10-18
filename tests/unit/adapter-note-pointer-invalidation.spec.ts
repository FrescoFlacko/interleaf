// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import { DocxAdapter } from '../../src/renderer/features/reader/adapters/docx-adapter';
import { EpubAdapter } from '../../src/renderer/features/reader/adapters/epub-adapter';
import { MobiAdapter } from '../../src/renderer/features/reader/adapters/mobi-adapter';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import type { Annotation } from '../../src/shared/types/annotation';
import {
  getNotePointerSurfaces,
  notePointerPaint,
  pickNoteAtSurfacePoint,
  resetNotePointer,
  type RangeLike,
  type RectLike,
} from '../../src/renderer/features/reader/annotations/note-pointer';
import { testReflowOptions } from '../helpers/document-source';

/**
 * Adapters must invalidate cached note-pointer rect geometry whenever a
 * zoom or reflow setter mutates layout: typography/content changes move
 * painted fragment rects without resizing the surface root, so the root
 * ResizeObserver cannot fire. Each test warms the rect cache through a real
 * hit-test, runs the setter, and proves the cache was dropped (and remains
 * functional for the next hit-test).
 */

const RECT = { left: 0, top: 0, right: 90, bottom: 10 };
const fakeRange = (rects: RectLike[]): RangeLike => ({ getClientRects: () => rects });

function annotation(id: string): Annotation {
  return {
    id,
    documentId: 'doc-1',
    type: 'note',
    color: 'yellow',
    status: 'anchored',
    anchor: { format: 'markdown', quote: { exact: 'x', prefix: '', suffix: '' }, blockIndex: 1 },
    selectedText: 'The reader engine',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  } as Annotation;
}

function paintAndWarm(): number {
  const owner = {};
  notePointerPaint(owner, document, [{ annotation: annotation('n1'), range: fakeRange([RECT]) }]);
  const surface = getNotePointerSurfaces()[0];
  if (surface === undefined) throw new Error('surface missing');
  pickNoteAtSurfacePoint(surface, 10, 5);
  return surface.rectCache.size;
}

function cacheSize(): number {
  return getNotePointerSurfaces()[0]?.rectCache.size ?? -1;
}

describe('adapter layout setters invalidate the note-pointer rect cache', () => {
  afterEach(() => {
    resetNotePointer();
  });

  it('MarkdownAdapter.setZoom drops cached rects and stays hittable', () => {
    const adapter = new MarkdownAdapter();
    expect(paintAndWarm()).toBe(1);
    return adapter.setZoom(1.5).then(() => {
      expect(cacheSize()).toBe(0);
      const surface = getNotePointerSurfaces()[0]!;
      pickNoteAtSurfacePoint(surface, 10, 5);
      expect(surface.rectCache.size).toBe(1);
    });
  });

  it('MarkdownAdapter.setReflowOptions drops cached rects', () => {
    const adapter = new MarkdownAdapter();
    expect(paintAndWarm()).toBe(1);
    return adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.9, horizontalMarginRem: 2.5 })).then(() => {
      expect(cacheSize()).toBe(0);
    });
  });

  it('DocxAdapter.setZoom drops cached rects and stays hittable', () => {
    const adapter = new DocxAdapter(() =>
      Promise.reject(new Error('parse not used by layout setters'))
    );
    expect(paintAndWarm()).toBe(1);
    return adapter.setZoom(1.5).then(() => {
      expect(cacheSize()).toBe(0);
      const surface = getNotePointerSurfaces()[0]!;
      pickNoteAtSurfacePoint(surface, 10, 5);
      expect(surface.rectCache.size).toBe(1);
    });
  });

  it('DocxAdapter.setReflowOptions drops cached rects', () => {
    const adapter = new DocxAdapter(() =>
      Promise.reject(new Error('parse not used by layout setters'))
    );
    expect(paintAndWarm()).toBe(1);
    return adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.9, horizontalMarginRem: 2.5 })).then(() => {
      expect(cacheSize()).toBe(0);
    });
  });

  it('PdfAdapter.setZoom drops cached rects and stays hittable', async () => {
    const adapter = new PdfAdapter();
    expect(paintAndWarm()).toBe(1);
    await adapter.setZoom(1.5);
    expect(cacheSize()).toBe(0);
    const surface = getNotePointerSurfaces()[0]!;
    expect(pickNoteAtSurfacePoint(surface, 10, 5)?.annotationId).toBe('n1');
    expect(surface.rectCache.size).toBe(1);
  });

  it('EpubAdapter.setZoom drops cached rects and stays hittable', () => {
    const adapter = new EpubAdapter();
    expect(paintAndWarm()).toBe(1);
    return adapter.setZoom(1.5).then(() => {
      expect(cacheSize()).toBe(0);
      const surface = getNotePointerSurfaces()[0]!;
      pickNoteAtSurfacePoint(surface, 10, 5);
      expect(surface.rectCache.size).toBe(1);
    });
  });

  it('EpubAdapter.setReflowOptions drops cached rects', () => {
    const adapter = new EpubAdapter();
    expect(paintAndWarm()).toBe(1);
    return adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.9, horizontalMarginRem: 2.5 })).then(() => {
      expect(cacheSize()).toBe(0);
    });
  });

  it('MobiAdapter inherited setZoom drops cached rects and stays hittable', async () => {
    const adapter = new MobiAdapter();
    expect(paintAndWarm()).toBe(1);
    await adapter.setZoom(1.5);
    expect(cacheSize()).toBe(0);
    const surface = getNotePointerSurfaces()[0]!;
    expect(pickNoteAtSurfacePoint(surface, 10, 5)?.annotationId).toBe('n1');
    expect(surface.rectCache.size).toBe(1);
  });

  it('MobiAdapter inherited setReflowOptions drops cached rects', async () => {
    const adapter = new MobiAdapter();
    expect(paintAndWarm()).toBe(1);
    await adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.9, horizontalMarginRem: 2.5 }));
    expect(cacheSize()).toBe(0);
  });
});
