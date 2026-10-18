// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  PdfAdapter,
  resolvePdfAnnotationAnchor,
  resolvePdfSearchAnchorRanges,
} from '../../src/renderer/features/reader/adapters/pdf-adapter';
import {
  buildPdfTextSpaceMap,
  mapIndexedRangeToRendered,
  pdfIndexedPageText,
  pdfRenderedPageText,
  pdfTextItemStrings,
  renderedOffsetForIndexedCharacter,
  type PdfTextContentEntry,
} from '../../src/renderer/features/reader/adapters/pdf-text-space';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { rangeFromOffsets, rangeOffsetsWithin } from '../../src/renderer/features/reader/annotations/dom-anchors';
import { searchHighlightRanges } from '../../src/renderer/features/reader/annotations/search-highlight';
import { resolveTextAnchor } from '../../src/renderer/features/reader/annotations/text-anchor-resolver';
import { createSearchMatchAnchor } from '../../src/shared/search/match-anchor';
import type { Annotation, QuoteContext } from '../../src/shared/types/annotation';
import type { PdfLocation } from '../../src/shared/types/document';
import type { SearchMatchAnchor } from '../../src/shared/types/search';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { TestCanvasContext } from '../helpers/canvas-context';
import { testDocumentSource } from '../helpers/document-source';

/**
 * A PDF page's text reaches the app through two different concatenations of the
 * same `getTextContent()` item sequence: the indexed space
 * (`items.join(' ').trim()`, what the FTS index and every stored anchor offset
 * live in) and the rendered space (`items.join('')`, what PDF.js's text layer
 * exposes as `textContent`). Applying an indexed offset straight to the DOM
 * paints a word one character further left per preceding item boundary.
 *
 * Every fixture below is deliberately multi-item, because a page whose text is
 * one item makes the two spaces identical and the assertions vacuous.
 */

/** One text run as `getTextContent` reports it. */
function textItem(str: string, hasEOL = false): TextItem {
  return {
    str,
    dir: 'ltr',
    transform: [1, 0, 0, 1, 0, 0],
    width: str.length * 5,
    height: 10,
    fontName: 'g_d0_f1',
    hasEOL,
  };
}

/** One marked-content boundary, which carries no text of its own. */
function markedContent(type: string, id = ''): TextMarkedContent {
  return { type, id };
}

describe('PDF index/render text space mapping', () => {
  it('keeps only entries carrying a string str, in item order', () => {
    // `getTextContent({ includeMarkedContent: true })` interleaves
    // `TextMarkedContent` entries, which have no `str` property at all, with
    // the `TextItem`s. Both spaces are built from the text items alone, so the
    // marked-content entries must contribute neither text nor a separator.
    const items: readonly PdfTextContentEntry[] = [
      markedContent('beginMarkedContentProps', 'p0_mc0'),
      textItem('alpha', true),
      markedContent('endMarkedContent'),
      textItem(''),
      textItem('omega'),
    ];

    expect(pdfTextItemStrings(items)).toEqual(['alpha', '', 'omega']);
    // The empty item still contributes its own separator on either side.
    expect(pdfIndexedPageText(pdfTextItemStrings(items))).toBe('alpha  omega');
    expect(pdfRenderedPageText(pdfTextItemStrings(items))).toBe('alphaomega');
  });

  it('separates every item pair in index space and nothing in render space', () => {
    const strings = ['alpha', 'beta', 'gamma'];
    const map = buildPdfTextSpaceMap(strings);

    expect(map.indexedText).toBe('alpha beta gamma');
    expect(map.renderedText).toBe('alphabetagamma');
    expect(pdfIndexedPageText(strings)).toBe(map.indexedText);
    expect(pdfRenderedPageText(strings)).toBe(map.renderedText);

    // `gamma` sits two boundaries in, so the spaces are two characters apart.
    expect(map.indexedText.indexOf('gamma')).toBe(11);
    expect(mapIndexedRangeToRendered(map, 11, 16)).toEqual({ start: 9, end: 14 });
    // The first item is the degenerate single-item case: no drift yet.
    expect(mapIndexedRangeToRendered(map, 0, 5)).toEqual({ start: 0, end: 5 });
  });

  it('counts a separator for empty items, which render nothing at all', () => {
    const map = buildPdfTextSpaceMap(['alpha', '', '', 'omega']);

    expect(map.indexedText).toBe('alpha   omega');
    expect(map.renderedText).toBe('alphaomega');
    expect(mapIndexedRangeToRendered(map, 8, 13)).toEqual({ start: 5, end: 10 });
    // The separators themselves have no rendered counterpart.
    expect(renderedOffsetForIndexedCharacter(map, 5)).toBeNull();
    expect(renderedOffsetForIndexedCharacter(map, 6)).toBeNull();
    expect(renderedOffsetForIndexedCharacter(map, 7)).toBeNull();
  });

  it('carries explicit intra-item whitespace through unchanged', () => {
    const map = buildPdfTextSpaceMap(['gap   between', 'words']);

    expect(map.indexedText).toBe('gap   between words');
    expect(map.renderedText).toBe('gap   betweenwords');
    // Explicit whitespace is real text in both spaces, so it maps normally.
    expect(mapIndexedRangeToRendered(map, 3, 6)).toEqual({ start: 3, end: 6 });
    expect(mapIndexedRangeToRendered(map, 14, 19)).toEqual({ start: 13, end: 18 });
  });

  it('offsets by the leading trim and ignores the trailing one', () => {
    const map = buildPdfTextSpaceMap(['   lead', 'tail   ']);

    expect(map.indexedText).toBe('lead tail');
    expect(map.renderedText).toBe('   leadtail   ');
    expect(map.leadingTrimLength).toBe(3);
    expect(mapIndexedRangeToRendered(map, 0, 4)).toEqual({ start: 3, end: 7 });
    expect(mapIndexedRangeToRendered(map, 5, 9)).toEqual({ start: 7, end: 11 });
  });

  it('refuses ranges that straddle a synthetic separator or leave the page', () => {
    const map = buildPdfTextSpaceMap(['   lead', 'tail   ']);

    // Starts on the separator: no rendered character corresponds to it.
    expect(mapIndexedRangeToRendered(map, 4, 9)).toBeNull();
    // Spans the separator: the rendered slice would silently drop a character,
    // so the slice comparison rejects it instead of painting a shifted word.
    expect(mapIndexedRangeToRendered(map, 3, 6)).toBeNull();
    expect(mapIndexedRangeToRendered(map, 0, 0)).toBeNull();
    expect(mapIndexedRangeToRendered(map, 5, 4)).toBeNull();
    expect(mapIndexedRangeToRendered(map, 0, 40)).toBeNull();
    expect(mapIndexedRangeToRendered(map, -1, 3)).toBeNull();
    expect(mapIndexedRangeToRendered(map, 1.5, 3)).toBeNull();
    expect(renderedOffsetForIndexedCharacter(map, map.indexedText.length)).toBeNull();
  });
});

/**
 * The rendered text layer is normalized, so a quote persisted against a raw
 * layer describes the right word in the wrong character space. These cover the
 * recovery without a PDF: the input is the layer text the adapter would read.
 */
describe('PDF annotation quote compatibility', () => {
  const layerText = 'the waffle door';

  it('prefers an exact normalized match over a truncated fuzzy raw match', async () => {
    // "waﬀle" is five characters — w, a, U+FB00, l, e — for the six the
    // normalized layer spells the same word with.
    const rawQuote: QuoteContext = { exact: 'waﬀle', prefix: 'the ', suffix: ' door' };
    expect(rawQuote.exact).toHaveLength(5);
    expect(layerText).not.toContain(rawQuote.exact);

    // The fuzzy stage compares the quote against a window of its own raw
    // length, so it clears the similarity threshold one character short and
    // would anchor a highlight that visibly stops inside the word.
    const naive = await resolveTextAnchor(layerText, rawQuote, { priorOffset: 4 });
    expect(naive?.stage).toBe('fuzzy');
    expect(layerText.slice(naive!.start, naive!.end)).toBe('waffl');

    const resolved = await resolvePdfAnnotationAnchor(layerText, rawQuote, { priorOffset: 4 });
    // Certain beats approximate: the normalized quote occurs literally.
    expect(resolved?.stage).toBe('quote');
    expect(layerText.slice(resolved!.start, resolved!.end)).toBe('waffle');
  });

  it('leaves a quote needing no normalization exactly as resolved', async () => {
    const quote: QuoteContext = { exact: 'waffle', prefix: 'the ', suffix: ' door' };
    const direct = await resolveTextAnchor(layerText, quote, { priorOffset: 4 });
    const resolved = await resolvePdfAnnotationAnchor(layerText, quote, { priorOffset: 4 });

    expect(resolved).toEqual(direct);
    expect(resolved?.stage).toBe('quote');
  });

  it('normalizes the way the rendered layer does, not with full NFKC', async () => {
    // PDF.js folds a selective character class — ligatures, a few spaces and
    // symbols, the Arabic presentation forms. Fullwidth letters are outside it,
    // so U+FF21 survives into the layer where NFKC would flatten it to "A".
    const rawQuote: QuoteContext = { exact: 'ﬀＡ', prefix: 'the ', suffix: ' door' };
    expect(rawQuote.exact.normalize('NFKC')).toBe('ffA');

    const pdfjsLayer = 'the ffＡ door';
    expect(pdfjsLayer).toContain('ffＡ');
    expect(pdfjsLayer).not.toContain('ffA');

    const resolved = await resolvePdfAnnotationAnchor(pdfjsLayer, rawQuote, { priorOffset: 4 });
    // `quote` is the exact-match stage: it fires only on a literal occurrence
    // of the normalized quote. Full NFKC would have produced "ffA", which does
    // not occur here, so it could only have reached the approximate stage —
    // the stage is what makes this assertion discriminating.
    expect(resolved?.stage).toBe('quote');
    expect(pdfjsLayer.slice(resolved?.start, resolved?.end)).toBe('ffＡ');

    // Fail-closed still holds on a layer that spells the tail differently:
    // widening the fold is not a licence to match neighbouring text.
    const otherLayer = 'the ffB door';
    expect(await resolvePdfAnnotationAnchor(otherLayer, rawQuote, { priorOffset: 4 })).toBeNull();
  });

  it('reports the unanchored answer for a quote no normalization can place', async () => {
    const quote: QuoteContext = { exact: 'ﬁreplace', prefix: '', suffix: '' };

    expect(await resolveTextAnchor(layerText, quote, { priorOffset: 0 })).toBeNull();
    expect(await resolvePdfAnnotationAnchor(layerText, quote, { priorOffset: 0 })).toBeNull();
  });
});

describe('PdfAdapter search highlight offsets', () => {
  const DOC_HASH = 'hash-pdf-search-highlight';

  const activeContainers: HTMLElement[] = [];
  const activeAdapters: PdfAdapter[] = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  // A descriptor, not the value: `Range.getClientRects` is declared on the type
  // but genuinely absent in jsdom, so only the descriptor distinguishes "not
  // there" from "there and undefined" — and it restores the original exactly.
  const originalRangeClientRects = Object.getOwnPropertyDescriptor(
    Range.prototype,
    'getClientRects'
  );

  beforeEach(() => {
    // jsdom implements no scrolling; the adapter centres the painted range.
    Element.prototype.scrollIntoView = () => undefined;

    // jsdom runs no layout, so `Range` has no `getClientRects` at all and
    // `normalizedRects` throws the moment annotation resolution measures a
    // repaired range. The empty list is the honest stand-in — it is what a
    // zero-layout document yields, and it matches the all-zero geometry jsdom
    // already reports for elements — and it leaves the measurement path real:
    // the adapter keeps the anchor's stored rects, exactly as it does for an
    // unmeasurable range in the app. Offsets and quotes, which these specs
    // assert on, are computed before any of this and are unaffected.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });

    // These specs drive rendering through `applySearchHighlight`'s own
    // `renderPage` call, so the setup's inert IntersectionObserver suffices.

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

  afterEach(async () => {
    for (const adapter of activeAdapters) {
      await adapter.close();
    }
    activeAdapters.length = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    if (originalRangeClientRects) {
      Object.defineProperty(Range.prototype, 'getClientRects', originalRangeClientRects);
    } else {
      Reflect.deleteProperty(Range.prototype, 'getClientRects');
    }
    document.getElementById('interleaf-search-highlight-styles')?.remove();
    document.getElementById('interleaf-annotation-highlight-styles')?.remove();
    for (const container of activeContainers) {
      container.parentElement?.removeChild(container);
    }
    activeContainers.length = 0;
  });

  type OpenPage = {
    readonly adapter: PdfAdapter;
    readonly layer: HTMLElement;
    /** `items.join(' ').trim()` — the space every stored offset lives in. */
    readonly indexedText: string;
    /** `items.join('')` — the space the rendered text layer exposes. */
    readonly renderedText: string;
  };

  async function openPageOne(fixture: Buffer, documentId: string): Promise<OpenPage> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    activeContainers.push(container);
    const adapter = new PdfAdapter();
    activeAdapters.push(adapter);
    await adapter.open(container, testDocumentSource({
      documentId,
      documentHash: DOC_HASH,
      assetUrl: `data:application/pdf;base64,${fixture.toString('base64')}`,
    }));
    await waitFor(
      () => {
        expect(container.querySelectorAll('.textLayer span').length).toBeGreaterThan(0);
      },
      { timeout: 5000 }
    );
    const layer = container.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
    if (!layer) throw new Error('page 1 text layer was not rendered');
    const [chunk] = await adapter.extractLocationText({ format: 'pdf', pageIndex: 0 });
    if (!chunk) throw new Error('page 1 produced no indexed chunk');
    return {
      adapter,
      layer,
      indexedText: chunk.text,
      renderedText: layer.textContent,
    };
  }

  /** Builds the anchor exactly as the indexing pipeline would for a chunk. */
  function anchorForChunk(
    documentId: string,
    indexedText: string,
    query: string,
    textStart = 0,
    textEnd = indexedText.length
  ): SearchMatchAnchor {
    const location: PdfLocation = { format: 'pdf', pageIndex: 0, textStart, textEnd };
    const anchor = createSearchMatchAnchor({
      chunkId: `chunk-${documentId}-p1`,
      documentId,
      documentHash: DOC_HASH,
      location,
      text: indexedText.slice(textStart, textEnd),
      query,
    });
    if (!anchor) throw new Error(`no anchor derived for query "${query}"`);
    return anchor;
  }

  function paint(
    adapter: PdfAdapter,
    query: string,
    anchor: SearchMatchAnchor,
    signal: AbortSignal = new AbortController().signal
  ) {
    return adapter.applySearchHighlight({
      requestId: 1,
      documentId: anchor.documentId,
      documentHash: anchor.documentHash,
      query,
      location: anchor.location,
      anchor,
      signal,
    });
  }

  /** What the old generic DOM anchoring would have painted for this anchor. */
  function naivePaintText(
    layer: HTMLElement,
    anchor: SearchMatchAnchor,
    termIndex = 0
  ): string | null {
    const location = anchor.location;
    if (location.format !== 'pdf' || location.textStart === undefined) return null;
    const term = anchor.ranges[termIndex];
    if (!term) return null;
    const range = rangeFromOffsets(layer, {
      start: location.textStart + term.start,
      end: location.textStart + term.end,
    });
    return range?.toString() ?? null;
  }

  /** The glyph span a painted range landed in, which identifies the line. */
  function glyphSpanText(range: Range): string {
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return element?.textContent ?? '';
  }

  function paintedTexts(): readonly string[] {
    return searchHighlightRanges(document).map((range) => range.toString());
  }

  /** A highlight persisted on page 1, with its anchor exactly as stored. */
  function storedAnnotation(
    documentId: string,
    quote: QuoteContext,
    textStart: number,
    textEnd: number
  ): Annotation {
    return {
      id: `annotation-${documentId}`,
      documentId,
      documentHash: DOC_HASH,
      type: 'highlight',
      anchor: { format: 'pdf', pageIndex: 0, quote, textStart, textEnd },
      selectedText: quote.exact,
      note: null,
      label: null,
      color: 'yellow',
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('paints the causative token on a multi-item page with leading trim and explicit whitespace', async () => {
    const page = await openPageOne(
      makePdfFixture({
        pageLines: [[
          // Leading whitespace the indexed join trims but the DOM keeps.
          '   Introductory filler line one.',
          // Explicit intra-item whitespace, which is real text in both spaces.
          'Second filler  line with padding.',
          'Report formats appear here.',
        ]],
        outline: [],
      }),
      'doc-pdf-highlight-multi-item'
    );

    // Exact whole-token relation: `formats` is its own token, and `format`
    // derives no anchor here at all.
    const anchor = anchorForChunk('doc-pdf-highlight-multi-item', page.indexedText, 'formats');
    expect(anchor.ranges).toHaveLength(1);
    expect(anchor.ranges[0]?.text).toBe('formats');
    expect(() => anchorForChunk('doc-pdf-highlight-multi-item', page.indexedText, 'format'))
      .toThrow(/no anchor derived/);

    // The two spaces really do diverge here; without that this test is vacuous.
    expect(page.renderedText).not.toBe(page.indexedText);
    expect(naivePaintText(page.layer, anchor)).not.toBe('formats');

    const result = await paint(page.adapter, 'formats', anchor);
    expect(result.status).toBe('applied');
    expect(result.rangeCount).toBe(1);
    expect(result.text).toBe('formats');
    expect(paintedTexts()).toEqual(['formats']);
  });

  it('paints every occurrence in its own line span', async () => {
    const page = await openPageOne(
      makePdfFixture({
        pageLines: [[
          'Alpha needle one.',
          'Beta needle two.',
          'Gamma needle three.',
        ]],
        outline: [],
      }),
      'doc-pdf-highlight-occurrences'
    );

    const anchor = anchorForChunk('doc-pdf-highlight-occurrences', page.indexedText, 'needle');
    expect(anchor.ranges).toHaveLength(3);
    // Drift accumulates one character per preceding item boundary: the first
    // occurrence is still correct, the later ones are not.
    expect(naivePaintText(page.layer, anchor)).toBe('needle');
    expect(naivePaintText(page.layer, anchor, 1)).not.toBe('needle');
    expect(naivePaintText(page.layer, anchor, 2)).not.toBe('needle');

    const result = await paint(page.adapter, 'needle', anchor);
    expect(result.status).toBe('applied');
    expect(result.rangeCount).toBe(3);
    expect(paintedTexts()).toEqual(['needle', 'needle', 'needle']);
    // Each occurrence landed in the line it came from, not one item to the left.
    expect(searchHighlightRanges(document).map(glyphSpanText)).toEqual([
      'Alpha needle one.',
      'Beta needle two.',
      'Gamma needle three.',
    ]);
  });

  it('resolves a chunk whose textStart is nonzero', async () => {
    const page = await openPageOne(
      makePdfFixture({
        pageLines: [[
          'Alpha needle one.',
          'Beta needle two.',
          'Gamma needle three.',
        ]],
        outline: [],
      }),
      'doc-pdf-highlight-chunk-offset'
    );

    // A second chunk that starts partway through the page, as the chunk
    // normalizer produces for long pages.
    const textStart = page.indexedText.indexOf('Beta');
    expect(textStart).toBeGreaterThan(0);
    const anchor = anchorForChunk(
      'doc-pdf-highlight-chunk-offset',
      page.indexedText,
      'needle',
      textStart
    );
    expect(anchor.ranges).toHaveLength(2);
    // Offsets are chunk-relative, so they are small even though the tokens are
    // late in the page.
    expect(anchor.ranges[0]?.start).toBe(page.indexedText.indexOf('Beta needle') + 5 - textStart);

    const result = await paint(page.adapter, 'needle', anchor);
    expect(result.status).toBe('applied');
    expect(paintedTexts()).toEqual(['needle', 'needle']);
    expect(searchHighlightRanges(document).map(glyphSpanText)).toEqual([
      'Beta needle two.',
      'Gamma needle three.',
    ]);
  });

  it('maps across normalized ligatures, whose expansion differs from the raw glyph count', async () => {
    const page = await openPageOne(
      // `ligaturePages` maps ASCII `A` onto U+FB00 `ﬀ` through the font's
      // ToUnicode CMap; normalization expands each to `ff`, so one `Tj` of
      // `AA` becomes the 4-character item `ffff`.
      makePdfFixture({ pageLines: [['AA', 'AA']], ligaturePages: [1], outline: [] }),
      'doc-pdf-highlight-ligature'
    );

    // Each `Tj` draws two raw glyphs, so an un-normalized page would be two
    // characters per item; both spaces show four, and neither retains U+FB00.
    expect(page.indexedText).toBe('ffff ffff');
    expect(page.renderedText).toBe('ffffffff');
    expect(page.indexedText).not.toContain('ﬀ');
    expect(page.renderedText).not.toContain('ﬀ');

    // Normalization is what decides the token, and the token is the whole
    // expansion: `ff` is a proper prefix of `ffff` and therefore not a match.
    expect(() => anchorForChunk('doc-pdf-highlight-ligature', page.indexedText, 'ff')).toThrow(
      /no anchor derived/
    );

    const anchor = anchorForChunk('doc-pdf-highlight-ligature', page.indexedText, 'ffff');
    expect(anchor.ranges.map((range) => range.text)).toEqual(['ffff', 'ffff']);
    // The stored offsets are in the indexed space, where the synthetic
    // separator pushes the second token to 5..9.
    expect(anchor.ranges[1]?.start).toBe(5);
    expect(anchor.ranges[1]?.end).toBe(9);
    // The second token sits one character further left in the DOM, so the
    // naive offsets run off the end of the rendered text.
    expect(naivePaintText(page.layer, anchor)).toBe('ffff');
    expect(naivePaintText(page.layer, anchor, 1)).not.toBe('ffff');

    const result = await paint(page.adapter, 'ffff', anchor);
    expect(result.status).toBe('applied');
    expect(paintedTexts()).toEqual(['ffff', 'ffff']);

    const [first, second] = searchHighlightRanges(document);
    if (!first || !second) throw new Error('expected two painted ranges');
    // Measure against the layer the ranges actually live in, so the assertion
    // holds whether or not the paint path re-rendered the page.
    const liveLayer = first.startContainer.parentElement?.closest('.textLayer');
    if (!liveLayer) throw new Error('painted range is not inside a text layer');
    expect(liveLayer.textContent).toBe(page.renderedText);
    // Exact positions in the rendered space. This is where the mapping is
    // proven: indexed 5..9 became rendered 4..8, the one-character correction
    // the synthetic separator requires. Measuring offsets rather than
    // containers keeps the assertion independent of how the DOM distributes
    // glyphs across text nodes — a range starting exactly on a node boundary
    // legitimately anchors to the end of the preceding node, so the two ranges
    // may share a `startContainer` while occupying different text.
    expect(rangeOffsetsWithin(liveLayer, first)).toEqual({ start: 0, end: 4 });
    expect(rangeOffsetsWithin(liveLayer, second)).toEqual({ start: 4, end: 8 });
    // Two distinct ordered ranges, not the same range painted twice. Together
    // with the offsets above (which abut at 4 and never overlap) this covers
    // the whole rendered text exactly once.
    expect(first.compareBoundaryPoints(Range.START_TO_START, second)).toBeLessThan(0);
    expect(first.toString()).toBe(page.renderedText.slice(0, 4));
    expect(second.toString()).toBe(page.renderedText.slice(4, 8));
  });

  it('re-anchors an annotation stored in the raw glyph space without moving the rendered space', async () => {
    const documentId = 'doc-pdf-legacy-raw-anchor';
    const page = await openPageOne(
      makePdfFixture({ pageLines: [['AA', 'AA']], ligaturePages: [1], outline: [] }),
      documentId
    );

    // The rendered layer is normalized, and that is the contract every stored
    // PDF offset is measured against. Denormalizing it to accommodate a raw
    // anchor would move all of them, so the recovery has to happen on the
    // quote instead.
    expect(page.renderedText).toBe('ffffffff');
    expect(page.renderedText).not.toContain('ﬀ');

    // An annotation captured against a raw text layer: the first line's two
    // U+FB00 glyphs, with offsets counted in raw glyphs. Nothing about it lines
    // up with the normalized DOM — the native slice is "ff", not "ﬀﬀ", and the
    // raw quote occurs nowhere in the layer text.
    const rawQuote: QuoteContext = { exact: 'ﬀﬀ', prefix: '', suffix: 'ﬀﬀ' };
    expect(page.renderedText).not.toContain(rawQuote.exact);
    expect(page.renderedText.slice(0, 2)).not.toBe(rawQuote.exact);
    // Resolution without the compatibility path is the unanchored answer: the
    // fuzzy stage sizes its candidate window to the raw quote's two characters,
    // so it scores the 4-character expansion against "ff" and falls short.
    expect(
      await resolveTextAnchor(page.renderedText, rawQuote, {
        nativeRange: { start: 0, end: 2 },
        priorOffset: 0,
      })
    ).toBeNull();

    const [resolution] = await page.adapter.setAnnotations([
      storedAnnotation(documentId, rawQuote, 0, 2),
    ]);
    expect(resolution?.status).toBe('anchored');
    const repaired = resolution?.anchor;
    if (repaired?.format !== 'pdf') throw new Error('expected a repaired pdf anchor');
    // Repaired into the rendered space: the first line's four expanded
    // characters, not the second line and not a truncated prefix of both.
    expect({ start: repaired.textStart, end: repaired.textEnd }).toEqual({ start: 0, end: 4 });
    expect(page.renderedText.slice(repaired.textStart, repaired.textEnd)).toBe('ffff');
    // The persisted quote is untouched; only its resolution was normalized.
    expect(repaired.quote.exact).toBe(rawQuote.exact);

    // Fail-closed is intact: normalizing a quote that describes no text on the
    // page still yields the unanchored answer rather than an arbitrary range.
    const [absent] = await page.adapter.setAnnotations([
      storedAnnotation(documentId, { exact: 'ﬀxyz', prefix: '', suffix: '' }, 0, 4),
    ]);
    expect(absent?.status).toBe('unanchored');

    // The search path over the same page is unaffected and still paints the
    // exact visible glyph range for the normalized query text. The query has to
    // be the whole expanded token: `ff` is only a prefix of it and matches
    // nothing, which is the same exactness the repair above must not weaken.
    expect(() => anchorForChunk(documentId, page.indexedText, 'ff')).toThrow(/no anchor derived/);
    const anchor = anchorForChunk(documentId, page.indexedText, 'ffff');
    const result = await paint(page.adapter, 'ffff', anchor);
    expect(result.status).toBe('applied');
    expect(paintedTexts()).toEqual(['ffff', 'ffff']);
    const [firstPainted, secondPainted] = searchHighlightRanges(document);
    if (!firstPainted || !secondPainted) throw new Error('expected two painted ranges');
    const liveLayer = firstPainted.startContainer.parentElement?.closest('.textLayer');
    if (!liveLayer) throw new Error('painted range is not inside a text layer');
    expect(rangeOffsetsWithin(liveLayer, firstPainted)).toEqual({ start: 0, end: 4 });
    expect(rangeOffsetsWithin(liveLayer, secondPainted)).toEqual({ start: 4, end: 8 });
  });

  it('traverses marked-content structure', async () => {
    const page = await openPageOne(
      makePdfFixture({
        pageLines: [[
          'Tagged filler line one.',
          'Tagged filler line two.',
          'Tagged formats live here.',
        ]],
        markedContentPages: [1],
        outline: [],
      }),
      'doc-pdf-highlight-marked-content'
    );

    // The fixture really produced `BDC`/`EMC` pairs, so PDF.js nested every
    // glyph span inside a `.markedContent` container.
    expect(page.layer.querySelectorAll('.markedContent').length).toBeGreaterThan(0);

    const anchor = anchorForChunk('doc-pdf-highlight-marked-content', page.indexedText, 'formats');
    expect(anchor.ranges[0]?.text).toBe('formats');
    expect(naivePaintText(page.layer, anchor)).not.toBe('formats');

    const result = await paint(page.adapter, 'formats', anchor);
    expect(result.status).toBe('applied');
    expect(paintedTexts()).toEqual(['formats']);
    expect(glyphSpanText(searchHighlightRanges(document)[0]!)).toBe(
      'Tagged formats live here.'
    );
  });

  it('fails closed instead of painting an unrelated word', async () => {
    const documentId = 'doc-pdf-highlight-fail-closed';
    const page = await openPageOne(
      makePdfFixture({
        pageLines: [[
          'Alpha filler line one.',
          'Beta formats line two.',
        ]],
        outline: [],
      }),
      documentId
    );

    const valid = anchorForChunk(documentId, page.indexedText, 'formats');
    const term = valid.ranges[0];
    if (!term) throw new Error('expected a derived term range');

    // Offsets that no longer describe the recorded token — a stale index
    // against re-extracted text. The reconstructed slice differs, so nothing
    // is painted rather than something two characters to the right.
    const shifted: SearchMatchAnchor = {
      ...valid,
      ranges: [{ ...term, start: term.start + 2, end: term.end + 2 }],
    };
    const shiftedResult = await paint(page.adapter, 'formats', shifted);
    expect(shiftedResult.status).toBe('not-found');
    expect(shiftedResult.rangeCount).toBe(0);
    expect(paintedTexts()).toEqual([]);

    // A range that spans a synthetic separator: its text exists in the indexed
    // space but has no rendered counterpart, so it must not collapse onto the
    // neighbouring characters. Under the exact whole-token relation no derived
    // anchor can look like this — a token never contains the separator — so the
    // separator guard is exercised directly rather than through
    // `applySearchHighlight`, which would already have rejected it.
    const boundaryStart = page.indexedText.indexOf('one. Beta');
    expect(boundaryStart).toBeGreaterThan(0);
    const straddling: SearchMatchAnchor = {
      ...valid,
      queryTerms: ['one. Beta'],
      ranges: [{
        start: boundaryStart,
        end: boundaryStart + 'one. Beta'.length,
        text: 'one. Beta',
        queryTermIndex: 0,
        queryTermIndices: [0],
      }],
    };
    const spaceMap = buildPdfTextSpaceMap(['Alpha filler line one.', 'Beta formats line two.']);
    expect(resolvePdfSearchAnchorRanges(page.layer, spaceMap, straddling)).toEqual([]);
    // The same call resolves the well-formed anchor, so the empty result above
    // is the separator guard rather than a broken fixture.
    expect(resolvePdfSearchAnchorRanges(page.layer, spaceMap, valid).map((range) => range.toString()))
      .toEqual(['formats']);

    // Bounds outside the reconstructed page text.
    const outOfBounds: SearchMatchAnchor = {
      ...valid,
      location: {
        format: 'pdf',
        pageIndex: 0,
        textStart: 0,
        textEnd: page.indexedText.length + 50,
      },
    };
    const outOfBoundsResult = await paint(page.adapter, 'formats', outOfBounds);
    expect(outOfBoundsResult.status).toBe('not-found');
    expect(paintedTexts()).toEqual([]);

    // A revision bound that no longer matches is stale, not a miss.
    const staleResult = await paint(page.adapter, 'formats', {
      ...valid,
      documentHash: 'hash-from-a-previous-revision',
    });
    expect(staleResult.status).toBe('stale');
    expect(paintedTexts()).toEqual([]);

    // An aborted request never paints either.
    const controller = new AbortController();
    controller.abort();
    const abortedResult = await paint(page.adapter, 'formats', valid, controller.signal);
    expect(abortedResult.status).toBe('stale');
    expect(paintedTexts()).toEqual([]);

    // The same adapter still paints correctly afterwards.
    const goodResult = await paint(page.adapter, 'formats', valid);
    expect(goodResult.status).toBe('applied');
    expect(paintedTexts()).toEqual(['formats']);
  });
});
