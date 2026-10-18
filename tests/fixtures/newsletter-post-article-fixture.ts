/**
 * A stand-in for a long technical post published on a hosted newsletter
 * platform.
 *
 * It is written from scratch — invented prose, invented hosts, invented product
 * names — and no test contacts the page that inspired it. What is reproduced is
 * that page's *shape*, which is the shape that cost the motivating capture its
 * entire structure:
 *
 * - the post element itself is classed `newsletter-post`, a name the image
 *   furniture list reads as "newsletter signup box";
 * - every in-article heading carries an anchor class containing the word
 *   `header`, which Readability's unlikely-candidate list reads as "site
 *   masthead", and wraps a copy-link `<button>` holding an `<svg>` beside the
 *   visible heading text;
 * - every editorial figure is a `<picture>` with a `<source>` and an `<img>`,
 *   nested inside a link inside a `<figure>` inside a captioned wrapper;
 * - the image URLs are CDN transformation paths whose commas sit *inside* the
 *   URL, so a `srcset` split on every comma yields a fragment that resolves
 *   against the article's own host rather than the CDN.
 *
 * Around them the fixture carries the things that must stay lost: the site
 * logo in the masthead, and a "more from this author" teaser card whose
 * generated class name says nothing but whose link wraps a headline.
 */

const CDN = 'https://cdn.example-stack.com/image/fetch';
const ORIGIN = 'https%3A%2F%2Fmedia.example-stack.com%2Fpublic%2Fimages';

export const NEWSLETTER_ARTICLE_URL =
  'https://www.example-stack.com/p/an-advanced-system-architecture-breakdown';
const NEWSLETTER_SITE_NAME = 'Example Stack';
export const NEWSLETTER_TITLE = 'An advanced system architecture breakdown';
const NEWSLETTER_AUTHOR = 'Rowan Diaz';

/**
 * One rendition of a figure, in the CDN's own path grammar.
 *
 * The commas are the point: they belong to the transformation list and not to
 * the `srcset` that lists these renditions.
 */
function rendition(slug: string, width: number, format: 'auto' | 'webp'): string {
  return `${CDN}/$s_!${slug.slice(0, 4).toUpperCase()}!,w_${String(width)},c_limit,f_${format},q_auto:good,fl_progressive:steep/${ORIGIN}%2F${slug}.png`;
}

/** The widest `f_auto` rendition of each figure: what a capture must archive. */
export const NEWSLETTER_FIGURE_URLS = {
  timeline: rendition('milestone-timeline', 1456, 'auto'),
  roofline: rendition('memory-roofline', 1456, 'auto'),
  latency: rendition('latency-breakdown', 1456, 'auto'),
} as const;

/** The editorial figures in the order the page presents them. */
export const NEWSLETTER_FIGURE_ORDER = [
  NEWSLETTER_FIGURE_URLS.timeline,
  NEWSLETTER_FIGURE_URLS.roofline,
  NEWSLETTER_FIGURE_URLS.latency,
] as const;

/** Narrow renditions that must lose to the widest one of the same figure. */
export const NEWSLETTER_NARROW_URLS = [
  rendition('milestone-timeline', 424, 'webp'),
  rendition('memory-roofline', 424, 'webp'),
  rendition('latency-breakdown', 424, 'webp'),
] as const;

/** Everything the capture must never request, whatever else changes. */
export const NEWSLETTER_EXCLUDED_IMAGE_URLS = {
  /** The publication's mark, in the masthead above everything. */
  siteLogo: `${CDN}/$s_!ZK4Z!,w_80,h_80,c_fill,f_auto/${ORIGIN}%2Fpublication-logo.png`,
  /** Cover thumbnail of a teaser card linking to a different post. */
  teaserThumbnail: `${CDN}/$s_!KZJ6!,w_140,h_140,c_fill,f_auto/${ORIGIN}%2Fearlier-post-cover.png`,
} as const;

/** The headings the post publishes, with the level each one must keep. */
export const NEWSLETTER_HEADINGS = [
  { level: 1, text: 'Part 1: System specification and constraints' },
  { level: 2, text: 'The Pareto frontier of system-level tradeoffs' },
  { level: 2, text: 'Architectural observations' },
  { level: 4, text: 'Latency of model requests' },
] as const;

/** The headline on the teaser card, which is not one of the post's headings. */
export const NEWSLETTER_TEASER_HEADLINE = 'An earlier deep dive into interconnect topologies';

/**
 * A masthead heading outside the post element, carrying the same anchor-style
 * class the post's own headings use. It is site chrome and must stay out.
 */
export const NEWSLETTER_CHROME_HEADLINE = 'Subscribe to the invented newsletter';

export const NEWSLETTER_CAPTIONS = [
  'Source: invented figure for an invented conference talk.',
  'Roofline estimates assume the invented memory system described above.',
  'Latency contributions, measured on the invented reference platform.',
] as const;

export const NEWSLETTER_ALT_TEXT = {
  timeline: 'A timeline of architectural milestones across two years.',
  roofline: 'A roofline chart plotting arithmetic intensity against throughput.',
  latency: 'A stacked bar chart of latency contributions per request stage.',
} as const;

/**
 * A section heading in the platform's own markup.
 *
 * The visible words sit in a coloured `<span>`; beside them the platform parks
 * an anchor target and a copy-link `<button>` wrapping an `<svg>`. The purge
 * list removes the button and the vector, and the heading has to come through
 * as a heading of this level carrying exactly these words.
 */
function heading(level: number, text: string, slug: string): string {
  const tag = `h${String(level)}`;
  return [
    `<${tag} class="header-anchor-post">`,
    `<span data-color="#3a30e2" style="color:rgb(58, 48, 226);">${text}</span>`,
    '<div class="pencraft pc-display-flex pc-position-absolute pc-reset header-anchor-parent">',
    '<div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">',
    `<div id="§${slug}" class="pencraft pc-reset header-anchor offset-top"></div>`,
    `<button tabindex="0" type="button" aria-label="Link" data-href="${NEWSLETTER_ARTICLE_URL}#${slug}" class="pencraft iconButton-mq_Et5">`,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Copy link</title><path d="M9 5h6v14H9z"></path></svg>',
    '</button></div></div>',
    `</${tag}>`,
  ].join('');
}

/** An editorial figure in the platform's own markup. */
function figure(slug: string, alt: string, caption: string): string {
  const wide = rendition(slug, 1456, 'auto');
  const narrow = rendition(slug, 424, 'webp');
  const srcset = `${narrow} 424w, ${rendition(slug, 848, 'webp')} 848w, ${rendition(slug, 1456, 'webp')} 1456w`;
  return [
    '<div class="captioned-image-container"><figure>',
    `<a target="_blank" href="${wide}" data-component-name="Image2ToDOM" class="image-link image2 can-restack">`,
    '<div class="image2-inset"><picture>',
    `<source type="image/webp" srcset="${srcset}" sizes="100vw"/>`,
    `<img src="${rendition(slug, 728, 'auto')}" srcset="${srcset.replace(/f_webp/g, 'f_auto')}, ${wide} 2048w" width="1247" height="640" alt="${alt}"/>`,
    '</picture></div></a>',
    `<figcaption class="image-caption">${caption}</figcaption>`,
    '</figure></div>',
  ].join('');
}

const PARAGRAPHS = [
  'Of all the architectures presented at the invented conference this year, the one described below is the only one whose designers published the constraints they started from, which is what makes it worth reading closely rather than skimming.',
  'Architecting custom silicon means navigating tightly coupled tradeoffs, and the team chose to begin from what the end user could perceive rather than from what the process node could deliver, which inverts the usual order of the argument.',
  'The theoretical memory roofline sits well above the token throughput any single user observes, and the gap between those two numbers is where most of the interesting engineering in this design actually lives.',
  'Latency contributions were measured per request stage rather than per kernel, so the chart below attributes stalls to the interconnect and to operand arrival rather than to the compute units that were waiting on them.',
];

export type NewsletterFixtureOptions = {
  /** Drops the teaser card, for tests about the article body alone. */
  readonly withoutTeaser?: boolean;
};

const TEASER = [
  '<div data-component-name="DigestPostEmbed" class="digestPostEmbed-flwiST">',
  '<a href="https://www.example-stack.com/p/interconnect-topologies" rel="noopener" target="_blank">',
  '<div class="pencraft pc-display-flex pc-gap-16 pc-reset">',
  '<div style="width:70px;height:70px;" class="pencraft pc-reset"><picture>',
  `<img src="${NEWSLETTER_EXCLUDED_IMAGE_URLS.teaserThumbnail}" width="140" height="140" alt="${NEWSLETTER_TEASER_HEADLINE}" class="img-OACg1c pencraft pc-reset"/>`,
  '</picture></div>',
  `<div class="pencraft pc-reset"><h4 class="pencraft pc-reset size-20-P_cSRT">${NEWSLETTER_TEASER_HEADLINE}</h4>`,
  '<div class="pencraft pc-reset meta-EgzBVA">Rowan Diaz · Aug 14</div></div>',
  '</div></a></div>',
].join('');

/** The fixture page, as the platform would serve it. */
export function newsletterArticleHtml(options: NewsletterFixtureOptions = {}): string {
  const body = [
    heading(1, NEWSLETTER_HEADINGS[0].text, 'part-1-system-specification-and-constraints'),
    `<p>${PARAGRAPHS[0] ?? ''}</p>`,
    figure('milestone-timeline', NEWSLETTER_ALT_TEXT.timeline, NEWSLETTER_CAPTIONS[0]),
    heading(2, NEWSLETTER_HEADINGS[1].text, 'the-pareto-frontier-of-system-level-tradeoffs'),
    `<p>${PARAGRAPHS[1] ?? ''}</p>`,
    heading(2, NEWSLETTER_HEADINGS[2].text, 'architectural-observations'),
    `<p>${PARAGRAPHS[2] ?? ''}</p>`,
    figure('memory-roofline', NEWSLETTER_ALT_TEXT.roofline, NEWSLETTER_CAPTIONS[1]),
    options.withoutTeaser === true ? '' : TEASER,
    heading(4, NEWSLETTER_HEADINGS[3].text, 'latency-of-model-requests'),
    `<p>${PARAGRAPHS[3] ?? ''}</p>`,
    figure('latency-breakdown', NEWSLETTER_ALT_TEXT.latency, NEWSLETTER_CAPTIONS[2]),
  ].join('');

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${NEWSLETTER_TITLE}</title>`,
    `<meta property="og:site_name" content="${NEWSLETTER_SITE_NAME}">`,
    `<meta name="author" content="${NEWSLETTER_AUTHOR}">`,
    '</head><body><div class="container"><div class="single-post">',
    '<div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">',
    '<div class="topbar-Z4pZwU"><div class="logoContainer-p12gJb"><a class="pencraft pc-display-contents pc-reset" href="/">',
    `<picture><img src="${NEWSLETTER_EXCLUDED_IMAGE_URLS.siteLogo}" width="80" height="80" alt="${NEWSLETTER_SITE_NAME}"/></picture>`,
    '</a></div>',
    `<h2 class="header-anchor-post">${NEWSLETTER_CHROME_HEADLINE}</h2>`,
    '<p>Get every invented post in your inbox.</p></div>',
    '<article class="typography newsletter-post post">',
    `<h1 class="post-title published">${NEWSLETTER_TITLE}</h1>`,
    '<div class="dt-post-body"><div class="available-content"><div dir="auto" class="body markup">',
    body,
    '</div></div></div></article>',
    '</div></div></div></body></html>',
  ].join('');
}
