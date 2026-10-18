/**
 * Keeping a reflowable reader on the same words when its viewport changes width.
 *
 * A PDF page can be rescaled: the same page-relative point stays under the same
 * pixel because nothing about the page changed but its size. Reflowable formats
 * have no such luxury — narrowing the reader re-wraps every line, so the
 * document's total height changes and a preserved `scrollTop` lands the reader
 * somewhere else entirely, usually further back than where they were reading.
 *
 * What can be preserved is the semantic anchor: the block the reader's eye was
 * on, and how far into that block the top of the viewport sat. That block is
 * still the same block after reflow; only its height and position moved. These
 * two functions capture that anchor before a reflow and put the reader back on
 * it afterwards.
 *
 * `restoreReflowAnchor` reads the anchor element's geometry, which forces the
 * pending layout, so callers may call it immediately after the mutation that
 * causes the reflow.
 */

export type ReflowAnchor = {
  /** The block the viewport's top edge was inside, or the first one below it. */
  readonly element: HTMLElement;
  /**
   * Where the viewport's top edge sat within that block, as a fraction of the
   * block's height. A fraction rather than a pixel offset: a re-wrapped
   * paragraph is a different height, and a pixel offset into the old height
   * would point at the wrong line of the new one.
   */
  readonly progressWithinElement: number;
};

/**
 * The block under the top of `scroller`'s viewport, and how far into it the
 * viewport's top edge sits. Returns `null` when nothing is measurable, in which
 * case the caller should leave the scroll position alone rather than guess.
 */
export function captureReflowAnchor(
  scroller: HTMLElement,
  elements: Iterable<HTMLElement>
): ReflowAnchor | null {
  const viewportTop = scroller.getBoundingClientRect().top;
  let firstBelow: { element: HTMLElement; distance: number } | null = null;

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top <= viewportTop && rect.bottom > viewportTop) {
      return {
        element,
        progressWithinElement: Math.max(0, Math.min(1, (viewportTop - rect.top) / rect.height)),
      };
    }
    // The viewport top can fall in the gap between two blocks; the block just
    // below it is what the reader is about to read.
    const distance = rect.top - viewportTop;
    if (distance >= 0 && (firstBelow === null || distance < firstBelow.distance)) {
      firstBelow = { element, distance };
    }
  }

  if (firstBelow === null) return null;
  return { element: firstBelow.element, progressWithinElement: 0 };
}

/**
 * Scrolls `scroller` so the captured anchor sits back under the viewport's top
 * edge. A `null` anchor is a no-op: nothing was measurable, so nothing is moved.
 */
export function restoreReflowAnchor(scroller: HTMLElement, anchor: ReflowAnchor | null): void {
  if (!anchor || !scroller.contains(anchor.element)) return;
  const rect = anchor.element.getBoundingClientRect();
  if (rect.height <= 0) return;
  const viewportTop = scroller.getBoundingClientRect().top;
  const delta = rect.top + anchor.progressWithinElement * rect.height - viewportTop;
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, scroller.scrollTop + delta));
}
