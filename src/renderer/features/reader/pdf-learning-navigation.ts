import type { PdfAnnotationAnchor } from '@shared/types/annotation';
import { resolvePdfAnnotationAnchor } from './adapters/pdf-annotation-anchor';
import { rangeFromOffsets } from './annotations/dom-anchors';

/** Confirm and scroll the live PDF text range; a rectangle alone is not proof. */
export async function confirmPdfLearningRange(anchor: PdfAnnotationAnchor): Promise<boolean> {
  const layer = document.querySelector<HTMLElement>(`[data-testid="pdf-textlayer-p${String(anchor.pageIndex + 1)}"]`);
  if (!layer) return false;
  const resolution = await resolvePdfAnnotationAnchor(layer.textContent, anchor.quote, {
    ...(anchor.textStart !== undefined && anchor.textEnd !== undefined
      ? { nativeRange: { start: anchor.textStart, end: anchor.textEnd }, priorOffset: anchor.textStart }
      : {}),
  });
  if (!resolution || resolution.stage === 'fuzzy') return false;
  const range = rangeFromOffsets(layer, resolution);
  const target = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
  if (!target) return false;
  target.scrollIntoView({ behavior: 'auto', block: 'center' });
  return true;
}
