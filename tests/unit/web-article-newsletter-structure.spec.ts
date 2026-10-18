import { describe, expect, it } from 'vitest';
import { extractArticleInWorker } from '@main/workers/article-extract-worker';
import { articleImageSources, renderArticleMarkdown } from '@main/library/article-markdown';
import { assetReference } from '@main/library/article-media';
import type { ExtractedArticle } from '@main/library/article-content';
import {
  NEWSLETTER_ALT_TEXT,
  NEWSLETTER_ARTICLE_URL,
  NEWSLETTER_CAPTIONS,
  NEWSLETTER_CHROME_HEADLINE,
  NEWSLETTER_EXCLUDED_IMAGE_URLS,
  NEWSLETTER_FIGURE_ORDER,
  NEWSLETTER_FIGURE_URLS,
  NEWSLETTER_HEADINGS,
  NEWSLETTER_NARROW_URLS,
  NEWSLETTER_TEASER_HEADLINE,
  NEWSLETTER_TITLE,
  newsletterArticleHtml,
  type NewsletterFixtureOptions,
} from '../fixtures/newsletter-post-article-fixture';

/**
 * Structure survival for a hosted-newsletter post, run through the real
 * extraction worker.
 *
 * The fixture is a from-scratch stand-in built in the shapes that flattened the
 * motivating capture: anchor-classed headings wrapping a copy-link button, a
 * post element classed `newsletter-post`, and `picture > source + img` figures
 * on a CDN whose URLs contain commas. What is asserted here is what a reader of
 * the snapshot would actually get.
 */

async function extract(options: NewsletterFixtureOptions = {}): Promise<ExtractedArticle> {
  return extractArticleInWorker(newsletterArticleHtml(options), NEWSLETTER_ARTICLE_URL);
}

function headingBlocks(article: ExtractedArticle): { level: number; text: string }[] {
  return article.blocks
    .filter((block) => block.type === 'heading')
    .map((block) => ({
      level: block.level,
      text: block.inline.map((inline) => inline.text).join('').trim(),
    }));
}

function imageSrcsInOrder(article: ExtractedArticle): string[] {
  return article.blocks.filter((block) => block.type === 'image').map((block) => block.src);
}

/** Archive references for the figures, as a completed capture would hold them. */
function archived(): ReadonlyMap<string, string> {
  return new Map(
    NEWSLETTER_FIGURE_ORDER.map((url, index) => [
      url,
      assetReference(String(index).repeat(64).slice(0, 64), '.png'),
    ])
  );
}

function markdownOf(article: ExtractedArticle, images?: ReadonlyMap<string, string>): string {
  return renderArticleMarkdown({
    article,
    sourceUrl: NEWSLETTER_ARTICLE_URL,
    fallbackTitle: 'Untitled article',
    ...(images === undefined ? {} : { images }),
  });
}

describe('newsletter post structure', () => {
  describe('section headings', () => {
    it('keeps every anchor-classed heading, in order, as a heading', async () => {
      const article = await extract();
      const captured = headingBlocks(article).filter(
        (block) => block.text !== NEWSLETTER_TEASER_HEADLINE && block.text !== NEWSLETTER_TITLE
      );
      expect(captured.map((block) => block.text)).toEqual(
        NEWSLETTER_HEADINGS.map((entry) => entry.text)
      );
      // A second <h1> inside the body is the article's own section heading, and
      // Readability normalizes it to the level below the title it already
      // assigned. Everything below the top level keeps the level it was
      // published at, which is the distinction the reader sees.
      expect(captured.map((block) => block.level)).toEqual([2, 2, 2, 4]);
    });

    it('keeps an h4 anchor heading a heading rather than a paragraph', async () => {
      const article = await extract();
      const deep = headingBlocks(article).find((block) => block.level === 4);
      expect(deep?.text).toBe('Latency of model requests');
      // The same words must not also survive as body prose.
      const paragraphs = article.blocks
        .filter((block) => block.type === 'paragraph')
        .map((block) => block.inline.map((inline) => inline.text).join(''));
      expect(paragraphs).not.toContain('Latency of model requests');
    });

    it('removes the copy-link button and its vector without taking the heading text', async () => {
      const article = await extract();
      const markdown = markdownOf(article);
      expect(markdown).toContain('## Part 1: System specification and constraints');
      expect(markdown).toContain('## Architectural observations');
      expect(markdown).toContain('#### Latency of model requests');
      // The button's accessible name and the vector's title are chrome.
      expect(markdown).not.toContain('Copy link');
      expect(markdown).not.toContain('<svg');
      expect(markdown).not.toContain('<button');
    });

    it('leaves a masthead heading outside the post element out of the article', async () => {
      // The rescue is scoped to the root the page nominates as its article, so
      // chrome keeps the names that let Readability rule it out. A masthead
      // carrying the very same anchor class as the post's headings must not be
      // adopted as body text because the post's headings were rescued.
      const article = await extract();
      expect(headingBlocks(article).map((block) => block.text)).not.toContain(
        NEWSLETTER_CHROME_HEADLINE
      );
      expect(markdownOf(article)).not.toContain(NEWSLETTER_CHROME_HEADLINE);
    });
  });

  describe('editorial figures', () => {
    it('keeps every picture figure, in the order the page presents them', async () => {
      const article = await extract();
      expect(imageSrcsInOrder(article)).toEqual([...NEWSLETTER_FIGURE_ORDER]);
      expect(articleImageSources(article)).toEqual([...NEWSLETTER_FIGURE_ORDER]);
    });

    it('reads a CDN srcset whose URLs contain commas as whole URLs', async () => {
      const article = await extract();
      const srcs = imageSrcsInOrder(article);
      // Every archived URL is a complete absolute CDN URL, not a fragment of
      // one resolved against the article's own host.
      for (const src of srcs) {
        expect(src.startsWith('https://cdn.example-stack.com/image/fetch/')).toBe(true);
        expect(src).not.toContain('example-stack.com/p/');
      }
      for (const narrow of NEWSLETTER_NARROW_URLS) expect(srcs).not.toContain(narrow);
      expect(srcs).toContain(NEWSLETTER_FIGURE_URLS.roofline);
    });

    it('renders the figures as inert Markdown images interleaved with the headings', async () => {
      const article = await extract();
      const images = archived();
      const markdown = markdownOf(article, images);
      const order = [
        '## Part 1: System specification and constraints',
        images.get(NEWSLETTER_FIGURE_URLS.timeline) ?? '',
        '## The Pareto frontier of system-level tradeoffs',
        '## Architectural observations',
        images.get(NEWSLETTER_FIGURE_URLS.roofline) ?? '',
        '#### Latency of model requests',
        images.get(NEWSLETTER_FIGURE_URLS.latency) ?? '',
      ];
      let cursor = -1;
      for (const needle of order) {
        const at = markdown.indexOf(needle, cursor + 1);
        expect(at, `${needle} in order`).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(markdown).toContain(`![${NEWSLETTER_ALT_TEXT.roofline}]`);
      expect(markdown).toContain(NEWSLETTER_CAPTIONS[1]);
      expect(markdown).not.toContain('<picture');
      expect(markdown).not.toContain('<img');
    });

    it('still refuses the masthead logo and a teaser card thumbnail', async () => {
      const article = await extract();
      const srcs = imageSrcsInOrder(article);
      expect(srcs).not.toContain(NEWSLETTER_EXCLUDED_IMAGE_URLS.siteLogo);
      expect(srcs).not.toContain(NEWSLETTER_EXCLUDED_IMAGE_URLS.teaserThumbnail);
      expect(articleImageSources(article)).not.toContain(
        NEWSLETTER_EXCLUDED_IMAGE_URLS.teaserThumbnail
      );
    });

    it('captures the same figures when the teaser card is absent', async () => {
      const article = await extract({ withoutTeaser: true });
      expect(imageSrcsInOrder(article)).toEqual([...NEWSLETTER_FIGURE_ORDER]);
    });
  });
});
