import { useEffect, useRef, type RefObject } from 'react';
import type { Annotation, AnnotationSort, AnnotationType } from '@shared/types/annotation';
import { useAnnotationStore } from '../../stores/use-annotation-store';

/**
 * Bringing a just-created annotation into view, and refusing to do anything at
 * all until the row it names is actually on screen.
 *
 * The reveal is a promise about one specific row in one specific document, so
 * "the request came back and the row was not in it" is never an answer: the
 * panel may be filtered to Notes, searched down to nothing, sorted oldest
 * first, or paged past the row, and a request may have been superseded or have
 * failed outright. Consuming the reveal in any of those cases would scroll the
 * reader somewhere they did not ask to go and then throw the request away.
 *
 * So the reveal does two things in order. First, once per request, it puts the
 * panel into the one view that is guaranteed to admit a new annotation on its
 * first page. Then it waits — indefinitely, if need be — for a settled page
 * fetched for exactly that view and document to render exactly that row, and
 * only then scrolls and clears. Anything else leaves the request pending.
 */

export type AnnotationPageView = {
  readonly query: string;
  readonly type: AnnotationType | 'all';
  readonly sort: AnnotationSort;
  readonly pageIndex: number;
};

/**
 * Newest-first, unfiltered, unsearched, first page: the only view in which a
 * just-created annotation is certain to be present and reachable.
 */
export const REVEAL_VIEW: AnnotationPageView = {
  query: '',
  type: 'all',
  sort: 'updated_desc',
  pageIndex: 0,
};

/**
 * Identifies the exact request a rendered page came from.
 *
 * The panel records this key when a page settles, so a reveal can require the
 * rows on screen to be the ones it is waiting for rather than leftovers from a
 * superseded request, another document, or a different filter. JSON encoding
 * keeps the parts apart, so no two distinct views can spell the same key.
 */
export function annotationPageKey(documentId: string, view: AnnotationPageView): string {
  return JSON.stringify([documentId, view.type, view.sort, view.pageIndex, view.query.trim()]);
}

export function useAnnotationReveal({
  items,
  listRef,
  pageKey,
  documentId,
  normalizeView,
}: {
  readonly items: readonly Annotation[];
  readonly listRef: RefObject<HTMLOListElement | null>;
  /** Key of the page currently rendered, or null before one has settled. */
  readonly pageKey: string | null;
  /** The document the panel is showing, or null when there is none. */
  readonly documentId: string | null;
  /** Puts the panel into `REVEAL_VIEW`; called at most once per request. */
  readonly normalizeView: () => void;
}): void {
  const revealRequest = useAnnotationStore((state) => state.revealRequest);
  const clearReveal = useAnnotationStore((state) => state.clearReveal);
  const normalizedNonce = useRef<number | null>(null);
  const normalizeRef = useRef(normalizeView);

  // The panel hands over a fresh closure every render; the reveal must not
  // re-run for that reason alone, so the current one is read from a ref.
  useEffect(() => {
    normalizeRef.current = normalizeView;
  });

  useEffect(() => {
    if (revealRequest === null) return;

    // A reveal names a row in one book. Raised against another one it is not
    // this panel's business at all: it stays pending for whichever panel is
    // showing that book, and nothing here — filters, page, scroll, focus —
    // moves on its account.
    if (documentId === null || documentId !== revealRequest.documentId) return;

    // One normalization per request. After that the reader owns the filters
    // again, even while the request is still waiting for its row.
    if (normalizedNonce.current !== revealRequest.nonce) {
      normalizedNonce.current = revealRequest.nonce;
      normalizeRef.current();
    }

    // The rows on screen must come from a settled request for this document
    // and the reveal view. A stale or superseded page and a failed page both
    // fail this test and leave the request pending rather than consuming it.
    if (pageKey !== annotationPageKey(revealRequest.documentId, REVEAL_VIEW)) return;

    const index = items.findIndex((item) => item.id === revealRequest.annotationId);
    const list = listRef.current;
    const row = index < 0 || list === null ? null : list.children.item(index);
    if (list === null || row === null) return;

    // Measured offset rather than `scrollIntoView`: the latter also scrolls
    // every scrollable ancestor, which would move the reader's page. Focus is
    // never touched, so the reader's keyboard position is left alone.
    const target = list.scrollTop + (row.getBoundingClientRect().top - list.getBoundingClientRect().top);
    list.scrollTop = Math.max(0, target);
    clearReveal(revealRequest.nonce);
  }, [clearReveal, documentId, items, listRef, pageKey, revealRequest]);
}
