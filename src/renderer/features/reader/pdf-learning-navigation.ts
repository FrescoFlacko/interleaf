import type { PdfAnnotationAnchor } from '@shared/types/annotation';
import { resolvePdfAnnotationAnchor } from './adapters/pdf-annotation-anchor';
import { rangeFromOffsets } from './annotations/dom-anchors';
import { positionLearningRange } from './learning-range-position';
import { TEXT_ANCHOR_LIMITS } from './annotations/text-anchor-resolver';

// Slow devices may need several seconds to render a page; this is a limit, not a delay.
const RENDER_DEADLINE_MS = 10_000;

/** Wait for the adapter's committed text render and prove a live, visible range. */
export async function confirmPdfLearningRange(anchor: PdfAnnotationAnchor, isCurrent: () => boolean): Promise<boolean> {
  const deadline = performance.now() + RENDER_DEADLINE_MS;
  while (isCurrent() && performance.now() < deadline) {
    const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
    const layer = scroller?.querySelector<HTMLElement>(`[data-testid="pdf-textlayer-p${String(anchor.pageIndex + 1)}"][data-pdf-text-ready="true"]`);
    const overlay = document.querySelector('[data-testid="reader-error"]');
    if (scroller && layer && !overlay) {
      const text = layer.textContent;
      if (text.length > TEXT_ANCHOR_LIMITS.maxExactSearchChars) return false;
      const resolution = await resolvePdfAnnotationAnchor(text, anchor.quote, {
        ...(anchor.textStart !== undefined && anchor.textEnd !== undefined
          ? { nativeRange: { start: anchor.textStart, end: anchor.textEnd }, priorOffset: anchor.textStart }
          : {}),
      });
      if (!isCurrent()) return false;
      if (!layer.isConnected || !scroller.contains(layer) || layer.textContent !== text || document.querySelector('[data-testid="reader-error"]')) continue;
      if (!resolution || resolution.stage === 'fuzzy') return false;
      const range = rangeFromOffsets(layer, resolution);
      const matched = text.slice(resolution.start, resolution.end);
      if (!range || !matched || range.toString() !== matched) return false;
      if (positionLearningRange(range, scroller, isCurrent)) return isCurrent();
    }
    await nextFrame(deadline);
  }
  return false;
}

/** A deadline also completes when animation frames are suspended in a hidden window. */
function nextFrame(deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); resolve(); };
    const frame = window.requestAnimationFrame(finish);
    const timer = window.setTimeout(finish, Math.max(0, deadline - performance.now()));
  });
}
