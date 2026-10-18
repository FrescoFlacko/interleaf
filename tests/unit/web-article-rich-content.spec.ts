import { describe, expect, it } from 'vitest';
import { extractArticleInWorker } from '@main/workers/article-extract-worker';
import {
  articleImageSources,
  renderArticleMarkdown,
} from '@main/library/article-markdown';
import {
  extractedArticleSchema,
  MAX_ARTICLE_INLINES_PER_CELL,
  MAX_ARTICLE_TABLE_COLUMNS,
  type ExtractedArticle,
} from '@main/library/article-content';
import { assetReference } from '@main/library/article-media';
import {
  parseMarkdownDocument,
  type MarkdownInline,
} from '../../src/renderer/features/reader/adapters/markdown-parser';
import {
  ASTRA_ALT_TEXT,
  ASTRA_ARCHIVED_IMAGE_URLS,
  ASTRA_ARTICLE_URL,
  ASTRA_CAPTIONS,
  ASTRA_EXCLUDED_IMAGE_URLS,
  ASTRA_IMAGE_URLS,
  ASTRA_LINKED_CELL,
  ASTRA_TABLES,
  astraArticleHtml,
  type AstraFixtureOptions,
} from '../fixtures/astra-article-fixture';

/**
 * Table and image capture, run through the real extraction worker.
 *
 * The fixture is a minimal stand-in for a model-announcement page — invented
 * prose and numbers in the same shape as the real thing — so these tests never
 * touch a network or reproduce a copyrighted article. What they assert is the
 * part a reader can see: that a seven-column benchmark table survives as a
 * table, that the images worth keeping are exactly the ones offered to the
 * archive, and that everything else the page tried to embed is gone.
 */

const BASE_URL = 'https://example.com/posts/article';

const FILLER = [
  'The margin of a page is where a reader argues with the author, and this paragraph',
  'exists so the extraction heuristics have a genuine article body to score rather',
  'than a fragment. It is long enough to pass the readable-text threshold on its own,',
  'and it contains commas, which the scoring pass treats as evidence of prose.',
].join(' ');

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

function articleBody(inner: string): string {
  return `<article class="post-content"><p>${FILLER}</p>${inner}</article>`;
}

async function snapshot(
  html: string,
  images?: ReadonlyMap<string, string>,
  baseUrl = BASE_URL
): Promise<{ article: ExtractedArticle; markdown: string }> {
  const article = await extractArticleInWorker(html, baseUrl);
  const markdown = renderArticleMarkdown({
    article,
    sourceUrl: baseUrl,
    fallbackTitle: 'Untitled article',
    ...(images === undefined ? {} : { images }),
  });
  return { article, markdown };
}

async function astra(
  options: AstraFixtureOptions = {},
  images?: ReadonlyMap<string, string>
): Promise<{ article: ExtractedArticle; markdown: string }> {
  return snapshot(astraArticleHtml(options), images, ASTRA_ARTICLE_URL);
}

/** The visible text of a parsed cell, with escapes already resolved. */
function cellText(inlines: readonly MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      if (inline.type === 'text') return inline.text;
      if (inline.type === 'code') return inline.code;
      if (inline.type === 'link') return inline.text;
      if ('children' in inline) return cellText(inline.children);
      return '';
    })
    .join('');
}

/** Every pipe-table row in a snapshot, split into trimmed cells. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim())
    );
}

describe('rich web article capture', () => {
  describe('semantic tables', () => {
    it('renders a seven-column benchmark table with its rows and columns in order', async () => {
      const { article, markdown } = await astra();
      const tables = article.blocks.filter((block) => block.type === 'table');
      expect(tables).toHaveLength(2);

      const first = ASTRA_TABLES[0]!;
      const header = `| ${first.headers.join(' | ')} |`;
      expect(markdown).toContain(header);
      expect(markdown).toContain(`| ${['---', '---', '---', '---', '---', '---', '---'].join(' | ')} |`);
      // Row order, column order, and every value survive the trip.
      expect(markdown).toContain('| Graduate reasoning | 86.4% | 79.1% | 71.8% | 64.2% | 82.0% | Zero-shot |');
      expect(markdown).toContain('| Long-context recall | 94.2% | 88.7% | 80.3% | 69.9% | 96.1% | 128k tokens |');

      const rows = tableRows(markdown);
      for (const row of rows) expect(row).toHaveLength(7);
    });

    it('treats a fully bold first row as the header when the page uses no <th>', async () => {
      const { article } = await astra();
      const tables = article.blocks.filter((block) => block.type === 'table');
      const strongRowTable = tables[1];
      expect(strongRowTable?.type).toBe('table');
      if (strongRowTable?.type !== 'table') return;

      const headerText = strongRowTable.header.map((cell) => cell.map((run) => run.text).join(''));
      expect(headerText).toEqual([...ASTRA_TABLES[1]!.headers]);
      // The promoted row is a header, not also a body row.
      expect(strongRowTable.rows).toHaveLength(ASTRA_TABLES[1]!.rows.length);
      expect(strongRowTable.rows[0]?.[0]?.map((run) => run.text).join('')).toBe('Chart reading');
    });

    it('does not promote a data row because its first cell happens to be bold', async () => {
      const { article } = await snapshot(
        page(
          articleBody(`
            <table>
              <tr><td><strong>Model</strong></td><td>7.1</td><td>Notes here</td></tr>
              <tr><td><strong>Other</strong></td><td>6.4</td><td>More notes</td></tr>
            </table>
          `)
        )
      );
      const table = article.blocks.find((block) => block.type === 'table');
      expect(table?.type).toBe('table');
      if (table?.type !== 'table') return;
      // No header was inferred, so both rows stay data rows.
      expect(table.header.every((cell) => cell.length === 0)).toBe(true);
      expect(table.rows).toHaveLength(2);
    });

    it('keeps a link inside a cell rather than flattening it to text', async () => {
      const { markdown } = await astra();
      const linked = ASTRA_TABLES[ASTRA_LINKED_CELL.table]!.rows[ASTRA_LINKED_CELL.row]![
        ASTRA_LINKED_CELL.column
      ]!;
      expect(markdown).toContain(`[${linked}](${ASTRA_LINKED_CELL.href})`);
    });

    it('escapes a literal pipe so the row keeps its column count', async () => {
      const { markdown } = await astra();
      expect(markdown).toContain('Scanned pages \\| mixed scripts');
      const rows = tableRows(markdown);
      const cell = rows.flat().find((text) => text.includes('mixed scripts'));
      expect(cell).toBe('Scanned pages \\| mixed scripts');
      for (const row of rows) expect(row).toHaveLength(7);
    });

    it('escapes backslashes and newlines inside a cell without changing its meaning', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <table>
              <thead><tr><th>Path</th><th>Result</th></tr></thead>
              <tbody><tr>
                <td>C:\\logs\\run|1</td>
                <td>first line
                second line</td>
              </tr></tbody>
            </table>
          `)
        )
      );
      const row = tableRows(markdown).find((cells) => cells[0]?.startsWith('C:'));
      expect(row).toBeDefined();
      expect(row).toHaveLength(2);
      // A backslash stays one backslash and the pipe stays inside the cell.
      expect(row?.[0]).toBe('C:\\\\logs\\\\run\\|1');
      // A newline cannot exist in a pipe table row, so it collapses to a space.
      expect(row?.[1]).toBe('first line second line');
      expect(markdown.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3);
    });

    it('falls back to paragraphs for spanning cells without scrambling the text', async () => {
      const { article, markdown } = await snapshot(
        page(
          articleBody(`
            <table>
              <thead><tr><th colspan="2">Combined heading</th><th>Third</th></tr></thead>
              <tbody>
                <tr><td>alpha</td><td>beta</td><td>gamma</td></tr>
                <tr><td>delta</td><td>epsilon</td><td>zeta</td></tr>
              </tbody>
            </table>
          `)
        )
      );
      expect(article.blocks.some((block) => block.type === 'table')).toBe(false);
      expect(markdown).not.toContain('|');
      // Every cell is still present, in source order, as its own paragraph.
      const order = ['Combined heading', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
      let cursor = 0;
      for (const text of order) {
        const found = markdown.indexOf(text, cursor);
        expect(found, `${text} appears in order`).toBeGreaterThan(-1);
        cursor = found;
      }
    });

    it('unwraps a layout table around a data table instead of nesting one in a cell', async () => {
      const nested = await snapshot(
        page(
          articleBody(`
            <table><tbody><tr><td>outer left</td><td>
              <table><tbody><tr><td>inner one</td><td>inner two</td></tr></tbody></table>
            </td></tr></tbody></table>
          `)
        )
      );
      // A pipe table has no spelling for a table inside a cell, so the outer
      // wrapper degrades to paragraphs and the data table it was holding is
      // still rendered as a table.
      const tables = nested.article.blocks.filter((block) => block.type === 'table');
      expect(tables).toHaveLength(1);
      expect(nested.markdown).toContain('outer left');
      expect(nested.markdown).toContain('| inner one | inner two |');

      const singleColumn = await snapshot(
        page(articleBody('<table><tbody><tr><td>only column</td></tr><tr><td>second row</td></tr></tbody></table>'))
      );
      expect(singleColumn.article.blocks.some((block) => block.type === 'table')).toBe(false);
      expect(singleColumn.markdown).toContain('only column');
      expect(singleColumn.markdown).toContain('second row');
    });

    it('falls back for a table wider than the column bound', async () => {
      const columns = MAX_ARTICLE_TABLE_COLUMNS + 1;
      const cells = Array.from({ length: columns }, (_value, index) => `<td>cell ${String(index)}</td>`).join('');
      const { article, markdown } = await snapshot(
        page(articleBody(`<table><tbody><tr>${cells}</tr></tbody></table>`))
      );
      expect(article.blocks.some((block) => block.type === 'table')).toBe(false);
      expect(markdown).toContain(`cell ${String(columns - 1)}`);
    });

    it('falls back for an over-decorated cell instead of failing the article', async () => {
      // Alternating styles, with no whitespace between them, so nothing merges
      // and the piece count is exactly the pair count doubled.
      const decorated = (pairs: number): string =>
        Array.from(
          { length: pairs },
          (_value, index) => `<em>e${String(index)}</em><strong>s${String(index)}</strong>`
        ).join('');
      const table = (cell: string): string =>
        `<table><tbody><tr><td>${cell}</td><td>plain</td></tr></tbody></table>`;

      const atLimit = await snapshot(
        page(articleBody(table(decorated(MAX_ARTICLE_INLINES_PER_CELL / 2))))
      );
      expect(atLimit.article.blocks.some((block) => block.type === 'table')).toBe(true);

      const overLimit = await snapshot(
        page(articleBody(table(decorated(MAX_ARTICLE_INLINES_PER_CELL / 2 + 1))))
      );
      // One intricate cell costs this table its shape, and nothing else: the
      // article still imports, and every piece of the cell is still readable.
      expect(overLimit.article.blocks.some((block) => block.type === 'table')).toBe(false);
      expect(overLimit.article.textLength).toBeGreaterThan(0);
      expect(overLimit.markdown).toContain('e0');
      expect(overLimit.markdown).toContain(`s${String(MAX_ARTICLE_INLINES_PER_CELL / 2)}`);
      expect(overLimit.markdown).toContain('plain');
      expect(overLimit.markdown).toContain(FILLER.slice(0, 40));
    });

    it('pads a ragged row so every row has the header column count', async () => {
      const { article } = await snapshot(
        page(
          articleBody(`
            <table>
              <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
              <tbody><tr><td>one</td></tr><tr><td>two</td><td>three</td><td>four</td></tr></tbody>
            </table>
          `)
        )
      );
      const table = article.blocks.find((block) => block.type === 'table');
      if (table?.type !== 'table') throw new Error('expected a table block');
      expect(table.header).toHaveLength(3);
      for (const row of table.rows) expect(row).toHaveLength(3);
      expect(table.rows[0]?.[1]).toEqual([]);
    });

    it('keeps a table caption exactly once on both the table and the fallback path', async () => {
      const { markdown } = await astra();
      for (const table of ASTRA_TABLES) {
        expect(markdown.split(table.caption)).toHaveLength(2);
      }

      const fallback = await snapshot(
        page(
          articleBody(`
            <table>
              <caption>Only caption</caption>
              <tbody><tr><td rowspan="2">spanning</td><td>right</td></tr><tr><td>below</td></tr></tbody>
            </table>
          `)
        )
      );
      expect(fallback.markdown.split('Only caption')).toHaveLength(2);
    });

    it('rejects a table the worker could not have made rectangular', () => {
      const ragged = {
        title: 'T',
        byline: null,
        siteName: null,
        textLength: 400,
        blocks: [
          {
            type: 'table',
            header: [[{ text: 'A', style: 'plain' }], [{ text: 'B', style: 'plain' }]],
            rows: [[[{ text: 'only one', style: 'plain' }]]],
          },
        ],
      };
      expect(extractedArticleSchema.safeParse(ragged).success).toBe(false);
    });
  });

  describe('image selection', () => {
    it('offers exactly the useful article images, in reading order', async () => {
      const { article } = await astra();
      expect(articleImageSources(article)).toEqual([...ASTRA_ARCHIVED_IMAGE_URLS]);
    });

    it('excludes chrome, icons, tracking pixels, decorative art, and vector sources', async () => {
      const { article, markdown } = await astra();
      const offered = articleImageSources(article);
      for (const excluded of ASTRA_EXCLUDED_IMAGE_URLS) {
        expect(offered, `${excluded} must not be archived`).not.toContain(excluded);
        expect(markdown, `${excluded} must not appear in the snapshot`).not.toContain(excluded);
      }
      // The vector chart and the canvas hero are active or unarchivable content,
      // so neither the markup nor a remote reference survives.
      expect(markdown).not.toContain('<svg');
      expect(markdown).not.toContain('<canvas');
      expect(markdown).not.toContain('.svg');
      expect(markdown).not.toContain('evil.example');
    });

    it('resolves a relative image against a declared <base> instead', async () => {
      const { article } = await astra({ withBase: true });
      const offered = articleImageSources(article);
      expect(offered).toContain(ASTRA_IMAGE_URLS.relativeUnderBase);
      expect(offered).not.toContain(ASTRA_IMAGE_URLS.relative);
    });

    it('picks the widest srcset candidate and the real target behind a lazy placeholder', async () => {
      const { article } = await astra();
      const offered = articleImageSources(article);
      expect(offered).toContain(ASTRA_IMAGE_URLS.srcsetWide);
      expect(offered).not.toContain(ASTRA_IMAGE_URLS.srcsetNarrow);
      expect(offered).toContain(ASTRA_IMAGE_URLS.lazy);
      expect(offered.some((url) => url.startsWith('data:'))).toBe(false);
    });

    it('collapses a picture element to its raster fallback rather than its vector source', async () => {
      const { article } = await astra();
      const offered = articleImageSources(article);
      expect(offered).toContain(ASTRA_IMAGE_URLS.pictureFallback);
      expect(offered).not.toContain(ASTRA_IMAGE_URLS.pictureVectorSource);
    });

    it('keeps alt text and figure captions, including for media it refuses to embed', async () => {
      const { markdown } = await astra();
      expect(markdown).toContain(ASTRA_ALT_TEXT.comparison);
      expect(markdown).toContain(ASTRA_CAPTIONS.comparison);
      // The video and the interactive embed are gone; their captions are not.
      expect(markdown).toContain(ASTRA_CAPTIONS.video);
      expect(markdown).toContain(ASTRA_CAPTIONS.interactive);
      expect(markdown).not.toContain('demo.mp4');
      expect(markdown).not.toContain('astra-playground');
    });

    it('uses the Open Graph raster only when the body has no image of its own', async () => {
      const withBodyImages = await astra();
      expect(articleImageSources(withBodyImages.article)).not.toContain(ASTRA_IMAGE_URLS.hero);

      const canvasOnly = await astra({ withoutBodyImages: true });
      expect(articleImageSources(canvasOnly.article)).toEqual([ASTRA_IMAGE_URLS.hero]);

      const noHeroAtAll = await astra({ withoutBodyImages: true, withoutOpenGraphImage: true });
      expect(articleImageSources(noHeroAtAll.article)).toEqual([]);
    });

    it('drops an image with no alt text outside a figure but keeps one inside a figure', async () => {
      const { article } = await snapshot(
        page(
          articleBody(`
            <img src="https://cdn.example.com/pictures/bare.png" alt="" width="600" height="400">
            <figure>
              <img src="https://cdn.example.com/pictures/captioned.png" alt="" width="600" height="400">
              <figcaption>The caption carries the meaning here.</figcaption>
            </figure>
          `)
        )
      );
      const offered = articleImageSources(article);
      expect(offered).toEqual(['https://cdn.example.com/pictures/captioned.png']);
    });

    it('keeps an alt-less image that a nearby caption describes', async () => {
      // The shape a great many editorial sites publish: no alt attribute at
      // all, and the description in a captioned wrapper beside the image.
      const { article, markdown } = await snapshot(
        page(
          articleBody(`
            <div class="img-captioned">
              <img src="/images/split-keyboard.jpg" width="600" height="400">
              <p class="caption">A split keyboard with the halves pulled apart.</p>
            </div>
            <figure>
              <img src="/images/thumb-clusters.jpg" width="600" height="400">
              <figcaption>Thumb clusters, seen from above.</figcaption>
            </figure>
          `)
        )
      );

      expect(articleImageSources(article)).toEqual([
        'https://example.com/images/split-keyboard.jpg',
        'https://example.com/images/thumb-clusters.jpg',
      ]);
      // The caption becomes the image's description, as inert text.
      expect(markdown).toContain('A split keyboard with the halves pulled apart.');
      expect(markdown).toContain('Thumb clusters, seen from above.');
      expect(markdown).not.toContain('img-captioned');
      expect(markdown).not.toContain('<p class');
    });

    it('does not let a caption rescue an image the page marked as furniture', async () => {
      const { article } = await snapshot(
        page(
          articleBody(`
            <div class="img-captioned">
              <img src="/images/tracker.jpg" width="1" height="1">
              <p class="caption">Described, but a tracking pixel.</p>
            </div>
            <div class="img-captioned">
              <img src="/images/site-logo.jpg" width="600" height="400">
              <p class="caption">Described, but page chrome.</p>
            </div>
            <div class="img-captioned">
              <img src="/images/chart.svg" width="600" height="400">
              <p class="caption">Described, but a vector document.</p>
            </div>
            <div class="img-captioned">
              <img src="/images/spacer.jpg" role="presentation" width="600" height="400">
              <p class="caption">Described, but explicitly decorative.</p>
            </div>
          `)
        )
      );
      expect(articleImageSources(article)).toEqual([]);
    });

    it('borrows only a caption that is actually near, named, and caption-sized', async () => {
      const longCaption = 'This is body copy that merely follows an image. '.repeat(20);
      const { article } = await snapshot(
        page(
          articleBody(`
            <div class="img-captioned">
              <img src="/images/plain-neighbour.jpg" width="600" height="400">
              <p>An ordinary paragraph that happens to follow the image.</p>
            </div>
            <div class="img-captioned">
              <img src="/images/long-neighbour.jpg" width="600" height="400">
              <p class="caption">${longCaption}</p>
            </div>
            <div>
              <div><div><div>
                <img src="/images/deep.jpg" width="600" height="400">
              </div></div></div>
              <p class="caption">Too far above the image to be its caption.</p>
            </div>
            <div class="gallery">
              <img src="/images/first-of-two.jpg" width="600" height="400">
              <img src="/images/second-of-two.jpg" width="600" height="400">
              <p class="caption">This describes the second image.</p>
            </div>
          `)
        )
      );
      // Only the image the caption actually follows is described by it: the
      // first of the pair does not reach past its neighbour to claim it.
      expect(articleImageSources(article)).toEqual([
        'https://example.com/images/second-of-two.jpg',
      ]);
    });

    it('refuses an image source that is not http or https', () => {
      const parsed = extractedArticleSchema.safeParse({
        title: 'T',
        byline: null,
        siteName: null,
        textLength: 400,
        blocks: [{ type: 'image', src: 'javascript:alert(1)', alt: 'x' }],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('durable references', () => {
    const hash = 'a'.repeat(64);

    it('writes app-owned asset references, never page or capability URLs', async () => {
      const reference = assetReference(hash, '.png');
      const images = new Map(ASTRA_ARCHIVED_IMAGE_URLS.map((url) => [url, reference]));
      const { markdown } = await astra({}, images);

      expect(markdown).toContain(`![${ASTRA_ALT_TEXT.comparison}](${reference})`);
      expect(markdown).not.toContain('interleaf-media:');
      for (const url of ASTRA_ARCHIVED_IMAGE_URLS) {
        expect(markdown, `${url} must not survive as a remote reference`).not.toContain(url);
      }
    });

    it('degrades an image that was not archived to its alt text', async () => {
      const reference = assetReference(hash, '.png');
      const partial = new Map([[ASTRA_IMAGE_URLS.comparison, reference]]);
      const { markdown } = await astra({}, partial);

      expect(markdown).toContain(`![${ASTRA_ALT_TEXT.comparison}](${reference})`);
      // The others keep their description instead of taking the article down.
      expect(markdown).toContain(`*${ASTRA_ALT_TEXT.lazy}*`);
      expect(markdown).not.toContain(ASTRA_IMAGE_URLS.lazy);
    });

    it('renders identical bytes for the same page and the same reference map', async () => {
      const images = new Map([[ASTRA_IMAGE_URLS.comparison, assetReference(hash, '.png')]]);
      const first = await astra({}, images);
      const second = await astra({}, images);
      expect(first.markdown).toBe(second.markdown);
    });
  });

  /**
   * The producer and the consumer of these bytes are different subsystems, so
   * the snapshot is parsed back with the reader's own Markdown parser. A table
   * that renders correctly but parses into the wrong number of columns would be
   * worse than no table at all.
   */
  describe('reader round trip', () => {
    it('parses both benchmark tables back into seven-column table blocks', async () => {
      const { markdown } = await astra();
      const parsed = parseMarkdownDocument(markdown);
      const tables = parsed.blocks.filter((block) => block.type === 'table');
      expect(tables).toHaveLength(2);

      for (const [index, block] of tables.entries()) {
        const source = ASTRA_TABLES[index]!;
        expect(block.table.headers).toHaveLength(7);
        expect(block.table.headers.map((cell) => cellText(cell.children))).toEqual([
          ...source.headers,
        ]);
        expect(block.table.rows).toHaveLength(source.rows.length);
        for (const row of block.table.rows) expect(row.cells).toHaveLength(7);
      }
    });

    it('restores a literal pipe inside a cell without shifting the columns', async () => {
      const { markdown } = await astra();
      const parsed = parseMarkdownDocument(markdown);
      const tables = parsed.blocks.filter((block) => block.type === 'table');
      const multimodal = tables[1];
      if (multimodal?.type !== 'table') throw new Error('expected the second table');

      const lastRow = multimodal.table.rows[2];
      expect(lastRow?.cells.map((cell) => cellText(cell.children))).toEqual([
        ...ASTRA_TABLES[1]!.rows[2]!,
      ]);
    });

    it('restores a backslash in a code cell instead of showing the escape', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <table>
              <thead><tr><th>Pattern</th><th>Meaning</th></tr></thead>
              <tbody><tr>
                <td><code>C:\\logs\\run|1</code></td>
                <td>C:\\logs\\run|1</td>
              </tr></tbody>
            </table>
          `)
        )
      );
      const parsed = parseMarkdownDocument(markdown);
      const table = parsed.blocks.find((block) => block.type === 'table');
      if (table?.type !== 'table') throw new Error('expected a table block');
      const cells = table.table.rows[0]?.cells ?? [];
      expect(cells).toHaveLength(2);
      // A code span is verbatim to the inline parser, so the doubling the row
      // writer needed has to be undone while the row is being split. Both the
      // code cell and the plain one read back exactly what the page said.
      expect(cells[0]?.children[0]).toEqual({ type: 'code', code: 'C:\\logs\\run|1' });
      expect(cellText(cells[1]?.children ?? [])).toBe('C:\\logs\\run|1');
    });

    it('preserves ordinary authored Markdown code-span backslashes such as `C:\\logs`', () => {
      const markdown = [
        '| Header | Description |',
        '| --- | --- |',
        '| `C:\\\\logs` | Log directory |',
      ].join('\n');
      const parsed = parseMarkdownDocument(markdown);
      const table = parsed.blocks.find((block) => block.type === 'table');
      if (table?.type !== 'table') throw new Error('expected a table block');
      const cells = table.table.rows[0]?.cells ?? [];
      expect(cells[0]?.children[0]).toEqual({ type: 'code', code: 'C:\\\\logs' });
    });

    it('keeps a cell link and an archived image reference intact', async () => {
      const reference = assetReference('b'.repeat(64), '.png');
      const images = new Map([[ASTRA_IMAGE_URLS.comparison, reference]]);
      const { markdown } = await astra({}, images);
      const parsed = parseMarkdownDocument(markdown);

      const links: string[] = [];
      const images_: { src: string; alt: string }[] = [];
      const walk = (inlines: readonly MarkdownInline[]): void => {
        for (const inline of inlines) {
          if (inline.type === 'link') links.push(inline.href);
          if (inline.type === 'image') images_.push({ src: inline.src, alt: inline.alt });
          if ('children' in inline) walk(inline.children);
        }
      };
      for (const block of parsed.blocks) {
        if (block.type === 'table') {
          for (const header of block.table.headers) walk(header.children);
          for (const row of block.table.rows) for (const cell of row.cells) walk(cell.children);
        }
        if (block.type === 'paragraph') walk(block.children);
      }

      expect(links).toContain(ASTRA_LINKED_CELL.href);
      expect(images_).toContainEqual({ src: reference, alt: ASTRA_ALT_TEXT.comparison });
    });
  });
});
