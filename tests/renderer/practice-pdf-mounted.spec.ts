// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { withLearningNavigation } from '../../src/renderer/features/reader/learning-mounted-navigation';
import type { PdfAnnotationAnchor } from '@shared/types/annotation';

function mountedPdf(text: string) {
  const scroll = document.createElement('div');
  scroll.dataset.testid = 'pdf-scroll-container';
  const page = document.createElement('div');
  page.dataset.testid = 'pdf-page-1';
  page.scrollIntoView = vi.fn();
  const layer = document.createElement('div');
  layer.dataset.testid = 'pdf-textlayer-p1';
  layer.textContent = text;
  if (text) layer.dataset.pdfTextReady = 'true';
  page.append(layer); scroll.append(page); document.body.append(scroll);
  const scrollTo = vi.fn();
  scroll.scrollTo = scrollTo;
  const pdf = new PdfAdapter();
  const goToLocation = vi.spyOn(pdf, 'goToLocation').mockResolvedValue();
  const legacy = vi.spyOn(pdf, 'goToAnnotation').mockResolvedValue();
  return { adapter: withLearningNavigation(pdf), scrollTo, goToLocation, legacy };
}

const source: PdfAnnotationAnchor = { format: 'pdf', pageIndex: 0,
  quote: { exact: 'source passage', prefix: '', suffix: '' },
  rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.1 }] };

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('actual mounted PDF adapter source boundary', () => {
  it('refuses an absent live quote instead of taking a rectangle fallback', async () => {
    const { adapter, scrollTo, legacy, goToLocation } = mountedPdf('Unrelated rendered text.');
    expect(await adapter.navigateLearningAnchor?.(source, () => true)).toBe(false);
    expect(goToLocation).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('refuses repeated live text even when an extracted-space offset appears to match', async () => {
    const { adapter, scrollTo, legacy } = mountedPdf('source passage and source passage');
    expect(await adapter.navigateLearningAnchor?.({ ...source, textStart: 0, textEnd: 14 }, () => true)).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('waits for an initially empty PDF text layer before checking it', async () => {
    const { adapter, scrollTo } = mountedPdf('');
    const pending = adapter.navigateLearningAnchor?.(source, () => true);
    window.setTimeout(() => {
      const layer = document.querySelector('[data-testid="pdf-textlayer-p1"]');
      if (layer instanceof HTMLElement) { layer.textContent = 'source passage and source passage'; layer.dataset.pdfTextReady = 'true'; }
    }, 20);
    expect(await pending).toBe(false);
    expect(document.querySelector('[data-testid="pdf-textlayer-p1"]')?.textContent).toBe('source passage and source passage');
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('refuses a fuzzy-only live match', async () => {
    const { adapter, scrollTo } = mountedPdf('source passagf');
    expect(await adapter.navigateLearningAnchor?.({ ...source, textStart: 0, textEnd: 14 }, () => true)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
