import type { PdfAnnotationAnchor } from '@shared/types/annotation';
import { resolvePdfAnnotationAnchor } from './adapters/pdf-annotation-anchor';
import { rangeFromOffsets } from './annotations/dom-anchors';
import { positionLearningRange } from './learning-range-position';
import { TEXT_ANCHOR_LIMITS } from './annotations/text-anchor-resolver';

/** Confirm and position the live PDF text range; a rectangle alone is not proof. */
export async function confirmPdfLearningRange(anchor: PdfAnnotationAnchor, isCurrent: () => boolean): Promise<boolean> {
  const layer = await waitForPdfTextLayer(anchor.pageIndex, isCurrent);
  const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
  if (!isCurrent() || !layer || !scroller) return false;
  const text = layer.textContent;
  if (text.length > TEXT_ANCHOR_LIMITS.maxExactSearchChars) return false;
  const resolution = await resolvePdfAnnotationAnchor(text, anchor.quote, {
    ...(anchor.textStart !== undefined && anchor.textEnd !== undefined
      ? { nativeRange: { start: anchor.textStart, end: anchor.textEnd }, priorOffset: anchor.textStart }
      : {}),
  });
  if (!isCurrent() || !resolution || resolution.stage === 'fuzzy') return false;
  const matched = text.slice(resolution.start, resolution.end);
  if (!matched || text.indexOf(matched) !== text.lastIndexOf(matched)) return false;
  const range = rangeFromOffsets(layer, resolution);
  return !!range && range.toString() === matched && positionLearningRange(range, scroller, isCurrent);
}

/** Virtualized PDF pages can mount their text layer after the page transition. */
async function waitForPdfTextLayer(pageIndex: number, isCurrent: () => boolean): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 200 && isCurrent(); attempt++) {
    const layer = document.querySelector<HTMLElement>(`[data-testid="pdf-textlayer-p${String(pageIndex + 1)}"]`);
    if (layer?.textContent) return layer;
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 10); });
  }
  return null;
}
