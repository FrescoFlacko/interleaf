import { z } from 'zod';
import { CHAT_MESSAGE_STATUSES } from '../constants/ai';
import {
  CHAT_WIRE_CITATIONS_PER_MESSAGE,
  CHAT_WIRE_CITATION_HEADING_MAX_LENGTH,
  CHAT_WIRE_CITATION_LABEL_MAX_LENGTH,
  CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH,
  CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURES_PER_MESSAGE,
  CHAT_WIRE_DISCLOSURE_INCLUDED_LABEL_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH,
  CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT,
  CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH,
  CHAT_WIRE_IDENTIFIER_MAX_LENGTH,
  CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS,
  CHAT_WIRE_MESSAGE_MAX_ORDINAL,
  CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT,
  CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS,
  CHAT_WIRE_TIMESTAMP_MAX_LENGTH,
  CHAT_WIRE_TIMESTAMP_PATTERN,
  CHAT_WIRE_WEB_SOURCES_PER_MESSAGE,
  CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH,
  CHAT_WIRE_WEB_SOURCE_URL_MAX_LENGTH,
} from '../constants/chat-wire';
import { INTERLEAF_ERROR_CODES } from '../errors/interleaf-error';

/**
 * The wire contract for chat messages and stream events. Main validates what it
 * sends with these schemas and the preload bridge validates what it receives
 * with the very same ones, so there is one definition per payload. Every bound
 * comes from `constants/chat-wire.ts`.
 *
 * None of these schemas transforms or defaults, so a value they accept already
 * is the domain type the preload guard narrows it to
 * (`src/preload/wire-guards.ts`).
 */

const identifierSchema = z.string().min(1).max(CHAT_WIRE_IDENTIFIER_MAX_LENGTH);
const requestIdSchema = z.uuid();

/** An ISO-8601 UTC instant as main writes it; anything else is not a timestamp. */
const chatWireTimestampSchema = z
  .string()
  .max(CHAT_WIRE_TIMESTAMP_MAX_LENGTH)
  .regex(CHAT_WIRE_TIMESTAMP_PATTERN)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Timestamp is not a valid instant.');

export const chatCitationSchema = z.object({
  sourceId: z.string().min(1).max(CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH),
  label: z.string().min(1).max(CHAT_WIRE_CITATION_LABEL_MAX_LENGTH),
  pageLabel: z.string().max(CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH).nullable(),
  heading: z.string().max(CHAT_WIRE_CITATION_HEADING_MAX_LENGTH).nullable(),
}).strict();

/**
 * One source the bound provider's own hosted search returned for a turn,
 * validated as metadata rather than as message text. Bounds mirror what the
 * OpenRouter provider already enforces when it parses a `url_citation`
 * annotation.
 *
 * It is deliberately typed rather than folded into `ChatMessage.content`:
 * `content` is the model-authored transcript that later turns replay back to
 * the model under the `assistant` role, and an untrusted webpage title must
 * never enter it.
 */
export const chatWebSourceSchema = z.object({
  url: z.string().min(1).max(CHAT_WIRE_WEB_SOURCE_URL_MAX_LENGTH),
  title: z.string().min(1).max(CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH),
}).strict();

const chunkCountSchema = z.number().int().min(0).max(CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT);

/**
 * A disclosure the bridge does not recognise fails the whole message, so the
 * reason list here is the one main attaches; adding a reason means adding it
 * here, and the bridge follows automatically.
 */
export const chatContextDisclosureSchema = z.object({
  contextItemId: identifierSchema,
  displayLabel: z.string().min(1).max(CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH),
  totalChunks: chunkCountSchema,
  includedChunks: chunkCountSchema,
  omittedChunks: chunkCountSchema,
  reason: z.enum([
    'model_context_window',
    'max_sources_per_request',
    'boundary_over_inclusion',
    /**
     * An explicitly pinned whole document was larger than this model could
     * hold, so only a bounded band of context around the reader's current
     * location was sent. Without this the turn would read as if the whole
     * document had been supplied.
     */
    'nearby_context_only',
  ]),
  /**
   * Where in the document the included context actually came from, in the
   * format's own units — `Pages 148–159` for a PDF.
   *
   * Absent whenever the format has no page numbering, or the packed band
   * carried no page labels to report: a band the reader cannot be told the
   * position of is left unstated rather than described in units that do not
   * apply to their document.
   */
  includedLabel: z.string().min(1).max(CHAT_WIRE_DISCLOSURE_INCLUDED_LABEL_MAX_LENGTH).exactOptional(),
}).strict();

export const chatWireErrorSchema = z.object({
  __interleafError: z.literal(true),
  code: z.enum(INTERLEAF_ERROR_CODES),
  message: z.string().min(1).max(CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH),
}).strict();

export const chatMessageSchema = z.object({
  id: identifierSchema,
  sessionId: identifierSchema,
  role: z.enum(['user', 'assistant', 'system']),
  ordinal: z.number().int().min(0).max(CHAT_WIRE_MESSAGE_MAX_ORDINAL),
  /** Model-authored text only. This is the sole field replayed as history. */
  content: z.string().max(CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS),
  citations: z.array(chatCitationSchema).max(CHAT_WIRE_CITATIONS_PER_MESSAGE),
  /** Empty when the turn's context was sent in full. */
  disclosures: z.array(chatContextDisclosureSchema).max(CHAT_WIRE_DISCLOSURES_PER_MESSAGE),
  /** Provider search metadata, rendered and stored beside `content`; empty when none. */
  webSources: z.array(chatWebSourceSchema).max(CHAT_WIRE_WEB_SOURCES_PER_MESSAGE),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  requestId: requestIdSchema.nullable(),
  tokenCount: z.number().int().min(0).max(CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT).nullable(),
  errorMessage: z.string().max(CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH).nullable(),
  createdAt: chatWireTimestampSchema,
}).strict();

const streamBase = {
  requestId: requestIdSchema,
  sessionId: identifierSchema,
  documentId: identifierSchema,
  messageId: identifierSchema,
};

/** The identifiers every stream event carries, whatever its body. */
export const chatStreamEnvelopeSchema = z.object(streamBase).strict();

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...streamBase, type: z.literal('token'), token: z.string().max(CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS) }).strict(),
  z.object({ ...streamBase, type: z.literal('done'), message: chatMessageSchema }).strict(),
  z.object({ ...streamBase, type: z.literal('error'), error: chatWireErrorSchema }).strict(),
]);

/**
 * Tells the renderer a conversation's stored title changed without a request of
 * its own (automatic naming). It carries identifiers only: the renderer re-reads
 * the title through the document-scoped session lookup, never from this event.
 */
export const chatSessionTitleChangedEventSchema = z.object({
  sessionId: identifierSchema,
  documentId: identifierSchema,
}).strict();
