import { describe, expect, it } from 'vitest';
import {
  CHAT_WIRE_CITATIONS_PER_MESSAGE,
  CHAT_WIRE_CITATION_HEADING_MAX_LENGTH,
  CHAT_WIRE_CITATION_LABEL_MAX_LENGTH,
  CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURES_PER_MESSAGE,
  CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT,
  CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH,
  CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS,
  CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT,
  CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS,
  CHAT_WIRE_WEB_SOURCES_PER_MESSAGE,
  CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH,
} from '@shared/constants/chat-wire';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { ChatMessage, ChatStreamEvent } from '@shared/types/ai';
import {
  CHAT_MESSAGE_UNDELIVERABLE,
  assertChatTurnIdentifiers,
  projectChatMessageForWire,
  projectChatStreamEventForWire,
} from '@main/ai/chat-wire-projection';
import { isChatMessage, isChatStreamEvent } from '../../src/preload/index';

/**
 * Main's projection is the last step before a chat message leaves for the
 * renderer. Whatever storage holds, the outcome is one of two: a message the
 * preload bridge accepts, or a typed error main can report. The bridge must
 * never be handed a payload it would silently drop.
 */

const ids = {
  requestId: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e',
  sessionId: 'session-1',
  documentId: 'doc-1',
  messageId: 'msg-1',
};

const baseMessage: ChatMessage = {
  id: 'msg-1',
  sessionId: 'session-1',
  role: 'assistant',
  ordinal: 1,
  content: 'Answer',
  citations: [],
  disclosures: [],
  webSources: [],
  status: 'complete',
  requestId: ids.requestId,
  tokenCount: 9,
  errorMessage: null,
  createdAt: '2026-09-30T12:00:00.000Z',
};

/** The largest message storage can hold: every list full, every field at its bound. */
const maximumStoredMessage: ChatMessage = {
  ...baseMessage,
  content: 'x'.repeat(CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS),
  citations: Array.from({ length: CHAT_WIRE_CITATIONS_PER_MESSAGE }, (_unused, index) => ({
    sourceId: `src-${String(index)}`,
    label: 'l'.repeat(CHAT_WIRE_CITATION_LABEL_MAX_LENGTH),
    pageLabel: 'p'.repeat(CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH),
    heading: 'h'.repeat(CHAT_WIRE_CITATION_HEADING_MAX_LENGTH),
  })),
  disclosures: Array.from({ length: CHAT_WIRE_DISCLOSURES_PER_MESSAGE }, (_unused, index) => ({
    contextItemId: `ctx-${String(index)}`,
    displayLabel: 'd'.repeat(CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH),
    totalChunks: CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT,
    includedChunks: 1,
    omittedChunks: CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT - 1,
    reason: 'nearby_context_only' as const,
  })),
  webSources: Array.from({ length: CHAT_WIRE_WEB_SOURCES_PER_MESSAGE }, (_unused, index) => ({
    url: `https://example.com/${String(index)}`,
    title: 't'.repeat(CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH),
  })),
  tokenCount: CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT,
  errorMessage: 'e'.repeat(CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH),
};

function expectErrorEvent(event: ChatStreamEvent, message: string): void {
  expect(event.type).toBe('error');
  if (event.type === 'error') {
    expect(event.error).toEqual({ __interleafError: true, code: 'internal', message });
  }
}

describe('projecting a stored chat message for the wire', () => {
  it('delivers a maximum-size stored message intact, as a message and as a done event', () => {
    const projected = projectChatMessageForWire(maximumStoredMessage);
    expect(projected).toEqual(maximumStoredMessage);
    expect(isChatMessage(projected)).toBe(true);

    const event = projectChatStreamEventForWire(ids, { type: 'done', message: maximumStoredMessage });
    expect(event.type).toBe('done');
    expect(isChatStreamEvent(event)).toBe(true);
  });

  it('rejects a message past a bound with a typed safe error', () => {
    const oversized = { ...maximumStoredMessage, content: `${maximumStoredMessage.content}x` };
    expect(() => projectChatMessageForWire(oversized)).toThrow(InterleafError);
    try {
      projectChatMessageForWire(oversized);
    } catch (error) {
      expect(error).toBeInstanceOf(InterleafError);
      expect((error as InterleafError).toPayload()).toEqual({
        __interleafError: true,
        code: 'internal',
        message: CHAT_MESSAGE_UNDELIVERABLE,
      });
    }
  });

  it('turns an undeliverable done into an error event the bridge accepts', () => {
    const tooLong = { ...baseMessage, content: 'x'.repeat(CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS + 1) };
    const event = projectChatStreamEventForWire(ids, { type: 'done', message: tooLong });
    expectErrorEvent(event, CHAT_MESSAGE_UNDELIVERABLE);
    expect(isChatStreamEvent(event)).toBe(true);
    expect(event).toMatchObject(ids);
  });

  it('narrows over-long citation display text and keeps the source id', () => {
    const astral = '\u{1F600}';
    const projected = projectChatMessageForWire({
      ...baseMessage,
      citations: [{
        sourceId: 'src-7',
        // An odd bound split would leave half a surrogate pair; the cut keeps whole code points.
        label: `${'l'.repeat(CHAT_WIRE_CITATION_LABEL_MAX_LENGTH - 1)}${astral}tail`,
        pageLabel: 'p'.repeat(CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH + 1),
        heading: 'h'.repeat(CHAT_WIRE_CITATION_HEADING_MAX_LENGTH + 1),
      }],
    });
    expect(projected.citations).toEqual([{
      sourceId: 'src-7',
      label: 'l'.repeat(CHAT_WIRE_CITATION_LABEL_MAX_LENGTH - 1),
      pageLabel: 'p'.repeat(CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH),
      heading: 'h'.repeat(CHAT_WIRE_CITATION_HEADING_MAX_LENGTH),
    }]);
    expect(isChatMessage(projected)).toBe(true);
  });

  it('cuts the citation, disclosure and web-source lists to their wire counts', () => {
    const projected = projectChatMessageForWire({
      ...maximumStoredMessage,
      content: 'Answer',
      citations: [...maximumStoredMessage.citations, { sourceId: 'src-extra', label: 'Extra', pageLabel: null, heading: null }],
      disclosures: [...maximumStoredMessage.disclosures, ...maximumStoredMessage.disclosures.slice(0, 1)],
      webSources: [...maximumStoredMessage.webSources, { url: 'https://example.com/extra', title: 'Extra' }],
    });
    expect(projected.citations).toHaveLength(CHAT_WIRE_CITATIONS_PER_MESSAGE);
    expect(projected.disclosures).toHaveLength(CHAT_WIRE_DISCLOSURES_PER_MESSAGE);
    expect(projected.webSources).toHaveLength(CHAT_WIRE_WEB_SOURCES_PER_MESSAGE);
    expect(isChatMessage(projected)).toBe(true);
  });

  it('normalises a SQLite default timestamp to ISO-8601 UTC', () => {
    expect(projectChatMessageForWire({ ...baseMessage, createdAt: '2026-09-30 12:00:00' }).createdAt)
      .toBe('2026-09-30T12:00:00Z');
    expect(projectChatMessageForWire({ ...baseMessage, createdAt: '2026-09-30 12:00:00.250' }).createdAt)
      .toBe('2026-09-30T12:00:00.250Z');
  });

  it('refuses a timestamp that is neither ISO nor the SQLite default', () => {
    expect(() => projectChatMessageForWire({ ...baseMessage, createdAt: 'yesterday' })).toThrow(InterleafError);
  });

  it('drops an implausible token count rather than the message', () => {
    expect(projectChatMessageForWire({ ...baseMessage, tokenCount: CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT }).tokenCount)
      .toBe(CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT);
    expect(projectChatMessageForWire({ ...baseMessage, tokenCount: CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT + 1 }).tokenCount)
      .toBeNull();
  });

  it('cuts a long error message to the wire bound', () => {
    const projected = projectChatMessageForWire({
      ...baseMessage,
      status: 'failed',
      errorMessage: 'e'.repeat(CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH + 50),
    });
    expect(projected.errorMessage).toHaveLength(CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH);
    expect(isChatMessage(projected)).toBe(true);
  });
});

describe('projecting stream events for the wire', () => {
  it('passes a token and a valid error through unchanged', () => {
    const token = projectChatStreamEventForWire(ids, { type: 'token', token: 'Hello' });
    expect(token).toEqual({ ...ids, type: 'token', token: 'Hello' });
    expect(isChatStreamEvent(token)).toBe(true);

    const error = new InterleafError('validation', 'The provider is offline.').toPayload();
    const event = projectChatStreamEventForWire(ids, { type: 'error', error });
    expect(event).toEqual({ ...ids, type: 'error', error });
    expect(isChatStreamEvent(event)).toBe(true);
  });

  it('replaces an error payload the bridge would refuse with a generic one', () => {
    const event = projectChatStreamEventForWire(ids, {
      type: 'error',
      error: { __interleafError: true, code: 'internal', message: '' },
    });
    expectErrorEvent(event, 'The AI response could not be delivered.');
    expect(isChatStreamEvent(event)).toBe(true);
  });

  it('throws a typed safe error for an invalid envelope instead of building an event', () => {
    const invalidEnvelopes = [
      { ...ids, requestId: 'not-a-uuid' },
      { ...ids, sessionId: '' },
      { ...ids, documentId: 'd'.repeat(129) },
      { ...ids, messageId: '' },
    ];
    for (const envelope of invalidEnvelopes) {
      let thrown: Error | null = null;
      try {
        projectChatStreamEventForWire(envelope, { type: 'token', token: 'x' });
      } catch (error) {
        thrown = error instanceof Error ? error : null;
      }
      expect(thrown).toBeInstanceOf(InterleafError);
      expect((thrown as InterleafError).toPayload()).toEqual({
        __interleafError: true,
        code: 'internal',
        message: 'The AI response could not be delivered.',
      });
    }
  });

  it('turns an invalid body in a valid envelope into an error event the bridge accepts', () => {
    const event = projectChatStreamEventForWire(ids, {
      type: 'token',
      token: 'x'.repeat(CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS + 1),
    });
    expectErrorEvent(event, 'The AI response could not be delivered.');
    expect(event).toMatchObject(ids);
    expect(isChatStreamEvent(event)).toBe(true);
  });

  it('refuses turn identifiers that no event could carry before the turn starts', () => {
    const turn = { requestId: ids.requestId, sessionId: ids.sessionId, documentId: ids.documentId };
    expect(() => { assertChatTurnIdentifiers(turn); }).not.toThrow();
    expect(() => { assertChatTurnIdentifiers({ ...turn, sessionId: 's'.repeat(129) }); }).toThrow(InterleafError);
    expect(() => { assertChatTurnIdentifiers({ ...turn, requestId: 'request-1' }); }).toThrow(InterleafError);
  });
});
