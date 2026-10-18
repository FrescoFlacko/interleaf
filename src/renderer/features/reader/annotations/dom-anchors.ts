import { HIGHLIGHT_API_NAMES, HIGHLIGHT_COLOR_CONFIGS } from '@shared/constants/annotations';
import type { Annotation, DocumentAnchor, HighlightColor, QuoteContext } from '@shared/types/annotation';
import type { DocumentLocation } from '@shared/types/document';
import type { SearchMatchAnchor } from '@shared/types/search';
import { takeCodePointPrefix, takeCodePointSuffix } from '@shared/agent-context';
import { resolveTextAnchor, type TextAnchorResolution, type TextRangeOffsets } from './text-anchor-resolver';

const QUOTE_CONTEXT_LENGTH = 256;
const HIGHLIGHT_STYLE_ID = 'interleaf-annotation-highlight-styles';
export const MAX_NATIVE_SELECTION_TEXT_LENGTH = 256_000;

/** Keep transport descriptors schema-safe even when the native selection is
 * larger than the annotation limit. The full native length is carried by the
 * ReaderSelection metadata; endpoint quotes are only re-anchoring hints. */
export function boundedQuoteContext(quote: QuoteContext): QuoteContext {
  return {
    exact: takeCodePointPrefix(quote.exact, MAX_NATIVE_SELECTION_TEXT_LENGTH),
    prefix: takeCodePointSuffix(quote.prefix, 2_000),
    suffix: takeCodePointPrefix(quote.suffix, 2_000),
  };
}

/**
 * The CSS Custom Highlight API of the window a document belongs to.
 *
 * An ebook section paints in its own iframe, so the registry and constructor
 * come from that document's window rather than the reader's.
 */
type HighlightApi = {
  readonly registry: HighlightRegistry;
  readonly Highlight: typeof Highlight;
};

const HIGHLIGHT_NAMES = HIGHLIGHT_API_NAMES;

export type ResolvedDomAnchor = {
  readonly range: Range;
  readonly resolution: TextAnchorResolution;
};

function characterOffsetOfPoint(root: Node, container: Node, offset: number): number | null {
  const doc = root.ownerDocument;
  if (!doc || !root.contains(container)) return null;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  if (container.nodeType === Node.TEXT_NODE) {
    let cursor = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textLen = node.textContent?.length ?? 0;
      if (container === node) {
        return cursor + Math.max(0, Math.min(offset, textLen));
      }
      cursor += textLen;
    }
    return cursor;
  }
  const pointRange = doc.createRange();
  try {
    pointRange.setStart(container, offset);
    pointRange.collapse(true);
  } catch {
    return null;
  }
  let cursor = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textLen = node.textContent?.length ?? 0;
    if (pointRange.comparePoint(node, 0) >= 0) {
      return cursor;
    }
    if (pointRange.comparePoint(node, textLen) > 0) {
      return cursor + textLen;
    }
    cursor += textLen;
  }
  return cursor;
}

export function rangeOffsetsWithin(root: Node, range: Range): TextRangeOffsets | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed) {
    return null;
  }
  const start = characterOffsetOfPoint(root, range.startContainer, range.startOffset);
  const end = characterOffsetOfPoint(root, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) {
    return null;
  }
  return { start, end };
}

export function rangeFromOffsets(root: Node, offsets: TextRangeOffsets): Range | null {
  const doc = root.ownerDocument;
  if (!doc || offsets.start < 0 || offsets.end <= offsets.start) return null;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let startBoundary: { node: Node; offset: number } | null = null;
  let endBoundary: { node: Node; offset: number } | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (startBoundary === null && offsets.start <= cursor + length) {
      startBoundary = { node, offset: offsets.start - cursor };
    }
    if (offsets.end <= cursor + length) {
      endBoundary = { node, offset: offsets.end - cursor };
      break;
    }
    cursor += length;
  }
  if (!startBoundary || !endBoundary) return null;
  const range = doc.createRange();
  try {
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);
    return range;
  } catch {
    return null;
  }
}

function searchLocationBounds(location: DocumentLocation): { readonly start: number; readonly end: number } | null {
  if (location.format === 'docx' || location.format === 'pptx' || location.format === 'markdown') {
    return location.characterStart !== undefined && location.characterEnd !== undefined
      ? { start: location.characterStart, end: location.characterEnd }
      : null;
  }
  return location.textStart !== undefined && location.textEnd !== undefined
    ? { start: location.textStart, end: location.textEnd }
    : null;
}

/** Resolve only hash-bound chunk-relative offsets; no visible-text re-search fallback. */
export function rangesForSearchAnchor(root: Node, anchor: SearchMatchAnchor): readonly Range[] {
  const bounds = searchLocationBounds(anchor.location);
  if (!bounds || anchor.ranges.length === 0) return [];
  const ranges: Range[] = [];
  for (const match of anchor.ranges.slice(0, 32)) {
    const start = bounds.start + match.start;
    const end = bounds.start + match.end;
    if (start < bounds.start || end > bounds.end || end <= start) return [];
    const range = rangeFromOffsets(root, { start, end });
    if (!range) return [];
    ranges.push(range);
  }
  return ranges;
}

export function quoteContextForRange(root: Node, range: Range): QuoteContext | null {
  const offsets = rangeOffsetsWithin(root, range);
  if (!offsets) return null;
  const text = root.textContent ?? '';
  const exact = text.slice(offsets.start, offsets.end);
  if (!exact.trim()) return null;
  return {
    exact,
    prefix: text.slice(Math.max(0, offsets.start - QUOTE_CONTEXT_LENGTH), offsets.start),
    suffix: text.slice(offsets.end, offsets.end + QUOTE_CONTEXT_LENGTH),
  };
}

export function subRangeWithin(root: Node, range: Range): Range | null {
  const doc = root.ownerDocument;
  if (!doc) return null;
  try {
    if (typeof range.intersectsNode === 'function' && !range.intersectsNode(root)) {
      return null;
    }
  } catch {
    // Fallback if intersectsNode throws on cross-frame nodes
  }
  const containsStart = root.contains(range.startContainer);
  const containsEnd = root.contains(range.endContainer);
  const subRange = doc.createRange();
  try {
    if (containsStart && containsEnd) {
      subRange.setStart(range.startContainer, range.startOffset);
      subRange.setEnd(range.endContainer, range.endOffset);
    } else if (containsStart) {
      subRange.selectNodeContents(root);
      subRange.setStart(range.startContainer, range.startOffset);
    } else if (containsEnd) {
      subRange.selectNodeContents(root);
      subRange.setEnd(range.endContainer, range.endOffset);
    } else {
      subRange.selectNodeContents(root);
    }
    return !subRange.collapsed ? subRange : null;
  } catch {
    return null;
  }
}

export async function resolveDomAnchor(
  root: Node,
  quote: QuoteContext,
  options: {
    readonly nativeRange?: TextRangeOffsets;
    readonly priorOffset?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<ResolvedDomAnchor | null> {
  const resolution = await resolveTextAnchor(root.textContent ?? '', quote, options);
  if (!resolution) return null;
  const range = rangeFromOffsets(root, resolution);
  return range ? { range, resolution } : null;
}

/** A document detached from any window has nothing to paint into. */
function getHighlightApi(doc: Document): HighlightApi | null {
  const view = doc.defaultView;
  if (!view) return null;
  return { registry: view.CSS.highlights, Highlight: view.Highlight };
}

/**
 * Notes paint with `--note-translucent`: deliberately stronger than the plain
 * `--selection-translucent` used for transient selections, still translucent,
 * and with no `color` declaration so the noted text keeps its own contrast.
 * The token falls back through selection paint for any surface that has not
 * defined it (top documents inherit it from the palette; reader iframes
 * receive an injected copy because custom properties do not cross frames).
 */
function ensureHighlightStyles(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    ::highlight(interleaf-yellow) { background: ${HIGHLIGHT_COLOR_CONFIGS.yellow.cssRgba}; }
    ::highlight(interleaf-blue) { background: ${HIGHLIGHT_COLOR_CONFIGS.blue.cssRgba}; }
    ::highlight(interleaf-green) { background: ${HIGHLIGHT_COLOR_CONFIGS.green.cssRgba}; }
    ::highlight(interleaf-pink) { background: ${HIGHLIGHT_COLOR_CONFIGS.pink.cssRgba}; }
    ::highlight(interleaf-purple) { background: ${HIGHLIGHT_COLOR_CONFIGS.purple.cssRgba}; }
    ::highlight(interleaf-note) { text-decoration: underline 2px var(--accent, currentColor); background: var(--note-translucent, var(--selection-translucent, var(--selection, transparent))); }
  `;
  (doc.querySelector('head') ?? doc.documentElement).appendChild(style);
}

export function clearDomHighlights(doc: Document): void {
  const api = getHighlightApi(doc);
  if (!api) return;
  for (const name of HIGHLIGHT_NAMES) api.registry.delete(name);
}

export function applyDomHighlights(
  doc: Document,
  ranges: readonly { readonly annotation: Annotation; readonly range: Range }[]
): boolean {
  const api = getHighlightApi(doc);
  if (!api) return false;
  ensureHighlightStyles(doc);
  clearDomHighlights(doc);
  const grouped = new Map<HighlightColor | 'note', Range[]>();
  for (const item of ranges) {
    const key = item.annotation.type === 'highlight' && item.annotation.color
      ? item.annotation.color
      : item.annotation.type === 'note' && !item.annotation.isLocationNote
        ? 'note'
        : null;
    if (key) grouped.set(key, [...(grouped.get(key) ?? []), item.range]);
  }
  for (const [key, group] of grouped) {
    api.registry.set(`interleaf-${key}`, new api.Highlight(...group));
  }
  return true;
}

export function anchorToLocation(anchor: DocumentAnchor): import('@shared/types/document').DocumentLocation {
  if (anchor.format === 'pdf') {
    return { format: 'pdf', pageIndex: anchor.pageIndex, ...(anchor.pageLabel ? { pageLabel: anchor.pageLabel } : {}) };
  }
  if (anchor.format === 'epub') {
    return {
      format: 'epub',
      cfi: anchor.cfi,
      ...(anchor.spineHref ? { spineHref: anchor.spineHref } : {}),
      ...(anchor.progression !== undefined ? { progression: anchor.progression } : {}),
    };
  }
  if (anchor.format === 'mobi') {
    return {
      format: 'mobi',
      sectionIndex: anchor.sectionIndex,
      ...(anchor.byteOffset !== undefined ? { byteOffset: anchor.byteOffset } : {}),
      ...(anchor.progression !== undefined ? { progression: anchor.progression } : {}),
    };
  }
  if (anchor.format === 'markdown') {
    return {
      format: 'markdown',
      blockIndex: anchor.blockIndex,
      ...(anchor.characterStart !== undefined && anchor.characterEnd !== undefined
        ? { characterStart: anchor.characterStart, characterEnd: anchor.characterEnd }
        : {}),
      ...(anchor.lineIndex !== undefined ? { lineIndex: anchor.lineIndex } : {}),
      ...(anchor.headingId !== undefined ? { headingId: anchor.headingId } : {}),
    };
  }
  return {
    format: anchor.format,
    paragraphIndex: anchor.paragraphIndex,
    ...(anchor.characterStart !== undefined && anchor.characterEnd !== undefined
      ? { characterStart: anchor.characterStart, characterEnd: anchor.characterEnd }
      : {}),
    ...(anchor.renderedPageIndex !== undefined ? { renderedPageIndex: anchor.renderedPageIndex } : {}),
  };
}

export function locationToAnchor(location: DocumentLocation): DocumentAnchor {
  const quote = { exact: '', prefix: '', suffix: '' } as const;
  if (location.format === 'pdf') {
    return {
      format: 'pdf',
      quote,
      pageIndex: location.pageIndex,
      ...(location.pageLabel ? { pageLabel: location.pageLabel } : {}),
    };
  }
  if (location.format === 'epub') {
    return {
      format: 'epub',
      quote,
      cfi: location.cfi,
      ...(location.spineHref ? { spineHref: location.spineHref } : {}),
      ...(location.progression !== undefined ? { progression: location.progression } : {}),
    };
  }
  if (location.format === 'mobi') {
    return {
      format: 'mobi',
      quote,
      sectionIndex: location.sectionIndex,
      ...(location.byteOffset !== undefined ? { byteOffset: location.byteOffset } : {}),
      ...(location.progression !== undefined ? { progression: location.progression } : {}),
    };
  }
  if (location.format === 'markdown') {
    return {
      format: 'markdown',
      quote,
      blockIndex: location.blockIndex,
      ...(location.characterStart !== undefined && location.characterEnd !== undefined
        ? { characterStart: location.characterStart, characterEnd: location.characterEnd }
        : {}),
      ...(location.lineIndex !== undefined ? { lineIndex: location.lineIndex } : {}),
      ...(location.headingId !== undefined ? { headingId: location.headingId } : {}),
    };
  }
  return {
    format: location.format,
    quote,
    paragraphIndex: location.paragraphIndex,
    ...(location.renderedPageIndex !== undefined ? { renderedPageIndex: location.renderedPageIndex } : {}),
  };
}

export type PartitionResult<T> =
  | { readonly ok: true; readonly segments: readonly T[]; readonly reconstructedText: string }
  | { readonly ok: false; readonly error: string };

/**
 * Deterministically partitions a native multi-segment selection string across ordered sub-segments.
 *
 * Accepts ONLY if:
 * 1. The first segment exact text begins at cursor 0 (`nativeSelectedText.startsWith(segments[0].quote.exact)`);
 * 2. Every subsequent segment exact text is found at or after cursor (`matchIdx >= cursor`);
 * 3. `separatorBefore` is the exact native substring between cursor and that match (`nativeSelectedText.slice(cursor, matchIdx)`);
 * 4. The final cursor equals `nativeSelectedText.length` (zero trailing unmatched characters).
 *
 * If any condition fails, returns `ok: false` with an explicit error message. Never guesses fallbacks or partial selections.
 */
export function partitionMultiSegmentText<
  T extends { readonly quote: QuoteContext; readonly separatorBefore?: string }
>(
  rawSegments: readonly T[],
  nativeSelectedText: string
): PartitionResult<T> {
  if (rawSegments.length === 0) {
    return { ok: false, error: 'No segment content found in selection.' };
  }
  if (!nativeSelectedText) {
    return { ok: false, error: 'Native selection text is empty.' };
  }

  let cursor = 0;
  const segmentsWithSeparators: T[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (!seg || seg.quote.exact.length === 0) {
      return { ok: false, error: 'Segment quote exact text cannot be empty.' };
    }

    if (i === 0) {
      if (!nativeSelectedText.startsWith(seg.quote.exact)) {
        return {
          ok: false,
          error: 'Selection text could not be mapped to document segments deterministically.',
        };
      }
      cursor = seg.quote.exact.length;
      segmentsWithSeparators.push(seg);
    } else {
      const matchIdx = nativeSelectedText.indexOf(seg.quote.exact, cursor);
      if (matchIdx < 0) {
        return {
          ok: false,
          error: 'Selection text could not be mapped to document segments deterministically.',
        };
      }
      const separatorBefore = nativeSelectedText.slice(cursor, matchIdx);
      cursor = matchIdx + seg.quote.exact.length;
      segmentsWithSeparators.push({
        ...seg,
        separatorBefore,
      });
    }
  }

  if (cursor !== nativeSelectedText.length) {
    return {
      ok: false,
      error: 'Selection text could not be mapped to document segments deterministically.',
    };
  }

  const reconstructedText = segmentsWithSeparators
    .map((s, i) => (i > 0 ? (s.separatorBefore ?? '') : '') + s.quote.exact)
    .join('');

  if (reconstructedText !== nativeSelectedText) {
    return {
      ok: false,
      error: 'Selection text could not be mapped to document segments deterministically.',
    };
  }

  return {
    ok: true,
    segments: segmentsWithSeparators,
    reconstructedText,
  };
}
