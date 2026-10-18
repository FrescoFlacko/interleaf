// Text search implementation ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

import { textWalker } from './text-walker';

const CONTEXT_LENGTH = 50;

const normalizeWhitespace = (str: string): string => str.replace(/\s+/g, ' ');

type SearchExcerpt = {
  pre: string;
  match: string;
  post: string;
};

type SearchIndices = {
  startIndex: number;
  startOffset: number;
  endIndex: number;
  endOffset: number;
};

const makeExcerpt = (
  strs: string[],
  { startIndex, startOffset, endIndex, endOffset }: SearchIndices
): SearchExcerpt => {
  const start = strs[startIndex] ?? '';
  const end = strs[endIndex] ?? '';
  const match =
    startIndex === endIndex
      ? start.slice(startOffset, endOffset)
      : start.slice(startOffset) +
        strs.slice(startIndex + 1, endIndex).join('') +
        end.slice(0, endOffset);

  const trimmedStart = normalizeWhitespace(start.slice(0, startOffset)).trimStart();
  const trimmedEnd = normalizeWhitespace(end.slice(endOffset)).trimEnd();
  const ellipsisPre = trimmedStart.length < CONTEXT_LENGTH ? '' : '…';
  const ellipsisPost = trimmedEnd.length < CONTEXT_LENGTH ? '' : '…';
  const pre = `${ellipsisPre}${trimmedStart.slice(-CONTEXT_LENGTH)}`;
  const post = `${trimmedEnd.slice(0, CONTEXT_LENGTH)}${ellipsisPost}`;
  return { pre, match, post };
};

export type SearchMatchResult = {
  range: Range;
  excerpt: SearchExcerpt;
  /** UTF-16 offsets in the text walker stream, used only as a native-range hint. */
  textStart: number;
  textEnd: number;
};

export type SearchOptions = {
  locales?: string;
  matchCase?: boolean;
};

const simpleSearch = function* (
  strs: string[],
  query: string,
  options: SearchOptions = {}
): Generator<{ indices: SearchIndices; excerpt: SearchExcerpt }> {
  const { locales = 'en', matchCase = false } = options;
  const haystack = strs.join('');
  const lowerHaystack = matchCase ? haystack : haystack.toLocaleLowerCase(locales);
  const needle = matchCase ? query : query.toLocaleLowerCase(locales);
  const needleLength = needle.length;

  if (needleLength === 0) return;

  let index = -1;
  let strIndex = 0;
  let sum = 0;

  do {
    index = lowerHaystack.indexOf(needle, index + 1);
    if (index > -1) {
      while (sum + (strs[strIndex]?.length ?? 0) <= index) {
        sum += strs[strIndex]?.length ?? 0;
        strIndex++;
      }
      const startIndex = strIndex;
      const startOffset = index - sum;

      let endSum = sum;
      let endStrIndex = strIndex;
      while (endSum + (strs[endStrIndex]?.length ?? 0) < index + needleLength) {
        endSum += strs[endStrIndex]?.length ?? 0;
        endStrIndex++;
      }
      const endIndex = endStrIndex;
      const endOffset = index + needleLength - endSum;

      const indices: SearchIndices = { startIndex, startOffset, endIndex, endOffset };
      const excerpt = makeExcerpt(strs, indices);
      yield { indices, excerpt };
    }
  } while (index > -1);
};

export const searchInDocument = (
  doc: Document | Element | Range,
  query: string,
  options?: SearchOptions
): Generator<SearchMatchResult> => {
  return textWalker(doc, (strs, makeRange) => {
    return Array.from(simpleSearch(strs, query, options)).map(({ indices, excerpt }) => ({
      range: makeRange(
        indices.startIndex,
        indices.startOffset,
        indices.endIndex,
        indices.endOffset
      ),
      excerpt,
      textStart: strs.slice(0, indices.startIndex).reduce((sum, value) => sum + value.length, 0) + indices.startOffset,
      textEnd: strs.slice(0, indices.endIndex).reduce((sum, value) => sum + value.length, 0) + indices.endOffset,
    }));
  });
};
