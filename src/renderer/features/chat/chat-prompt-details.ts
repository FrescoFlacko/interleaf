import type { AIProviderStatus, ChatMessage, ChatSession } from '@shared/types/ai';
import { displayProviderName, modelLabel } from './chat-labels';
import type { PromptDetailToken } from './ChatPromptDetails';

/**
 * The labelled parameters shown beside an answer's prompt: only facts the app
 * holds. Provider and model come from the conversation's binding; the source
 * counts come from the answer itself. Web sources appear only when the turn
 * actually used search.
 */
export function promptDetailTokens(
  message: ChatMessage,
  session: ChatSession | null,
  providerInfo: AIProviderStatus | undefined
): readonly PromptDetailToken[] {
  const tokens: PromptDetailToken[] = [];
  if (session !== null) {
    tokens.push({ label: 'Provider', value: displayProviderName(session.providerId, providerInfo?.name) });
    tokens.push({ label: 'Model', value: modelLabel(session.modelId, providerInfo) });
  }
  tokens.push({ label: 'Cited sources', value: String(message.citations.length) });
  const webSources = message.webSources.length;
  if (webSources > 0) tokens.push({ label: 'Web sources', value: String(webSources) });
  return tokens;
}
