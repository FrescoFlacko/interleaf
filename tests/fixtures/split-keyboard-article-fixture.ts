/**
 * A stand-in for a long, heavily illustrated personal-blog build guide.
 *
 * It is written from scratch — invented prose, invented product names, invented
 * hosts — and no test contacts the page that inspired it. What is reproduced is
 * that page's *shape*, which is the shape Mozilla Readability handles worst:
 *
 * - a hero banner above the article body, outside the scored content;
 * - captioned figures whose image is wrapped in an affiliate-style link, so the
 *   figure reads as pure link density;
 * - a figure whose real source is parked in `data-src` behind a placeholder;
 * - a figure carrying only a `srcset`;
 * - a short trailing "where to buy" section with more link than prose.
 *
 * Readability discards all of those and keeps the surrounding paragraphs, which
 * is exactly how the motivating article lost seven editorial figures. Around
 * them the fixture also carries the things that must stay lost: a comment
 * thread with avatars, a share widget, a favicon, a tracking pixel, an inline
 * SVG chart, a `<video>`, an `<iframe>`, a `<canvas>`, and a form.
 */

const CDN = 'https://static.example-blog.com';

export const KEYBOARD_ARTICLE_URL = 'https://www.example-blog.com/posts/2026/02/split-keyboards/';
const KEYBOARD_SITE_NAME = 'Example Blog';
const KEYBOARD_TITLE = "A beginner's guide to split keyboards";
const KEYBOARD_AUTHOR = 'Sam Rivers';

/**
 * The seven editorial figures Readability drops, in the order the page presents
 * them. Reconciliation has to return every one of them, in this order.
 */
export const KEYBOARD_DROPPED_IMAGE_URLS = {
  /** Article hero banner, above the body and outside the scored content. */
  banner: `${CDN}/split-keyboards/banner.png`,
  /** Captioned figure whose image is wrapped in a shop link. */
  ultimateHacking: `${CDN}/split-keyboards/ultimate-hacking-keyboard.png`,
  /** Captioned figure inside a low-text wrapper. */
  tenting: `${CDN}/split-keyboards/tenting-setup.png`,
  /** Linked captioned figure for a trackball board. */
  charybdis: `${CDN}/split-keyboards/charybdis.png`,
  /** Lazy-loaded figure: the real source sits in `data-src`. */
  dongle: `${CDN}/split-keyboards/zmk-dongle.png`,
  /** Responsive figure offering only a `srcset`. */
  layoutComparison: `${CDN}/split-keyboards/layout-comparison-1200.png`,
  /** Figure in the short, link-heavy closing section. */
  shop: `${CDN}/split-keyboards/beekeeb-shop.png`,
} as const;

/** The narrow rendition of the responsive figure, which must lose to the wide one. */
const KEYBOARD_NARROW_LAYOUT_URL = `${CDN}/split-keyboards/layout-comparison-400.png`;

/** Everything the capture must never request, whatever else changes. */
export const KEYBOARD_EXCLUDED_IMAGE_URLS = {
  favicon: `${CDN}/site/favicon.png`,
  siteLogo: `${CDN}/site/logo.png`,
  /**
   * The site's brand photograph, in the page header above everything.
   *
   * Deliberately named like an editorial photograph and given real alt text:
   * nothing about the URL or the words marks it as chrome, so only the fact
   * that it sits in the site's own header can keep it out. It is the case the
   * `logo.png` above was quietly covering for.
   */
  siteBrandPhoto: `${CDN}/site/workbench-masthead-photo.png`,
  shareIcon: `${CDN}/site/icon-share.png`,
  trackingPixel: 'https://metrics.example.net/pixel.gif',
  /** Two commenters' portraits, in a comment thread below the article. */
  commenterOne: `${CDN}/users/portrait-4821.png`,
  commenterTwo: `${CDN}/users/portrait-9143.png`,
  /** Author portrait in the bio card under the article. */
  authorBio: `${CDN}/users/portrait-sam.png`,
  /** Thumbnail in the "related posts" strip. */
  relatedThumbnail: `${CDN}/related/keycap-profiles.png`,
  /** Thumbnail in a sponsored strip. */
  sponsoredThumbnail: `${CDN}/promo/switch-tester.png`,
  /** Vector chart, refused by policy rather than by scoring. */
  vectorChart: `${CDN}/split-keyboards/typing-speed.svg`,
  /** Poster frame of a `<video>`; the element and its poster are both dropped. */
  videoPoster: `${CDN}/split-keyboards/demo-poster.png`,
  narrowLayout: KEYBOARD_NARROW_LAYOUT_URL,
} as const;

export const KEYBOARD_ALT_TEXT = {
  banner: 'A split keyboard in two halves on a wooden desk',
  ultimateHacking: 'The Ultimate Hacking Keyboard with its two halves joined',
  tenting: 'A tented split keyboard raised on adjustable legs',
  charybdis: 'A Charybdis board with an integrated trackball under the thumb cluster',
  dongle: 'A wireless dongle plugged into the back of a laptop',
  layoutComparison: 'Three keyboard layouts drawn side by side for comparison',
  shop: 'An assembled board photographed on a workshop bench',
} as const;

export const KEYBOARD_CAPTIONS = {
  banner: 'The board I ended up with after eighteen months of rebuilding.',
  ultimateHacking: 'The Ultimate Hacking Keyboard is the gentlest way into a split layout.',
  tenting: 'Tenting is the change that did the most for my wrists.',
  charybdis: 'An integrated trackball removes the reach to the mouse entirely.',
  dongle: 'A dongle keeps the wireless link off the host operating system.',
  layoutComparison: 'Staggered, ortholinear, and columnar, drawn to the same scale.',
  shop: 'Beekeeb sells the assembled version if you would rather not solder.',
  video: 'Typing on the finished board, filmed from above.',
  interactive: 'An embedded layout editor, which this snapshot does not keep.',
} as const;

const PARAGRAPHS: readonly string[] = [
  'A split keyboard is two keyboards that agree to act as one, and the whole argument for owning a pair is that your shoulders get to decide where your hands go instead of the other way around. I resisted the idea for years on the grounds that it looked like a lot of trouble, and it was a lot of trouble, and I would do it again tomorrow.',
  'The first thing to understand is that almost none of the difficulty is in the splitting. Two halves at shoulder width feels natural within an afternoon. The difficulty is in everything the split-keyboard community bundles along with it: fewer keys, a columnar layout, thumb clusters, and a layer system that hides half the alphabet behind a held key.',
  'So my advice is to buy the least ambitious board you can find, and to change exactly one thing at a time. Every person I know who bounced off split keyboards bounced because they took delivery of a thirty-six key wireless board with no legends and tried to keep working the same afternoon.',
  'Tenting is the next change worth making, and it is the one people skip because it looks like an accessory rather than a feature. Rotating each half so the thumbs sit higher than the little fingers takes the forearms out of a permanent twist, and unlike the layout changes it costs no relearning at all.',
  'Wireless is worth having and worth being patient about. The firmware story is good now, but a board that talks to the host over Bluetooth directly will occasionally lose a keystroke during a reconnect, and a keyboard that loses keystrokes is a keyboard you stop trusting.',
  'The layout question is the one that generates the most argument and matters the least at the beginning. Staggered, ortholinear, and columnar are all fine, and the honest answer is that you will adapt to whichever one you commit to for a month.',
];

const CLOSING_PARAGRAPH =
  'None of this is expensive by the standards of hobbies that involve soldering, and all of it is reversible. If you try one board and hate it, sell it; the second-hand market for these things is unreasonably healthy.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A captioned figure whose image is wrapped in a shop link, which is the shape
 * that reads as pure link density to a scoring pass.
 */
function linkedFigure(src: string, alt: string, caption: string, href: string): string {
  return `
    <figure class="post-figure">
      <a href="${href}"><img src="${src}" alt="${escapeHtml(alt)}" width="1024" height="683"></a>
      <figcaption>${escapeHtml(caption)}</figcaption>
    </figure>`;
}

function plainFigure(src: string, alt: string, caption: string): string {
  return `
    <div class="post-figure">
      <img src="${src}" alt="${escapeHtml(alt)}" width="1024" height="683">
      <p class="caption">${escapeHtml(caption)}</p>
    </div>`;
}

function lazyFigure(src: string, alt: string, caption: string): string {
  return `
    <figure class="post-figure">
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
        data-src="${src}" loading="lazy" alt="${escapeHtml(alt)}" width="1024" height="683">
      <figcaption>${escapeHtml(caption)}</figcaption>
    </figure>`;
}

function responsiveFigure(): string {
  return `
    <figure class="post-figure">
      <img
        srcset="${KEYBOARD_NARROW_LAYOUT_URL} 400w, ${KEYBOARD_DROPPED_IMAGE_URLS.layoutComparison} 1200w"
        sizes="(max-width: 600px) 400px, 1200px"
        alt="${escapeHtml(KEYBOARD_ALT_TEXT.layoutComparison)}" width="1200" height="600">
      <figcaption>${escapeHtml(KEYBOARD_CAPTIONS.layoutComparison)}</figcaption>
    </figure>`;
}

/** The comment thread, share rail, promo strips, and bio card. All must stay out. */
function furnitureHtml(): string {
  return `
  <div class="share-buttons">
    <a href="/share"><img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.shareIcon}" alt="Share this post" width="200" height="200"></a>
  </div>
  <div class="author-bio">
    <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.authorBio}" alt="${KEYBOARD_AUTHOR}" width="200" height="200">
    <p>${KEYBOARD_AUTHOR} writes about keyboards, workshops, and the tools that go with them, and has been doing so for rather longer than is strictly reasonable.</p>
  </div>
  <section class="related-posts">
    <h2>Related posts</h2>
    <a href="/posts/keycaps"><img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.relatedThumbnail}" alt="Keycap profiles compared" width="480" height="270"></a>
  </section>
  <aside class="sponsored">
    <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.sponsoredThumbnail}" alt="A switch tester board" width="480" height="270">
  </aside>
  <section id="comments">
    <h2>Comments</h2>
    <ul class="comment-list">
      <li class="comment">
        <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.commenterOne}" alt="Dana Okafor" width="96" height="96">
        <p>I went straight to a thirty-six key board and lasted four days. Wish I had read this first, because starting small is obviously the right call and I would have kept going.</p>
      </li>
      <li class="comment">
        <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.commenterTwo}" alt="Priya Raman" width="96" height="96">
        <p>Seconding the tenting advice. It made more difference to my wrists in a week than switching layouts did in a year of daily practice at the keyboard.</p>
      </li>
    </ul>
    <form action="/comments" method="post">
      <label for="comment-body">Leave a comment</label>
      <textarea id="comment-body" name="body"></textarea>
      <button type="submit">Post</button>
    </form>
  </section>`;
}

/** Media the reader model permanently excludes, each keeping only its caption. */
function interactiveMediaHtml(): string {
  return `
    <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.vectorChart}" alt="Typing speed over the first eight weeks" width="900" height="500">
    <svg viewBox="0 0 900 500" width="900" height="500" onload="fetch('https://evil.example/beacon')">
      <title>Typing speed over the first eight weeks</title>
      <rect width="900" height="500"></rect>
    </svg>
    <figure>
      <video src="${CDN}/split-keyboards/demo.mp4" controls poster="${KEYBOARD_EXCLUDED_IMAGE_URLS.videoPoster}"></video>
      <figcaption>${escapeHtml(KEYBOARD_CAPTIONS.video)}</figcaption>
    </figure>
    <figure>
      <iframe src="https://example.com/embeds/layout-editor" title="Layout editor" width="800" height="600"></iframe>
      <figcaption>${escapeHtml(KEYBOARD_CAPTIONS.interactive)}</figcaption>
    </figure>
    <canvas id="typing-heatmap" width="900" height="400" aria-label="Typing heatmap"></canvas>`;
}

type KeyboardFixtureOptions = {
  /** Drops the hero banner, leaving the article with no image above its body. */
  readonly withoutBanner?: boolean;
  /**
   * Puts the hero in a `<header>` of the article's own, the shape a site header
   * has to be told apart from.
   */
  readonly bannerInArticleHeader?: boolean;
};

export function keyboardArticleHtml(options: KeyboardFixtureOptions = {}): string {
  const bannerContents = `
      <img src="${KEYBOARD_DROPPED_IMAGE_URLS.banner}" alt="${escapeHtml(KEYBOARD_ALT_TEXT.banner)}" width="1600" height="900">
      <p class="caption">${escapeHtml(KEYBOARD_CAPTIONS.banner)}</p>`;
  const banner =
    options.withoutBanner === true
      ? ''
      : options.bannerInArticleHeader === true
        ? `
    <header class="post-header">${bannerContents}
    </header>`
        : `
    <div class="post-banner">${bannerContents}
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(KEYBOARD_TITLE)} | ${KEYBOARD_SITE_NAME}</title>
  <link rel="icon" href="${KEYBOARD_EXCLUDED_IMAGE_URLS.favicon}">
  <meta name="author" content="${KEYBOARD_AUTHOR}">
  <meta property="og:site_name" content="${KEYBOARD_SITE_NAME}">
  <meta property="og:title" content="${escapeHtml(KEYBOARD_TITLE)}">
</head>
<body>
  <header class="site-header">
    <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.siteBrandPhoto}" alt="The workshop bench where every board on this site was built" width="1400" height="360">
    <nav aria-label="Site">
      <a href="/"><img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.siteLogo}" alt="${KEYBOARD_SITE_NAME}" width="120" height="32"></a>
      <a href="/posts">Posts</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <article class="post">
      <h1>${escapeHtml(KEYBOARD_TITLE)}</h1>
      <p class="byline">By ${KEYBOARD_AUTHOR}</p>
      ${banner}
      <p>${PARAGRAPHS[0] ?? ''}</p>
      <h2>Start with the least ambitious board</h2>
      <p>${PARAGRAPHS[1] ?? ''}</p>
      ${linkedFigure(
        KEYBOARD_DROPPED_IMAGE_URLS.ultimateHacking,
        KEYBOARD_ALT_TEXT.ultimateHacking,
        KEYBOARD_CAPTIONS.ultimateHacking,
        'https://shop.example.com/uhk'
      )}
      <p>${PARAGRAPHS[2] ?? ''}</p>
      <h2>Then raise it</h2>
      <p>${PARAGRAPHS[3] ?? ''}</p>
      ${plainFigure(
        KEYBOARD_DROPPED_IMAGE_URLS.tenting,
        KEYBOARD_ALT_TEXT.tenting,
        KEYBOARD_CAPTIONS.tenting
      )}
      ${linkedFigure(
        KEYBOARD_DROPPED_IMAGE_URLS.charybdis,
        KEYBOARD_ALT_TEXT.charybdis,
        KEYBOARD_CAPTIONS.charybdis,
        'https://shop.example.com/charybdis'
      )}
      <h2>Wireless, and the dongle question</h2>
      <p>${PARAGRAPHS[4] ?? ''}</p>
      ${lazyFigure(
        KEYBOARD_DROPPED_IMAGE_URLS.dongle,
        KEYBOARD_ALT_TEXT.dongle,
        KEYBOARD_CAPTIONS.dongle
      )}
      <h2>Layouts, briefly</h2>
      <p>${PARAGRAPHS[5] ?? ''}</p>
      ${responsiveFigure()}
      ${interactiveMediaHtml()}
      <h2>Where to buy</h2>
      <section class="buy">
        ${linkedFigure(
          KEYBOARD_DROPPED_IMAGE_URLS.shop,
          KEYBOARD_ALT_TEXT.shop,
          KEYBOARD_CAPTIONS.shop,
          'https://shop.example.com/beekeeb'
        )}
        <p><a href="https://shop.example.com/beekeeb">Beekeeb</a>, <a href="https://shop.example.com/uhk">UHK</a>, <a href="https://shop.example.com/charybdis">Bastard Keyboards</a>.</p>
      </section>
      <p>${CLOSING_PARAGRAPH}</p>
      <img src="${KEYBOARD_EXCLUDED_IMAGE_URLS.trackingPixel}" alt="" width="1" height="1">
    </article>
    ${furnitureHtml()}
  </main>
  <footer>
    <p>© 2026 ${KEYBOARD_SITE_NAME}.</p>
  </footer>
</body>
</html>`;
}

/** The seven editorial images a complete capture archives, in document order. */
export const KEYBOARD_EDITORIAL_IMAGE_ORDER: readonly string[] = [
  KEYBOARD_DROPPED_IMAGE_URLS.banner,
  KEYBOARD_DROPPED_IMAGE_URLS.ultimateHacking,
  KEYBOARD_DROPPED_IMAGE_URLS.tenting,
  KEYBOARD_DROPPED_IMAGE_URLS.charybdis,
  KEYBOARD_DROPPED_IMAGE_URLS.dongle,
  KEYBOARD_DROPPED_IMAGE_URLS.layoutComparison,
  KEYBOARD_DROPPED_IMAGE_URLS.shop,
];
