import type {
  ChatSelectionDescriptor,
  DocumentLocation,
  PdfLocation,
  TableOfContentsItem,
} from '@shared/types/document';
import { parseEpubCfiSpineIndex } from '@shared/schemas/document';
import { hasParagraphFormat } from '@shared/document-format-family';

/** A flattened outline item retains the item's depth-first order.  The order
 * is the document's logical section order, including nested headings. */
export type FlattenedTocItem = {
  readonly item: TableOfContentsItem;
  readonly order: number;
  /** Effective depth from the tree and adapter hierarchy metadata. */
  readonly depth: number;
};

type TocPageRange = {
  readonly start: number;
  readonly end: number;
};

export type TocContextRange = {
  readonly item: TableOfContentsItem;
  readonly nextItem: TableOfContentsItem | null;
  readonly startLocation: DocumentLocation;
  /** The first location after the selected section, when one exists. */
  readonly nextBoundaryLocation: DocumentLocation | null;
  /** Inclusive PDF page numbers, when the adapter has meaningful pages. */
  readonly pageRange: TocPageRange | null;
};

const DEFAULT_TOC_CONTEXT_ERROR = 'The selected outline section is no longer available.';
/** Stated rather than guessed: the document itself carries no destination for
 * this entry, so there is no section to attach. */
export const UNRESOLVED_TOC_DESTINATION_ERROR =
  'This outline entry has no usable destination in the document, so its section cannot be attached.';
const UNRESOLVED_TOC_BOUNDARY_ERROR =
  'The next outline entry has no usable destination in the document, so where this section ends is unknown.';

export function flattenTableOfContents(items: readonly TableOfContentsItem[]): readonly FlattenedTocItem[] {
  const flattened: FlattenedTocItem[] = [];
  const hasNestedStructure = items.some((item) => item.children.length > 0);
  const visit = (nodes: readonly TableOfContentsItem[], depth: number): void => {
    for (const item of nodes) {
      // DOCX's real adapter output is a flat array: hierarchy is represented
      // by the zero-based `level` field rather than `children`. Nested EPUB
      // and PDF outlines use children. Once a tree is present, structural
      // depth is authoritative so a malformed declared level cannot make a
      // child appear shallower than its parent; flat adapter output uses its
      // validated level metadata.
      const declaredDepth = Number.isSafeInteger(item.level) && item.level >= 0 ? item.level : depth;
      flattened.push({ item, order: flattened.length, depth: hasNestedStructure ? depth : declaredDepth });
      if (item.children.length > 0) visit(item.children, depth + 1);
    }
  };
  visit(items, 0);
  return flattened;
}

function validUnit(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function locationUnit(location: DocumentLocation): number | null {
  if (hasParagraphFormat(location)) return validUnit(location.paragraphIndex);
  switch (location.format) {
    case 'pdf': return validUnit(location.pageIndex);
    case 'mobi': return validUnit(location.sectionIndex);
    case 'markdown': return validUnit(location.blockIndex);
    case 'epub': return parseEpubCfiSpineIndex(location.cfi);
  }
}

function clampPdfPage(pageIndex: number, pageCount: number | null): number | null {
  const valid = validUnit(pageIndex);
  if (valid === null) return null;
  if (pageCount === null) return valid;
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return null;
  return Math.min(valid, pageCount - 1);
}

/**
 * Derive the inclusive section boundary from a depth-first outline. A heading
 * always starts on its own destination unit. Descendant headings belong to
 * their parent section, so the exclusive boundary is the first flattened
 * heading at the selected heading's depth or an ancestor's depth. Invalid or
 * descending native destinations fail closed instead of becoming an
 * overlapping one-unit range.
 */
export function deriveTocContextRange(
  items: readonly TableOfContentsItem[],
  selectedId: string,
  pageCount: number | null = null,
): TocContextRange | null {
  const flattened = flattenTableOfContents(items);
  const selectedIndex = flattened.findIndex(({ item }) => item.id === selectedId);
  const selected = flattened[selectedIndex];
  if (!selected) return null;

  const location = selected.item.location;
  // An entry whose destination the document does not resolve has no start and
  // cannot bound the entry before it either, so it is neither selectable nor a
  // boundary candidate. Substituting a neighbouring location would attach text
  // the reader did not choose.
  if (location === null) return null;
  const next = flattened
    .slice(selectedIndex + 1)
    .find((candidate) => candidate.depth <= selected.depth)?.item ?? null;
  const nextLocation = next?.location ?? null;
  // The section that follows is what ends this one. When the document does not
  // resolve its destination, the end of this section is unknown, so the range
  // fails closed rather than running on to a later heading.
  if (next !== null && nextLocation === null) return null;

  // A boundary is an adapter-owned location. Never silently coerce it to the
  // selected adapter's format, including when the selected location is PDF.
  if (nextLocation !== null && nextLocation.format !== location.format) return null;

  // The EPUB adapter currently stores a spine-root CFI for fragment TOC
  // destinations. Attaching that location would silently include the whole
  // spine (and cannot distinguish multiple headings in one spine), so fail
  // closed until a truthful fragment CFI is available.
  if (location.format === 'epub' && location.spineHref?.includes('#')) return null;

  if (location.format === 'pdf') {
    const startIndex = clampPdfPage(location.pageIndex, pageCount);
    if (startIndex === null) return null;

    const nextIndex = nextLocation?.format === 'pdf'
      ? clampPdfPage(nextLocation.pageIndex, pageCount)
      : null;
    if (nextLocation !== null && nextIndex === null) return null;
    if (nextIndex !== null && nextIndex < startIndex) return null;
    const lastIndex = pageCount !== null && Number.isSafeInteger(pageCount) && pageCount > 0
      ? pageCount - 1
      : startIndex;
    const endIndex = Math.max(startIndex, Math.min(lastIndex, nextIndex === null ? lastIndex : nextIndex - 1));
    const startLocation: PdfLocation = {
      ...location,
      pageIndex: startIndex,
    };
    return {
      item: selected.item,
      nextItem: next,
      startLocation,
      nextBoundaryLocation: nextLocation,
      pageRange: { start: startIndex + 1, end: endIndex + 1 },
    };
  }

  // A location's format is adapter-owned. Do not invent a page number for a
  // reflowable document. Numeric units below are only used to make the
  // context descriptor's end unit exclusive-by-one where the format supports
  // that unit natively.
  const startUnit = locationUnit(location);
  if (startUnit === null) return null;
  const nextUnit = nextLocation === null ? null : locationUnit(nextLocation);
  if (nextLocation !== null && nextUnit === null) return null;
  if (nextUnit !== null && nextUnit < startUnit) return null;
  if (location.format === 'epub' && nextLocation?.format === 'epub' && nextUnit === startUnit) return null;
  return {
    item: selected.item,
    nextItem: next,
    startLocation: location,
    nextBoundaryLocation: nextLocation,
    pageRange: null,
  };
}

/** Return a safe, user-facing explanation when a TOC range cannot be derived. */
export function tocContextUnavailableMessage(
  items: readonly TableOfContentsItem[],
  selectedId: string,
): string {
  const flattened = flattenTableOfContents(items);
  const selectedIndex = flattened.findIndex(({ item }) => item.id === selectedId);
  const selected = flattened[selectedIndex];
  if (!selected) return DEFAULT_TOC_CONTEXT_ERROR;
  const next = flattened
    .slice(selectedIndex + 1)
    .find((candidate) => candidate.depth <= selected.depth)?.item ?? null;
  const location = selected.item.location;
  const nextLocation = next?.location ?? null;
  if (location === null) return UNRESOLVED_TOC_DESTINATION_ERROR;
  if (next !== null && nextLocation === null) return UNRESOLVED_TOC_BOUNDARY_ERROR;
  if (location.format === 'epub') {
    const selectedUnit = locationUnit(location);
    const nextUnit = nextLocation?.format === 'epub' ? locationUnit(nextLocation) : null;
    if (location.spineHref?.includes('#') || (nextUnit !== null && selectedUnit !== null && nextUnit === selectedUnit)) {
      return 'This EPUB outline entry does not expose a safe subsection boundary.';
    }
  }
  return DEFAULT_TOC_CONTEXT_ERROR;
}

function sameFormat<T extends DocumentLocation['format']>(location: DocumentLocation, format: T): location is Extract<DocumentLocation, { format: T }> {
  return location.format === format;
}

function fallbackEpubCfi(index: number): string {
  return `epubcfi(/6/${String((index + 1) * 2)})`;
}

export type TocRangeUnitReferences = ReadonlyMap<number, string>;

/**
 * Convert a non-PDF TOC range into the already-supported selection descriptor
 * used by Chat.  `unitCount` is optional because Markdown/DOCX do not expose
 * a page count for their logical units; when omitted, the last section is
 * bounded to its heading unit, which is the only safe location known to the
 * adapter.  Callers may provide a count obtained from adapter extraction.
 */
export function tocRangeToChatDescriptor(
  range: TocContextRange,
  unitCount?: number,
  unitReferences?: TocRangeUnitReferences,
): ChatSelectionDescriptor | null {
  if (range.pageRange !== null) return null;
  const start = range.startLocation;
  const boundary = range.nextBoundaryLocation;
  const startUnit = locationUnit(start);
  if (startUnit === null) return null;
  const boundaryUnit = boundary !== null ? locationUnit(boundary) : null;
  if (boundary !== null && boundaryUnit === null) return null;
  if (boundaryUnit !== null && boundaryUnit < startUnit) return null;
  if (unitCount !== undefined) {
    if (!Number.isSafeInteger(unitCount) || unitCount <= startUnit) return null;
    if (boundaryUnit !== null && boundaryUnit > unitCount) return null;
  }
  const maxUnit = unitCount === undefined ? startUnit : unitCount - 1;
  const endUnit = boundaryUnit === null || boundaryUnit === startUnit
    ? (boundaryUnit === startUnit ? startUnit : maxUnit)
    : boundaryUnit - 1;

  if (sameFormat(start, 'epub')) {
    const startCfi = start.cfi;
    // Use hrefs emitted by adapter extraction. TOC hrefs may contain a
    // fragment and cannot safely identify persisted chunk rows; synthetic
    // section-N values would be misleading source references.
    const startHref = unitReferences?.get(startUnit) ?? start.spineHref;
    if (!startHref || startHref.includes('#')) return null;
    const endpointUnit = endUnit;
    const hasKnownFinalEndpoint = boundary === null && unitCount !== undefined && Number.isSafeInteger(unitCount) && unitCount > 0;
    const endCfi = boundary !== null && boundaryUnit !== null
      ? fallbackEpubCfi(endpointUnit)
      : hasKnownFinalEndpoint
        ? fallbackEpubCfi(endpointUnit)
        : startCfi;
    const endHref = endpointUnit === startUnit ? startHref : unitReferences?.get(endpointUnit);
    if (!endHref || endHref.includes('#')) return null;
    return {
      format: 'epub',
      startSpineHref: startHref,
      endSpineHref: endHref,
      startCfi,
      endCfi,
      ...(start.progression !== undefined ? { startProgression: start.progression } : {}),
    };
  }

  if (sameFormat(start, 'mobi')) {
    return {
      format: 'mobi',
      startSectionIndex: start.sectionIndex,
      endSectionIndex: endUnit,
    };
  }
  if (hasParagraphFormat(start)) {
    return {
      format: start.format,
      startParagraphIndex: start.paragraphIndex,
      endParagraphIndex: endUnit,
      ...(start.renderedPageIndex !== undefined ? { startRenderedPageIndex: start.renderedPageIndex } : {}),
    };
  }
  if (sameFormat(start, 'markdown')) {
    return {
      format: 'markdown',
      startBlockIndex: start.blockIndex,
      endBlockIndex: endUnit,
      ...(start.lineIndex !== undefined ? { startLineIndex: start.lineIndex } : {}),
      ...(start.headingId !== undefined ? { startHeadingId: start.headingId } : {}),
    };
  }
  return null;
}

export function tocRangeUnit(location: DocumentLocation): number | null {
  return locationUnit(location);
}
