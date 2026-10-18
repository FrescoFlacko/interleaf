import type { ChatContextDisclosure, ChatSourceEnvelopeItem } from '@shared/types/ai';

/**
 * Naming the part of a document a nearby-context band actually covered.
 *
 * A reader told only that “context near your current position” was sent cannot
 * check the answer against the document. What this produces is read back off
 * the sources the turn is sending, never predicted from the anchor, so the
 * disclosure cannot claim pages the model did not receive.
 *
 * It is derived from the canonical `location`, never from `pageLabel`. A
 * source's page label is display text an adapter chose — `Page 148` for a PDF,
 * but `Block 12`, `Section 3` or `Rendered page 4` for the reflowable formats —
 * so reading numbers out of it would turn a heading or a spine section into a
 * page this document does not have. Only a PDF has pages, and only a PDF is
 * described here.
 */

/** Beyond this many separate pages the list is truncated rather than grown. */
const MAX_LISTED_PAGES = 12;

/**
 * Where a packed band came from, as pages, or `null`.
 *
 * `null` is the truthful answer for every reflowable format: EPUB and MOBI have
 * spine sections, Markdown has blocks, and a DOCX paragraph's rendered page is
 * an artifact of a layout the reader may never see. Saying nothing is better
 * than naming a unit the document does not have. A band that skips pages is
 * listed page by page rather than smoothed into a range it does not cover.
 */
export function nearbyBandLabel(sources: readonly ChatSourceEnvelopeItem[]): string | null {
  const pages = distinctPdfPages(sources);
  if (pages === null) return null;
  const first = pages[0];
  const last = pages[pages.length - 1];
  if (first === undefined || last === undefined) return null;
  if (pages.length === 1) return `Page ${String(first)}`;
  if (isContiguous(pages)) return `Pages ${String(first)}–${String(last)}`;

  const listed = pages.slice(0, MAX_LISTED_PAGES).map(String).join(', ');
  return pages.length > MAX_LISTED_PAGES ? `Pages ${listed}, …` : `Pages ${listed}`;
}

/**
 * The label to disclose for a pinned whole document the packer has just sized.
 *
 * Nothing is claimed unless the packed envelope was actually adopted — an
 * envelope the builder discarded is not what the turn sends — and unless the
 * document was in fact reduced to a band: a whole document that fitted is not
 * "context near your position" and needs no such note. Only the sources beyond
 * the explicit selections are the band; the selections in front of them were
 * the reader's own choices and are disclosed on their own terms.
 */
export function adoptedBandLabel(input: {
  readonly adopted: boolean;
  readonly fullDocIncluded: boolean;
  readonly sources: readonly ChatSourceEnvelopeItem[];
  readonly explicitCount: number;
}): string | null {
  if (!input.adopted || input.fullDocIncluded) return null;
  return nearbyBandLabel(input.sources.slice(input.explicitCount));
}

/**
 * The label as a disclosure member, which is no member at all when there is
 * nothing truthful to put in it. An absent member says "this format cannot
 * name where the context came from"; a present empty one would say nothing
 * while looking like an answer.
 */
export function bandLabelMember(
  label: string | null
): Pick<ChatContextDisclosure, 'includedLabel'> {
  return label === null ? {} : { includedLabel: label };
}

/**
 * The one-based page numbers a band covered, in the order it covered them, or
 * `null` if any source in it is not a canonical PDF location.
 *
 * One non-PDF source is enough to withhold the whole label: a range built from
 * the rest would describe part of what was sent as if it were all of it.
 */
function distinctPdfPages(sources: readonly ChatSourceEnvelopeItem[]): readonly number[] | null {
  const pages: number[] = [];
  for (const source of sources) {
    const location = source.location;
    if (location.format !== 'pdf') return null;
    if (!Number.isInteger(location.pageIndex) || location.pageIndex < 0) return null;
    const page = location.pageIndex + 1;
    if (!pages.includes(page)) pages.push(page);
  }
  return pages;
}

/** True only for whole numbers that run one after another with no gap. */
function isContiguous(pages: readonly number[]): boolean {
  return pages.every((value, index) => index === 0 || value === (pages[index - 1] ?? 0) + 1);
}
