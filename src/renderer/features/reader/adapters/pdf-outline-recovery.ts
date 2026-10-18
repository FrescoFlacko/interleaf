import { pdfTextItemStrings, type PdfTextContentEntry } from './pdf-text-space';

/**
 * Recovering the page of an outline entry whose destination does not resolve.
 *
 * Some PDFs ship an outline that points at named destinations the document's
 * own name tree never defines. `gebbdoom.pdf` is one: `Hidden improvements`
 * and `Sound System` both name a `section.N.M` destination that is simply not
 * there, so honest resolution yields nothing and the reader loses two working
 * outline entries.
 *
 * The entry is still recoverable from the document itself, because an
 * unresolved entry is surrounded by entries that did resolve. Those neighbours
 * bound a short interval of pages, and the section's own heading text appears
 * on the page the entry should have pointed at. Reading that text back is
 * evidence from the document rather than a guess.
 *
 * The rules below are deliberately strict, because a wrong page is worse than
 * no page:
 *
 *   * Both neighbours must have resolved. A one-sided bound is not a bound.
 *   * The interval must be short. A long gap means the outline structure does
 *     not tell us where to look, so we do not look.
 *   * The title must be substantial enough to identify a section.
 *   * The page *before* the interval must not already contain the title. If it
 *     does, the phrase is not introduced here — a running header carried in
 *     from an earlier section, or a phrase common enough to match anything —
 *     and the first hit inside the interval would not mean what it appears to.
 *
 * When any rule fails the entry keeps its unresolved `null` location. Nothing
 * here scans the whole document, offsets a neighbour by a page, or invents a
 * location.
 */

/** The longest run of pages a pair of resolved neighbours may bound. */
const MAX_RECOVERY_PAGES = 8;

/** The shortest normalized title that can identify a section on its own. */
const MIN_TITLE_LENGTH = 6;

/** The part of the document proxy recovery reads page text through. */
export type PdfOutlineTextSource = {
  readonly getPage: (pageNumber: number) => Promise<{
    readonly getTextContent: () => Promise<{ readonly items: readonly PdfTextContentEntry[] }>;
  }>;
};

/**
 * Case, punctuation and run-length folded away, so an outline title matches the
 * heading as the page's text items happen to be split. PDF text arrives in
 * fragments with arbitrary spacing, and section numbering ("2.3") reaches the
 * page as separate pieces, so comparing anything finer than words would miss.
 */
function normalizeOutlineText(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

/** One unresolved entry and the pages its resolved neighbours bound. */
export type OutlineRecoveryRequest = {
  readonly title: string;
  /** Page index of the nearest preceding resolved entry, or `null`. */
  readonly previousPageIndex: number | null;
  /** Page index of the nearest following resolved entry, or `null`. */
  readonly nextPageIndex: number | null;
};

/**
 * Page text, read once per page for the life of one recovery pass.
 *
 * An outline with several unresolved entries tends to bound overlapping
 * intervals, and the guard page of one entry is often inside the interval of
 * the next. The cache is local to the pass and released with it, so it never
 * becomes a second copy of the document held alongside PDF.js's own.
 */
export function createOutlinePageTextCache(source: PdfOutlineTextSource): (pageIndex: number) => Promise<string> {
  const pages = new Map<number, Promise<string>>();
  return (pageIndex: number): Promise<string> => {
    const cached = pages.get(pageIndex);
    if (cached !== undefined) return cached;
    const pending = readPageText(source, pageIndex);
    pages.set(pageIndex, pending);
    return pending;
  };
}

async function readPageText(source: PdfOutlineTextSource, pageIndex: number): Promise<string> {
  try {
    const page = await source.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    return normalizeOutlineText(pdfTextItemStrings(content.items).join(' '));
  } catch {
    // A page that will not yield text is simply not evidence for anything.
    return '';
  }
}

/**
 * The page an unresolved outline entry belongs on, or `null` when the document
 * does not say so plainly enough to be worth showing.
 */
export async function recoverOutlinePageIndex(
  readPage: (pageIndex: number) => Promise<string>,
  request: OutlineRecoveryRequest,
  pageCount: number,
): Promise<number | null> {
  const title = normalizeOutlineText(request.title);
  if (title.length < MIN_TITLE_LENGTH) return null;

  const { previousPageIndex, nextPageIndex } = request;
  if (previousPageIndex === null || nextPageIndex === null) return null;

  const first = previousPageIndex + 1;
  const last = Math.min(nextPageIndex, pageCount - 1);
  if (last < first) return null;
  if (last - first + 1 > MAX_RECOVERY_PAGES) return null;

  // The page before the interval settles whether a hit inside it means the
  // section starts there.
  if ((await readPage(previousPageIndex)).includes(title)) return null;

  for (let pageIndex = first; pageIndex <= last; pageIndex++) {
    if ((await readPage(pageIndex)).includes(title)) return pageIndex;
  }
  return null;
}
