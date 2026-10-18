import { z } from 'zod';
import {
  MAX_WEB_ARTICLE_BLOCKS,
  MAX_WEB_ARTICLE_IMAGES,
} from '@shared/constants/web-article';

/**
 * The inert intermediate representation a web article is reduced to before it
 * becomes Markdown.
 *
 * The extraction worker never returns HTML. It returns only this closed set of
 * text-bearing shapes, so nothing that crosses back from the untrusted-parse
 * boundary can carry markup, an event handler, a remote resource, or a URL
 * scheme that was not explicitly allowed. Everything downstream — Markdown
 * generation, hashing, storage — operates on plain data that was already
 * checked against this schema.
 */

export const MAX_ARTICLE_BLOCKS = MAX_WEB_ARTICLE_BLOCKS;
export const MAX_ARTICLE_INLINES_PER_BLOCK = 400;
export const MAX_ARTICLE_TEXT_LENGTH = 2_000_000;
export const MAX_ARTICLE_LIST_ITEMS = 500;
export const MAX_ARTICLE_TITLE_LENGTH = 300;
export const MAX_ARTICLE_BYLINE_LENGTH = 200;
export const MAX_ARTICLE_SITE_NAME_LENGTH = 120;

/**
 * Table and image bounds.
 *
 * A table is the one shape here whose cost grows multiplicatively, so rows,
 * columns, total cells, and the inline run inside a single cell are each capped
 * independently rather than relying on the shared block budget. Images are
 * capped by count because every accepted candidate becomes a bounded network
 * request and a file on disk later in the pipeline.
 */
export const MAX_ARTICLE_TABLES = 60;
export const MAX_ARTICLE_TABLE_ROWS = 200;
export const MAX_ARTICLE_TABLE_COLUMNS = 24;
export const MAX_ARTICLE_TABLE_CELLS = 2000;
export const MAX_ARTICLE_INLINES_PER_CELL = 40;
export const MAX_ARTICLE_IMAGES = MAX_WEB_ARTICLE_IMAGES;
/**
 * How many image candidates one extraction recognizes, and so the largest
 * shortfall it can report.
 *
 * The IR stops at `MAX_ARTICLE_IMAGES`, and everything past that used to vanish
 * without trace: a page offering fifty-two useful figures produced forty image
 * blocks and no evidence that twelve had been left behind. The worker counts
 * them instead. Recognition stops at this same bound, so the count is exact for
 * every candidate the worker actually saw rather than a saturated approximation,
 * and what leaves the worker is still a number and never a list of URLs.
 */
export const MAX_ARTICLE_IMAGE_CANDIDATES = MAX_WEB_ARTICLE_BLOCKS;
export const MAX_ARTICLE_IMAGE_ALT_LENGTH = 500;
const MAX_ARTICLE_IMAGE_SRC_LENGTH = 2048;

export function isSafeArticleHref(href: string): boolean {
  if (href.length === 0 || href.length > 2048) return false;
  try {
    const url = new URL(href);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const inlineSchema = z
  .object({
    text: z.string().max(MAX_ARTICLE_TEXT_LENGTH),
    style: z.enum(['plain', 'emphasis', 'strong', 'code']),
    href: z
      .string()
      .max(2048)
      .refine(isSafeArticleHref, {
        message: 'Article link href must be a valid http: or https: URL without credentials.',
      })
      /** Present only for links the worker already reduced to an http/https URL. */
      .exactOptional(),
  })
  .strict();

const inlineRunSchema = z.array(inlineSchema).max(MAX_ARTICLE_INLINES_PER_BLOCK);

const tableCellSchema = z.array(inlineSchema).max(MAX_ARTICLE_INLINES_PER_CELL);
const tableRowSchema = z.array(tableCellSchema).max(MAX_ARTICLE_TABLE_COLUMNS);

const imageSrcSchema = z
  .string()
  .max(MAX_ARTICLE_IMAGE_SRC_LENGTH)
  .refine(isSafeArticleHref, {
    message: 'Article image src must be a valid http: or https: URL without credentials.',
  });

/**
 * A table is accepted only if it is already rectangular.
 *
 * The worker pads and truncates rows before replying, so a shape check here is
 * cheap and turns any future extraction bug into a typed failure rather than a
 * pipe table whose cells have silently shifted into the wrong columns.
 */
const tableSchema = z
  .object({
    type: z.literal('table'),
    header: tableRowSchema,
    rows: z.array(tableRowSchema).max(MAX_ARTICLE_TABLE_ROWS),
  })
  .strict()
  .refine(
    (table) =>
      table.header.length > 0 &&
      table.rows.every((row) => row.length === table.header.length) &&
      table.rows.length * table.header.length <= MAX_ARTICLE_TABLE_CELLS,
    { message: 'Article table must be rectangular and within the cell budget.' }
  );

const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6), inline: inlineRunSchema }).strict(),
  z.object({ type: z.literal('paragraph'), inline: inlineRunSchema }).strict(),
  z.object({ type: z.literal('quote'), inline: inlineRunSchema }).strict(),
  z.object({ type: z.literal('caption'), inline: inlineRunSchema }).strict(),
  z
    .object({
      type: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(inlineRunSchema).max(MAX_ARTICLE_LIST_ITEMS),
    })
    .strict(),
  z.object({ type: z.literal('code'), text: z.string().max(MAX_ARTICLE_TEXT_LENGTH) }).strict(),
  /**
   * A rectangular table. `header` may be all-empty when the source had no
   * usable header row; every row is already padded to `header.length`, so
   * downstream rendering never has to reason about ragged input.
   */
  tableSchema,
  /**
   * A localizable image candidate. `src` is an absolute http/https URL on
   * the page, not something the renderer will ever see: the media pipeline
   * either archives it and rewrites the reference to a durable app-owned
   * identity, or drops it and leaves the alt text behind.
   */
  z
    .object({
      type: z.literal('image'),
      src: imageSrcSchema,
      alt: z.string().max(MAX_ARTICLE_IMAGE_ALT_LENGTH),
    })
    .strict(),
  z.object({ type: z.literal('rule') }).strict(),
]);

function countBlocks(blocks: readonly { readonly type: string }[], type: string): number {
  return blocks.reduce((total, block) => (block.type === type ? total + 1 : total), 0);
}

/**
 * Caps the two block kinds whose cost is not paid in text.
 *
 * Every accepted image becomes a network request and a stored file, and every
 * table multiplies out into cells, so both are limited on top of the shared
 * block budget rather than relying on it.
 */
function withinRichBlockBudget(blocks: readonly { readonly type: string }[]): boolean {
  return (
    countBlocks(blocks, 'image') <= MAX_ARTICLE_IMAGES &&
    countBlocks(blocks, 'table') <= MAX_ARTICLE_TABLES
  );
}

/**
 * Runtime shape check applied to the worker's reply.
 *
 * The worker is Interleaf code, but it is the only place that touches hostile
 * markup, so its output is validated exactly like any other untrusted payload
 * rather than trusted because of where it came from.
 */
export const extractedArticleSchema = z
  .object({
    title: z.string().max(MAX_ARTICLE_TITLE_LENGTH).nullable(),
    byline: z.string().max(MAX_ARTICLE_BYLINE_LENGTH).nullable(),
    siteName: z.string().max(MAX_ARTICLE_SITE_NAME_LENGTH).nullable(),
    blocks: z.array(blockSchema).max(MAX_ARTICLE_BLOCKS).refine(withinRichBlockBudget, {
      message: 'Article exceeds the image or table budget.',
    }),
    /** Length of the readable text the worker accepted, used for the article threshold. */
    textLength: z.number().int().min(0).max(MAX_ARTICLE_TEXT_LENGTH),
    /**
     * Open Graph raster candidate for the page, captured before active elements
     * were purged. Used only as a hero fallback when the body yielded no image.
     */
    heroImage: z
      .object({ src: imageSrcSchema, alt: z.string().max(MAX_ARTICLE_IMAGE_ALT_LENGTH) })
      .strict()
      .exactOptional(),
    /**
     * How many otherwise-usable editorial images the extraction ceilings dropped.
     *
     * Only a count. The URLs behind it are deliberately discarded at the worker
     * boundary, because the point is to tell a reader that the snapshot is short
     * of the page, not to hand anything downstream a list of things to fetch.
     */
    imagesOmitted: z.number().int().min(0).max(MAX_ARTICLE_IMAGE_CANDIDATES).exactOptional(),
  })
  .strict();

export type ExtractedArticle = z.output<typeof extractedArticleSchema>;
export type ArticleBlock = ExtractedArticle['blocks'][number];
export type ArticleInline = Extract<ArticleBlock, { type: 'paragraph' }>['inline'][number];
export type ArticleInlineStyle = ArticleInline['style'];
/** One table cell, which carries the same inline vocabulary as any other run. */
export type ArticleTableCell = Extract<ArticleBlock, { type: 'table' }>['header'][number];
