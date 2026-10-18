import { z } from 'zod';
import { AGENT_EXECUTION_MODES } from '../constants/agent-modes';
import { agentModelIdentifierSchema, MAX_AGENT_PROFILE_MODEL_OPTIONS } from './agent-model';
import { documentAnchorSchema } from './annotation';
import { portableValueSchema } from './portable';
import { type CloneableValue, type PortableMember, type PortableRecord, isPortableArray } from '../models/portable';
import { documentLocationSchema } from './document';
import { workingDirectoryDisplayNameSchema, workingDirectoryHandleSchema } from './settings';
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
} from '../constants/agent-wire';
import {
  AGENT_CONTEXT_SELECTION_SOURCE,
  normalizeLegacyAgentContextSource,
} from '../legacy/legacy-brand-values';

export const AGENT_MAX_CONTEXT_TEXT_LENGTH = 256_000;
/** Maximum UTF-8 bytes persisted for one main-owned Agent context packet. */
export const AGENT_MAX_CONTEXT_PACKET_BYTES = 256_000;
export const AGENT_MAX_SURROUNDING_TEXT_LENGTH = 20_000;
const agentIdentifierSchema = z.string().trim().min(1).max(128);
/** Longest task or follow-up main accepts, measured after trimming. */
export const AGENT_MAX_PROMPT_LENGTH = 100_000;
export const agentPromptSchema = z.string().trim().min(1).max(AGENT_MAX_PROMPT_LENGTH);
const agentExecutionModeSchema = z.enum(AGENT_EXECUTION_MODES);

export const agentContextPacketSchema = z.object({
  version: z.literal(1),
  /**
   * Human-readable native range label for UI summaries (for example
   * Pages 3–5). Absent for a direct selection, which has no named range.
   */
  scopeLabel: z.string().trim().min(1).max(256).exactOptional(),
  document: z.object({
    id: agentIdentifierSchema,
    hash: z.string().min(1).max(256),
    title: z.string().max(1_000),
    author: z.string().max(1_000).nullable(),
  }).strict(),
  selection: z.object({
    exactQuote: z.string().min(1).max(AGENT_MAX_CONTEXT_TEXT_LENGTH),
    anchor: documentAnchorSchema,
    location: documentLocationSchema,
    surroundingText: z.string().max(AGENT_MAX_SURROUNDING_TEXT_LENGTH).nullable(),
  }).strict(),
  provenance: z.object({
    // Accepts the pre-rebrand tag and normalizes it, so a context packet
    // captured before the Interleaf rename still validates. Only the current
    // spelling ever leaves this schema.
    source: z.string().transform((value, context) => {
      const normalized = normalizeLegacyAgentContextSource(value);
      if (normalized === null) {
        context.addIssue({
          code: 'custom',
          message: `Agent context source must be ${AGENT_CONTEXT_SELECTION_SOURCE}.`,
        });
        return z.NEVER;
      }
      return normalized;
    }),
    capturedAt: z.iso.datetime(),
    contentIsUntrustedReference: z.literal(true),
    // Packets captured before truncation was recorded were never truncated.
    truncated: z.boolean().default(false),
  }).strict(),
}).strict().superRefine((packet, context) => {
  if (packet.selection.anchor.format !== packet.selection.location.format) {
    context.addIssue({
      code: 'custom',
      path: ['selection', 'location', 'format'],
      message: 'Agent context anchor and location formats must match.',
    });
  }
});

export const agentStartRequestSchema = z.object({
  documentId: agentIdentifierSchema,
  profileId: agentIdentifierSchema,
  workingDirectoryHandle: agentIdentifierSchema,
  // Defaults normalise the request: the parsed form always states every member.
  executionMode: agentExecutionModeSchema.default('auto-isolated'),
  prompt: agentPromptSchema,
  /** `null` (or empty) runs the profile's configured default model. */
  model: z.string().trim().max(128).nullable().default(null),
  contextPacket: agentContextPacketSchema.nullable().default(null),
  /**
   * The direct-workspace confirmation main granted for this exact draft. The
   * grant is bound to its draft, so the two travel together; `null` for runs
   * that need no confirmation.
   */
  riskConfirmation: z.object({
    grantId: z.uuid(),
    draftId: agentIdentifierSchema,
  }).strict().nullable().default(null),
}).strict().superRefine((data, ctx) => {
  if (data.contextPacket && data.contextPacket.document.id !== data.documentId) {
    ctx.addIssue({
      code: 'custom',
      path: ['contextPacket', 'document', 'id'],
      message: 'Context packet document ID must match the session document ID.',
    });
  }
});

export const agentListSessionsRequestSchema = z.object({ documentId: agentIdentifierSchema }).strict();

/** `null` asks about the default profile. */
export const agentModeAvailabilityRequestSchema = z
  .object({ profileId: z.string().trim().max(128).nullable() })
  .strict();

export const agentDocumentSessionRequestSchema = z.object({
  sessionId: agentIdentifierSchema,
  documentId: agentIdentifierSchema,
}).strict();

export const agentSessionRequestSchema = z.object({ sessionId: agentIdentifierSchema }).strict();
export const agentResumeRequestSchema = z.object({
  sessionId: agentIdentifierSchema,
  prompt: agentPromptSchema,
}).strict();
export const agentCopyResultResponseSchema = z.object({
  copied: z.literal(true),
  characterCount: z.number().int().nonnegative().max(65_536),
}).strict();
export const agentStopRequestSchema = z.object({ sessionId: agentIdentifierSchema }).strict();
export const agentSelectDirectoryRequestSchema = z.undefined();

/**
 * Checks the portable JSON-like value contract used by agent event payloads.
 *
 * The schema layer accepts any portable value here and does not inspect
 * diagnostic extras further. Keep this
 * one guard shared by `data` and serialized `error` so those two boundary
 * payloads cannot silently acquire different depth/size/cycle limits.
 */
function isBoundedEventValue(
  value: PortableMember,
  depth = 0,
  active = new WeakSet<object>(),
  isRoot = depth === 0,
): boolean {
  if (depth > AGENT_EVENT_VALUE_MAX_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (active.has(value)) return false;

  active.add(value);
  try {
    if (isPortableArray(value)) {
      if (value.length > AGENT_EVENT_VALUE_MAX_ENTRIES) return false;
      for (const entry of value) {
        if (!isBoundedEventValue(entry, depth + 1, active, false)) return false;
      }
    } else {
      const record: PortableRecord = value;
      const proto = Reflect.getPrototypeOf(record);
      if (proto !== null && proto !== Object.prototype) return false;
      const keys = Object.keys(record);
      if (keys.length > AGENT_EVENT_VALUE_MAX_ENTRIES) return false;
      for (const key of keys) {
        if (key.length > AGENT_EVENT_VALUE_MAX_KEY_LENGTH) return false;
        if (!isBoundedEventValue(record[key], depth + 1, active, false)) return false;
      }
    }

    if (isRoot) {
      try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') return false;
        return serialized.length <= AGENT_EVENT_VALUE_MAX_SERIALIZED_LENGTH;
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    // Proxies/getters and cyclic values must fail closed at the schema boundary.
    return false;
  } finally {
    // Track only the active recursion path. Repeated references are safe to
    // serialize; cycles are rejected when the path re-enters an object.
    active.delete(value);
  }
}

const boundedEventDataSchema = z.record(z.string(), portableValueSchema).superRefine((value, context) => {
  if (!isBoundedEventValue(value, 0)) {
    context.addIssue({ code: 'custom', message: 'Structured agent event data must be a bounded plain object.' });
  }
});

/**
 * An agent event's `error`. Its `code` is any short string, not only a current
 * `InterleafErrorCode`, because stored events from earlier versions and
 * adapter-reported failures carry their own codes.
 */
export const boundedSerializedErrorSchema = z.object({
  __interleafError: z.literal(true),
  code: z.string().min(1).max(AGENT_EVENT_ERROR_CODE_MAX_LENGTH),
  message: z.string().min(1).max(AGENT_EVENT_ERROR_MESSAGE_MAX_LENGTH),
}).catchall(portableValueSchema).superRefine((value, context) => {
  if (!isBoundedEventValue(value, 0)) {
    context.addIssue({ code: 'custom', message: 'Agent event error must be a bounded serializable object with valid extras.' });
  }
});

/**
 * Whether a value's JSON text fits the whole-event transport bound
 * (`constants/agent-wire.ts`). It measures the value exactly as received, so
 * the bridge can apply it before any schema walks the value.
 */
export function fitsAgentEventWireBound(value: CloneableValue): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= AGENT_EVENT_WIRE_MAX_SERIALIZED_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Identifiers on an event are compared, not normalised: a session ID with
 * surrounding whitespace is refused rather than trimmed, so the value the
 * bridge forwards is the value the schema checked.
 */
const agentEventIdentifierSchema = z.string().min(1).max(AGENT_EVENT_IDENTIFIER_MAX_LENGTH)
  .refine((value) => value.trim() === value, 'Agent event identifiers must not have surrounding whitespace.');

const agentEventTextSchema = z.string().max(AGENT_EVENT_TEXT_MAX_LENGTH);
const agentEventBase = {
  sessionId: agentEventIdentifierSchema,
  ordinal: z.number().int().min(0).max(AGENT_EVENT_MAX_ORDINAL),
  timestamp: z.iso.datetime().max(AGENT_EVENT_TIMESTAMP_MAX_LENGTH),
};

/**
 * One persisted agent event. Each type carries exactly the payload it needs:
 * output text names its stream, structured kinds carry data, `ended` carries
 * the exit status, and `error` carries a serialized error with the readable
 * message as optional text.
 *
 * No member transforms or defaults, so what the schema accepts is exactly what
 * it returns; the preload bridge forwards the received value on that basis.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...agentEventBase, type: z.literal('started') }).strict(),
  z.object({ ...agentEventBase, type: z.literal('stdout'), stream: z.literal('stdout'), text: agentEventTextSchema }).strict(),
  z.object({ ...agentEventBase, type: z.literal('stderr'), stream: z.literal('stderr'), text: agentEventTextSchema }).strict(),
  z.object({ ...agentEventBase, type: z.literal('structured'), data: boundedEventDataSchema }).strict(),
  z.object({ ...agentEventBase, type: z.literal('changed-files'), data: boundedEventDataSchema }).strict(),
  z.object({ ...agentEventBase, type: z.literal('tests'), data: boundedEventDataSchema }).strict(),
  z.object({ ...agentEventBase, type: z.literal('final'), text: agentEventTextSchema }).strict(),
  z.object({
    ...agentEventBase,
    type: z.literal('ended'),
    exitCode: z.number().int().min(-AGENT_EVENT_EXIT_CODE_LIMIT).max(AGENT_EVENT_EXIT_CODE_LIMIT).nullable(),
    signal: z.string().max(AGENT_EVENT_SIGNAL_MAX_LENGTH).nullable(),
  }).strict(),
  z.object({ ...agentEventBase, type: z.literal('cancelled') }).strict(),
  z.object({
    ...agentEventBase,
    type: z.literal('error'),
    // Absent when the error carries no readable summary beyond its message.
    text: agentEventTextSchema.exactOptional(),
    error: boundedSerializedErrorSchema,
  }).strict(),
]).superRefine((event, context) => {
  if (!fitsAgentEventWireBound(event)) {
    context.addIssue({ code: 'custom', message: 'Agent event exceeds the transport size bound.' });
  }
});

export const agentProfileSchema = z.object({
  id: agentIdentifierSchema,
  providerId: z.enum(['codex', 'claude-code', 'antigravity', 'copilot', 'opencode', 'pi', 'cursor', 'custom']),
  name: z.string().min(1).max(200),
  defaultModel: z.string().max(128).nullable(),
  // Not the user's persisted list: this is main's merged projection, so the
  // bound is the sum of every source `resolveAgentModelOptions` can merge.
  availableModels: z.array(agentModelIdentifierSchema).max(MAX_AGENT_PROFILE_MODEL_OPTIONS),
  reasoningEffort: z.string().max(128).nullable(),
  defaultSandboxMode: agentExecutionModeSchema,
  capabilities: z.object({
    structuredOutput: z.boolean(),
    sessionResume: z.boolean(),
    nativeSandbox: z.boolean(),
    workingDirectory: z.boolean(),
    modelSelection: z.boolean(),
    reasoningSelection: z.boolean(),
    fileChangeEvents: z.boolean(),
    toolEvents: z.boolean(),
    subagents: z.boolean(),
    interactiveAuthentication: z.boolean(),
    nonInteractiveMode: z.boolean(),
  }).strict(),
  detection: z.object({
    availability: z.enum(['installed', 'not-installed', 'error']),
    version: z.string().max(512).nullable(),
    checkedAt: z.iso.datetime(),
    errorMessage: z.string().max(2_000).nullable(),
  }).strict(),
  isCustom: z.boolean(),
  unsafe: z.boolean(),
}).strict();

/**
 * Result contract for `agent:list-profile-status`.
 *
 * Closed and bounded on purpose: this is the detection projection a progressive
 * readout renders, and nothing path-like, credential-derived or probe-verbatim
 * may appear in it. `errorMessage` carries the same already-redacted, bounded
 * string the profile list carries.
 */
export const agentProfileStatusSnapshotSchema = z.object({
  profiles: z.array(z.object({
    profileId: z.string().min(1).max(128),
    providerId: z.enum(['codex', 'claude-code', 'antigravity', 'copilot', 'opencode', 'pi', 'cursor', 'fake', 'custom']),
    name: z.string().min(1).max(200),
    availability: z.enum(['installed', 'not-installed', 'error']),
    unavailability: z.enum(['none', 'not-found', 'unsupported', 'error']),
    version: z.string().max(512).nullable(),
    errorMessage: z.string().max(2_000).nullable(),
    checkedAt: z.iso.datetime(),
    defaultModel: z.string().max(128).nullable(),
    availableModels: z.array(z.string().min(1).max(128)).max(256),
    supportsModelSelection: z.boolean(),
    isCustom: z.boolean(),
  }).strict()).max(128),
  modelDiscoveryPending: z.boolean(),
}).strict();

export const agentWorkingDirectorySchema = z.object({
  handle: workingDirectoryHandleSchema,
  displayName: workingDirectoryDisplayNameSchema,
}).strict();
