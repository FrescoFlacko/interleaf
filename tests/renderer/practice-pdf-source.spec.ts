// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { navigateLearningSource } from '../../src/renderer/features/reader/learning-source';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { testDocumentAdapter } from '../helpers/document-adapter';

it('does not report PDF passage success from the legacy rectangle fallback', async () => {
  const quote = 'The exact saved source passage exists only in extraction.';
  const layer = document.createElement('div');
  layer.textContent = 'An unrelated rendered page with no matching evidence anywhere.';
  const scrollTo = vi.fn();
  const goToLocation = vi.fn(() => Promise.resolve());
  const actualAdapter = { pageCount: 1, goToLocation, renderPage: () => Promise.resolve(), waitForTextLayer: () => Promise.resolve(layer),
    pageWrappers: new Map([[1, { offsetTop: 0, offsetHeight: 1000 }]]), scrollContainer: { clientHeight: 300, scrollTo } };
  const adapter = testDocumentAdapter('pdf', {
    extractLocationText: () => Promise.resolve([{ id: 'c', documentId: 'doc', ordinal: 0, text: quote, tokenCount: 10,
      location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null }]),
    goToAnnotation: (annotation) => PdfAdapter.prototype.goToAnnotation.call(actualAdapter as never, annotation),
  });
  const result = await navigateLearningSource(adapter, { documentId: 'doc', documentHash: 'hash', anchor: {
    format: 'pdf', pageIndex: 0, quote: { exact: quote, prefix: '', suffix: '' }, rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.1 }],
  } }, () => true);
  expect(result).toBe(false);
  expect(scrollTo).not.toHaveBeenCalled();
});
