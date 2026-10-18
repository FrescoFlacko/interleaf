import * as pdfjsLib from 'pdfjs-dist';
import type {
  DocumentFormat,
  DocumentLocation,
  NormalizedTextChunk,
  PdfChatSelectionDescriptor,
  PdfLocation,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
type RawPdfAnnotation = {
  readonly annotationType?: number;
  readonly subtype?: string;
  readonly noHTML?: boolean;
  readonly dest?: PdfDestination;
  /** Present on Link annotations, and untrusted until `parseSafeExternalUrl` accepts it. */
  readonly url?: string;
};
import type { Annotation, PdfAnnotationAnchor, PdfAnchorSegment, NormalizedRect, QuoteContext } from '@shared/types/annotation';
import type { SearchMatchAnchor, SearchTermRange } from '@shared/types/search';
import { takeCodePointPrefix } from '@shared/agent-context';

import type {
  AnnotationAnchorResolution,
  AnnotationResolutionCallback,
  DocumentAdapter,
  DocumentAdapterCapabilities,
  DocumentSource,
  ExternalLinkCallback,
  ReaderSelection,
  SelectionChangeCallback,
  SearchHighlightRequest,
  SearchHighlightResult,
  SelectionIssue,
} from '../types';
import { isSearchHighlightCancelled } from '../types';
import { TextLayerBuilder, textLayerRenderer } from './pdf-viewer-runtime';
import { configurePdfWorker } from './pdf-worker-setup';
import {
  calculateDestinationOffset,
  enhanceLinkAnnotations,
  parseSafeExternalUrl,
  PdfLinkService,
  resolvePdfDestination,
  type PdfDestination,
} from './pdf-link-service';
import { mapPdfOutline, type PdfOutlineNode } from './pdf-outline';
import {
  anchorToLocation,
  boundedQuoteContext,
  clearDomHighlights,
  MAX_NATIVE_SELECTION_TEXT_LENGTH,
  partitionMultiSegmentText,
  quoteContextForRange,
  rangeFromOffsets,
  rangeOffsetsWithin,
  subRangeWithin,
} from '../annotations/dom-anchors';
import { notePointerDetachOwner, notePointerInvalidateLayout, paintAnchoredRanges } from '../annotations/note-pointer';
import { applySearchHighlight, clearSearchHighlight } from '../annotations/search-highlight';
import {
  MAX_SEARCH_ANCHOR_RANGES,
  searchAnchorMatchesQuery,
  searchTokenMatchesTerm,
} from '@shared/search/match-anchor';
import {
  buildPdfTextSpaceMap,
  mapIndexedRangeToRendered,
  PDF_TEXT_CONTENT_PARAMS,
  pdfIndexedPageText,
  pdfTextItemStrings,
  joinPdfTextItems,
  type PdfTextSpaceMap,
} from './pdf-text-space';
import { resolvePdfAnnotationAnchor } from './pdf-annotation-anchor';

export { resolvePdfAnnotationAnchor };
export const PDF_RENDER_LIMITS = Object.freeze({
  maxImagePixels: 16 * 1024 * 1024,
  maxCanvasAreaBytes: 64 * 1024 * 1024,
  maxCanvasPixels: 16 * 1024 * 1024,
  maxCanvasDimension: 8_192,
  maxPageCssDimension: 20_000,
});

/**
 * Quiet period before a live fit-scale resize commits its destructive
 * re-render pass. ResizeObserver deliveries during panel drags arrive faster
 * than PDF.js can repaint; committing once after the drag settles keeps the
 * interaction smooth instead of tearing down every painted page per frame.
 */
const PDF_RESIZE_COMMIT_DELAY_MS = 140;
const FIT_SCALE_DEADBAND = 0.0008;
/** Below this delta an already-painted page is considered sharp at the target scale. */
const RENDERED_SCALE_EPSILON = 0.001;
/** Preview factors this close to 1 are visually identical and are skipped. */
const PREVIEW_FACTOR_EPSILON = 0.0005;

type PdfViewportAnchor = {
  readonly pageNumber: number;
  /** Position within the page at the vertical centre of the viewport. */
  readonly pageProgress: number;
};

/**
 * Retires one page's text layer and everything scoped to it.
 *
 * `cancel()` clears the layer's children and unregisters it from PDF.js's
 * document-wide selection bookkeeping, but leaves the (now empty) container
 * attached; the adapter owns removing it. Detaching the div is also what ends
 * the lifetime of the `mousedown`/`copy` listeners `TextLayerBuilder` binds to
 * it: no external abort signal governs them, so once the div is out of the DOM
 * and out of PDF.js's static map nothing outlives this call. See the builder
 * construction in `renderPage` for why no signal is passed.
 */
function cancelTextLayerBuilder(builder: TextLayerBuilder): void {
  try {
    builder.cancel();
  } catch {
    // Teardown is best-effort; a partially rendered layer may throw here.
  }
  builder.div.remove();
}

export function safePageScale(
  width: number,
  height: number,
  desiredScale: number
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return desiredScale;
  }
  return Math.max(
    Number.EPSILON,
    Math.min(
      desiredScale,
      PDF_RENDER_LIMITS.maxPageCssDimension / width,
      PDF_RENDER_LIMITS.maxPageCssDimension / height
    )
  );
}

export function safeCanvasScale(
  width: number,
  height: number,
  desiredScale: number
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }
  return Math.max(
    Number.EPSILON,
    Math.min(
      desiredScale,
      PDF_RENDER_LIMITS.maxCanvasDimension / width,
      PDF_RENDER_LIMITS.maxCanvasDimension / height,
      Math.sqrt(PDF_RENDER_LIMITS.maxCanvasPixels / (width * height))
    )
  );
}

/** The anchor's own record of which query terms this physical token satisfied. */
function anchorTermMatchesQuery(anchor: SearchMatchAnchor, term: SearchTermRange): boolean {
  return term.queryTermIndices.some((index) => {
    const queryTerm = anchor.queryTerms[index];
    return queryTerm !== undefined && searchTokenMatchesTerm(term.text, queryTerm);
  });
}

/**
 * Resolves an indexed search anchor onto the live PDF text layer.
 *
 * The generic `rangesForSearchAnchor` applies indexed offsets straight to DOM
 * text nodes, which is correct only where the two spaces coincide. PDF is the
 * one format where they do not: the index joins text items with a synthetic
 * space and trims, while the rendered layer concatenates the same items with
 * nothing between them (see `pdf-text-space.ts`). So PDF translates through the
 * page's own item sequence instead.
 *
 * Fails closed — an empty result rather than a shifted paint — whenever any of
 * these does not hold, since every one of them means the offsets no longer
 * describe this page:
 *
 * 1. the chunk bounds fit inside the reconstructed indexed page text;
 * 2. each term range fits inside its chunk;
 * 3. the indexed text at those offsets is still exactly the recorded token;
 * 4. the token still satisfies one of the anchor's query terms under the same
 *    folded exact whole-token relation every other search surface uses;
 * 5. the range maps to a rendered range without straddling a separator; and
 * 6. the resulting DOM `Range` stringifies to that same token.
 */
export function resolvePdfSearchAnchorRanges(
  layer: Node,
  spaceMap: PdfTextSpaceMap,
  anchor: SearchMatchAnchor
): readonly Range[] {
  const location = anchor.location;
  if (location.format !== 'pdf') return [];
  const { textStart, textEnd } = location;
  if (
    textStart === undefined ||
    textEnd === undefined ||
    !Number.isInteger(textStart) ||
    !Number.isInteger(textEnd) ||
    textStart < 0 ||
    textEnd <= textStart ||
    textEnd > spaceMap.indexedText.length
  ) {
    return [];
  }
  if (anchor.ranges.length === 0) return [];

  const ranges: Range[] = [];
  for (const term of anchor.ranges.slice(0, MAX_SEARCH_ANCHOR_RANGES)) {
    const start = textStart + term.start;
    const end = textStart + term.end;
    if (term.start < 0 || term.end <= term.start || end > textEnd) return [];
    if (spaceMap.indexedText.slice(start, end) !== term.text) return [];
    if (!anchorTermMatchesQuery(anchor, term)) return [];
    const rendered = mapIndexedRangeToRendered(spaceMap, start, end);
    if (!rendered) return [];
    const range = rangeFromOffsets(layer, rendered);
    if (!range) return [];
    if (range.toString() !== term.text) return [];
    ranges.push(range);
  }
  return ranges;
}

export class PdfAdapter implements DocumentAdapter {
  readonly format: DocumentFormat = 'pdf';
  /** A PDF page is fixed-layout, so it has no reflow control; its link annotations can leave the document. */
  readonly capabilities: DocumentAdapterCapabilities = { reflow: null, externalLinks: this };

  /*
   * Render bookkeeping below is `protected` rather than `private`. None of it
   * is part of the adapter's public contract, and no production code outside
   * this class reads it; the visibility exists so the render-scheduling suite
   * can observe epochs, in-flight tasks and painted scales through a subclass
   * declared in the tests, instead of asserting its way past the type. A
   * renamed or retyped member then breaks that subclass at compile time.
   */

  private container: HTMLElement | null = null;
  protected scrollContainer: HTMLElement | null = null;
  private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  protected pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  private pageCount = 0;
  private currentPage = 1;
  protected zoom = 1.0;
  private zoomMode: ZoomMode = 'fit-width';
  private documentId = '';
  private documentHash = '';

  protected readonly pageDimensions = new Map<
    number,
    { width: number; height: number; aspectRatio: number }
  >();
  protected readonly renderedPages = new Set<number>();
  protected readonly renderedScales = new Map<number, number>();
  protected readonly previewScales = new Map<number, number>();
  protected readonly pendingRenderTokens = new Map<number, symbol>();
  private readonly inFlightRenders = new Map<
    number,
    { readonly task: pdfjsLib.RenderTask; readonly token: symbol }
  >();
  protected readonly pageWrappers = new Map<number, HTMLElement>();
  /**
   * Official PDF.js text layers, one per painted page. `TextLayerBuilder.cancel()`
   * is the only path that unregisters a layer from PDF.js's static selection
   * bookkeeping, so every teardown route (double-buffer swap, render failure,
   * virtualization, close) must go through {@link destroyTextLayer}.
   */
  private readonly textLayerBuilders = new Map<number, TextLayerBuilder>();
  private readonly annotationLayerDivs = new Map<number, HTMLDivElement>();
  private readonly linkService: PdfLinkService = new PdfLinkService(this);
  private readonly scheduledTeardowns = new Map<number, number>();
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRefitFrame: number | null = null;
  protected resizeCommitTimer: number | null = null;
  private isDestroyed = false;
  protected renderEpoch = 0;
  private scrollAnimationFrame: number | null = null;
  private scrollListener: (() => void) | null = null;
  private annotations: readonly Annotation[] = [];
  private annotationSequence = 0;
  private selectionListener: (() => void) | null = null;
  private onLocationChange?: ((location: PdfLocation, progress: number) => void) | undefined;
  private onSelectionChange?: SelectionChangeCallback | undefined;
  private onAnnotationResolution?: ((result: AnnotationAnchorResolution) => void) | undefined;
  private onExternalLink?: ((url: string) => void | Promise<void>) | undefined;
  private isClosed(): boolean {
    return this.isDestroyed || !this.pdfDoc;
  }

  setLocationChangeCallback(callback: ((location: PdfLocation, progress: number) => void) | null): void {
    this.onLocationChange = callback ?? undefined;
  }

  setSelectionChangeCallback(callback: SelectionChangeCallback | null): void {
    this.onSelectionChange = callback ?? undefined;
    this.installSelectionListener();
  }

  setAnnotationResolutionCallback(callback: AnnotationResolutionCallback | null): void {
    this.onAnnotationResolution = callback ?? undefined;
  }
  setExternalLinkCallback(callback: ExternalLinkCallback | null): void {
    this.onExternalLink = callback ?? undefined;
  }

  async goToDestination(dest: PdfDestination): Promise<boolean> {
    if (!this.pdfDoc || !this.scrollContainer) return false;

    const resolved = await resolvePdfDestination(this.pdfDoc, dest, this.pageCount);
    if (!resolved) return false;

    const { pageNumber, modeName, args } = resolved;
    let targetOffsetY = 0;

    try {
      const page = await this.pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: this.zoom });
      targetOffsetY = calculateDestinationOffset(page, viewport, modeName, args);
    } catch {
      targetOffsetY = 0;
    }

    const wrapper = this.pageWrappers.get(pageNumber);
    if (wrapper) {
      const clampedOffset = Math.max(0, Math.min(wrapper.offsetHeight || 0, targetOffsetY));
      const targetScrollTop = wrapper.offsetTop + clampedOffset;
      if (typeof this.scrollContainer.scrollTo === 'function') {
        this.scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
      } else {
        this.scrollContainer.scrollTop = Math.max(0, targetScrollTop);
      }
    }

    this.currentPage = pageNumber;
    this.notifyLocationChange();
    return true;
  }

  /**
   * Reports a link annotation the reader activated. The adapter has already
   * refused anything that is not an allowlisted absolute target; where it goes
   * from here is the host's decision, and an unmounted adapter — one with no
   * callback set — leaves the link inert rather than reaching for a bridge of
   * its own.
   */
  async handleExternalLink(url: string): Promise<void> {
    await this.onExternalLink?.(url);
  }

  executeNamedAction(action: string): void {
    switch (action) {
      case 'NextPage':
        void this.goToPage(this.currentPage + 1);
        break;
      case 'PrevPage':
        void this.goToPage(this.currentPage - 1);
        break;
      case 'FirstPage':
        void this.goToPage(1);
        break;
      case 'LastPage':
        void this.goToPage(this.pageCount);
        break;
      default:
        break;
    }
  }

  private destroyAnnotationLayer(pageNumber: number): void {
    const div = this.annotationLayerDivs.get(pageNumber);
    if (!div) return;
    this.annotationLayerDivs.delete(pageNumber);
    div.remove();
  }

  private destroyAllAnnotationLayers(): void {
    for (const div of this.annotationLayerDivs.values()) {
      div.remove();
    }
    this.annotationLayerDivs.clear();
  }

  async open(containerElement: HTMLElement, source: DocumentSource): Promise<void> {
    this.container = containerElement;
    this.documentId = source.documentId;
    this.documentHash = source.documentHash;
    this.isDestroyed = false;
    configurePdfWorker();

    // Embedded PDF scripting is not wired into this adapter, XFA is disabled,
    // and annotations are excluded from page rendering below.
    if (source.assetUrl.startsWith('data:')) {
      const base64Data = source.assetUrl.split(',')[1] ?? '';
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      this.loadingTask = pdfjsLib.getDocument({
        data: bytes,
        stopAtErrors: false,
        enableXfa: false,
        maxImageSize: PDF_RENDER_LIMITS.maxImagePixels,
        canvasMaxAreaInBytes: PDF_RENDER_LIMITS.maxCanvasAreaBytes,
      });
    } else {
      this.loadingTask = pdfjsLib.getDocument({
        url: source.assetUrl,
        stopAtErrors: false,
        enableXfa: false,
        maxImageSize: PDF_RENDER_LIMITS.maxImagePixels,
        canvasMaxAreaInBytes: PDF_RENDER_LIMITS.maxCanvasAreaBytes,
      });
    }
    this.pdfDoc = await this.loadingTask.promise;
    this.pageCount = this.pdfDoc.numPages;

    // Cache initial dimensions for page 1 as baseline
    const firstPage = await this.pdfDoc.getPage(1);
    const initialViewport = firstPage.getViewport({ scale: 1.0 });
    const defaultWidth = initialViewport.width;
    const defaultHeight = initialViewport.height;
    const defaultAspectRatio = defaultHeight / defaultWidth;

    for (let i = 1; i <= this.pageCount; i++) {
      this.pageDimensions.set(i, {
        width: defaultWidth,
        height: defaultHeight,
        aspectRatio: defaultAspectRatio,
      });
    }

    // Build DOM structure: Continuous vertical scroll container
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className =
      'pdf-viewer-scroll-container h-full w-full overflow-y-auto overflow-x-hidden flex flex-col items-center py-6 gap-6 outline-hidden';
    this.scrollContainer.setAttribute('data-testid', 'pdf-scroll-container');
    this.scrollContainer.setAttribute('tabindex', '0');

    // Calculate initial fit zoom
    this.recalculateFitScale();

    // Create page placeholder wrappers
    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const wrapper = document.createElement('div');
      wrapper.className =
        'pdf-page-wrapper relative bg-white shadow-md transition-shadow duration-150 select-text';
      wrapper.setAttribute('data-page-number', String(pageNum));
      wrapper.setAttribute('data-testid', `pdf-page-${String(pageNum)}`);

      const dims = this.pageDimensions.get(pageNum);
      const placeholderScale = dims
        ? safePageScale(dims.width, dims.height, this.zoom)
        : this.zoom;
      const targetWidth = dims ? Math.round(dims.width * placeholderScale) : 600;
      const targetHeight = dims ? Math.round(dims.height * placeholderScale) : 800;
      wrapper.style.width = `${String(targetWidth)}px`;
      wrapper.style.height = `${String(targetHeight)}px`;
      wrapper.style.minHeight = `${String(targetHeight)}px`;

      this.pageWrappers.set(pageNum, wrapper);
      this.scrollContainer.appendChild(wrapper);
    }
    this.container.replaceChildren(this.scrollContainer);
    this.installSelectionListener();


    // Setup intersection observer for near-viewport lazy rendering (+- 2 pages overscan)
    this.setupIntersectionObserver();
    this.scrollListener = () => {
      this.scrollAnimationFrame ??= window.requestAnimationFrame(() => {
        this.scrollAnimationFrame = null;
        this.handleScroll();
      });
    };
    this.scrollContainer.addEventListener('scroll', this.scrollListener, { passive: true });

    // Setup resize observer for responsive fit-width / fit-page
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.isDestroyed && (this.zoomMode === 'fit-width' || this.zoomMode === 'fit-page')) {
        this.scheduleResizeRefit();
      }
    });
    this.resizeObserver.observe(this.container);

    // Restore initial reading position if provided
    if (source.initialLocation?.format === 'pdf') {
      const targetPage = source.initialLocation.pageIndex + 1;
      if (targetPage >= 1 && targetPage <= this.pageCount) {
        this.goToPageInstant(targetPage);
      } else {
        this.updateVisiblePages();
      }
    } else {
      this.updateVisiblePages();
    }
  }

  async close(): Promise<void> {
    notePointerDetachOwner(this);
    this.isDestroyed = true;
    this.renderEpoch += 1;
    this.annotationSequence += 1;
    if (this.selectionListener) document.removeEventListener('selectionchange', this.selectionListener);
    this.selectionListener = null;
    clearDomHighlights(document);
    clearSearchHighlight(document);
    // Cancelling every builder is what tears the static selection listener
    // down: PDF.js refcounts it by live layer count and aborts its own
    // controller when the last layer deregisters.
    this.destroyAllTextLayers();
    this.destroyAllAnnotationLayers();
    this.onExternalLink = undefined;
    this.cancelPendingResizeSchedule();

    // Disconnect observers and listeners
    if (this.scrollListener) {
      this.scrollContainer?.removeEventListener('scroll', this.scrollListener);
      this.scrollListener = null;
    }
    if (this.scrollAnimationFrame !== null) {
      window.cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    // Cancel in-flight render tasks
    for (const { task } of this.inFlightRenders.values()) {
      try {
        task.cancel();
      } catch {
        // Ignored on cancellation
      }
    }
    this.inFlightRenders.clear();
    this.pendingRenderTokens.clear();
    this.renderedPages.clear();
    this.renderedScales.clear();
    this.previewScales.clear();
    this.pageWrappers.clear();
    // The loading task owns worker/document teardown in pdf.js 6.
    if (this.loadingTask) {
      try {
        await this.loadingTask.destroy();
      } catch {
        // Teardown is best-effort after cancellation.
      }
      this.loadingTask = null;
    }
    this.pdfDoc = null;
    this.documentHash = '';

    if (this.container) {
      this.container.replaceChildren();
      this.container = null;
    }
    this.scrollContainer = null;
    this.annotations = [];
    this.onSelectionChange = undefined;
    this.onAnnotationResolution = undefined;
  }

  async getTableOfContents(): Promise<readonly TableOfContentsItem[]> {
    if (!this.pdfDoc) return [];
    try {
      const outline = (await this.pdfDoc.getOutline()) as readonly PdfOutlineNode[] | null;
      if (!outline || outline.length === 0) return [];
      return await mapPdfOutline(this.pdfDoc, outline, this.pageCount);
    } catch {
      return [];
    }
  }

  goToLocation(location: DocumentLocation): Promise<void> {
    if (location.format !== 'pdf') return Promise.resolve();
    const pageNum = location.pageIndex + 1;
    return this.goToPage(pageNum);
  }

  goToPage(pageNumber: number): Promise<void> {
    const clamped = Math.max(1, Math.min(this.pageCount, pageNumber));
    this.currentPage = clamped;
    const wrapper = this.pageWrappers.get(clamped);
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this.notifyLocationChange();
    return Promise.resolve();
  }

  private goToPageInstant(pageNumber: number): void {
    const clamped = Math.max(1, Math.min(this.pageCount, pageNumber));
    this.currentPage = clamped;
    const wrapper = this.pageWrappers.get(clamped);
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' });
    }
  }
  getReadingLocation(): { readonly location: DocumentLocation; readonly progress: number } {
    return {
      location: {
        format: 'pdf',
        pageIndex: this.currentPage - 1,
      },
      progress: this.getProgress(),
    };
  }

  getProgress(): number {
    if (this.pageCount <= 0) return 0;
    return Math.min(1.0, Math.max(0.0, this.currentPage / this.pageCount));
  }

  async search(query: string): Promise<readonly SearchMatch[]> {
    if (!this.pdfDoc || !query.trim()) return [];
    const normalizedQuery = query.toLowerCase().trim();
    const matches: SearchMatch[] = [];

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      // Deliberately untrimmed: this viewport-local find reports offsets in the
      // joined space, unlike the trimmed indexed space `extractText()` yields.
      const fullPageText = joinPdfTextItems(pdfTextItemStrings(textContent.items));

      let startIndex = 0;
      const lowerFull = fullPageText.toLowerCase();
      while (startIndex < lowerFull.length) {
        const found = lowerFull.indexOf(normalizedQuery, startIndex);
        if (found === -1) break;

        const prefixStart = Math.max(0, found - 40);
        const prefix = fullPageText.slice(prefixStart, found);
        const text = fullPageText.slice(found, found + query.length);
        const suffix = fullPageText.slice(found + query.length, found + query.length + 40);

        matches.push({
          id: `match-${String(pageNum)}-${String(found)}`,
          location: { format: 'pdf', pageIndex: pageNum - 1 },
          text,
          textStart: found,
          textEnd: found + query.length,
          prefix,
          suffix,
        });

        startIndex = found + query.length;
      }
    }

    return matches;
  }

  async applySearchHighlight(request: SearchHighlightRequest): Promise<SearchHighlightResult> {
    clearSearchHighlight(document);
    const location = request.anchor.location;
    if (
      request.documentId !== this.documentId ||
      (this.documentHash !== '' && request.documentHash !== this.documentHash) ||
      request.anchor.documentId !== request.documentId ||
      request.anchor.documentHash !== request.documentHash ||
      !searchAnchorMatchesQuery(request.anchor, request.query) ||
      location.format !== 'pdf'
    ) {
      return { status: 'stale', text: null, rangeCount: 0 };
    }
    const pageNumber = location.pageIndex + 1;
    if (pageNumber < 1 || pageNumber > this.pageCount || !request.query.trim()) {
      return { status: 'not-found', text: null, rangeCount: 0 };
    }
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    await this.goToLocation(location);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    await this.renderPage(pageNumber);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    const pdfDoc = this.pdfDoc;
    if (!pdfDoc) return { status: 'stale', text: null, rangeCount: 0 };
    // Fetch the item sequence before claiming the layer so the layer this
    // resolves against is the one that is live after the last await.
    const page = await pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent(PDF_TEXT_CONTENT_PARAMS);
    if (isSearchHighlightCancelled(request) || this.isClosed()) return { status: 'stale', text: null, rangeCount: 0 };
    const spaceMap = buildPdfTextSpaceMap(pdfTextItemStrings(textContent.items));
    const layer = await this.waitForTextLayer(pageNumber);
    if (!layer) return { status: 'not-found', text: null, rangeCount: 0 };
    if (isSearchHighlightCancelled(request) || this.isClosed()) return { status: 'stale', text: null, rangeCount: 0 };
    const ranges = resolvePdfSearchAnchorRanges(layer, spaceMap, request.anchor);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    if (ranges.length === 0) return { status: 'not-found', text: null, rangeCount: 0 };
    const rangeCount = applySearchHighlight(document, ranges);
    const firstRange = ranges[0];
    const target = firstRange?.startContainer instanceof Element
      ? firstRange.startContainer
      : firstRange?.startContainer.parentElement;
    target?.scrollIntoView({ behavior: 'auto', block: 'center' });
    return {
      status: rangeCount > 0 ? 'applied' : 'unsupported',
      text: rangeCount > 0 ? ranges.map((range) => range.toString()).join(' … ') : null,
      rangeCount,
    };
  }

  clearSearchHighlight(): void {
    clearSearchHighlight(document);
  }

  async *extractText(): AsyncIterable<NormalizedTextChunk> {
    if (!this.pdfDoc) return;
    let ordinal = 0;

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = pdfIndexedPageText(pdfTextItemStrings(textContent.items));

      if (text.length > 0) {
        const tokenCount = Math.ceil(text.length / 4);
        yield {
          id: `chunk-${this.documentId}-p${String(pageNum)}`,
          documentId: this.documentId,
          ordinal: ordinal++,
          text,
          tokenCount,
          location: { format: 'pdf', pageIndex: pageNum - 1 },
          heading: null,
          pageLabel: `Page ${String(pageNum)}`,
        };
      }
    }
  }

  async extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]> {
    if (!this.pdfDoc || location.format !== 'pdf') return [];
    const pageNum = location.pageIndex + 1;
    if (pageNum < 1 || pageNum > this.pageCount) return [];

    const page = await this.pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = pdfIndexedPageText(pdfTextItemStrings(textContent.items));

    return [
      {
        id: `chunk-${this.documentId}-p${String(pageNum)}`,
        documentId: this.documentId,
        ordinal: 0,
        text,
        tokenCount: Math.ceil(text.length / 4),
        location,
        heading: null,
        pageLabel: `Page ${String(pageNum)}`,
      },
    ];
  }

  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void> {
    const previousZoom = this.zoom;
    this.cancelPendingResizeSchedule();

    if (typeof zoom === 'string') {
      this.zoomMode = zoom;
      this.recalculateFitScale();
    } else {
      this.zoomMode = 'custom';
      this.zoom = Math.max(0.25, Math.min(5.0, zoom));
    }

    const scaleChanged = Math.abs(this.zoom - previousZoom) > 0.0001;
    if (!scaleChanged) {
      return Promise.resolve();
    }
    this.cancelAllScheduledTeardowns();
    this.renderEpoch += 1;
    for (const { task } of this.inFlightRenders.values()) {
      try {
        task.cancel();
      } catch {
        // Ignored
      }
    }
    this.inFlightRenders.clear();
    this.pendingRenderTokens.clear();
    this.renderedPages.clear();

    // No content clearing here: painted surfaces are preview-transformed and replaced atomically by renderPage.
    this.resizePageWrappers(this.zoom);
    for (const [pageNumber, renderedScale] of this.renderedScales) {
      const factor = this.zoom / renderedScale;
      if (Math.abs(factor - 1) < PREVIEW_FACTOR_EPSILON) {
        this.clearPreviewTransform(pageNumber);
      } else {
        this.applyPreviewFactor(pageNumber, factor);
      }
    }
    // Preview-transformed pages keep painted ranges without repainting, so
    // cached note-pointer rects from the previous scale must be dropped.
    notePointerInvalidateLayout();

    this.updateVisiblePages();
    return Promise.resolve();
  }

  getZoom(): number {
    return this.zoom;
  }

  getZoomMode(): ZoomMode {
    return this.zoomMode;
  }

  getPageCount(): number {
    return this.pageCount;
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  private computeFitZoom(): number | null {
    if (!this.container || this.pageDimensions.size === 0) return null;
    const firstDims = this.pageDimensions.get(1);
    if (!firstDims || firstDims.width <= 0 || firstDims.height <= 0) return null;

    const availableWidth = Math.max(200, this.container.clientWidth - 48);
    const availableHeight = Math.max(200, this.container.clientHeight - 64);

    let nextZoom: number;
    if (this.zoomMode === 'fit-width') {
      nextZoom = availableWidth / firstDims.width;
    } else if (this.zoomMode === 'fit-page') {
      const widthScale = availableWidth / firstDims.width;
      const heightScale = availableHeight / firstDims.height;
      nextZoom = Math.min(widthScale, heightScale);
    } else {
      return null;
    }
    return Math.max(0.25, Math.min(4.0, nextZoom));
  }

  private recalculateFitScale(): void {
    const computed = this.computeFitZoom();
    if (computed === null) return;
    this.zoom = computed;
  }

  private scheduleResizeRefit(): void {
    if (typeof window === 'undefined' || this.isClosed()) return;
    this.resizeRefitFrame ??= window.requestAnimationFrame(() => {
      this.resizeRefitFrame = null;
      if (this.isClosed()) return;
      const changed = this.applyLiveFitGeometry();
      if (!changed) return;
      if (this.resizeCommitTimer !== null) window.clearTimeout(this.resizeCommitTimer);
      this.resizeCommitTimer = window.setTimeout(() => {
        this.resizeCommitTimer = null;
        this.commitResizeRefit();
      }, PDF_RESIZE_COMMIT_DELAY_MS);
    });
  }

  private applyLiveFitGeometry(): boolean {
    if (this.isClosed()) return false;
    if (this.zoomMode !== 'fit-width' && this.zoomMode !== 'fit-page') return false;
    const targetZoom = this.computeFitZoom();
    if (targetZoom === null || Math.abs(targetZoom - this.zoom) <= FIT_SCALE_DEADBAND) return false;

    const anchor = this.captureViewportAnchor();
    this.zoom = targetZoom;
    this.resizePageWrappers(targetZoom);
    this.restoreViewportAnchor(anchor);
    for (const [pageNumber, renderedScale] of this.renderedScales) {
      this.applyPreviewFactor(pageNumber, targetZoom / renderedScale);
    }
    return true;
  }

  private commitResizeRefit(): void {
    this.cancelPendingResizeSchedule();
    if (this.isClosed()) return;
    if (this.zoomMode !== 'fit-width' && this.zoomMode !== 'fit-page') return;
    const targetZoom = this.computeFitZoom();
    if (targetZoom === null) return;

    this.cancelAllScheduledTeardowns();
    this.renderEpoch += 1;
    for (const { task } of this.inFlightRenders.values()) {
      try {
        task.cancel();
      } catch {
        // Ignored
      }
    }
    this.inFlightRenders.clear();
    this.pendingRenderTokens.clear();

    const anchor = this.captureViewportAnchor();
    this.zoom = targetZoom;
    this.resizePageWrappers(targetZoom);
    this.restoreViewportAnchor(anchor);

    // Sharp pages keep their surface and drop preview transforms; others keep their old paint and repaint once below.
    let needsRepaint = false;
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber++) {
      const renderedScale = this.renderedScales.get(pageNumber);
      if (
        renderedScale !== undefined &&
        this.renderedPages.has(pageNumber) &&
        Math.abs(renderedScale - targetZoom) < RENDERED_SCALE_EPSILON
      ) {
        this.clearPreviewTransform(pageNumber);
        continue;
      }
      needsRepaint = true;
      this.renderedPages.delete(pageNumber);
    }
    if (needsRepaint) {
      this.updateVisiblePages();
    }
  }

  private cancelPendingResizeSchedule(): void {
    if (typeof window !== 'undefined') {
      if (this.resizeRefitFrame !== null) {
        window.cancelAnimationFrame(this.resizeRefitFrame);
      }
      if (this.resizeCommitTimer !== null) {
        window.clearTimeout(this.resizeCommitTimer);
      }
    }
    this.resizeRefitFrame = null;
    this.resizeCommitTimer = null;
  }

  private resizePageWrappers(zoom: number): void {
    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const wrapper = this.pageWrappers.get(pageNum);
      const dims = this.pageDimensions.get(pageNum);
      if (!wrapper || !dims) continue;
      const placeholderScale = safePageScale(dims.width, dims.height, zoom);
      wrapper.style.width = `${String(Math.round(dims.width * placeholderScale))}px`;
      wrapper.style.height = `${String(Math.round(dims.height * placeholderScale))}px`;
      wrapper.style.minHeight = `${String(Math.round(dims.height * placeholderScale))}px`;
    }
  }

  /**
   * Fit-width resizing changes every wrapper's height. Preserve the document
   * point at the viewport centre so a side-panel resize behaves like visual
   * zoom instead of moving the reader to a different page.
   */
  private captureViewportAnchor(): PdfViewportAnchor | null {
    const scroller = this.scrollContainer;
    if (!scroller || this.pageCount === 0) return null;
    const documentY = scroller.scrollTop + scroller.clientHeight / 2;
    let selected = this.pageWrappers.get(this.currentPage) ?? null;
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber++) {
      const wrapper = this.pageWrappers.get(pageNumber);
      if (!wrapper) continue;
      const height = wrapper.offsetHeight || Number.parseFloat(wrapper.style.height) || 1;
      if (documentY >= wrapper.offsetTop && documentY <= wrapper.offsetTop + height) {
        selected = wrapper;
        break;
      }
    }
    if (!selected) return null;
    const pageNumber = Number.parseInt(selected.dataset.pageNumber ?? '', 10);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) return null;
    const height = selected.offsetHeight || Number.parseFloat(selected.style.height) || 1;
    return {
      pageNumber,
      pageProgress: Math.max(0, Math.min(1, (documentY - selected.offsetTop) / height)),
    };
  }

  private restoreViewportAnchor(anchor: PdfViewportAnchor | null): void {
    const scroller = this.scrollContainer;
    if (!scroller || !anchor) return;
    const wrapper = this.pageWrappers.get(anchor.pageNumber);
    if (!wrapper) return;
    const height = wrapper.offsetHeight || Number.parseFloat(wrapper.style.height) || 1;
    const target = wrapper.offsetTop + anchor.pageProgress * height - scroller.clientHeight / 2;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, target));
  }

  private pageSurfaceElements(pageNumber: number): readonly HTMLElement[] {
    const wrapper = this.pageWrappers.get(pageNumber);
    if (!wrapper) return [];
    const elements: HTMLElement[] = [];
    const canvas = wrapper.querySelector('canvas');
    if (canvas instanceof HTMLElement) elements.push(canvas);
    const textLayer = wrapper.querySelector('.textLayer');
    if (textLayer instanceof HTMLElement) elements.push(textLayer);
    const annotationLayer = wrapper.querySelector('.annotationLayer');
    if (annotationLayer instanceof HTMLElement) elements.push(annotationLayer);
    return elements;
  }

  private applyPreviewFactor(pageNumber: number, factor: number): void {
    if (Math.abs(factor - 1) < PREVIEW_FACTOR_EPSILON) {
      this.clearPreviewTransform(pageNumber);
      return;
    }
    const transform = `scale(${String(factor)})`;
    if (this.previewScales.get(pageNumber) === factor) return;
    for (const element of this.pageSurfaceElements(pageNumber)) {
      if (element.classList.contains('textLayer') || element.classList.contains('annotationLayer')) {
        // The text layer's `transform` belongs to the official
        // `[data-main-rotation]` rules; an inline transform here would drop the
        // rotation on /Rotate 90|270 pages. The stylesheet composes this
        // variable with the rotation instead, and already pins
        // `transform-origin: 0 0`.
        element.style.setProperty('--preview-scale', String(factor));
        continue;
      }
      element.style.transformOrigin = 'top left';
      element.style.transform = transform;
    }
    this.previewScales.set(pageNumber, factor);
  }

  private clearPreviewTransform(pageNumber: number): void {
    if (!this.previewScales.has(pageNumber)) return;
    for (const element of this.pageSurfaceElements(pageNumber)) {
      if (element.classList.contains('textLayer') || element.classList.contains('annotationLayer')) {
        element.style.removeProperty('--preview-scale');
        continue;
      }
      element.style.transformOrigin = '';
      element.style.transform = '';
    }
    this.previewScales.delete(pageNumber);
  }

  private setupIntersectionObserver(): void {
    if (!this.scrollContainer) {
      return;
    }

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number(entry.target.getAttribute('data-page-number'));
          if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > this.pageCount) {
            continue;
          }
          if (entry.isIntersecting) {
            this.cancelScheduledTeardown(pageNum);
            void this.renderPage(pageNum);
          } else {
            // Validate against live viewport geometry before destroying page content.
            // A stale asynchronous false entry (e.g. from initial measurement before layout settled)
            // must never synchronously tear down a page that is near or in the viewport.
            if (this.isPageNearViewport(pageNum)) {
              this.cancelScheduledTeardown(pageNum);
              void this.renderPage(pageNum);
            } else if (
              this.renderedPages.has(pageNum) ||
              this.pendingRenderTokens.has(pageNum) ||
              (this.pageWrappers.get(pageNum)?.childElementCount ?? 0) > 0
            ) {
              this.schedulePageTeardown(pageNum);
            }
          }
        }
      },
      {
        root: this.scrollContainer,
        rootMargin: '600px 0px 600px 0px', // Overscan buffer (+- ~2 pages)
        threshold: 0.01,
      }
    );

    for (const wrapper of this.pageWrappers.values()) {
      this.intersectionObserver.observe(wrapper);
    }
  }

  private schedulePageTeardown(pageNumber: number): void {
    this.cancelScheduledTeardown(pageNumber);
    if (typeof window === 'undefined') {
      this.destroyPageContent(pageNumber);
      return;
    }
    const handle = window.requestAnimationFrame(() => {
      this.scheduledTeardowns.delete(pageNumber);
      if (this.isClosed()) return;
      if (!this.isPageNearViewport(pageNumber)) {
        this.destroyPageContent(pageNumber);
      } else {
        void this.renderPage(pageNumber);
      }
    });
    this.scheduledTeardowns.set(pageNumber, handle);
  }

  private cancelScheduledTeardown(pageNumber: number): void {
    const handle = this.scheduledTeardowns.get(pageNumber);
    if (handle !== undefined) {
      if (typeof window !== 'undefined') {
        window.cancelAnimationFrame(handle);
      }
      this.scheduledTeardowns.delete(pageNumber);
    }
  }

  private cancelAllScheduledTeardowns(): void {
    if (typeof window !== 'undefined') {
      for (const handle of this.scheduledTeardowns.values()) {
        window.cancelAnimationFrame(handle);
      }
    }
    this.scheduledTeardowns.clear();
  }

  private isPageNearViewport(pageNumber: number): boolean {
    if (!this.scrollContainer) return false;
    const wrapper = this.pageWrappers.get(pageNumber);
    if (!wrapper) return false;

    const containerRect = this.scrollContainer.getBoundingClientRect();
    // If layout is not yet committed or container dimensions are zero (e.g. initial mount before paint)
    if (containerRect.height <= 0 && this.scrollContainer.clientHeight <= 0) {
      return Math.abs(pageNumber - this.currentPage) <= 2;
    }

    const overscanBuffer = 800; // px buffer above/below viewport
    const minVisible = containerRect.top - overscanBuffer;
    const maxVisible = containerRect.bottom + overscanBuffer;

    const rect = wrapper.getBoundingClientRect();
    if (rect.height <= 0 && rect.width <= 0) {
      return Math.abs(pageNumber - this.currentPage) <= 2;
    }

    return rect.bottom >= minVisible && rect.top <= maxVisible;
  }

  private updateVisiblePages(): void {
    if (!this.scrollContainer || this.pageCount === 0) return;

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const isNear = this.isPageNearViewport(pageNum);
      const rendered = this.renderedPages.has(pageNum);
      const pending = this.pendingRenderTokens.has(pageNum);
      const childCount = this.pageWrappers.get(pageNum)?.childElementCount ?? 0;
      if (isNear) {
        this.cancelScheduledTeardown(pageNum);
        void this.renderPage(pageNum);
      } else if (rendered || pending || childCount > 0) {
        // Virtualize: destroy offscreen page content to preserve memory
        this.destroyPageContent(pageNum);
      }
    }
  }
  protected async renderPage(pageNumber: number): Promise<void> {
    this.cancelScheduledTeardown(pageNumber);
    if (
      this.isDestroyed ||
      !this.pdfDoc ||
      this.renderedPages.has(pageNumber) ||
      this.pendingRenderTokens.has(pageNumber)
    ) {
      return;
    }

    const wrapper = this.pageWrappers.get(pageNumber);
    if (!wrapper) return;

    const pdfDoc = this.pdfDoc;
    // Fixed at dispatch: live resize may advance this.zoom while this render is in flight.
    const renderScale = this.zoom;
    const token = Symbol(`pdf-render-${String(pageNumber)}`);
    const epoch = this.renderEpoch;
    this.pendingRenderTokens.set(pageNumber, token);

    let provisionalCanvas: HTMLCanvasElement | null = null;
    let provisionalBuilder: TextLayerBuilder | null = null;
    let provisionalAnnotationLayer: HTMLDivElement | null = null;

    try {
      const page = await pdfDoc.getPage(pageNumber);
      if (!this.isRenderCurrent(pageNumber, token, epoch)) return;

      const viewport = page.getViewport({ scale: renderScale });
      const unitViewport = page.getViewport({ scale: 1 });
      this.pageDimensions.set(pageNumber, {
        width: unitViewport.width,
        height: unitViewport.height,
        aspectRatio: viewport.height / viewport.width,
      });
      wrapper.style.width = `${String(Math.round(viewport.width))}px`;
      wrapper.style.height = `${String(Math.round(viewport.height))}px`;
      wrapper.style.minHeight = `${String(Math.round(viewport.height))}px`;

      // Completed surface underneath enables double buffering; empty wrapper means first paint attaches immediately.
      const priorSurface = wrapper.querySelector('canvas');
      const doubleBuffered = priorSurface !== null;

      // Create Canvas Layer
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas block absolute inset-0';
      canvas.setAttribute('data-testid', `pdf-canvas-p${String(pageNumber)}`);

      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const outputScale = safeCanvasScale(viewport.width, viewport.height, dpr);
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${String(Math.round(viewport.width))}px`;
      canvas.style.height = `${String(Math.round(viewport.height))}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (outputScale !== 1) {
        ctx.scale(outputScale, outputScale);
      }

      if (!this.isRenderCurrent(pageNumber, token, epoch)) return;

      if (!doubleBuffered) {
        provisionalCanvas = canvas;
        wrapper.appendChild(canvas);
      }

      // Execute PDF.js Canvas Render Task
      const renderTask = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      });
      this.inFlightRenders.set(pageNumber, { task: renderTask, token });

      await renderTask.promise;
      if (!this.isRenderCurrent(pageNumber, token, epoch)) return;

      // Official viewer text layer. PDF.js owns glyph geometry, the
      // `.endOfContent` sentinel, the `selecting` class, the copy handler and
      // the shared document selection listener; the adapter owns only lifetime.
      //
      // No `abortSignal` is passed, deliberately. Upstream funnels that one
      // option into two different lifetimes inside `#bindMouse`: it scopes the
      // per-div `mousedown`/`copy` listeners *and* it is folded into the
      // static, document-wide selection listener via
      // `AbortSignal.any([staticAC.signal, abortSignal])` by whichever builder
      // happens to install that listener. Neither scope works here:
      //
      //  - A per-page controller aborts on the first swap or virtualization
      //    teardown. If that page was the one that installed the static
      //    listener, the composite signal fires and every *surviving* page
      //    silently loses `selectionchange`/`pointerup` handling — and upstream
      //    never reinstalls it, because its own controller is still non-null.
      //  - A document-lifetime controller (what `PDFPageView` uses, where pages
      //    are not repeatedly discarded) keeps every retired layer's listeners
      //    registered against a signal that outlives them, so each zoom
      //    rerender and each scrolled-away page strands a detached div and its
      //    builder until `close()`.
      //
      // Passing nothing gives each scope its correct owner: the div listeners
      // live exactly as long as the div (a self-contained cycle that dies with
      // `cancelTextLayerBuilder`), and the static listener stays under PDF.js's
      // own refcount, which `destroyAllTextLayers()` drives to zero on close.
      const builder = new TextLayerBuilder({ pdfPage: page });
      provisionalBuilder = builder;
      const textLayerDiv = builder.div;
      // PDF.js emits text geometry in unscaled PDF points and applies the page
      // scale through this custom property (`setLayerDimensions`). It is pinned
      // to the scale this layer was built at rather than the live zoom, so the
      // preview transform below keeps text locked to its own canvas until a
      // sharper repaint commits.
      textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale));
      textLayerDiv.setAttribute('data-testid', `pdf-textlayer-p${String(pageNumber)}`);

      if (!doubleBuffered) {
        // Original progressive order: shell attached, then filled in place.
        wrapper.appendChild(textLayerDiv);
      }

      await textLayerRenderer(builder).render({
        viewport,
        // `TextLayerBuilder` defaults to `disableNormalization: true`, which is
        // right for the standalone viewer but wrong here: `search()`,
        // `extractText()` and `normalizedTextChunks()` all read
        // `page.getTextContent()`, whose default *is* normalized. Ligatures are
        // the visible case — U+FB00 arrives as "ff" (2 chars) from
        // `getTextContent()` but as "ﬀ" (1 char) from the builder default — so
        // an un-normalized DOM would shift every search hit and stored
        // annotation offset on such a page relative to the extraction space.
        // Passing our own object replaces upstream's default wholesale, so
        // `includeMarkedContent` has to be restated to keep the official
        // marked-content DOM structure. `applySearchHighlight` re-reads the
        // page with the same constant so its item sequence is this layer's.
        //
        // Do not flip this back to the upstream default to accommodate an
        // anchor stored in the raw glyph space: every annotation resolved
        // against this layer since the normalized contract landed would shift
        // by one character per preceding ligature. `resolvePdfAnnotationAnchor`
        // normalizes such quotes instead, which recovers them without moving
        // the space anything else is anchored in.
        textContentParams: PDF_TEXT_CONTENT_PARAMS,
      });
      if (!this.isRenderCurrent(pageNumber, token, epoch)) return;

      // Link annotation layer rendering:
      let annotationLayerDiv: HTMLDivElement | null = null;
      try {
        const rawAnnotations = (await page.getAnnotations({ intent: 'display' })) as readonly RawPdfAnnotation[];
        if (!this.isRenderCurrent(pageNumber, token, epoch)) return;

        const linkAnnotations = rawAnnotations.filter(
          (annot) =>
            (annot.annotationType === pdfjsLib.AnnotationType.LINK || annot.subtype === 'Link') &&
            !annot.noHTML &&
            (annot.dest !== undefined || (typeof annot.url === 'string' && parseSafeExternalUrl(annot.url) !== null))
        );

        if (linkAnnotations.length > 0) {
          annotationLayerDiv = document.createElement('div');
          annotationLayerDiv.className = 'annotationLayer';
          annotationLayerDiv.setAttribute('data-testid', `pdf-annotationlayer-p${String(pageNumber)}`);
          annotationLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale));
          provisionalAnnotationLayer = annotationLayerDiv;

          const layer = new pdfjsLib.AnnotationLayer({
            div: annotationLayerDiv,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            linkService: this.linkService as never,
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: null,
            structTreeLayer: null,
            commentManager: null,
            annotationStorage: null,
          });

          await layer.render({
            div: annotationLayerDiv,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            annotations: linkAnnotations,
            linkService: this.linkService as never,
            renderForms: false,
          });
          if (!this.isRenderCurrent(pageNumber, token, epoch)) return;
          enhanceLinkAnnotations(annotationLayerDiv);
        }
      } catch (annotErr) {
        console.warn(`Failed to render link annotations for page ${String(pageNumber)}:`, annotErr);
      }

      // Retire the previous layer before the new one is registered so the swap
      // never leaves two builders claiming the same page.
      this.destroyTextLayer(pageNumber);
      this.destroyAnnotationLayer(pageNumber);
      if (doubleBuffered) {
        // Atomic swap: the old painted surface and its preview transform die here together.
        const children: HTMLElement[] = [canvas, textLayerDiv];
        if (annotationLayerDiv) children.push(annotationLayerDiv);
        wrapper.replaceChildren(...children);
      } else {
        if (annotationLayerDiv) wrapper.appendChild(annotationLayerDiv);
      }
      this.textLayerBuilders.set(pageNumber, builder);
      if (annotationLayerDiv) {
        this.annotationLayerDivs.set(pageNumber, annotationLayerDiv);
      }
      this.renderedPages.add(pageNumber);
      this.renderedScales.set(pageNumber, renderScale);
      // Surface may lag zoom after mid-flight resize; preview until commit repaints sharp.
      this.applyPreviewFactor(pageNumber, this.zoom / renderScale);
      void this.refreshAnnotations();
    } catch (err) {
      // First-paint failure drops only this render's provisional nodes; preserved surfaces stay untouched.
      if (
        this.isRenderCurrent(pageNumber, token, epoch) &&
        provisionalCanvas?.parentElement === wrapper
      ) {
        this.destroyTextLayer(pageNumber);
        this.destroyAnnotationLayer(pageNumber);
        wrapper.replaceChildren();
      }
      if (err instanceof pdfjsLib.RenderingCancelledException) {
        // Expected cancellation on fast scroll or zoom change
        return;
      }
      console.warn('PDF page rendering failed.', err);
    } finally {
      // Any builder that never became this page's registered layer — stale
      // render, cancellation, or failure — still has to release its PDF.js
      // selection registration and drop out of the DOM.
      if (provisionalBuilder && this.textLayerBuilders.get(pageNumber) !== provisionalBuilder) {
        cancelTextLayerBuilder(provisionalBuilder);
      }
      if (
        provisionalAnnotationLayer &&
        this.annotationLayerDivs.get(pageNumber) !== provisionalAnnotationLayer
      ) {
        provisionalAnnotationLayer.remove();
      }
      if (this.pendingRenderTokens.get(pageNumber) === token) {
        this.pendingRenderTokens.delete(pageNumber);
      }
      if (this.inFlightRenders.get(pageNumber)?.token === token) {
        this.inFlightRenders.delete(pageNumber);
      }
    }
  }

  /** Cancels and detaches the registered text layer for a page, if any. */
  private destroyTextLayer(pageNumber: number): void {
    const builder = this.textLayerBuilders.get(pageNumber);
    if (!builder) return;
    this.textLayerBuilders.delete(pageNumber);
    cancelTextLayerBuilder(builder);
  }

  private destroyAllTextLayers(): void {
    for (const builder of this.textLayerBuilders.values()) {
      cancelTextLayerBuilder(builder);
    }
    this.textLayerBuilders.clear();
  }

  private isRenderCurrent(pageNumber: number, token: symbol, epoch: number): boolean {
    return (
      !this.isClosed() &&
      this.renderEpoch === epoch &&
      this.pendingRenderTokens.get(pageNumber) === token
    );
  }

  protected destroyPageContent(pageNumber: number): void {
    this.pendingRenderTokens.delete(pageNumber);
    const render = this.inFlightRenders.get(pageNumber);
    if (render) {
      try {
        render.task.cancel();
      } catch {
        // Ignored
      }
      this.inFlightRenders.delete(pageNumber);
    }

    this.renderedPages.delete(pageNumber);
    this.renderedScales.delete(pageNumber);
    this.previewScales.delete(pageNumber);
    this.destroyTextLayer(pageNumber);
    this.destroyAnnotationLayer(pageNumber);
    const wrapper = this.pageWrappers.get(pageNumber);
    if (wrapper) {
      wrapper.replaceChildren(); // Removes canvas and textLayer, placeholder height preserved
    }
  }
  private handleScroll(): void {
    if (!this.scrollContainer) return;
    const targetY = this.scrollContainer.scrollTop + this.scrollContainer.clientHeight / 3;

    let closestPage = this.currentPage;
    let minDistance = Number.POSITIVE_INFINITY;
    let low = 1;
    let high = this.pageCount;
    while (low <= high) {
      const pageNum = Math.floor((low + high) / 2);
      const wrapper = this.pageWrappers.get(pageNum);
      if (!wrapper) break;
      const pageTop = wrapper.offsetTop;
      const distance = Math.abs(pageTop - targetY);
      if (distance < minDistance) {
        minDistance = distance;
        closestPage = pageNum;
      }
      if (pageTop < targetY) {
        low = pageNum + 1;
      } else {
        high = pageNum - 1;
      }
    }

    if (closestPage !== this.currentPage) {
      this.currentPage = closestPage;
      this.notifyLocationChange();
    }

    if (!this.intersectionObserver) {
      this.updateVisiblePages();
    }
  }

  private notifyLocationChange(): void {
    this.onLocationChange?.(
      { format: 'pdf', pageIndex: this.currentPage - 1 },
      this.getProgress()
    );
  }

  private installSelectionListener(): void {
    if (this.selectionListener) document.removeEventListener('selectionchange', this.selectionListener);
    this.selectionListener = null;
    if (!this.onSelectionChange || !this.scrollContainer) return;
    this.selectionListener = () => {
      const result = this.captureSelection();
      this.onSelectionChange?.(result.selection, result.error);
    };
    document.addEventListener('selectionchange', this.selectionListener);
  }
  private captureSelection(): { selection: ReaderSelection | null; error: SelectionIssue | null } {
    const selection = document.getSelection();
    if (selection?.rangeCount !== 1 || selection.isCollapsed || !this.scrollContainer) {
      return { selection: null, error: null };
    }
    const range = selection.getRangeAt(0);
    const nativeSelectedText = selection.toString();
    const startElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const endElement = range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;
    const startWrapper = startElement?.closest<HTMLElement>('.pdf-page-wrapper');
    const endWrapper = endElement?.closest<HTMLElement>('.pdf-page-wrapper');
    if (!startWrapper || !endWrapper || !this.scrollContainer.contains(startWrapper) || !this.scrollContainer.contains(endWrapper)) {
      return { selection: null, error: null };
    }

    const startPageNumber = Number(startWrapper.dataset.pageNumber);
    const endPageNumber = Number(endWrapper.dataset.pageNumber);
    if (!Number.isInteger(startPageNumber) || !Number.isInteger(endPageNumber)) return { selection: null, error: null };

    const minPage = Math.min(startPageNumber, endPageNumber);
    const maxPage = Math.max(startPageNumber, endPageNumber);

    if (minPage === maxPage) {
      const layer = startWrapper.querySelector<HTMLElement>('.textLayer');
      if (!layer?.isConnected) {
        return {
          selection: null,
          error: {
            code: 'stale_layer',
            message: 'The document text layer updated during selection. Please try selecting again.',
          },
        };
      }
      const subRange = subRangeWithin(layer, range);
      if (!subRange) return { selection: null, error: null };
      const offsets = rangeOffsetsWithin(layer, subRange);
      const quote = quoteContextForRange(layer, subRange);
      if (!offsets || !quote) return { selection: null, error: null };
      const rects = this.normalizedRects(subRange, startWrapper);
      if (rects.length === 0) return { selection: null, error: null };
      const rect = range.getBoundingClientRect();
      const pageLabel = String(minPage);
      const selectedText = nativeSelectedText || quote.exact;
      const chatDescriptor: PdfChatSelectionDescriptor = {
        format: 'pdf',
        startPageIndex: minPage - 1,
        endPageIndex: minPage - 1,
        startPageLabel: pageLabel,
        endPageLabel: pageLabel,
        startQuote: boundedQuoteContext(quote),
        endQuote: boundedQuoteContext(quote),
        startTextOffset: offsets.start,
        endTextOffset: offsets.end,
        selectedTextSnippet: takeCodePointPrefix(selectedText, 500),
      };
      const anchor: PdfAnnotationAnchor = {
        format: 'pdf',
        quote,
        pageIndex: minPage - 1,
        pageLabel,
        rects,
        textStart: offsets.start,
        textEnd: offsets.end,
      };
      return {
        selection: {
          selectedText: takeCodePointPrefix(selectedText, MAX_NATIVE_SELECTION_TEXT_LENGTH),
          totalSelectedLength: selectedText.length,
          chatDescriptor,
          anchor: selectedText.length <= 256_000 ? anchor : null,
          clientRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        },
        error: null,
      };
    }

    const rawSegments: PdfAnchorSegment[] = [];

    for (let pageNum = minPage; pageNum <= maxPage; pageNum++) {
      const wrapper = this.pageWrappers.get(pageNum);
      const layer = wrapper?.querySelector<HTMLElement>('.textLayer');
      if (!wrapper || !layer?.isConnected) continue;
      const subRange = subRangeWithin(layer, range);
      if (!subRange) continue;
      const offsets = rangeOffsetsWithin(layer, subRange);
      const quote = quoteContextForRange(layer, subRange);
      if (!offsets || !quote || quote.exact.length === 0) continue;
      const rects = this.normalizedRects(subRange, wrapper);
      rawSegments.push({
        pageIndex: pageNum - 1,
        pageLabel: String(pageNum),
        quote,
        ...(rects.length > 0 ? { rects } : {}),
        textStart: offsets.start,
        textEnd: offsets.end,
      });
    }

    const firstRaw = rawSegments[0];
    const lastRaw = rawSegments[rawSegments.length - 1];
    const chatDescriptor: PdfChatSelectionDescriptor = {
      format: 'pdf',
      startPageIndex: minPage - 1,
      endPageIndex: maxPage - 1,
      startPageLabel: String(minPage),
      endPageLabel: String(maxPage),
      ...(firstRaw?.quote ? { startQuote: boundedQuoteContext(firstRaw.quote) } : {}),
      ...(lastRaw?.quote ? { endQuote: boundedQuoteContext(lastRaw.quote) } : {}),
      ...(firstRaw?.textStart !== undefined ? { startTextOffset: firstRaw.textStart } : {}),
      ...(lastRaw?.textEnd !== undefined ? { endTextOffset: lastRaw.textEnd } : {}),
      selectedTextSnippet: takeCodePointPrefix(nativeSelectedText, 500),
    };

    let anchor: PdfAnnotationAnchor | null = null;
    const isWithinAnnotationBounds =
      maxPage - minPage + 1 <= 50 && nativeSelectedText.length <= 256_000;

    if (isWithinAnnotationBounds && rawSegments.length > 0) {
      if (rawSegments.length === 1 && rawSegments[0]) {
        const seg = rawSegments[0];
        anchor = {
          format: 'pdf',
          quote: seg.quote,
          pageIndex: seg.pageIndex,
          ...(seg.pageLabel !== undefined ? { pageLabel: seg.pageLabel } : {}),
          ...(seg.rects ? { rects: seg.rects } : {}),
          ...(seg.textStart !== undefined ? { textStart: seg.textStart } : {}),
          ...(seg.textEnd !== undefined ? { textEnd: seg.textEnd } : {}),
        };
      } else {
        const partition = partitionMultiSegmentText(rawSegments, nativeSelectedText);
        if (partition.ok) {
          const segments = partition.segments;
          const fullSelectedText = partition.reconstructedText;
          const firstSegment = segments[0];
          const lastSegment = segments[segments.length - 1];
          if (firstSegment && lastSegment) {
            const pageLabel = `${String(minPage)}–${String(maxPage)}`;
            const topLevelQuote: QuoteContext = {
              exact: takeCodePointPrefix(fullSelectedText, 256_000),
              prefix: firstSegment.quote.prefix,
              suffix: lastSegment.quote.suffix,
            };
            anchor = {
              format: 'pdf',
              quote: topLevelQuote,
              pageIndex: firstSegment.pageIndex,
              pageLabel,
              ...(firstSegment.rects ? { rects: firstSegment.rects } : {}),
              ...(firstSegment.textStart !== undefined ? { textStart: firstSegment.textStart } : {}),
              ...(firstSegment.textEnd !== undefined ? { textEnd: firstSegment.textEnd } : {}),
              segments: [...segments],
            };
          }
        }
      }
    }

    const rect = typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    return {
      selection: {
        selectedText: takeCodePointPrefix(nativeSelectedText, MAX_NATIVE_SELECTION_TEXT_LENGTH),
        totalSelectedLength: nativeSelectedText.length,
        chatDescriptor,
        anchor,
        clientRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      },
      error: null,
    };
  }

  async setAnnotations(annotations: readonly Annotation[]): Promise<readonly AnnotationAnchorResolution[]> {
    this.annotations = annotations.filter((annotation) => annotation.anchor.format === 'pdf');
    return this.refreshAnnotations();
  }

  getAnnotationScope(): { readonly format: 'pdf'; readonly pageStart: number; readonly pageEnd: number } | null {
    if (this.pageCount <= 0) return null;
    const pageIndex = this.currentPage - 1;
    return {
      format: 'pdf',
      pageStart: Math.max(0, pageIndex - 2),
      pageEnd: Math.min(this.pageCount - 1, pageIndex + 2),
    };
  }

  async goToAnnotation(annotation: Annotation): Promise<void> {
    if (annotation.anchor.format !== 'pdf') return;
    const anchor = annotation.anchor;
    const pageNumber = anchor.pageIndex + 1;
    if (pageNumber < 1 || pageNumber > this.pageCount) return;

    await this.goToLocation(anchorToLocation(anchor));
    await this.renderPage(pageNumber);
    const layer = await this.waitForTextLayer(pageNumber);
    if (layer && anchor.quote.exact.length > 0) {
      const resolution = await resolvePdfAnnotationAnchor(layer.textContent, anchor.quote, {
        ...(anchor.textStart !== undefined && anchor.textEnd !== undefined
          ? { nativeRange: { start: anchor.textStart, end: anchor.textEnd } }
          : {}),
        priorOffset: anchor.textStart ?? 0,
      });
      const range = resolution ? rangeFromOffsets(layer, resolution) : null;
      const target = range?.startContainer instanceof Element
        ? range.startContainer
        : range?.startContainer.parentElement;
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'center' });
        return;
      }
    }

    const rect = anchor.rects?.[0];
    const wrapper = this.pageWrappers.get(pageNumber);
    if (rect && wrapper && this.scrollContainer) {
      const top = wrapper.offsetTop + rect.y * wrapper.offsetHeight - this.scrollContainer.clientHeight / 2;
      this.scrollContainer.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    }
  }

  private async waitForTextLayer(pageNumber: number): Promise<HTMLElement | null> {
    for (let attempt = 0; attempt < 200 && !this.isClosed(); attempt++) {
      const layer = this.pageWrappers
        .get(pageNumber)
        ?.querySelector<HTMLElement>('.textLayer');
      if (layer) return layer;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    }
    return null;
  }

  private async refreshAnnotations(): Promise<readonly AnnotationAnchorResolution[]> {
    const sequence = ++this.annotationSequence;
    const results: AnnotationAnchorResolution[] = [];
    const painted: { annotation: Annotation; range: Range }[] = [];
    for (const annotation of this.annotations) {
      const anchor = annotation.anchor as PdfAnnotationAnchor;
      if (anchor.segments && anchor.segments.length > 0) {
        const repairedSegments: PdfAnchorSegment[] = [];
        let anyAnchored = false;
        let bestStage: AnnotationAnchorResolution['stage'] = 'unanchored';

        for (const segment of anchor.segments) {
          if (segment.pageIndex < 0 || segment.pageIndex >= this.pageCount) {
            repairedSegments.push(segment);
            continue;
          }
          const layer = this.pageWrappers.get(segment.pageIndex + 1)?.querySelector<HTMLElement>('.textLayer');
          if (!layer) {
            repairedSegments.push(segment);
            continue;
          }
          const resolution = await resolvePdfAnnotationAnchor(layer.textContent, segment.quote, {
            ...(segment.textStart !== undefined && segment.textEnd !== undefined
              ? { nativeRange: { start: segment.textStart, end: segment.textEnd } }
              : {}),
            priorOffset: segment.textStart ?? 0,
          });
          if (sequence !== this.annotationSequence) return [];
          if (!resolution) {
            repairedSegments.push(segment);
            continue;
          }
          anyAnchored = true;
          if (resolution.stage === 'native' || bestStage === 'unanchored' || bestStage === 'fuzzy') {
            bestStage = resolution.stage;
          }
          const range = rangeFromOffsets(layer, resolution);
          const wrapper = this.pageWrappers.get(segment.pageIndex + 1);
          const rects = range && wrapper ? this.normalizedRects(range, wrapper) : segment.rects;
          repairedSegments.push({
            ...segment,
            textStart: resolution.start,
            textEnd: resolution.end,
            ...(rects && rects.length > 0 ? { rects } : {}),
          });
          if (range) painted.push({ annotation, range });
        }

        const firstRepaired = repairedSegments[0] ?? anchor;
        const repairedAnchor: PdfAnnotationAnchor = {
          ...anchor,
          pageIndex: firstRepaired.pageIndex,
          ...(firstRepaired.textStart !== undefined ? { textStart: firstRepaired.textStart } : {}),
          ...(firstRepaired.textEnd !== undefined ? { textEnd: firstRepaired.textEnd } : {}),
          ...(firstRepaired.rects && firstRepaired.rects.length > 0 ? { rects: firstRepaired.rects } : {}),
          segments: repairedSegments,
        };
        const result: AnnotationAnchorResolution = {
          annotationId: annotation.id,
          status: anyAnchored ? 'anchored' : annotation.status,
          anchor: repairedAnchor,
          stage: bestStage,
        };
        results.push(result);
        this.onAnnotationResolution?.(result);
        continue;
      }

      // Single segment / legacy anchor
      if (anchor.pageIndex < 0 || anchor.pageIndex >= this.pageCount) {
        const result: AnnotationAnchorResolution = {
          annotationId: annotation.id,
          status: 'unanchored',
          anchor,
          stage: 'unanchored',
        };
        results.push(result);
        this.onAnnotationResolution?.(result);
        continue;
      }
      const layer = this.pageWrappers
        .get(anchor.pageIndex + 1)
        ?.querySelector<HTMLElement>('.textLayer');
      if (!layer) continue;
      const resolution = await resolvePdfAnnotationAnchor(layer.textContent, anchor.quote, {
        ...(anchor.textStart !== undefined && anchor.textEnd !== undefined
          ? { nativeRange: { start: anchor.textStart, end: anchor.textEnd } }
          : {}),
        priorOffset: anchor.textStart ?? 0,
      });
      if (sequence !== this.annotationSequence) return [];
      if (!resolution) {
        const result: AnnotationAnchorResolution = {
          annotationId: annotation.id,
          status: 'unanchored',
          anchor,
          stage: 'unanchored',
        };
        results.push(result);
        this.onAnnotationResolution?.(result);
        continue;
      }
      const range = rangeFromOffsets(layer, resolution);
      const wrapper = this.pageWrappers.get(anchor.pageIndex + 1);
      const rects = range && wrapper ? this.normalizedRects(range, wrapper) : anchor.rects;
      const repairedAnchor: PdfAnnotationAnchor = {
        ...anchor,
        textStart: resolution.start,
        textEnd: resolution.end,
        ...(rects && rects.length > 0 ? { rects } : {}),
      };
      const result: AnnotationAnchorResolution = {
        annotationId: annotation.id,
        status: 'anchored',
        anchor: repairedAnchor,
        stage: resolution.stage,
      };
      results.push(result);
      this.onAnnotationResolution?.(result);
      if (range) painted.push({ annotation, range });
    }
    if (sequence === this.annotationSequence) paintAnchoredRanges(this, document, painted);
    return results;
  }

  private normalizedRects(range: Range, wrapper: HTMLElement): NormalizedRect[] {
    const bounds = wrapper.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    return Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .slice(0, 256)
      .map((rect) => {
        const x = Math.max(0, Math.min(1, (rect.left - bounds.left) / bounds.width));
        const y = Math.max(0, Math.min(1, (rect.top - bounds.top) / bounds.height));
        const right = Math.max(x, Math.min(1, (rect.right - bounds.left) / bounds.width));
        const bottom = Math.max(y, Math.min(1, (rect.bottom - bounds.top) / bounds.height));
        return { x, y, width: right - x, height: bottom - y };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0);
  }
}
