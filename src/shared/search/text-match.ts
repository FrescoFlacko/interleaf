import { foldSearchText, searchTextTokens, tokenizeSearchTerms } from './match-anchor';
import type { SearchTextToken } from './match-anchor';

/**
 * Exact whole-token search matching, shared by the main-process result filter,
 * the excerpt builder, and the renderer's result-card marks.
 *
 * FTS5's `MATCH` is a *candidate* prefilter only. The table is tokenized with
 * `porter unicode61`, so the database also returns stem relatives (`format`
 * retrieves rows whose only occurrence is `formatting`) and its `unicode61`
 * boundaries are not identical to {@link searchTextTokens}. Everything in this
 * module works on the stored chunk text with the project's own token
 * definition and folding, so a search result, its excerpt, its anchor ranges,
 * the card marks and the in-document paint all agree on exactly one relation:
 * folded token equality.
 *
 * Porter stemming is a deterministic function of the token, so every exact
 * match is also a stem match — filtering a superset here never loses a result.
 */

/** Bounds the marks a single card can paint; the tail renders unmarked. */
export const MAX_SEARCH_TEXT_MATCHES = 128;

/** Roughly the visible width of a result-card excerpt. */
export const SEARCH_EXCERPT_MAX_CHARS = 260;
const SEARCH_EXCERPT_LEAD_CHARS = 70;
const ELLIPSIS = '…';

export type SearchTextSegment = {
  readonly text: string;
  readonly isMatch: boolean;
};

function foldedQueryTerms(query: string): readonly string[] {
  return [...new Set(tokenizeSearchTerms(query).map(foldSearchText))];
}

/** Every exact whole-token occurrence of any query term, in source order. */
export function searchTermMatchRanges(text: string, query: string): readonly SearchTextToken[] {
  const terms = new Set(foldedQueryTerms(query));
  if (terms.size === 0 || text.length === 0) return [];
  const matches: SearchTextToken[] = [];
  for (const token of searchTextTokens(text)) {
    if (!terms.has(foldSearchText(token.text))) continue;
    matches.push(token);
    if (matches.length >= MAX_SEARCH_TEXT_MATCHES) break;
  }
  return matches;
}

/**
 * Splits text into alternating plain and matched segments for safe React
 * rendering. Callers render each segment as a text node or a `<mark>`; no
 * markup is ever produced from the document text itself.
 */
export function splitTextBySearchTerms(text: string, query: string): readonly SearchTextSegment[] {
  if (text.length === 0) return [];
  const matches = searchTermMatchRanges(text, query);
  if (matches.length === 0) return [{ text, isMatch: false }];
  const segments: SearchTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), isMatch: false });
    segments.push({ text: text.slice(match.start, match.end), isMatch: true });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), isMatch: false });
  return segments;
}

/**
 * True when every distinct query term occurs at least once as an exact whole
 * token across the supplied fields. This is the authoritative definition of a
 * search result; `MATCH` only decides which rows are worth checking.
 *
 * The folded-substring pass first is a cheap necessary condition: a term that
 * is not a substring of the folded field cannot be one of its tokens, which
 * rejects the common stem-only candidate without tokenizing a whole chunk.
 */
export function fieldsMatchAllSearchTerms(
  fields: readonly (string | null | undefined)[],
  query: string
): boolean {
  const terms = foldedQueryTerms(query);
  if (terms.length === 0) return false;
  const present = fields.filter((field): field is string => typeof field === 'string' && field.length > 0);
  if (present.length === 0) return false;
  const foldedFields = present.map(foldSearchText);
  if (!terms.every((term) => foldedFields.some((field) => field.includes(term)))) return false;

  const pending = new Set(terms);
  for (const field of present) {
    for (const token of searchTextTokens(field)) {
      pending.delete(foldSearchText(token.text));
      if (pending.size === 0) return true;
    }
  }
  return pending.size === 0;
}

/** Word-aligned start at or before `index`, so an excerpt never opens mid-word. */
function alignedStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const space = text.lastIndexOf(' ', index);
  return space < 0 ? 0 : space + 1;
}

/**
 * Word-aligned end at or before `index`, never cutting before `minimum` so the
 * causative match itself always survives.
 */
function alignedEnd(text: string, index: number, minimum: number): number {
  if (index >= text.length) return text.length;
  const space = text.lastIndexOf(' ', index);
  return space > minimum ? space : index;
}

/**
 * Builds the result-card excerpt around the first exact match.
 *
 * FTS5's `snippet()` centres its window on whatever the *stemmed* index
 * matched, so on a multi-thousand-character chunk it can return a window that
 * contains `formatting` and no occurrence of `format` at all — a card that
 * shows nothing the user searched for and nothing to mark. Deriving the window
 * from the same exact matches the card highlights keeps the two in step.
 */
export function buildSearchExcerpt(text: string, query: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return '';
  if (flat.length <= SEARCH_EXCERPT_MAX_CHARS) return flat;
  const first = searchTermMatchRanges(flat, query)[0];
  const anchorStart = first?.start ?? 0;
  const anchorEnd = first?.end ?? 0;
  const start = alignedStart(
    flat,
    Math.max(0, Math.min(anchorStart - SEARCH_EXCERPT_LEAD_CHARS, flat.length - SEARCH_EXCERPT_MAX_CHARS))
  );
  const end = alignedEnd(flat, Math.min(flat.length, start + SEARCH_EXCERPT_MAX_CHARS), anchorEnd);
  const prefix = start > 0 ? `${ELLIPSIS} ` : '';
  const suffix = end < flat.length ? ` ${ELLIPSIS}` : '';
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}
