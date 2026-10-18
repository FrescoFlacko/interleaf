import { takeCodePointPrefix } from '@shared/agent-context';
import {
  CHAT_WIRE_CITATIONS_PER_MESSAGE,
  CHAT_WIRE_CITATION_HEADING_MAX_LENGTH,
  CHAT_WIRE_CITATION_LABEL_MAX_LENGTH,
  CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURES_PER_MESSAGE,
  CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH,
  CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT,
  CHAT_WIRE_WEB_SOURCES_PER_MESSAGE,
} from '@shared/constants/chat-wire';
import { InterleafError, type SerializedInterleafError } from '@shared/errors/interleaf-error';
import { chatMessageSchema, chatStreamEnvelopeSchema, chatStreamEventSchema, chatWireErrorSchema } from '@shared/schemas/chat-wire';
import type { ChatCitation, ChatMessage, ChatStreamEvent } from '@shared/types/ai';

/**
 * Main's projection of a stored chat message onto the wire contract.
 *
 * Every path that returns or pushes a chat message to the renderer goes
 * through here, and the result is checked against the same schema the preload
 * bridge applies. A message therefore either reaches the renderer or fails
 * here as a typed error; the bridge never drops one silently.
 *
 * The wire limits match storage (see `constants/chat-wire.ts`), so the
 * projection only narrows what storage does not constrain:
 * - `createdAt` is normalised to ISO-8601 UTC. The column's SQLite default,
 *   `datetime('now','utc')`, writes `YYYY-MM-DD HH:MM:SS`; current inserts
 *   always supply an ISO instant, so this only repairs rows written by default.
 * - `errorMessage` and the citation display fields (`label`, `pageLabel`,
 *   `heading`) are display text and are cut to their wire bounds on a code-point
 *   boundary. A citation label is composed from an indexed page label and
 *   heading, so a valid index can produce a label longer than the wire allows;
 *   `sourceId`, which navigation resolves, is never altered.
 * - The citation, disclosure and web-source lists are cut to their wire counts.
 *   Disclosures and web sources are already checked item by item when read.
 * - `tokenCount` is a provider-reported statistic; one beyond any real request
 *   is dropped to `null` rather than failing the message.
 */

export const CHAT_MESSAGE_UNDELIVERABLE = 'This chat message could not be delivered to the reader.';
const CHAT_EVENT_FAILED = 'The AI response could not be delivered.';

const SQLITE_UTC_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/u;

function wireTimestamp(value: string): string {
  const match = SQLITE_UTC_DATETIME.exec(value);
  return match === null ? value : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

function wireTokenCount(value: number | null): number | null {
  return value !== null && value > CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT ? null : value;
}

function wireText(value: string | null, maxLength: number): string | null {
  return value === null ? null : takeCodePointPrefix(value, maxLength);
}

function wireCitation(citation: ChatCitation): ChatCitation {
  const label = takeCodePointPrefix(citation.label, CHAT_WIRE_CITATION_LABEL_MAX_LENGTH);
  return {
    sourceId: citation.sourceId,
    label: label.length > 0 ? label : citation.sourceId,
    pageLabel: wireText(citation.pageLabel, CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH),
    heading: wireText(citation.heading, CHAT_WIRE_CITATION_HEADING_MAX_LENGTH),
  };
}

/** Projects one message, or throws a typed `internal` error it cannot be sent. */
export function projectChatMessageForWire(message: ChatMessage): ChatMessage {
  const projected: ChatMessage = {
    ...message,
    citations: message.citations.slice(0, CHAT_WIRE_CITATIONS_PER_MESSAGE).map(wireCitation),
    disclosures: message.disclosures.slice(0, CHAT_WIRE_DISCLOSURES_PER_MESSAGE),
    webSources: message.webSources.slice(0, CHAT_WIRE_WEB_SOURCES_PER_MESSAGE),
    createdAt: wireTimestamp(message.createdAt),
    tokenCount: wireTokenCount(message.tokenCount),
    errorMessage: wireText(message.errorMessage, CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH),
  };
  if (!chatMessageSchema.safeParse(projected).success) {
    throw new InterleafError('internal', CHAT_MESSAGE_UNDELIVERABLE);
  }
  return projected;
}

export type ChatStreamEventBody =
  | { readonly type: 'token'; readonly token: string }
  | { readonly type: 'done'; readonly message: ChatMessage }
  | { readonly type: 'error'; readonly error: SerializedInterleafError };

type ChatStreamEventIds = Pick<ChatStreamEvent, 'requestId' | 'sessionId' | 'documentId' | 'messageId'>;

const chatTurnIdentifiersSchema = chatStreamEnvelopeSchema.omit({ messageId: true });

/**
 * Checks the identifiers a turn's events will carry before the turn is
 * persisted, so a turn that could never name itself on the wire is refused up
 * front with a typed error instead of failing midway. The message ID is not yet
 * known here; the repository generates it as a UUID.
 */
export function assertChatTurnIdentifiers(ids: Omit<ChatStreamEventIds, 'messageId'>): void {
  if (!chatTurnIdentifiersSchema.safeParse(ids).success) {
    throw new InterleafError('internal', CHAT_EVENT_FAILED);
  }
}

function wireError(error: SerializedInterleafError): SerializedInterleafError {
  return chatWireErrorSchema.safeParse(error).success
    ? error
    : new InterleafError('internal', CHAT_EVENT_FAILED).toPayload();
}

/**
 * Builds the event main pushes for one turn.
 *
 * The identifiers are checked first: without a valid envelope no event can
 * name the turn it belongs to, so an invalid one throws a typed `internal`
 * error and nothing is sent. ChatService checks the caller-supplied
 * identifiers before a turn starts, so this is a programming error, not a
 * reachable failure. Within a valid envelope, a body that cannot be projected
 * (a `done` whose message does not fit, an oversized token) becomes a typed
 * `error` event for the same turn, so the renderer leaves its streaming state
 * instead of waiting for a message it never gets.
 */
export function projectChatStreamEventForWire(ids: ChatStreamEventIds, body: ChatStreamEventBody): ChatStreamEvent {
  if (!chatStreamEnvelopeSchema.safeParse(ids).success) {
    throw new InterleafError('internal', CHAT_EVENT_FAILED);
  }
  let event: ChatStreamEvent;
  if (body.type === 'done') {
    try {
      event = { ...ids, type: 'done', message: projectChatMessageForWire(body.message) };
    } catch (error) {
      if (!(error instanceof InterleafError)) throw error;
      event = { ...ids, type: 'error', error: error.toPayload() };
    }
  } else if (body.type === 'error') {
    event = { ...ids, type: 'error', error: wireError(body.error) };
  } else {
    event = { ...ids, type: 'token', token: body.token };
  }
  if (!chatStreamEventSchema.safeParse(event).success) {
    return { ...ids, type: 'error', error: new InterleafError('internal', CHAT_EVENT_FAILED).toPayload() };
  }
  return event;
}
