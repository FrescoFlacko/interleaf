import {
  CHAT_MAX_SOURCES_PER_REQUEST,
  CHAT_RESPONSE_MAX_TEXT_UNITS,
  CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS,
} from './ai';

/**
 * The single set of limits for a chat message, citation and stream event as
 * they cross main → preload → renderer.
 *
 * `chatMessageSchema` and `chatStreamEventSchema` (`schemas/chat-wire.ts`) are
 * built from these and nothing else, and the preload bridge validates pushed
 * events with those same schemas, so the producer and the bridge cannot drift.
 *
 * Transport deliberately matches storage rather than narrowing it. Every byte
 * of an assistant reply has already crossed the bridge as `token` events by the
 * time the `done` message arrives, and history is listed in full, so a smaller
 * transport cap would not bound what the renderer holds; it would only make the
 * final message disagree with the streamed text, or be dropped. The limits that
 * storage itself does not enforce — ordinal, token count, timestamp format —
 * are applied by main's projection (`src/main/ai/chat-wire-projection.ts`)
 * before anything is sent.
 */

export const CHAT_WIRE_IDENTIFIER_MAX_LENGTH = 128;

/** Content may be as long as the longest reply main will store. */
export const CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS = CHAT_RESPONSE_MAX_TEXT_UNITS;
export const CHAT_WIRE_MESSAGE_MAX_ORDINAL = 1_000_000;
export const CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT = 10_000_000;
export const CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH = 2_000;
/** `createdAt` and other wire timestamps: `YYYY-MM-DDTHH:MM:SS[.sss]Z`. */
export const CHAT_WIRE_TIMESTAMP_MAX_LENGTH = 64;
export const CHAT_WIRE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/** One citation per distinct source a single request can carry. */
export const CHAT_WIRE_CITATIONS_PER_MESSAGE = CHAT_MAX_SOURCES_PER_REQUEST;
export const CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH = 128;
export const CHAT_WIRE_CITATION_LABEL_MAX_LENGTH = 500;
export const CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH = 256;
export const CHAT_WIRE_CITATION_HEADING_MAX_LENGTH = 2_000;

export const CHAT_WIRE_DISCLOSURES_PER_MESSAGE = 500;
export const CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH = 500;
export const CHAT_WIRE_DISCLOSURE_INCLUDED_LABEL_MAX_LENGTH = 200;
/** Chunk counts describe a whole indexed document, which can be very large. */
export const CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT = 10_000_000;

export const CHAT_WIRE_WEB_SOURCES_PER_MESSAGE = CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS;
export const CHAT_WIRE_WEB_SOURCE_URL_MAX_LENGTH = 2_048;
export const CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH = 120;

/** One `token` event; main splits longer provider chunks to fit. */
export const CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS = 65_536;
