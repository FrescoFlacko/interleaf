import { describe, expect, it } from 'vitest';
import {
  buildSearchExcerpt,
  fieldsMatchAllSearchTerms,
  MAX_SEARCH_TEXT_MATCHES,
  searchTermMatchRanges,
  SEARCH_EXCERPT_MAX_CHARS,
  splitTextBySearchTerms,
} from '@shared/search/text-match';

describe('exact whole-token search text matching', () => {
  it('matches a token in any casing and never a longer word containing it', () => {
    const text = 'FORMAT, formats, formatted, formatting, formation, reformat, FoRmAt.';
    expect(searchTermMatchRanges(text, 'Format').map((match) => match.text)).toEqual(['FORMAT', 'FoRmAt']);
    expect(searchTermMatchRanges(text, 'formats').map((match) => match.text)).toEqual(['formats']);
    expect(searchTermMatchRanges(text, 'reformat').map((match) => match.text)).toEqual(['reformat']);
    expect(searchTermMatchRanges(text, 'forma')).toEqual([]);
    expect(searchTermMatchRanges(text, 'formatte')).toEqual([]);
  });

  it('reports native offsets across punctuation and folds combining marks', () => {
    expect(searchTermMatchRanges('Use (format), format-aware.', 'format').map((match) => [match.start, match.end]))
      .toEqual([[5, 11], [14, 20]]);
    // Underscores join, matching the shared token definition rather than FTS5's.
    expect(searchTermMatchRanges('the format_id column', 'format')).toEqual([]);
    expect(searchTermMatchRanges('CAFÉ and cafe', 'Café').map((match) => match.text)).toEqual(['CAFÉ', 'cafe']);
  });

  it('bounds the number of marks it will produce', () => {
    const text = Array.from({ length: MAX_SEARCH_TEXT_MATCHES + 40 }, () => 'needle').join(' ');
    expect(searchTermMatchRanges(text, 'needle')).toHaveLength(MAX_SEARCH_TEXT_MATCHES);
  });

  it('splits into segments that reassemble to the original text', () => {
    const text = 'A QUORUM of quorums; quorum-based voting.';
    const segments = splitTextBySearchTerms(text, 'quorum');
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.isMatch).map((segment) => segment.text))
      .toEqual(['QUORUM', 'quorum']);
    expect(splitTextBySearchTerms(text, 'absent')).toEqual([{ text, isMatch: false }]);
    expect(splitTextBySearchTerms('', 'quorum')).toEqual([]);
    // A text that is nothing but the match must not emit empty segments.
    expect(splitTextBySearchTerms('quorum', 'quorum')).toEqual([{ text: 'quorum', isMatch: true }]);
  });

  it('requires every distinct query term as an exact token across the searched fields', () => {
    expect(fieldsMatchAllSearchTerms(['alpha beta gamma'], 'alpha gamma')).toBe(true);
    expect(fieldsMatchAllSearchTerms(['Safety', 'alpha beta'], 'safety beta')).toBe(true);
    expect(fieldsMatchAllSearchTerms(['alpha beta'], 'alpha gamma')).toBe(false);
    // The stem-only candidate FTS5 returns is exactly what this rejects.
    expect(fieldsMatchAllSearchTerms(['Several formats apply'], 'format')).toBe(false);
    expect(fieldsMatchAllSearchTerms(['alphabet'], 'alpha')).toBe(false);
    expect(fieldsMatchAllSearchTerms(['CAFÉ'], 'cafe')).toBe(true);
    expect(fieldsMatchAllSearchTerms([null, undefined, ''], 'alpha')).toBe(false);
    expect(fieldsMatchAllSearchTerms(['alpha'], '***')).toBe(false);
    // A repeated term is one requirement, not two.
    expect(fieldsMatchAllSearchTerms(['alpha'], 'alpha ALPHA')).toBe(true);
  });

  it('centres a bounded excerpt on the first exact match and marks both truncated ends', () => {
    const lead = 'lorem '.repeat(120);
    const tail = ' tail'.repeat(120);
    const text = `${lead}needle${tail}`;
    const excerpt = buildSearchExcerpt(text, 'needle');
    expect(excerpt).toContain('needle');
    expect(excerpt.startsWith('… ')).toBe(true);
    expect(excerpt.endsWith(' …')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_MAX_CHARS + 4);
    // Word-aligned: the window never opens or closes mid-word.
    expect(excerpt.slice(2)).toMatch(/^\S/u);
    expect(/lore\b/u.test(excerpt)).toBe(false);
  });

  it('collapses whitespace, returns short text whole, and still shows something with no exact match', () => {
    expect(buildSearchExcerpt('  A\n\tspaced   passage. ', 'passage')).toBe('A spaced passage.');
    expect(buildSearchExcerpt('   ', 'passage')).toBe('');
    const text = `${'lorem '.repeat(120)}formats`;
    // `formats` is a stem relative, not an exact match: the card still gets a
    // readable head-of-chunk excerpt rather than an empty string.
    const excerpt = buildSearchExcerpt(text, 'format');
    expect(excerpt.startsWith('lorem')).toBe(true);
    expect(excerpt.endsWith(' …')).toBe(true);
  });
});
