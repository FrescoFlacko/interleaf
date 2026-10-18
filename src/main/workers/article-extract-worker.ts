import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  MAX_ARTICLE_BLOCKS,
  MAX_ARTICLE_BYLINE_LENGTH,
  MAX_ARTICLE_IMAGE_ALT_LENGTH,
  MAX_ARTICLE_IMAGE_CANDIDATES,
  MAX_ARTICLE_IMAGES,
  MAX_ARTICLE_INLINES_PER_BLOCK,
  MAX_ARTICLE_INLINES_PER_CELL,
  MAX_ARTICLE_LIST_ITEMS,
  MAX_ARTICLE_SITE_NAME_LENGTH,
  MAX_ARTICLE_TABLE_CELLS,
  MAX_ARTICLE_TABLE_COLUMNS,
  MAX_ARTICLE_TABLE_ROWS,
  MAX_ARTICLE_TABLES,
  MAX_ARTICLE_TEXT_LENGTH,
  MAX_ARTICLE_TITLE_LENGTH,
  type ExtractedArticle,
} from '../library/article-content';
import type { PortableValue } from '@shared/models/portable';
import { messageToArticle, MIN_ARTICLE_TEXT_LENGTH } from './article-extract-result';
import { ARTICLE_IMAGE_ADMISSION_SOURCE } from './article-image-admission';

/**
 * Reader-style article extraction for untrusted HTML.
 *
 * Hostile markup is never parsed on the main thread. Each page is handed to a
 * short-lived worker that owns a non-executing `linkedom` DOM: there is no
 * script runtime, no network, no timer that outlives the job, and no filesystem
 * use, so nothing in the page can run. The worker replies with the inert block
 * IR in `article-content.ts` — never HTML, never a node — and that reply is
 * schema-checked here before any other code sees it.
 *
 * Work is bounded three ways: a hard element budget rejects documents that
 * would make scoring expensive, text and block budgets bound the reply size,
 * and a parent-side timeout terminates a worker that stops making progress for
 * any reason. Concurrency is capped and the waiter queue is bounded, so
 * repeated imports cannot accumulate workers or pending closures.
 *
 * Cancellation reaches both halves. A job aborted while still queued leaves the
 * queue without ever taking a slot, and a job aborted while extracting has its
 * worker terminated, so nothing keeps running on the user's behalf after they
 * stop waiting for it.
 */

const MAX_WORKERS = 2;
const MAX_QUEUE = 8;
const EXTRACT_TIMEOUT_MS = 15_000;
const MAX_ELEMENT_COUNT = 60_000;
const MAX_HTML_LENGTH = 12 * 1024 * 1024;
/** Bounds on one `srcset` attribute, which is attacker-controlled free text. */
const MAX_SRCSET_ENTRIES = 24;
const MAX_SRCSET_LENGTH = 8192;

type WorkerModulePaths = { readonly linkedom: string; readonly readability: string };

/**
 * Resolved on first use rather than at import time.
 *
 * Resolution reads the installed dependency tree, and doing that while the
 * module graph loads would turn a packaging problem into a main-process crash
 * at startup instead of a typed failure on the one import that needs it.
 */
let workerModulePaths: WorkerModulePaths | null = null;

function resolveWorkerModulePaths(): WorkerModulePaths {
  if (workerModulePaths === null) {
    const requireFromHere = createRequire(__filename);
    try {
      workerModulePaths = {
        linkedom: requireFromHere.resolve('linkedom'),
        readability: requireFromHere.resolve('@mozilla/readability'),
      };
    } catch (cause) {
      throw new InterleafError('internal', 'Article extraction is unavailable.', { cause: cause instanceof Error ? cause : null });
    }
  }
  return workerModulePaths;
}

type AdmissionWaiter = { readonly id: symbol; readonly grant: () => void };

let activeWorkers = 0;
const waiters: AdmissionWaiter[] = [];
/** Every worker this module has started and not yet seen exit. */
const liveWorkers = new Set<Worker>();

export type ArticleExtractOptions = {
  /** Test seam: shorten the timeout so timeout handling can be exercised. */
  readonly timeoutMs?: number;
  /** Test seam: force the worker to fail so failure handling can be exercised. */
  readonly testWorkerFailure?: boolean;
  /**
   * Test seam: keep the worker alive and idle instead of replying, so
   * cancellation and timeout can be shown to actually tear a worker down.
   */
  readonly testWorkerHang?: boolean;
  /** Abandons the job, whether it is still queued or already extracting. */
  readonly signal?: AbortSignal;
};

/**
 * Admission and worker bookkeeping, for tests that assert nothing outlives a
 * cancelled import. Production code has no reason to read this.
 */
export function articleExtractorState(): {
  readonly active: number;
  readonly queued: number;
  readonly workers: number;
} {
  return { active: activeWorkers, queued: waiters.length, workers: liveWorkers.size };
}

function cancelledError(): InterleafError {
  return new InterleafError('validation', 'That import was cancelled.');
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { parseHTML } = require(workerData.linkedomModulePath);
const { Readability } = require(workerData.readabilityModulePath);
const limits = workerData.limits;

if (workerData.testWorkerFailure === true) {
  throw new Error('forced article worker failure');
}
// Elements that can execute, load a remote resource, submit data, or embed a
// separate document. They are detached with their subtrees before anything is
// read, so no branch below can reach them.
//
// img and picture are absent because images are handled by
// normalizeImages, which runs first and replaces every one of them with a
// freshly created element carrying nothing but a validated absolute URL and its
// alt text. By the time this list is applied there is no original image node
// left, so the remaining entries — including source, svg, and canvas —
// still remove everything vector, active, or remotely loadable.
var REMOVE_SELECTOR = [
  'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
  'fieldset', 'legend', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track',
  'template', 'link', 'base', 'meta', 'dialog', 'menu', 'slot', 'portal', 'map', 'area',
  'picture', 'object', 'param', 'marquee', 'blink', 'title'
].join(',');

// Page furniture that is never article body text.
var CHROME_SELECTOR = [
  'nav', 'aside', 'footer',
  '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
  '[role="contentinfo"]', '[role="search"]', '[role="alert"]', '[role="dialog"]'
].join(',');

var HIDDEN_STYLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(;|$)|font-size\s*:\s*0)/i;
var OFFSCREEN_STYLE = /(left|top|text-indent)\s*:\s*-\s*[0-9]{3,}/i;
var POSITIVE_NAME = /article|body|content|entry|hentry|main|page|post|story|text|blog|column/i;
var NEGATIVE_NAME = /combx|comment|contact|foot|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|banner|newsletter|subscribe|paywall|popup|modal|cookie|consent|breadcrumb|pagination|byline|caption-credit|social|advert|^ad$|ad-|-ad|adsense|doubleclick/i;
var BLOCK_TAGS = {
  ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DD: 1, DETAILS: 1, DIV: 1, DL: 1,
  DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1,
  H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HR: 1, IMG: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1,
  P: 1, PRE: 1, SECTION: 1, TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1,
  TR: 1, UL: 1
};
var HEADING_TAGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };

// Lazy-loading attributes that carry a single image URL, in the order they are
// consulted. They come first because a deferred image usually parks a
// placeholder in src and keeps the real asset in a data attribute.
var IMAGE_SRC_ATTRIBUTES = [
  'data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src', 'data-image-src'
];
var IMAGE_SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'data-lazy-srcset'];
// URL shapes that are page furniture rather than article illustration.
var IMAGE_NOISE = /(^|[\/._-])(favicon|sprite|spacer|pixel|blank|beacon|tracking|analytics|logo|avatar|icon|badge|emoji|placeholder|advert|doubleclick)([\/._-]|$)/i;
// Containers whose pictures are not this article's illustrations, consulted
// only when reconciling images Readability discarded. Readability's own scoring
// already keeps these regions out of the body it returns, so restoring images
// from the surrounding document has to reapply the same judgement by hand or it
// would hand the reader a comment thread's avatars and a promo strip's
// thumbnails. Names only, never the raster itself: an editorial figure inside
// an ordinary content wrapper is untouched.
var FURNITURE_CONTAINER = /(^|[\s_-])(comments?|commentlist|discussion|disqus|respond|reply|trackback|pingback|related|recommend(ed|ations)?|more-?from|read-?next|share|sharing|social|follow|sidebar|widget|promo|sponsor|advert|ads?|newsletter|subscribe|signup|paywall|popup|modal|cookie|consent|breadcrumbs?|pagination|pager|masthead|colophon|author-?bio|avatar|gravatar|profile-?pic|toolbar|menu)([\s_-]|$)/i;
// Ancestors that are page furniture by tag alone. <header> is included: a site
// header is masthead chrome, and its brand photograph is not this article's
// illustration no matter what the file happens to be called. The article's own
// hero banner, which also routinely sits in a <header>, is preserved by the
// article-root exception in hasFurnitureAncestor rather than by admitting every
// header on the page.
var FURNITURE_TAGS = { NAV: 1, ASIDE: 1, FOOTER: 1, FORM: 1, HEADER: 1 };
// How far up from a reconciled image furniture is looked for. Deep enough to
// clear a comment thread's own nesting, bounded so a pathological tree cannot
// make this walk expensive.
var FURNITURE_ANCESTOR_DEPTH = 12;
// Vector and animated-vector sources, which the archive deliberately refuses.
var VECTOR_IMAGE = /\.(svgz?)($|[?#])/i;

function fail(reason) {
  var error = new Error(reason);
  error.interleafReason = reason;
  throw error;
}

function clean(value, max) {
  if (typeof value !== 'string') return null;
  var normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, max);
}

function metaContent(document, selector) {
  var node = document.querySelector(selector);
  if (node === null) return null;
  return clean(node.getAttribute('content'), 1024);
}

/**
 * Reads a document's own <base href>.
 *
 * Relative URLs on the page are resolved against this rather than the response
 * URL when the page declares one, matching how a browser would read the same
 * markup. It is captured before <base> is purged, and it only ever feeds URL
 * resolution: a hostile value can at worst produce a candidate URL, which still
 * has to survive the same scheme check, the SSRF policy, and the media bounds
 * before anything is fetched.
 */
function readBaseUrl(document) {
  var node = document.querySelector('base[href]');
  if (node === null) return null;
  var raw = node.getAttribute('href');
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  var resolved;
  try {
    resolved = new URL(raw.trim(), workerData.baseUrl);
  } catch (error) {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  resolved.username = '';
  resolved.password = '';
  var text = resolved.toString();
  return text.length > 2048 ? null : text;
}

/**
 * The page's declared social-card image, kept only as a hero fallback.
 *
 * Pages that draw their hero on a <canvas> leave nothing static in the body,
 * and the canvas itself is purged; the Open Graph raster is the one static
 * stand-in such a page publishes. It is subject to every later check, and
 * declared vector sources are refused here as well.
 */
function readHeroImage(document, metadata) {
  var raw = metaContent(document, 'meta[property="og:image"]')
    || metaContent(document, 'meta[property="og:image:url"]')
    || metaContent(document, 'meta[name="twitter:image"]');
  if (raw === null) return null;
  var src = safeHref(raw);
  if (src === null || VECTOR_IMAGE.test(src)) return null;
  var alt = metaContent(document, 'meta[property="og:image:alt"]')
    || metaContent(document, 'meta[name="twitter:image:alt"]')
    || metadata.title;
  return { src: src, alt: alt === null ? '' : alt.slice(0, limits.maxImageAlt) };
}

function readMetadata(document) {
  var title = metaContent(document, 'meta[property="og:title"]')
    || metaContent(document, 'meta[name="twitter:title"]')
    || clean(document.title, limits.maxTitle);
  var siteName = metaContent(document, 'meta[property="og:site_name"]');
  var byline = metaContent(document, 'meta[name="author"]')
    || metaContent(document, 'meta[property="article:author"]')
    || metaContent(document, 'meta[name="byl"]');
  if (byline === null) {
    var relAuthor = document.querySelector('[rel="author"]');
    if (relAuthor !== null) byline = clean(relAuthor.textContent, limits.maxByline);
  }
  return {
    title: title === null ? null : title.slice(0, limits.maxTitle),
    byline: byline === null ? null : byline.slice(0, limits.maxByline),
    siteName: siteName === null ? null : siteName.slice(0, limits.maxSiteName)
  };
}

function isHiddenElement(element) {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  var style = element.getAttribute('style');
  if (typeof style === 'string' && style.length > 0) {
    if (HIDDEN_STYLE.test(style)) return true;
    if (OFFSCREEN_STYLE.test(style)) return true;
  }
  return false;
}

function removeAll(document, selector) {
  var nodes = document.querySelectorAll(selector);
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (node.parentNode !== null) node.remove();
  }
}

function removeHidden(document) {
  var nodes = document.querySelectorAll('[hidden],[aria-hidden],[style]');
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (node.parentNode !== null && isHiddenElement(node)) node.remove();
  }
}

// The final response URL, replaced by the page's own <base href> when it
// declares a usable one. Set once, before anything resolves a URL.
var resolutionBaseUrl = workerData.baseUrl;

function safeHref(rawHref) {
  if (typeof rawHref !== 'string') return null;
  var trimmed = rawHref.trim();
  if (trimmed.length === 0) return null;
  var resolved;
  try {
    resolved = new URL(trimmed, resolutionBaseUrl);
  } catch (error) {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  resolved.username = '';
  resolved.password = '';
  var text = resolved.toString();
  return text.length > 2048 ? null : text;
}

/**
 * Picks the widest entry from a srcset.
 *
 * Parsing is bounded by both string length and entry count, and selection is
 * purely by declared width so the same markup always yields the same URL —
 * which matters because the chosen URL ends up in content-hashed snapshot
 * bytes. Entries without a width descriptor score zero, so the last such entry
 * wins only when nothing declares a width at all.
 *
 * Candidates are split the way the HTML grammar does — a URL runs to the next
 * whitespace and only what follows it is descriptor text ended by a comma —
 * rather than on every comma. Image CDNs put transformation parameters such as
 * "w_1456,c_limit,f_auto" inside the path, and splitting those apart yields a
 * fragment that resolves against the page instead of the CDN: a different
 * origin, and not an image at all.
 */
function pickFromSrcset(value) {
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limits.maxSrcsetLength) return null;
  var best = null;
  var bestWidth = -1;
  var position = 0;
  var entries = 0;
  while (position < trimmed.length && entries < limits.maxSrcsetEntries) {
    while (position < trimmed.length && /[\s,]/.test(trimmed.charAt(position))) position += 1;
    if (position >= trimmed.length) break;
    var urlStart = position;
    while (position < trimmed.length && !/\s/.test(trimmed.charAt(position))) position += 1;
    var candidate = trimmed.slice(urlStart, position);
    var descriptor = '';
    // A URL that ends in commas carries no descriptor; those commas separate it
    // from the next candidate.
    if (/,$/.test(candidate)) {
      candidate = candidate.replace(/,+$/, '');
    } else {
      var descriptorStart = position;
      while (position < trimmed.length && trimmed.charAt(position) !== ',') position += 1;
      descriptor = trimmed.slice(descriptorStart, position);
    }
    if (candidate.length === 0) continue;
    entries += 1;
    var width = 0;
    var tokens = descriptor.trim().split(/\s+/);
    for (var token = 0; token < tokens.length; token += 1) {
      var match = /^([0-9]{1,6})w$/.exec(tokens[token]);
      if (match !== null) width = Number(match[1]);
    }
    if (width >= bestWidth) {
      bestWidth = width;
      best = candidate;
    }
  }
  return best;
}

/**
 * The one URL an image element is worth archiving, or null.
 *
 * Lazy attributes are consulted first, then srcset, then src. srcset outranks
 * src because a responsive image puts its smallest rendition in src as the
 * fallback for old clients and its real editorial asset in the srcset list, so
 * reading src first would archive a thumbnail of the picture the article meant
 * to show. A page that offers only src still falls through to it.
 */
function imageUrlFrom(element) {
  for (var index = 0; index < IMAGE_SRC_ATTRIBUTES.length; index += 1) {
    var direct = safeHref(element.getAttribute(IMAGE_SRC_ATTRIBUTES[index]));
    if (direct !== null) return direct;
  }
  for (var set = 0; set < IMAGE_SRCSET_ATTRIBUTES.length; set += 1) {
    var picked = pickFromSrcset(element.getAttribute(IMAGE_SRCSET_ATTRIBUTES[set]));
    if (picked === null) continue;
    var resolvedSet = safeHref(picked);
    if (resolvedSet !== null) return resolvedSet;
  }
  return safeHref(element.getAttribute('src'));
}

${ARTICLE_IMAGE_ADMISSION_SOURCE}

function hasPictureAncestor(element) {
  var node = element.parentNode;
  for (var depth = 0; depth < 4 && node !== null && node !== undefined; depth += 1) {
    if (node.tagName === 'PICTURE') return true;
    node = node.parentNode;
  }
  return false;
}

function closestFigure(element) {
  var node = element.parentNode;
  for (var depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
    if (node.tagName === 'FIGURE') return node;
    node = node.parentNode;
  }
  return null;
}

// A class token a page uses to mark the line that describes a nearby image.
var CAPTION_CLASS = /(^|[\s_-])(caption|figcaption|image-(caption|description))([\s_-]|$)/i;
// Elements that can carry a caption. A caption is a short line of prose, so a
// list, a table, or a section is not one no matter what it is named.
var CAPTION_TAGS = { P: 1, DIV: 1, SPAN: 1, SMALL: 1, EM: 1, I: 1 };
// A caption is a line, not a passage. Longer text is somebody else's paragraph
// that happens to sit beside an image, and borrowing it would describe the
// image with unrelated body copy.
var MAX_CAPTION_SOURCE_LENGTH = 600;
// How far above the image a caption wrapper may sit, how many element children
// that wrapper may hold before it stops being an image-with-caption, and how
// many siblings are examined. All three keep the search local and bounded.
var CAPTION_ANCESTOR_DEPTH = 2;
var CAPTION_WRAPPER_CHILDREN = 4;
var CAPTION_SIBLING_SCAN = 3;
// Containers that end the upward search: past one of these a "caption" is a
// page-level element, not this image's description.
var CAPTION_STOP_TAGS = { BODY: 1, HTML: 1, MAIN: 1, ARTICLE: 1, SECTION: 1 };

function isCaptionElement(node) {
  if (node.tagName === 'FIGCAPTION') return true;
  if (CAPTION_TAGS[node.tagName] !== 1) return false;
  var className = node.getAttribute('class');
  return typeof className === 'string' && CAPTION_CLASS.test(className);
}

/** The caption's text, normalized and truncated, or '' if it is not one. */
function captionTextOf(node) {
  // A wrapper holding another image is a gallery row, not a description.
  if (node.querySelector('img') !== null) return '';
  var raw = node.textContent;
  if (typeof raw !== 'string' || raw.length > MAX_CAPTION_SOURCE_LENGTH) return '';
  return clean(raw, limits.maxImageAlt) || '';
}

/**
 * The caption a page placed next to a node, searching siblings only.
 *
 * The forward scan stops at the next image, because a caption past that one
 * describes it rather than this one.
 */
function captionBeside(node) {
  var forward = node.nextElementSibling;
  for (var index = 0; index < CAPTION_SIBLING_SCAN && forward !== null && forward !== undefined; index += 1) {
    if (forward.tagName === 'IMG' || forward.tagName === 'PICTURE' || forward.tagName === 'FIGURE') break;
    if (isCaptionElement(forward)) {
      var text = captionTextOf(forward);
      if (text !== '') return text;
    }
    forward = forward.nextElementSibling;
  }
  var back = node.previousElementSibling;
  if (back !== null && back !== undefined && isCaptionElement(back)) return captionTextOf(back);
  return '';
}

/**
 * The description a page gave an image without writing alt text.
 *
 * Many editorial sites caption images with a marked-up sibling — a
 * <figcaption>, or a p.caption inside a small wrapper — and leave alt empty
 * even though the image is the point of the paragraph. Reading that caption
 * recovers those images instead of discarding a whole article's illustrations.
 *
 * The search is deliberately narrow: it looks at a handful of siblings, climbs
 * at most two ancestors and only through wrappers small enough to be an
 * image-with-caption, requires a caption-named element, and takes text only up
 * to a caption-sized bound. It yields plain text that is stored as alt, so
 * nothing about the page's markup survives. Images the page marked as
 * decorative, as tracking pixels, or as chrome are rejected before this runs
 * and stay rejected: a caption promotes an alt-less image, it never overrides
 * a refusal.
 */
function nearbyCaptionText(element) {
  var node = element;
  for (var depth = 0; depth <= CAPTION_ANCESTOR_DEPTH; depth += 1) {
    var text = captionBeside(node);
    if (text !== '') return text;
    var parent = node.parentNode;
    if (parent === null || parent === undefined || parent.nodeType !== 1) return '';
    if (CAPTION_STOP_TAGS[parent.tagName] === 1) return '';
    var children = parent.children;
    if (children === undefined || children.length > CAPTION_WRAPPER_CHILDREN) return '';
    node = parent;
  }
  return '';
}


function imageAltText(element) {
  return clean(element.getAttribute('alt'), limits.maxImageAlt)
    || clean(element.getAttribute('aria-label'), limits.maxImageAlt)
    || clean(element.getAttribute('title'), limits.maxImageAlt)
    || nearbyCaptionText(element)
    || '';
}

/**
 * Replaces every image on the page with a freshly created inert element.
 *
 * This runs before the purge list and before Readability so that images keep
 * their position in the article, and it is a replacement rather than an edit:
 * the new node is built from scratch and given exactly two attributes, so no
 * event handler, lazy-loading hook, usemap, referrer policy, or unknown
 * attribute from the original markup survives. Anything that fails selection
 * is detached outright, and a <picture> collapses to the single raster its
 * own <img> fallback or <source> list names.
 */
/**
 * Drops the class and id a page hung on its section headings.
 *
 * Readability decides what is article body partly by name, and its list of
 * names that mean "not content" includes the word header — written for site
 * mastheads. A publisher that labels every in-article heading with an anchor
 * class such as "header-anchor-post" therefore has each of its real section
 * headings deleted before scoring begins, and the article comes out as one
 * undifferentiated run of paragraphs. On the article this was built for that
 * cost all thirty-five headings.
 *
 * A heading element is not a region, so its own name carries no structural
 * meaning worth keeping: Readability is asked to discard classes anyway, and
 * the block walk reads the tag and its text. Removing the name only stops it
 * from being mistaken for chrome.
 *
 * Scoped to the root the page itself nominates as its article — <article>, or
 * <main> — and to nothing when the page nominates neither. Headings in site
 * chrome, comment threads, and teaser cards keep the names that let Readability
 * rule them out, so this cannot make unrelated headings likelier to be adopted
 * as body text; it only stops genuine in-article headings from being deleted
 * before scoring begins.
 */
function neutralizeHeadingNames(root) {
  if (root === null || typeof root.querySelectorAll !== 'function') return;
  var nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (var index = 0; index < nodes.length; index += 1) {
    nodes[index].removeAttribute('class');
    nodes[index].removeAttribute('id');
  }
}

function normalizeImages(document) {
  var nodes = document.querySelectorAll('img,picture');
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (node.parentNode === null) continue;
    // The enclosing <picture> already accounted for this one.
    if (node.tagName === 'IMG' && hasPictureAncestor(node)) continue;
    var origin = node;
    if (node.tagName === 'PICTURE') {
      var inner = node.querySelector('img');
      origin = inner === null ? node : inner;
    }
    var src = imageUrlFrom(origin);
    if (src === null && node.tagName === 'PICTURE') {
      var sources = node.querySelectorAll('source');
      for (var s = 0; s < sources.length && src === null; s += 1) {
        if (sources[s].getAttribute('type') === 'image/svg+xml') continue;
        src = imageUrlFrom(sources[s]);
      }
    }
    if (src === null || !isUsefulImage(origin, src)) {
      node.remove();
      continue;
    }
    var replacement = document.createElement('img');
    replacement.setAttribute('src', src);
    replacement.setAttribute('alt', imageAltText(origin));
    node.parentNode.replaceChild(replacement, node);
  }
}

/**
 * Reconciling the images Readability threw away.
 *
 * Readability scores prose. An editorial figure that sits in its own wrapper, is
 * wrapped in a link, defers its real source to a data attribute, or lives in a
 * short trailing section scores as page furniture and is discarded before the
 * block walk ever sees it — on the article this was built for, seven captioned
 * figures and the hero disappeared that way while the surrounding paragraphs
 * survived. Readability has no setting that keeps them.
 *
 * So the images are taken from the document *as it was already sanitized*,
 * before Readability was allowed to mutate it, and the ones its output does not
 * contain are put back. Every one of them has already been through
 * normalizeImages: it is a freshly built element carrying a validated absolute
 * http/https URL and plain alt text, and everything vector, active, remotely
 * loadable, hidden, or chrome has already been detached from the tree. Nothing
 * new is admitted here — this only declines to lose what selection already
 * approved. What it does add is a second refusal, hasFurnitureAncestor, because
 * Readability's scoring was also what kept comment avatars and promo
 * thumbnails out of the body, and that judgement has to be reapplied by name
 * once the body is no longer the only source.
 *
 * Placement is by remembered neighbouring text rather than by node identity,
 * since the surviving blocks are a different tree from the one the image came
 * from. Each image keeps the normalized opening of the text immediately before
 * and after it; whichever of those two the emitted blocks still contain decides
 * where it lands. Insertion is monotone in document order, so restored images
 * can never be reordered among themselves or moved above one that Readability
 * kept.
 */

// Elements whose text can position a restored image, plus the images
// themselves, matched together so one query yields document order.
var ANCHOR_SELECTOR = 'img,p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,pre,dd,dt,summary,td,th';
// How much of a neighbour's text identifies it. Long enough that two different
// paragraphs do not collide, short enough that inline markup Readability
// rewrites on the way out does not change the key.
var ANCHOR_KEY_LENGTH = 60;
// Raw text read before normalizing, so a long <pre> costs a bounded slice.
var ANCHOR_SOURCE_LENGTH = 4096;

function anchorKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  var text = raw.length > ANCHOR_SOURCE_LENGTH ? raw.slice(0, ANCHOR_SOURCE_LENGTH) : raw;
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, ANCHOR_KEY_LENGTH);
}

function runText(run) {
  var text = '';
  for (var index = 0; index < run.length; index += 1) text += run[index].text;
  return text;
}

/** The text a block is recognized by, or '' for one that carries none. */
function blockAnchorKey(block) {
  if (block.type === 'code') return anchorKey(block.text);
  if (block.type === 'image' || block.type === 'rule' || block.type === 'table') return '';
  if (block.type === 'list') {
    var joined = '';
    for (var item = 0; item < block.items.length && joined.length < ANCHOR_KEY_LENGTH; item += 1) {
      joined += runText(block.items[item]) + ' ';
    }
    return anchorKey(joined);
  }
  return anchorKey(runText(block.inline));
}

/**
 * The <article> or <main> the page nominated as its own content, or null.
 *
 * Set once per extraction, before anything consults it. It exists so a <header>
 * can be told apart from *the* header: one inside this element is the article's
 * own banner, and one outside it is the site's masthead.
 */
var articleContentRoot = null;

/** True when a node is the given root or sits inside it, without DOM helpers. */
function isWithin(node, root) {
  if (root === null || root === undefined) return false;
  var current = node;
  for (var depth = 0; depth <= FURNITURE_ANCESTOR_DEPTH; depth += 1) {
    if (current === null || current === undefined) return false;
    if (current === root) return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * True when an image links away to another article instead of illustrating this
 * one.
 *
 * A teaser card is a link that carries both a thumbnail and the headline of the
 * page it points at. Publishers build these out of generated class names that
 * say nothing, so the name list cannot recognize them, but the shape is
 * unambiguous: an editorial figure's own link wraps the picture and nothing
 * else, never a heading.
 */
function isTeaserCardImage(element) {
  var node = element.parentNode;
  for (var depth = 0; depth < FURNITURE_ANCESTOR_DEPTH; depth += 1) {
    if (node === null || node === undefined || node.nodeType !== 1) return false;
    if (node === articleContentRoot) return false;
    if (node.tagName === 'A' && node.querySelector('h1,h2,h3,h4,h5,h6') !== null) return true;
    node = node.parentNode;
  }
  return false;
}

/**
 * True when an image sits inside a region of the page that is not this article.
 *
 * Names and landmark roles only. A raster is never judged by what it depicts,
 * and an editorial figure inside an ordinary content wrapper is untouched.
 *
 * The walk stops at the element the page nominated as its article, because past
 * that point the names describe the page rather than the figure's surroundings:
 * a post published as class "newsletter-post" is not a newsletter signup box,
 * and reading it as one discards every figure the article contains.
 */
function hasFurnitureAncestor(element) {
  if (isTeaserCardImage(element)) return true;
  var node = element.parentNode;
  for (var depth = 0; depth < FURNITURE_ANCESTOR_DEPTH; depth += 1) {
    if (node === null || node === undefined || node.nodeType !== 1) return false;
    if (node === articleContentRoot) return false;
    // A header belonging to the article the page nominated is the one header
    // whose picture can be editorial; every other one is site chrome. The name
    // and role checks below still apply to it.
    var headerIsArticleOwn = node.tagName === 'HEADER' && isWithin(node, articleContentRoot);
    if (FURNITURE_TAGS[node.tagName] === 1 && !headerIsArticleOwn) return true;
    var role = node.getAttribute('role');
    if (role === 'navigation' || role === 'complementary' || role === 'contentinfo' || role === 'banner') {
      return true;
    }
    var className = node.getAttribute('class');
    var identifier = node.getAttribute('id');
    var names = (typeof className === 'string' ? className : '') + ' ' + (typeof identifier === 'string' ? identifier : '');
    if (FURNITURE_CONTAINER.test(names)) return true;
    node = node.parentNode;
  }
  return false;
}

/** The caption a page wrote for an image, from its figure or a named sibling. */
function figureCaptionOf(element) {
  var figure = closestFigure(element);
  if (figure !== null) {
    var figcaption = figure.querySelector('figcaption');
    if (figcaption !== null) {
      var text = captionTextOf(figcaption);
      if (text !== '') return text;
    }
  }
  return nearbyCaptionText(element);
}

/**
 * Every article image the sanitized document holds, in document order, with the
 * text on each side of it and its caption.
 *
 * Called before Readability runs, because Readability mutates the document it
 * is given and there would be nothing left to compare against afterwards.
 */
function imageInventory(document, budget) {
  var nodes = document.querySelectorAll(ANCHOR_SELECTOR);
  var stream = [];
  var seen = {};
  var occurrences = {};
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (node.tagName !== 'IMG') {
      var key = anchorKey(node.textContent);
      if (key === '') continue;
      // Which time this exact line has been seen. A page that repeats a
      // paragraph offers several equal keys, and the ordinal is the only thing
      // that tells the third one from the first.
      var count = occurrences['k' + key];
      count = typeof count === 'number' && count < limits.maxBlocks ? count + 1 : 1;
      occurrences['k' + key] = count;
      stream.push({ entry: null, key: key, ordinal: count });
      continue;
    }
    var src = node.getAttribute('src');
    if (typeof src !== 'string' || src.length === 0) continue;
    if (seen[' ' + src] === 1) continue;
    if (hasFurnitureAncestor(node)) continue;
    // Past the recognition ceiling nothing further is inspected, so nothing
    // beyond it is silently dropped either: what the article recognized is
    // exactly what it can account for.
    if (!recognizeImage(budget, src)) break;
    seen[' ' + src] = 1;
    var alt = node.getAttribute('alt');
    stream.push({
      entry: {
        src: src,
        alt: typeof alt === 'string' ? alt.slice(0, limits.maxImageAlt) : '',
        caption: figureCaptionOf(node),
        before: '',
        beforeOrdinal: 0,
        after: '',
        afterOrdinal: 0
      },
      key: '',
      ordinal: 0
    });
  }

  var inventory = [];
  var previous = null;
  for (var forward = 0; forward < stream.length; forward += 1) {
    if (stream[forward].entry === null) {
      previous = stream[forward];
      continue;
    }
    if (previous !== null) {
      stream[forward].entry.before = previous.key;
      stream[forward].entry.beforeOrdinal = previous.ordinal;
    }
    inventory.push(stream[forward].entry);
  }
  var next = null;
  for (var back = stream.length - 1; back >= 0; back -= 1) {
    if (stream[back].entry === null) {
      next = stream[back];
      continue;
    }
    if (next !== null) {
      stream[back].entry.after = next.key;
      stream[back].entry.afterOrdinal = next.ordinal;
    }
  }
  return inventory;
}

/**
 * The surviving occurrence of an anchor a restored image sat next to.
 *
 * An anchor key is a 60-character prefix, so a page that repeats a line — "Step
 * one." three times, or two paragraphs that open identically — offers several
 * equal keys. Matching on text alone picks one by array position rather than by
 * the occurrence this image actually followed, which is how a figure that came
 * after the third paragraph lands after the second. The inventory recorded
 * which occurrence it was, and the survivors of one key are a subsequence of
 * the occurrences of that key, so the wanted anchor is the last survivor whose
 * own occurrence has not passed the recorded one. Searching forwards from the
 * last placement keeps the whole pass monotone in document order.
 *
 * Returns -1 when the key is absent or nothing survived at or after the start.
 */
function anchorOccurrenceIndex(placed, key, ordinal, from) {
  if (key === '') return -1;
  var best = -1;
  var first = -1;
  for (var index = from; index < placed.length; index += 1) {
    if (placed[index].key !== key) continue;
    if (first < 0) first = index;
    if (placed[index].ordinal === 0) continue;
    if (placed[index].ordinal > ordinal) break;
    best = index;
  }
  // No ordinal was usable — an anchor restored during this pass, or a page
  // repeating one line more times than the block ceiling counts. The first
  // survivor at or after the last placement is still deterministic.
  return best >= 0 ? best : first;
}

/**
 * Where a restored image belongs, never before anything already placed.
 *
 * Both neighbours are looked for forwards from the last placement, never across
 * the whole article, and each is matched against the occurrence the page
 * actually put next to this image.
 */
function insertionIndex(placed, entry, minIndex) {
  var beforeAt = anchorOccurrenceIndex(placed, entry.before, entry.beforeOrdinal, minIndex);
  var afterFrom = beforeAt < 0 ? minIndex : beforeAt + 1;
  var afterAt = anchorOccurrenceIndex(placed, entry.after, entry.afterOrdinal, afterFrom);
  if (afterAt >= 0) return afterAt;
  if (beforeAt >= 0) return beforeAt + 1;
  // Neither neighbour survived — both were themselves scored away. Falling to
  // the end of the article would strand the figure below the closing
  // paragraph and, worse, drag every later restored image down with it, since
  // placement never moves backwards. Directly after whatever was placed last
  // keeps the restored figures in the order the page presented them.
  var fallback = minIndex;
  // Nothing at all preceded it on the page: a hero. It belongs at the top, but
  // below the article's own title, which the renderer deduplicates against the
  // front matter and would stop recognizing if an image were pushed above it.
  if (entry.before === '') {
    while (fallback < placed.length && placed[fallback].block.type === 'heading') fallback += 1;
  }
  return fallback;
}

/**
 * Admits one eligible image as a candidate this article recognizes.
 *
 * Every recognition point goes through here, so the ceiling is on the article
 * rather than on any single pass, and the answer is what tells a caller to stop
 * looking rather than to drop a picture quietly. Addresses are held only to
 * recognize the same picture twice and never leave the worker.
 *
 * Returns false once the article has recognized as many candidates as it is
 * allowed to; a candidate already recognized is always true.
 */
function recognizeImage(budget, src) {
  if (budget.candidateImages['s' + src] === 1) return true;
  if (budget.candidates >= limits.maxImageCandidates) return false;
  budget.candidateImages['s' + src] = 1;
  budget.candidates += 1;
  return true;
}

/**
 * Records one recognized image the extraction ceilings refused to keep.
 *
 * What leaves this worker is a single number, so a reader can be told the
 * snapshot is short of the page without anything downstream gaining a list of
 * addresses it might try to fetch. A picture already emitted into the article
 * is not a shortfall — counting it would put one candidate on both sides of the
 * partition — and the clamp is unreachable by construction, since a candidate
 * is only ever counted here after recognition admitted it under the same
 * ceiling.
 */
function noteImageOmitted(budget, src) {
  if (typeof src !== 'string' || src.length === 0) return;
  if (budget.emittedImages['s' + src] === 1) return;
  if (budget.omittedImages['s' + src] === 1) return;
  budget.omittedImages['s' + src] = 1;
  if (budget.imagesOmitted < limits.maxImageCandidates) budget.imagesOmitted += 1;
}

/** True when the article can still afford one more block of this size. */
function canAfford(budget, textLength) {
  return budget.blocks + 1 <= limits.maxBlocks && budget.text + textLength <= limits.maxText;
}

/**
 * Puts back the inventory images Readability's output does not contain.
 *
 * Returns the reconciled block list. Restored images are charged to the same
 * budgets as any other block and stop at the same image, block, and text
 * ceilings; running out of budget ends the pass rather than failing the
 * article, since a partly illustrated article is still the article.
 */
function reconcileDroppedImages(blocks, inventory, budget) {
  if (inventory.length === 0) return blocks;
  var placed = [];
  var known = {};
  var occurrences = {};
  for (var index = 0; index < blocks.length; index += 1) {
    var key = blockAnchorKey(blocks[index]);
    var ordinal = 0;
    if (key !== '') {
      var seenBefore = occurrences['k' + key];
      ordinal = typeof seenBefore === 'number' && seenBefore < limits.maxBlocks ? seenBefore + 1 : 1;
      occurrences['k' + key] = ordinal;
      known['k' + key] = 1;
    }
    placed.push({ block: blocks[index], key: key, ordinal: ordinal });
    if (blocks[index].type === 'image') known['s' + blocks[index].src] = 1;
  }

  var minIndex = 0;
  for (var item = 0; item < inventory.length; item += 1) {
    var entry = inventory[item];
    if (known['s' + entry.src] === 1) {
      for (var at = minIndex; at < placed.length; at += 1) {
        if (placed[at].block.type === 'image' && placed[at].block.src === entry.src) {
          minIndex = at + 1;
          break;
        }
      }
      continue;
    }
    if (budget.images >= limits.maxImages || !canAfford(budget, entry.alt.length)) {
      // The ceiling ends the pass, but not the accounting: every figure still
      // waiting is one this article would otherwise have kept.
      for (var rest = item; rest < inventory.length; rest += 1) {
        if (known['s' + inventory[rest].src] !== 1) noteImageOmitted(budget, inventory[rest].src);
      }
      break;
    }

    var target = insertionIndex(placed, entry, minIndex);
    var added = [{ block: { type: 'image', src: entry.src, alt: entry.alt }, key: '', ordinal: 0 }];
    budget.spendBlock();
    budget.spendText(entry.alt.length);
    budget.images += 1;
    budget.emittedImages['s' + entry.src] = 1;
    known['s' + entry.src] = 1;

    // The figure's caption travels with it, unless Readability already kept
    // that line, in which case restoring it would say the same thing twice.
    var captionKey = anchorKey(entry.caption);
    if (captionKey !== '' && known['k' + captionKey] !== 1 && canAfford(budget, entry.caption.length)) {
      added.push({
        block: { type: 'caption', inline: [{ text: entry.caption, style: 'plain' }] },
        key: captionKey,
        ordinal: 0
      });
      budget.spendBlock();
      budget.spendText(entry.caption.length);
      known['k' + captionKey] = 1;
    }

    placed.splice.apply(placed, [target, 0].concat(added));
    minIndex = target + added.length;
  }

  var result = [];
  for (var out = 0; out < placed.length; out += 1) result.push(placed[out].block);
  return result;
}

function Budget() {
  this.text = 0;
  this.blocks = 0;
  this.images = 0;
  this.tables = 0;
  // Image accounting, all of it by address and all of it worker-only. Every
  // eligible image the article recognizes is registered once; each one then
  // ends up either emitted into the article or counted as a shortfall, so the
  // two sets partition the candidates exactly.
  this.candidates = 0;
  this.candidateImages = {};
  this.emittedImages = {};
  this.imagesOmitted = 0;
  this.omittedImages = {};
  // Per-run inline ceiling, and the reason raised when a run reaches it. A
  // table cell borrows the scratch budget to impose its own lower ceiling
  // under a reason its caller can recognize; null means the ordinary
  // document-wide limit applies.
  this.inlineCap = null;
  this.inlineReason = 'too-complex';
}

Budget.prototype.spendText = function (length) {
  this.text += length;
  if (this.text > limits.maxText) fail('too-large');
};

Budget.prototype.spendBlock = function () {
  this.blocks += 1;
  if (this.blocks > limits.maxBlocks) fail('too-large');
};

function pushInline(run, inline, budget) {
  if (inline.text.length === 0) return;
  var cap = budget.inlineCap === null ? limits.maxInlines : budget.inlineCap;
  if (run.length >= cap) fail(budget.inlineReason);
  budget.spendText(inline.text.length);
  var previous = run.length > 0 ? run[run.length - 1] : null;
  if (previous !== null && previous.style === inline.style && previous.href === inline.href) {
    run[run.length - 1] = { text: previous.text + inline.text, style: previous.style, href: previous.href };
    return;
  }
  run.push(inline);
}

function styleFor(tag, current) {
  if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'DFN' || tag === 'VAR') return 'emphasis';
  if (tag === 'STRONG' || tag === 'B') return 'strong';
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') return 'code';
  return current;
}

function collectInlines(node, run, style, href, budget) {
  var children = node.childNodes;
  for (var index = 0; index < children.length; index += 1) {
    var child = children[index];
    if (child.nodeType === 3) {
      pushInline(run, buildInline(String(child.textContent || '').replace(/\s+/g, ' '), style, href), budget);
      continue;
    }
    if (child.nodeType !== 1) continue;
    collectInlineElement(child, run, style, href, budget);
  }
}

// Handles the element itself before descending, so a link encountered directly
// inside a container keeps its href instead of collapsing to bare text.
function collectInlineElement(element, run, style, href, budget) {
  var tag = element.tagName;
  if (tag === 'BR') {
    pushInline(run, buildInline(' ', style, href), budget);
    return;
  }
  if (tag === 'A') {
    var ownHref = href === undefined ? safeHref(element.getAttribute('href')) : href;
    collectInlines(element, run, style, ownHref === null ? undefined : ownHref, budget);
    return;
  }
  collectInlines(element, run, styleFor(tag, style), href, budget);
}

function buildInline(text, style, href) {
  var inline = { text: text, style: style };
  if (href !== undefined && href !== null) inline.href = href;
  return inline;
}

function inlineRun(element, budget) {
  var run = [];
  collectInlines(element, run, 'plain', undefined, budget);
  return trimRun(run);
}

/**
 * Builds one table cell's inline run, or returns null when the cell carries
 * more inline pieces than a table cell is allowed to hold.
 *
 * The ceiling has to be applied while the run is being built rather than to
 * the finished run: the document-wide inline limit is ten times the per-cell
 * one, so a single over-decorated cell would otherwise either be accepted by
 * the check that comes too late or, if it also ran past the document limit,
 * fail the whole article. Neither is right for one cell in one table, so the
 * cell reports itself under its own reason and the table takes the paragraph
 * fallback.
 */
function cellRun(element, scratch) {
  scratch.inlineCap = limits.maxCellInlines;
  scratch.inlineReason = 'cell-too-complex';
  try {
    return inlineRun(element, scratch);
  } catch (error) {
    if (error !== null && error !== undefined && error.interleafReason === 'cell-too-complex') {
      return null;
    }
    throw error;
  } finally {
    scratch.inlineCap = null;
    scratch.inlineReason = 'too-complex';
  }
}

function trimRun(run) {
  var trimmed = [];
  for (var index = 0; index < run.length; index += 1) {
    var item = run[index];
    var text = item.text;
    if (index === 0) text = text.replace(/^\s+/, '');
    if (index === run.length - 1) text = text.replace(/\s+$/, '');
    if (text.length === 0) continue;
    trimmed.push(buildInline(text, item.style, item.href));
  }
  return trimmed;
}

function emitRun(blocks, type, run, budget, extra) {
  if (run.length === 0) return;
  budget.spendBlock();
  var block = { type: type, inline: run };
  if (extra !== undefined) block.level = extra;
  blocks.push(block);
}

function emitList(blocks, element, budget) {
  var items = [];
  var children = element.children;
  for (var index = 0; index < children.length; index += 1) {
    if (items.length >= limits.maxListItems) fail('too-complex');
    var child = children[index];
    if (child.tagName !== 'LI') continue;
    var run = inlineRun(child, budget);
    if (run.length > 0) items.push(run);
  }
  if (items.length === 0) return;
  budget.spendBlock();
  blocks.push({ type: 'list', ordered: element.tagName === 'OL', items: items });
}

function textOf(element) {
  var text = element.textContent;
  return typeof text === 'string' ? text : '';
}

function emitCode(blocks, element, budget) {
  var text = textOf(element).replace(/\r\n/g, '\n').trim();
  if (text.length === 0) return;
  budget.spendText(text.length);
  budget.spendBlock();
  blocks.push({ type: 'code', text: text });
}

function emitImage(blocks, element, budget) {
  var src = element.getAttribute('src');
  if (typeof src !== 'string' || src.length === 0) return;
  // Beyond the recognition ceiling the article stops seeing images at all,
  // here as in the inventory, so nothing is dropped without being counted.
  if (!recognizeImage(budget, src)) return;
  if (budget.images >= limits.maxImages) {
    noteImageOmitted(budget, src);
    return;
  }
  var alt = imageAltText(element);
  budget.spendText(alt.length);
  budget.spendBlock();
  budget.images += 1;
  budget.emittedImages['s' + src] = 1;
  blocks.push({ type: 'image', src: src, alt: alt });
}

/**
 * Emits the images inside a run-level element.
 *
 * Readability wraps a bare image in a paragraph, so by the time the walker
 * reaches an image that a page put in its own captioned wrapper, the image is a
 * descendant of a block whose branch reads text only. Without this the whole
 * ordinary captioned-image shape would be dropped while its caption survived.
 */
function emitImagesWithin(element, blocks, budget) {
  var images = element.querySelectorAll('img');
  for (var index = 0; index < images.length; index += 1) {
    emitImage(blocks, images[index], budget);
  }
}

/** Direct TD/TH children of a row, in source order. */
function rowCells(row) {
  var cells = [];
  var children = row.children;
  for (var index = 0; index < children.length; index += 1) {
    var tag = children[index].tagName;
    if (tag === 'TD' || tag === 'TH') cells.push(children[index]);
  }
  return cells;
}

/**
 * True when a cell spans more than one row or column.
 *
 * Spanning cells cannot be placed in a pipe table without inventing content or
 * moving text into a column it does not belong to, so their presence sends the
 * whole table down the paragraph fallback instead.
 */
function hasSpan(cell) {
  var attributes = ['rowspan', 'colspan'];
  for (var index = 0; index < attributes.length; index += 1) {
    var raw = cell.getAttribute(attributes[index]);
    if (typeof raw !== 'string') continue;
    var trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (Number(trimmed) !== 1) return true;
  }
  return false;
}

function allCellsAre(cells, tag) {
  if (cells.length === 0) return false;
  for (var index = 0; index < cells.length; index += 1) {
    if (cells[index].tagName !== tag) return false;
  }
  return true;
}

/**
 * True when every non-empty cell in the row is entirely strongly emphasized.
 *
 * Pages that style a header row with <strong> instead of <th> are common
 * enough — the benchmark tables this feature was built for do exactly that —
 * that losing the header would misrepresent the data. Requiring *every*
 * text-bearing cell to be fully strong keeps an ordinary data row whose first
 * cell happens to be bold from being promoted by mistake.
 */
function isStrongRow(runs) {
  var sawText = false;
  for (var index = 0; index < runs.length; index += 1) {
    var run = runs[index];
    for (var part = 0; part < run.length; part += 1) {
      if (run[part].text.trim().length === 0) continue;
      if (run[part].style !== 'strong') return false;
      sawText = true;
    }
  }
  return sawText;
}

function paddedRow(cells, columns) {
  var row = [];
  for (var index = 0; index < columns; index += 1) {
    row.push(index < cells.length ? cells[index] : []);
  }
  return row;
}

/**
 * Emits a <table> as a rectangular IR table, or falls back to the plain
 * paragraph walk.
 *
 * The fallback is the pre-existing behaviour: every cell becomes its own
 * paragraph. It is verbose, but it never reorders or merges text, so a table
 * shape this code cannot represent faithfully degrades to something readable
 * rather than to something wrong. It is taken for nested tables, spanning
 * cells, and any table over the row, column, cell, or per-cell inline budget.
 *
 * Cell runs are built against a scratch budget first so that a table that ends
 * up falling back has not already charged its text to the document budget
 * twice.
 */
function emitTable(blocks, element, budget, depth) {
  // Lifted out ahead of the table so it survives either path exactly once.
  var caption = element.querySelector('caption');
  if (caption !== null) {
    emitRun(blocks, 'caption', inlineRun(caption, budget), budget);
    caption.remove();
  }

  var rows = element.querySelectorAll('tr');
  var nested = element.querySelector('table') !== null;
  if (nested || rows.length === 0 || rows.length > limits.maxTableRows || budget.tables >= limits.maxTables) {
    walkChildren(element, blocks, budget, depth + 1);
    return;
  }

  var scratch = new Budget();
  var grid = [];
  var columns = 0;
  for (var index = 0; index < rows.length; index += 1) {
    var cells = rowCells(rows[index]);
    var runs = [];
    for (var cell = 0; cell < cells.length; cell += 1) {
      if (hasSpan(cells[cell])) {
        walkChildren(element, blocks, budget, depth + 1);
        return;
      }
      var run = cellRun(cells[cell], scratch);
      if (run === null) {
        walkChildren(element, blocks, budget, depth + 1);
        return;
      }
      runs.push(run);
    }
    if (runs.length > columns) columns = runs.length;
    grid.push({ runs: runs, header: allCellsAre(cells, 'TH') || isHeaderSection(rows[index]) });
  }

  // A single-column table is page layout, not data, and has no pipe-table
  // spelling the reader's parser recognizes.
  if (columns < 2 || columns > limits.maxTableColumns || grid.length * columns > limits.maxTableCells) {
    walkChildren(element, blocks, budget, depth + 1);
    return;
  }

  var first = grid[0];
  var headerFirst = first.header || isStrongRow(first.runs);
  var header = headerFirst ? paddedRow(first.runs, columns) : paddedRow([], columns);
  var body = [];
  for (var row = headerFirst ? 1 : 0; row < grid.length; row += 1) {
    body.push(paddedRow(grid[row].runs, columns));
  }
  if (body.length === 0 && !headerFirst) {
    walkChildren(element, blocks, budget, depth + 1);
    return;
  }

  budget.spendText(scratch.text);
  budget.spendBlock();
  budget.tables += 1;
  blocks.push({ type: 'table', header: header, rows: body });
}

function isHeaderSection(row) {
  var parent = row.parentNode;
  return parent !== null && parent !== undefined && parent.tagName === 'THEAD';
}

function isBlockElement(element) {
  return BLOCK_TAGS[element.tagName] === 1;
}

function emitElement(element, blocks, budget, depth) {
  if (depth > 32) fail('too-complex');
  var tag = element.tagName;
  if (HEADING_TAGS[tag] === 1) {
    emitRun(blocks, 'heading', inlineRun(element, budget), budget, Number(tag.slice(1)));
    return;
  }
  if (tag === 'P' || tag === 'DT' || tag === 'DD' || tag === 'SUMMARY') {
    // An image-only paragraph is an illustration; a paragraph that also has
    // text keeps its text first and its images after it.
    emitRun(blocks, 'paragraph', inlineRun(element, budget), budget);
    emitImagesWithin(element, blocks, budget);
    return;
  }
  if (tag === 'BLOCKQUOTE') {
    emitRun(blocks, 'quote', inlineRun(element, budget), budget);
    return;
  }
  if (tag === 'FIGCAPTION') {
    emitRun(blocks, 'caption', inlineRun(element, budget), budget);
    return;
  }
  if (tag === 'UL' || tag === 'OL') {
    emitList(blocks, element, budget);
    return;
  }
  if (tag === 'PRE') {
    emitCode(blocks, element, budget);
    return;
  }
  if (tag === 'HR') {
    budget.spendBlock();
    blocks.push({ type: 'rule' });
    return;
  }
  if (tag === 'IMG') {
    emitImage(blocks, element, budget);
    return;
  }
  if (tag === 'TABLE') {
    emitTable(blocks, element, budget, depth);
    return;
  }
  walkChildren(element, blocks, budget, depth + 1);
}

// Mixed containers are walked child by child so free text between block
// elements becomes its own paragraph instead of being dropped or merged.
function walkChildren(element, blocks, budget, depth) {
  var pending = [];
  var children = element.childNodes;
  for (var index = 0; index < children.length; index += 1) {
    var child = children[index];
    if (child.nodeType === 3) {
      pushInline(pending, buildInline(String(child.textContent || '').replace(/\s+/g, ' '), 'plain', undefined), budget);
      continue;
    }
    if (child.nodeType !== 1) continue;
    if (isBlockElement(child)) {
      emitRun(blocks, 'paragraph', trimRun(pending), budget);
      pending = [];
      emitElement(child, blocks, budget, depth + 1);
      continue;
    }
    collectInlineElement(child, pending, 'plain', undefined, budget);
  }
  emitRun(blocks, 'paragraph', trimRun(pending), budget);
}

function extract(html) {
  if (html.length > limits.maxHtml) fail('too-large');
  var parsed = parseHTML(html);
  var document = parsed.document;
  if (document === null || document === undefined || document.body === null) fail('no-article');

  var declaredBase = readBaseUrl(document);
  if (declaredBase !== null) resolutionBaseUrl = declaredBase;

  var metadata = readMetadata(document);
  var heroImage = readHeroImage(document, metadata);
  articleContentRoot = document.querySelector('article') || document.querySelector('main');
  // Images are rewritten into inert placeholders before the purge list runs, so
  // they keep their position in the article body while nothing from the
  // original image markup survives.
  normalizeImages(document);
  removeAll(document, REMOVE_SELECTOR);
  removeHidden(document);

  var elementCount = document.querySelectorAll('*').length;
  if (elementCount > limits.maxElements) fail('too-large');

  removeAll(document, CHROME_SELECTOR);

  // Taken now, while the sanitized document is still intact: Readability
  // mutates the document it is handed, so this is the last point at which the
  // article's own images can be seen alongside the text around them.
  var budget = new Budget();
  var inventory = imageInventory(document, budget);

  neutralizeHeadingNames(articleContentRoot);

  // Run Mozilla Readability heuristics on the sanitized non-executing DOM
  var readabilityParsed = null;
  try {
    var reader = new Readability(document, {
      charThreshold: limits.minTextLength,
      keepClasses: false,
    });
    readabilityParsed = reader.parse();
  } catch (err) {
    readabilityParsed = null;
  }

  var container = null;
  if (readabilityParsed !== null && readabilityParsed.content) {
    if (readabilityParsed.title) {
      metadata.title = clean(readabilityParsed.title, limits.maxTitle) || metadata.title;
    }
    if (readabilityParsed.byline) {
      metadata.byline = clean(readabilityParsed.byline, limits.maxByline) || metadata.byline;
    }
    if (readabilityParsed.siteName) {
      metadata.siteName = clean(readabilityParsed.siteName, limits.maxSiteName) || metadata.siteName;
    }
    var contentParsed = parseHTML(readabilityParsed.content);
    container = contentParsed.document.getElementById('readability-page-1') || contentParsed.document.body;
  } else {
    container = document.querySelector('article') || document.querySelector('main') || document.body;
  }

  if (container === null || container === undefined) fail('no-article');

  var blocks = [];
  walkChildren(container, blocks, budget, 0);
  blocks = reconcileDroppedImages(blocks, inventory, budget);

  var textLength = 0;
  for (var index = 0; index < blocks.length; index += 1) {
    var block = blocks[index];
    if (block.type === 'code') {
      textLength += block.text.length;
    } else if (block.type === 'list') {
      for (var item = 0; item < block.items.length; item += 1) {
        textLength += runLength(block.items[item]);
      }
    } else if (block.type === 'table') {
      textLength += rowLength(block.header);
      for (var row = 0; row < block.rows.length; row += 1) {
        textLength += rowLength(block.rows[row]);
      }
    } else if (block.type !== 'rule' && block.type !== 'image') {
      // Alt text is deliberately excluded: a page of pictures is not an article.
      textLength += runLength(block.inline);
    }
  }

  if (textLength < limits.minTextLength) fail('no-article');

  var result = {
    title: metadata.title,
    byline: metadata.byline,
    siteName: metadata.siteName,
    blocks: blocks,
    textLength: textLength
  };
  if (heroImage !== null) result.heroImage = heroImage;
  if (budget.imagesOmitted > 0) result.imagesOmitted = budget.imagesOmitted;
  return result;
}

function rowLength(row) {
  var total = 0;
  for (var index = 0; index < row.length; index += 1) total += runLength(row[index]);
  return total;
}
function runLength(run) {
  var total = 0;
  for (var index = 0; index < run.length; index += 1) total += run[index].text.length;
  return total;
}

if (workerData.testWorkerHang === true) {
  // Stays alive and idle, replying to nothing, so only the parent terminating
  // this worker can end it.
  setInterval(function () {}, 3600000);
} else {
  try {
    parentPort.postMessage({ ok: true, article: extract(String(workerData.html)) });
  } catch (error) {
    var reason = error && error.interleafReason ? error.interleafReason : 'failed';
    parentPort.postMessage({ ok: false, reason: reason });
  }
}
`;

/**
 * Takes one of the fixed extraction slots, waiting in a bounded queue if they
 * are all busy.
 *
 * A waiter that aborts removes itself from the queue and never takes a slot, so
 * a cancelled job cannot start after the fact and cannot hold the queue against
 * the jobs behind it.
 */
async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw cancelledError();
  }
  if (activeWorkers < MAX_WORKERS) {
    activeWorkers += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUE) {
    throw new InterleafError(
      'validation',
      'Interleaf is already importing as many pages as it can handle. Try again in a moment.'
    );
  }
  await new Promise<void>((resolve, reject) => {
    const id = Symbol('article-extract-waiter');

    const onAbort = (): void => {
      const index = waiters.findIndex((waiter) => waiter.id === id);
      // Already granted a slot; the extraction itself observes the signal.
      if (index === -1) return;
      waiters.splice(index, 1);
      reject(cancelledError());
    };

    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    waiters.push({ id, grant });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Hands the slot to the next waiter, or gives it back to the pool.
 *
 * The slot is transferred rather than freed and re-taken, so a release can
 * never let concurrency drift above `MAX_WORKERS`.
 */
function release(): void {
  const next = waiters.shift();
  if (next) {
    next.grant();
  } else {
    activeWorkers -= 1;
  }
}

/**
 * Runs one extraction in an isolated worker and returns the validated IR.
 *
 * `baseUrl` is used only to resolve relative links to absolute `http`/`https`
 * URLs inside the worker; it is never used to open anything.
 */
export async function extractArticleInWorker(
  html: string,
  baseUrl: string,
  options: ArticleExtractOptions = {}
): Promise<ExtractedArticle> {
  await acquire(options.signal);
  try {
    const message = await runWorker(html, baseUrl, options);
    return messageToArticle(message);
  } finally {
    release();
  }
}

/**
 * The effective wall-clock budget for one extraction.
 *
 * A caller may shorten the budget but never extend it, so a smaller remaining
 * deadline upstream tightens this bound while a missing, absurd, or hostile
 * value falls back to the module's own ceiling instead of loosening it.
 */
export function extractionTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return EXTRACT_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(requested), EXTRACT_TIMEOUT_MS));
}

function runWorker(
  html: string,
  baseUrl: string,
  options: ArticleExtractOptions
): Promise<PortableValue> {
  const modulePaths = resolveWorkerModulePaths();
  const signal = options.signal;
  return new Promise<PortableValue>((resolve, reject) => {
    // Checked again here because the slot handoff in `release` can grant
    // admission in the same turn an abort arrives.
    if (signal?.aborted === true) {
      reject(cancelledError());
      return;
    }

    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        html,
        baseUrl,
        linkedomModulePath: modulePaths.linkedom,
        readabilityModulePath: modulePaths.readability,
        testWorkerFailure: options.testWorkerFailure === true,
        testWorkerHang: options.testWorkerHang === true,
        limits: {
          minTextLength: MIN_ARTICLE_TEXT_LENGTH,
          maxHtml: MAX_HTML_LENGTH,
          maxElements: MAX_ELEMENT_COUNT,
          maxBlocks: MAX_ARTICLE_BLOCKS,
          maxInlines: MAX_ARTICLE_INLINES_PER_BLOCK,
          maxListItems: MAX_ARTICLE_LIST_ITEMS,
          maxText: MAX_ARTICLE_TEXT_LENGTH,
          maxTitle: MAX_ARTICLE_TITLE_LENGTH,
          maxByline: MAX_ARTICLE_BYLINE_LENGTH,
          maxSiteName: MAX_ARTICLE_SITE_NAME_LENGTH,
          maxTables: MAX_ARTICLE_TABLES,
          maxTableRows: MAX_ARTICLE_TABLE_ROWS,
          maxTableColumns: MAX_ARTICLE_TABLE_COLUMNS,
          maxTableCells: MAX_ARTICLE_TABLE_CELLS,
          maxCellInlines: MAX_ARTICLE_INLINES_PER_CELL,
          maxImages: MAX_ARTICLE_IMAGES,
          maxImageCandidates: MAX_ARTICLE_IMAGE_CANDIDATES,
          maxImageAlt: MAX_ARTICLE_IMAGE_ALT_LENGTH,
          maxSrcsetEntries: MAX_SRCSET_ENTRIES,
          maxSrcsetLength: MAX_SRCSET_LENGTH,
        },
      },
    });
    liveWorkers.add(worker);
    // Registered outside the settle paths so the set empties on whichever exit
    // actually happens, including one this side never asked for.
    worker.once('exit', () => {
      liveWorkers.delete(worker);
    });

    /**
     * Ends the job exactly once: stops the timer, drops the abort listener, and
     * terminates the worker no matter which outcome arrived first. Every exit
     * from this promise goes through here, so no worker is left running behind
     * a settled caller.
     */
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      finish();
    };

    function onAbort(): void {
      settle(() => {
        reject(cancelledError());
      });
    }

    const timeout = setTimeout(() => {
      settle(() => {
        reject(
          new InterleafError('validation', 'That page took too long to read, so Interleaf stopped.')
        );
      });
    }, extractionTimeoutMs(options.timeoutMs));
    timeout.unref();

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message: PortableValue) => {
      settle(() => {
        resolve(message);
      });
    });
    worker.once('error', () => {
      settle(() => {
        reject(new InterleafError('internal', 'Article extraction failed safely.'));
      });
    });
    worker.once('exit', (code) => {
      settle(() => {
        reject(
          new InterleafError(
            'internal',
            `Article extraction worker exited before completion (${String(code)}).`
          )
        );
      });
    });
  });
}
