import type { AIProviderStatus } from '@shared/types/ai';
import { isProviderReady, type ProviderDiscoveryState } from '../../stores/use-chat-store';

/**
 * Whether a conversation's bound provider can serve it right now.
 *
 * Returns `null` unless a current probe succeeded: while one is running, and
 * after one fails, the binding is simply not known to be usable, and reporting
 * it as unavailable would turn a pending or failed probe into a verdict about
 * the reader's setup. Retained provider objects still name the binding; they
 * never answer this question.
 */
export function sessionProviderReady(
  discovery: ProviderDiscoveryState,
  providerInfo: AIProviderStatus | undefined
): boolean | null {
  if (discovery !== 'succeeded') return null;
  return providerInfo !== undefined && isProviderReady(providerInfo);
}
