import type { ChatMessage, ChatStreamEvent, SendChatMessageResult } from '@shared/types/ai';
import { bridge } from '../app/api-client';
import { chatDocumentId, moveTurn, type ChatRuntime } from './chat-runtime';
import { syncSessionSummary } from './chat-session-summaries';
import { mergeMessages, withoutEarlyPlaceholders } from './chat-transcript';
import type { TerminalStreamEvent } from './chat-turns';

type TokenStreamEvent = Extract<ChatStreamEvent, { type: 'token' }>;

/** One acknowledged turn, as the early-terminal handling refers to it. */
export type AcknowledgedTurn = {
  readonly result: SendChatMessageResult;
  readonly sessionId: string;
  readonly trimmed: string;
  readonly turn: number;
};

/**
 * Routes one event from main's chat stream.
 *
 * Only the document and conversation in view are considered; within them, the
 * turn model decides whether the event belongs to the turn in flight. With no
 * turn in flight, or for a request id the turn does not follow, the event is
 * stale or hostile and must never materialize as assistant content.
 */
export function handleStreamEvent(runtime: ChatRuntime, event: ChatStreamEvent): void {
  const state = runtime.get();
  if (chatDocumentId(state) !== event.documentId || state.activeSessionId !== event.sessionId) return;
  const route = runtime.turns.route(event);
  if (route === 'ignore') return;
  if (event.type === 'token') {
    applyToken(runtime, event);
    return;
  }
  // Nothing terminal is acted on until the turn's own invoke has come back: the
  // request id alone does not carry the submitted prompt or the persisted
  // messages this has to settle against.
  if (route === 'buffer') {
    runtime.turns.apply({ type: 'buffer-terminal', event });
    return;
  }
  settleStreamedTurn(runtime, event);
}

/** A token names the request while the invoke is out, and extends its answer. */
function applyToken(runtime: ChatRuntime, event: TokenStreamEvent): void {
  moveTurn(runtime, { type: 'reveal', requestId: event.requestId }, (current) => {
    const existing = current.messages.find((message) => message.id === event.messageId);
    if (existing) {
      return {
        messages: current.messages.map((message) =>
          message.id === event.messageId ? { ...message, content: message.content + event.token } : message
        ),
      };
    }
    const placeholder: ChatMessage = {
      id: event.messageId,
      sessionId: event.sessionId,
      role: 'assistant',
      ordinal: current.messages.length,
      content: event.token,
      citations: [],
      disclosures: [],
      webSources: [],
      status: 'streaming',
      requestId: event.requestId,
      tokenCount: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    };
    return { messages: [...current.messages, placeholder] };
  });
}

function settleStreamedTurn(runtime: ChatRuntime, event: TerminalStreamEvent): void {
  const turn = runtime.turns.phase.turn;
  if (event.type === 'done') {
    runtime.drafts.forgetSubmittedPrompt(event.requestId);
    moveTurn(runtime, { type: 'settle', turn, outcome: 'completed' }, (current) => ({
      messages: mergeMessages(current.messages, [event.message]),
      statusMessage: '',
    }));
    syncSessionSummary(runtime, event.sessionId);
    return;
  }
  // Reached only for the document and session this event belongs to, which were
  // both checked above, so the recovered prompt can never surface in another
  // conversation.
  const abandonedPrompt = runtime.drafts.takeSubmittedPrompt(event.requestId);
  moveTurn(runtime, { type: 'settle', turn, outcome: 'failed' }, {
    error: event.error.message,
    statusMessage: '',
    ...(abandonedPrompt === null ? {} : { lastFailedDraft: abandonedPrompt }),
  });
  refreshFailedTranscript(runtime, event.sessionId, turn);
  syncSessionSummary(runtime, event.sessionId);
}

/**
 * Applies a terminal event that arrived before the send call resolved.
 *
 * The stream can finish or fail before the invoke that started it returns, so
 * the event is held and replayed here against the turn it belongs to, once the
 * acknowledgement has supplied the canonical messages and the submitted words.
 */
export function settleEarlyTerminal(runtime: ChatRuntime, event: TerminalStreamEvent, acked: AcknowledgedTurn): void {
  const { result, sessionId, trimmed, turn } = acked;
  runtime.drafts.forgetSubmittedPrompt(result.requestId);
  if (event.type === 'done') {
    // The answer arrived early: it replaces this request's streaming placeholders.
    moveTurn(runtime, { type: 'settle', turn, outcome: 'completed' }, (current) => ({
      messages: mergeMessages(withoutEarlyPlaceholders(current.messages, result), [result.userMessage, event.message]),
      statusMessage: '',
    }));
    syncSessionSummary(runtime, sessionId);
    return;
  }
  const message = event.error.message;
  moveTurn(runtime, { type: 'settle', turn, outcome: 'failed' }, (current) => ({
    messages: mergeMessages(current.messages, [
      result.userMessage,
      { ...result.assistantMessage, status: 'failed', errorMessage: message },
    ]),
    error: message,
    statusMessage: '',
    // The turn never produced an answer, so the reader keeps the words they
    // submitted rather than having to retype them.
    lastFailedDraft: trimmed,
  }));
  refreshFailedTranscript(runtime, sessionId, turn);
  syncSessionSummary(runtime, sessionId);
}

/**
 * Re-reads a failed turn's transcript so it shows what main persisted, unless
 * the reader has moved on or started another turn in the meantime.
 */
function refreshFailedTranscript(runtime: ChatRuntime, sessionId: string, turn: number): void {
  void bridge.chat.listMessages(sessionId).then((messages) => {
    if (runtime.get().activeSessionId === sessionId && runtime.turns.isSettledAt(turn)) {
      runtime.set({ messages });
    }
  });
}
