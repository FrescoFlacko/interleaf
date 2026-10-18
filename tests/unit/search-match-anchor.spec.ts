import { describe, expect, it } from 'vitest';
import { createSearchMatchAnchor, deriveSearchTermRanges, tokenizeSearchTerms } from '@shared/search/match-anchor';

describe('hash-bound search match anchors', () => {
  it('follows the exact whole-token AND contract across non-contiguous, out-of-order terms', () => {
    const text = 'Architecture comes first; a catalogue follows.';
    const result = deriveSearchTermRanges(text, 'catalogue architecture');
    expect(result?.queryTerms).toEqual(['catalogue', 'architecture']);
    expect(result?.ranges.map((range) => range.text)).toEqual(['Architecture', 'catalogue']);
    expect(result?.ranges.map((range) => range.queryTermIndex)).toEqual([1, 0]);
    expect(result?.ranges.every((range) => range.queryTermIndices.length > 0)).toBe(true);
    // Prefixes of a native token are not matches; there is no prefix expansion.
    expect(deriveSearchTermRanges(text, 'cat arch')).toBeNull();
  });

  it('matches only the exact token in any casing, never a longer word sharing its stem', () => {
    const text = 'The FORMAT, its formats, formatted output, formatting rules and formation.';
    const result = deriveSearchTermRanges(text, 'Format');
    expect(result?.ranges.map((range) => range.text)).toEqual(['FORMAT']);
    for (const casing of ['format', 'FORMAT', 'FoRmAt']) {
      expect(deriveSearchTermRanges(text, casing)?.ranges.map((range) => range.text)).toEqual(['FORMAT']);
    }
    for (const longer of ['formats', 'formatted', 'formatting', 'formation']) {
      expect(deriveSearchTermRanges(text, longer)?.ranges.map((range) => range.text)).toEqual([longer]);
    }
  });

  it('treats punctuation as a boundary and underscores as part of one token', () => {
    // `format.` and `(format)` are the token `format`; `format_id` is not.
    const punctuated = deriveSearchTermRanges('Use format. Then (format) again, format-aware.', 'format');
    expect(punctuated?.ranges.map((range) => [range.start, range.end])).toEqual([[4, 10], [18, 24], [33, 39]]);
    expect(deriveSearchTermRanges('The format_id column.', 'format')).toBeNull();
    expect(deriveSearchTermRanges('The format_id column.', 'format_id')?.ranges.map((range) => range.text))
      .toEqual(['format_id']);
  });

  it('folds query normalization and case while preserving native UTF-16 offsets', () => {
    expect(tokenizeSearchTerms('  CAFÉ\u00a0  résumé ')).toEqual(['CAFÉ', 'résumé']);
    const result = deriveSearchTermRanges('Résumé and CAFÉ', 'café résumé');
    expect(result?.ranges.map((range) => range.text)).toEqual(['Résumé', 'CAFÉ']);
    expect(result?.ranges.map((range) => [range.start, range.end])).toEqual([[0, 6], [11, 15]]);
    expect(deriveSearchTermRanges('CAFÉ', 'cafe')?.ranges[0]?.text).toBe('CAFÉ');
  });

  it('bounds ranges and rejects legacy locations without native offsets', () => {
    const text = Array.from({ length: 100 }, (_, index) => `needle filler${String(index)}`).join(' ');
    const ranges = deriveSearchTermRanges(text, 'needle');
    expect(ranges?.ranges).toHaveLength(32);
    expect(ranges?.ranges.every((range) => range.text === 'needle')).toBe(true);
    expect(createSearchMatchAnchor({
      chunkId: 'legacy', documentId: 'doc', documentHash: 'hash',
      location: { format: 'pdf', pageIndex: 0 }, text: 'needle', query: 'needle',
    })).toBeNull();
  });

  it('returns null for an AND term absent from the indexed chunk', () => {
    expect(deriveSearchTermRanges('only alpha', 'alpha missing')).toBeNull();
    expect(deriveSearchTermRanges('only alpha', '***')).toBeNull();
  });

  it('reserves distinct terms, deduplicates duplicate queries, and fills fairly in source order', () => {
    const text = `${Array.from({ length: 40 }, () => 'alpha').join(' ')} omega`;
    const result = deriveSearchTermRanges(text, 'alpha alpha omega');
    expect(result?.ranges).toHaveLength(32);
    expect(result?.ranges.at(-1)?.text).toBe('omega');
    expect(result?.ranges.filter((range) => range.text === 'alpha')).toHaveLength(31);
    expect(result?.ranges.find((range) => range.text === 'alpha')?.queryTermIndices).toEqual([0, 1]);
  });
});
