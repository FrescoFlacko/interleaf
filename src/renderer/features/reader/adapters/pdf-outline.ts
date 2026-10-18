import type { TableOfContentsItem } from '@shared/types/document';
import { resolvePdfDestination, type PdfDestination, type PdfDestinationResolver } from './pdf-link-service';
import {
  createOutlinePageTextCache,
  recoverOutlinePageIndex,
  type PdfOutlineTextSource,
} from './pdf-outline-recovery';

/** One raw outline node as `PDFDocumentProxy.getOutline()` reports it. The
 * destination is untrusted document data: it may be a named string, an explicit
 * array, a malformed value, or absent entirely. */
export type PdfOutlineNode = {
  readonly title?: string;
  readonly dest?: PdfDestination | null;
  readonly items?: readonly PdfOutlineNode[];
};

/** The part of the document proxy outline mapping needs: destination lookup,
 * and page text for the bounded recovery pass. Declared structurally so the
 * mapping can be exercised against a recorded destination shape without loading
 * a PDF. */
export type PdfOutlineDocument = PdfDestinationResolver & PdfOutlineTextSource;

/** An entry mid-build, before its recovered page is known and its id formed. */
type OutlineEntry = {
  readonly title: string;
  readonly level: number;
  readonly index: number;
  /** True when a destination was present but did not resolve. */
  readonly unresolvedDest: boolean;
  pageIndex: number | null;
  readonly children: OutlineEntry[];
};

/**
 * Map a PDF outline into table-of-contents items.
 *
 * Destination resolution goes through the same validated path the link service
 * uses, so a named destination, an explicit reference destination and an
 * integer page-index destination all resolve identically in both places.
 *
 * An entry whose destination is present but unresolvable — a named destination
 * missing from the document's name tree — gets one bounded, document-derived
 * second chance, described in `pdf-outline-recovery.ts`. Anything that chance
 * does not settle keeps a `null` location. Page 1 is never used as a fallback:
 * a real destination on the first page and an unresolvable one are different
 * facts, and presenting the second as the first sends the reader to the wrong
 * place.
 */
export async function mapPdfOutline(
  pdfDoc: PdfOutlineDocument,
  nodes: readonly PdfOutlineNode[],
  pageCount: number,
): Promise<TableOfContentsItem[]> {
  const documentOrder: OutlineEntry[] = [];
  const roots = await buildOutlineEntries(pdfDoc, nodes, pageCount, 0, documentOrder);
  await recoverUnresolvedEntries(pdfDoc, documentOrder, pageCount);
  return roots.map(toTableOfContentsItem);
}

async function buildOutlineEntries(
  pdfDoc: PdfOutlineDocument,
  nodes: readonly PdfOutlineNode[],
  pageCount: number,
  level: number,
  documentOrder: OutlineEntry[],
): Promise<OutlineEntry[]> {
  const entries: OutlineEntry[] = [];

  for (const [index, node] of nodes.entries()) {
    const pageIndex = await resolveOutlinePageIndex(pdfDoc, node.dest, pageCount);
    const entry: OutlineEntry = {
      title: node.title ?? 'Untitled',
      level,
      index,
      unresolvedDest: pageIndex === null && node.dest !== undefined && node.dest !== null,
      pageIndex,
      children: [],
    };
    entries.push(entry);
    // Pre-order is reading order, which is the order the neighbouring pages
    // that bound a recovery run in.
    documentOrder.push(entry);
    if (node.items && node.items.length > 0) {
      entry.children.push(
        ...await buildOutlineEntries(pdfDoc, node.items, pageCount, level + 1, documentOrder)
      );
    }
  }

  return entries;
}

/** The bounded second chance, for entries that had a destination and lost it. */
async function recoverUnresolvedEntries(
  pdfDoc: PdfOutlineDocument,
  documentOrder: readonly OutlineEntry[],
  pageCount: number,
): Promise<void> {
  const candidates = documentOrder.filter((entry) => entry.unresolvedDest && entry.pageIndex === null);
  if (candidates.length === 0) return;

  const readPage = createOutlinePageTextCache(pdfDoc);
  for (const entry of candidates) {
    const position = documentOrder.indexOf(entry);
    entry.pageIndex = await recoverOutlinePageIndex(readPage, {
      title: entry.title,
      previousPageIndex: nearestResolvedPage(documentOrder, position, -1),
      nextPageIndex: nearestResolvedPage(documentOrder, position, 1),
    }, pageCount);
  }
}

/**
 * The page of the nearest entry in `step`'s direction that resolved from its
 * own destination. Recovered pages are not used as bounds: a bound has to be
 * evidence the document stated, not something this pass concluded.
 */
function nearestResolvedPage(
  documentOrder: readonly OutlineEntry[],
  from: number,
  step: -1 | 1,
): number | null {
  for (let at = from + step; at >= 0 && at < documentOrder.length; at += step) {
    const entry = documentOrder[at];
    if (entry === undefined) return null;
    if (!entry.unresolvedDest && entry.pageIndex !== null) return entry.pageIndex;
  }
  return null;
}

function toTableOfContentsItem(entry: OutlineEntry): TableOfContentsItem {
  const children = entry.children.map(toTableOfContentsItem);
  return {
    id: `toc-${String(entry.level)}-${String(entry.index)}-${entry.pageIndex === null ? 'unresolved' : String(entry.pageIndex)}`,
    title: entry.title,
    location: entry.pageIndex === null ? null : { format: 'pdf', pageIndex: entry.pageIndex },
    level: entry.level,
    children,
  };
}

async function resolveOutlinePageIndex(
  pdfDoc: PdfOutlineDocument,
  dest: PdfDestination | null | undefined,
  pageCount: number,
): Promise<number | null> {
  if (dest === undefined || dest === null) return null;
  try {
    const resolved = await resolvePdfDestination(pdfDoc, dest, pageCount);
    return resolved?.pageIndex ?? null;
  } catch {
    return null;
  }
}
