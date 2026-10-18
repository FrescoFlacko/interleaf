import { describe, expect, it } from 'vitest';
import { extractArticleInWorker } from '@main/workers/article-extract-worker';
import { articleImageSources } from '@main/library/article-markdown';
import {
  MAX_ARTICLE_BLOCKS,
  MAX_ARTICLE_IMAGE_CANDIDATES,
  MAX_ARTICLE_IMAGES,
  type ExtractedArticle,
} from '@main/library/article-content';
import { MAX_ARCHIVED_IMAGES } from '@main/library/article-media';
import {
  KEYBOARD_ALT_TEXT,
  KEYBOARD_ARTICLE_URL,
  KEYBOARD_CAPTIONS,
  KEYBOARD_DROPPED_IMAGE_URLS,
  KEYBOARD_EDITORIAL_IMAGE_ORDER,
  KEYBOARD_EXCLUDED_IMAGE_URLS,
  keyboardArticleHtml,
} from '../fixtures/split-keyboard-article-fixture';

/**
 * Recovering the editorial figures Readability discards.
 *
 * The fixture is a from-scratch stand-in for a long illustrated build guide,
 * built in the shapes Readability scores as furniture: linked figures, a
 * lazy-loaded figure, a responsive figure, a hero above the body, and a short
 * link-heavy closing section. These run through the real extraction worker, so
 * what is asserted is what a reader of the snapshot would actually get.
 */

async function extract(html = keyboardArticleHtml()): Promise<ExtractedArticle> {
  return extractArticleInWorker(html, KEYBOARD_ARTICLE_URL);
}

function imageSrcsInOrder(article: ExtractedArticle): string[] {
  return article.blocks.filter((block) => block.type === 'image').map((block) => block.src);
}

function captionTexts(article: ExtractedArticle): string[] {
  return article.blocks
    .filter((block) => block.type === 'caption')
    .map((block) => block.inline.map((inline) => inline.text).join(''));
}

/**
 * Caption prose wherever it ended up. A `<figcaption>` becomes a caption block,
 * while a figure that captions itself with a styled `<p>` survives the scoring
 * pass on its own and stays a paragraph; both keep the words next to the
 * picture, which is what the reader is owed.
 */
function proseTexts(article: ExtractedArticle): string[] {
  return article.blocks
    .filter((block) => block.type === 'caption' || block.type === 'paragraph')
    .map((block) => block.inline.map((inline) => inline.text).join(''));
}

/** Heading blocks the article opens with, which a hero must never jump above. */
function leadingHeadings(article: ExtractedArticle): number {
  let count = 0;
  while (article.blocks[count]?.type === 'heading') count += 1;
  return count;
}

/** The article with `count` extra linked gallery figures before the shop section. */
function galleryHtml(count: number): string {
  const figures = Array.from(
    { length: count },
    (_value, index) =>
      `<figure class="post-figure"><a href="https://shop.example.com/${String(index)}">` +
      `<img src="https://static.example-blog.com/gallery/${String(index)}.png" ` +
      `alt="Build photograph number ${String(index)}" width="1024" height="683"></a>` +
      `<figcaption>Build photograph number ${String(index)}.</figcaption></figure>`
  ).join('');
  return keyboardArticleHtml().replace('<h2>Where to buy</h2>', `${figures}<h2>Where to buy</h2>`);
}

/**
 * A paragraph opening the page uses three times.
 *
 * Longer than the sixty characters an anchor key keeps, so all three
 * paragraphs — and the two that only share the opening — are indistinguishable
 * to placement and can only be told apart by which one comes next.
 */
const REPEATED_OPENING =
  'Run the same pass over every switch in the board before you decide anything at all';

const PASS_IMAGE_URLS = {
  one: 'https://static.example-blog.com/split-keyboards/pass-one.png',
  three: 'https://static.example-blog.com/split-keyboards/pass-three.png',
} as const;

/** The article with a section whose prose repeats around two dropped figures. */
function repeatedProseHtml(): string {
  const paragraph = (tail: string): string => `<p>${REPEATED_OPENING}, ${tail}</p>`;
  const figure = (src: string, ordinal: string): string =>
    `<figure class="post-figure"><a href="https://shop.example.com/${ordinal}">` +
    `<img src="${src}" alt="The ${ordinal} pass over the switch plate" width="1024" height="683"></a>` +
    `<figcaption>The ${ordinal} pass over the switch plate.</figcaption></figure>`;
  const section = [
    '<h2>Three passes</h2>',
    paragraph('then start again from the outermost column and work inwards slowly.'),
    figure(PASS_IMAGE_URLS.one, 'first'),
    paragraph('then check the plate for flex before the second pass begins in earnest.'),
    paragraph('then finish with the thumb cluster, which always needs the most attention.'),
    figure(PASS_IMAGE_URLS.three, 'third'),
  ].join('');
  return keyboardArticleHtml().replace('<h2>Where to buy</h2>', `${section}<h2>Where to buy</h2>`);
}

/** A line the page prints four times, word for word, around a dropped figure. */
const IDENTICAL_PARAGRAPH =
  'Check the plate for flex, then seat every switch again, working from the outermost column inwards.';

const PLATE_IMAGE_URL = 'https://static.example-blog.com/split-keyboards/third-pass.png';

/**
 * The article with a figure that followed the third of four identical lines.
 *
 * Nothing distinguishes the paragraphs, and the line after the figure is the
 * same line again, so there is no unique following anchor to fall back on: only
 * the occurrence the figure actually sat next to can place it.
 */
function identicalProseHtml(): string {
  const paragraph = `<p>${IDENTICAL_PARAGRAPH}</p>`;
  const figure =
    '<figure class="post-figure"><a href="https://shop.example.com/plate">' +
    `<img src="${PLATE_IMAGE_URL}" alt="The plate after the third pass" ` +
    'width="1024" height="683"></a></figure>';
  const section = [
    '<h2>Four identical passes</h2>',
    paragraph,
    paragraph,
    paragraph,
    figure,
    paragraph,
  ].join('');
  return keyboardArticleHtml().replace('<h2>Where to buy</h2>', `${section}<h2>Where to buy</h2>`);
}

describe('web article image reconciliation', () => {
  it('keeps every editorial figure the scoring pass dropped, in document order', async () => {
    const article = await extract();
    expect(imageSrcsInOrder(article)).toEqual([...KEYBOARD_EDITORIAL_IMAGE_ORDER]);
  });

  it('offers exactly those figures to the media archive', async () => {
    const article = await extract();
    expect(articleImageSources(article)).toEqual([...KEYBOARD_EDITORIAL_IMAGE_ORDER]);
  });

  it('recovers a restored figure alongside its caption exactly once', async () => {
    const article = await extract();
    const prose = proseTexts(article);
    for (const caption of Object.values(KEYBOARD_CAPTIONS)) {
      if (caption === KEYBOARD_CAPTIONS.video || caption === KEYBOARD_CAPTIONS.interactive) continue;
      expect(prose.filter((text) => text === caption), caption).toHaveLength(1);
    }
    // A caption Readability already kept is not restored a second time.
    const captions = captionTexts(article);
    expect(captions.filter((text) => text === KEYBOARD_CAPTIONS.charybdis)).toHaveLength(1);
  });

  it('places a restored figure between the paragraphs that surrounded it', async () => {
    const article = await extract();
    const index = article.blocks.findIndex(
      (block) => block.type === 'image' && block.src === KEYBOARD_DROPPED_IMAGE_URLS.tenting
    );
    const heading = article.blocks.findIndex(
      (block) =>
        block.type === 'heading' &&
        block.inline.map((inline) => inline.text).join('').includes('raise it')
    );
    const nextHeading = article.blocks.findIndex(
      (block) =>
        block.type === 'heading' &&
        block.inline.map((inline) => inline.text).join('').includes('Wireless')
    );
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(heading);
    expect(index).toBeLessThan(nextHeading);
  });

  it('opens with the hero banner, never above a surviving title heading', async () => {
    const article = await extract();
    const banner = article.blocks.findIndex(
      (block) => block.type === 'image' && block.src === KEYBOARD_DROPPED_IMAGE_URLS.banner
    );
    // The hero belongs at the top of the body, but under any heading the
    // article opens with: the renderer deduplicates a leading title heading
    // against the front matter and stops recognizing it if an image is pushed
    // above it.
    expect(banner).toBe(leadingHeadings(article));
  });

  it('leaves an article with no banner one figure shorter and otherwise identical', async () => {
    const article = await extract(keyboardArticleHtml({ withoutBanner: true }));
    expect(imageSrcsInOrder(article)).toEqual(
      KEYBOARD_EDITORIAL_IMAGE_ORDER.filter((src) => src !== KEYBOARD_DROPPED_IMAGE_URLS.banner)
    );
  });

  it('carries the alt text a restored figure declared', async () => {
    const article = await extract();
    const byline = new Map(
      article.blocks
        .filter((block) => block.type === 'image')
        .map((block) => [block.src, block.alt])
    );
    expect(byline.get(KEYBOARD_DROPPED_IMAGE_URLS.charybdis)).toBe(KEYBOARD_ALT_TEXT.charybdis);
    expect(byline.get(KEYBOARD_DROPPED_IMAGE_URLS.dongle)).toBe(KEYBOARD_ALT_TEXT.dongle);
  });

  it('prefers the widest rendition of a responsive figure', async () => {
    const article = await extract();
    const offered = articleImageSources(article);
    expect(offered).toContain(KEYBOARD_DROPPED_IMAGE_URLS.layoutComparison);
    expect(offered).not.toContain(KEYBOARD_EXCLUDED_IMAGE_URLS.narrowLayout);
  });

  it('bounds a restored capture by the schema-validated image maximum', async () => {
    const article = await extract(galleryHtml(MAX_ARTICLE_IMAGES + 12));
    const images = imageSrcsInOrder(article);
    expect(images.length).toBe(MAX_ARTICLE_IMAGES);
    expect(new Set(images).size).toBe(images.length);
  });

  it('archives up to the same maximum the extraction schema validates', () => {
    expect(MAX_ARCHIVED_IMAGES).toBe(MAX_ARTICLE_IMAGES);
    expect(MAX_ARCHIVED_IMAGES).toBe(40);
  });

  it('counts the editorial figures the image ceiling refused', async () => {
    const extra = 12;
    const article = await extract(galleryHtml(MAX_ARTICLE_IMAGES + extra));
    expect(imageSrcsInOrder(article)).toHaveLength(MAX_ARTICLE_IMAGES);
    // Seven of the fixture's own figures are also competing for the same forty
    // places, so the shortfall is at least the twelve the gallery added.
    expect(article.imagesOmitted ?? 0).toBeGreaterThanOrEqual(extra);
  });

  it('reports nothing omitted when every figure fits', async () => {
    const article = await extract();
    expect(article.imagesOmitted).toBeUndefined();
  });

  it('never carries the URLs of the figures it left behind', async () => {
    const article = await extract(galleryHtml(MAX_ARTICLE_IMAGES + 12));
    // The reply is a count and nothing else: no list, no addresses.
    expect(typeof article.imagesOmitted).toBe('number');
    expect(JSON.stringify(article)).not.toContain('/gallery/51.png');
  });

  it('refuses a site header photograph that looks nothing like chrome', async () => {
    const article = await extract();
    const offered = articleImageSources(article);
    expect(offered).not.toContain(KEYBOARD_EXCLUDED_IMAGE_URLS.siteBrandPhoto);
  });

  it('keeps a hero the article put in a header of its own', async () => {
    const article = await extract(keyboardArticleHtml({ bannerInArticleHeader: true }));
    expect(articleImageSources(article)).toContain(KEYBOARD_DROPPED_IMAGE_URLS.banner);
  });

  it('recognizes image candidates up to a bound derived from the block ceiling', () => {
    // Not an invented number: a candidate could at most have become one block,
    // so the article's own block ceiling is what bounds how many it recognizes.
    expect(MAX_ARTICLE_IMAGE_CANDIDATES).toBe(MAX_ARTICLE_BLOCKS);
  });

  it('accounts for every eligible figure exactly, past any saturating count', async () => {
    const gallery = 460;
    const article = await extract(galleryHtml(gallery));
    const images = imageSrcsInOrder(article);
    // The fixture's own editorial figures compete for the same forty places, so
    // they are candidates too, and the total is the page's whole eligible set.
    const candidates = gallery + KEYBOARD_EDITORIAL_IMAGE_ORDER.length;

    expect(images).toHaveLength(MAX_ARTICLE_IMAGES);
    // Exact, not saturated: a count that stopped at four hundred would leave
    // sixty-odd pictures unaccounted for on a page like this.
    expect(article.imagesOmitted).toBe(candidates - MAX_ARTICLE_IMAGES);
    expect(images.length + (article.imagesOmitted ?? 0)).toBe(candidates);
    expect(article.imagesOmitted ?? 0).toBeLessThanOrEqual(MAX_ARTICLE_IMAGE_CANDIDATES);
    // Still a number and nothing else.
    expect(JSON.stringify(article)).not.toContain('/gallery/459.png');
  });

  it('places a restored figure after the exact repeated line it followed', async () => {
    const article = await extract(identicalProseHtml());
    const paragraphs: number[] = [];
    article.blocks.forEach((block, index) => {
      if (block.type !== 'paragraph') return;
      if (block.inline.map((inline) => inline.text).join('') === IDENTICAL_PARAGRAPH) {
        paragraphs.push(index);
      }
    });
    const image = article.blocks.findIndex(
      (block) => block.type === 'image' && block.src === PLATE_IMAGE_URL
    );

    expect(paragraphs).toHaveLength(4);
    const [, , third = -1, fourth = -1] = paragraphs;
    // Exactly between the third occurrence and the fourth, which is where the
    // page put it. Matching the anchor text alone lands it after the first.
    expect(image).toBe(third + 1);
    expect(fourth).toBe(image + 1);
  });

  it('places restored figures by occurrence when the surrounding text repeats', async () => {
    const article = await extract(repeatedProseHtml());
    const at = (src: string): number =>
      article.blocks.findIndex((block) => block.type === 'image' && block.src === src);
    const paragraphs: number[] = [];
    article.blocks.forEach((block, index) => {
      if (block.type !== 'paragraph') return;
      if (block.inline.map((inline) => inline.text).join('').startsWith(REPEATED_OPENING)) {
        paragraphs.push(index);
      }
    });

    expect(paragraphs).toHaveLength(3);
    const [first = -1, second = -1, third = -1] = paragraphs;
    // Each figure belongs beside the occurrence it actually followed. A search
    // over the whole article would find the last matching paragraph and drag
    // both figures to the bottom of the section.
    expect(at(PASS_IMAGE_URLS.one)).toBeGreaterThan(first);
    expect(at(PASS_IMAGE_URLS.one)).toBeLessThan(second);
    expect(at(PASS_IMAGE_URLS.three)).toBeGreaterThan(third);
  });
});
