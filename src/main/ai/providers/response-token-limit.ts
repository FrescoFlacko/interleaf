import type { ProviderChatRequest } from './types';

/** The response-token limit an HTTP adapter sends: the request's cap, never above the model's. */
export function responseTokenLimit(request: ProviderChatRequest, modelMaxOutputTokens: number): number {
  const cap = request.maxResponseTokens;
  if (cap === undefined || !Number.isSafeInteger(cap) || cap < 1) return modelMaxOutputTokens;
  return Math.min(cap, modelMaxOutputTokens);
}
