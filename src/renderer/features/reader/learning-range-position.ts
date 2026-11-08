/** Place the first real text fragment in the reader's own scroll viewport. */
export function positionLearningRange(range: Range, scroller: HTMLElement, isCurrent: () => boolean): boolean {
  if (!isCurrent() || !range.startContainer.isConnected || !scroller.contains(range.startContainer)) return false;
  const rect = range.getClientRects()[0];
  if (!rect || rect.height <= 0) return false;
  const viewport = scroller.getBoundingClientRect();
  scroller.scrollTo({ top: scroller.scrollTop + rect.top - viewport.top - 24, behavior: 'instant' });
  if (!isCurrent()) return false;
  const placed = range.getClientRects()[0];
  return !!placed && placed.bottom > viewport.top && placed.top < viewport.bottom && placed.right > viewport.left && placed.left < viewport.right;
}

/** Ebook ranges live inside a sandboxed iframe with its own scroll root. */
export function positionEbookLearningRange(range: Range, frame: HTMLIFrameElement, isCurrent: () => boolean): boolean {
  const doc = frame.contentDocument;
  if (!doc || !frame.isConnected) return false;
  const view = doc.defaultView;
  const scroller = doc.scrollingElement;
  if (!isCurrent() || !view || !scroller || !doc.contains(range.startContainer)) return false;
  const rect = range.getClientRects()[0];
  if (!rect || rect.height <= 0) return false;
  view.scrollTo({ top: scroller.scrollTop + rect.top - 24, behavior: 'instant' });
  if (!isCurrent()) return false;
  const placed = range.getClientRects()[0];
  const frameRect = frame.getBoundingClientRect();
  const reader = document.querySelector<HTMLElement>('[data-testid="reader-document-region"]')?.getBoundingClientRect();
  return !!placed && !!reader && placed.bottom > 0 && placed.top < view.innerHeight && placed.right > 0 && placed.left < view.innerWidth
    && frameRect.top + placed.bottom > reader.top && frameRect.top + placed.top < reader.bottom
    && frameRect.left + placed.right > reader.left && frameRect.left + placed.left < reader.right;
}
