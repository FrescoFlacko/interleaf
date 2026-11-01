import type { SearchMatch } from '@shared/types/document';
import { caseFold, lookupFolding } from 'unicode-case-folding';
import { containsArticleAssetReference } from '@shared/legacy/legacy-brand-values';
import type { MarkdownBlock } from './markdown-parser';

/**
 * Text search over parsed Markdown blocks. Pure apart from cooperative
 * yielding: the adapter owns the blocks, the search sequence and the DOM, and
 * this owns case folding, offset mapping back to the original text, and the
 * result bounds.
 */

const MAX_MARKDOWN_SEARCH_RESULTS = 5_000;
const MAX_MARKDOWN_SEARCH_QUERY_LENGTH = 1_024;
const SEARCH_YIELD_UTF16_UNITS = 128 * 1024;

/**
 * Case-folds `value` and records, for every folded UTF-16 unit, the original
 * range it came from, yielding to the event loop every 128 Ki units and
 * returning `null` once `isCancelled` reports a newer search.
 */
async function foldTextWithOffsets(
  value: string,
  isCancelled: () => boolean,
  workBudget: { utf16Units: number }
): Promise<{
  readonly folded: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} | null> {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset) ?? 0;
    const originalLength = codePoint > 0xffff ? 2 : 1;
    const mapped = lookupFolding(codePoint) ?? [codePoint];
    const piece = String.fromCodePoint(...mapped);
    folded += piece;
    for (const character of piece) {
      starts.push(offset);
      ends.push(offset + originalLength);
      if (character.length === 2) {
        starts.push(offset);
        ends.push(offset + originalLength);
      }
    }
    offset += originalLength;
    workBudget.utf16Units += originalLength;
    if (workBudget.utf16Units >= SEARCH_YIELD_UTF16_UNITS) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      if (isCancelled()) return null;
      workBudget.utf16Units = 0;
    }
  }
  return { folded, starts, ends };
}

/**
 * An archived image as a snapshot spells it: `![alt](interleaf-asset:<hash><ext>)`.
 * Alt text may contain escaped brackets such as `\[` or `\]` (e.g. `![Chart \[v2\]](interleaf-asset:...)`).
 *
 * Snapshots captured before the Interleaf rename spell the same reference
 * `marginlab-asset:`. Both are matched so an older archived article still
 * renders its alt text instead of a raw hash.
 */
const ASSET_IMAGE_REFERENCE = /!\[((?:\\.|[^\\\]])*)\]\((?:interleaf|marginlab)-asset:[^)]*\)/g;

/**
 * Drops the durable reference from an archived image, keeping its alt text.
 *
 * The reference is storage bookkeeping that no reader sees: sixty-four hex
 * characters are a false hit for anyone searching a word that happens to be
 * spelled in hex, and they are tokens spent on nothing in an AI context. The
 * alt text is the opposite — it is the only description of the picture the
 * text carries — so it stays where the image was. Escaped brackets inside alt
 * text are unescaped for human-readable search and AI extraction.
 */
function stripAssetReferences(text: string): string {
  if (!containsArticleAssetReference(text)) return text;
  return text.replace(ASSET_IMAGE_REFERENCE, (_match, alt: string) => {
    return alt.replace(/\\([[\]\\])/g, '$1');
  });
}

/** A block's searchable, extractable text: archived image references reduced to their alt text. */
export function getBlockText(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'list':
    case 'table':
      return stripAssetReferences(block.text);
    case 'code_block':
      return block.code;
    case 'hr':
      return '';
  }
}

/** The query as a search uses it: trimmed and bounded, or empty for no search. */
export function markdownSearchNeedle(query: string): string {
  return query.trim().slice(0, MAX_MARKDOWN_SEARCH_QUERY_LENGTH);
}

type FoldedText = NonNullable<Awaited<ReturnType<typeof foldTextWithOffsets>>>;

/**
 * The first `limit` distinct original ranges in one block where the folded
 * needle occurs, in order. Scanning stops as soon as `limit` ranges are found,
 * so a block with millions of occurrences costs no more than the results the
 * search can still return.
 */
function foldedMatchRanges(folded: FoldedText, foldedNeedle: string, limit: number): readonly (readonly [number, number])[] {
  const { folded: foldedText, starts, ends } = folded;
  const ranges: (readonly [number, number])[] = [];
  const seenRanges = new Set<string>();
  let offset = 0;
  while (ranges.length < limit && offset <= foldedText.length - foldedNeedle.length) {
    const found = foldedText.indexOf(foldedNeedle, offset);
    if (found < 0) break;
    const originalStart = starts[found];
    const originalEnd = ends[found + foldedNeedle.length - 1];
    if (originalStart === undefined || originalEnd === undefined) break;
    const rangeKey = `${String(originalStart)}:${String(originalEnd)}`;
    if (!seenRanges.has(rangeKey)) {
      seenRanges.add(rangeKey);
      ranges.push([originalStart, originalEnd]);
    }
    offset = found + Math.max(1, foldedNeedle.length);
  }
  return ranges;
}

function blockMatch(block: MarkdownBlock, blockText: string, originalStart: number, originalEnd: number): SearchMatch {
  return {
    id: `markdown-match-${String(block.index)}-${String(originalStart)}-${String(originalEnd)}`,
    location: {
      format: 'markdown',
      blockIndex: block.index,
      characterStart: originalStart,
      characterEnd: originalEnd,
      lineIndex: block.lineIndex,
      ...(block.type === 'heading' ? { headingId: block.headingId } : {}),
    },
    text: blockText.slice(originalStart, originalEnd),
    textStart: originalStart,
    textEnd: originalEnd,
    prefix: blockText.slice(Math.max(0, originalStart - 50), originalStart),
    suffix: blockText.slice(originalEnd, originalEnd + 50),
  };
}

/**
 * Case-insensitive matches of `needle` (already passed through
 * `markdownSearchNeedle`) across `blocks`, at most 5,000. Resolves to `[]` as
 * soon as `isCancelled` reports that a newer search superseded this one.
 */
export async function searchMarkdownBlocks(
  blocks: readonly MarkdownBlock[],
  needle: string,
  isCancelled: () => boolean
): Promise<readonly SearchMatch[]> {
  const foldedNeedle = caseFold(needle);
  const matches: SearchMatch[] = [];
  const workBudget = { utf16Units: 0 };
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  if (isCancelled()) return [];

  for (const block of blocks) {
    const blockText = getBlockText(block);
    const folded = await foldTextWithOffsets(blockText, isCancelled, workBudget);
    if (!folded) return [];
    for (const [originalStart, originalEnd] of foldedMatchRanges(folded, foldedNeedle, MAX_MARKDOWN_SEARCH_RESULTS - matches.length)) {
      matches.push(blockMatch(block, blockText, originalStart, originalEnd));
    }
    if (matches.length >= MAX_MARKDOWN_SEARCH_RESULTS) return matches;
  }
  return matches;
}
