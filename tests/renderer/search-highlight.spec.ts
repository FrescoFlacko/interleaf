// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applySearchHighlight, clearSearchHighlight, MAX_SEARCH_HIGHLIGHT_RANGES, SEARCH_HIGHLIGHT_NAME, searchHighlightRanges } from '../../src/renderer/features/reader/annotations/search-highlight';
import { rangeFromOffsets } from '../../src/renderer/features/reader/annotations/dom-anchors';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import { testDocumentSource } from '../helpers/document-source';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

afterEach(() => {
  document.getElementById('interleaf-search-highlight-styles')?.remove();
  document.body.replaceChildren();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe('transient search highlight', () => {
  it('paints a bounded dedicated range and preserves annotation registry entries', () => {
    const registry = window.CSS.highlights;
    const root = document.createElement('p');
    root.textContent = 'alpha selected text omega';
    document.body.append(root);
    const range = rangeFromOffsets(root, { start: 6, end: 19 });
    expect(range?.toString()).toBe('selected text');
    registry.set('interleaf-yellow', new Highlight());

    expect(applySearchHighlight(document, range ? [range] : [])).toBe(1);
    expect(searchHighlightRanges(document)).toHaveLength(1);
    expect(registry.has('interleaf-yellow')).toBe(true);
    clearSearchHighlight(document);
    expect(registry.has(SEARCH_HIGHLIGHT_NAME)).toBe(false);
    expect(registry.has('interleaf-yellow')).toBe(true);
  });

  it('bounds range count and drops collapsed or foreign ranges', () => {
    const root = document.createElement('p');
    root.textContent = 'needle '.repeat(MAX_SEARCH_HIGHLIGHT_RANGES + 4);
    document.body.append(root);
    const ranges = Array.from({ length: MAX_SEARCH_HIGHLIGHT_RANGES + 4 }, (_, index) =>
      rangeFromOffsets(root, { start: index * 7, end: index * 7 + 6 })
    ).filter((range): range is Range => range !== null);
    expect(applySearchHighlight(document, ranges)).toBe(MAX_SEARCH_HIGHLIGHT_RANGES);
    expect(searchHighlightRanges(document)).toHaveLength(MAX_SEARCH_HIGHLIGHT_RANGES);
  });

  it('uses the persisted character location for a repeated Markdown term', async () => {
    HTMLElement.prototype.scrollIntoView = () => undefined;
    const adapter = new MarkdownAdapter();
    const payload = new TextEncoder().encode('# Heading\n\nfirst needle then needle and done.');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(payload, { status: 200 }));
    try {
      await adapter.open(document.createElement('div'), testDocumentSource({
        documentId: 'doc-search', documentHash: 'hash-search', assetUrl: 'interleaf-media://asset',
      }));
      const matches = await adapter.search('needle');
      expect(matches).toHaveLength(2);
      const second = matches[1];
      if (!second) return;
      expect(second.location.format).toBe('markdown');
      const secondLocation = second.location;
      if (secondLocation.format !== 'markdown') return;
      const secondStart = second.textStart;
      const secondEnd = second.textEnd;
      if (secondStart === undefined || secondEnd === undefined) return;
      const result = await adapter.applySearchHighlight({
        requestId: 1,
        documentId: 'doc-search', documentHash: 'hash-search', query: 'needle', location: secondLocation,
        anchor: {
          version: 1,
          chunkId: 'chunk-1',
          documentId: 'doc-search',
          documentHash: 'hash-search',
          location: secondLocation,
          queryTerms: ['needle'],
          ranges: [{ start: 0, end: secondEnd - secondStart, text: 'needle', queryTermIndex: 0, queryTermIndices: [0] }],
        },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe('applied');
      expect(searchHighlightRanges(document)).toHaveLength(1);
      expect(searchHighlightRanges(document)[0]?.toString()).toBe('needle');
      await adapter.close();
      expect(searchHighlightRanges(document)).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
