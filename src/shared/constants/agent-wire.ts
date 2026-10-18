/**
 * The limits for one agent event as main persists it and pushes it to the
 * renderer. `agentEventSchema` (`schemas/agent.ts`) is built from these, and
 * the preload bridge validates every pushed event with that same schema.
 *
 * Each member has its own bound, and `AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH`
 * bounds the event as a whole. The whole-event bound is not a tighter policy
 * layered on top: it is the largest JSON text any event the member bounds
 * admit can serialize to, every member of the largest event type present and
 * every string character escaped at its worst (`\u0000`, six units), so a
 * legitimate event always fits. It exists so the bridge can refuse an oversized
 * value from its raw serialized length, before any schema walks it, and so the
 * event's total size is a stated number rather than an inference from many
 * separate bounds.
 */

export const AGENT_EVENT_IDENTIFIER_MAX_LENGTH = 128;
export const AGENT_EVENT_MAX_ORDINAL = 1_000_000;
/** `YYYY-MM-DDTHH:MM:SS.fffffffffZ`: an ISO-8601 UTC instant to nanosecond precision. */
export const AGENT_EVENT_TIMESTAMP_MAX_LENGTH = 30;
export const AGENT_EVENT_TEXT_MAX_LENGTH = 65_536;
export const AGENT_EVENT_SIGNAL_MAX_LENGTH = 64;
export const AGENT_EVENT_EXIT_CODE_LIMIT = 255;
export const AGENT_EVENT_ERROR_CODE_MAX_LENGTH = 128;
export const AGENT_EVENT_ERROR_MESSAGE_MAX_LENGTH = 2_000;

/** Bounds shared by the structured `data` and serialized `error` payloads. */
export const AGENT_EVENT_VALUE_MAX_DEPTH = 5;
export const AGENT_EVENT_VALUE_MAX_ENTRIES = 128;
export const AGENT_EVENT_VALUE_MAX_KEY_LENGTH = 256;
/** Measured as the payload's own JSON text, so escaping is already counted. */
export const AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH = 65_536;

/** The most JSON text one UTF-16 unit can become (`\u0000`, or a lone surrogate). */
const JSON_ESCAPED_UNIT_MAX_LENGTH = 6;

function quotedMaxLength(units: number): number {
  return 2 + units * JSON_ESCAPED_UNIT_MAX_LENGTH;
}

/** `"key":` followed by the value. */
function memberMaxLength(key: string, valueLength: number): number {
  return key.length + 3 + valueLength;
}

const TEXT_MEMBER = memberMaxLength('text', quotedMaxLength(AGENT_EVENT_TEXT_MAX_LENGTH));
const DATA_MEMBER = memberMaxLength('data', AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH);
const ERROR_MEMBER = memberMaxLength('error', AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH);
const ENDED_MEMBERS = [
  memberMaxLength('exitCode', String(-AGENT_EVENT_EXIT_CODE_LIMIT).length),
  memberMaxLength('signal', quotedMaxLength(AGENT_EVENT_SIGNAL_MAX_LENGTH)),
];

/** Each event type with the payload members it may carry beside the shared ones. */
const AGENT_EVENT_PAYLOAD_MAX_LENGTHS: readonly (readonly [type: string, members: readonly number[]])[] = [
  ['started', []],
  ['stdout', [memberMaxLength('stream', '"stdout"'.length), TEXT_MEMBER]],
  ['stderr', [memberMaxLength('stream', '"stderr"'.length), TEXT_MEMBER]],
  ['structured', [DATA_MEMBER]],
  ['changed-files', [DATA_MEMBER]],
  ['tests', [DATA_MEMBER]],
  ['final', [TEXT_MEMBER]],
  ['ended', ENDED_MEMBERS],
  ['cancelled', []],
  ['error', [TEXT_MEMBER, ERROR_MEMBER]],
];

/** Braces, the separators between members and every member at its largest. */
function eventMaxLength(type: string, payload: readonly number[]): number {
  const members = [
    memberMaxLength('sessionId', quotedMaxLength(AGENT_EVENT_IDENTIFIER_MAX_LENGTH)),
    memberMaxLength('ordinal', String(AGENT_EVENT_MAX_ORDINAL).length),
    memberMaxLength('type', type.length + 2),
    memberMaxLength('timestamp', 2 + AGENT_EVENT_TIMESTAMP_MAX_LENGTH),
    ...payload,
  ];
  return 2 + (members.length - 1) + members.reduce((total, length) => total + length, 0);
}

/**
 * The whole-event transport bound: the largest serialized form of any event
 * type. The `error` event, with its text and its serialized error both at
 * their bounds, is the largest; the bound is 459,633 units.
 */
export const AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH = Math.max(
  ...AGENT_EVENT_PAYLOAD_MAX_LENGTHS.map(([type, payload]) => eventMaxLength(type, payload))
);
