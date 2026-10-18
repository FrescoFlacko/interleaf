import type {
  DocumentFormat,
  DocumentLocation,
  EpubChatSelectionDescriptor,
  MobiChatSelectionDescriptor,
  NormalizedTextChunk,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
import type {
  AnnotationAnchorResolution,
  AnnotationResolutionCallback,
  DocumentAdapter,
  DocumentAdapterCapabilities,
  DocumentSource,
  ReaderSelection,
  ReflowOptions,
  SearchHighlightRequest,
  SearchHighlightResult,
  SelectionChangeCallback,
  SelectionIssue,
} from '../types';
import { isSearchHighlightCancelled } from '../types';
import type {
  Annotation,
  EpubAnnotationAnchor,
  MobiAnnotationAnchor,
  QuoteContext,
} from '@shared/types/annotation';
import { takeCodePointPrefix } from '@shared/agent-context';
import { View, type Ebook } from './foliate/view';
import type { EbookNavigationTarget } from './foliate/paginator';
import * as CFI from './foliate/epubcfi';
import {
  anchorToLocation,
  boundedQuoteContext,
  clearDomHighlights,
  quoteContextForRange,
  rangeFromOffsets,
  rangesForSearchAnchor,
  rangeOffsetsWithin,
  subRangeWithin,
} from '../annotations/dom-anchors';
import { notePointerDetachOwner, notePointerInvalidateLayout, paintAnchoredRanges } from '../annotations/note-pointer';
import { resolveTextAnchor } from '../annotations/text-anchor-resolver';
import { applySearchHighlight, clearSearchHighlight } from '../annotations/search-highlight';
import { searchAnchorMatchesQuery } from '@shared/search/match-anchor';

const MAX_EBOOK_BYTES = 256 * 1024 * 1024;

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes = MAX_EBOOK_BYTES
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('This ebook is too large to open safely.');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('ebook size limit exceeded');
        throw new Error('This ebook is too large to open safely.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export abstract class EbookBaseAdapter<TBook extends Ebook = Ebook> implements DocumentAdapter {
  abstract readonly format: DocumentFormat;
  /** Ebook text reflows; its links stay inside the book. */
  readonly capabilities: DocumentAdapterCapabilities = { reflow: this, externalLinks: null };

  protected container: HTMLElement | null = null;
  protected view: View | null = null;
  protected book: TBook | null = null;
  protected documentId = '';
  protected documentHash = '';
  protected isDestroyed = false;
  protected zoom = 1.0;
  protected zoomMode: ZoomMode = 'fit-width';
  protected currentPage = 1;
  protected pageCount = 1;
  protected currentProgress = 0;
  protected lineHeight = 1.65;
  protected horizontalMarginRem = 2.5;
  protected fontSize = 1;
  protected fontFamily: ReflowOptions['fontFamily'] = 'system';
  protected contentWidth = 72;
  protected paragraphSpacing = 0.8;
  protected currentLocationDetail: string | number | undefined;
  protected onLocationChange?: ((location: DocumentLocation, progress: number) => void) | undefined;
  private openSequence = 0;
  private openController: AbortController | null = null;
  private annotations: readonly Annotation[] = [];
  private annotationSequence = 0;
  private selectionDocument: Document | null = null;
  private selectionListener: (() => void) | null = null;
  private rendererLoadListener: (() => void) | null = null;
  private onSelectionChange?: SelectionChangeCallback | undefined;
  private onAnnotationResolution?: ((result: AnnotationAnchorResolution) => void) | undefined;

  setLocationChangeCallback(callback: ((location: DocumentLocation, progress: number) => void) | null): void {
    this.onLocationChange = callback ?? undefined;
  }

  setSelectionChangeCallback(callback: SelectionChangeCallback | null): void {
    this.onSelectionChange = callback ?? undefined;
    this.installSelectionListener();
  }

  setAnnotationResolutionCallback(callback: AnnotationResolutionCallback | null): void {
    this.onAnnotationResolution = callback ?? undefined;
  }

  protected async fetchBuffer(assetUrl: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (assetUrl.startsWith('data:')) {
      const separatorIndex = assetUrl.indexOf(',');
      const metadata = separatorIndex >= 0 ? assetUrl.slice(0, separatorIndex) : '';
      const base64Data = separatorIndex >= 0 ? assetUrl.slice(separatorIndex + 1) : '';
      if (!metadata.endsWith(';base64') || !base64Data) {
        throw new Error('The ebook asset is not a valid base64 data URL.');
      }
      if (Math.ceil((base64Data.length * 3) / 4) > MAX_EBOOK_BYTES) {
        throw new Error('This ebook is too large to open safely.');
      }

      try {
        // Renderer code MUST NOT reference Node Buffer (AGENTS.md §1 invariant 5).
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          if ((i & 0xfffff) === 0) signal.throwIfAborted();
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
      } catch {
        throw new Error('The ebook asset contains invalid base64 data.');
      }
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(assetUrl);
    } catch {
      throw new Error('The ebook asset URL is invalid.');
    }
    if (parsedUrl.protocol !== 'interleaf-media:') {
      throw new Error('The ebook asset URL uses an unsupported protocol.');
    }

    const response = await fetch(assetUrl, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to load the ebook asset (HTTP ${String(response.status)}).`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EBOOK_BYTES) {
      throw new Error('This ebook is too large to open safely.');
    }
    return readBoundedResponseBytes(response);
  }

  abstract createBook(buffer: Uint8Array, signal: AbortSignal): Promise<TBook>;
  abstract buildLocation(sectionIndex: number, cfiOrOffset?: string | number, progress?: number): DocumentLocation;
  abstract resolveLocationTarget(location: DocumentLocation): EbookNavigationTarget | number | null;
  abstract getTableOfContents(): Promise<readonly TableOfContentsItem[]>;

  async open(containerElement: HTMLElement, source: DocumentSource): Promise<void> {
    const sequence = ++this.openSequence;
    this.openController?.abort();
    this.detachRendererListeners();
    const openController = new AbortController();
    this.openController = openController;
    if (this.view) {
      this.view.close();
      this.view.element.remove();
      this.view = null;
    }
    if (this.book) {
      this.book.destroy();
      this.book = null;
    }
    this.container = containerElement;
    this.documentId = source.documentId;
    this.documentHash = source.documentHash;
    this.isDestroyed = false;

    // Clear previous container contents
    while (containerElement.firstChild) {
      containerElement.removeChild(containerElement.firstChild);
    }

    // 1. Fetch raw ebook buffer
    let openedBook: TBook | null = null;
    let openedView: View | null = null;
    const disposeOpenedResources = (): void => {
      notePointerDetachOwner(this);
      if (openedView) {
        openedView.close();
        openedView.element.remove();
        if (this.view === openedView) this.view = null;
      }
      if (openedBook) {
        openedBook.destroy();
        if (this.book === openedBook) this.book = null;
      }
    };
    try {
      const buffer = await this.fetchBuffer(source.assetUrl, openController.signal);
      if (sequence !== this.openSequence) return;

      // 2. Initialize book and view
      openedBook = await this.createBook(buffer, openController.signal);
      if (sequence !== this.openSequence) {
        openedBook.destroy();
        return;
      }
      this.book = openedBook;
      this.pageCount = Math.max(1, openedBook.sections.length);

      openedView = new View();
      this.view = openedView;
      containerElement.appendChild(openedView.element);

      openedView.addEventListener('relocate', (e) => {
        if (sequence !== this.openSequence) return;
        const detail = (e as CustomEvent<{ index: number; progress: number; cfi?: string }>).detail;
        this.currentPage = detail.index + 1;
        this.currentProgress = detail.progress;
        this.currentLocationDetail = detail.cfi;

        const loc = this.buildLocation(detail.index, detail.cfi, detail.progress);
        this.onLocationChange?.(loc, detail.progress);
      });

      await openedView.open(openedBook);
      if (sequence !== this.openSequence) {
        disposeOpenedResources();
        return;
      }
      this.applyTypographyStyles();
      const renderer = openedView.activeRenderer;
      if (renderer) {
        this.rendererLoadListener = () => {
          this.installSelectionListener();
          void this.refreshAnnotations();
        };
        renderer.addEventListener('load', this.rendererLoadListener);
      }
      this.installSelectionListener();

      // 3. Navigate to initial location if provided
      if (source.initialLocation) {
        await this.goToLocation(source.initialLocation);
        if (sequence !== this.openSequence) {
          disposeOpenedResources();
          return;
        }
      }
      void this.refreshAnnotations();
    } catch (error) {
      disposeOpenedResources();
      if (openController.signal.aborted || sequence !== this.openSequence) return;
      throw error;
    } finally {
      if (this.openController === openController) this.openController = null;
    }
  }

  async goToPage(pageNumber: number): Promise<void> {
    if (!this.view || this.isDestroyed) return;
    const clamped = Math.max(1, Math.min(this.pageCount, pageNumber));
    this.currentPage = clamped;
    await this.view.goTo(clamped - 1);
  }

  async goToLocation(location: DocumentLocation): Promise<void> {
    if (!this.view || this.isDestroyed) return;
    const target = this.resolveLocationTarget(location);
    if (target !== null) {
      await this.view.goTo(target);
    }
  }

  getReadingLocation(): { readonly location: DocumentLocation; readonly progress: number } {
    const loc = this.buildLocation(
      this.currentPage - 1,
      this.currentLocationDetail,
      this.currentProgress
    );
    return {
      location: loc,
      progress: this.currentProgress,
    };
  }

  getProgress(): number {
    return this.currentProgress;
  }

  getPageCount(): number {
    return this.pageCount;
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getZoom(): number {
    return this.zoom;
  }

  getZoomMode(): ZoomMode {
    return this.zoomMode;
  }

  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void> {
    if (typeof zoom === 'number') {
      this.zoom = Math.max(0.5, Math.min(3.0, zoom));
      this.zoomMode = 'custom';
    } else {
      this.zoomMode = zoom;
      this.zoom = zoom === 'fit-width' ? 1.0 : 1.2;
    }
    this.applyTypographyStyles();
    // The paginator iframe's outer box may be unchanged while typography
    // mutates inner fragment rects; drop cached note-pointer geometry.
    notePointerInvalidateLayout();
    return Promise.resolve();
  }

  setReflowOptions(options: ReflowOptions): Promise<void> {
    this.lineHeight = Math.max(1.2, Math.min(2.2, options.lineHeight));
    this.horizontalMarginRem = Math.max(0.75, Math.min(5, options.horizontalMarginRem));
    this.fontSize = Math.max(0.75, Math.min(2, options.fontSize));
    this.fontFamily = options.fontFamily;
    this.contentWidth = Math.max(40, Math.min(100, options.contentWidth));
    this.paragraphSpacing = Math.max(0, Math.min(3, options.paragraphSpacing));
    this.applyTypographyStyles();
    notePointerInvalidateLayout();
    return Promise.resolve();
  }

  protected applyTypographyStyles(): void {
    if (!this.view || this.isDestroyed) return;
    const fontSizePx = Math.round(16 * this.zoom * this.fontSize);
    const fontStack = this.fontFamily === 'serif'
      ? 'Georgia, "Times New Roman", serif'
      : this.fontFamily === 'sans'
        ? 'ui-sans-serif, system-ui, sans-serif'
        : this.fontFamily === 'dyslexic'
          ? 'OpenDyslexic, Arial, sans-serif'
          : 'ui-sans-serif, system-ui, -apple-system, sans-serif';
    const css = `
      body {
        font-size: ${String(fontSizePx)}px !important;
        line-height: ${String(this.lineHeight)} !important;
        padding-inline: ${String(this.horizontalMarginRem)}rem !important;
        max-width: ${String(this.contentWidth)}% !important;
        font-family: ${fontStack} !important;
      }
      p, li, dd, dt {
        font-size: ${String(fontSizePx)}px !important;
        line-height: ${String(this.lineHeight)} !important;
        margin-block-end: ${String(this.paragraphSpacing)}em !important;
        font-family: ${fontStack} !important;
      }
      h1 { font-size: ${String(Math.round(fontSizePx * 1.75))}px !important; }
      h2 { font-size: ${String(Math.round(fontSizePx * 1.45))}px !important; }
      h3 { font-size: ${String(Math.round(fontSizePx * 1.25))}px !important; }
      pre, code { font-size: ${String(Math.round(fontSizePx * 0.9))}px !important; }
    `;
    this.view.setStyles(css);
  }

  async search(query: string): Promise<readonly SearchMatch[]> {
    if (!this.view || this.isDestroyed || !query.trim()) return [];

    const matches: SearchMatch[] = [];
    let matchId = 1;

    for await (const { index, match } of this.view.search(query)) {
      const loc = this.buildLocation(index);
      matches.push({
        id: `match-${String(matchId++)}`,
        location: loc,
        text: match.excerpt.match,
        textStart: match.textStart,
        textEnd: match.textEnd,
        prefix: match.excerpt.pre,
        suffix: match.excerpt.post,
      });
    }

    return matches;
  }

  async applySearchHighlight(request: SearchHighlightRequest): Promise<SearchHighlightResult> {
    this.clearSearchHighlight();
    if (
      request.documentId !== this.documentId ||
      (this.documentHash !== '' && request.documentHash !== this.documentHash) ||
      request.anchor.documentId !== request.documentId ||
      request.anchor.documentHash !== request.documentHash ||
      !searchAnchorMatchesQuery(request.anchor, request.query) ||
      request.anchor.location.format !== this.format ||
      !request.query.trim()
    ) {
      return { status: 'stale', text: null, rangeCount: 0 };
    }

    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    await this.goToLocation(request.anchor.location);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    const renderer = this.view?.activeRenderer;
    const doc = renderer?.document;
    if (!renderer || !doc || renderer.index !== this.sectionIndexForLocation(request.anchor.location)) {
      return { status: 'not-found', text: null, rangeCount: 0 };
    }

    const ranges = rangesForSearchAnchor(doc.body, request.anchor);
    if (isSearchHighlightCancelled(request) || ranges.length === 0) return { status: 'not-found', text: null, rangeCount: 0 };
    const rangeCount = applySearchHighlight(doc, ranges);
    if (rangeCount === 0) return { status: 'unsupported', text: null, rangeCount: 0 };
    const firstRange = ranges[0];
    const target = firstRange?.startContainer instanceof Element
      ? firstRange.startContainer
      : firstRange?.startContainer.parentElement;
    target?.scrollIntoView({ behavior: 'auto', block: 'center' });
    return { status: 'applied', text: ranges.map((range) => range.toString()).join(' … '), rangeCount };
  }

  clearSearchHighlight(): void {
    const doc = this.view?.activeRenderer?.document;
    if (doc) clearSearchHighlight(doc);
  }

  async *extractText(): AsyncIterable<NormalizedTextChunk> {
    if (!this.book || this.isDestroyed) return;

    for (let i = 0; i < this.book.sections.length; i++) {
      const section = this.book.sections[i];
      if (!section) continue;
      const doc = await section.createDocument();
      // Keep the exact body text stream, including XHTML indentation. The
      // native highlight adapter paints offsets against this same stream.
      const text = doc.body.textContent;
      const tokenCount = text.split(/\s+/).filter(Boolean).length;
      const headingEl = doc.querySelector('h1, h2, h3, title');
      const heading = (headingEl ? headingEl.textContent.trim() : '') || null;
      const loc = this.buildLocation(i);

      yield {
        id: `chunk-${this.documentId}-${String(i + 1)}`,
        documentId: this.documentId,
        ordinal: i + 1,
        text,
        tokenCount,
        location: loc,
        heading,
        pageLabel: `Section ${String(i + 1)}`,
      };
    }
  }

  async extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]> {
    const target = this.resolveLocationTarget(location);
    const index = typeof target === 'number' ? target : target?.index ?? 0;
    if (!this.book || index < 0 || index >= this.book.sections.length) {
      return [];
    }

    const section = this.book.sections[index];
    if (!section) {
      return [];
    }
    const doc = await section.createDocument();
    const text = doc.body.textContent;
    const tokenCount = text.split(/\s+/).filter(Boolean).length;
    const headingEl = doc.querySelector('h1, h2, h3, title');
    const heading = (headingEl ? headingEl.textContent.trim() : '') || null;

    return [
      {
        id: `chunk-${this.documentId}-${String(index + 1)}`,
        documentId: this.documentId,
        ordinal: index + 1,
        text,
        tokenCount,
        location,
        heading,
        pageLabel: `Section ${String(index + 1)}`,
      },
    ];
  }

  close(): Promise<void> {
    this.openSequence += 1;
    this.annotationSequence += 1;
    this.isDestroyed = true;
    notePointerDetachOwner(this);
    this.openController?.abort();
    this.openController = null;
    this.detachRendererListeners();
    if (this.view) {
      this.view.close();
      this.view.element.remove();
      this.view = null;
    }
    if (this.book) {
      this.book.destroy();
      this.book = null;
    }
    this.container = null;
    this.documentHash = '';
    this.currentLocationDetail = undefined;
    this.onLocationChange = undefined;
    this.annotations = [];
    this.onSelectionChange = undefined;
    this.onAnnotationResolution = undefined;
    return Promise.resolve();
  }

  private removeSelectionListener(): void {
    if (this.selectionListener && this.selectionDocument) {
      this.selectionDocument.removeEventListener('selectionchange', this.selectionListener);
      clearDomHighlights(this.selectionDocument);
      clearSearchHighlight(this.selectionDocument);
    }
    this.selectionListener = null;
    this.selectionDocument = null;
  }

  private sectionIndexForLocation(location: DocumentLocation): number {
    const target = this.resolveLocationTarget(location);
    return typeof target === 'number' ? target : target?.index ?? -1;
  }

  private detachRendererListeners(): void {
    this.removeSelectionListener();
    if (this.rendererLoadListener && this.view?.activeRenderer) {
      this.view.activeRenderer.removeEventListener('load', this.rendererLoadListener);
    }
    this.rendererLoadListener = null;
  }

  private installSelectionListener(): void {
    this.removeSelectionListener();
    const renderer = this.view?.activeRenderer;
    const doc = renderer?.document;
    if (!doc) return;
    this.selectionDocument = doc;
    if (this.onSelectionChange) {
      this.selectionListener = () => {
        const result = this.captureSelection();
        this.onSelectionChange?.(result.selection, result.error);
      };
      doc.addEventListener('selectionchange', this.selectionListener);
    }
  }

  private captureSelection(): { selection: ReaderSelection | null; error: SelectionIssue | null } {
    const renderer = this.view?.activeRenderer;
    const doc = renderer?.document;
    const body = doc?.body;
    const selection = doc?.getSelection();
    if (!renderer || !doc || !body || selection?.rangeCount !== 1 || selection.isCollapsed) return { selection: null, error: null };
    const range = selection.getRangeAt(0);
    const subRange = subRangeWithin(body, range);
    if (!subRange) return { selection: null, error: null };
    const offsets = rangeOffsetsWithin(body, subRange);
    const quote = quoteContextForRange(body, subRange);
    if (!offsets || !quote) return { selection: null, error: null };
    const section = renderer.sections[renderer.index];
    if (!section) return { selection: null, error: null };
    const nativeSelectedText = selection.toString();
    const selectedText = nativeSelectedText || quote.exact;
    const topLevelQuote: QuoteContext = {
      ...quote,
      exact: takeCodePointPrefix(selectedText, 256_000),
    };
    const cfi = section.cfi ? CFI.joinIndir(section.cfi, CFI.fromRange(subRange)) : CFI.fromRange(subRange);
    const chatDescriptor = this.format === 'epub'
      ? ({
          format: 'epub',
          startSpineHref: section.id,
          endSpineHref: section.id,
          startCfi: cfi,
          endCfi: cfi,
          startProgression: renderer.progress,
          endProgression: renderer.progress,
          startQuote: boundedQuoteContext(quote),
          endQuote: boundedQuoteContext(quote),
          selectedTextSnippet: takeCodePointPrefix(selectedText, 500),
        } satisfies EpubChatSelectionDescriptor)
      : ({
          format: 'mobi',
          startSectionIndex: renderer.index,
          endSectionIndex: renderer.index,
          startQuote: boundedQuoteContext(quote),
          endQuote: boundedQuoteContext(quote),
          startOffset: offsets.start,
          endOffset: offsets.end,
          selectedTextSnippet: takeCodePointPrefix(selectedText, 500),
        } satisfies MobiChatSelectionDescriptor);

    const anchor = this.format === 'epub'
      ? ({
          format: 'epub',
          quote: topLevelQuote,
          cfi,
          spineHref: section.id,
          progression: renderer.progress,
          textStart: offsets.start,
          textEnd: offsets.end,
        } satisfies EpubAnnotationAnchor)
      : ({
          format: 'mobi',
          quote: topLevelQuote,
          sectionIndex: renderer.index,
          progression: renderer.progress,
          textStart: offsets.start,
          textEnd: offsets.end,
        } satisfies MobiAnnotationAnchor);
    const rect = subRange.getBoundingClientRect();
    const frame = renderer.frameRect;
    return {
      selection: {
        selectedText: takeCodePointPrefix(selectedText, 256_000),
        totalSelectedLength: selectedText.length,
        chatDescriptor,
        anchor: selectedText.length <= 256_000 ? anchor : null,
        clientRect: {
          left: frame.left + rect.left,
          top: frame.top + rect.top,
          width: rect.width,
          height: rect.height,
        },
      },
      error: null,
    };
  }

  async setAnnotations(annotations: readonly Annotation[]): Promise<readonly AnnotationAnchorResolution[]> {
    this.annotations = annotations.filter((annotation) => annotation.anchor.format === this.format);
    return this.refreshAnnotations();
  }

  getAnnotationScope():
    | { readonly format: 'epub'; readonly spineHref: string }
    | { readonly format: 'mobi'; readonly sectionIndex: number }
    | null {
    const renderer = this.view?.activeRenderer;
    const section = renderer?.sections[renderer.index];
    if (!renderer || !section) return null;
    return this.format === 'epub'
      ? { format: 'epub', spineHref: section.id }
      : { format: 'mobi', sectionIndex: renderer.index };
  }

  async goToAnnotation(annotation: Annotation): Promise<void> {
    if (annotation.anchor.format !== this.format) return;
    await this.goToLocation(anchorToLocation(annotation.anchor));
    const resolved = await this.resolveCurrentAnnotation(annotation);
    const range = resolved?.range;
    if (range) {
      const parent = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      parent?.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }

  private async refreshAnnotations(): Promise<readonly AnnotationAnchorResolution[]> {
    const sequence = ++this.annotationSequence;
    const doc = this.view?.activeRenderer?.document;
    if (!doc) return [];
    const results: AnnotationAnchorResolution[] = [];
    const painted: { annotation: Annotation; range: Range }[] = [];
    for (const annotation of this.annotations) {
      const resolved = await this.resolveCurrentAnnotation(annotation);
      if (sequence !== this.annotationSequence) return [];
      if (!resolved) continue;
      results.push(resolved.result);
      this.onAnnotationResolution?.(resolved.result);
      if (resolved.range) painted.push({ annotation, range: resolved.range });
    }
    if (sequence === this.annotationSequence) {
      // Iframe-local range rects are translated to top-window viewport
      // coordinates at open time via the live frame rect, so the popover is
      // positioned in the top frame while hit-testing stays iframe-local.
      paintAnchoredRanges(this, doc, painted, {
        toTopClientRect: (rect) => {
          const frame = this.view?.activeRenderer?.frameRect;
          const frameLeft = frame?.left ?? 0;
          const frameTop = frame?.top ?? 0;
          return {
            left: frameLeft + rect.left,
            top: frameTop + rect.top,
            right: frameLeft + rect.right,
            bottom: frameTop + rect.bottom,
          };
        },
      });
    }
    return results;
  }

  private async resolveCurrentAnnotation(annotation: Annotation): Promise<{
    readonly result: AnnotationAnchorResolution;
    readonly range: Range | null;
  } | null> {
    const renderer = this.view?.activeRenderer;
    const doc = renderer?.document;
    const body = doc?.body;
    const section = renderer?.sections[renderer.index];
    if (!renderer || !doc || !body || !section) return null;
    const anchor = annotation.anchor;
    if (anchor.format !== 'epub' && anchor.format !== 'mobi') return null;
    const resolvedTarget = anchor.format === 'epub' && !anchor.spineHref
      ? this.resolveLocationTarget(anchorToLocation(anchor))
      : null;
    const resolvedIndex = anchor.format === 'epub' && anchor.spineHref
      ? renderer.sections.findIndex((candidate) => candidate.id === anchor.spineHref)
      : typeof resolvedTarget === 'number'
        ? resolvedTarget
        : resolvedTarget?.index;
    const targetExists = anchor.format === 'epub'
      ? resolvedIndex !== undefined && resolvedIndex >= 0 && resolvedIndex < renderer.sections.length
      : anchor.sectionIndex >= 0 && anchor.sectionIndex < renderer.sections.length;
    if (!targetExists) {
      return {
        result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
        range: null,
      };
    }
    const isCurrent = anchor.format === 'epub'
      ? resolvedIndex === renderer.index
      : anchor.sectionIndex === renderer.index;
    if (!isCurrent) return null;
    if (anchor.quote.exact.length === 0) {
      return {
        result: { annotationId: annotation.id, status: 'anchored', anchor, stage: 'native' },
        range: null,
      };
    }

    let nativeRange: Range | null = null;
    if (anchor.format === 'epub') {
      try {
        nativeRange = CFI.toRange(doc, anchor.cfi);
      } catch {
        nativeRange = null;
      }
    } else if (anchor.textStart !== undefined && anchor.textEnd !== undefined) {
      nativeRange = rangeFromOffsets(body, { start: anchor.textStart, end: anchor.textEnd });
    }
    const nativeOffsets = nativeRange ? rangeOffsetsWithin(body, nativeRange) : null;
    const priorOffset = anchor.textStart ?? nativeOffsets?.start ?? 0;
    const resolution = await resolveTextAnchor(body.textContent, anchor.quote, {
      ...(nativeOffsets ? { nativeRange: nativeOffsets } : {}),
      priorOffset,
    });
    if (!resolution) {
      return {
        result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
        range: null,
      };
    }
    const range = rangeFromOffsets(body, resolution);
    if (!range) {
      return {
        result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
        range: null,
      };
    }
    const repairedAnchor = anchor.format === 'epub'
      ? ({
          ...anchor,
          cfi: section.cfi ? CFI.joinIndir(section.cfi, CFI.fromRange(range)) : CFI.fromRange(range),
          spineHref: section.id,
          progression: renderer.progress,
          textStart: resolution.start,
          textEnd: resolution.end,
        } satisfies EpubAnnotationAnchor)
      : ({
          ...anchor,
          sectionIndex: renderer.index,
          progression: renderer.progress,
          textStart: resolution.start,
          textEnd: resolution.end,
        } satisfies MobiAnnotationAnchor);
    return {
      result: {
        annotationId: annotation.id,
        status: 'anchored',
        anchor: repairedAnchor,
        stage: resolution.stage,
      },
      range,
    };
  }
}
