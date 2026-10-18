import type {
  DocxChatSelectionDescriptor,
  DocumentLocation,
  DocxLocation,
  PptxChatSelectionDescriptor,
  PptxLocation,
  NormalizedTextChunk,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
import DocxParseWorker from './docx-parse.worker?worker';
import { parseOoxmlInWorker } from './ooxml-worker-pool';
import type {
  ParsedDocxBlock,
  ParsedDocxParagraph,
  ParsedDocxPayload,
  ParsedDocxTable,
} from './docx-parse-core';
import { sanitizeEbookHtml } from './foliate/sanitize';
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
import type { Annotation, DocxAnnotationAnchor, DocxAnchorSegment, PptxAnnotationAnchor, QuoteContext } from '@shared/types/annotation';
import { takeCodePointPrefix } from '@shared/agent-context';
import {
  anchorToLocation,
  boundedQuoteContext,
  clearDomHighlights,
  MAX_NATIVE_SELECTION_TEXT_LENGTH,
  partitionMultiSegmentText,
  quoteContextForRange,
  rangeFromOffsets,
  rangesForSearchAnchor,
  rangeOffsetsWithin,
  subRangeWithin,
} from '../annotations/dom-anchors';
import { notePointerDetachOwner, notePointerInvalidateLayout, paintAnchoredRanges } from '../annotations/note-pointer';
import { applySearchHighlight, clearSearchHighlight } from '../annotations/search-highlight';
import { searchAnchorMatchesQuery } from '@shared/search/match-anchor';
import { resolveTextAnchor } from '../annotations/text-anchor-resolver';
import { captureReflowAnchor, restoreReflowAnchor, type ReflowAnchor } from './reflow-anchor';
import { caseFold, lookupFolding } from 'unicode-case-folding';

const MAX_DOCX_BYTES = 128 * 1024 * 1024;
// PPTX slides reuse this paragraph model; each slide is one widescreen page.
const PAGE_SIZES = {
  docx: { width: 816, height: 1_056 },
  pptx: { width: 960, height: 540 },
} as const;
export const MAX_DOCX_SEARCH_RESULTS = 5_000;
const MAX_DOCX_SEARCH_QUERY_LENGTH = 1_024;
const SEARCH_YIELD_UTF16_UNITS = 128 * 1024;

/** PPTX shares the DOCX paragraph model; only the location format differs. */
type OoxmlLocation = DocxLocation | PptxLocation;
type OoxmlAnchor = DocxAnnotationAnchor | PptxAnnotationAnchor;

export type DocxParse = (
  bytes: Uint8Array,
  signal?: AbortSignal
) => Promise<ParsedDocxPayload>;

function parseDocxInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<ParsedDocxPayload> {
  return parseOoxmlInWorker(() => new DocxParseWorker(), 'DOCX', bytes, signal);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function foldTextWithOffsets(
  value: string,
  isCancelled: () => boolean,
  workBudget: { utf16Units: number }
): Promise<{
  readonly folded: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} | null> {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset) ?? 0;
    const originalLength = codePoint > 0xffff ? 2 : 1;
    const mapped = lookupFolding(codePoint) ?? [codePoint];
    const piece = String.fromCodePoint(...mapped);
    folded += piece;
    for (const character of piece) {
      starts.push(offset);
      ends.push(offset + originalLength);
      if (character.length === 2) {
        starts.push(offset);
        ends.push(offset + originalLength);
      }
    }
    offset += originalLength;
    workBudget.utf16Units += originalLength;
    if (workBudget.utf16Units >= SEARCH_YIELD_UTF16_UNITS) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      if (isCancelled()) return null;
      workBudget.utf16Units = 0;
    }
  }
  return { folded, starts, ends };
}

function renderParagraphContent(paragraph: ParsedDocxParagraph): string {
  const renderText = (text: string): string => escapeHtml(text);
  const text = paragraph.runs
    ? paragraph.runs.map((run) => {
        let markup = renderText(run.text);
        if (run.bold) markup = `<strong>${markup}</strong>`;
        if (run.italic) markup = `<em>${markup}</em>`;
        if (run.underline) markup = `<u>${markup}</u>`;
        if (run.strike) markup = `<s>${markup}</s>`;
        if (run.verticalAlign === 'subscript') markup = `<sub>${markup}</sub>`;
        if (run.verticalAlign === 'superscript') markup = `<sup>${markup}</sup>`;
        return markup;
      }).join('')
    : renderText(paragraph.text);
  const images = (paragraph.images ?? [])
    .map((image) => `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}">`)
    .join('');
  return `<span class="docx-paragraph-content">${text}${images}</span>`;
}

function paragraphClasses(paragraph: ParsedDocxParagraph): string {
  const alignment = paragraph.alignment ? ` docx-align-${paragraph.alignment}` : '';
  return `docx-paragraph${alignment}`;
}

function renderParagraphMarkup(paragraph: ParsedDocxParagraph): string {
  const tag = paragraph.headingLevel ? `h${String(paragraph.headingLevel)}` : 'p';
  return `<${tag} class="${paragraphClasses(paragraph)}" data-docx-paragraph="${String(paragraph.index)}">${renderParagraphContent(paragraph)}</${tag}>`;
}

function renderListMarkup(paragraphs: readonly ParsedDocxParagraph[]): string {
  const renderLevel = (startIndex: number, level: number): { readonly markup: string; readonly nextIndex: number } => {
    const first = paragraphs[startIndex];
    if (!first?.list) return { markup: '', nextIndex: startIndex + 1 };
    const tag = first.list.ordered ? 'ol' : 'ul';
    const listStyle = first.list.style;
    let markup = `<${tag} class="docx-list docx-list-level-${String(level)} docx-list-style-${listStyle}">`;
    let index = startIndex;
    while (index < paragraphs.length) {
      const paragraph = paragraphs[index];
      if (paragraph?.list?.level !== level) break;
      const list = paragraph.list;
      if ((list.ordered ? 'ol' : 'ul') !== tag) break;
      if (list.style !== listStyle) break;
      const value = list.ordered ? ` value="${String(list.ordinal)}"` : '';
      markup += `<li class="${paragraphClasses(paragraph)}" data-docx-paragraph="${String(paragraph.index)}"${value}>${renderParagraphContent(paragraph)}`;
      index += 1;
      while ((paragraphs[index]?.list?.level ?? -1) > level) {
        const nestedLevel = paragraphs[index]?.list?.level;
        if (nestedLevel === undefined) break;
        const nested = renderLevel(index, nestedLevel);
        markup += nested.markup;
        index = nested.nextIndex;
      }
      markup += '</li>';
    }
    markup += `</${tag}>`;
    return { markup, nextIndex: index };
  };

  let markup = '';
  let index = 0;
  while (index < paragraphs.length) {
    const level = paragraphs[index]?.list?.level ?? 0;
    const rendered = renderLevel(index, level);
    markup += rendered.markup;
    index = Math.max(index + 1, rendered.nextIndex);
  }
  return markup;
}

function renderParagraphSequence(paragraphs: readonly ParsedDocxParagraph[]): string {
  let markup = '';
  let index = 0;
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index];
    if (!paragraph) break;
    if (!paragraph.list) {
      markup += renderParagraphMarkup(paragraph);
      index += 1;
      continue;
    }
    const id = paragraph.list.id;
    const listItems: ParsedDocxParagraph[] = [];
    for (;;) {
      const candidate = paragraphs[index];
      if (candidate?.list?.id !== id) break;
      listItems.push(candidate);
      index += 1;
    }
    markup += renderListMarkup(listItems);
  }
  return markup;
}

function renderTableMarkup(table: ParsedDocxTable): string {
  const rows = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderParagraphSequence(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="docx-table"><tbody>${rows}</tbody></table>`;
}

function renderBlocksMarkup(blocks: readonly ParsedDocxBlock[]): string {
  let markup = '';
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;
    if (block.kind === 'table') {
      markup += renderTableMarkup(block);
      index += 1;
      continue;
    }
    const paragraphs: ParsedDocxParagraph[] = [];
    while (blocks[index]?.kind === 'paragraph') {
      paragraphs.push(blocks[index] as ParsedDocxParagraph);
      index += 1;
    }
    markup += renderParagraphSequence(paragraphs);
  }
  return markup;
}

function flattenParagraphs(blocks: readonly ParsedDocxBlock[]): ParsedDocxParagraph[] {
  const paragraphs: ParsedDocxParagraph[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph') paragraphs.push(block);
    else for (const row of block.rows) for (const cell of row) paragraphs.push(...cell);
  }
  return paragraphs.sort((a, b) => a.index - b.index);
}

async function readBoundedDocxResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error('This DOCX is too large to open safely.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_DOCX_BYTES) {
        await reader.cancel('DOCX size limit exceeded');
        throw new Error('This DOCX is too large to open safely.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class DocxAdapter implements DocumentAdapter {
  /** Office text reflows; its hyperlinks are not followed out of the document. */
  readonly capabilities: DocumentAdapterCapabilities = { reflow: this, externalLinks: null };
  private container: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private payload: ParsedDocxPayload | null = null;
  private paragraphs: ParsedDocxParagraph[] = [];
  private readonly paragraphsByIndex = new Map<number, ParsedDocxParagraph>();
  private readonly blocksByPage = new Map<number, ParsedDocxBlock[]>();
  private readonly pageWrappers = new Map<number, HTMLElement>();
  private readonly renderedPages = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private scrollListener: (() => void) | null = null;
  private scrollAnimationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastObservedWidth = 0;
  private reflowAnchor: ReflowAnchor | null = null;
  private openController: AbortController | null = null;
  private openSequence = 0;
  private documentId = '';
  private documentHash = '';
  private currentParagraphIndex = 0;
  private currentCharacterStart: number | undefined;
  private currentCharacterEnd: number | undefined;
  private currentPage = 1;
  private pageCount = 1;
  private zoom = 1;
  private zoomMode: ZoomMode = 'fit-width';
  private lineHeight = 1.65;
  private horizontalMarginRem = 2.5;
  private fontSize = 1;
  private fontFamily: ReflowOptions['fontFamily'] = 'system';
  private contentWidth = 72;
  private paragraphSpacing = 0.8;
  private searchSequence = 0;
  private annotationSequence = 0;
  private annotations: readonly Annotation[] = [];
  private selectionListener: (() => void) | null = null;
  private onSelectionChange?: SelectionChangeCallback | undefined;
  private onAnnotationResolution?: ((result: AnnotationAnchorResolution) => void) | undefined;
  private onLocationChange?: ((location: OoxmlLocation, progress: number) => void) | undefined;

  constructor(
    private readonly parseDocx: DocxParse = parseDocxInWorker,
    readonly format: 'docx' | 'pptx' = 'docx'
  ) {}

  setLocationChangeCallback(callback: ((location: OoxmlLocation, progress: number) => void) | null): void {
    this.onLocationChange = callback ?? undefined;
  }

  setSelectionChangeCallback(callback: SelectionChangeCallback | null): void {
    this.onSelectionChange = callback ?? undefined;
    this.installSelectionListener();
  }

  setAnnotationResolutionCallback(callback: AnnotationResolutionCallback | null): void {
    this.onAnnotationResolution = callback ?? undefined;
  }

  async open(containerElement: HTMLElement, source: DocumentSource): Promise<void> {
    const sequence = ++this.openSequence;
    this.searchSequence += 1;
    this.openController?.abort();
    this.teardownDom();
    const controller = new AbortController();
    this.openController = controller;
    this.container = containerElement;
    this.documentId = source.documentId;
    this.documentHash = source.documentHash;
    containerElement.replaceChildren();

    try {
      const bytes = await this.fetchBytes(source.assetUrl, controller.signal);
      controller.signal.throwIfAborted();
      const payload = await this.parseDocx(bytes, controller.signal);
      controller.signal.throwIfAborted();
      if (sequence !== this.openSequence) return;
      this.payload = payload;
      this.paragraphs = flattenParagraphs(payload.blocks);
      this.paragraphsByIndex.clear();
      for (const paragraph of this.paragraphs) this.paragraphsByIndex.set(paragraph.index, paragraph);
      this.blocksByPage.clear();
      for (const block of payload.blocks) {
        const blocks = this.blocksByPage.get(block.pageIndex) ?? [];
        blocks.push(block);
        this.blocksByPage.set(block.pageIndex, blocks);
      }
      this.pageCount = Math.max(1, payload.pageCount);
      this.currentParagraphIndex = this.paragraphs[0]?.index ?? 0;
      this.currentCharacterStart = undefined;
      this.currentCharacterEnd = undefined;
      this.currentPage = 1;
      this.buildDom(containerElement);
      if (source.initialLocation?.format === this.format) {
        await this.goToLocation(source.initialLocation);
      } else {
        this.updateVisiblePages();
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== this.openSequence) return;
      this.teardownDom();
      throw error;
    } finally {
      if (this.openController === controller) this.openController = null;
    }
  }

  private async fetchBytes(assetUrl: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (assetUrl.startsWith('data:')) {
      const separator = assetUrl.indexOf(',');
      const metadata = separator >= 0 ? assetUrl.slice(0, separator) : '';
      const encoded = separator >= 0 ? assetUrl.slice(separator + 1) : '';
      if (!metadata.endsWith(';base64') || !encoded) throw new Error('The DOCX asset is not a valid base64 data URL.');
      if (Math.ceil((encoded.length * 3) / 4) > MAX_DOCX_BYTES) throw new Error('This DOCX is too large to open safely.');
      try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          if ((index & 0xfffff) === 0) signal.throwIfAborted();
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error('The DOCX asset contains invalid base64 data.');
      }
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(assetUrl);
    } catch {
      throw new Error('The DOCX asset URL is invalid.');
    }
    if (parsedUrl.protocol !== 'interleaf-media:') throw new Error('The DOCX asset URL uses an unsupported protocol.');
    const response = await fetch(assetUrl, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok) throw new Error(`Failed to load the DOCX asset (HTTP ${String(response.status)}).`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_DOCX_BYTES) throw new Error('This DOCX is too large to open safely.');
    return readBoundedDocxResponse(response);
  }

  private buildDom(container: HTMLElement): void {
    const scroller = document.createElement('div');
    scroller.className = 'docx-viewer-scroll-container h-full w-full overflow-y-auto overflow-x-hidden flex flex-col items-center py-6 gap-6 outline-hidden';
    scroller.setAttribute('data-testid', 'docx-scroll-container');
    scroller.setAttribute('tabindex', '0');
    this.scrollContainer = scroller;
    for (let page = 0; page < this.pageCount; page++) {
      const wrapper = document.createElement('article');
      // DOCX is reflowable, so it follows the reader surface's selected
      // background/text pair. Unlike PDF pages, this is presentation only and
      // never changes the source document's fixed layout data.
      wrapper.className = 'docx-page-wrapper shadow-md box-border';
      wrapper.style.backgroundColor = 'var(--reader-background-override, var(--bg-reader))';
      wrapper.style.color = 'var(--reader-foreground-override, var(--text-primary))';
      wrapper.setAttribute('data-docx-page', String(page));
      wrapper.setAttribute('data-testid', `docx-page-${String(page + 1)}`);
      if (this.format === 'pptx') wrapper.setAttribute('aria-label', `Slide ${String(page + 1)}`);
      wrapper.style.minHeight = `${String(PAGE_SIZES[this.format].height)}px`;
      this.pageWrappers.set(page, wrapper);
      scroller.appendChild(wrapper);
    }
    container.replaceChildren(scroller);
    this.applyLayoutStyles();
    this.scrollListener = () => {
      this.scrollAnimationFrame ??= window.requestAnimationFrame(() => {
        this.scrollAnimationFrame = null;
        if (!this.observer) this.updateVisiblePages();
        this.updateReadingPositionFromViewport();
        this.captureReadingAnchor();
      });
    };
    scroller.addEventListener('scroll', this.scrollListener, { passive: true });
    this.installReflowAnchoring(scroller);
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = Number(entry.target.getAttribute('data-docx-page'));
        if (entry.isIntersecting) this.renderPage(page);
        else if (Math.abs(page - (this.currentPage - 1)) > 2) this.destroyPage(page);
      }
    }, { root: scroller, rootMargin: '800px 0px', threshold: 0.01 });
    for (const wrapper of this.pageWrappers.values()) this.observer.observe(wrapper);
    this.renderPage(0);
    this.installSelectionListener();
  }

  private renderPage(pageIndex: number): void {
    if (this.renderedPages.has(pageIndex) || !this.payload) return;
    const wrapper = this.pageWrappers.get(pageIndex);
    if (!wrapper) return;
    const markup = renderBlocksMarkup(this.blocksByPage.get(pageIndex) ?? []);
    wrapper.innerHTML = sanitizeEbookHtml(markup || '<p class="docx-empty-page"></p>');
    for (const paragraph of wrapper.querySelectorAll<HTMLElement>('.docx-paragraph')) {
      paragraph.style.whiteSpace = 'pre-wrap';
      paragraph.style.overflowWrap = 'anywhere';
      paragraph.style.margin = `0 0 ${String(this.paragraphSpacing)}em`;
    }
    for (const alignment of ['center', 'right', 'justify'] as const) {
      for (const paragraph of wrapper.querySelectorAll<HTMLElement>(`.docx-align-${alignment}`)) {
        paragraph.style.textAlign = alignment;
      }
    }
    for (const style of [
      'decimal',
      'lower-alpha',
      'upper-alpha',
      'lower-roman',
      'upper-roman',
      'disc',
      'none',
    ] as const) {
      for (const list of wrapper.querySelectorAll<HTMLElement>(`.docx-list-style-${style}`)) {
        list.style.listStyleType = style;
      }
    }
    for (const image of wrapper.querySelectorAll<HTMLImageElement>('img')) {
      image.style.maxWidth = '100%';
      image.style.height = 'auto';
      image.style.display = 'block';
      image.style.margin = '0.75rem auto';
    }
    for (const table of wrapper.querySelectorAll<HTMLTableElement>('table')) {
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
    }
    for (const cell of wrapper.querySelectorAll<HTMLTableCellElement>('td')) {
      cell.style.border = '1px solid var(--border-subtle)';
      cell.style.padding = '0.5rem';
      cell.style.verticalAlign = 'top';
    }
    this.renderedPages.add(pageIndex);
    void this.refreshAnnotations();
  }

  private destroyPage(pageIndex: number): void {
    const wrapper = this.pageWrappers.get(pageIndex);
    if (!wrapper) return;
    wrapper.replaceChildren();
    this.renderedPages.delete(pageIndex);
  }

  private pruneRenderedPages(activePageIndex: number): void {
    for (const page of [...this.renderedPages]) {
      if (Math.abs(page - activePageIndex) > 3) this.destroyPage(page);
    }
  }

  private updateVisiblePages(): void {
    const scroller = this.scrollContainer;
    if (!scroller) return;
    const estimatedPage = Math.max(
      0,
      Math.min(this.pageCount - 1, Math.floor(scroller.scrollTop / (PAGE_SIZES[this.format].height * this.zoom + 24)))
    );
    for (let page = Math.max(0, estimatedPage - 2); page <= Math.min(this.pageCount - 1, estimatedPage + 2); page++) {
      this.renderPage(page);
    }
    this.pruneRenderedPages(estimatedPage);
  }

  /**
   * A DOCX page is drawn at its own width until the reader is narrower than
   * that, at which point the page shrinks and its paragraphs re-wrap. Panel
   * resizes and the Outline toggle must not walk the reader through the
   * document, so the paragraph under the top of the viewport is put back.
   *
   * The anchor is recorded on scroll rather than on resize: a ResizeObserver
   * callback runs after layout, when the reflow has already happened and the
   * paragraph that was at the top of the viewport is no longer there.
   */
  private installReflowAnchoring(scroller: HTMLElement): void {
    this.lastObservedWidth = scroller.clientWidth;
    this.captureReadingAnchor();
    this.resizeObserver = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      // Only a width change re-wraps a paragraph.
      if (width === this.lastObservedWidth) return;
      this.lastObservedWidth = width;
      restoreReflowAnchor(scroller, this.reflowAnchor);
      notePointerInvalidateLayout();
    });
    this.resizeObserver.observe(scroller);
  }

  /** Records where the reader is now, for the next reflow to restore. */
  private captureReadingAnchor(): void {
    const scroller = this.scrollContainer;
    if (!scroller) return;
    // A width change re-wraps the text before the ResizeObserver restores the
    // reader, and this capture is rAF-batched, so it can run in exactly that
    // window: between the re-wrap and the restore. What is under the top of
    // the viewport then is the drift, not where the reader was, and recording
    // it would make the restore put them back on the wrong words. The anchor
    // is therefore only refreshed while the width the last anchor was taken at
    // still holds.
    if (this.resizeObserver !== null && scroller.clientWidth !== this.lastObservedWidth) return;
    this.reflowAnchor = captureReflowAnchor(
      scroller,
      scroller.querySelectorAll<HTMLElement>('[data-docx-paragraph]')
    );
  }

  private updateReadingPositionFromViewport(): void {
    const scroller = this.scrollContainer;
    if (!scroller) return;
    const target = scroller.getBoundingClientRect().top + Math.max(1, scroller.clientHeight) / 3;
    let chosen: ParsedDocxParagraph | undefined;
    let chosenElement: HTMLElement | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestHeight = Number.POSITIVE_INFINITY;
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-docx-paragraph]')) {
      const index = Number(element.dataset.docxParagraph);
      const paragraph = this.paragraphsByIndex.get(index);
      if (!paragraph) continue;
      const rect = element.getBoundingClientRect();
      const distance = target < rect.top
        ? rect.top - target
        : target > rect.bottom
          ? target - rect.bottom
          : 0;
      if (distance < bestDistance || (distance === bestDistance && rect.height < bestHeight)) {
        chosen = paragraph;
        chosenElement = element;
        bestDistance = distance;
        bestHeight = rect.height;
      }
    }
    if (!chosen || !chosenElement) return;
    const offset = this.characterOffsetAtPoint(chosenElement, target);
    const start = offset !== undefined && chosen.text.length > 0
      ? Math.max(0, Math.min(chosen.text.length - 1, offset))
      : undefined;
    const end = start !== undefined ? Math.min(chosen.text.length, start + 1) : undefined;
    const paragraphChanged = chosen.index !== this.currentParagraphIndex;
    this.currentPage = chosen.pageIndex + 1;
    this.pruneRenderedPages(chosen.pageIndex);
    if (
      !paragraphChanged &&
      (start === undefined || (
        start === this.currentCharacterStart && end === this.currentCharacterEnd
      ))
    ) return;
    this.currentParagraphIndex = chosen.index;
    if (start !== undefined && end !== undefined && end > start) {
      this.currentCharacterStart = start;
      this.currentCharacterEnd = end;
    } else if (paragraphChanged) {
      this.currentCharacterStart = undefined;
      this.currentCharacterEnd = undefined;
    }
    this.notifyLocationChange();
  }

  private characterOffsetAtPoint(element: HTMLElement, y: number): number | undefined {
    const content = element.querySelector<HTMLElement>('.docx-paragraph-content');
    if (!content) return undefined;
    const rect = content.getBoundingClientRect();
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + 8));
    const ownerDocument = element.ownerDocument;
    const caretPosition = ownerDocument.caretPositionFromPoint(x, y);
    const node = caretPosition?.offsetNode;
    const offset = caretPosition?.offset;
    if (!node || offset === undefined || !content.contains(node)) return undefined;
    const prefix = ownerDocument.createRange();
    prefix.selectNodeContents(content);
    try {
      prefix.setEnd(node, offset);
      return Math.min(content.textContent.length, prefix.toString().length);
    } catch {
      return undefined;
    }
  }

  private rangeForParagraph(
    element: HTMLElement,
    start: number,
    end: number
  ): Range | null {
    const content = element.querySelector<HTMLElement>('.docx-paragraph-content');
    if (!content || end <= start) return null;
    const boundary = (target: number): { readonly node: Node; readonly offset: number } => {
      const walker = element.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let remaining = target;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode();
      }
      return { node: content, offset: content.childNodes.length };
    };
    const startBoundary = boundary(start);
    const endBoundary = boundary(end);
    const range = element.ownerDocument.createRange();
    try {
      range.setStart(startBoundary.node, startBoundary.offset);
      range.setEnd(endBoundary.node, endBoundary.offset);
      return range;
    } catch {
      return null;
    }
  }

  private notifyLocationChange(): void {
    const paragraph = this.paragraphsByIndex.get(this.currentParagraphIndex);
    const pageIndex = paragraph?.pageIndex ?? Math.max(0, this.currentPage - 1);
    const characterStart = this.currentCharacterStart;
    const characterEnd = this.currentCharacterEnd;
    const hasRange =
      characterStart !== undefined &&
      characterEnd !== undefined &&
      characterEnd > characterStart;
    this.onLocationChange?.({
      format: this.format,
      paragraphIndex: this.currentParagraphIndex,
      ...(hasRange ? {
        characterStart,
        characterEnd,
      } : {}),
      renderedPageIndex: pageIndex,
    }, this.getProgress());
  }

  private applyLayoutStyles(): void {
    const maxWidth = Math.round(PAGE_SIZES[this.format].width * this.zoom * (this.contentWidth / 72));
    for (const wrapper of this.pageWrappers.values()) {
      wrapper.style.width = `min(calc(100% - 2rem), ${String(maxWidth)}px)`;
      wrapper.style.minHeight = `${String(Math.round(PAGE_SIZES[this.format].height * this.zoom))}px`;
      wrapper.style.padding = `${String(this.horizontalMarginRem)}rem`;
      wrapper.style.fontSize = `${String(this.zoom * this.fontSize)}rem`;
      wrapper.style.lineHeight = String(this.lineHeight);
      wrapper.style.fontFamily = this.fontFamily === 'serif'
        ? 'Georgia, "Times New Roman", serif'
        : this.fontFamily === 'sans'
          ? 'ui-sans-serif, system-ui, sans-serif'
          : this.fontFamily === 'dyslexic'
            ? 'OpenDyslexic, Arial, sans-serif'
            : 'ui-sans-serif, system-ui, -apple-system, sans-serif';
      wrapper.style.setProperty('--interleaf-paragraph-spacing', `${String(this.paragraphSpacing)}em`);
      for (const paragraph of wrapper.querySelectorAll<HTMLElement>('.docx-paragraph')) {
        paragraph.style.marginBottom = `${String(this.paragraphSpacing)}em`;
      }
    }
  }

  close(): Promise<void> {
    notePointerDetachOwner(this);
    this.openSequence += 1;
    this.searchSequence += 1;
    this.annotationSequence += 1;
    this.openController?.abort();
    this.openController = null;
    this.teardownDom();
    this.payload = null;
    this.paragraphs = [];
    this.paragraphsByIndex.clear();
    this.blocksByPage.clear();
    this.currentCharacterStart = undefined;
    this.currentCharacterEnd = undefined;
    this.documentId = '';
    this.documentHash = '';
    this.annotations = [];
    this.onSelectionChange = undefined;
    this.onAnnotationResolution = undefined;
    return Promise.resolve();
  }

  private teardownDom(): void {
    if (this.selectionListener) document.removeEventListener('selectionchange', this.selectionListener);
    this.selectionListener = null;
    clearDomHighlights(document);
    clearSearchHighlight(document);
    if (this.scrollListener) this.scrollContainer?.removeEventListener('scroll', this.scrollListener);
    this.scrollListener = null;
    if (this.scrollAnimationFrame !== null) window.cancelAnimationFrame(this.scrollAnimationFrame);
    this.scrollAnimationFrame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.reflowAnchor = null;
    this.lastObservedWidth = 0;
    this.observer?.disconnect();
    this.observer = null;
    this.pageWrappers.clear();
    this.renderedPages.clear();
    this.container?.replaceChildren();
    this.scrollContainer = null;
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
    if (selection?.rangeCount !== 1 || selection.isCollapsed || !this.scrollContainer) return { selection: null, error: null };
    const range = selection.getRangeAt(0);
    const nativeSelectedText = selection.toString();
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    const startParagraph = startElement?.closest<HTMLElement>('[data-docx-paragraph]');
    const endParagraph = endElement?.closest<HTMLElement>('[data-docx-paragraph]');
    if (!startParagraph || !endParagraph || !this.scrollContainer.contains(startParagraph) || !this.scrollContainer.contains(endParagraph)) return { selection: null, error: null };

    const startParaNum = Number(startParagraph.dataset.docxParagraph);
    const endParaNum = Number(endParagraph.dataset.docxParagraph);
    if (!Number.isInteger(startParaNum) || !Number.isInteger(endParaNum)) return { selection: null, error: null };

    const minPara = Math.min(startParaNum, endParaNum);
    const maxPara = Math.max(startParaNum, endParaNum);

    if (minPara === maxPara) {
      const content = startParagraph.querySelector<HTMLElement>('.docx-paragraph-content') ?? startParagraph;
      const subRange = subRangeWithin(content, range);
      if (!subRange) return { selection: null, error: null };
      const offsets = rangeOffsetsWithin(content, subRange);
      const quote = quoteContextForRange(content, subRange);
      const paragraph = this.paragraphsByIndex.get(minPara);
      if (!offsets || !quote || !paragraph) return { selection: null, error: null };
      const rect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      const selectedText = nativeSelectedText || quote.exact;
      const chatDescriptor: DocxChatSelectionDescriptor | PptxChatSelectionDescriptor = {
        format: this.format,
        startParagraphIndex: minPara,
        endParagraphIndex: minPara,
        startRenderedPageIndex: paragraph.pageIndex,
        endRenderedPageIndex: paragraph.pageIndex,
        startQuote: boundedQuoteContext(quote),
        endQuote: boundedQuoteContext(quote),
        startCharacterOffset: offsets.start,
        endCharacterOffset: offsets.end,
        selectedTextSnippet: takeCodePointPrefix(selectedText, 500),
      };
      const anchor: OoxmlAnchor = {
        format: this.format,
        quote,
        paragraphIndex: minPara,
        characterStart: offsets.start,
        characterEnd: offsets.end,
        renderedPageIndex: paragraph.pageIndex,
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

    const rawSegments: DocxAnchorSegment[] = [];

    for (let paraIndex = minPara; paraIndex <= maxPara; paraIndex++) {
      const paragraph = this.paragraphsByIndex.get(paraIndex);
      if (!paragraph) continue;
      const wrapper = this.pageWrappers.get(paragraph.pageIndex);
      const paraEl = wrapper?.querySelector<HTMLElement>(`[data-docx-paragraph="${String(paraIndex)}"]`);
      if (!paraEl) continue;
      const content = paraEl.querySelector<HTMLElement>('.docx-paragraph-content') ?? paraEl;
      const subRange = subRangeWithin(content, range);
      if (!subRange) continue;
      const offsets = rangeOffsetsWithin(content, subRange);
      const quote = quoteContextForRange(content, subRange);
      if (!offsets || !quote || quote.exact.length === 0) continue;
      rawSegments.push({
        paragraphIndex: paraIndex,
        quote,
        characterStart: offsets.start,
        characterEnd: offsets.end,
        renderedPageIndex: paragraph.pageIndex,
      });
    }

    const firstRaw = rawSegments[0];
    const lastRaw = rawSegments[rawSegments.length - 1];
    const firstPara = this.paragraphsByIndex.get(minPara);
    const lastPara = this.paragraphsByIndex.get(maxPara);

    const chatDescriptor: DocxChatSelectionDescriptor | PptxChatSelectionDescriptor = {
      format: this.format,
      startParagraphIndex: minPara,
      endParagraphIndex: maxPara,
      ...(firstPara?.pageIndex !== undefined ? { startRenderedPageIndex: firstPara.pageIndex } : {}),
      ...(lastPara?.pageIndex !== undefined ? { endRenderedPageIndex: lastPara.pageIndex } : {}),
      ...(firstRaw?.quote ? { startQuote: boundedQuoteContext(firstRaw.quote) } : {}),
      ...(lastRaw?.quote ? { endQuote: boundedQuoteContext(lastRaw.quote) } : {}),
      ...(firstRaw?.characterStart !== undefined ? { startCharacterOffset: firstRaw.characterStart } : {}),
      ...(lastRaw?.characterEnd !== undefined ? { endCharacterOffset: lastRaw.characterEnd } : {}),
      selectedTextSnippet: takeCodePointPrefix(nativeSelectedText, 500),
    };

    let anchor: OoxmlAnchor | null = null;
    const isWithinAnnotationBounds =
      maxPara - minPara + 1 <= 100 && nativeSelectedText.length <= 256_000;

    if (isWithinAnnotationBounds && rawSegments.length > 0) {
      if (rawSegments.length === 1 && rawSegments[0]) {
        const seg = rawSegments[0];
        anchor = {
          format: this.format,
          quote: seg.quote,
          paragraphIndex: seg.paragraphIndex,
          ...(seg.characterStart !== undefined ? { characterStart: seg.characterStart } : {}),
          ...(seg.characterEnd !== undefined ? { characterEnd: seg.characterEnd } : {}),
          ...(seg.renderedPageIndex !== undefined ? { renderedPageIndex: seg.renderedPageIndex } : {}),
        };
      } else {
        const partition = partitionMultiSegmentText(rawSegments, nativeSelectedText);
        if (partition.ok) {
          const segments = partition.segments;
          const fullSelectedText = partition.reconstructedText;
          const firstSegment = segments[0];
          const lastSegment = segments[segments.length - 1];
          if (firstSegment && lastSegment) {
            const topLevelQuote: QuoteContext = {
              exact: takeCodePointPrefix(fullSelectedText, 256_000),
              prefix: firstSegment.quote.prefix,
              suffix: lastSegment.quote.suffix,
            };
            anchor = {
              format: this.format,
              quote: topLevelQuote,
              paragraphIndex: firstSegment.paragraphIndex,
              ...(firstSegment.characterStart !== undefined ? { characterStart: firstSegment.characterStart } : {}),
              ...(firstSegment.characterEnd !== undefined ? { characterEnd: firstSegment.characterEnd } : {}),
              ...(firstSegment.renderedPageIndex !== undefined ? { renderedPageIndex: firstSegment.renderedPageIndex } : {}),
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
    this.annotations = annotations.filter((annotation) => annotation.anchor.format === this.format);
    return this.refreshAnnotations();
  }

  async goToAnnotation(annotation: Annotation): Promise<void> {
    if (annotation.anchor.format === this.format) await this.goToLocation(anchorToLocation(annotation.anchor));
  }

  getAnnotationScope(): { readonly format: 'docx' | 'pptx'; readonly pageStart: number; readonly pageEnd: number } | null {
    if (!this.payload) return null;
    const pageIndex = this.currentPage - 1;
    return {
      format: this.format,
      pageStart: Math.max(0, pageIndex - 2),
      pageEnd: Math.min(this.pageCount - 1, pageIndex + 2),
    };
  }

  private async refreshAnnotations(): Promise<readonly AnnotationAnchorResolution[]> {
    if (!this.payload) return [];
    const sequence = ++this.annotationSequence;
    const results: AnnotationAnchorResolution[] = [];
    const painted: { annotation: Annotation; range: Range }[] = [];
    for (const annotation of this.annotations) {
      if (sequence !== this.annotationSequence) return [];
      const resolved = await this.resolveAnnotation(annotation);
      if (sequence !== this.annotationSequence) return [];
      results.push(resolved.result);
      this.onAnnotationResolution?.(resolved.result);
      for (const range of resolved.ranges) painted.push({ annotation, range });
    }
    if (sequence === this.annotationSequence) paintAnchoredRanges(this, document, painted);
    return results;
  }

  private async resolveAnnotation(annotation: Annotation): Promise<{
    readonly result: AnnotationAnchorResolution;
    readonly ranges: readonly Range[];
  }> {
    const anchor = annotation.anchor as OoxmlAnchor;
    if (anchor.segments && anchor.segments.length > 0) {
      const repairedSegments: DocxAnchorSegment[] = [];
      const ranges: Range[] = [];
      let anyAnchored = false;
      let bestStage: AnnotationAnchorResolution['stage'] = 'unanchored';

      for (const segment of anchor.segments) {
        const paragraph = this.paragraphsByIndex.get(segment.paragraphIndex);
        if (!paragraph) {
          repairedSegments.push(segment);
          continue;
        }
        const resolution = await resolveTextAnchor(paragraph.text, segment.quote, {
          ...(segment.characterStart !== undefined && segment.characterEnd !== undefined
            ? { nativeRange: { start: segment.characterStart, end: segment.characterEnd } }
            : {}),
          priorOffset: segment.characterStart ?? 0,
        });
        if (!resolution) {
          repairedSegments.push(segment);
          continue;
        }
        anyAnchored = true;
        if (resolution.stage === 'native' || bestStage === 'unanchored' || bestStage === 'fuzzy') {
          bestStage = resolution.stage;
        }
        const content = this.pageWrappers
          .get(paragraph.pageIndex)
          ?.querySelector<HTMLElement>(`[data-docx-paragraph="${String(paragraph.index)}"] .docx-paragraph-content`);
        const range = content ? rangeFromOffsets(content, resolution) : null;
        if (range) ranges.push(range);
        repairedSegments.push({
          ...segment,
          characterStart: resolution.start,
          characterEnd: resolution.end,
          renderedPageIndex: paragraph.pageIndex,
        });
      }

      const firstRepaired = repairedSegments[0] ?? anchor;
      const repairedAnchor: OoxmlAnchor = {
        ...anchor,
        paragraphIndex: firstRepaired.paragraphIndex,
        ...(firstRepaired.characterStart !== undefined ? { characterStart: firstRepaired.characterStart } : {}),
        ...(firstRepaired.characterEnd !== undefined ? { characterEnd: firstRepaired.characterEnd } : {}),
        ...(firstRepaired.renderedPageIndex !== undefined ? { renderedPageIndex: firstRepaired.renderedPageIndex } : {}),
        segments: repairedSegments,
      };

      return {
        result: {
          annotationId: annotation.id,
          status: anyAnchored ? 'anchored' : annotation.status,
          anchor: repairedAnchor,
          stage: bestStage,
        },
        ranges,
      };
    }

    if (anchor.quote.exact.length === 0) {
      const exists = this.paragraphsByIndex.has(anchor.paragraphIndex);
      return {
        result: {
          annotationId: annotation.id,
          status: exists ? 'anchored' : 'unanchored',
          anchor,
          stage: exists ? 'native' : 'unanchored',
        },
        ranges: [],
      };
    }
    const priorOrdinal = Math.max(0, this.paragraphs.findIndex((item) => item.index === anchor.paragraphIndex));
    const candidateOrdinals: number[] = [priorOrdinal];
    for (let distance = 1; distance <= 20; distance += 1) {
      if (priorOrdinal - distance >= 0) candidateOrdinals.push(priorOrdinal - distance);
      if (priorOrdinal + distance < this.paragraphs.length) candidateOrdinals.push(priorOrdinal + distance);
    }
    for (const ordinal of candidateOrdinals) {
      const paragraph = this.paragraphs[ordinal];
      if (!paragraph) continue;
      const isNativeParagraph = paragraph.index === anchor.paragraphIndex;
      const resolution = await resolveTextAnchor(paragraph.text, anchor.quote, {
        ...(isNativeParagraph && anchor.characterStart !== undefined && anchor.characterEnd !== undefined
          ? { nativeRange: { start: anchor.characterStart, end: anchor.characterEnd } }
          : {}),
        priorOffset: isNativeParagraph ? anchor.characterStart ?? 0 : 0,
      });
      if (!resolution) continue;
      const repairedAnchor: OoxmlAnchor = {
        ...anchor,
        paragraphIndex: paragraph.index,
        characterStart: resolution.start,
        characterEnd: resolution.end,
        renderedPageIndex: paragraph.pageIndex,
      };
      const content = this.pageWrappers
        .get(paragraph.pageIndex)
        ?.querySelector<HTMLElement>(`[data-docx-paragraph="${String(paragraph.index)}"] .docx-paragraph-content`);
      const range = content ? rangeFromOffsets(content, resolution) : null;
      return {
        result: {
          annotationId: annotation.id,
          status: 'anchored',
          anchor: repairedAnchor,
          stage: resolution.stage,
        },
        ranges: range ? [range] : [],
      };
    }
    return {
      result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
      ranges: [],
    };
  }

  getTableOfContents(): Promise<readonly TableOfContentsItem[]> {
    return Promise.resolve((this.payload?.toc ?? []).map((item, index) => ({
      id: `${this.format}-toc-${String(index)}-${String(item.paragraphIndex)}`,
      title: item.title,
      location: { format: this.format, paragraphIndex: item.paragraphIndex, renderedPageIndex: item.pageIndex },
      level: item.level, children: [],
    })));
  }

  goToLocation(location: DocumentLocation): Promise<void> {
    if (!this.ownsLocation(location) || this.paragraphs.length === 0) return Promise.resolve();
    const paragraph = this.paragraphsByIndex.get(location.paragraphIndex)
      ?? this.paragraphs.reduce((nearest, candidate) => Math.abs(candidate.index - location.paragraphIndex) < Math.abs(nearest.index - location.paragraphIndex) ? candidate : nearest);
    this.currentParagraphIndex = paragraph.index;
    this.currentPage = paragraph.pageIndex + 1;
    const hasRange =
      location.characterStart !== undefined &&
      location.characterEnd !== undefined &&
      location.characterStart >= 0 &&
      location.characterEnd > location.characterStart &&
      location.characterEnd <= paragraph.text.length;
    this.currentCharacterStart = hasRange ? location.characterStart : undefined;
    this.currentCharacterEnd = hasRange ? location.characterEnd : undefined;
    this.renderPage(paragraph.pageIndex);
    this.pruneRenderedPages(paragraph.pageIndex);
    const element = this.pageWrappers.get(paragraph.pageIndex)?.querySelector<HTMLElement>(`[data-docx-paragraph="${String(paragraph.index)}"]`);
    const characterStart = location.characterStart;
    const characterEnd = location.characterEnd;
    const range = element && hasRange && characterStart !== undefined && characterEnd !== undefined
      ? this.rangeForParagraph(element, characterStart, characterEnd)
      : null;
    const rangeRect = range && typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : null;
    if (rangeRect && this.scrollContainer && Number.isFinite(rangeRect.top)) {
      const scrollerTop = this.scrollContainer.getBoundingClientRect().top;
      this.scrollContainer.scrollTop += rangeRect.top - scrollerTop - 24;
    } else if (element) {
      element.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' });
    }
    this.notifyLocationChange();
    return Promise.resolve();
  }

  getReadingLocation(): { readonly location: OoxmlLocation; readonly progress: number } {
    const paragraph = this.paragraphsByIndex.get(this.currentParagraphIndex);
    return {
      location: {
        format: this.format,
        paragraphIndex: this.currentParagraphIndex,
        ...(this.currentCharacterStart !== undefined &&
        this.currentCharacterEnd !== undefined &&
        this.currentCharacterEnd > this.currentCharacterStart ? {
          characterStart: this.currentCharacterStart,
          characterEnd: this.currentCharacterEnd,
        } : {}),
        renderedPageIndex: paragraph?.pageIndex ?? Math.max(0, this.currentPage - 1),
      },
      progress: this.getProgress(),
    };
  }

  getProgress(): number {
    if (this.paragraphs.length <= 1) return this.paragraphs.length === 1 ? 1 : 0;
    const ordinal = this.paragraphs.findIndex((paragraph) => paragraph.index === this.currentParagraphIndex);
    return Math.max(0, Math.min(1, ordinal / (this.paragraphs.length - 1)));
  }

  async search(query: string): Promise<readonly SearchMatch[]> {
    const needle = query.trim().slice(0, MAX_DOCX_SEARCH_QUERY_LENGTH);
    if (!needle) return [];
    const sequence = ++this.searchSequence;
    const foldedNeedle = caseFold(needle);
    const matches: SearchMatch[] = [];
    const workBudget = { utf16Units: 0 };
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    if (sequence !== this.searchSequence) return [];
    for (const paragraph of this.paragraphs) {
      const folded = await foldTextWithOffsets(
        paragraph.text,
        () => sequence !== this.searchSequence,
        workBudget
      );
      if (!folded) return [];
      const { folded: foldedText, starts, ends } = folded;
      const seenRanges = new Set<string>();
      let offset = 0;
      while (offset <= foldedText.length - foldedNeedle.length) {
        const found = foldedText.indexOf(foldedNeedle, offset);
        if (found < 0) break;
        const originalStart = starts[found];
        const originalEnd = ends[found + foldedNeedle.length - 1];
        if (originalStart === undefined || originalEnd === undefined) break;
        const rangeKey = `${String(originalStart)}:${String(originalEnd)}`;
        if (!seenRanges.has(rangeKey)) {
          seenRanges.add(rangeKey);
          matches.push({
            id: `docx-match-${String(paragraph.index)}-${String(originalStart)}-${String(originalEnd)}`,
            location: {
              format: this.format,
              paragraphIndex: paragraph.index,
              characterStart: originalStart,
              characterEnd: originalEnd,
              renderedPageIndex: paragraph.pageIndex,
            },
            text: paragraph.text.slice(originalStart, originalEnd),
            textStart: originalStart,
            textEnd: originalEnd,
            prefix: paragraph.text.slice(Math.max(0, originalStart - 50), originalStart),
            suffix: paragraph.text.slice(originalEnd, originalEnd + 50),
          });
          if (matches.length >= MAX_DOCX_SEARCH_RESULTS) return matches;
        }
        offset = found + Math.max(1, foldedNeedle.length);
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
      !this.ownsLocation(location)
    ) {
      return { status: 'stale', text: null, rangeCount: 0 };
    }
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    await this.goToLocation(location);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    const paragraph = this.paragraphsByIndex.get(location.paragraphIndex);
    const wrapper = paragraph ? this.pageWrappers.get(paragraph.pageIndex) : undefined;
    const element = wrapper?.querySelector<HTMLElement>(
      `[data-docx-paragraph="${String(location.paragraphIndex)}"] .docx-paragraph-content`
    );
    if (!element) return { status: 'not-found', text: null, rangeCount: 0 };
    const ranges = rangesForSearchAnchor(element, request.anchor);
    if (isSearchHighlightCancelled(request) || ranges.length === 0) return { status: 'not-found', text: null, rangeCount: 0 };
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
    await Promise.resolve();
    let heading: string | null = null;
    let ordinal = 0;
    for (const paragraph of this.paragraphs) {
      if (paragraph.headingLevel && paragraph.text.trim()) heading = paragraph.text.trim();
      if (!paragraph.text.trim()) continue;
      yield this.makeChunk(paragraph, ordinal++, heading);
    }
  }

  extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]> {
    if (!this.ownsLocation(location)) return Promise.resolve([]);
    const paragraph = this.paragraphsByIndex.get(location.paragraphIndex);
    if (!paragraph) return Promise.resolve([]);
    let heading: string | null = null;
    for (const candidate of this.paragraphs) {
      if (candidate.index > paragraph.index) break;
      if (candidate.headingLevel && candidate.text.trim()) heading = candidate.text.trim();
    }
    return Promise.resolve([this.makeChunk(paragraph, paragraph.index, heading, location)]);
  }

  private makeChunk(
    paragraph: ParsedDocxParagraph,
    ordinal: number,
    heading: string | null,
    location?: OoxmlLocation
  ): NormalizedTextChunk {
    return {
      id: `chunk-${this.documentId}-${this.format}-${String(paragraph.index)}`,
      documentId: this.documentId,
      ordinal,
      text: paragraph.text,
      tokenCount: Math.ceil(paragraph.text.length / 4),
      location: location ?? { format: this.format, paragraphIndex: paragraph.index, renderedPageIndex: paragraph.pageIndex },
      heading,
      pageLabel: `${this.format === 'pptx' ? 'Slide' : 'Rendered page'} ${String(paragraph.pageIndex + 1)}`,
    };
  }

  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void> {
    if (typeof zoom === 'number') {
      this.zoomMode = 'custom';
      this.zoom = Math.max(0.25, Math.min(4, zoom));
    } else {
      this.zoomMode = zoom;
      const width = Math.max(240, this.container?.clientWidth ?? PAGE_SIZES[this.format].width);
      const height = Math.max(240, this.container?.clientHeight ?? PAGE_SIZES[this.format].height);
      const widthScale = (width - 32) / PAGE_SIZES[this.format].width;
      this.zoom = Math.max(0.25, Math.min(4, zoom === 'fit-page' ? Math.min(widthScale, (height - 48) / PAGE_SIZES[this.format].height) : widthScale));
    }
    this.applyLayoutStyles();
    // Layout mutations change fragment rects without resizing the outer
    // page boxes; drop cached note-pointer rect geometry explicitly.
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
    this.applyLayoutStyles();
    notePointerInvalidateLayout();
    return Promise.resolve();
  }

  private ownsLocation(location: DocumentLocation): location is OoxmlLocation {
    return location.format === this.format;
  }

  getZoom(): number { return this.zoom; }
  getZoomMode(): ZoomMode { return this.zoomMode; }
  getPageCount(): number { return this.pageCount; }
  getCurrentPage(): number { return this.currentPage; }

  goToPage(pageNumber: number): Promise<void> {
    const clamped = Math.max(1, Math.min(this.pageCount, pageNumber));
    this.currentPage = clamped;
    const pageIndex = clamped - 1;
    this.renderPage(pageIndex);
    this.pruneRenderedPages(pageIndex);
    const first = this.paragraphs.find((paragraph) => paragraph.pageIndex === pageIndex);
    if (first) {
      this.currentParagraphIndex = first.index;
      this.currentCharacterStart = first.text.length > 0 ? 0 : undefined;
      this.currentCharacterEnd = first.text.length > 0 ? 1 : undefined;
    }
    const wrapper = this.pageWrappers.get(pageIndex);
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this.notifyLocationChange();
    return Promise.resolve();
  }
}
