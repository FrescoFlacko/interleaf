import {
  isSafeArticleHref,
  MAX_ARTICLE_TITLE_LENGTH,
  type ArticleBlock,
  type ArticleInline,
  type ArticleInlineStyle,
  type ArticleTableCell,
  type ExtractedArticle,
} from './article-content';

/**
 * Renders the extracted article IR as Markdown.
 *
 * This is the last step before untrusted content becomes a file, and it is a
 * pure function over plain data — there is no DOM here and no HTML can reach
 * it. Its job is to keep the result inert: every character that Markdown or the
 * reader would otherwise treat as structure is escaped, link targets are
 * restricted to `http`/`https`, and front-matter values are flattened to a
 * single quoted line so a hostile title cannot open a new document section.
 *
 * The output deliberately uses the plain Markdown the existing reader already
 * parses, so a web snapshot needs no new anchor format, parser, or renderer.
 */

const MAX_FRONT_MATTER_VALUE = 300;
const INLINE_ESCAPE = /[\\`*_[\]<>|~]/g;
const LINE_START_MARKER = /^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s)|\d+\.(?=\s)|=+$|-+$)/;

export type ArticleMarkdownInput = {
  readonly article: ExtractedArticle;
  /** Provenance URL, already validated and credential-free. */
  readonly sourceUrl: string;
  /** Title to use when the page supplied none. */
  readonly fallbackTitle: string;
  /**
   * Page image URL to durable app-owned reference, for the images that were
   * successfully archived.
   *
   * The values here are stable identities such as `interleaf-asset:<sha256>.png`
   * — never a `interleaf-media:` capability URL, which expires and is bound to
   * one open document, and so must never become snapshot bytes. An image with
   * no entry was not archived and degrades to its alt text.
   */
  readonly images?: ReadonlyMap<string, string>;
};

function escapeInline(text: string): string {
  return text.replace(INLINE_ESCAPE, (character) => `\\${character}`);
}

/**
 * Neutralizes a leading construct so a paragraph that happens to start with
 * `#`, `- `, or `1.` stays a paragraph instead of becoming a heading or list.
 */
function escapeLineStart(text: string): string {
  return text.replace(LINE_START_MARKER, (_match, indent: string, marker: string) => `${indent}\\${marker}`);
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const symbol of text) {
    current = symbol === character ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Escapes the two characters that would otherwise break a table row.
 *
 * A code span is normally verbatim, but inside a pipe table an unescaped `|`
 * would shear the row into the wrong number of columns and shift every later
 * cell under the wrong header, so the separator has to be escaped even here.
 * Only backslashes immediately preceding a pipe are escaped so they cannot
 * escape the pipe's escape itself. Backslashes elsewhere in a code span are
 * untouched, preserving ordinary authored Markdown code-span semantics.
 */
function escapeCellCode(text: string): string {
  return text.replace(/\\*\|/g, (match) => '\\'.repeat((match.length - 1) * 2 + 1) + '|');
}

function renderInlineCode(text: string, inCell: boolean): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  const body = inCell ? escapeCellCode(text) : text;
  return `${fence}${pad}${body}${pad}${fence}`;
}

/**
 * Parentheses are percent-encoded because the reader's link parser tracks
 * parenthesis depth; everything else in the URL was already normalized by
 * `URL`, and the scheme was restricted before this point.
 */
function renderHref(href: string): string {
  return href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function applyInlineStyle(body: string, style: ArticleInlineStyle): string {
  if (style === 'strong') return `**${body}**`;
  if (style === 'emphasis') return `*${body}*`;
  return body;
}

function renderInline(inline: ArticleInline, inCell: boolean): string {
  const body =
    inline.style === 'code' ? renderInlineCode(inline.text, inCell) : escapeInline(inline.text);
  const styled = applyInlineStyle(body, inline.style);
  if (inline.href === undefined || !isSafeArticleHref(inline.href)) return styled;
  return `[${styled}](${renderHref(inline.href)})`;
}

function renderRun(run: readonly ArticleInline[]): string {
  return run.map((inline) => renderInline(inline, false)).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Renders one table cell.
 *
 * `renderRun`'s whitespace collapse already removes newlines, which a pipe
 * table cannot contain, and `escapeInline` already escapes both `\` and `|`,
 * so a cell's meaning survives the trip into a row without ever supplying an
 * unescaped separator.
 */
function renderCell(cell: ArticleTableCell): string {
  return cell.map((inline) => renderInline(inline, true)).join('').replace(/\s+/g, ' ').trim();
}

function renderTableBlock(block: Extract<ArticleBlock, { type: 'table' }>): string {
  const columns = block.header.length;
  if (columns < 2) return '';
  const lines = [
    `| ${block.header.map(renderCell).join(' | ')} |`,
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
  ];
  for (const row of block.rows) {
    lines.push(`| ${row.map(renderCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Single-line, bracket-safe text for an image's alt attribute. */
function renderAlt(alt: string): string {
  return escapeInline(alt).replace(/\s+/g, ' ').trim();
}

function renderImageBlock(
  block: Extract<ArticleBlock, { type: 'image' }>,
  images: ReadonlyMap<string, string> | undefined
): string {
  const alt = renderAlt(block.alt);
  const reference = images?.get(block.src);
  // An image that was not archived — rejected, unreachable, or over budget —
  // leaves its description behind rather than taking the article down with it.
  if (reference === undefined) return alt.length === 0 ? '' : `*${alt}*`;
  return `![${alt}](${reference})`;
}

function renderCodeBlock(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}\n${text}\n${fence}`;
}

function renderListBlock(block: Extract<ArticleBlock, { type: 'list' }>): string {
  const lines: string[] = [];
  for (const item of block.items) {
    const text = renderRun(item);
    if (text.length === 0) continue;
    const marker = block.ordered ? `${String(lines.length + 1)}.` : '-';
    lines.push(`${marker} ${text}`);
  }
  return lines.join('\n');
}

/**
 * The two block kinds that depend on what the media pipeline archived.
 *
 * They are dispatched apart from the text blocks because they are the only
 * ones whose rendering is a function of anything beyond the block itself.
 * `null` means "not one of these", leaving the text renderer to answer.
 */
function renderRichBlock(
  block: ArticleBlock,
  images: ReadonlyMap<string, string> | undefined
): string | null {
  if (block.type === 'table') return renderTableBlock(block);
  if (block.type === 'image') return renderImageBlock(block, images);
  return null;
}

function renderTextBlock(block: ArticleBlock): string {
  switch (block.type) {
    case 'heading': {
      const text = renderRun(block.inline);
      return text.length === 0 ? '' : `${'#'.repeat(block.level)} ${text}`;
    }
    case 'paragraph':
      return escapeLineStart(renderRun(block.inline));
    case 'quote': {
      const text = renderRun(block.inline);
      return text.length === 0 ? '' : `> ${text}`;
    }
    case 'caption': {
      const text = renderRun(block.inline);
      return text.length === 0 ? '' : `*${text}*`;
    }
    case 'list':
      return renderListBlock(block);
    case 'code':
      return renderCodeBlock(block.text);
    case 'rule':
      // `***` rather than `---`, which the reader would read as a setext rule.
      return '***';
    default:
      return '';
  }
}

function renderBlock(block: ArticleBlock, images?: ReadonlyMap<string, string>): string {
  return renderRichBlock(block, images) ?? renderTextBlock(block);
}

function stripControlChars(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    result += code < 32 || code === 127 ? ' ' : text.charAt(i);
  }
  return result;
}

/**
 * Cleans the article title while preserving genuine typography (apostrophes, quotes, dashes).
 */
function cleanTitle(value: string): string {
  const stripped = stripControlChars(value);
  return stripped.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ARTICLE_TITLE_LENGTH);
}

/**
 * Flattens a value for YAML front matter: one line, safely escaped quotes,
 * no control characters, and never the `---` delimiter itself.
 */
function frontMatterValue(value: string): string {
  const stripped = stripControlChars(value);
  const flattened = stripped
    .replace(/"/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flattened.slice(0, MAX_FRONT_MATTER_VALUE);
}

function frontMatterLine(key: string, value: string | null): string | null {
  if (value === null) return null;
  const safe = frontMatterValue(value);
  return safe.length === 0 ? null : `${key}: "${safe}"`;
}

export function articleTitle(input: ArticleMarkdownInput): string {
  const candidate = input.article.title === null ? '' : cleanTitle(input.article.title);
  return candidate.length > 0 ? candidate : input.fallbackTitle;
}

/** Zero-width and soft-hyphen characters, which carry no visible difference. */
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Apostrophe-like characters: the ASCII quote, backtick and acute accent, the
 * modifier letters, the curly single quotes, and the prime.
 *
 * These are removed rather than turned into a separator so `Reader's Guide` and
 * `Readers Guide` compare equal — a page that spells the possessive one way
 * in its title and the other way in its first heading is naming one article.
 */
const APOSTROPHE_CHARACTERS = /[\u0027\u0060\u00B4\u02B9\u02BB-\u02BD\u2018-\u201B\u2032]/g;

/** Anything that is neither a letter, a digit, nor whitespace. */
const NON_WORD_CHARACTERS = /[^\p{L}\p{N}\s]/gu;

/**
 * Normalizes a heading or title string for deduplication comparison.
 *
 * A page's metadata title and its own first heading routinely differ by
 * typography alone: a straight apostrophe against a curly one, a trailing
 * period, a wrapping pair of smart quotes, an em dash, a colon the heading
 * drops. Rendering both would hand the reader two H1s that say the same thing,
 * so this reduces a title to the letters and digits it is made of —
 * compatibility-normalized (NFKC, which folds fullwidth and other presentation
 * forms), invisible characters dropped, apostrophes elided, every remaining
 * punctuation mark treated as a word separator, whitespace collapsed, then
 * case-folded.
 *
 * This drives presentation only. It never decides what is fetched, stored, or
 * escaped, so folding aggressively here costs nothing beyond occasionally
 * treating two very similar headings as one.
 */
export function normalizeTitleForComparison(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(APOSTROPHE_CHARACTERS, '')
    .replace(NON_WORD_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Builds the complete snapshot file.
 *
 * The result is a pure function of the extracted article and its URL — no
 * timestamp, no random identifier — so an unchanged page hashes to the same
 * bytes every time and re-importing it deduplicates under the existing
 * content-hash rules instead of creating a second copy. Capture time lives in
 * the database row, not in the file.
 */
/**
 * The block list a snapshot is actually rendered from.
 *
 * A page that paints its hero on a `<canvas>` leaves no static image in the
 * body — the canvas is purged as active content — so when the body produced no
 * image at all, the page's own Open Graph raster stands in at the top. A page
 * that did produce body images is left alone, so the fallback can never
 * duplicate an illustration the article already has.
 */
function articleBlocksForRender(article: ExtractedArticle): readonly ArticleBlock[] {
  if (article.heroImage === undefined) return article.blocks;
  if (article.blocks.some((block) => block.type === 'image')) return article.blocks;
  return [
    { type: 'image', src: article.heroImage.src, alt: article.heroImage.alt },
    ...article.blocks,
  ];
}

/**
 * Every distinct page image URL the snapshot would reference, in reading order.
 *
 * This is the exact set the media pipeline is asked to archive, derived from
 * the same block list that renders, so no image can be fetched that the
 * snapshot would not use and none can be referenced that was never offered.
 */
export function articleImageSources(article: ExtractedArticle): readonly string[] {
  const seen = new Set<string>();
  for (const block of articleBlocksForRender(article)) {
    if (block.type === 'image') seen.add(block.src);
  }
  return [...seen];
}

export function renderArticleMarkdown(input: ArticleMarkdownInput): string {
  const frontMatter = [
    frontMatterLine('title', articleTitle(input)),
    frontMatterLine('author', input.article.byline),
    frontMatterLine('site', input.article.siteName),
    frontMatterLine('source', input.sourceUrl),
  ].filter((line): line is string => line !== null);

  const title = articleTitle(input);
  // The rendered snapshot always opens with the title as an H1, so an article
  // whose own first heading repeats it drops that heading rather than showing
  // the reader the same line twice.
  const normalizedTitle = normalizeTitleForComparison(title);
  const renderable = articleBlocksForRender(input.article);
  const firstBlock = renderable[0];
  const firstBlockMatchesTitle =
    normalizedTitle.length > 0 &&
    firstBlock?.type === 'heading' &&
    normalizeTitleForComparison(firstBlock.inline.map((i) => i.text).join('')) === normalizedTitle;
  const blocksToRender = firstBlockMatchesTitle ? renderable.slice(1) : renderable;

  const body = blocksToRender
    .map((block) => renderBlock(block, input.images))
    .filter((text) => text.length > 0)
    .join('\n\n');

  return `---\n${frontMatter.join('\n')}\n---\n\n# ${escapeInline(title)}\n\n${body}\n`;
}
