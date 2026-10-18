import { describe, expect, it } from 'vitest';
import { resolveTextAnchor, TEXT_ANCHOR_LIMITS } from '../../src/renderer/features/reader/annotations/text-anchor-resolver';

describe('resolveTextAnchor', () => {
  it('prefers a valid format-native range', async () => {
    await expect(
      resolveTextAnchor('before exact after', { exact: 'exact', prefix: 'before ', suffix: ' after' }, {
        nativeRange: { start: 7, end: 12 },
        priorOffset: 7,
      })
    ).resolves.toMatchObject({ start: 7, end: 12, stage: 'native', score: 1 });
  });

  it('uses context and prior location to rank duplicate exact quotes', async () => {
    const text = 'wrong quote context. The right quote context.';
    await expect(
      resolveTextAnchor(text, { exact: 'quote', prefix: 'The right ', suffix: ' context.' }, { priorOffset: 30 })
    ).resolves.toMatchObject({ start: text.lastIndexOf('quote'), stage: 'quote' });
  });

  it('recovers a bounded fuzzy quote above the strict threshold', async () => {
    const text = `${'x'.repeat(100)}The quick brown fox jumps over the very lazy dog.${'y'.repeat(100)}`;
    const resolved = await resolveTextAnchor(
      text,
      { exact: 'The quick brown fox jumps over the lazy dog.', prefix: '', suffix: '' },
      { priorOffset: 100 }
    );
    expect(resolved?.stage).toBe('fuzzy');
    expect(resolved?.score).toBeGreaterThan(TEXT_ANCHOR_LIMITS.fuzzyThreshold);
  });

  it('does not search fuzzily without a prior location or for oversized quotes', async () => {
    await expect(
      resolveTextAnchor('A similar quotf', { exact: 'A similar quote', prefix: '', suffix: '' })
    ).resolves.toBeNull();
    await expect(
      resolveTextAnchor('x'.repeat(10_000), {
        exact: 'y'.repeat(TEXT_ANCHOR_LIMITS.maxFuzzyQuoteLength + 1),
        prefix: '',
        suffix: '',
      }, { priorOffset: 0 })
    ).resolves.toBeNull();
  });

  it('bounds exact recovery around the prior location in very large text', async () => {
    const padding = 'x'.repeat(TEXT_ANCHOR_LIMITS.maxExactSearchChars + 100);
    const text = `target${padding}target`;
    const nearEnd = await resolveTextAnchor(
      text,
      { exact: 'target', prefix: '', suffix: '' },
      { priorOffset: text.length - 6 }
    );
    expect(nearEnd?.start).toBe(text.length - 6);
  });

  it('returns unanchored for low-confidence candidates and supports cancellation', async () => {
    await expect(
      resolveTextAnchor('completely unrelated material', { exact: 'target quotation', prefix: '', suffix: '' }, { priorOffset: 0 })
    ).resolves.toBeNull();

    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveTextAnchor('target', { exact: 'target', prefix: '', suffix: '' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
