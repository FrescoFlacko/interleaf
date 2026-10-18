import type { SearchMatchAnchor, SearchTermRange } from '../types/search';

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const MAX_QUERY_TERMS = 20;
const MAX_TERM_LENGTH = 64;
export const MAX_SEARCH_ANCHOR_RANGES = 32;

export function tokenizeSearchTerms(query: string): readonly string[] {
  return query.normalize('NFKC')
    .match(TOKEN_RE)
    ?.slice(0, MAX_QUERY_TERMS)
    .map((term) => term.slice(0, MAX_TERM_LENGTH))
    .filter(Boolean) ?? [];
}

/**
 * SQLite's unicode61 tokenizer removes combining marks by default. Keep anchor
 * derivation congruent while retaining original UTF-16 boundaries.
 *
 * Exported so consumers that re-validate an anchor before painting apply the
 * identical folding rather than an approximation of it.
 */
export function foldSearchText(value: string): string {
  return value.normalize('NFKD').replace(/[\p{M}]/gu, '').toLocaleLowerCase('en-US');
}

const folded = foldSearchText;

/**
 * The exact whole-token relation every search surface uses: a native token
 * matches a query term only when the two fold to the same string. `Format`
 * matches `format`, `FORMAT` and `FoRmAt`; it never matches `formats`,
 * `formatted`, `formatting` or `formation`. There is no prefix or stem
 * expansion on this path — see `buildExactFtsQuery` and the exact-term filter
 * in `SearchRepository.search` for the retrieval half of the same contract.
 */
export function searchTokenMatchesTerm(token: string, term: string): boolean {
  return folded(token) === folded(term);
}

export type SearchTextToken = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

/**
 * The single definition of a search token boundary, shared by query parsing,
 * anchor derivation, the main-process exact-term filter, and both highlight
 * surfaces. FTS5's own `unicode61` boundaries differ slightly (`_` separates
 * there and joins here), which is why `MATCH` is only a candidate prefilter:
 * this tokenization, applied in `fieldsMatchAllSearchTerms`, decides what a
 * result is.
 */
export function searchTextTokens(text: string): readonly SearchTextToken[] {
  const matches = text.matchAll(TOKEN_RE);
  const tokens: SearchTextToken[] = [];
  for (const match of matches) {
    const textValue = match[0];
    const start = match.index;
    tokens.push({ start, end: start + textValue.length, text: textValue });
  }
  return tokens;
}

/**
 * Derives all bounded, causative token ranges using the same NFKC/token/exact
 * contract as the main-process result filter. It intentionally returns null
 * when any AND term has no native token match; adapters must never guess a
 * first literal occurrence in that case.
 */
export function deriveSearchTermRanges(
  text: string,
  query: string,
): { readonly queryTerms: readonly string[]; readonly ranges: readonly SearchTermRange[] } | null {
  const queryTerms = tokenizeSearchTerms(query);
  if (queryTerms.length === 0 || text.length === 0) return null;
  const tokens = searchTextTokens(text);
  const distinctTerms = new Map<string, { readonly indexes: number[] }>();
  for (const [queryTermIndex, queryTerm] of queryTerms.entries()) {
    const key = folded(queryTerm);
    const existing = distinctTerms.get(key);
    if (existing) existing.indexes.push(queryTermIndex);
    else distinctTerms.set(key, { indexes: [queryTermIndex] });
  }
  const candidatesByTerm = new Map<string, readonly SearchTextToken[]>();
  for (const key of distinctTerms.keys()) {
    const matches = tokens.filter((token) => folded(token.text) === key);
    if (matches.length === 0) return null;
    candidatesByTerm.set(key, matches);
  }
  const physical = new Map<string, SearchTermRange>();
  // Reserve one native token for every distinct AND term first. This prevents
  // a frequent first term from consuming the entire bounded registry.
  for (const [key, term] of distinctTerms) {
    const token = candidatesByTerm.get(key)?.[0];
    if (!token) return null;
    const physicalKey = `${String(token.start)}:${String(token.end)}`;
    const prior = physical.get(physicalKey);
    if (prior) {
      physical.set(physicalKey, {
        ...prior,
        queryTermIndices: [...prior.queryTermIndices, ...term.indexes],
      });
    } else {
      physical.set(physicalKey, {
        start: token.start,
        end: token.end,
        text: token.text,
        queryTermIndex: term.indexes[0] ?? 0,
        queryTermIndices: [...term.indexes],
      });
    }
  }
  // Fill remaining capacity in source order, deduplicating physical tokens.
  const candidates = [...tokens].sort((left, right) => left.start - right.start || left.end - right.end);
  for (const token of candidates) {
    if (physical.size >= MAX_SEARCH_ANCHOR_RANGES) break;
    const matchingIndexes = [...distinctTerms.entries()]
      .filter(([key]) => folded(token.text) === key)
      .flatMap(([, term]) => term.indexes);
    if (matchingIndexes.length === 0) continue;
    const physicalKey = `${String(token.start)}:${String(token.end)}`;
    const prior = physical.get(physicalKey);
    if (prior) {
      physical.set(physicalKey, {
        ...prior,
        queryTermIndices: [...new Set([...prior.queryTermIndices, ...matchingIndexes])],
      });
      continue;
    }
    physical.set(physicalKey, {
      start: token.start,
      end: token.end,
      text: token.text,
      queryTermIndex: matchingIndexes[0] ?? 0,
      queryTermIndices: matchingIndexes,
    });
  }
  return { queryTerms, ranges: [...physical.values()].sort((left, right) => left.start - right.start || left.end - right.end) };
}

export function createSearchMatchAnchor(input: {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentHash: string;
  readonly location: SearchMatchAnchor['location'];
  readonly text: string;
  readonly query: string;
}): SearchMatchAnchor | null {
  const location = input.location;
  const hasOffsets = location.format === 'docx' || location.format === 'pptx' || location.format === 'markdown'
    ? location.characterStart !== undefined && location.characterEnd !== undefined
    : location.textStart !== undefined && location.textEnd !== undefined;
  if (!hasOffsets) return null;
  const match = deriveSearchTermRanges(input.text, input.query);
  if (!match) return null;
  return { version: 1, chunkId: input.chunkId, documentId: input.documentId, documentHash: input.documentHash, location: input.location, ...match };
}

export function searchAnchorMatchesQuery(anchor: SearchMatchAnchor, query: string): boolean {
  const terms = tokenizeSearchTerms(query);
  return terms.length === anchor.queryTerms.length && terms.every((term, index) => term === anchor.queryTerms[index]);
}
