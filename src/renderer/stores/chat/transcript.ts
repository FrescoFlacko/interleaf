import type { ChatContextItem, ChatMessage, SendChatMessageResult } from '@shared/types/ai';

export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[]
): readonly ChatMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const prev = byId.get(message.id);
    if (prev && prev.content.length > message.content.length && message.content.length === 0) {
      byId.set(message.id, { ...message, content: prev.content });
    } else {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort((left, right) => left.ordinal - right.ordinal);
}

/**
 * Adds an attached item, or refreshes it in place when the main process
 * resolved the request to a context item this session already holds. Keeping
 * the position stable means a repeated attachment cannot reorder the chips.
 */
export function upsertContextItem(
  items: readonly ChatContextItem[],
  item: ChatContextItem
): readonly ChatContextItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing) => (existing.id === item.id ? item : existing));
}

/**
 * Drops context chips by identity, for the ids main reports it deleted.
 *
 * Only those ids are removed rather than the tray being emptied, so a chip the
 * reader attached while the request was in flight survives.
 */
export function withoutContextItems(
  items: readonly ChatContextItem[],
  removedIds: readonly string[]
): readonly ChatContextItem[] {
  if (removedIds.length === 0) return items;
  const removed = new Set(removedIds);
  return items.filter((item) => !removed.has(item.id));
}

export function mergeContextItems(
  loaded: readonly ChatContextItem[],
  current: readonly ChatContextItem[]
): readonly ChatContextItem[] {
  const byId = new Map(loaded.map((item) => [item.id, item]));
  for (const item of current) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** Streaming placeholders left by a different request are not this turn's. */
export function withoutEarlyPlaceholders(
  messages: readonly ChatMessage[],
  result: SendChatMessageResult,
): readonly ChatMessage[] {
  return messages.filter(
    (message) =>
      message.id === result.assistantMessage.id ||
      message.requestId !== result.requestId ||
      message.status !== 'streaming',
  );
}

/**
 * The transcript once a turn has completed.
 *
 * Early tokens may already have created an assistant placeholder, so the final
 * message keeps whatever text streamed into it, and placeholders left behind by
 * a different request are dropped rather than shown as stuck streams.
 */
export function transcriptWithCompletedTurn(
  messages: readonly ChatMessage[],
  result: SendChatMessageResult,
): readonly ChatMessage[] {
  const existingAssistant = messages.find((message) => message.id === result.assistantMessage.id);
  const streamed = existingAssistant !== undefined && existingAssistant.content.length > 0;
  const mergedAssistant: ChatMessage = streamed
    ? { ...result.assistantMessage, content: existingAssistant.content }
    : result.assistantMessage;
  return mergeMessages(withoutEarlyPlaceholders(messages, result), [result.userMessage, mergedAssistant]);
}
