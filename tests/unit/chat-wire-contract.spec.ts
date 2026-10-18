import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
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
  CHAT_WIRE_WEB_SOURCES_PER_MESSAGE,
  CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH,
  CHAT_WIRE_WEB_SOURCE_URL_MAX_LENGTH,
} from '@shared/constants/chat-wire';
import { chatCitationSchema, chatMessageSchema, chatStreamEventSchema } from '@shared/schemas/chat-wire';
import {
  AGENT_EVENT_ERROR_CODE_MAX_LENGTH,
  AGENT_EVENT_ERROR_MESSAGE_MAX_LENGTH,
  AGENT_EVENT_EXIT_CODE_LIMIT,
  AGENT_EVENT_IDENTIFIER_MAX_LENGTH,
  AGENT_EVENT_MAX_ORDINAL,
  AGENT_EVENT_SIGNAL_MAX_LENGTH,
  AGENT_EVENT_TEXT_MAX_LENGTH,
  AGENT_EVENT_TIMESTAMP_MAX_LENGTH,
  AGENT_EVENT_VALUE_MAX_DEPTH,
  AGENT_EVENT_VALUE_MAX_ENTRIES,
  AGENT_EVENT_VALUE_MAX_KEY_LENGTH,
  AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH,
  AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH,
} from '@shared/constants/agent-wire';
import { agentEventSchema, fitsAgentEventWireBound } from '@shared/schemas/agent';
import type { CloneableValue } from '@shared/models/portable';
import { isAgentEvent, isChatCitation, isChatMessage, isChatStreamEvent } from '../../src/preload/index';

/**
 * Equivalence between main's wire schemas and the preload guards.
 *
 * One fixture table drives both sides: every row is parsed by the shared schema
 * and checked by the guard the bridge actually installs, and the two must agree
 * with the expected verdict. Every bound appears at its exact limit (accepted)
 * and one past it (refused), so a guard that drifts from the schema in either
 * direction fails here.
 */

type WireCase = {
  readonly name: string;
  readonly payload: CloneableValue;
  readonly accepted: boolean;
};

const text = (length: number, unit = 'x'): string => unit.repeat(length);
const list = <T extends CloneableValue>(length: number, item: (index: number) => T): T[] =>
  Array.from({ length }, (_unused, index) => item(index));

/** A case at the limit and one past it, built by the same function. */
function atLimit(name: string, limit: number, build: (size: number) => CloneableValue): WireCase[] {
  return [
    { name: `${name} at ${String(limit)}`, payload: build(limit), accepted: true },
    { name: `${name} at ${String(limit + 1)}`, payload: build(limit + 1), accepted: false },
  ];
}

const citation = {
  sourceId: 'src-1',
  label: 'Page 1',
  pageLabel: '1',
  heading: 'Replication',
};

const disclosure = {
  contextItemId: 'ctx-1',
  displayLabel: 'Entire document',
  totalChunks: 400,
  includedChunks: 11,
  omittedChunks: 389,
  reason: 'nearby_context_only',
  includedLabel: 'Pages 1–11',
};

const webSource = { url: 'https://example.com/a', title: 'Example' };

const message = {
  id: 'msg-1',
  sessionId: 'session-1',
  role: 'assistant',
  ordinal: 1,
  content: 'Answer [src-1]',
  citations: [citation],
  disclosures: [disclosure],
  webSources: [webSource],
  status: 'complete',
  requestId: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e',
  tokenCount: 9,
  errorMessage: null,
  createdAt: '2026-09-30T12:00:00.000Z',
};

function messageWithout(keys: readonly string[]): CloneableValue {
  return Object.fromEntries(Object.entries(message).filter(([key]) => !keys.includes(key)));
}

const streamIds = {
  requestId: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e',
  sessionId: 'session-1',
  documentId: 'doc-1',
  messageId: 'msg-1',
};

const wireError = { __interleafError: true, code: 'internal', message: 'The provider failed.' };

const citationCases: WireCase[] = [
  { name: 'a valid citation', payload: citation, accepted: true },
  { name: 'a citation with null page and heading', payload: { ...citation, pageLabel: null, heading: null }, accepted: true },
  { name: 'a citation with an unknown member', payload: { ...citation, extra: 1 }, accepted: false },
  { name: 'a citation with an empty source id', payload: { ...citation, sourceId: '' }, accepted: false },
  ...atLimit('citation sourceId', CHAT_WIRE_CITATION_SOURCE_ID_MAX_LENGTH, (n) => ({ ...citation, sourceId: text(n) })),
  ...atLimit('citation label', CHAT_WIRE_CITATION_LABEL_MAX_LENGTH, (n) => ({ ...citation, label: text(n) })),
  ...atLimit('citation pageLabel', CHAT_WIRE_CITATION_PAGE_LABEL_MAX_LENGTH, (n) => ({ ...citation, pageLabel: text(n) })),
  ...atLimit('citation heading', CHAT_WIRE_CITATION_HEADING_MAX_LENGTH, (n) => ({ ...citation, heading: text(n) })),
];

const withDisclosure = (patch: Readonly<Record<string, CloneableValue>>): CloneableValue => ({ ...message, disclosures: [{ ...disclosure, ...patch }] });

const messageCases: WireCase[] = [
  { name: 'a valid message', payload: message, accepted: true },
  { name: 'a message whose disclosure and web-source lists are empty', payload: { ...message, disclosures: [], webSources: [] }, accepted: true },
  { name: 'a message without its disclosure and web-source lists', payload: messageWithout(['disclosures', 'webSources']), accepted: false },
  { name: 'a message with an unknown member', payload: { ...message, extra: true }, accepted: false },
  { name: 'a message with an unknown status', payload: { ...message, status: 'pending' }, accepted: false },
  { name: 'a message with a negative ordinal', payload: { ...message, ordinal: -1 }, accepted: false },
  { name: 'a message with a non-uuid request id', payload: { ...message, requestId: 'req-1' }, accepted: false },
  { name: 'a message with a SQLite timestamp', payload: { ...message, createdAt: '2026-09-30 12:00:00' }, accepted: false },
  { name: 'a message with an impossible date', payload: { ...message, createdAt: '2026-13-45T99:00:00Z' }, accepted: false },
  { name: 'a message with a second-precision timestamp', payload: { ...message, createdAt: '2026-09-30T12:00:00Z' }, accepted: true },
  { name: 'a message whose timestamp exceeds its bound', payload: { ...message, createdAt: `2026-09-30T12:00:00.000Z${text(CHAT_WIRE_TIMESTAMP_MAX_LENGTH)}` }, accepted: false },
  ...atLimit('message id', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => ({ ...message, id: text(n) })),
  ...atLimit('message sessionId', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => ({ ...message, sessionId: text(n) })),
  ...atLimit('message ordinal', CHAT_WIRE_MESSAGE_MAX_ORDINAL, (n) => ({ ...message, ordinal: n })),
  ...atLimit('message content', CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS, (n) => ({ ...message, content: text(n) })),
  ...atLimit('message tokenCount', CHAT_WIRE_MESSAGE_MAX_TOKEN_COUNT, (n) => ({ ...message, tokenCount: n })),
  ...atLimit('message errorMessage', CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH, (n) => ({ ...message, errorMessage: text(n) })),
  ...atLimit('message citations', CHAT_WIRE_CITATIONS_PER_MESSAGE, (n) => ({ ...message, citations: list(n, () => citation) })),
  ...atLimit('message disclosures', CHAT_WIRE_DISCLOSURES_PER_MESSAGE, (n) => ({ ...message, disclosures: list(n, () => disclosure) })),
  ...atLimit('message webSources', CHAT_WIRE_WEB_SOURCES_PER_MESSAGE, (n) => ({ ...message, webSources: list(n, () => webSource) })),
  ...atLimit('disclosure contextItemId', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => withDisclosure({ contextItemId: text(n) })),
  ...atLimit('disclosure displayLabel', CHAT_WIRE_DISCLOSURE_LABEL_MAX_LENGTH, (n) => withDisclosure({ displayLabel: text(n) })),
  ...atLimit('disclosure includedLabel', CHAT_WIRE_DISCLOSURE_INCLUDED_LABEL_MAX_LENGTH, (n) => withDisclosure({ includedLabel: text(n) })),
  ...atLimit('disclosure totalChunks', CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT, (n) => withDisclosure({ totalChunks: n })),
  ...atLimit('disclosure includedChunks', CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT, (n) => withDisclosure({ includedChunks: n })),
  ...atLimit('disclosure omittedChunks', CHAT_WIRE_DISCLOSURE_MAX_CHUNK_COUNT, (n) => withDisclosure({ omittedChunks: n })),
  { name: 'a disclosure with an unknown reason', payload: withDisclosure({ reason: 'because' }), accepted: false },
  ...atLimit('web source url', CHAT_WIRE_WEB_SOURCE_URL_MAX_LENGTH, (n) => ({ ...message, webSources: [{ ...webSource, url: text(n) }] })),
  ...atLimit('web source title', CHAT_WIRE_WEB_SOURCE_TITLE_MAX_LENGTH, (n) => ({ ...message, webSources: [{ ...webSource, title: text(n) }] })),
  ...atLimit('message citation label', CHAT_WIRE_CITATION_LABEL_MAX_LENGTH, (n) => ({ ...message, citations: [{ ...citation, label: text(n) }] })),
];

const streamCases: WireCase[] = [
  { name: 'a token event', payload: { ...streamIds, type: 'token', token: 'Hello' }, accepted: true },
  { name: 'a done event', payload: { ...streamIds, type: 'done', message }, accepted: true },
  { name: 'an error event', payload: { ...streamIds, type: 'error', error: wireError }, accepted: true },
  { name: 'an unknown event type', payload: { ...streamIds, type: 'progress' }, accepted: false },
  { name: 'an event with an unknown member', payload: { ...streamIds, type: 'token', token: 'x', extra: 1 }, accepted: false },
  { name: 'an event with a non-uuid request id', payload: { ...streamIds, requestId: 'req', type: 'token', token: 'x' }, accepted: false },
  { name: 'an error with an unknown code', payload: { ...streamIds, type: 'error', error: { ...wireError, code: 'made-up' } }, accepted: false },
  { name: 'an error with an empty message', payload: { ...streamIds, type: 'error', error: { ...wireError, message: '' } }, accepted: false },
  { name: 'an error with extra members', payload: { ...streamIds, type: 'error', error: { ...wireError, stack: 'at x' } }, accepted: false },
  { name: 'a done event whose message is invalid', payload: { ...streamIds, type: 'done', message: { ...message, status: 'pending' } }, accepted: false },
  ...atLimit('token text', CHAT_WIRE_STREAM_TOKEN_MAX_TEXT_UNITS, (n) => ({ ...streamIds, type: 'token', token: text(n) })),
  ...atLimit('stream sessionId', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => ({ ...streamIds, sessionId: text(n), type: 'token', token: 'x' })),
  ...atLimit('stream documentId', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => ({ ...streamIds, documentId: text(n), type: 'token', token: 'x' })),
  ...atLimit('stream messageId', CHAT_WIRE_IDENTIFIER_MAX_LENGTH, (n) => ({ ...streamIds, messageId: text(n), type: 'token', token: 'x' })),
  ...atLimit('stream error message', CHAT_WIRE_ERROR_MESSAGE_MAX_LENGTH, (n) => ({ ...streamIds, type: 'error', error: { ...wireError, message: text(n) } })),
  ...atLimit('done message content', CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS, (n) => ({ ...streamIds, type: 'done', message: { ...message, content: text(n) } })),
  ...atLimit('done message citations', CHAT_WIRE_CITATIONS_PER_MESSAGE, (n) => ({ ...streamIds, type: 'done', message: { ...message, citations: list(n, () => citation) } })),
];

const agentEvent = { sessionId: 'agent-session', ordinal: 0, timestamp: '2026-09-30T12:00:00.000Z' };
const structured = (data: CloneableValue): CloneableValue => ({ ...agentEvent, type: 'structured', data });
const withError = (error: CloneableValue): CloneableValue => ({ ...agentEvent, type: 'error', error });

/** A record whose single chain of `a` members puts a leaf `depth` levels below it. */
const nested = (depth: number): CloneableValue => (depth === 0 ? 'x' : { a: nested(depth - 1) });
const keyed = (count: number, prefix = 'k'): Record<string, CloneableValue> =>
  Object.fromEntries(list(count, (index) => [`${prefix}${String(index)}`, 0] as const));
/** `{"v":""}` wraps the padding string in eight characters of JSON. */
const DATA_ENVELOPE = JSON.stringify({ v: '' }).length;
const ERROR_ENVELOPE = JSON.stringify({ ...wireError, pad: '' }).length;
const ERROR_MEMBERS = Object.keys(wireError).length;
/** `YYYY-MM-DDTHH:MM:SS.` plus `Z`: the timestamp without its fractional digits. */
const timestampOfLength = (length: number): string => `2026-09-30T12:00:00.${'1'.repeat(length - 21)}Z`;

/**
 * The largest event the member bounds admit: an `error` event, the type with
 * the most payload, every member at its bound and every string unit one JSON
 * escapes to six characters.
 */
const ESCAPED = '\u0000';
const maximalAgentEvent = {
  sessionId: text(AGENT_EVENT_IDENTIFIER_MAX_LENGTH, ESCAPED),
  ordinal: AGENT_EVENT_MAX_ORDINAL,
  type: 'error',
  timestamp: timestampOfLength(AGENT_EVENT_TIMESTAMP_MAX_LENGTH),
  text: text(AGENT_EVENT_TEXT_MAX_LENGTH, ESCAPED),
  error: { ...wireError, pad: text(AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH - ERROR_ENVELOPE) },
};

const agentCases: WireCase[] = [
  { name: 'a started event', payload: { ...agentEvent, type: 'started' }, accepted: true },
  { name: 'a started event with a payload', payload: { ...agentEvent, type: 'started', text: 'Launching', data: { pid: 42 } }, accepted: false },
  { name: 'a cancelled event with a payload', payload: { ...agentEvent, type: 'cancelled', text: 'Stopped by the user', data: { reason: 'user' } }, accepted: false },
  { name: 'a stdout event', payload: { ...agentEvent, type: 'stdout', stream: 'stdout', text: 'ok' }, accepted: true },
  { name: 'a stdout event on the wrong stream', payload: { ...agentEvent, type: 'stdout', stream: 'stderr', text: 'ok' }, accepted: false },
  { name: 'a final event without text', payload: { ...agentEvent, type: 'final' }, accepted: false },
  { name: 'a structured event with data', payload: structured({ kind: 'tool' }), accepted: true },
  { name: 'a structured event without data', payload: { ...agentEvent, type: 'structured' }, accepted: false },
  { name: 'an ended event', payload: { ...agentEvent, type: 'ended', exitCode: 0, signal: null }, accepted: true },
  { name: 'an ended event without a signal', payload: { ...agentEvent, type: 'ended', exitCode: 0 }, accepted: false },
  { name: 'an error event', payload: withError(wireError), accepted: true },
  { name: 'an error event with readable text', payload: { ...agentEvent, type: 'error', text: 'The run failed.', error: wireError }, accepted: true },
  { name: 'an error event with an adapter error code', payload: withError({ ...wireError, code: 'provider-exited' }), accepted: true },
  { name: 'an error event without its error', payload: { ...agentEvent, type: 'error' }, accepted: false },
  { name: 'an unknown agent event type', payload: { ...agentEvent, type: 'progress' }, accepted: false },
  { name: 'an agent event with an unknown member', payload: { ...agentEvent, type: 'started', extra: 1 }, accepted: false },
  { name: 'an agent event with a member present as undefined', payload: { ...agentEvent, type: 'error', text: undefined, error: wireError }, accepted: false },
  { name: 'an agent event with a whitespace-padded session id', payload: { ...agentEvent, sessionId: ' agent-session', type: 'started' }, accepted: false },
  { name: 'an agent event with a session id padded far past its bound', payload: { ...agentEvent, sessionId: `${text(200_000, ' ')}s`, type: 'started' }, accepted: false },
  { name: 'an agent event with a non-ISO timestamp', payload: { ...agentEvent, timestamp: '2026-09-30 12:00:00', type: 'started' }, accepted: false },
  { name: 'an agent event timestamp without fractional seconds', payload: { ...agentEvent, timestamp: '2026-09-30T12:00:00Z', type: 'started' }, accepted: true },
  { name: 'an agent event timestamp with second-tenths', payload: { ...agentEvent, timestamp: '2026-09-30T12:00:00.1Z', type: 'started' }, accepted: true },
  ...atLimit('agent timestamp length (fractional digits)', AGENT_EVENT_TIMESTAMP_MAX_LENGTH, (n) => ({ ...agentEvent, timestamp: timestampOfLength(n), type: 'started' })),
  ...atLimit('agent sessionId', AGENT_EVENT_IDENTIFIER_MAX_LENGTH, (n) => ({ ...agentEvent, sessionId: text(n), type: 'started' })),
  ...atLimit('agent ordinal', AGENT_EVENT_MAX_ORDINAL, (n) => ({ ...agentEvent, ordinal: n, type: 'started' })),
  ...atLimit('agent text', AGENT_EVENT_TEXT_MAX_LENGTH, (n) => ({ ...agentEvent, type: 'final', text: text(n) })),
  ...atLimit('agent error text', AGENT_EVENT_TEXT_MAX_LENGTH, (n) => ({ ...agentEvent, type: 'error', text: text(n), error: wireError })),
  ...atLimit('agent exitCode', AGENT_EVENT_EXIT_CODE_LIMIT, (n) => ({ ...agentEvent, type: 'ended', exitCode: n, signal: null })),
  ...atLimit('agent negative exitCode', AGENT_EVENT_EXIT_CODE_LIMIT, (n) => ({ ...agentEvent, type: 'ended', exitCode: -n, signal: null })),
  ...atLimit('agent signal', AGENT_EVENT_SIGNAL_MAX_LENGTH, (n) => ({ ...agentEvent, type: 'ended', exitCode: null, signal: text(n) })),
  ...atLimit('agent error code', AGENT_EVENT_ERROR_CODE_MAX_LENGTH, (n) => withError({ ...wireError, code: text(n) })),
  ...atLimit('agent error message', AGENT_EVENT_ERROR_MESSAGE_MAX_LENGTH, (n) => withError({ ...wireError, message: text(n) })),
  ...atLimit('agent serialized data', AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH, (n) => structured({ v: text(n - DATA_ENVELOPE) })),
  ...atLimit('agent data depth', AGENT_EVENT_VALUE_MAX_DEPTH, (n) => structured(nested(n))),
  ...atLimit('agent data key count', AGENT_EVENT_VALUE_MAX_ENTRIES, (n) => structured(keyed(n))),
  ...atLimit('agent data array width', AGENT_EVENT_VALUE_MAX_ENTRIES, (n) => structured({ v: list(n, () => 0) })),
  ...atLimit('agent data key length', AGENT_EVENT_VALUE_MAX_KEY_LENGTH, (n) => structured({ [text(n)]: 0 })),
  ...atLimit('agent serialized error', AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH, (n) => withError({ ...wireError, pad: text(n - ERROR_ENVELOPE) })),
  ...atLimit('agent error extras depth', AGENT_EVENT_VALUE_MAX_DEPTH, (n) => withError({ ...wireError, detail: nested(n - 1) })),
  ...atLimit('agent error key count', AGENT_EVENT_VALUE_MAX_ENTRIES, (n) => withError({ ...wireError, ...keyed(n - ERROR_MEMBERS, 'extra') })),
  ...atLimit('agent error extras key length', AGENT_EVENT_VALUE_MAX_KEY_LENGTH, (n) => withError({ ...wireError, [text(n)]: 0 })),
  { name: 'an agent error with a non-finite extra', payload: withError({ ...wireError, ratio: Number.NaN }), accepted: false },
  { name: 'the largest event the member bounds admit (exactly the transport bound)', payload: maximalAgentEvent, accepted: true },
  { name: 'an event one unit past the transport bound', payload: { ...maximalAgentEvent, text: `${maximalAgentEvent.text}x` }, accepted: false },
];

const suites: readonly {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly guard: (value: CloneableValue) => boolean;
  readonly cases: readonly WireCase[];
}[] = [
  { name: 'chat citation', schema: chatCitationSchema, guard: isChatCitation, cases: citationCases },
  { name: 'chat message', schema: chatMessageSchema, guard: isChatMessage, cases: messageCases },
  { name: 'chat stream event', schema: chatStreamEventSchema, guard: isChatStreamEvent, cases: streamCases },
  { name: 'agent event', schema: agentEventSchema, guard: isAgentEvent, cases: agentCases },
];

describe('wire schema and preload guard equivalence', () => {
  for (const suite of suites) {
    describe(suite.name, () => {
      it.each(suite.cases.map((wireCase) => [wireCase.name, wireCase] as const))('%s', (_name, wireCase) => {
        expect(suite.schema.safeParse(wireCase.payload).success).toBe(wireCase.accepted);
        expect(suite.guard(wireCase.payload)).toBe(wireCase.accepted);
      });
    });
  }

  it('confirms the serialized payload fixtures land exactly on their bounds', () => {
    expect(JSON.stringify({ v: text(AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH - DATA_ENVELOPE) })).toHaveLength(AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH);
    expect(JSON.stringify({ ...wireError, pad: text(AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH - ERROR_ENVELOPE) })).toHaveLength(AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH);
    expect(timestampOfLength(AGENT_EVENT_TIMESTAMP_MAX_LENGTH)).toHaveLength(AGENT_EVENT_TIMESTAMP_MAX_LENGTH);
  });

  it('states the transport bound as the serialized size of the largest admissible event', () => {
    expect(JSON.stringify(maximalAgentEvent)).toHaveLength(AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH);
    expect(AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH).toBe(459_633);
  });

  it('measures the transport bound on the raw value at its exact limit and one past it', () => {
    const atBound = { v: text(AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH - DATA_ENVELOPE) };
    expect(fitsAgentEventWireBound(atBound)).toBe(true);
    expect(fitsAgentEventWireBound({ v: `${atBound.v}x` })).toBe(false);
    // Values JSON cannot measure are refused rather than guessed at.
    const cyclic: Record<string, CloneableValue> = {};
    cyclic.self = cyclic;
    expect(fitsAgentEventWireBound(cyclic)).toBe(false);
    expect(fitsAgentEventWireBound(undefined)).toBe(false);
  });
});
