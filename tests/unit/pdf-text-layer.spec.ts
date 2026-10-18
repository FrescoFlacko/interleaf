// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { TestCanvasContext } from '../helpers/canvas-context';
import { testDocumentSource } from '../helpers/document-source';

/**
 * The PDF text layer is now the official `TextLayerBuilder` from
 * pdfjs-dist 6.2.108 (`web/pdf_viewer.mjs`). PDF.js owns glyph geometry, the
 * `.endOfContent` sentinel, the `selecting` class and the shared document
 * selection listener; the adapter owns only the builder's lifetime and the CSS
 * those internals depend on. These specs pin both halves of that contract.
 */

const UPSTREAM_CSS = readFileSync(
  join(process.cwd(), 'node_modules/pdfjs-dist/web/pdf_viewer.css'),
  'utf8'
);
const APP_CSS = readFileSync(
  join(process.cwd(), 'src/renderer/styles/global.css'),
  'utf8'
);

/** Collapses comments and formatting so declarations compare literally. */
function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([:;{}>,])\s*/g, '$1')
    .replaceAll("'", '"')
    .trim();
}

type CssRule = { readonly selector: string; readonly body: string };

/** Naive top-level rule scanner; sufficient for both stylesheets here. */
function topLevelRules(css: string): readonly CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules: CssRule[] = [];
  let depth = 0;
  let blockStart = 0;
  let selectorStart = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push({
          selector: stripped.slice(selectorStart, blockStart).trim(),
          body: stripped.slice(blockStart + 1, i),
        });
        selectorStart = i + 1;
      }
    }
  }
  return rules;
}

/**
 * The canonical upstream `.textLayer` block (the one carrying the sentinel);
 * `pdf_viewer.css` also declares `.textLayer` twice more for annotation-editor
 * nesting.
 */
function upstreamTextLayerBlock(): string {
  const block = topLevelRules(UPSTREAM_CSS).find(
    (rule) => rule.selector === '.textLayer' && rule.body.includes('.endOfContent')
  );
  if (!block) throw new Error('Upstream .textLayer block not found in pdf_viewer.css');
  return normalizeCss(block.body);
}

/** Every app rule whose selector mentions `.textLayer`, flattened. */
function appTextLayerCss(): string {
  return normalizeCss(
    topLevelRules(APP_CSS)
      .filter((rule) => rule.selector.includes('.textLayer'))
      .map((rule) => rule.body)
      .join(';')
  );
}

/** Every app rule targeting the PDF page container. */
function appPageWrapperCss(): string {
  return normalizeCss(
    topLevelRules(APP_CSS)
      .filter((rule) => rule.selector.includes('.pdf-page-wrapper'))
      .map((rule) => rule.body)
      .join(';')
  );
}

describe('PDF text layer stylesheet contract (pdfjs-dist 6.2.108)', () => {
  const upstream = upstreamTextLayerBlock();
  const app = appTextLayerCss();

  // Declarations the upstream text layer depends on for selection to behave
  // natively. Each is asserted against the installed stylesheet first, so a
  // pdfjs-dist upgrade that drops or renames one fails here instead of silently
  // leaving the app port stale.
  const SHARED_DECLARATIONS = [
    // Container: hit-testing box, glyph coordinate space, caret.
    'position:absolute',
    'text-align:initial',
    'inset:0',
    'overflow:clip',
    'opacity:1',
    'line-height:1',
    'letter-spacing:normal',
    'word-spacing:normal',
    'text-size-adjust:none',
    'forced-color-adjust:none',
    'transform-origin:0 0',
    'caret-color:CanvasText',
    'z-index:0',
    '--min-font-size:1',
    '--min-font-size-inv:calc(1 / var(--min-font-size))',
    // Glyph spans.
    'color:transparent',
    'white-space:pre',
    'cursor:text',
    'transform-origin:0% 0%',
    'user-select:text',
    'z-index:1',
    '--font-height:0',
    'font-size:calc(var(--text-scale-factor) * var(--font-height))',
    '--scale-x:1',
    '--rotate:0deg',
    'transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))',
    // Marked content is transparent to layout so nested spans keep their
    // absolute positions; `includeMarkedContent` is on by default in
    // `TextLayerBuilder.render()`.
    'display:contents',
    // Image glyphs must not be draggable text.
    'cursor:default',
    'user-select:none',
    // Sentinel geometry that upstream toggles via `.selecting`.
    'display:block',
    'inset:100% 0 0',
    'top:0',
  ] as const;

  it.each(SHARED_DECLARATIONS)('upstream and the app port declare `%s`', (declaration) => {
    expect(upstream).toContain(declaration);
    expect(app).toContain(declaration);
  });

  it('keeps the sentinel and its selecting state addressable', () => {
    expect(upstream).toContain('.endOfContent{');
    expect(upstream).toContain('&.selecting .endOfContent{');

    // The app port flattens upstream's nesting into two top-level rules, and
    // `appTextLayerCss()` keeps only rule *bodies* — so the sentinel selectors
    // have to be checked against `APP_CSS` directly.
    const sentinelRules = new Map(
      topLevelRules(APP_CSS)
        .filter((rule) => rule.selector.includes('.endOfContent'))
        .map((rule) => [normalizeCss(rule.selector), normalizeCss(rule.body)])
    );
    expect(sentinelRules.get('.textLayer .endOfContent')).toContain('inset:100% 0 0');
    expect(sentinelRules.get('.textLayer.selecting .endOfContent')).toContain('top:0');
  });

  it('paints line-break selection transparently so blank page width stays clear', () => {
    expect(upstream).toContain('br::selection{background:transparent');
    const brRules = topLevelRules(APP_CSS).filter((rule) =>
      rule.selector.includes('br::selection')
    );
    expect(brRules.length).toBeGreaterThan(0);
    for (const rule of brRules) {
      expect(normalizeCss(rule.body)).toContain('background-color:transparent');
    }
  });

  it('scales glyph geometry from the same custom property PDF.js writes', () => {
    // `setLayerDimensions()` emits `var(--total-scale-factor)`; the adapter sets
    // it per layer at the scale that layer was rendered with.
    expect(upstream).toContain('--text-scale-factor:calc(var(--total-scale-factor)');
    expect(app).toContain('--text-scale-factor:calc(var(--total-scale-factor');
  });

  it('applies upstream page rotation for /Rotate 90|180|270 pages', () => {
    const upstreamRotations = new Map(
      topLevelRules(UPSTREAM_CSS)
        .filter((rule) => /^\[data-main-rotation="(90|180|270)"\]$/.test(rule.selector))
        .map((rule) => [rule.selector, normalizeCss(rule.body)])
    );
    expect(upstreamRotations.get('[data-main-rotation="90"]')).toContain(
      'transform:rotate(90deg) translateY(-100%)'
    );
    expect(upstreamRotations.get('[data-main-rotation="180"]')).toContain(
      'transform:rotate(180deg) translate(-100%,-100%)'
    );
    expect(upstreamRotations.get('[data-main-rotation="270"]')).toContain(
      'transform:rotate(270deg) translateX(-100%)'
    );

    // The app scopes the same transforms to `.textLayer` and composes them with
    // the preview scale, because the adapter's double-buffered zoom preview
    // would otherwise overwrite `transform` and drop the rotation.
    const appRotations = new Map(
      topLevelRules(APP_CSS)
        .filter((rule) => rule.selector.includes('data-main-rotation'))
        .map((rule) => [normalizeCss(rule.selector), normalizeCss(rule.body)])
    );
    expect(appRotations.get('.textLayer[data-main-rotation="90"]')).toBe(
      'transform:scale(var(--preview-scale)) rotate(90deg) translateY(-100%);'
    );
    expect(appRotations.get('.textLayer[data-main-rotation="180"]')).toBe(
      'transform:scale(var(--preview-scale)) rotate(180deg) translate(-100%,-100%);'
    );
    expect(appRotations.get('.textLayer[data-main-rotation="270"]')).toBe(
      'transform:scale(var(--preview-scale)) rotate(270deg) translateX(-100%);'
    );
  });

  it('gives the page container the rounding units `setLayerDimensions()` requires', () => {
    // Without these the emitted
    // `round(down, var(--total-scale-factor) * Npx, var(--scale-round-x))`
    // is invalid at computed-value time and the layer collapses to `auto`.
    const upstreamPage = topLevelRules(UPSTREAM_CSS).find(
      (rule) => rule.selector === '.pdfViewer .page'
    );
    expect(upstreamPage).toBeDefined();
    const upstreamPageBody = normalizeCss(upstreamPage?.body ?? '');
    for (const declaration of [
      '--user-unit:1',
      '--scale-round-x:1px',
      '--scale-round-y:1px',
      'direction:ltr',
    ]) {
      expect(upstreamPageBody).toContain(declaration);
      expect(appPageWrapperCss()).toContain(declaration);
    }
  });
});

describe('PdfAdapter text layer lifecycle', () => {
  const activeContainers: HTMLElement[] = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalAddEventListener = document.addEventListener.bind(document);

  let capturedObserverCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null;
  const observedWrappers = new Set<Element>();
  /** Signals PDF.js attached its shared `selectionchange` listener with. */
  const selectionChangeSignals: AbortSignal[] = [];
  /**
   * PDF.js refcounts its single static selection listener by live layer count,
   * so it legitimately tears down and re-registers when every layer is
   * virtualized away between renders. The leak-free invariant is therefore
   * "at most one *live* listener", not "one listener ever".
   */
  const liveSelectionListeners = (): readonly AbortSignal[] =>
    selectionChangeSignals.filter((signal) => !signal.aborted);

  beforeEach(() => {
    capturedObserverCallback = null;
    observedWrappers.clear();
    selectionChangeSignals.length = 0;

    document.addEventListener = function (
      this: Document,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) {
      if (
        type === 'selectionchange' &&
        typeof options === 'object' &&
        options.signal instanceof AbortSignal
      ) {
        selectionChangeSignals.push(options.signal);
      }
      originalAddEventListener(type, listener, options);
    } as typeof document.addEventListener;

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '600px 0px 600px 0px';
      readonly scrollMargin = '0px 0px 0px 0px';
      readonly thresholds: readonly number[] = [0.01];

      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedObserverCallback = callback;
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
    globalThis.IntersectionObserver =
      MockIntersectionObserver as typeof IntersectionObserver;

    const getContextMock = function (this: HTMLCanvasElement, contextId: string): CanvasRenderingContext2D | null {
      return contextId === '2d' ? new TestCanvasContext(this) : null;
    };
   Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: getContextMock,
    });

    Element.prototype.getBoundingClientRect = function () {
      const pageNumAttr = this.getAttribute('data-page-number');
      if (pageNumAttr) {
        const pageNum = Number(pageNumAttr);
        const scroller = this.closest('.pdf-viewer-scroll-container');
        const scrollTop = scroller?.scrollTop ?? 0;
        const top = (pageNum - 1) * 800 - scrollTop;
        return {
          top, bottom: top + 792, left: 0, right: 612,
          width: 612, height: 792, x: 0, y: top, toJSON: () => ({}),
        };
      }
      if (this.classList.contains('pdf-viewer-scroll-container')) {
        return {
          top: 0, bottom: 600, left: 0, right: 800,
          width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
        };
      }
      return {
        top: 0, bottom: 0, left: 0, right: 0,
        width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
      };
    };
  });

  afterEach(() => {
    document.addEventListener = originalAddEventListener;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.IntersectionObserver = originalIntersectionObserver;
    for (const container of activeContainers) {
      container.parentElement?.removeChild(container);
    }
    activeContainers.length = 0;
  });

  function mountContainer(): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    activeContainers.push(container);
    return container;
  }

  function triggerVisibility(
    container: HTMLElement,
    updates: readonly { readonly page: number; readonly isIntersecting: boolean }[]
  ): void {
    const entering = updates.find((u) => u.isIntersecting && u.page > 2);
    if (entering) {
      const scroller = container.querySelector('.pdf-viewer-scroll-container');
      if (scroller) scroller.scrollTop = (entering.page - 1) * 800;
    }
    const entries = updates.map(({ page, isIntersecting }) => {
      const target = container.querySelector(`[data-page-number="${String(page)}"]`);
      if (!target) throw new Error(`Page ${String(page)} placeholder not found`);
      return {
        target,
        isIntersecting,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: container.getBoundingClientRect(),
      } as IntersectionObserverEntry;
    });
    capturedObserverCallback?.(entries);
  }

  async function openFixture(
    container: HTMLElement,
    fixture: Buffer,
    documentId: string
  ): Promise<PdfAdapter> {
    const adapter = new PdfAdapter();
    await adapter.open(container, testDocumentSource({
      documentId,
      assetUrl: `data:application/pdf;base64,${fixture.toString('base64')}`,
    }));
    return adapter;
  }

  type LayerListenerRecord = {
    readonly target: HTMLElement;
    readonly type: string;
    readonly signal: AbortSignal | null;
  };

  /**
   * Reads the abort signal out of an `addEventListener` options argument.
   *
   * `TextLayerBuilder#bindMouse` passes `null` when it has no abort signal
   * (`const opts = abortSignal ? { signal: abortSignal } : null`) — which is
   * the path the adapter deliberately takes. That is legal at runtime, where
   * `addEventListener` treats `null` like `undefined`, but `lib.dom.d.ts`
   * declares the parameter as `AddEventListenerOptions | boolean | undefined`,
   * so `typeof options === 'object'` narrows straight to
   * `AddEventListenerOptions` and the null case is invisible to the compiler.
   * Declaring this reader's parameter so that it admits `null` is what makes
   * the null check both sound and non-redundant to the type checker.
   */
  function signalOf(options?: AddEventListenerOptions | boolean | null): AbortSignal | null {
    if (typeof options !== 'object' || options === null) return null;
    const { signal } = options;
    return signal instanceof AbortSignal ? signal : null;
  }

  /**
   * Records every listener bound directly to a `.textLayer` container.
   * `TextLayerBuilder` binds `mousedown` and `copy` to its own div and scopes
   * them with whatever `abortSignal` it was constructed with, so this is the
   * only vantage point from which per-layer listener lifetime is observable.
   */
  function recordTextLayerListeners(): {
    readonly records: readonly LayerListenerRecord[];
    readonly restore: () => void;
  } {
    const records: LayerListenerRecord[] = [];
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean
    ): void {
      if (this instanceof HTMLElement && this.classList.contains('textLayer')) {
        records.push({ target: this, type, signal: signalOf(options) });
      }
      original.call(this, type, callback, options);
    };
    return {
      records,
      restore: () => {
        EventTarget.prototype.addEventListener = original;
      },
    };
  }

  it('builds upstream text layers with the sentinel and a shared, document-scoped selection listener', async () => {
    const container = mountContainer();
    const adapter = await openFixture(
      container,
      makePdfFixture({
        pageLines: [
          ['Native selection alpha line one.', 'Native selection alpha line two.'],
          ['Native selection beta line one.', 'Native selection beta line two.'],
        ],
        outline: [],
      }),
      'doc-pdf-textlayer-lifecycle'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer')).toHaveLength(2);
        },
        { timeout: 5000 }
      );

      for (const pageNumber of [1, 2]) {
        const layer = container.querySelector<HTMLElement>(
          `[data-testid="pdf-textlayer-p${String(pageNumber)}"]`
        );
        expect(layer).not.toBeNull();
        // Upstream constructor contract: focusable container named `textLayer`.
        expect(layer?.className).toBe('textLayer');
        expect(layer?.tabIndex).toBe(0);
        // `setLayerDimensions()` records the viewport rotation the CSS keys off.
        expect(layer?.getAttribute('data-main-rotation')).toBe('0');
        expect(layer?.style.getPropertyValue('--total-scale-factor')).not.toBe('');
        // The sentinel is appended last, after every glyph span.
        expect(layer?.lastElementChild?.className).toBe('endOfContent');
        expect(layer?.querySelectorAll('.endOfContent')).toHaveLength(1);
        expect(layer?.querySelectorAll('span').length).toBeGreaterThan(0);
        expect(layer?.textContent).toContain('Native selection');
      }

      // PDF.js installs exactly one static `selectionchange` listener for all
      // layers; a second page must not add another.
      expect(selectionChangeSignals).toHaveLength(1);
      expect(liveSelectionListeners()).toHaveLength(1);

      // Upstream drag lifecycle, driven entirely by PDF.js's own handlers.
      const layer1 = container.querySelector<HTMLElement>(
        '[data-testid="pdf-textlayer-p1"]'
      );
      layer1?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(layer1?.classList.contains('selecting')).toBe(true);
      document.dispatchEvent(new Event('pointerup'));
      expect(layer1?.classList.contains('selecting')).toBe(false);
      expect(layer1?.lastElementChild?.className).toBe('endOfContent');
    } finally {
      await adapter.close();
    }

    // Closing cancels every builder, which drops PDF.js's live-layer count to
    // zero; upstream then aborts its own static controller, so no
    // document-level selection listener outlives the document.
    expect(liveSelectionListeners()).toHaveLength(0);
    expect(container.querySelectorAll('.textLayer')).toHaveLength(0);
  });

  it('cancels the builder when a page is virtualized away, keeps the shared listener working, and rebuilds on return', async () => {
    const container = mountContainer();
    const pages = Array.from(
      { length: 12 },
      (_, idx) => `Virtualization page ${String(idx + 1)} selectable body text.`
    );
    const adapter = await openFixture(
      container,
      makePdfFixture({ pages, outline: [] }),
      'doc-pdf-textlayer-virtualization'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer').length).toBeGreaterThan(1);
        },
        { timeout: 5000 }
      );
      const page1 = container.querySelector<HTMLElement>('[data-page-number="1"]');
      expect(page1?.querySelector('.textLayer')).not.toBeNull();

      triggerVisibility(container, [
        { page: 1, isIntersecting: false },
        { page: 2, isIntersecting: false },
        { page: 9, isIntersecting: true },
      ]);

      await waitFor(
        () => {
          expect(page1?.querySelector('.textLayer')).toBeNull();
          expect(
            container.querySelector('[data-page-number="9"]')?.querySelector('.textLayer')
          ).not.toBeNull();
        },
        { timeout: 5000 }
      );

      // Layers are bounded rather than accumulating across the document.
      expect(container.querySelectorAll('.textLayer').length).toBeLessThanOrEqual(4);

      // Tearing pages down never leaves more than one live document listener,
      // and never leaves zero while layers are mounted.
      expect(liveSelectionListeners()).toHaveLength(1);

      // Behavioural proof, and the reason a per-page `abortSignal` cannot be
      // handed to `TextLayerBuilder`: upstream folds that signal into its
      // *static* listener via `AbortSignal.any`, so retiring the installing
      // page (one of the earliest layers just retired) would take `pointerup`
      // down with it and strand `selecting` on every surviving layer — with no
      // path back, since upstream's own controller is still non-null and
      // blocks reinstallation.
      const survivor = container.querySelector<HTMLElement>(
        '[data-page-number="9"] .textLayer'
      );
      if (!survivor) throw new Error('Page 9 has no text layer');
      survivor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(survivor.classList.contains('selecting')).toBe(true);
      document.dispatchEvent(new Event('pointerup'));
      expect(survivor.classList.contains('selecting')).toBe(false);

      triggerVisibility(container, [
        { page: 9, isIntersecting: false },
        { page: 1, isIntersecting: true },
      ]);
      await waitFor(
        () => {
          expect(page1?.querySelector('.textLayer')).not.toBeNull();
        },
        { timeout: 5000 }
      );
      expect(page1?.querySelector('.textLayer')?.lastElementChild?.className).toBe(
        'endOfContent'
      );
    } finally {
      await adapter.close();
    }

    expect(liveSelectionListeners()).toHaveLength(0);
  });

  it('rebuilds a single registered layer per page across a zoom re-render', async () => {
    const container = mountContainer();
    const adapter = await openFixture(
      container,
      makePdfFixture({
        pageLines: [['Zoom rerender line one.', 'Zoom rerender line two.']],
        outline: [],
      }),
      'doc-pdf-textlayer-zoom'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer')).toHaveLength(1);
        },
        { timeout: 5000 }
      );
      const initialScale = container
        .querySelector<HTMLElement>('.textLayer')
        ?.style.getPropertyValue('--total-scale-factor');

      await adapter.setZoom(2);
      await waitFor(
        () => {
          const layer = container.querySelector<HTMLElement>('.textLayer');
          expect(layer?.style.getPropertyValue('--total-scale-factor')).not.toBe(initialScale);
        },
        { timeout: 5000 }
      );

      // Double buffering must not leave the previous layer behind.
      expect(container.querySelectorAll('.textLayer')).toHaveLength(1);
      expect(container.querySelectorAll('.endOfContent')).toHaveLength(1);
      expect(liveSelectionListeners()).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  it('ends each layer listener scope with that layer rather than with the document', async () => {
    const container = mountContainer();
    const spy = recordTextLayerListeners();
    const pages = Array.from(
      { length: 12 },
      (_, idx) => `Listener scope page ${String(idx + 1)} selectable body text.`
    );

    /**
     * Whether a retired div is actually collected is a GC question and is not
     * observable from a test, so the invariant asserted here is the one that
     * is: once a layer is gone, nothing still-live may still hold its
     * listeners. A document-lifetime `abortSignal` fails this — every retired
     * div stays registered against an un-aborted signal until `close()`.
     */
    const expectScopeEnded = (div: HTMLElement): void => {
      const own = spy.records.filter((record) => record.target === div);
      // Guards against a vacuous pass if upstream ever stops binding these.
      const types = new Set(own.map((record) => record.type));
      expect(types.has('mousedown')).toBe(true);
      expect(types.has('copy')).toBe(true);
      for (const record of own) {
        expect(record.signal === null || record.signal.aborted).toBe(true);
      }
    };

    const layerForPage = (page: number): HTMLElement => {
      const div = container.querySelector<HTMLElement>(
        `[data-page-number="${String(page)}"] .textLayer`
      );
      if (!div) throw new Error(`Page ${String(page)} has no text layer`);
      return div;
    };

    const adapter = await openFixture(
      container,
      makePdfFixture({ pages, outline: [] }),
      'doc-pdf-textlayer-listener-scope'
    );
    let beforeClose: readonly HTMLElement[] = [];

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer').length).toBeGreaterThan(1);
        },
        { timeout: 5000 }
      );
      const beforeSwap = layerForPage(1);

      // Double-buffer swap. The first `setZoom` is deliberately left un-awaited
      // so its render can land stale, which also exercises the shared `finally`
      // cleanup a render error takes for a builder that never became the
      // page's registered layer.
      const stale = adapter.setZoom(2);
      await adapter.setZoom(3);
      await stale;
      await waitFor(
        () => {
          expect(beforeSwap.isConnected).toBe(false);
        },
        { timeout: 5000 }
      );
      // The swap must retire the old layer, not accumulate a second one.
      expect(container.querySelectorAll('[data-testid="pdf-textlayer-p1"]')).toHaveLength(1);
      expectScopeEnded(beforeSwap);
      expect(liveSelectionListeners()).toHaveLength(1);

      // Virtualization teardown.
      const beforeTeardown = layerForPage(1);
      triggerVisibility(container, [
        { page: 1, isIntersecting: false },
        { page: 2, isIntersecting: false },
        { page: 9, isIntersecting: true },
      ]);
      await waitFor(
        () => {
          expect(beforeTeardown.isConnected).toBe(false);
        },
        { timeout: 5000 }
      );
      expectScopeEnded(beforeTeardown);
      expect(liveSelectionListeners()).toHaveLength(1);

      beforeClose = Array.from(container.querySelectorAll<HTMLElement>('.textLayer'));
      expect(beforeClose.length).toBeGreaterThan(0);
    } finally {
      spy.restore();
      await adapter.close();
    }

    // Close retires whatever was still mounted, on the same terms.
    for (const div of beforeClose) {
      expect(div.isConnected).toBe(false);
      expectScopeEnded(div);
    }
    expect(liveSelectionListeners()).toHaveLength(0);
  });

  it('marks rotated pages with the rotation upstream CSS keys off', async () => {
    const container = mountContainer();
    const adapter = await openFixture(
      container,
      makePdfFixture({
        pageLines: [['Rotated page selectable line.']],
        pageRotations: [90],
        outline: [],
      }),
      'doc-pdf-textlayer-rotated'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer')).toHaveLength(1);
        },
        { timeout: 5000 }
      );
      const layer = container.querySelector<HTMLElement>('.textLayer');
      expect(layer?.getAttribute('data-main-rotation')).toBe('90');
      expect(layer?.lastElementChild?.className).toBe('endOfContent');
      // `TextLayer` sizes the container from the unrotated page box and the
      // `[data-main-rotation]` rule rotates it over the (landscape) canvas, so
      // the wrapper the adapter sizes from the viewport must be landscape.
      const wrapper = container.querySelector<HTMLElement>('[data-page-number="1"]');
      expect(Number.parseInt(wrapper?.style.width ?? '0', 10)).toBeGreaterThan(
        Number.parseInt(wrapper?.style.height ?? '0', 10)
      );
    } finally {
      await adapter.close();
    }
  });

  it('marks right-to-left runs with the direction PDF.js derives from the text content', async () => {
    const container = mountContainer();
    const adapter = await openFixture(
      container,
      // `rtlPages` maps ASCII A.. onto Hebrew alef.. through the font encoding,
      // so PDF.js's bidi pass sees genuine RTL codepoints.
      makePdfFixture({
        pageLines: [['ABCD EFGH']],
        rtlPages: [1],
        outline: [],
      }),
      'doc-pdf-textlayer-rtl'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer span').length).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );
      const layer = container.querySelector<HTMLElement>('.textLayer');
      expect(layer?.textContent).toContain('א');
      const spans = Array.from(layer?.querySelectorAll('span') ?? []);
      expect(spans.some((span) => span.getAttribute('dir') === 'rtl')).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('renders the text layer in the same normalized character space the adapter extracts and searches in', async () => {
    const container = mountContainer();
    const adapter = await openFixture(
      container,
      // `ligaturePages` gives the page a font whose `/ToUnicode` maps ASCII `A`
      // onto U+FB00 `ﬀ`. That codepoint is the smallest signal that separates
      // PDF.js's two text spaces: normalized it expands to `"ff"` (2 chars),
      // un-normalized it stays one char. `TextLayerBuilder` defaults to
      // `disableNormalization: true`, so without the adapter's explicit
      // `textContentParams` the DOM would be one character per ligature while
      // `search()` / `extractText()` — which call bare `getTextContent()` —
      // stay normalized, shifting every stored annotation offset on the page.
      makePdfFixture({
        pageLines: [['AA']],
        ligaturePages: [1],
        outline: [],
      }),
      'doc-pdf-textlayer-normalization'
    );

    try {
      await waitFor(
        () => {
          expect(container.querySelectorAll('.textLayer span').length).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );

      // The extraction space: what annotations and search offsets are anchored
      // against. Asserting the exact string also proves the fixture's ToUnicode
      // CMap really took effect — a silent fallback would yield `"AA"` in both
      // spaces and make the comparison below vacuous.
      const [chunk] = await adapter.extractLocationText({ format: 'pdf', pageIndex: 0 });
      expect(chunk?.text).toBe('ffff');

      // The DOM space: one `Tj` means one glyph span, so the spans concatenate
      // to the same string the extraction join produces. `includeMarkedContent`
      // makes PDF.js wrap runs in `<span class="markedContent">` containers
      // whose `textContent` repeats their children, so those are excluded.
      const layer = container.querySelector<HTMLElement>('.textLayer');
      const layerText = Array.from(layer?.querySelectorAll('span:not(.markedContent)') ?? [])
        .map((span) => span.textContent)
        .join('');
      // Equality is the offset-compatibility claim itself: an un-normalized
      // layer would be the 2-character `"ﬀﬀ"` against a 4-character extraction
      // space, so every anchor past the ligature would be off by two.
      expect(layerText).not.toContain('ﬀ');
      expect(layerText).toBe(chunk?.text);
    } finally {
      await adapter.close();
    }
  });
});
