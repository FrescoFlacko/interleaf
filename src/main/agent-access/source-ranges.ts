/** Compare any claimed range to the indexed chunk's native start, when both exist. */
export function sourceRangeMatches(start: number | undefined, end: number | undefined,
  chunkStart: number | undefined, quoteOffset: number, quoteLength: number): boolean {
  if (start === undefined || end === undefined || chunkStart === undefined) return true;
  return start === chunkStart + quoteOffset && end === start + quoteLength;
}
