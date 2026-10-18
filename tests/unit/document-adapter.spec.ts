// @vitest-environment jsdom
import * as pdfjsLib from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { createDocumentAdapter } from '../../src/renderer/features/reader/adapters/adapter-factory';
import { EpubAdapter } from '../../src/renderer/features/reader/adapters/epub-adapter';
import { DocxAdapter } from '../../src/renderer/features/reader/adapters/docx-adapter';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import { parseMobiArchive } from '../../src/renderer/features/reader/adapters/foliate/mobi-parse-core';
import { inflateZipArchive } from '../../src/renderer/features/reader/adapters/foliate/zip-inflate-core';
import { MobiAdapter } from '../../src/renderer/features/reader/adapters/mobi-adapter';
import {
  PDF_RENDER_LIMITS,
  PdfAdapter,
  safeCanvasScale,
  safePageScale,
} from '../../src/renderer/features/reader/adapters/pdf-adapter';
import {
  makeEpubFixture,
  makeKf8Fixture,
  makeMobiFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';
import { ProbePdfAdapter } from '../helpers/pdf-adapter-probe';
import { testIntersectionObserverEntry } from '../helpers/intersection-observer';
import { testDocumentSource } from '../helpers/document-source';

const parseMobiForTesting = (bytes: Uint8Array) =>
  parseMobiArchive(bytes, { includeResources: false });

/**
 * How a stubbed render task is settled as failed.
 *
 * pdf.js builds its exceptions on a `BaseException` whose prototype is an
 * `Error` at runtime, but whose declaration carries no `Error` members, so a
 * cancellation has to be named alongside `Error` rather than as one.
 */
type RenderRejection = Error | pdfjsLib.RenderingCancelledException;

const noopFn = (): void => undefined;

const pdfDataUrl = (binary: Buffer): string =>
  `data:application/pdf;base64,${binary.toString('base64')}`;

const rect = (top: number, left: number, width: number, height: number): DOMRect => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
  width,
  height,
  x: left,
  y: top,
  toJSON: noopFn,
});

const stubCanvasRenderingContext = (): {
  restore: () => void;
} => {
  const noop = noopFn;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: function (this: HTMLCanvasElement) {
      return {
        canvas: this,
        scale: noop,
        clearRect: noop,
        fillRect: noop,
        strokeRect: noop,
        save: noop,
        restore: noop,
        translate: noop,
        transform: noop,
        setTransform: noop,
        resetTransform: noop,
        getTransform: () => (typeof DOMMatrix !== 'undefined' ? new DOMMatrix() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        arc: noop,
        bezierCurveTo: noop,
        quadraticCurveTo: noop,
        rect: noop,
        fill: noop,
        stroke: noop,
        clip: noop,
        setLineDash: noop,
        getLineDash: () => [],
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: noop,
        drawImage: noop,
        fillText: noop,
        strokeText: noop,
        measureText: () => ({ width: 10 }),
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        globalAlpha: 1,
      };
    },
  });
  return {
    restore: () => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: originalGetContext,
      });
    },
  };
};

const installMockResizeObserver = (): {
  capturedCallback: { current: ResizeObserverCallback | null };
  fire: () => void;
  restore: () => void;
} => {
  const capturedCallback: { current: ResizeObserverCallback | null } = { current: null };
  const OriginalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class MockResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      capturedCallback.current ??= callback;
    }
    observe = noopFn;
    unobserve = noopFn;
    disconnect = noopFn;
  };
  return {
    capturedCallback,
    fire: () => {
      capturedCallback.current?.([], new globalThis.ResizeObserver(noopFn));
    },
    restore: () => {
      globalThis.ResizeObserver = OriginalResizeObserver;
    },
  };
};

/** Captures the adapter's IntersectionObserver so a test can deliver entries by hand. */
const installMockIntersectionObserver = (): {
  deliver: (target: Element, isIntersecting: boolean) => void;
  restore: () => void;
} => {
  let capturedCallback: IntersectionObserverCallback | null = null;
  const OriginalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class MockIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly scrollMargin = '0px 0px 0px 0px';
    readonly thresholds = [];
    constructor(callback: IntersectionObserverCallback) {
      capturedCallback ??= callback;
    }
    observe = noopFn;
    unobserve = noopFn;
    disconnect = noopFn;
    takeRecords = (): IntersectionObserverEntry[] => [];
  };
  return {
    deliver: (target, isIntersecting) => {
      // Read through a function: TS cannot see the constructor-time assignment.
      const readCallback = (): IntersectionObserverCallback | null => capturedCallback;
      const callback = readCallback();
      expect(callback).not.toBeNull();
      callback!(
        [testIntersectionObserverEntry({ target, isIntersecting, time: Date.now() })],
        new globalThis.IntersectionObserver(noopFn)
      );
    },
    restore: () => {
      globalThis.IntersectionObserver = OriginalIntersectionObserver;
    },
  };
};

/**
 * Holds every render of `pageNum` open until the test settles it, while the
 * real pdf.js task runs underneath so cancellation reaches the worker.
 */
const gatePageRender = (
  adapter: ProbePdfAdapter,
  pageNum: number
): {
  started: Promise<void>;
  settle: (err?: RenderRejection) => void;
  cancelCalled: () => boolean;
} => {
  const originalGetPage = adapter.document.getPage.bind(adapter.document);
  let settleRender: ((err?: RenderRejection) => void) | null = null;
  let notifyStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let cancelCalled = false;
  adapter.document.getPage = async function (requested: number) {
    const page = await originalGetPage(requested);
    if (requested === pageNum) {
      const originalRender = page.render.bind(page);
      page.render = function (params: Parameters<typeof originalRender>[0]) {
        const realTask = originalRender(params);
        realTask.promise.catch(noopFn);
        const delayedPromise = new Promise<void>((resolve, reject) => {
          settleRender = (err?: RenderRejection) => {
            if (err instanceof Error) {
              reject(err);
            } else {
              resolve();
            }
          };
        });
        notifyStarted?.();
        return {
          promise: delayedPromise,
          cancel: () => {
            cancelCalled = true;
            try {
              realTask.cancel();
            } catch {
              // Ignored
            }
          },
        } as pdfjsLib.RenderTask;
      };
    }
    return page;
  };
  return {
    started,
    settle: (err) => {
      // Read through a function: TS cannot see the assignment inside render.
      const readSettle = (): ((err?: RenderRejection) => void) | null => settleRender;
      const settleNow = readSettle();
      expect(settleNow).not.toBeNull();
      settleNow!(err);
    },
    cancelCalled: () => cancelCalled,
  };
};

const waitForTextLayer = async (wrapper: HTMLElement | null, pageNum: number): Promise<void> => {
  for (let i = 0; i < 50 && !wrapper?.querySelector(`[data-testid="pdf-textlayer-p${String(pageNum)}"]`); i++) {
    await new Promise<void>((r) => {
      window.setTimeout(r, 10);
    });
  }
};

const nextAnimationFrame = (): Promise<void> =>
  new Promise<void>((r) => {
    window.requestAnimationFrame(() => {
      r();
    });
  });

type FrameAndTimerControls = {
  rafScheduleCount: () => number;
  flushFrames: () => void;
  flushTimeouts: () => void;
  realSleep: (ms: number) => Promise<void>;
  restore: () => void;
};

/**
 * Routes window.requestAnimationFrame / setTimeout through controllable
 * queues so a ResizeObserver burst can be delivered multiple times inside
 * one logical frame and the quiet-period commit drained deterministically.
 */
const captureFrameAndTimerScheduling = (): FrameAndTimerControls => {
  const originalRaf = window.requestAnimationFrame.bind(window);
  const originalCaf = window.cancelAnimationFrame.bind(window);
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);

  let nextFrameId = 1;
  let scheduledFrames = 0;
  const cancelledFrameIds = new Set<number>();
  const frameQueue: (() => void)[] = [];
  type RecordedTimeout = {
    id: number;
    run: () => void;
  };
  let nextTimeoutId = 1;
  const timeoutQueue: RecordedTimeout[] = [];

  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      scheduledFrames += 1;
      const id = nextFrameId++;
      frameQueue.push(() => {
        if (!cancelledFrameIds.delete(id)) callback(0);
      });
      return id;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number): void => {
      cancelledFrameIds.add(handle);
    },
  });
  Object.defineProperty(window, 'setTimeout', {
    configurable: true,
    // Every timer the adapters under test schedule is a closure with no
    // forwarded arguments, so that is the arity this stub declares and runs.
    // The delay a caller passes is ignored rather than accepted: this queue
    // is drained explicitly by the test, never by elapsed time.
    value: (handler: () => void): number => {
      const id = nextTimeoutId++;
      timeoutQueue.push({
        id,
        run: () => {
          handler();
        },
      });
      return id;
    },
  });
  Object.defineProperty(window, 'clearTimeout', {
    configurable: true,
    value: (handle?: number): void => {
      if (typeof handle !== 'number') return;
      const index = timeoutQueue.findIndex((entry) => entry.id === handle);
      if (index >= 0) timeoutQueue.splice(index, 1);
    },
  });

  return {
    rafScheduleCount: () => scheduledFrames,
    flushFrames: () => {
      while (frameQueue.length > 0) {
        for (const runFrame of frameQueue.splice(0)) runFrame();
      }
    },
    flushTimeouts: () => {
      let guard = 0;
      while (timeoutQueue.length > 0 && guard++ < 50) {
        for (const entry of timeoutQueue.splice(0)) entry.run();
      }
    },
    realSleep: (ms: number) =>
      new Promise<void>((resolve) => {
        originalSetTimeout(resolve, ms);
      }),
    restore: () => {
      Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: originalRaf });
      Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: originalCaf });
      Object.defineProperty(window, 'setTimeout', { configurable: true, value: originalSetTimeout });
      Object.defineProperty(window, 'clearTimeout', { configurable: true, value: originalClearTimeout });
    },
  };
};

const setContainerSize = (container: HTMLElement, width: number, height: number): void => {
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: height });
};

const pumpAsync = async (controls: FrameAndTimerControls, cycles = 4): Promise<void> => {
  for (let i = 0; i < cycles; i++) {
    controls.flushFrames();
    controls.flushTimeouts();
    await Promise.resolve();
    await Promise.resolve();
    await controls.realSleep(6);
  }
  controls.flushFrames();
  controls.flushTimeouts();
};

const waitForFirstCanvas = async (
  container: HTMLElement,
  controls: FrameAndTimerControls,
  painted: ReadonlySet<number>
): Promise<HTMLCanvasElement> => {
  let canvas: HTMLCanvasElement | null = null;
  for (let i = 0; i < 400 && canvas === null; i++) {
    controls.flushFrames();
    controls.flushTimeouts();
    canvas = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
    // Canvas presence alone is ambiguous mid-flight (first paint attaches
    // provisionally); bookkeeping plus a built text layer mark completion.
    if (canvas === null || !painted.has(1)) {
      canvas = null;
      await Promise.resolve();
      await Promise.resolve();
      await controls.realSleep(5);
    }
  }
  if (canvas === null) throw new Error('initial PDF canvas did not render');
  return canvas;
};

describe('DocumentAdapter Contract & Adapters (ADR-0002)', () => {
  it('creates correct adapter instances via factory', () => {
    for (const [format, AdapterClass] of [
      ['pdf', PdfAdapter],
      ['epub', EpubAdapter],
      ['mobi', MobiAdapter],
      ['docx', DocxAdapter],
      ['markdown', MarkdownAdapter],
    ] as const) {
      const adapter = createDocumentAdapter(format);
      expect(adapter).toBeInstanceOf(AdapterClass);
      expect(adapter.format).toBe(format);
    }
  });

  it('initializes and renders multi-page PDF, extracting TOC outline and search matches', async () => {
    const pdfBinary = makePdfFixture({
      title: 'Advanced System Architecture',
      author: 'Martin Fowler',
      pages: [
        'Chapter 1: Microservices and Modular Monoliths. Decoupling systems requires careful boundary definition.',
        'Chapter 2: Event-Driven Architectures. Message brokers and event sourcing provide reactive foundations.',
        'Chapter 3: Reliability and Resiliency. Circuit breakers and retries prevent cascading failures.',
      ],
      outline: [
        { title: 'Chapter 1: Microservices', targetPage: 1 },
        { title: 'Chapter 2: Event-Driven', targetPage: 2 },
        { title: 'Chapter 3: Reliability', targetPage: 3 },
      ],
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    const dataUrl = pdfDataUrl(pdfBinary);
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-pdf-1',
      assetUrl: dataUrl,
    }));

    expect(adapter.getPageCount()).toBe(3);
    expect(adapter.getCurrentPage()).toBe(1);
    expect(adapter.getProgress()).toBe(1 / 3);

    const toc = await adapter.getTableOfContents();
    expect(toc).toHaveLength(3);
    expect(toc[0]!.title).toBe('Chapter 1: Microservices');
    expect(toc[0]!.location).toEqual({ format: 'pdf', pageIndex: 0 });
    expect(toc[1]!.title).toBe('Chapter 2: Event-Driven');
    expect(toc[1]!.location).toEqual({ format: 'pdf', pageIndex: 1 });

    const searchMatches = await adapter.search('Event');
    expect(searchMatches.length).toBeGreaterThan(0);
    expect(searchMatches[0]!.location.format).toBe('pdf');

    const chunks: { text: string; ordinal: number }[] = [];
    for await (const chunk of adapter.extractText()) {
      chunks.push({ text: chunk.text, ordinal: chunk.ordinal });
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toContain('Microservices');

    await adapter.goToPage(2);
    expect(adapter.getCurrentPage()).toBe(2);

    const removedPage = await adapter.setAnnotations([{
      id: 'removed-page',
      documentId: 'doc-pdf-1',
      documentHash: 'older-hash',
      type: 'bookmark',
      anchor: { format: 'pdf', pageIndex: 99, quote: { exact: '', prefix: '', suffix: '' } },
      selectedText: null,
      note: null,
      label: null,
      color: null,
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }]);
    expect(removedPage).toEqual([expect.objectContaining({
      annotationId: 'removed-page',
      status: 'unanchored',
      stage: 'unanchored',
    })]);

    await adapter.setZoom(1.5);
    expect(adapter.getZoom()).toBe(1.5);
    expect(adapter.getZoomMode()).toBe('custom');

    await adapter.close();
    document.body.removeChild(container);
  });

  it('bounds hostile PDF page geometry and never wires embedded actions or annotations', async () => {
    const actionMarker = '__interleafPdfActionExecuted';
    Object.defineProperty(window, actionMarker, {
      value: false,
      writable: true,
      configurable: true,
    });

    const pdfBinary = makePdfFixture({
      embeddedJavaScript: `window.${actionMarker} = true;`,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    const dataUrl = pdfDataUrl(pdfBinary);
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-pdf-hostile',
      assetUrl: dataUrl,
    }));

    await adapter.setZoom(5);
    adapter.discardPageContent(1);
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    await adapter.repaintPage(1);

    const wrapper = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
    expect(Number.parseFloat(wrapper!.style.width)).toBeLessThanOrEqual(
      PDF_RENDER_LIMITS.maxPageCssDimension
    );
    expect(Number.parseFloat(wrapper!.style.height)).toBeLessThanOrEqual(
      PDF_RENDER_LIMITS.maxPageCssDimension
    );

    const pageScale = safePageScale(100_000, 100_000, 5);
    const cssWidth = 100_000 * pageScale;
    const cssHeight = 100_000 * pageScale;
    const canvasScale = safeCanvasScale(cssWidth, cssHeight, 2);
    const canvasWidth = Math.floor(cssWidth * canvasScale);
    const canvasHeight = Math.floor(cssHeight * canvasScale);

    expect(canvasWidth).toBeLessThanOrEqual(PDF_RENDER_LIMITS.maxCanvasDimension);
    expect(canvasHeight).toBeLessThanOrEqual(PDF_RENDER_LIMITS.maxCanvasDimension);
    expect(canvasWidth * canvasHeight).toBeLessThanOrEqual(
      PDF_RENDER_LIMITS.maxCanvasPixels
    );
    expect(container.querySelector('.annotationLayer')).toBeNull();
    expect(window.__interleafPdfActionExecuted).toBe(false);

    await adapter.close();
    document.body.removeChild(container);
    Reflect.deleteProperty(window, actionMarker);
  });
  it('preserves newer render canvas and text layer when a stale/canceled render attempt settles late', async () => {
    const noop = noopFn;
    const ctxStub = stubCanvasRenderingContext();
    const pdfBinary = makePdfFixture({
      title: 'Cancellation Race Regression PDF',
      pages: [
        'Page 1: Deep distributed systems verification and cancellation race proof.',
        'Page 2: Resilient state machine replication.',
      ],
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-race',
        assetUrl: pdfDataUrl(pdfBinary),
      }));

      const originalGetPage = adapter.document.getPage.bind(adapter.document);

      let renderCallCount = 0;
      let settleRenderA: ((err?: RenderRejection) => void) | null = null;
      let notifyRenderAStarted: (() => void) | null = null;
      const renderAStarted = new Promise<void>((resolve) => {
        notifyRenderAStarted = resolve;
      });
      let notifyRenderBFinished: (() => void) | null = null;
      const renderBFinished = new Promise<void>((resolve) => {
        notifyRenderBFinished = resolve;
      });
      const wrappedPages = new WeakSet<object>();
      adapter.document.getPage = async function (pageNum: number) {
        const page = await originalGetPage(pageNum);
        if (pageNum === 1 && !wrappedPages.has(page)) {
          wrappedPages.add(page);
          const originalRender = page.render.bind(page);
          page.render = function (params: Parameters<typeof originalRender>[0]) {
            renderCallCount++;
            if (renderCallCount === 1) {
              const realTask = originalRender(params);
              realTask.promise.catch(noop);
              const delayedPromise = new Promise<void>((resolve, reject) => {
                settleRenderA = (err?: RenderRejection) => {
                  // A pdf.js cancellation is an `Error` at runtime, so this
                  // rejects with the exception the adapter really sees.
                  if (err instanceof Error) {
                    reject(err);
                  } else if (err !== undefined) {
                    reject(new Error('Rendering cancelled'));
                  } else {
                    resolve();
                  }
                };
              });
              notifyRenderAStarted?.();
              return {
                promise: delayedPromise,
                cancel: () => {
                  try {
                    realTask.cancel();
                  } catch {
                    // Ignored
                  }
                },
              } as pdfjsLib.RenderTask;
            }
            const realTask = originalRender(params);
            void realTask.promise.then(() => {
              notifyRenderBFinished?.();
            });
            return realTask;
          };
        }
        return page;
      };

      adapter.discardPageContent(1);
      const renderAPromise = adapter.repaintPage(1);
      await renderAStarted;
      expect(renderCallCount).toBe(1);

      // Trigger Render B via setZoom, which cancels Render A and renders at scale 1.5
      await adapter.setZoom(1.5);
      await renderBFinished;
      expect(renderCallCount).toBe(2);

      // Wait for text layer of Render B to be created
      const wrapper = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      expect(wrapper).not.toBeNull();
      await waitForTextLayer(wrapper, 1);
      const canvasB = wrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(canvasB).not.toBeNull();
      const textLayerB = wrapper?.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      expect(textLayerB).not.toBeNull();

      expect(settleRenderA).not.toBeNull();
      settleRenderA!(new pdfjsLib.RenderingCancelledException('Rendering cancelled', 0));

      await renderAPromise;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 10);
      });

      const canvasAfter = wrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      const textLayerAfter = wrapper?.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      expect(canvasAfter).not.toBeNull();
      expect(textLayerAfter).not.toBeNull();
      expect(canvasAfter).toBe(canvasB);
      expect(textLayerAfter).toBe(textLayerB);
      expect(wrapper?.contains(canvasB!)).toBe(true);
      expect(wrapper?.contains(textLayerB!)).toBe(true);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      ctxStub.restore();
    }
  });

  it('does not cancel, recreate, or clear the canvas when fit-scale resize measurement is unchanged', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const pdfBinary = makePdfFixture({
      title: 'Stable Canvas Fit Test',
      pages: ['Page 1: Fit-width scale stability proof.'],
    });

    const container = document.createElement('div');
    setContainerSize(container, 1024, 768);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-fit-noop',
        assetUrl: pdfDataUrl(pdfBinary),
      }));

      const controls0 = captureFrameAndTimerScheduling();
      try {
        await waitForFirstCanvas(container, controls0, adapter.painted);
      } finally {
        controls0.restore();
      }

      const wrapper = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      expect(wrapper).not.toBeNull();
      const initialCanvas = wrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(initialCanvas).not.toBeNull();
      if (initialCanvas === null || initialCanvas === undefined) {
        throw new Error('expected the initial page canvas to be present');
      }
      const initialZoom = adapter.getZoom();

      expect(roMock.capturedCallback.current).not.toBeNull();
      roMock.fire();

      // Also directly invoke setZoom with identical fit mode
      await adapter.setZoom('fit-width');

      // Verify zoom is identical and the existing canvas was NOT replaced, cleared, or detached
      expect(adapter.getZoom()).toBe(initialZoom);
      const currentCanvas = wrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(currentCanvas).toBe(initialCanvas);
      expect(wrapper?.contains(initialCanvas)).toBe(true);

      // A duplicate/no-op ResizeObserver delivery must neither schedule a
      // commit nor bump the epoch, cancel in-flight work, or swap the canvas.
      const controls = captureFrameAndTimerScheduling();
      try {
        const epochBeforeNoOp = adapter.epoch;
        const scaleRecorded = adapter.paintedScales.get(1);
        expect(scaleRecorded).toBeDefined();

        roMock.fire();
        controls.flushFrames();
        expect(adapter.commitTimer).toBeNull();
        controls.flushTimeouts();
        await pumpAsync(controls);

        expect(adapter.epoch).toBe(epochBeforeNoOp);
        expect(adapter.previewedScales.size).toBe(0);
        expect(adapter.getZoom()).toBe(initialZoom);
        const canvasAfterNoOp = wrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
        expect(canvasAfterNoOp).toBe(initialCanvas);
        expect(canvasAfterNoOp?.isConnected).toBe(true);
        expect(canvasAfterNoOp?.style.transform).toBe('');
        expect(adapter.paintedScales.get(1)).toBe(scaleRecorded);
      } finally {
        controls.restore();
      }
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      roMock.restore();
      ctxStub.restore();
    }
  });

  it('preserves in-flight pending render when a stale false IntersectionObserver entry arrives and completes canvas and text layer without resize', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const pdfBinary = makePdfFixture({
      title: 'Pending IO Race Proof Guide',
      pages: [
        'Page 1: In-viewport live geometry content.',
        'Page 2: Middle content.',
      ],
    });

    const container = document.createElement('div');
    setContainerSize(container, 1000, 800);
    document.body.appendChild(container);
    const ioMock = installMockIntersectionObserver();
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-pending-io-race',
        assetUrl: pdfDataUrl(pdfBinary),
      }));

      const scrollContainer = container.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      expect(scrollContainer).not.toBeNull();
      scrollContainer!.getBoundingClientRect = () => rect(0, 0, 1000, 800);
      const wrapper1 = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      expect(wrapper1).not.toBeNull();
      wrapper1!.getBoundingClientRect = () => rect(24, 100, 800, 800);

      const gate = gatePageRender(adapter, 1);
      // Clear initial page 1 and start controlled pending render 1
      adapter.discardPageContent(1);
      const render1Promise = adapter.repaintPage(1);
      await gate.started;

      // Page 1 is now actively IN-FLIGHT / PENDING
      const inFlightCanvas = wrapper1?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(inFlightCanvas).not.toBeNull();
      expect(wrapper1?.contains(inFlightCanvas!)).toBe(true);

      // Deliver a stale `isIntersecting: false` entry for Page 1 while live geometry is near
      ioMock.deliver(wrapper1!, false);

      // Verify the pending render was NOT canceled and its canvas was NOT removed from wrapper
      expect(gate.cancelCalled()).toBe(false);
      expect(wrapper1?.contains(inFlightCanvas!)).toBe(true);

      // Now settle the pending render and allow text layer to complete
      gate.settle();
      await render1Promise;
      await waitForTextLayer(wrapper1, 1);

      // Assert Page 1 canvas and text layer are fully attached and completed without any later true event/resize
      const finalCanvas = wrapper1?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      const finalTextLayer = wrapper1?.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      expect(finalTextLayer).not.toBeNull();
      expect(finalCanvas).toBe(inFlightCanvas);
      expect(wrapper1?.contains(inFlightCanvas!)).toBe(true);
      expect(wrapper1?.contains(finalTextLayer!)).toBe(true);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      ioMock.restore();
      ctxStub.restore();
    }
  });

  it('preserves initial pending render when a false IO entry arrives with unsettled layout and geometry settles to near before next frame', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const pdfBinary = makePdfFixture({
      title: 'Unsettled Layout IO Proof Guide',
      pages: [
        'Page 1: Content rendered during initial unsettled mount.',
        'Page 2: Second page content.',
      ],
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const ioMock = installMockIntersectionObserver();
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-unsettled-io-race',
        assetUrl: pdfDataUrl(pdfBinary),
      }));

      const scrollContainer = container.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      expect(scrollContainer).not.toBeNull();
      const wrapper1 = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      expect(wrapper1).not.toBeNull();

      // Simulate initial unsettled layout state (0x0 or displaced offscreen rects)
      let layoutSettled = false;
      scrollContainer!.getBoundingClientRect = () =>
        layoutSettled ? rect(0, 0, 1000, 800) : rect(0, 0, 0, 0);
      wrapper1!.getBoundingClientRect = () =>
        layoutSettled ? rect(24, 100, 800, 800) : rect(0, 0, 0, 0);

      const gate = gatePageRender(adapter, 1);
      // Clear initial page 1 and start controlled pending render 1
      adapter.discardPageContent(1);
      const render1Promise = adapter.repaintPage(1);
      await gate.started;

      const inFlightCanvas = wrapper1?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(inFlightCanvas).not.toBeNull();

      // Deliver an initial false IO entry while geometry is unsettled (0x0)
      ioMock.deliver(wrapper1!, false);

      // Now layout settles to near before the next frame
      layoutSettled = true;
      await nextAnimationFrame();

      // Verify the in-flight render was NOT canceled
      expect(gate.cancelCalled()).toBe(false);
      expect(wrapper1?.contains(inFlightCanvas!)).toBe(true);

      // Settle the pending render
      gate.settle();
      await render1Promise;
      await waitForTextLayer(wrapper1, 1);

      // Assert Page 1 canvas and text layer complete and remain attached without any subsequent true IO event or resize
      const finalCanvas = wrapper1?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      const finalTextLayer = wrapper1?.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      expect(finalTextLayer).not.toBeNull();
      expect(finalCanvas).toBe(inFlightCanvas);
      expect(wrapper1?.contains(inFlightCanvas!)).toBe(true);
      expect(wrapper1?.contains(finalTextLayer!)).toBe(true);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      ioMock.restore();
      ctxStub.restore();
    }
  });

  it('cancels an in-flight pending render and tears down mounted content when a genuinely far page receives a false IntersectionObserver entry', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const pdfBinary = makePdfFixture({
      title: 'Far Page Teardown Proof Guide',
      pages: [
        'Page 1: In-viewport live geometry content.',
        'Page 2: Middle content.',
        'Page 3: Middle content.',
        'Page 4: Genuinely far offscreen content.',
      ],
    });

    const container = document.createElement('div');
    setContainerSize(container, 1000, 800);
    document.body.appendChild(container);
    const ioMock = installMockIntersectionObserver();
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-far-teardown-race',
        assetUrl: pdfDataUrl(pdfBinary),
      }));

      const scrollContainer = container.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      expect(scrollContainer).not.toBeNull();
      scrollContainer!.getBoundingClientRect = () => rect(0, 0, 1000, 800);
      const wrapper4 = container.querySelector<HTMLElement>('[data-testid="pdf-page-4"]');
      expect(wrapper4).not.toBeNull();
      wrapper4!.getBoundingClientRect = () => rect(3200, 100, 800, 800);

      const gate = gatePageRender(adapter, 4);
      // Clear initial page 4 and start controlled pending render 4
      adapter.discardPageContent(4);
      const render4Promise = adapter.repaintPage(4);
      await gate.started;

      // Page 4 is now in flight
      expect(wrapper4?.querySelector('[data-testid="pdf-canvas-p4"]')).not.toBeNull();

      // Deliver a false IO entry for Page 4 (genuinely far offscreen)
      ioMock.deliver(wrapper4!, false);
      await nextAnimationFrame();

      // Assert Page 4 in-flight render was canceled and wrapper children were cleared
      expect(gate.cancelCalled()).toBe(true);
      expect(wrapper4?.querySelector('[data-testid="pdf-canvas-p4"]')).toBeNull();
      expect(wrapper4?.childElementCount).toBe(0);

      // Settle the canceled render promise and verify clean settlement
      gate.settle(new pdfjsLib.RenderingCancelledException('Rendering cancelled', 0));
      await render4Promise;

      expect(wrapper4?.querySelector('[data-testid="pdf-canvas-p4"]')).toBeNull();
      expect(wrapper4?.childElementCount).toBe(0);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      ioMock.restore();
      ctxStub.restore();
    }
  });

  it('initializes and renders EPUB, extracting TOC, search matches, and text chunks', async () => {
    const epubBinary = makeEpubFixture({
      title: 'Distributed Systems Patterns',
      author: 'Leslie Lamport',
      chapters: [
        {
          title: 'Chapter 1: Time and Clocks',
          content: '<p>Logical clocks and vector clocks provide partial ordering in distributed systems.</p>',
        },
        {
          title: 'Chapter 2: Consensus Algorithms',
          content: '<p>Paxos and Raft solve distributed consensus under network partition scenarios.</p>',
        },
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new EpubAdapter((bytes) => Promise.resolve(inflateZipArchive(bytes)));
    const dataUrl = `data:application/epub+zip;base64,${epubBinary.toString('base64')}`;

    await adapter.open(container, testDocumentSource({
      documentId: 'doc-epub-1',
      assetUrl: dataUrl,
    }));
    expect(adapter.format).toBe('epub');
    expect(adapter.getPageCount()).toBe(2);
    expect(adapter.getCurrentPage()).toBe(1);

    const toc = await adapter.getTableOfContents();
    expect(toc.length).toBeGreaterThanOrEqual(2);
    expect(toc[0]!.title).toContain('Time and Clocks');
    expect(toc[0]!.location?.format).toBe('epub');

    const searchMatches = await adapter.search('Paxos');
    expect(searchMatches.length).toBe(1);
    expect(searchMatches[0]!.text).toBe('Paxos');
    expect(searchMatches[0]!.location.format).toBe('epub');

    const chunks = [];
    for await (const chunk of adapter.extractText()) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toContain('Logical clocks');

    await adapter.goToPage(2);
    expect(adapter.getCurrentPage()).toBe(2);

    await adapter.setZoom(1.25);
    expect(adapter.getZoom()).toBe(1.25);

    const loc = adapter.getReadingLocation();
    expect(loc.location.format).toBe('epub');

    await adapter.close();
    document.body.removeChild(container);
  });

  it('initializes and renders MOBI, extracting TOC, search matches, and text chunks', async () => {
    const mobiBinary = makeMobiFixture({
      title: 'High Performance Databases',
      author: 'Jim Gray',
      chapters: [
        {
          title: 'Chapter 1: Transaction Processing',
          content: '<p>ACID guarantees and two-phase locking provide serializability.</p>',
        },
        {
          title: 'Chapter 2: Write-Ahead Logging',
          content: '<p>WAL protocols ensure atomicity and durability in crash recovery.</p>',
        },
      ],
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new MobiAdapter(parseMobiForTesting);

    const dataUrl = `data:application/x-mobipocket-ebook;base64,${mobiBinary.toString('base64')}`;
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-mobi-1',
      assetUrl: dataUrl,
    }));

    expect(adapter.format).toBe('mobi');
    expect(adapter.getPageCount()).toBe(2);
    expect(adapter.getCurrentPage()).toBe(1);

    const toc = await adapter.getTableOfContents();
    expect(toc.length).toBe(2);
    expect(toc[0]!.location?.format).toBe('mobi');

    const searchMatches = await adapter.search('Write-Ahead');
    expect(searchMatches.length).toBe(1);
    expect(searchMatches[0]!.location.format).toBe('mobi');

    const chunks = [];
    for await (const chunk of adapter.extractText()) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toContain('Transaction Processing');

    await adapter.goToPage(2);
    expect(adapter.getCurrentPage()).toBe(2);

    await adapter.close();
    document.body.removeChild(container);
  });

  it('opens real KF8/AZW3 content through the pinned foliate parser', async () => {
    const kf8Binary = makeKf8Fixture();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new MobiAdapter(parseMobiForTesting);

    await adapter.open(container, testDocumentSource({
      documentId: 'doc-kf8-1',
      assetUrl: `data:application/vnd.amazon.ebook;base64,${kf8Binary.toString('base64')}`,
    }));

    expect(adapter.getPageCount()).toBeGreaterThanOrEqual(1);
    const chunks = [];
    for await (const chunk of adapter.extractText()) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.text).join(' ')).toContain(
      'Generated public test content for KF8 parsing.'
    );
    expect(await adapter.search('sanitized reflow')).toHaveLength(1);

    await adapter.close();
    document.body.removeChild(container);
  });

  it('coalesces a ResizeObserver burst into live geometry plus exactly one sharp commit', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const controls = captureFrameAndTimerScheduling();

    const pdfBinary = makePdfFixture({ title: 'Pane Drag Burst', pages: ['Page 1: Burst stability.'] });
    const container = document.createElement('div');
    setContainerSize(container, 1024, 768);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-burst',
        assetUrl: `data:application/pdf;base64,${pdfBinary.toString('base64')}`,
      }));
      const initialCanvas = await waitForFirstCanvas(container, controls, adapter.painted);
      const epochBeforeBurst = adapter.epoch;
      const zoomBeforeBurst = adapter.scale;
      const wrapperBefore = container.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      expect(wrapperBefore).not.toBeNull();
      const widthBefore = Number.parseFloat(wrapperBefore!.style.width);
      const rafBaseline = controls.rafScheduleCount();

      // Simulate one animation frame's worth of pointer-move pane resizing:
      // three observer deliveries arrive before the coalescing frame runs.
      setContainerSize(container, 900, 768);
      roMock.fire();
      setContainerSize(container, 820, 768);
      roMock.fire();
      setContainerSize(container, 700, 768);
      roMock.fire();
      expect(controls.rafScheduleCount()).toBe(rafBaseline + 1);

      // Live pass: geometry and preview tracking move, the painted surface does not.
      controls.flushFrames();
      const widthDuringLiveStep = Number.parseFloat(wrapperBefore!.style.width);
      expect(widthDuringLiveStep).toBeLessThan(widthBefore);
      expect(adapter.scale).toBeCloseTo(((700 - 48) / (1024 - 48)) * zoomBeforeBurst, 5);
      expect(adapter.epoch).toBe(epochBeforeBurst);
      expect(initialCanvas.isConnected).toBe(true);
      const livePreviewMatch = /scale\(([\d.]+)\)/.exec(initialCanvas.style.transform);
      const livePreviewFactor = Number.parseFloat(livePreviewMatch?.[1] ?? '1');
      expect(livePreviewFactor).toBeGreaterThan(0);
      expect(livePreviewFactor).toBeLessThan(1);
      expect(initialCanvas.style.transformOrigin).toBe('top left');
      expect(initialCanvas.parentElement?.querySelector('.textLayer')).not.toBeNull();

      // Interleaved bursts continue to coalesce without touching content.
      setContainerSize(container, 760, 768);
      roMock.fire();
      controls.flushFrames();
      expect(initialCanvas.isConnected).toBe(true);
      expect(adapter.pendingTokens.size).toBe(0);

      // Quiet period elapses: the single destructive commit repaints once.
      controls.flushTimeouts();
      await pumpAsync(controls);
      const finalCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(finalCanvas).not.toBeNull();
      expect(finalCanvas).not.toBe(initialCanvas);
      expect(initialCanvas.isConnected).toBe(false);
      expect(adapter.epoch).toBe(epochBeforeBurst + 1);
      expect(finalCanvas!.style.transform).toBe('');
      expect(adapter.previewedScales.has(1)).toBe(false);
      const paintedScale = adapter.paintedScales.get(1);
      expect(paintedScale).toBeDefined();
      expect(paintedScale!).toBeCloseTo(adapter.scale, 5);
      const unitPageWidth = adapter.dimensions.get(1)?.width ?? 0;
      expect(unitPageWidth).toBeGreaterThan(0);
      expect(Number.parseFloat(finalCanvas!.style.width)).toBe(Math.round(unitPageWidth * adapter.scale));
      expect(container.querySelectorAll('canvas')).toHaveLength(1);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      roMock.restore();
      controls.restore();
      ctxStub.restore();
    }
  });

  it('previews a stale-scale swap and repaints sharp when a render finishes after live resize advances zoom', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const controls = captureFrameAndTimerScheduling();

    const pdfBinary = makePdfFixture({ title: 'Scale Race', pages: ['Page 1: Scale race coherence.'] });
    const container = document.createElement('div');
    setContainerSize(container, 1024, 768);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-scale-race',
        assetUrl: `data:application/pdf;base64,${pdfBinary.toString('base64')}`,
      }));
      const initialCanvas = await waitForFirstCanvas(container, controls, adapter.painted);
      const scaleA = adapter.scale;

      // Gate exactly one replacement render so it can settle on purpose
      // after a live resize has already moved this.zoom.
      let finishGatedRender!: () => void;
      const gatedRenderPromise = new Promise<void>((resolve) => {
        finishGatedRender = (): void => {
          resolve();
        };
      });
      const realPage = await adapter.document.getPage(1);
      const originalPageRender = realPage.render.bind(realPage);
      let gateArmed = true;
      realPage.render = (params: Parameters<typeof originalPageRender>[0]) => {
        if (!gateArmed) return originalPageRender(params);
        gateArmed = false;
        return {
          cancel: () => undefined,
          promise: gatedRenderPromise,
        } as pdfjsLib.RenderTask;
      };
      adapter.document.getPage = (): Promise<pdfjsLib.PDFPageProxy> => Promise.resolve(realPage);

      adapter.discardPageContent(1);
      const replacementRender = adapter.repaintPage(1);
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
        await controls.realSleep(2);
      }
      expect(gateArmed).toBe(false);

      // Live resize advances zoom while the render is gated; no epoch bump occurs.
      setContainerSize(container, 700, 768);
      roMock.fire();
      controls.flushFrames();
      const scaleB = adapter.scale;
      expect(scaleB).toBeLessThan(scaleA);

      // The gated render resolves at scale A after zoom is already at B.
      // Drain only frames/microtasks: draining timers here would run the
      // settle commit and repaint at B before the stale-scale state is
      // observable.
      finishGatedRender();
      const framesOnlyDrain = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) {
          controls.flushFrames();
          await Promise.resolve();
          await Promise.resolve();
          await controls.realSleep(4);
        }
        controls.flushFrames();
      };
      await replacementRender;
      await framesOnlyDrain();

      const swappedScale = adapter.paintedScales.get(1);
      expect(swappedScale).toBeDefined();
      expect(swappedScale!).toBeCloseTo(scaleA, 5);
      const swappedCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(swappedCanvas).not.toBeNull();
      expect(swappedCanvas).not.toBe(initialCanvas);
      expect(initialCanvas.isConnected).toBe(false);
      const previewMatch = /scale\(([\d.]+)\)/.exec(swappedCanvas!.style.transform);
      const previewFactor = Number.parseFloat(previewMatch?.[1] ?? '1');
      expect(previewFactor).toBeCloseTo(scaleB / scaleA, 3);
      expect(adapter.previewedScales.has(1)).toBe(true);

      // Quiet-period commit must produce the final sharp render at scale B.
      const epochBeforeCommit = adapter.epoch;
      controls.flushTimeouts();
      await pumpAsync(controls);
      const finalCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(finalCanvas).not.toBeNull();
      expect(finalCanvas).not.toBe(swappedCanvas);
      expect(adapter.paintedScales.get(1)!).toBeCloseTo(scaleB, 5);
      expect(finalCanvas!.style.transform).toBe('');
      expect(adapter.previewedScales.size).toBe(0);
      expect(adapter.epoch).toBeGreaterThan(epochBeforeCommit);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      roMock.restore();
      controls.restore();
      ctxStub.restore();
    }
  });

  it('cancels pending resize work on close without further renders or errors', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const controls = captureFrameAndTimerScheduling();

    const pdfBinary = makePdfFixture({ title: 'Close Race', pages: ['Page 1: Close race.'] });
    const container = document.createElement('div');
    setContainerSize(container, 1000, 760);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-close-race',
        assetUrl: `data:application/pdf;base64,${pdfBinary.toString('base64')}`,
      }));
      await waitForFirstCanvas(container, controls, adapter.painted);

      setContainerSize(container, 700, 760);
      roMock.fire();
      controls.flushFrames();
      expect(adapter.commitTimer).not.toBeNull();

      await adapter.close();
      expect(adapter.commitTimer).toBeNull();
      const epochAtClose = adapter.epoch;
      await pumpAsync(controls);
      expect(adapter.epoch).toBe(epochAtClose);
      expect(container.childElementCount).toBe(0);
    } finally {
      document.body.removeChild(container);
      roMock.restore();
      controls.restore();
      ctxStub.restore();
    }
  });

  it('manual zoom invalidates the pending resize commit and stays authoritative afterwards', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const controls = captureFrameAndTimerScheduling();

    const pdfBinary = makePdfFixture({ title: 'Manual Zoom Priority', pages: ['Page 1: Manual zoom priority.'] });
    const container = document.createElement('div');
    setContainerSize(container, 1024, 768);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-manual-zoom-race',
        assetUrl: `data:application/pdf;base64,${pdfBinary.toString('base64')}`,
      }));
      const initialCanvas = await waitForFirstCanvas(container, controls, adapter.painted);

      setContainerSize(container, 720, 768);
      roMock.fire();
      controls.flushFrames();
      expect(adapter.commitTimer).not.toBeNull();

      await adapter.setZoom(2.25);
      expect(adapter.getZoomMode()).toBe('custom');
      expect(adapter.commitTimer).toBeNull();
      const epochAfterManualZoom = adapter.epoch;

      // A late resize delivery must not fight the manual zoom decision:
      // neither a live pass nor the quiet-period commit may run off fit modes.
      setContainerSize(container, 600, 768);
      roMock.fire();
      controls.flushFrames();
      controls.flushTimeouts();
      await pumpAsync(controls);

      expect(adapter.getZoom()).toBe(2.25);
      expect(adapter.getZoomMode()).toBe('custom');
      expect(adapter.epoch).toBe(epochAfterManualZoom);
      const repainted = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(repainted).not.toBeNull();
      expect(repainted).not.toBe(initialCanvas);
      expect(repainted!.style.transform).toBe('');
      expect(adapter.scale).toBe(2.25);
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      roMock.restore();
      controls.restore();
      ctxStub.restore();
    }
  });

  it('keeps the completed surface attached when a committed repaint is cancelled mid-render', async () => {
    const ctxStub = stubCanvasRenderingContext();
    const roMock = installMockResizeObserver();
    const controls = captureFrameAndTimerScheduling();

    const pdfBinary = makePdfFixture({ title: 'Cancellation Preservation', pages: ['Page 1: Preserve me during cancellation.'] });
    const container = document.createElement('div');
    setContainerSize(container, 1024, 768);
    document.body.appendChild(container);
    const adapter = new ProbePdfAdapter();

    try {
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-pdf-cancel-preserve',
        assetUrl: `data:application/pdf;base64,${pdfBinary.toString('base64')}`,
      }));
      const previousCanvas = await waitForFirstCanvas(container, controls, adapter.painted);
      const previousTextLayer = container.querySelector('.textLayer');
      expect(previousTextLayer).not.toBeNull();

      // Gate the first post-commit render attempt so the swap is observable.
      const realPage = await adapter.document.getPage(1);
      let releaseRender!: (outcome: Promise<pdfjsLib.RenderTask['promise']>) => void;
      const renderGate = new Promise<Promise<pdfjsLib.RenderTask['promise']>>((resolveGate) => {
        releaseRender = (outcome) => {
          resolveGate(outcome);
        };
      });
      let cancelInjection!: () => void;
      const cancelInjectionPromise = new Promise<pdfjsLib.RenderTask['promise']>((_, rejectInjection) => {
        cancelInjection = (): void => {
          const cancellation = new pdfjsLib.RenderingCancelledException('commit cancelled', 0);
          rejectInjection(cancellation instanceof Error ? cancellation : new Error('commit cancelled'));
        };
      });
      let gateArmed = true;
      const originalPageRender = realPage.render.bind(realPage);
      realPage.render = (params: Parameters<typeof originalPageRender>[0]) => {
        if (!gateArmed) return originalPageRender(params);
        gateArmed = false;
        // Pure stub: cycle A must start no real render so its cancellation
        // cannot poison the worker for the recovery pass.
        return {
          cancel: () => undefined,
          promise: renderGate.then(() => cancelInjectionPromise),
        } as pdfjsLib.RenderTask;
      };
      adapter.document.getPage = (): Promise<pdfjsLib.PDFPageProxy> => Promise.resolve(realPage);

      setContainerSize(container, 680, 768);
      roMock.fire();
      controls.flushFrames();
      controls.flushTimeouts();
      await controls.realSleep(10);

      // Mid-gate: bookkeeping was invalidated but the old paint is untouched.
      expect(previousCanvas.isConnected).toBe(true);
      expect(container.querySelector('.textLayer')).toBe(previousTextLayer);
      expect(adapter.painted.has(1)).toBe(false);

      releaseRender(cancelInjectionPromise);
      cancelInjection();
      await pumpAsync(controls);
      expect(previousCanvas.isConnected).toBe(true);
      expect(container.querySelector('.textLayer')).toBe(previousTextLayer);

      // A fresh quiet cycle recovers with a sharp swap at the live scale.
      setContainerSize(container, 900, 768);
      roMock.fire();
      controls.flushFrames();
      controls.flushTimeouts();
      await pumpAsync(controls);
      const recovered = container.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      expect(recovered).not.toBeNull();
      expect(recovered).not.toBe(previousCanvas);
      expect(previousCanvas.isConnected).toBe(false);
      expect(recovered!.style.transform).toBe('');
    } finally {
      await adapter.close();
      document.body.removeChild(container);
      roMock.restore();
      controls.restore();
      ctxStub.restore();
    }
  });
});
