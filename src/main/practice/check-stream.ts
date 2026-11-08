import type { PracticeCard } from '@shared/schemas/practice';
import type { AIProvider, ProviderChatRequest } from '../ai/providers/types';
import type { PracticeRepository } from './repository';

export function sourceStillCurrent(repository: PracticeRepository, card: PracticeCard): boolean {
  const latest = repository.get(card.id);
  return latest?.revision === card.revision && latest.sourceState === card.sourceState && latest.evidence === card.evidence;
}

export async function readSourceCheck(provider: AIProvider, request: ProviderChatRequest, deadline: Promise<never>, cancelled: () => boolean): Promise<string | null> {
  const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
  let result = '';
  try {
    for (let count = 0; count < 20000; count += 1) {
      const step = await Promise.race([iterator.next(), deadline]);
      if (cancelled() || step.done) return null;
      if (step.value.type === 'done') return result.trim().length > 0 ? result : null;
      result += step.value.token;
      if (result.length > 16000) return null;
    }
    return null;
  } finally { void iterator.return?.().catch(() => undefined); }
}
