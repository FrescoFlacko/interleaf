import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdownDocument } from '../../src/renderer/features/reader/adapters/markdown-parser';
import { markdownSearchNeedle, searchMarkdownBlocks } from '../../src/renderer/features/reader/adapters/markdown-search';

/**
 * The Markdown reader's text search, now its own pure module: case folding
 * that maps back to original offsets, de-duplicated ranges, heading locations,
 * archived-image alt text, the result bound and cooperative cancellation.
 */

const never = (): boolean => false;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchMarkdownBlocks', () => {
  it('folds case, including expanding foldings, and reports original offsets', async () => {
    const { blocks } = parseMarkdownDocument('# Straße\n\nThe STRASSE and the straße.');
    const matches = await searchMarkdownBlocks(blocks, 'strasse', never);
    expect(matches.map((match) => [match.location.format === 'markdown' && match.location.blockIndex, match.text])).toEqual([
      [0, 'Straße'],
      [1, 'STRASSE'],
      [1, 'straße'],
    ]);
    const heading = matches[0];
    expect(heading?.location).toMatchObject({ format: 'markdown', blockIndex: 0, characterStart: 0, characterEnd: 6, headingId: 'strae' });
    expect(heading?.prefix).toBe('');
  });

  it('searches archived images by alt text, never by their storage reference', async () => {
    const hash = 'a'.repeat(64);
    const { blocks } = parseMarkdownDocument(`![Chart \\[v2\\]](interleaf-asset:${hash}.png)`);
    expect(await searchMarkdownBlocks(blocks, 'Chart [v2]', never)).toHaveLength(1);
    expect(await searchMarkdownBlocks(blocks, 'aaaaaaaa', never)).toHaveLength(0);
  });

  it('stops at the result bound', async () => {
    const { blocks } = parseMarkdownDocument('x '.repeat(6_000));
    expect(await searchMarkdownBlocks(blocks, 'x', never)).toHaveLength(5_000);
  });

  /**
   * Counts the folded-needle scans a search performs. A work bound, not a
   * timing: each scan is one candidate occurrence examined, so enumeration
   * that ignores the result cap shows up as scans far beyond it.
   */
  function countNeedleScans(needle: string): () => number {
    const original = String.prototype.indexOf;
    let scans = 0;
    vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search: string, position?: number) {
      if (search === needle) scans += 1;
      return original.call(this, search, position);
    });
    return () => scans;
  }

  it('stops examining occurrences once the result cap is reached inside one huge block', async () => {
    // A valid fenced block: 32 lines of 32,000 matching characters (1,024,000 occurrences).
    const { blocks } = parseMarkdownDocument('```text\n' + `${'x'.repeat(32_000)}\n`.repeat(32) + '```');
    expect(blocks).toHaveLength(1);
    const scans = countNeedleScans('x');
    const matches = await searchMarkdownBlocks(blocks, 'x', never);
    expect(matches).toHaveLength(5_000);
    expect(matches.at(-1)?.textStart).toBe(4_999);
    expect(scans()).toBeLessThanOrEqual(5_000);
  });

  it('carries the remaining result budget across blocks', async () => {
    // 3,000 occurrences, then a block far larger than what is left of the cap.
    const { blocks } = parseMarkdownDocument(`${'x '.repeat(3_000)}\n\n` + '```text\n' + `${'x'.repeat(32_000)}\n`.repeat(4) + '```');
    expect(blocks).toHaveLength(2);
    const scans = countNeedleScans('x');
    const matches = await searchMarkdownBlocks(blocks, 'x', never);
    expect(matches).toHaveLength(5_000);
    expect(matches.filter((match) => match.location.format === 'markdown' && match.location.blockIndex === 1)).toHaveLength(2_000);
    expect(matches.at(-1)?.textStart).toBe(1_999);
    // Every occurrence in the first block, one exhausted scan ending it, then only what the budget allows.
    expect(scans()).toBeLessThanOrEqual(5_000 + 1);
  });

  it('counts de-duplicated original ranges against the budget when one character folds to several', async () => {
    // Each ß folds to "ss": two folded occurrences of "s" map to one original range.
    const { blocks } = parseMarkdownDocument('```text\n' + `${'ß'.repeat(32_000)}\n` + '```');
    const scans = countNeedleScans('s');
    const matches = await searchMarkdownBlocks(blocks, 's', never);
    expect(matches).toHaveLength(5_000);
    expect(matches.slice(0, 2).map((match) => [match.textStart, match.textEnd, match.text])).toEqual([[0, 1, 'ß'], [1, 2, 'ß']]);
    expect(new Set(matches.map((match) => match.id)).size).toBe(5_000);
    expect(scans()).toBeLessThanOrEqual(2 * 5_000);
  });

  it('resolves empty once a newer search supersedes it', async () => {
    const { blocks } = parseMarkdownDocument('needle');
    expect(await searchMarkdownBlocks(blocks, 'needle', () => true)).toEqual([]);
  });

  it('trims and bounds the query before any search', () => {
    expect(markdownSearchNeedle('   ')).toBe('');
    expect(markdownSearchNeedle(`  ${'q'.repeat(2_000)} `)).toHaveLength(1_024);
  });
});
