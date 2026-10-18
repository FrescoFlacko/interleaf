/**
 * The two PDF page-text character spaces, and the mapping between them.
 *
 * A PDF page's text reaches the app twice, through two different
 * concatenations of the *same* `getTextContent()` item sequence:
 *
 * **Index space** — `items.map((item) => item.str).join(' ').trim()`. This is
 * what {@link pdfIndexedPageText} builds, what `PdfAdapter.extractText()`
 * yields, and therefore what the FTS index stores. Every persisted chunk
 * `textStart` and every `SearchTermRange` offset lives here. One synthetic
 * space separates *every* pair of consecutive items — including empty ones,
 * which contribute a separator and no characters — and leading/trailing
 * whitespace is then trimmed off the joined result.
 *
 * **Render space** — `items.map((item) => item.str).join('')`. PDF.js's
 * `TextLayer` gives each item its own `<span>` whose `textContent` is exactly
 * `item.str` and inserts no separator between them. The `<br>` it appends for
 * `hasEOL`, the `<span class="markedContent">` wrappers it opens for
 * `includeMarkedContent`, and `TextLayerBuilder`'s `.endOfContent` sentinel all
 * contribute zero characters, and an empty item produces no span at all
 * (`hasText === false`). So the text layer's `textContent` is the bare
 * concatenation, in item order.
 *
 * On a page whose text is a single item the two spaces are identical — which is
 * exactly why single-item fixtures never caught the divergence. On a real page
 * they drift apart by one character per item boundary that precedes the offset,
 * plus the leading trim, so applying an indexed offset straight to the DOM
 * paints a word that is progressively further left than the causative match.
 *
 * Everything here is pure and DOM-free: it takes the item strings and returns
 * offsets. Callers own fetching the item sequence and building the `Range`.
 */

import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';

/** One entry of a `getTextContent()` item sequence, as pdfjs types it. */
export type PdfTextContentEntry = TextItem | TextMarkedContent;

/** The separator `join(' ')` inserts between consecutive PDF text items. */
const PDF_TEXT_ITEM_SEPARATOR = ' ';

/**
 * Text-content parameters shared by the rendered text layer and by any mapping
 * derived from it. `disableNormalization: false` keeps the DOM in the same
 * normalized (ligature-expanded) space as `getTextContent()`; restating
 * `includeMarkedContent: true` preserves upstream's marked-content DOM, which
 * `TextLayerBuilder` would otherwise supply itself.
 *
 * Marked-content entries carry no `str` and are dropped by
 * {@link pdfTextItemStrings}, and the worker flushes the pending text item at
 * every marked-content boundary regardless of the flag, so the `str` sequence
 * is identical with and without it.
 *
 * The normalized rendered layer is a load-bearing contract, not an
 * implementation detail: PDF annotation anchors store offsets into, and quotes
 * taken from, this layer's `textContent`. Turning normalization off would move
 * every one of them by one character per preceding ligature. A quote recorded
 * in the raw glyph space is recovered by normalizing the *quote*
 * (`resolvePdfAnnotationAnchor`), never by denormalizing the layer.
 */
export const PDF_TEXT_CONTENT_PARAMS = Object.freeze({
  includeMarkedContent: true,
  disableNormalization: false,
});

/**
 * Narrows a `getTextContent()` entry to one that actually carries text.
 *
 * `items` is `(TextItem | TextMarkedContent)[]`: `TextItem` has `str: string`,
 * while `TextMarkedContent` has no `str` property whatsoever, so the presence
 * of the property is the discriminant pdfjs gives this union.
 */
function hasTextString(item: PdfTextContentEntry): item is TextItem {
  return 'str' in item;
}

/** The ordered item strings both spaces are built from. */
export function pdfTextItemStrings(items: readonly PdfTextContentEntry[]): readonly string[] {
  const strings: string[] = [];
  for (const item of items) {
    if (hasTextString(item)) strings.push(item.str);
  }
  return strings;
}

/** The joined, untrimmed page text. */
export function joinPdfTextItems(strings: readonly string[]): string {
  return strings.join(PDF_TEXT_ITEM_SEPARATOR);
}

/**
 * The exact page text the search index stores. `PdfAdapter.extractText()` and
 * `extractLocationText()` both go through here so the indexed contract has a
 * single definition.
 */
export function pdfIndexedPageText(strings: readonly string[]): string {
  return joinPdfTextItems(strings).trim();
}

/** The exact page text PDF.js's rendered text layer exposes as `textContent`. */
export function pdfRenderedPageText(strings: readonly string[]): string {
  return strings.join('');
}

type PdfTextSpaceItem = {
  readonly length: number;
  /** Offset of this item inside the untrimmed joined (index) text. */
  readonly joinedStart: number;
  /** Offset of this item inside the rendered text. */
  readonly renderedStart: number;
};

export type PdfTextSpaceMap = {
  readonly indexedText: string;
  readonly renderedText: string;
  /** Characters `trim()` removed from the front of the joined text. */
  readonly leadingTrimLength: number;
  readonly items: readonly PdfTextSpaceItem[];
};

export function buildPdfTextSpaceMap(strings: readonly string[]): PdfTextSpaceMap {
  const items: PdfTextSpaceItem[] = [];
  let joinedCursor = 0;
  let renderedCursor = 0;
  for (const [index, value] of strings.entries()) {
    if (index > 0) joinedCursor += PDF_TEXT_ITEM_SEPARATOR.length;
    items.push({ length: value.length, joinedStart: joinedCursor, renderedStart: renderedCursor });
    joinedCursor += value.length;
    renderedCursor += value.length;
  }
  const joined = joinPdfTextItems(strings);
  return {
    indexedText: joined.trim(),
    renderedText: pdfRenderedPageText(strings),
    leadingTrimLength: joined.length - joined.trimStart().length,
    items,
  };
}

/**
 * Maps one indexed character position onto its rendered position.
 *
 * Returns `null` when the position is out of bounds or lands on a synthetic
 * separator, because no rendered character corresponds to it.
 */
export function renderedOffsetForIndexedCharacter(
  map: PdfTextSpaceMap,
  indexedOffset: number
): number | null {
  if (!Number.isInteger(indexedOffset) || indexedOffset < 0 || indexedOffset >= map.indexedText.length) {
    return null;
  }
  const joinedOffset = indexedOffset + map.leadingTrimLength;
  let low = 0;
  let high = map.items.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const item = map.items[mid];
    if (!item) return null;
    if (joinedOffset < item.joinedStart) {
      high = mid - 1;
    } else if (joinedOffset >= item.joinedStart + item.length) {
      low = mid + 1;
    } else {
      return item.renderedStart + (joinedOffset - item.joinedStart);
    }
  }
  return null;
}

/**
 * Maps a half-open indexed range onto the equivalent half-open rendered range.
 *
 * The end bound is mapped through its last *included* character so an exclusive
 * end sitting on a separator stays unambiguous. The final slice comparison is
 * the fail-closed guard: a range that straddles a synthetic separator has a
 * separator in its indexed slice and none in its rendered slice, so it is
 * rejected rather than silently shortened.
 */
export function mapIndexedRangeToRendered(
  map: PdfTextSpaceMap,
  indexedStart: number,
  indexedEnd: number
): { readonly start: number; readonly end: number } | null {
  if (!Number.isInteger(indexedStart) || !Number.isInteger(indexedEnd) || indexedEnd <= indexedStart) {
    return null;
  }
  const start = renderedOffsetForIndexedCharacter(map, indexedStart);
  const lastIncluded = renderedOffsetForIndexedCharacter(map, indexedEnd - 1);
  if (start === null || lastIncluded === null) return null;
  const end = lastIncluded + 1;
  if (end <= start) return null;
  if (map.renderedText.slice(start, end) !== map.indexedText.slice(indexedStart, indexedEnd)) {
    return null;
  }
  return { start, end };
}
