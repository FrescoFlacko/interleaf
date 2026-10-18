import type { ChatSourceEnvelopeItem } from '@shared/types/ai';

/**
 * The request budget's unit of account.
 *
 * Every packing decision in the context builder and its packers is charged with
 * these two estimates, so they live apart from any one packer: the whole point
 * of an estimate is that the same one is used everywhere a budget is enforced.
 */
export function estimateChatTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * What one source costs once serialized, including its framing. The constant
 * stands for the element, attributes and separators the serializer adds around
 * the passage itself.
 */
export function estimateSourceEnvelopeTokens(source: ChatSourceEnvelopeItem): number {
  return (
    estimateChatTokens(source.excerptText) +
    estimateChatTokens(source.label) +
    (source.pageLabel ? estimateChatTokens(source.pageLabel) : 0) +
    (source.heading ? estimateChatTokens(source.heading) : 0) +
    15
  );
}
