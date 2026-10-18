import type {
  DocumentFormat,
  DocumentLocation,
  DocumentMediaAsset,
  MarkdownChatSelectionDescriptor,
  MarkdownLocation,
  NormalizedTextChunk,
  SearchMatch,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
import type {
  DocumentAdapter,
  DocumentSource,
  ReflowOptions,
  SearchHighlightRequest,
  SearchHighlightResult,
} from '../types';
import type {
  AnnotationAnchorResolution,
  AnnotationResolutionCallback,
  DocumentAdapterCapabilities,
  ExternalLinkCallback,
  ReaderSelection,
  SelectionChangeCallback,
  SelectionIssue,
} from '../types';
import { isSearchHighlightCancelled } from '../types';
import type { Annotation, AnnotationAnchorScope, MarkdownAnnotationAnchor, MarkdownAnchorSegment, QuoteContext } from '@shared/types/annotation';
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
import { subscribeLayoutWillChange } from '../../../components/layout-change-signal';
import { caseFold, lookupFolding } from 'unicode-case-folding';
import { parseExternalHttpUrl } from '@shared/schemas/external-link';
import { containsArticleAssetReference } from '@shared/legacy/legacy-brand-values';
import {
  isSafeMarkdownUrl,
  MAX_MARKDOWN_DOCUMENT_BYTES,
  parseMarkdownDocument,
  type MarkdownBlock,
  type MarkdownHeadingBlock,
  type MarkdownInline,
  type ParsedMarkdownDocument,
} from './markdown-parser';
import {
  createMermaidFigure,
  describeDiagramKind,
  detectAppearance,
  DIAGRAM_BUDGET_NOTE,
  MERMAID_LANGUAGE,
  paintDiagram,
  showDiagramNote,
  syncDiagramScrollAffordance,
} from './mermaid-block';
import { describeMermaidFailure, MERMAID_LIMITS } from '@shared/schemas/mermaid';
import type { MermaidAppearance, MermaidRenderResult } from '@shared/types/mermaid';
import { MARKDOWN_HEADING_SIZE_CLASSES } from './markdown-heading-classes';
import { bridge } from '../../../app/api-client';

/** One fenced diagram: where to paint it, and what to say if it is not drawn. */
type MermaidFigureEntry = {
  readonly index: number;
  readonly source: string;
  readonly label: string;
  readonly region: HTMLElement;
  readonly note: HTMLElement;
};

/**
 * A frame's grace on top of the reader's surface transition, so the colour a
 * diagram's appearance is decided from is the settled one.
 */
const SURFACE_SETTLE_MARGIN_MS = 32;

const MAX_MARKDOWN_SEARCH_RESULTS = 5_000;
const MAX_MARKDOWN_SEARCH_QUERY_LENGTH = 1_024;
const SEARCH_YIELD_UTF16_UNITS = 128 * 1024;
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
  for (let offset = 0; offset < value.length; ) {
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

/**
 * An archived image as a snapshot spells it: `![alt](interleaf-asset:<hash><ext>)`.
 * Alt text may contain escaped brackets such as `\[` or `\]` (e.g. `![Chart \[v2\]](interleaf-asset:...)`).
 *
 * Snapshots captured before the Interleaf rename spell the same reference
 * `marginlab-asset:`. Both are matched so an older archived article still
 * renders its alt text instead of a raw hash.
 */
const ASSET_IMAGE_REFERENCE = /!\[((?:\\.|[^\\\]])*)\]\((?:interleaf|marginlab)-asset:[^)]*\)/g;

/**
 * Drops the durable reference from an archived image, keeping its alt text.
 *
 * The reference is storage bookkeeping that no reader sees: sixty-four hex
 * characters are a false hit for anyone searching a word that happens to be
 * spelled in hex, and they are tokens spent on nothing in an AI context. The
 * alt text is the opposite — it is the only description of the picture the
 * text carries — so it stays where the image was. Escaped brackets inside alt
 * text are unescaped for human-readable search and AI extraction.
 */
function stripAssetReferences(text: string): string {
  if (!containsArticleAssetReference(text)) return text;
  return text.replace(ASSET_IMAGE_REFERENCE, (_match, alt: string) => {
    return alt.replace(/\\([[\]\\])/g, '$1');
  });
}

function getBlockText(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'list':
    case 'table':
      return stripAssetReferences(block.text);
    case 'code_block':
      return block.code;
    case 'hr':
      return '';
  }
}

export class MarkdownAdapter implements DocumentAdapter {
  readonly format: DocumentFormat = 'markdown';
  readonly capabilities: DocumentAdapterCapabilities = { reflow: this, externalLinks: this };

  private container: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private contentWrapper: HTMLElement | null = null;
  private parsedDoc: ParsedMarkdownDocument | null = null;
  private blocks: readonly MarkdownBlock[] = [];
  private readonly blocksByIndex = new Map<number, MarkdownBlock>();
  private readonly blockElements = new Map<number, HTMLElement>();
  private readonly headingElements = new Map<string, HTMLElement>();
  private tableWrappers: HTMLElement[] = [];
  private mermaidFigures: MermaidFigureEntry[] = [];
  private mermaidAppearance: MermaidAppearance | null = null;
  private mermaidThemeObserver: MutationObserver | null = null;
  private mermaidAppearanceTimer: number | null = null;
  /**
   * Guards diagram painting against its own re-entry. A theme change starts a
   * fresh pass while the previous one may still be awaiting main; only the
   * newest pass is allowed to touch the document.
   */
  private mermaidSequence = 0;
  private scrollListener: (() => void) | null = null;
  private scrollAnimationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeLayoutWillChange: (() => void) | null = null;
  private lastObservedWidth = 0;
  /** The painted measure the current anchor was taken against. */
  private lastObservedMeasure = 0;
  private reflowAnchor: ReflowAnchor | null = null;
  private openController: AbortController | null = null;
  private openSequence = 0;
  private documentId = '';
  private documentHash = '';
  /** Durable image reference to the capability main issued for this open. */
  private readonly mediaAssets = new Map<string, DocumentMediaAsset>();
  private currentBlockIndex = 0;
  private currentCharacterStart: number | undefined;
  private currentCharacterEnd: number | undefined;
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
  private onLocationChange?: ((location: MarkdownLocation, progress: number) => void) | undefined;
  private onExternalLink?: ((url: string) => void | Promise<void>) | undefined;

  setLocationChangeCallback(callback: ((location: MarkdownLocation, progress: number) => void) | null): void {
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
    this.mediaAssets.clear();
    for (const asset of source.mediaAssets) {
      this.mediaAssets.set(asset.reference, asset);
    }
    containerElement.replaceChildren();

    try {
      const markdownText = await this.fetchText(source.assetUrl, controller.signal);
      controller.signal.throwIfAborted();
      if (sequence !== this.openSequence) return;

      const parsedDoc = parseMarkdownDocument(markdownText);
      this.parsedDoc = parsedDoc;
      this.blocks = parsedDoc.blocks;
      this.blocksByIndex.clear();
      for (const block of this.blocks) {
        this.blocksByIndex.set(block.index, block);
      }
      this.currentBlockIndex = this.blocks[0]?.index ?? 0;
      this.currentCharacterStart = undefined;
      this.currentCharacterEnd = undefined;

      this.buildDom(containerElement);
      if (source.initialLocation?.format === 'markdown') {
        await this.goToLocation(source.initialLocation);
      } else {
        this.updateReadingPositionFromViewport();
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== this.openSequence) return;
      this.teardownDom();
      throw error;
    } finally {
      if (this.openController === controller) this.openController = null;
    }
  }

  private async fetchText(assetUrl: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const response = await fetch(assetUrl, { signal });
    if (!response.ok) {
      throw new Error(`Failed to load Markdown asset (${String(response.status)}).`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MARKDOWN_DOCUMENT_BYTES) {
      throw new Error(
        `Markdown document exceeds maximum supported size of ${String(MAX_MARKDOWN_DOCUMENT_BYTES / (1024 * 1024))} MB.`
      );
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_MARKDOWN_DOCUMENT_BYTES) {
      throw new Error(
        `Markdown document exceeds maximum supported size of ${String(MAX_MARKDOWN_DOCUMENT_BYTES / (1024 * 1024))} MB.`
      );
    }

    // Decode as UTF-8 safely with fatal: true
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      return decoder.decode(buffer);
    } catch {
      throw new Error('Invalid Markdown document: file contains invalid UTF-8 encoding.');
    }
  }

  private buildDom(containerElement: HTMLElement): void {
    const scroller = document.createElement('div');
    scroller.className =
      'markdown-viewer-scroll-container h-full w-full overflow-y-auto overflow-x-hidden flex flex-col items-center py-6 outline-hidden';
    scroller.setAttribute('data-testid', 'markdown-scroll-container');
    scroller.setAttribute('tabindex', '0');
    this.scrollContainer = scroller;

    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-content-wrapper w-full box-border transition-all';
    wrapper.setAttribute('data-testid', 'markdown-content-wrapper');
    wrapper.style.backgroundColor = 'var(--reader-background-override, var(--bg-reader))';
    wrapper.style.color = 'var(--reader-foreground-override, var(--text-primary))';
    this.contentWrapper = wrapper;

    this.applyLayoutStyles();
    this.renderAllBlocks(wrapper);
    scroller.appendChild(wrapper);
    containerElement.appendChild(scroller);

    this.scrollListener = () => {
      if (this.scrollAnimationFrame !== null) return;
      this.scrollAnimationFrame = window.requestAnimationFrame(() => {
        this.scrollAnimationFrame = null;
        this.updateReadingPositionFromViewport();
        this.captureReadingAnchor();
      });
    };
    scroller.addEventListener('scroll', this.scrollListener, { passive: true });
    this.installReflowAnchoring(scroller);
    this.installSelectionListener();
    this.installMermaidThemeWatcher();
    // Diagrams are drawn after the document is readable, never as a condition
    // of it: a reader can scroll, select, and annotate the text while the
    // pictures are still arriving, and a renderer that never answers costs
    // nothing but the illustrations.
    void this.renderMermaidFigures();
    // A document opened into a surface that was chosen earlier is painted
    // moments after this wrapper is attached, so the first appearance is
    // confirmed once the reader is actually painted.
    this.scheduleMermaidAppearanceCheck();
  }

  /**
   * Redraws diagrams when the surface they are read against changes.
   *
   * Both the application palette and the independent reader background are DOM
   * attributes, and either can turn a legible diagram into a dark picture on a
   * dark page. The appearance is re-derived from the painted colour and a pass
   * only runs when it actually changed, so unrelated attribute churn costs no
   * renders.
   */
  private installMermaidThemeWatcher(): void {
    this.mermaidThemeObserver?.disconnect();
    this.mermaidThemeObserver = null;
    const observer = new MutationObserver(() => {
      this.scheduleMermaidAppearanceCheck();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-theme', 'data-reader-background'],
    });
    this.mermaidThemeObserver = observer;
  }

  /**
   * Re-reads the surface once it has finished changing colour.
   *
   * A palette or reading-background change is an attribute write, but the
   * reader crossfades to the new colour: for the length of that transition
   * `getComputedStyle` answers with the colour currently being painted, which
   * is still the surface the reader is leaving. Deciding there would redraw
   * every diagram for the old appearance, or not redraw them at all. The
   * check therefore waits out the reader's own transition — read from the
   * element rather than hard-coded, so it follows the stylesheet — and
   * coalesces, so a burst of attribute writes costs one comparison.
   */
  private scheduleMermaidAppearanceCheck(): void {
    if (this.mermaidFigures.length === 0) return;
    // Restarted rather than kept: a check already in flight was timed for an
    // earlier change and would land part-way through this one's crossfade,
    // leaving the diagrams drawn for a surface the reader has left.
    if (this.mermaidAppearanceTimer !== null) window.clearTimeout(this.mermaidAppearanceTimer);
    this.mermaidAppearanceTimer = window.setTimeout(() => {
      this.mermaidAppearanceTimer = null;
      if (this.mermaidFigures.length === 0) return;
      if (this.diagramAppearance() === this.mermaidAppearance) return;
      void this.renderMermaidFigures();
    }, this.surfaceSettleMs() + SURFACE_SETTLE_MARGIN_MS);
  }

  /**
   * The appearance a diagram should be drawn for.
   *
   * Measured from the box a picture is actually painted into rather than from
   * the page behind it: the diagram card carries its own surface, and a
   * drawing is legible or not against *that* colour. Falling back to the
   * content wrapper only matters before the first figure exists.
   */
  private diagramAppearance(): MermaidAppearance {
    const region = this.mermaidFigures.find((figure) => figure.region.isConnected)?.region;
    return detectAppearance(region ?? this.contentWrapper);
  }

  /** How long the reader takes to finish crossfading to a new surface. */
  private surfaceSettleMs(): number {
    const element = this.contentWrapper;
    if (element === null) return 0;
    let longest = 0;
    for (const value of window.getComputedStyle(element).transitionDuration.split(',')) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) longest = Math.max(longest, seconds);
    }
    return Math.ceil(longest * 1000);
  }

  /**
   * Draws every fenced diagram in the open document, one at a time.
   *
   * Two guards decide whether a result may still be shown: the open sequence,
   * which a close or a reopen moves, and this pass's own sequence, which a
   * theme change moves. A reply that arrives after either has moved belongs to
   * a reader that no longer exists and is dropped rather than painted into
   * whatever is on screen now.
   */
  private async renderMermaidFigures(): Promise<void> {
    const figures = this.mermaidFigures;
    if (figures.length === 0) return;
    const sequence = ++this.mermaidSequence;
    const openSequence = this.openSequence;
    const appearance = this.diagramAppearance();
    this.mermaidAppearance = appearance;

    for (const [position, entry] of figures.entries()) {
      if (sequence !== this.mermaidSequence || openSequence !== this.openSequence) return;
      if (!entry.region.isConnected) continue;

      if (position >= MERMAID_LIMITS.maxDiagramsPerDocument) {
        showDiagramNote(entry.region, entry.note, DIAGRAM_BUDGET_NOTE);
        continue;
      }
      let result: MermaidRenderResult;
      try {
        result = await bridge.reader.renderMermaid({ source: entry.source, appearance });
      } catch {
        // A rejected bridge call is a failure of Interleaf's own plumbing, not
        // a statement about the diagram; it reads the same to the reader.
        result = { status: 'failed', reason: 'unavailable' };
      }
      if (sequence !== this.mermaidSequence || openSequence !== this.openSequence) return;
      // Asked of the document rather than the element: a reopen can replace the
      // reader's children while this job was in flight, and the box that was
      // mounted when the request went out may no longer be part of anything.
      if (!document.contains(entry.region)) continue;

      if (result.status === 'rendered') {
        entry.region.hidden = false;
        entry.note.hidden = true;
        paintDiagram(entry.region, result, entry.label);
        syncDiagramScrollAffordance(entry.region, entry.label);
        continue;
      }
      showDiagramNote(
        entry.region,
        entry.note,
        describeMermaidFailure(result) ?? 'This diagram could not be drawn.'
      );
    }
  }

  /**
   * Markdown is laid out to a `ch`-based measure, so any width the reader is
   * narrower than that measure re-wraps the text. Resizing a side panel or
   * opening the Outline must not therefore move the reader through the
   * document: the block under the top of the viewport is put back where it was.
   *
   * The anchor is recorded as the reader scrolls (and when a panel announces
   * a resize), never in the ResizeObserver: that runs after layout, when the
   * text has already re-wrapped under the reader.
   *
   * The content wrapper is observed as well as the scroller: the measure is
   * what wraps the text, and it can keep changing after the scroller's one
   * resize, so restoring on the scroller alone would leave the reader adrift.
   */
  private installReflowAnchoring(scroller: HTMLElement): void {
    this.lastObservedWidth = scroller.clientWidth;
    this.lastObservedMeasure = this.contentWrapper?.clientWidth ?? 0;
    this.captureReadingAnchor();
    this.resizeObserver = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      const measure = this.contentWrapper?.clientWidth ?? 0;
      // Height alone does not re-wrap anything, and reacting to it would fight
      // the reader every time a toolbar appeared.
      if (width === this.lastObservedWidth && measure === this.lastObservedMeasure) return;
      this.lastObservedWidth = width;
      this.lastObservedMeasure = measure;
      this.syncTableScrollAffordance();
      restoreReflowAnchor(scroller, this.reflowAnchor);
      // Painted annotation rects moved with the text.
      notePointerInvalidateLayout();
    });
    this.resizeObserver.observe(scroller);
    if (this.contentWrapper !== null) this.resizeObserver.observe(this.contentWrapper);
    // Records a scroll made in the same task as a panel resize, pre-commit.
    this.unsubscribeLayoutWillChange = subscribeLayoutWillChange(() => { this.captureReadingAnchor(); });
  }

  /** Records where the reader is now, for the next reflow to restore. */
  private captureReadingAnchor(): void {
    const scroller = this.scrollContainer;
    if (!scroller) return;
    // A rAF-batched capture can run after a re-wrap but before the restore, when
    // the viewport top is drift: refresh only while the anchor's width holds.
    if (
      this.resizeObserver !== null
      && (scroller.clientWidth !== this.lastObservedWidth
        || (this.contentWrapper?.clientWidth ?? 0) !== this.lastObservedMeasure)
    ) return;
    this.reflowAnchor = captureReflowAnchor(scroller, this.blockElements.values());
  }

  private renderAllBlocks(wrapper: HTMLElement): void {
    wrapper.replaceChildren();
    this.blockElements.clear();
    this.headingElements.clear();
    this.tableWrappers = [];
    // Repopulated by `createBlockElement` as each fenced diagram is built.
    this.mermaidFigures = [];

    for (const block of this.blocks) {
      const blockElement = this.createBlockElement(block);
      this.blockElements.set(block.index, blockElement);
      if (block.type === 'heading') {
        this.headingElements.set(block.headingId, blockElement);
      }
      if (block.type === 'table') this.tableWrappers.push(blockElement);
      wrapper.appendChild(blockElement);
    }
    this.syncTableScrollAffordance();
  }

  /**
   * Puts a sideways-scrolling table into the tab order as its own named region.
   *
   * An `overflow-x: auto` box scrolls with the arrow keys only once something
   * can focus it, so without this a wide table is reachable by pointer and by
   * nothing else. The affordance is applied only while the table actually
   * overflows — otherwise every table in a document would be a tab stop and a
   * landmark announcing scrolling that cannot happen — which makes it a
   * function of layout, so it is re-evaluated after rendering, after a
   * typography or zoom change, and after a width change.
   */
  private syncTableScrollAffordance(): void {
    for (const [index, table] of this.tableWrappers.entries()) {
      if (table.scrollWidth > table.clientWidth) {
        table.setAttribute('tabindex', '0');
        table.setAttribute('role', 'region');
        // Numbered because identical landmark names are indistinguishable to
        // anyone navigating by region.
        table.setAttribute('aria-label', `Table ${String(index + 1)}, scrollable horizontally`);
        continue;
      }
      table.removeAttribute('tabindex');
      table.removeAttribute('role');
      table.removeAttribute('aria-label');
    }
    // A diagram box overflows for the same reasons and at the same moments a
    // table does, so the two affordances are kept in step.
    for (const figure of this.mermaidFigures) {
      syncDiagramScrollAffordance(figure.region, figure.label);
    }
  }

  private createBlockElement(block: MarkdownBlock): HTMLElement {
    switch (block.type) {
      case 'heading': {
        const heading = document.createElement(`h${String(block.level)}`);
        heading.id = block.headingId;
        heading.setAttribute('data-markdown-block', String(block.index));
        heading.setAttribute('data-testid', `markdown-heading-${String(block.level)}`);
        heading.className = `markdown-heading markdown-h${String(block.level)} ${MARKDOWN_HEADING_SIZE_CLASSES[block.level]} text-text-primary scroll-mt-6`;
        const contentSpan = document.createElement('span');
        contentSpan.className = 'markdown-block-content';
        this.renderInlinesInto(block.children, contentSpan);
        heading.appendChild(contentSpan);
        return heading;
      }

      case 'paragraph': {
        const p = document.createElement('p');
        p.setAttribute('data-markdown-block', String(block.index));
        p.setAttribute('data-testid', `markdown-paragraph-${String(block.index)}`);
        p.className = 'markdown-paragraph leading-relaxed text-text-primary';
        p.style.marginBottom = `${String(this.paragraphSpacing)}em`;
        const contentSpan = document.createElement('span');
        contentSpan.className = 'markdown-block-content';
        this.renderInlinesInto(block.children, contentSpan);
        p.appendChild(contentSpan);
        return p;
      }

      case 'code_block': {
        const pre = document.createElement('pre');
        pre.setAttribute('data-markdown-block', String(block.index));
        // Built first and unchanged, so a diagram block is the ordinary code
        // block plus an illustration rather than a different rendering.
        pre.setAttribute('data-testid', `markdown-code-block-${String(block.index)}`);
        pre.className =
          'markdown-code-block rounded-lg p-4 font-mono text-[0.75em] overflow-x-auto bg-bg-surface border border-border-subtle my-4 leading-normal';
        const code = document.createElement('code');
        code.className = block.language ? `language-${block.language}` : '';
        const contentSpan = document.createElement('span');
        contentSpan.className = 'markdown-block-content font-mono';
        contentSpan.textContent = block.code;
        code.appendChild(contentSpan);
        pre.appendChild(code);
        if (block.language !== MERMAID_LANGUAGE) return pre;

        const figure = createMermaidFigure(block.index, pre);
        this.mermaidFigures.push({
          index: block.index,
          source: block.code,
          label: describeDiagramKind(block.code),
          region: figure.region,
          note: figure.note,
        });
        return figure.figure;
      }

      case 'blockquote': {
        const bq = document.createElement('blockquote');
        bq.setAttribute('data-markdown-block', String(block.index));
        bq.setAttribute('data-testid', `markdown-blockquote-${String(block.index)}`);
        bq.className =
          'markdown-blockquote border-l-4 border-accent/60 pl-4 py-1 italic my-3 text-text-secondary';
        const contentSpan = document.createElement('span');
        contentSpan.className = 'markdown-block-content';
        this.renderInlinesInto(block.children, contentSpan);
        bq.appendChild(contentSpan);
        return bq;
      }

      case 'list': {
        const list = document.createElement(block.list.ordered ? 'ol' : 'ul');
        list.setAttribute('data-markdown-block', String(block.index));
        list.setAttribute('data-testid', `markdown-list-${String(block.index)}`);
        list.className = block.list.ordered
          ? 'markdown-list markdown-list-ordered list-decimal pl-6 my-3 space-y-1'
          : 'markdown-list markdown-list-unordered list-disc pl-6 my-3 space-y-1';
        for (const item of block.list.items) {
          const li = document.createElement('li');
          li.className = 'markdown-list-item leading-relaxed';
          if (item.checked !== null && item.checked !== undefined) {
            li.className += ' list-none -ml-5 flex items-start gap-2';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.disabled = true;
            checkbox.checked = item.checked;
            checkbox.className = 'mt-1 rounded-xs border-border-subtle text-accent';
            checkbox.setAttribute('aria-label', item.text);
            li.appendChild(checkbox);
          }
          const contentSpan = document.createElement('span');
          contentSpan.className = 'markdown-block-content';
          this.renderInlinesInto(item.children, contentSpan);
          li.appendChild(contentSpan);
          list.appendChild(li);
        }
        return list;
      }

      case 'table': {
        const container = document.createElement('div');
        container.setAttribute('data-markdown-block', String(block.index));
        container.setAttribute('data-testid', `markdown-table-${String(block.index)}`);
        container.className =
          'markdown-table-wrapper w-full overflow-x-auto my-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

        const table = document.createElement('table');
        table.className = 'markdown-table w-full border-collapse border border-border-subtle text-[0.75em]';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.className = 'bg-bg-surface border-b border-border-subtle';
        for (const header of block.table.headers) {
          const th = document.createElement('th');
          th.className = 'border border-border-subtle p-2 font-semibold text-text-primary';
          if (header.align) th.style.textAlign = header.align;
          const contentSpan = document.createElement('span');
          contentSpan.className = 'markdown-block-content';
          this.renderInlinesInto(header.children, contentSpan);
          th.appendChild(contentSpan);
          headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of block.table.rows) {
          const tr = document.createElement('tr');
          tr.className = 'border-b border-border-subtle/50 hover:bg-bg-surface/50';
          for (const cell of row.cells) {
            const td = document.createElement('td');
            td.className = 'border border-border-subtle p-2 text-text-primary';
            if (cell.align) td.style.textAlign = cell.align;
            const contentSpan = document.createElement('span');
            contentSpan.className = 'markdown-block-content';
            this.renderInlinesInto(cell.children, contentSpan);
            td.appendChild(contentSpan);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
        return container;
      }

      case 'hr': {
        const hr = document.createElement('hr');
        hr.setAttribute('data-markdown-block', String(block.index));
        hr.setAttribute('data-testid', `markdown-hr-${String(block.index)}`);
        hr.className = 'markdown-hr border-t border-border-subtle my-6';
        return hr;
      }
    }
  }

  private renderInlinesInto(inlines: readonly MarkdownInline[], parent: HTMLElement): void {
    for (const inline of inlines) {
      switch (inline.type) {
        case 'text':
          parent.appendChild(document.createTextNode(inline.text));
          break;

        case 'html_text':
          // Raw HTML is rendered as inert text node to completely prevent injection
          parent.appendChild(document.createTextNode(inline.raw));
          break;

        case 'strong': {
          const strong = document.createElement('strong');
          strong.className = 'font-bold';
          this.renderInlinesInto(inline.children, strong);
          parent.appendChild(strong);
          break;
        }

        case 'emphasis': {
          const em = document.createElement('em');
          em.className = 'italic';
          this.renderInlinesInto(inline.children, em);
          parent.appendChild(em);
          break;
        }

        case 'strikethrough': {
          const del = document.createElement('del');
          del.className = 'line-through opacity-80';
          this.renderInlinesInto(inline.children, del);
          parent.appendChild(del);
          break;
        }

        case 'code': {
          const code = document.createElement('code');
          code.className =
            'rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[0.9em] border border-border-subtle/50 text-accent';
          code.textContent = inline.code;
          parent.appendChild(code);
          break;
        }

        case 'link': {
          if (isSafeMarkdownUrl(inline.href)) {
            const a = document.createElement('a');
            a.href = inline.href;
            a.rel = 'noopener noreferrer';
            if (inline.title) a.title = inline.title;
            const isInternalFragment = inline.href.startsWith('#');
            // An external target is reported to the host, which is the only
            // party that can open it. The click itself never navigates: this
            // surface has no navigation, and a captured article's links are
            // untrusted data like the rest of it.
            const externalTarget = isInternalFragment ? null : parseExternalHttpUrl(inline.href);
            if (!isInternalFragment) {
              a.setAttribute('data-external-link', 'true');
              // A validated http/https target is actionable through the host,
              // so assistive tech announces it as a working link; a link this
              // surface cannot act on (e.g. mailto:) is announced as inert.
              a.toggleAttribute('aria-disabled', externalTarget === null);
            }
            a.className =
              'markdown-link text-accent underline underline-offset-2 hover:opacity-80 transition-opacity';
            a.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isInternalFragment) {
                const targetId = inline.href.slice(1);
                const targetEl = this.headingElements.get(targetId);
                if (targetEl) {
                  targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
                return;
              }
              if (externalTarget !== null) void this.onExternalLink?.(externalTarget);
            });
            this.renderInlinesInto(inline.children, a);
            parent.appendChild(a);
          } else {
            // Unsafe scheme: render as plain text without link capabilities
            this.renderInlinesInto(inline.children, parent);
          }
          break;
        }

        case 'image': {
          // A captured article names its pictures by durable reference. Only
          // main can turn one into something loadable, and it only does so for
          // the open document, so an unknown reference stays alt text and no
          // remote URL is ever resolvable here.
          const resolved = this.mediaAssets.get(inline.src);
          if (resolved?.url.startsWith('interleaf-media:') === true) {
            const img = document.createElement('img');
            img.src = resolved.url;
            img.alt = inline.alt;
            if (inline.title) img.title = inline.title;
            // Intrinsic size reserves the box before the image decodes, so
            // captured images do not reflow the text a reader is looking at.
            img.width = resolved.width;
            img.height = resolved.height;
            img.decoding = 'async';
            img.className = 'markdown-image max-w-full h-auto rounded my-3 mx-auto block';
            parent.appendChild(img);
          } else {
            const span = document.createElement('span');
            span.className = 'markdown-image-alt text-text-secondary text-[0.75em] italic';
            span.textContent = `[Image: ${inline.alt}]`;
            parent.appendChild(span);
          }
          break;
        }
      }
    }
  }

  private applyLayoutStyles(): void {
    const wrapper = this.contentWrapper;
    if (!wrapper) return;

    wrapper.style.maxWidth = `${String(this.contentWidth)}ch`;
    wrapper.style.paddingLeft = `${String(this.horizontalMarginRem)}rem`;
    wrapper.style.paddingRight = `${String(this.horizontalMarginRem)}rem`;
    wrapper.style.fontSize = `${String(this.fontSize * this.zoom)}rem`;
    wrapper.style.lineHeight = String(this.lineHeight);

    const fontFamilies: Record<NonNullable<ReflowOptions['fontFamily']>, string> = {
      system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
      sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      dyslexic: 'OpenDyslexic, comic sans ms, sans-serif',
    };
    wrapper.style.fontFamily = fontFamilies[this.fontFamily];

    for (const paragraph of wrapper.querySelectorAll<HTMLElement>('.markdown-paragraph')) {
      paragraph.style.marginBottom = `${String(this.paragraphSpacing)}em`;
      // Paragraphs carry the `leading-relaxed` utility class, whose rule
      // beats the inherited wrapper line-height; the reflow setting must be
      // applied inline to take (and to visibly reflow) effect.
      paragraph.style.lineHeight = String(this.lineHeight);
    }
    for (const item of wrapper.querySelectorAll<HTMLElement>('.markdown-list-item')) {
      item.style.lineHeight = String(this.lineHeight);
    }
    // Narrowing the measure or enlarging the type can push a table that fit
    // into overflow, and widening it can do the reverse.
    this.syncTableScrollAffordance();
  }

  close(): Promise<void> {
    notePointerDetachOwner(this);
    this.openSequence += 1;
    this.searchSequence += 1;
    this.annotationSequence += 1;
    this.openController?.abort();
    this.openController = null;
    this.teardownDom();
    this.parsedDoc = null;
    this.blocks = [];
    this.blocksByIndex.clear();
    this.blockElements.clear();
    this.headingElements.clear();
    this.currentCharacterStart = undefined;
    this.currentCharacterEnd = undefined;
    this.documentId = '';
    this.documentHash = '';
    this.annotations = [];
    this.onSelectionChange = undefined;
    this.onAnnotationResolution = undefined;
    this.onExternalLink = undefined;
    return Promise.resolve();
  }

  private teardownDom(): void {
    if (this.selectionListener) {
      document.removeEventListener('selectionchange', this.selectionListener);
    }
    this.selectionListener = null;
    clearDomHighlights(document);
    clearSearchHighlight(document);
    if (this.scrollListener) {
      this.scrollContainer?.removeEventListener('scroll', this.scrollListener);
    }
    this.scrollListener = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unsubscribeLayoutWillChange?.();
    this.unsubscribeLayoutWillChange = null;
    this.reflowAnchor = null;
    this.lastObservedWidth = 0;
    this.lastObservedMeasure = 0;
    if (this.scrollAnimationFrame !== null) {
      window.cancelAnimationFrame(this.scrollAnimationFrame);
    }
    this.scrollAnimationFrame = null;
    this.blockElements.clear();
    this.headingElements.clear();
    this.tableWrappers = [];
    // Moving the sequence retires any diagram render still in flight, so a
    // reply that arrives after teardown finds no reader to paint into.
    this.mermaidSequence += 1;
    this.mermaidFigures = [];
    this.mermaidAppearance = null;
    this.mermaidThemeObserver?.disconnect();
    this.mermaidThemeObserver = null;
    if (this.mermaidAppearanceTimer !== null) {
      window.clearTimeout(this.mermaidAppearanceTimer);
      this.mermaidAppearanceTimer = null;
    }
    this.container?.replaceChildren();
    this.scrollContainer = null;
    this.contentWrapper = null;
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

  /**
   * The element a block's character offsets are measured against.
   *
   * Almost every block renders one `.markdown-block-content` span holding all of
   * its text. Lists and tables are the exceptions: each is a single
   * `[data-markdown-block]` element with one content span per `<li>` or per
   * `<th>`/`<td>`, so the first span is only the first item or the first header
   * cell — a selection anywhere later intersects nothing and is dropped, and an
   * anchor stored there can never be found again. The block element itself is
   * the one root covering every cell or item, and capture and resolution both
   * ask for it here, so an offset means the same thing in both directions.
   *
   * That root's text runs the cells together with no separator, while the
   * platform's own copied string puts tabs and newlines between them. Offsets
   * and quotes are therefore measured in the DOM's separator-free text, which
   * keeps capture and resolution consistent; a stored quote spanning several
   * cells reads without those separators.
   */
  private blockTextRoot(blockElement: HTMLElement, block: MarkdownBlock | undefined): HTMLElement {
    if (block?.type === 'list' || block?.type === 'table') return blockElement;
    return blockElement.querySelector<HTMLElement>('.markdown-block-content') ?? blockElement;
  }

  private captureSelection(): { selection: ReaderSelection | null; error: SelectionIssue | null } {
    const selection = document.getSelection();
    if (selection?.rangeCount !== 1 || selection.isCollapsed || !this.scrollContainer) {
      return { selection: null, error: null };
    }
    const range = selection.getRangeAt(0);
    const nativeSelectedText = selection.toString();
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    const startBlock = startElement?.closest<HTMLElement>('[data-markdown-block]');
    const endBlock = endElement?.closest<HTMLElement>('[data-markdown-block]');
    if (!startBlock || !endBlock || !this.scrollContainer.contains(startBlock) || !this.scrollContainer.contains(endBlock)) {
      return { selection: null, error: null };
    }

    const startBlockNum = Number(startBlock.dataset.markdownBlock);
    const endBlockNum = Number(endBlock.dataset.markdownBlock);
    if (!Number.isInteger(startBlockNum) || !Number.isInteger(endBlockNum)) return { selection: null, error: null };
    const minBlock = Math.min(startBlockNum, endBlockNum);
    const maxBlock = Math.max(startBlockNum, endBlockNum);

    if (minBlock === maxBlock) {
      const block = this.blocksByIndex.get(minBlock);
      const content = this.blockTextRoot(startBlock, block);
      const subRange = subRangeWithin(content, range);
      if (!subRange) return { selection: null, error: null };

      const offsets = rangeOffsetsWithin(content, subRange);
      const quote = quoteContextForRange(content, subRange);
      if (!offsets || !quote || !block) return { selection: null, error: null };

      const rect = range.getBoundingClientRect();
      const selectedText = quote.exact;
      const chatDescriptor: MarkdownChatSelectionDescriptor = {
        format: 'markdown',
        startBlockIndex: minBlock,
        endBlockIndex: minBlock,
        startLineIndex: block.lineIndex,
        endLineIndex: block.lineIndex,
        ...(block.type === 'heading' && block.headingId ? { startHeadingId: block.headingId, endHeadingId: block.headingId } : {}),
        startQuote: boundedQuoteContext(quote),
        endQuote: boundedQuoteContext(quote),
        startCharacterOffset: offsets.start,
        endCharacterOffset: offsets.end,
        selectedTextSnippet: takeCodePointPrefix(selectedText, 500),
      };
      const anchor: MarkdownAnnotationAnchor = {
        format: 'markdown',
        quote,
        blockIndex: minBlock,
        characterStart: offsets.start,
        characterEnd: offsets.end,
        lineIndex: block.lineIndex,
        ...(block.type === 'heading' ? { headingId: block.headingId } : {}),
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

    const rawSegments: MarkdownAnchorSegment[] = [];

    for (let blockIndex = minBlock; blockIndex <= maxBlock; blockIndex++) {
      const blockEl = this.blockElements.get(blockIndex);
      const block = this.blocksByIndex.get(blockIndex);
      if (!blockEl || !block) continue;
      const content = this.blockTextRoot(blockEl, block);
      const subRange = subRangeWithin(content, range);
      if (!subRange) continue;
      const offsets = rangeOffsetsWithin(content, subRange);
      const quote = quoteContextForRange(content, subRange);
      if (!offsets || !quote || quote.exact.length === 0) continue;
      rawSegments.push({
        blockIndex,
        quote,
        characterStart: offsets.start,
        characterEnd: offsets.end,
        lineIndex: block.lineIndex,
        ...(block.type === 'heading' ? { headingId: block.headingId } : {}),
      });
    }

    const firstRaw = rawSegments[0];
    const lastRaw = rawSegments[rawSegments.length - 1];
    const firstBlock = this.blocksByIndex.get(minBlock);
    const lastBlock = this.blocksByIndex.get(maxBlock);

    const chatDescriptor: MarkdownChatSelectionDescriptor = {
      format: 'markdown',
      startBlockIndex: minBlock,
      endBlockIndex: maxBlock,
      ...(firstBlock?.lineIndex !== undefined ? { startLineIndex: firstBlock.lineIndex } : {}),
      ...(lastBlock?.lineIndex !== undefined ? { endLineIndex: lastBlock.lineIndex } : {}),
      ...(firstBlock?.type === 'heading' && firstBlock.headingId ? { startHeadingId: firstBlock.headingId } : {}),
      ...(lastBlock?.type === 'heading' && lastBlock.headingId ? { endHeadingId: lastBlock.headingId } : {}),
      ...(firstRaw?.quote ? { startQuote: boundedQuoteContext(firstRaw.quote) } : {}),
      ...(lastRaw?.quote ? { endQuote: boundedQuoteContext(lastRaw.quote) } : {}),
      ...(firstRaw?.characterStart !== undefined ? { startCharacterOffset: firstRaw.characterStart } : {}),
      ...(lastRaw?.characterEnd !== undefined ? { endCharacterOffset: lastRaw.characterEnd } : {}),
      selectedTextSnippet: takeCodePointPrefix(nativeSelectedText, 500),
    };

    let anchor: MarkdownAnnotationAnchor | null = null;
    const isWithinAnnotationBounds =
      maxBlock - minBlock + 1 <= 100 && nativeSelectedText.length <= 256_000;

    if (isWithinAnnotationBounds && rawSegments.length > 0) {
      if (rawSegments.length === 1 && rawSegments[0]) {
        const seg = rawSegments[0];
        anchor = {
          format: 'markdown',
          quote: seg.quote,
          blockIndex: seg.blockIndex,
          ...(seg.characterStart !== undefined ? { characterStart: seg.characterStart } : {}),
          ...(seg.characterEnd !== undefined ? { characterEnd: seg.characterEnd } : {}),
          ...(seg.lineIndex !== undefined ? { lineIndex: seg.lineIndex } : {}),
          ...(seg.headingId ? { headingId: seg.headingId } : {}),
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
              format: 'markdown',
              quote: topLevelQuote,
              blockIndex: firstSegment.blockIndex,
              ...(firstSegment.characterStart !== undefined ? { characterStart: firstSegment.characterStart } : {}),
              ...(firstSegment.characterEnd !== undefined ? { characterEnd: firstSegment.characterEnd } : {}),
              ...(firstSegment.lineIndex !== undefined ? { lineIndex: firstSegment.lineIndex } : {}),
              ...(firstSegment.headingId ? { headingId: firstSegment.headingId } : {}),
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
  async setAnnotations(
    annotations: readonly Annotation[]
  ): Promise<readonly AnnotationAnchorResolution[]> {
    this.annotations = annotations.filter((annotation) => annotation.anchor.format === 'markdown');
    return this.refreshAnnotations();
  }

  async goToAnnotation(annotation: Annotation): Promise<void> {
    if (annotation.anchor.format === 'markdown') {
      await this.goToLocation(anchorToLocation(annotation.anchor));
    }
  }

  getAnnotationScope(): AnnotationAnchorScope | null {
    if (!this.parsedDoc || this.blocks.length === 0) return null;
    return {
      format: 'markdown',
      blockStart: 0,
      blockEnd: Math.max(0, this.blocks.length - 1),
    };
  }

  private async refreshAnnotations(): Promise<readonly AnnotationAnchorResolution[]> {
    if (!this.parsedDoc || !this.contentWrapper) return [];
    const sequence = ++this.annotationSequence;
    const results: AnnotationAnchorResolution[] = [];
    const painted: { annotation: Annotation; range: Range }[] = [];

    for (const annotation of this.annotations) {
      if (sequence !== this.annotationSequence) return [];
      const resolved = await this.resolveAnnotation(annotation);
      if (sequence !== this.annotationSequence) return [];
      results.push(resolved.result);
      for (const range of resolved.ranges) {
        painted.push({ annotation, range });
      }
      this.onAnnotationResolution?.(resolved.result);
    }

    if (sequence === this.annotationSequence) {
      paintAnchoredRanges(this, document, painted);
    }
    return results;
  }

  private async resolveAnnotation(
    annotation: Annotation
  ): Promise<{ result: AnnotationAnchorResolution; ranges: readonly Range[] }> {
    if (annotation.anchor.format !== 'markdown') {
      return {
        result: {
          annotationId: annotation.id,
          status: 'unanchored',
          anchor: annotation.anchor,
          stage: 'unanchored',
        },
        ranges: [],
      };
    }

    const sequence = this.annotationSequence;
    const anchor = annotation.anchor;

    if (anchor.segments && anchor.segments.length > 0) {
      const repairedSegments: MarkdownAnchorSegment[] = [];
      const ranges: Range[] = [];
      let anyAnchored = false;
      let bestStage: AnnotationAnchorResolution['stage'] = 'unanchored';

      for (const segment of anchor.segments) {
        const blockEl = this.blockElements.get(segment.blockIndex);
        const block = this.blocksByIndex.get(segment.blockIndex);
        if (!blockEl || !block) {
          repairedSegments.push(segment);
          continue;
        }
        const content = this.blockTextRoot(blockEl, block);
        const resolution = await resolveTextAnchor(content.textContent, segment.quote, {
          ...(segment.characterStart !== undefined && segment.characterEnd !== undefined
            ? { nativeRange: { start: segment.characterStart, end: segment.characterEnd } }
            : {}),
          priorOffset: segment.characterStart ?? 0,
        });
        if (sequence !== this.annotationSequence) {
          return {
            result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
            ranges: [],
          };
        }
        if (!resolution) {
          repairedSegments.push(segment);
          continue;
        }
        anyAnchored = true;
        if (resolution.stage === 'native' || bestStage === 'unanchored' || bestStage === 'fuzzy') {
          bestStage = resolution.stage;
        }
        const range = rangeFromOffsets(content, { start: resolution.start, end: resolution.end });
        if (range) ranges.push(range);
        repairedSegments.push({
          ...segment,
          characterStart: resolution.start,
          characterEnd: resolution.end,
        });
      }

      const firstRepaired = repairedSegments[0] ?? anchor;
      const repairedAnchor: MarkdownAnnotationAnchor = {
        ...anchor,
        blockIndex: firstRepaired.blockIndex,
        ...(firstRepaired.characterStart !== undefined ? { characterStart: firstRepaired.characterStart } : {}),
        ...(firstRepaired.characterEnd !== undefined ? { characterEnd: firstRepaired.characterEnd } : {}),
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

    const getHeadingIdForBlock = (blockIndex: number): string | undefined => {
      const b = this.blocksByIndex.get(blockIndex);
      if (b?.type === 'heading') return b.headingId;
      for (let i = blockIndex - 1; i >= 0; i--) {
        const prev = this.blocksByIndex.get(i);
        if (prev?.type === 'heading') return prev.headingId;
      }
      return undefined;
    };

    // 1. First check the primary block indicated by anchor.blockIndex
    const primaryBlock = this.blocksByIndex.get(anchor.blockIndex);
    const primaryBlockEl = this.blockElements.get(anchor.blockIndex);

    if (primaryBlock && primaryBlockEl) {
      const content = this.blockTextRoot(primaryBlockEl, primaryBlock);

      // Stage 1: Native offsets in primary block
      if (
        anchor.characterStart !== undefined &&
        anchor.characterEnd !== undefined &&
        anchor.characterEnd > anchor.characterStart
      ) {
        const range = rangeFromOffsets(content, {
          start: anchor.characterStart,
          end: anchor.characterEnd,
        });
        if (range?.toString() === anchor.quote.exact) {
          return {
            result: {
              annotationId: annotation.id,
              status: 'anchored',
              anchor,
              stage: 'native',
            },
            ranges: [range],
          };
        }
      }

      // Stage 2 & 3: Quote & Fuzzy matching within primary block
      const resolution = await resolveTextAnchor(
        content.textContent,
        anchor.quote,
        anchor.characterStart !== undefined ? { priorOffset: anchor.characterStart } : {}
      );

      if (sequence !== this.annotationSequence) {
        return {
          result: { annotationId: annotation.id, status: 'unanchored', anchor, stage: 'unanchored' },
          ranges: [],
        };
      }

      if (resolution) {
        const range = rangeFromOffsets(content, {
          start: resolution.start,
          end: resolution.end,
        });
        if (range) {
          const headingId = getHeadingIdForBlock(primaryBlock.index);
          const repairedAnchor: MarkdownAnnotationAnchor = {
            ...anchor,
            characterStart: resolution.start,
            characterEnd: resolution.end,
            lineIndex: primaryBlock.lineIndex,
            ...(headingId ? { headingId } : {}),
          };
          return {
            result: {
              annotationId: annotation.id,
              status: 'anchored',
              anchor: repairedAnchor,
              stage: resolution.stage,
            },
            ranges: [range],
          };
        }
      }
    }

    // 2. Multi-block Fallback Search:
    // Build candidate block list prioritizing heading match and proximity to anchor.blockIndex
    const candidateBlocks: MarkdownBlock[] = [];
    const seenIndices = new Set<number>();
    if (primaryBlock) seenIndices.add(primaryBlock.index);

    if (anchor.headingId) {
      const headingEl = this.headingElements.get(anchor.headingId);
      if (headingEl) {
        const headingBlockIdx = Number(headingEl.dataset.markdownBlock);
        for (let i = headingBlockIdx; i < this.blocks.length; i++) {
          const b = this.blocks[i];
          if (!b) break;
          if (i > headingBlockIdx && b.type === 'heading') break;
          if (!seenIndices.has(b.index)) {
            seenIndices.add(b.index);
            candidateBlocks.push(b);
          }
        }
      }
    }

    const remainingBlocks = this.blocks
      .filter((b) => !seenIndices.has(b.index))
      .sort((a, b) => Math.abs(a.index - anchor.blockIndex) - Math.abs(b.index - anchor.blockIndex));

    candidateBlocks.push(...remainingBlocks);

    for (const candidate of candidateBlocks) {
      if (sequence !== this.annotationSequence) break;
      const candidateEl = this.blockElements.get(candidate.index);
      if (!candidateEl) continue;

      const content = this.blockTextRoot(candidateEl, candidate);
      const resolution = await resolveTextAnchor(
        content.textContent,
        anchor.quote,
        anchor.characterStart !== undefined ? { priorOffset: anchor.characterStart } : {}
      );

      if (sequence !== this.annotationSequence) break;

      if (resolution) {
        const range = rangeFromOffsets(content, {
          start: resolution.start,
          end: resolution.end,
        });
        if (range) {
          const headingId = getHeadingIdForBlock(candidate.index);
          const repairedAnchor: MarkdownAnnotationAnchor = {
            format: 'markdown',
            quote: anchor.quote,
            blockIndex: candidate.index,
            characterStart: resolution.start,
            characterEnd: resolution.end,
            lineIndex: candidate.lineIndex,
            ...(headingId ? { headingId } : {}),
          };
          return {
            result: {
              annotationId: annotation.id,
              status: 'anchored',
              anchor: repairedAnchor,
              stage: resolution.stage,
            },
            ranges: [range],
          };
        }
      }
    }

    return {
      result: {
        annotationId: annotation.id,
        status: 'unanchored',
        anchor,
        stage: 'unanchored',
      },
      ranges: [],
    };
  }

  private updateReadingPositionFromViewport(): void {
    const scroller = this.scrollContainer;
    if (!scroller || this.blocks.length === 0) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const targetTop = scrollerRect.top + scrollerRect.height / 4;

    let bestBlockIndex = this.blocks[0]?.index ?? 0;
    let minDistance = Number.POSITIVE_INFINITY;

    for (const [index, element] of this.blockElements.entries()) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top - targetTop);
      if (distance < minDistance) {
        minDistance = distance;
        bestBlockIndex = index;
      }
    }

    if (bestBlockIndex !== this.currentBlockIndex) {
      this.currentCharacterStart = undefined;
      this.currentCharacterEnd = undefined;
    }

    const scrollProgress = this.getProgress();
    this.currentBlockIndex = bestBlockIndex;

    const location: MarkdownLocation = {
      format: 'markdown',
      blockIndex: bestBlockIndex,
      progression: scrollProgress,
      ...(this.blocksByIndex.get(bestBlockIndex)?.type === 'heading'
        ? {
            headingId: (this.blocksByIndex.get(bestBlockIndex) as MarkdownHeadingBlock).headingId,
          }
        : {}),
    };

    this.onLocationChange?.(location, scrollProgress);
  }

  getTableOfContents(): Promise<readonly TableOfContentsItem[]> {
    if (!this.parsedDoc) return Promise.resolve([]);

    const headings = this.blocks.filter(
      (block): block is MarkdownHeadingBlock => block.type === 'heading'
    );

    // Build hierarchical tree
    const rootItems: TableOfContentsItem[] = [];
    const stack: { item: TableOfContentsItem; children: TableOfContentsItem[] }[] = [];

    for (const heading of headings) {
      const itemChildren: TableOfContentsItem[] = [];
      const item: TableOfContentsItem = {
        id: `toc-heading-${String(heading.index)}`,
        title: heading.text,
        level: heading.level,
        location: {
          format: 'markdown',
          blockIndex: heading.index,
          headingId: heading.headingId,
          lineIndex: heading.lineIndex,
        },
        children: itemChildren,
      };

      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top && top.item.level >= heading.level) {
          stack.pop();
        } else {
          break;
        }
      }

      if (stack.length === 0) {
        rootItems.push(item);
      } else {
        const parent = stack[stack.length - 1];
        parent?.children.push(item);
      }

      stack.push({ item, children: itemChildren });
    }

    return Promise.resolve(rootItems);
  }

  goToLocation(location: DocumentLocation): Promise<void> {
    if (location.format !== 'markdown' || !this.scrollContainer) return Promise.resolve();

    let targetElement = location.headingId ? this.headingElements.get(location.headingId) : undefined;
    targetElement ??= this.blockElements.get(location.blockIndex);
    if (targetElement) {
      targetElement.scrollIntoView({ block: 'start', behavior: 'auto' });
      this.currentBlockIndex = location.blockIndex;
      this.currentCharacterStart = location.characterStart;
      this.currentCharacterEnd = location.characterEnd;
      this.updateReadingPositionFromViewport();
    } else if (
      location.progression !== undefined &&
      location.progression >= 0 &&
      location.progression <= 1
    ) {
      const maxScroll = this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight;
      if (maxScroll > 0) {
        this.scrollContainer.scrollTop = Math.round(location.progression * maxScroll);
        this.updateReadingPositionFromViewport();
      }
    }
    return Promise.resolve();
  }

  getReadingLocation(): { readonly location: MarkdownLocation; readonly progress: number } {
    const block = this.blocksByIndex.get(this.currentBlockIndex);
    return {
      location: {
        format: 'markdown',
        blockIndex: this.currentBlockIndex,
        ...(this.currentCharacterStart !== undefined &&
        this.currentCharacterEnd !== undefined &&
        this.currentCharacterEnd > this.currentCharacterStart
          ? {
              characterStart: this.currentCharacterStart,
              characterEnd: this.currentCharacterEnd,
            }
          : {}),
        ...(block?.type === 'heading' ? { headingId: block.headingId } : {}),
        progression: this.getProgress(),
      },
      progress: this.getProgress(),
    };
  }

  getProgress(): number {
    const scroller = this.scrollContainer;
    if (!scroller) return 0;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return 0;
    return Math.max(0, Math.min(1, scroller.scrollTop / maxScroll));
  }

  async search(query: string): Promise<readonly SearchMatch[]> {
    const needle = query.trim().slice(0, MAX_MARKDOWN_SEARCH_QUERY_LENGTH);
    if (!needle) return [];
    const sequence = ++this.searchSequence;
    const foldedNeedle = caseFold(needle);
    const matches: SearchMatch[] = [];
    const workBudget = { utf16Units: 0 };
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    if (sequence !== this.searchSequence) return [];

    for (const block of this.blocks) {
      const blockText = getBlockText(block);

      const folded = await foldTextWithOffsets(
        blockText,
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
            id: `markdown-match-${String(block.index)}-${String(originalStart)}-${String(originalEnd)}`,
            location: {
              format: 'markdown',
              blockIndex: block.index,
              characterStart: originalStart,
              characterEnd: originalEnd,
              lineIndex: block.lineIndex,
              ...(block.type === 'heading' ? { headingId: block.headingId } : {}),
            },
            text: blockText.slice(originalStart, originalEnd),
            textStart: originalStart,
            textEnd: originalEnd,
            prefix: blockText.slice(Math.max(0, originalStart - 50), originalStart),
            suffix: blockText.slice(originalEnd, originalEnd + 50),
          });
          if (matches.length >= MAX_MARKDOWN_SEARCH_RESULTS) return matches;
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
      location.format !== 'markdown'
    ) {
      return { status: 'stale', text: null, rangeCount: 0 };
    }
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    await this.goToLocation(location);
    if (isSearchHighlightCancelled(request)) return { status: 'stale', text: null, rangeCount: 0 };
    const blockElement = this.blockElements.get(location.blockIndex);
    const content = blockElement?.querySelector<HTMLElement>('.markdown-block-content') ?? blockElement;
    if (!content) return { status: 'not-found', text: null, rangeCount: 0 };
    const ranges = rangesForSearchAnchor(content, request.anchor);
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
    let currentHeading: string | null = null;
    let ordinal = 0;

    for (const block of this.blocks) {
      if (block.type === 'heading' && block.text.trim()) {
        currentHeading = block.text.trim();
      }
      const text = getBlockText(block);
      if (!text.trim()) continue;

      yield this.makeChunk(block, ordinal++, currentHeading);
    }
  }

  extractLocationText(location: DocumentLocation): Promise<readonly NormalizedTextChunk[]> {
    if (location.format !== 'markdown') return Promise.resolve([]);
    const block = this.blocksByIndex.get(location.blockIndex);
    if (!block) return Promise.resolve([]);

    let heading: string | null = null;
    for (const candidate of this.blocks) {
      if (candidate.index > block.index) break;
      if (candidate.type === 'heading' && candidate.text.trim()) {
        heading = candidate.text.trim();
      }
    }

    return Promise.resolve([this.makeChunk(block, block.index, heading, location)]);
  }

  private makeChunk(
    block: MarkdownBlock,
    ordinal: number,
    heading: string | null,
    location?: MarkdownLocation
  ): NormalizedTextChunk {
    const text = getBlockText(block);
    return {
      id: `chunk-${this.documentId}-markdown-${String(block.index)}`,
      documentId: this.documentId,
      ordinal,
      text,
      tokenCount: Math.ceil(text.length / 4),
      location:
        location ?? {
          format: 'markdown',
          blockIndex: block.index,
          lineIndex: block.lineIndex,
          ...(block.type === 'heading' ? { headingId: block.headingId } : {}),
        },
      heading,
      pageLabel: block.type === 'heading' ? block.text : `Block ${String(block.index + 1)}`,
    };
  }

  setZoom(zoom: number | 'fit-width' | 'fit-page'): Promise<void> {
    if (typeof zoom === 'number') {
      this.zoomMode = 'custom';
      this.zoom = Math.max(0.25, Math.min(4, zoom));
    } else {
      this.zoomMode = zoom;
      this.zoom = 1;
    }
    this.applyLayoutStyles();
    // Typography/content-width mutations move painted fragment rects without
    // resizing the fixed outer root, so the surface ResizeObserver cannot
    // fire; explicit invalidation drops cached rect geometry.
    notePointerInvalidateLayout();
    return Promise.resolve();
  }

  getZoom(): number {
    return this.zoom;
  }

  getZoomMode(): ZoomMode {
    return this.zoomMode;
  }

  getPageCount(): number {
    return 1;
  }

  getCurrentPage(): number {
    return 1;
  }

  goToPage(): Promise<void> {
    if (this.scrollContainer) {
      this.scrollContainer.scrollTop = 0;
      this.updateReadingPositionFromViewport();
    }
    return Promise.resolve();
  }

  setReflowOptions(options: ReflowOptions): Promise<void> {
    this.lineHeight = options.lineHeight;
    this.horizontalMarginRem = options.horizontalMarginRem;
    this.fontSize = options.fontSize;
    this.fontFamily = options.fontFamily;
    this.contentWidth = options.contentWidth;
    this.paragraphSpacing = options.paragraphSpacing;

    this.applyLayoutStyles();
    notePointerInvalidateLayout();
    return Promise.resolve();
  }
}
