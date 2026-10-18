import type { QuoteContext } from '@shared/types/annotation';

export const TEXT_ANCHOR_LIMITS = Object.freeze({
  maxExactMatches: 2_048,
  maxExactSearchChars: 2_000_000,
  maxFuzzyQuoteLength: 4_096,
  fuzzyWindowRadius: 50_000,
  maxFuzzyCandidates: 256,
  fuzzyThreshold: 0.85,
  yieldEveryCandidates: 32,
});

export type TextRangeOffsets = { readonly start: number; readonly end: number };

export type TextAnchorResolution = TextRangeOffsets & {
  readonly stage: 'native' | 'quote' | 'fuzzy';
  readonly score: number;
};

export type ResolveTextAnchorOptions = {
  readonly nativeRange?: TextRangeOffsets;
  readonly priorOffset?: number;
  readonly signal?: AbortSignal;
};

function isValidRange(text: string, range: TextRangeOffsets): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= text.length
  );
}

function contextScore(text: string, start: number, end: number, quote: QuoteContext): number {
  let score = 0;
  if (quote.prefix.length > 0) {
    const actual = text.slice(Math.max(0, start - quote.prefix.length), start);
    score += suffixSimilarity(actual, quote.prefix) * 0.4;
  }
  if (quote.suffix.length > 0) {
    const actual = text.slice(end, end + quote.suffix.length);
    score += prefixSimilarity(actual, quote.suffix) * 0.4;
  }
  return score;
}

function prefixSimilarity(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  if (limit === 0) return 0;
  let same = 0;
  while (same < limit && left[same] === right[same]) same += 1;
  return same / Math.max(left.length, right.length);
}

function suffixSimilarity(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  if (limit === 0) return 0;
  let same = 0;
  while (same < limit && left[left.length - same - 1] === right[right.length - same - 1]) same += 1;
  return same / Math.max(left.length, right.length);
}

function proximityScore(start: number, priorOffset: number | undefined, textLength: number): number {
  if (priorOffset === undefined) return 0;
  return 1 - Math.min(1, Math.abs(start - priorOffset) / Math.max(1, textLength));
}

function findBestExactMatch(
  text: string,
  quote: QuoteContext,
  priorOffset: number | undefined
): TextAnchorResolution | null {
  if (quote.exact.length === 0) return null;
  const boundedStart = text.length > TEXT_ANCHOR_LIMITS.maxExactSearchChars
    ? Math.max(
        0,
        Math.min(
          text.length - TEXT_ANCHOR_LIMITS.maxExactSearchChars,
          (priorOffset ?? 0) - Math.floor(TEXT_ANCHOR_LIMITS.maxExactSearchChars / 2)
        )
      )
    : 0;
  const boundedText = text.slice(
    boundedStart,
    Math.min(text.length, boundedStart + TEXT_ANCHOR_LIMITS.maxExactSearchChars)
  );
  let cursor = 0;
  let matches = 0;
  let best: TextAnchorResolution | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  while (cursor <= boundedText.length - quote.exact.length && matches < TEXT_ANCHOR_LIMITS.maxExactMatches) {
    const localStart = boundedText.indexOf(quote.exact, cursor);
    if (localStart < 0) break;
    const start = boundedStart + localStart;
    const end = start + quote.exact.length;
    const rank = contextScore(text, start, end, quote) + proximityScore(start, priorOffset, text.length) * 0.2;
    if (rank > bestRank) {
      bestRank = rank;
      best = { start, end, stage: 'quote', score: 1 };
    }
    matches += 1;
    cursor = localStart + Math.max(1, quote.exact.length);
  }
  return best;
}

function normalizeForFuzzy(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) {
    return left.length === right.length && left === right ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function candidateStarts(text: string, quote: string, windowStart: number, windowEnd: number, prior: number): number[] {
  const starts = new Set<number>();
  const add = (value: number): void => {
    const clamped = Math.max(windowStart, Math.min(windowEnd - quote.length, value));
    if (clamped >= windowStart && clamped + quote.length <= windowEnd) starts.add(clamped);
  };
  add(prior);
  add(windowStart);
  const probe = quote.slice(0, Math.min(16, quote.length));
  if (probe.length >= 4) {
    let cursor = windowStart;
    while (cursor < windowEnd && starts.size < TEXT_ANCHOR_LIMITS.maxFuzzyCandidates) {
      const found = text.indexOf(probe, cursor);
      if (found < 0 || found >= windowEnd) break;
      add(found);
      cursor = found + 1;
    }
  }
  const stride = Math.max(1, Math.ceil((windowEnd - windowStart) / TEXT_ANCHOR_LIMITS.maxFuzzyCandidates));
  for (let offset = windowStart; offset < windowEnd && starts.size < TEXT_ANCHOR_LIMITS.maxFuzzyCandidates; offset += stride) {
    const previousBoundary = text.lastIndexOf(' ', offset);
    add(previousBoundary >= windowStart ? previousBoundary + 1 : offset);
  }
  return [...starts].slice(0, TEXT_ANCHOR_LIMITS.maxFuzzyCandidates);
}

async function findBestFuzzyMatch(
  text: string,
  quote: QuoteContext,
  priorOffset: number | undefined,
  signal: AbortSignal | undefined
): Promise<TextAnchorResolution | null> {
  if (
    priorOffset === undefined ||
    quote.exact.length < 2 ||
    quote.exact.length > TEXT_ANCHOR_LIMITS.maxFuzzyQuoteLength
  ) {
    return null;
  }
  const safePrior = Math.max(0, Math.min(text.length, priorOffset));
  const windowStart = Math.max(0, safePrior - TEXT_ANCHOR_LIMITS.fuzzyWindowRadius);
  const windowEnd = Math.min(text.length, safePrior + TEXT_ANCHOR_LIMITS.fuzzyWindowRadius);
  if (windowEnd - windowStart < quote.exact.length) return null;

  const normalizedQuote = normalizeForFuzzy(quote.exact);
  if (normalizedQuote.length < 2) return null;
  let best: TextAnchorResolution | null = null;
  let bestRank: number = TEXT_ANCHOR_LIMITS.fuzzyThreshold;
  const starts = candidateStarts(text, quote.exact, windowStart, windowEnd, safePrior);
  for (const [index, start] of starts.entries()) {
    if (index > 0 && index % TEXT_ANCHOR_LIMITS.yieldEveryCandidates === 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    const end = start + quote.exact.length;
    const score = bigramSimilarity(normalizedQuote, normalizeForFuzzy(text.slice(start, end)));
    const rank = score + contextScore(text, start, end, quote) * 0.1 + proximityScore(start, safePrior, text.length) * 0.02;
    if (score > TEXT_ANCHOR_LIMITS.fuzzyThreshold && rank > bestRank) {
      bestRank = rank;
      best = { start, end, stage: 'fuzzy', score };
    }
  }
  return best;
}

/**
 * Resolve a text quote without retaining DOM nodes. Native offsets win, then
 * exact quote/context matching, then bounded fuzzy recovery near the prior
 * location. `null` is the explicit unanchored outcome.
 */
export async function resolveTextAnchor(
  text: string,
  quote: QuoteContext,
  options: ResolveTextAnchorOptions = {}
): Promise<TextAnchorResolution | null> {
  options.signal?.throwIfAborted();
  const nativeRange = options.nativeRange;
  if (
    nativeRange !== undefined &&
    isValidRange(text, nativeRange) &&
    text.slice(nativeRange.start, nativeRange.end) === quote.exact
  ) {
    return { ...nativeRange, stage: 'native', score: 1 };
  }
  const exact = findBestExactMatch(text, quote, options.priorOffset);
  if (exact) return exact;
  return findBestFuzzyMatch(text, quote, options.priorOffset, options.signal);
}
