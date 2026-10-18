// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import type { DocumentMediaAsset } from '@shared/types/document';
import { testDocumentSource, testReflowOptions } from '../helpers/document-source';

/**
 * What the reader does with a captured article's tables and images.
 *
 * This is the consumer end of the snapshot format: the extractor's job is to
 * emit a pipe table and a durable `interleaf-asset:` reference, and the job
 * asserted here is that the reader turns those back into a real `<table>` and
 * into an image loaded through the capability main issued for this open. The
 * two halves are tested apart because the snapshot on disk is the contract
 * between them, and a change to either side that breaks it should fail here.
 */

const ASSET_ONE = 'interleaf-asset:1111111111111111111111111111111111111111111111111111111111111111.png';
const ASSET_TWO = 'interleaf-asset:2222222222222222222222222222222222222222222222222222222222222222.png';
const MISSING_ASSET =
  'interleaf-asset:3333333333333333333333333333333333333333333333333333333333333333.png';

const MEDIA: readonly DocumentMediaAsset[] = [
  { reference: ASSET_ONE, url: 'interleaf-media://11111111-1111-4111-8111-111111111111', width: 240, height: 140 },
  { reference: ASSET_TWO, url: 'interleaf-media://22222222-2222-4222-8222-222222222222', width: 192, height: 108 },
];

/** A snapshot shaped like the one the importer writes for a benchmark article. */
const ARTICLE = [
  '---',
  'title: "Astra: a new generation of assistants"',
  'source: "https://example.com/index/astra-model/"',
  '---',
  '',
  '# Astra: a new generation of assistants',
  '',
  'The tables below report the evaluations we run before every release.',
  '',
  '| Benchmark | Astra | Astra mini | Previous flagship | Open baseline | Expert panel | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| Graduate reasoning | 86.4% | 79.1% | 71.8% | 64.2% | 82.0% | Zero-shot |',
  '| Long-context recall | 94.2% | 88.7% | 80.3% | 69.9% | 96.1% | 128k tokens |',
  '| [Tool use](https://example.com/evals/tool-use) | 73.5% | 65.0% | 58.4% | 41.6% | 77.3% | Five runs, averaged |',
  '| Document extraction | 91.0% | 84.3% | 77.7% | 66.5% | 93.2% | Scanned pages \\| mixed scripts |',
  '',
  `![Side-by-side transcripts of two assistants](${ASSET_ONE})`,
  '',
  'Reviewers preferred the Astra transcript in most of the paired comparisons.',
  '',
  `![Accuracy plotted against training compute](${ASSET_TWO})`,
  '',
  `![An image whose file went missing](${MISSING_ASSET})`,
  '',
  '![A picture the capture never archived](https://cdn.example.com/astra/latency-profile.png)',
  '',
  '*Astra narrating a chart it produced a moment earlier.*',
  '',
].join('\n');

describe('reading a captured web article', () => {
  const originalFetch = globalThis.fetch;
  let adapter: MarkdownAdapter;
  let container: HTMLElement;

  async function open(
    markdown: string,
    mediaAssets: readonly DocumentMediaAsset[] = MEDIA
  ): Promise<void> {
    const bytes = new TextEncoder().encode(markdown);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bytes.buffer, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    );
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-astra',
      assetUrl: 'test://astra.md',
      mediaAssets,
    }));
  }

  function tableWrapper(): HTMLElement {
    const wrapper = container.querySelector<HTMLElement>('[data-testid^="markdown-table-"]');
    if (wrapper === null) throw new Error('the article rendered no table');
    return wrapper;
  }

  beforeEach(() => {
    adapter = new MarkdownAdapter();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await adapter.close();
    container.remove();
    globalThis.fetch = originalFetch;
  });

  describe('tables', () => {
    it('rebuilds a seven-column table with its header row', async () => {
      await open(ARTICLE);

      const table = tableWrapper().querySelector('table');
      expect(table).not.toBeNull();
      const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((th) =>
        th.textContent.trim()
      );
      expect(headers).toEqual([
        'Benchmark',
        'Astra',
        'Astra mini',
        'Previous flagship',
        'Open baseline',
        'Expert panel',
        'Notes',
      ]);

      const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.querySelectorAll('td')).toHaveLength(7);
      }
      expect(rows[0]?.querySelectorAll('td')[0]?.textContent.trim()).toBe('Graduate reasoning');
      expect(rows[1]?.querySelectorAll('td')[4]?.textContent.trim()).toBe('69.9%');
    });

    it('restores a cell that contained a literal pipe instead of splitting the row', async () => {
      await open(ARTICLE);

      const lastRow = [...container.querySelectorAll('tbody tr')].at(-1);
      const cells = [...(lastRow?.querySelectorAll('td') ?? [])].map((td) => td.textContent.trim());
      expect(cells).toHaveLength(7);
      expect(cells.at(-1)).toBe('Scanned pages | mixed scripts');
    });

    it('keeps a link inside a cell, marked external and announced actionable', async () => {
      await open(ARTICLE);

      const link = container.querySelector<HTMLAnchorElement>('td a[data-external-link="true"]');
      expect(link).not.toBeNull();
      expect(link?.textContent.trim()).toBe('Tool use');
      expect(link?.getAttribute('href')).toBe('https://example.com/evals/tool-use');
      expect(link?.rel).toBe('noopener noreferrer');
      expect(link?.getAttribute('aria-disabled')).toBeNull();
    });

    it('wraps the table in its own horizontal scroller', async () => {
      await open(ARTICLE);

      const wrapper = tableWrapper();
      expect(wrapper.className).toContain('overflow-x-auto');
      expect(wrapper.className).toContain('w-full');
      // The scroller owns the overflow, so the table itself is never clipped by
      // the reading column and the surrounding prose does not scroll sideways.
      expect(wrapper.querySelector('table')?.parentElement).toBe(wrapper);
      expect(wrapper.closest('.markdown-viewer-scroll-container')).not.toBeNull();
    });

    it('keeps the scroller through a narrow column at 200% zoom', async () => {
      await open(ARTICLE);

      await adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.6, contentWidth: 40, horizontalMarginRem: 1 }));
      await adapter.setZoom(2);
      expect(adapter.getZoom()).toBe(2);

      const wrapper = tableWrapper();
      expect(wrapper.className).toContain('overflow-x-auto');
      expect(wrapper.querySelectorAll('td')).toHaveLength(28);
      // Layout changes re-style the reading column; they must not turn the
      // table back into text a reader would have to scroll the page to reach.
      const column = container.querySelector<HTMLElement>('.markdown-content-wrapper');
      expect(column?.style.maxWidth).toBe('40ch');
    });

    it('makes an overflowing table focusable and named, and only while it overflows', async () => {
      await open(ARTICLE);
      const wrapper = tableWrapper();
      expect(wrapper.getAttribute('tabindex')).toBeNull();

      // jsdom lays nothing out, so the overflow the reader reacts to is stated
      // here; real geometry is exercised in the Electron end-to-end test.
      const measure = (scrollWidth: number, clientWidth: number): void => {
        Object.defineProperty(wrapper, 'scrollWidth', { value: scrollWidth, configurable: true });
        Object.defineProperty(wrapper, 'clientWidth', { value: clientWidth, configurable: true });
      };

      measure(900, 400);
      await adapter.setZoom(1.5);
      expect(wrapper.getAttribute('tabindex')).toBe('0');
      expect(wrapper.getAttribute('role')).toBe('region');
      expect(wrapper.getAttribute('aria-label')).toBe('Table 1, scrollable horizontally');
      wrapper.focus();
      expect(document.activeElement).toBe(wrapper);

      // A table that fits is not a tab stop: nothing is gained by stopping on
      // it, and a landmark would announce scrolling that cannot happen.
      measure(400, 400);
      await adapter.setZoom(1);
      expect(wrapper.getAttribute('tabindex')).toBeNull();
      expect(wrapper.getAttribute('role')).toBeNull();
      expect(wrapper.getAttribute('aria-label')).toBeNull();
    });

    it('exposes the table to assistive technology as a table', async () => {
      await open(ARTICLE);

      const table = tableWrapper().querySelector('table');
      expect(table?.tagName).toBe('TABLE');
      expect(table?.querySelector('thead tr')?.children).toHaveLength(7);
      // Header cells are th elements, which is what gives a screen reader the
      // column names while it reads a data cell.
      expect(table?.querySelectorAll('thead td')).toHaveLength(0);
    });
  });

  describe('images', () => {
    it('loads an archived image through the capability issued for this open', async () => {
      await open(ARTICLE);

      const first = container.querySelector<HTMLImageElement>(
        `img[src="${MEDIA[0]?.url ?? ''}"]`
      );
      expect(first).not.toBeNull();
      expect(first?.getAttribute('alt')).toBe('Side-by-side transcripts of two assistants');
      expect(first?.width).toBe(240);
      expect(first?.height).toBe(140);
      expect(first?.decoding).toBe('async');

      const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
      expect(sources).toEqual([MEDIA[0]?.url, MEDIA[1]?.url]);
    });

    it('never resolves a durable reference itself or loads anything remote', async () => {
      await open(ARTICLE);

      for (const img of container.querySelectorAll('img')) {
        expect(img.getAttribute('src')).toMatch(/^interleaf-media:\/\//);
      }
      expect(container.querySelector('img[src^="http"]')).toBeNull();
      expect(container.querySelector('img[src^="interleaf-asset:"]')).toBeNull();
      expect(container.innerHTML).not.toContain('cdn.example.com');
    });

    it('leaves a reference with no capability as its description', async () => {
      await open(ARTICLE);

      const fallbacks = [...container.querySelectorAll('.markdown-image-alt')].map((node) =>
        node.textContent
      );
      expect(fallbacks).toContain('[Image: An image whose file went missing]');
      expect(fallbacks).toContain('[Image: A picture the capture never archived]');
    });

    it('shows descriptions only, with no images, when the document is opened with no media', async () => {
      await open(ARTICLE, []);

      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(container.querySelectorAll('.markdown-image-alt')).toHaveLength(4);
      // The article still reads: tables and prose are unaffected.
      expect(container.querySelector('table')).not.toBeNull();
      expect(container.textContent).toContain('Reviewers preferred the Astra transcript');
    });

    it('drops the previous document capabilities when another document is opened', async () => {
      await open(ARTICLE);
      expect(container.querySelectorAll('img')).toHaveLength(2);

      await open(`![Only picture](${ASSET_ONE})\n\nA short second article body.`, [
        { reference: ASSET_ONE, url: 'interleaf-media://33333333-3333-4333-8333-333333333333', width: 10, height: 10 },
      ]);

      const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
      expect(sources).toEqual(['interleaf-media://33333333-3333-4333-8333-333333333333']);
      expect(container.innerHTML).not.toContain(MEDIA[0]?.url ?? '');
    });
  });

  describe('the rest of the reader is unchanged', () => {
    it('anchors annotations by block across a document containing tables', async () => {
      await open(ARTICLE);

      const scope = adapter.getAnnotationScope();
      expect(scope?.format).toBe('markdown');
      const results = await adapter.search('Reviewers preferred');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.text).toContain('Reviewers preferred');

      // A table cell is searchable text like any other block.
      const inTable = await adapter.search('128k tokens');
      expect(inTable.length).toBeGreaterThan(0);
    });

    it('offers table text to the indexing and AI-context stream', async () => {
      await open(ARTICLE);

      const chunks: string[] = [];
      for await (const chunk of adapter.extractText()) chunks.push(chunk.text);
      const joined = chunks.join('\n');

      expect(joined).toContain('Long-context recall');
      expect(joined).toContain('Scanned pages | mixed scripts');
      expect(joined).toContain('Reviewers preferred the Astra transcript');
      // A per-open capability is meaningless to an index and to a model, and it
      // would be stale by the time anything read it back.
      expect(joined).not.toContain('interleaf-media:');
    });

    it('indexes the description of an archived image, not its storage reference', async () => {
      await open(ARTICLE);

      const chunks: string[] = [];
      for await (const chunk of adapter.extractText()) chunks.push(chunk.text);
      const joined = chunks.join('\n');

      // A content hash is not prose. It is a false hit for anyone searching, a
      // block of tokens spent on nothing in a model's context, and it names a
      // file no consumer of this text may open.
      expect(joined).not.toContain('interleaf-asset:');
      expect(joined).not.toContain('1111111111111111');
      // The words a reader wrote about the picture survive in its place.
      expect(joined).toContain('Side-by-side transcripts of two assistants');
      expect(joined).toContain('An image whose file went missing');
      expect(joined).toContain('Astra narrating a chart it produced a moment earlier');

      expect(await adapter.search('1111111111111111')).toHaveLength(0);
      const described = await adapter.search('Side-by-side transcripts');
      expect(described.length).toBeGreaterThan(0);
      expect(described[0]?.text).toContain('Side-by-side transcripts');
    });

    it('strips durable asset references with escaped brackets in alt text from search and AI text', async () => {
      const docWithEscapedAlt = [
        '# Escaped Alt Test',
        '',
        'Before ![Chart \\[v2\\]](' + ASSET_ONE + ') After',
      ].join('\n');
      await open(docWithEscapedAlt);

      const chunks: string[] = [];
      for await (const chunk of adapter.extractText()) chunks.push(chunk.text);
      const joined = chunks.join('\n');

      expect(joined).not.toContain('interleaf-asset:');
      expect(joined).toContain('Before Chart [v2] After');

      const matches = await adapter.search('Chart [v2]');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('lists the article heading in the table of contents', async () => {
      await open(ARTICLE);

      const toc = await adapter.getTableOfContents();
      expect(toc[0]?.title).toBe('Astra: a new generation of assistants');
    });
  });
});
