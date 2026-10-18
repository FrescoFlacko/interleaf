// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { EpubAdapter } from '../../src/renderer/features/reader/adapters/epub-adapter';
import { inflateZipArchive } from '../../src/renderer/features/reader/adapters/foliate/zip-inflate-core';
import { makeEpubFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { TestCanvasContext } from '../helpers/canvas-context';
import { testDocumentSource } from '../helpers/document-source';

describe('Reader Adapter Performance & Scalability (Phase 11)', () => {
  const activeContainers: HTMLElement[] = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalWorker = globalThis.Worker;

  let capturedObserverCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null;
  const observedWrappers = new Set<Element>();

  beforeEach(() => {
    capturedObserverCallback = null;
    observedWrappers.clear();

    // Mock IntersectionObserver to capture production callbacks from PdfAdapter
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '600px 0px 600px 0px';
      readonly scrollMargin = '0px 0px 0px 0px';
      readonly thresholds: readonly number[] = [0.01];

      constructor(callback: IntersectionObserverCallback) {
        // The test drives the callback directly and never inspects the observer
        // argument, so the capture hands this instance back for it.
        capturedObserverCallback = (entries) => { callback(entries, this); };
      }

      observe(target: Element): void {
        observedWrappers.add(target);
      }

      unobserve(target: Element): void {
        observedWrappers.delete(target);
      }

      disconnect(): void {
        observedWrappers.clear();
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    globalThis.IntersectionObserver = MockIntersectionObserver;
    // Provide a 2D canvas context mock for jsdom environment
    const getContextMock = function (this: HTMLCanvasElement, contextId: string): CanvasRenderingContext2D | null {
      return contextId === '2d' ? new TestCanvasContext(this) : null;
    };
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContextMock });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContextMock });
    }

    // Provide realistic bounding box geometry for PDF pages in jsdom
    Element.prototype.getBoundingClientRect = function () {
      const pageNumAttr = this.getAttribute('data-page-number');
      if (pageNumAttr) {
        const pageNum = Number(pageNumAttr);
        const scroller = this.closest('.pdf-viewer-scroll-container');
        const scrollTop = scroller?.scrollTop ?? 0;
        const top = (pageNum - 1) * 800 - scrollTop;
        return {
          top,
          bottom: top + 792,
          left: 0,
          right: 612,
          width: 612,
          height: 792,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      }
      if (
        this.classList.contains('pdf-viewer-scroll-container') ||
        this.getAttribute('data-testid') === 'pdf-scroll-container'
      ) {
        return {
          top: 0,
          bottom: 600,
          left: 0,
          right: 800,
          width: 800,
          height: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      }
      return {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    };
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.IntersectionObserver = originalIntersectionObserver;
    globalThis.Worker = originalWorker;

    for (const container of activeContainers) {
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
    }
    activeContainers.length = 0;
  });

  it('PdfAdapter enforces automatic visibility-driven render and teardown across a 50-page PDF with bounded resident canvases', async () => {
    // Generate a 50-page PDF fixture
    const pages = Array.from({ length: 50 }, (_, idx) =>
      `Chapter ${String(idx + 1)}: Scalable systems proof and bounded memory invariants for page ${String(idx + 1)}.`
    );
    const pdfBinary = makePdfFixture({
      title: '50-Page Scalable Systems Architecture',
      author: 'Principal Architect',
      pages,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    activeContainers.push(container);

    const adapter = new PdfAdapter();
    const dataUrl = `data:application/pdf;base64,${pdfBinary.toString('base64')}`;

    await adapter.open(container, testDocumentSource({
      documentId: 'doc-pdf-perf-50',
      assetUrl: dataUrl,
    }));
    try {
      expect(adapter.getPageCount()).toBe(50);
      expect(adapter.getCurrentPage()).toBe(1);
      expect(observedWrappers.size).toBe(50);
      expect(capturedObserverCallback).not.toBeNull();

      // Helper to trigger the real production IntersectionObserver callback
      const triggerVisibility = (updates: { page: number; isIntersecting: boolean }[]) => {
        const entering = updates.find((u) => u.isIntersecting && u.page > 2);
        if (entering) {
          const scroller = container.querySelector('.pdf-viewer-scroll-container');
          if (scroller) {
            scroller.scrollTop = (entering.page - 1) * 800;
          }
        }
        const entries = updates.map(({ page, isIntersecting }) => {
          const target = container.querySelector(`[data-page-number="${String(page)}"]`);
          if (!target) throw new Error(`Target page ${String(page)} placeholder not found`);
          return {
            target,
            isIntersecting,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: container.getBoundingClientRect(),
          } as IntersectionObserverEntry;
        });
        capturedObserverCallback!(entries);
      };

      // 2. Initial state: wait for viewport-near pages (Pages 1 & 2) to render
      await waitFor(() => {
        expect(container.querySelectorAll('canvas').length).toBe(2);
      }, { timeout: 3000 });

      const page1Wrapper = container.querySelector('[data-page-number="1"]');
      const page2Wrapper = container.querySelector('[data-page-number="2"]');
      const page25Wrapper = container.querySelector('[data-page-number="25"]');
      const page50Wrapper = container.querySelector('[data-page-number="50"]');
      expect(page1Wrapper?.querySelector('canvas')).not.toBeNull();
      expect(page2Wrapper?.querySelector('canvas')).not.toBeNull();
      expect(page25Wrapper?.querySelector('canvas')).toBeNull();
      expect(page50Wrapper?.querySelector('canvas')).toBeNull();

      // 3. Drive viewport scroll to distant Page 25 & 26: Pages 1 & 2 exit, Pages 25 & 26 enter
      triggerVisibility([
        { page: 1, isIntersecting: false },
        { page: 2, isIntersecting: false },
        { page: 25, isIntersecting: true },
        { page: 26, isIntersecting: true },
      ]);

      // Assert automatic production teardown & render via waitFor
      await waitFor(() => {
        expect(page1Wrapper?.querySelector('canvas')).toBeNull();
        expect(page2Wrapper?.querySelector('canvas')).toBeNull();
        expect(page25Wrapper?.querySelector('canvas')).not.toBeNull();
        expect(container.querySelector('[data-page-number="26"]')?.querySelector('canvas')).not.toBeNull();
        expect(container.querySelectorAll('canvas').length).toBe(2);
      }, { timeout: 3000 });

      // Invariant: Resident canvas count across all 50 pages is strictly bounded (<= 2)
      expect(container.querySelectorAll('canvas').length).toBe(2);

      // Search matches are extracted on-demand across all 50 pages without rendering all canvases
      const matches = await adapter.search('invariants');
      expect(matches.length).toBe(50);
      expect(matches[0]?.location.format).toBe('pdf');
    } finally {
      await adapter.close();
      expect(observedWrappers.size).toBe(0);
    }
  });

  it('EpubAdapter exercises the production worker boundary and mounts/unmounts active sections lazily over a 30-chapter EPUB', async () => {
    let workerSpawnCount = 0;
    let workerTerminated = false;

    // Production worker mock compatible with ZipInflateWorker
    class MockZipInflateWorker extends EventTarget implements Worker {
      onmessage: ((this: Worker, event: MessageEvent) => void) | null = null;
      onmessageerror: ((this: Worker, event: MessageEvent) => void) | null = null;
      onerror: ((this: AbstractWorker, event: ErrorEvent) => void) | null = null;

      constructor() {
        super();
        workerSpawnCount += 1;
      }

      postMessage(data: { bytes: Uint8Array }): void {
        setTimeout(() => {
          if (workerTerminated) return;
          try {
            const entries = inflateZipArchive(data.bytes);
            this.onmessage?.call(this, new MessageEvent('message', { data: { ok: true, entries } }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onmessage?.call(this, new MessageEvent('message', { data: { ok: false, message } }));
          }
        }, 10);
      }

      terminate(): void {
        workerTerminated = true;
      }
    }
    globalThis.Worker = MockZipInflateWorker;

    // Generate a 30-chapter EPUB archive
    const chapters = Array.from({ length: 30 }, (_, idx) => ({
      title: `Chapter ${String(idx + 1)}: Consensus Protocol Part ${String(idx + 1)}`,
      content: `<p>Detailed discussion of Paxos and Raft consensus algorithms in chapter ${String(idx + 1)}.</p>`,
    }));

    const epubBinary = makeEpubFixture({
      title: 'Distributed Consensus Compendium',
      author: 'Leslie Lamport',
      chapters,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    activeContainers.push(container);

    // Instantiate with default production worker boundary (no inflate override!)
    const adapter = new EpubAdapter();
    const dataUrl = `data:application/epub+zip;base64,${epubBinary.toString('base64')}`;

    await adapter.open(container, testDocumentSource({
      documentId: 'doc-epub-perf-30',
      assetUrl: dataUrl,
    }));

    try {
      expect(adapter.format).toBe('epub');
      expect(adapter.getPageCount()).toBe(30);
      expect(adapter.getCurrentPage()).toBe(1);

      // Verify production worker was spawned to inflate the archive
      expect(workerSpawnCount).toBeGreaterThanOrEqual(1);

      // Table of contents outline extracts all 30 chapter entries lazily
      const toc = await adapter.getTableOfContents();
      expect(toc.length).toBe(30);
      expect(toc[0]?.title).toContain('Chapter 1');
      expect(toc[29]?.title).toContain('Chapter 30');

      // 1. Initial mounted state: active section iframe is mounted for Chapter 1
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.srcdoc).toContain('Consensus Protocol Part 1');

      // 2. Navigate to Chapter 20
      await adapter.goToPage(20);
      expect(adapter.getCurrentPage()).toBe(20);
      expect(adapter.getProgress()).toBeGreaterThan(0.6);
      expect(adapter.getProgress()).toBeLessThan(0.75);

      // Active section iframe now reflects Chapter 20 (previous chapter is unmounted)
      expect(iframe?.srcdoc).toContain('Consensus Protocol Part 20');
      expect(iframe?.srcdoc).not.toContain('Consensus Protocol Part 1');

      // 3. Extract text chunk generator yields bounded chunks incrementally
      let chunkCount = 0;
      for await (const chunk of adapter.extractText()) {
        chunkCount += 1;
        expect(chunk.tokenCount).toBeGreaterThan(0);
        expect(chunk.tokenCount).toBeLessThan(1000);
      }
      expect(chunkCount).toBe(30);
    } finally {
      await adapter.close();
      expect(workerTerminated).toBe(true);
    }
  });
});
