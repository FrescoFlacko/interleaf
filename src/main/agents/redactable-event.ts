/**
 * The event model the redactor owns, the marker it writes over a leaf, and
 * the signal names it lets through.
 *
 * Kept apart from the redaction passes themselves: these are the shapes a
 * redacted event must still satisfy, and the checks that rebuild one from
 * rewritten members without asserting it into the type.
 */
import type { AgentEventDraft } from '@shared/types/agent';
import { INTERLEAF_ERROR_CODES, type InterleafErrorCode } from '@shared/errors/interleaf-error';
import {
  isMutablePortableRecord,
  type MutablePortableMember,
  type MutablePortableRecord,
  type PortableValue,
} from '@shared/models/portable';

export const REDACTED = '[REDACTED]';

const ALLOWED_SIGNALS = new Set<string>([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP',
  'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL',
  'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS',
  'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG',
  'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);

export function sanitizeSignal(signal: PortableValue): string | null {
  if (typeof signal !== 'string') return null;
  const upper = signal.trim().toUpperCase();
  return ALLOWED_SIGNALS.has(upper) ? upper : null;
}

type PayloadMember = 'stream' | 'text' | 'data' | 'exitCode' | 'signal' | 'error';
/** The type member `K` has on the variants that carry it; distributes over the event union. */
type PayloadValue<K extends PayloadMember, E = AgentEventDraft> = E extends AgentEventDraft
  ? (K extends keyof E ? Exclude<E[K], undefined> : never)
  : never;

/**
 * A flat read view over every event variant.
 *
 * The published event is a union in which each type carries only its own
 * payload. The redaction passes treat payload members uniformly, so they read
 * events through this view: a member is present exactly when the variant
 * carries it. Every variant is assignable to it.
 */
export type AgentEventView = Pick<AgentEventDraft, 'sessionId' | 'type' | 'timestamp'> & {
  readonly [K in PayloadMember]?: PayloadValue<K>;
};

/**
 * An agent event the redactor owns.
 *
 * Redaction rewrites payload leaves in place, so the redactor works on events
 * it constructed itself rather than on a caller's value. This is the flat view
 * with its payload members still writable; {@link toAgentEventDraft} rebuilds
 * the published variant when the event is drained.
 */
export type RedactableAgentEvent = Omit<AgentEventView, 'text' | 'data' | 'error'> & {
  text?: string;
  data?: MutablePortableRecord;
  error?: RedactableSerializedError;
};

type RedactableSerializedError = {
  __interleafError: true;
  code: InterleafErrorCode;
  message: string;
} & MutablePortableRecord;

/**
 * Rebuilds the event model from the redacted members.
 *
 * Redaction rewrites leaves, not structure: the identity members are copied
 * from the source event and only `text`, `data` and `error` can have been
 * replaced. Each replacement is checked against the member it has to satisfy,
 * so a redacted payload that no longer fits the event contract degrades to the
 * redaction marker instead of being asserted into the type.
 */
export function toRedactedEvent(
  source: AgentEventView,
  redacted: MutablePortableRecord,
): RedactableAgentEvent {
  const text = redacted.text;
  const data = redacted.data;
  const error = redacted.error;
  const signal = redacted.signal;
  return {
    sessionId: source.sessionId,
    type: source.type,
    timestamp: source.timestamp,
    ...(source.stream !== undefined ? { stream: source.stream } : {}),
    ...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
    ...(source.signal !== undefined ? { signal: typeof signal === 'string' ? signal : null } : {}),
    ...(source.text !== undefined ? { text: typeof text === 'string' ? text : REDACTED } : {}),
    ...(source.data !== undefined ? { data: isMutablePortableRecord(data) ? data : { value: REDACTED } } : {}),
    ...(source.error !== undefined ? { error: toRedactedError(error) } : {}),
  };
}

type DraftBase = Pick<AgentEventDraft, 'sessionId' | 'timestamp'>;
const draftText = (event: RedactableAgentEvent): string => event.text ?? REDACTED;
const draftData = (event: RedactableAgentEvent): MutablePortableRecord => event.data ?? { value: REDACTED };

/** One builder per variant, so each rebuild reads only the members its type carries. */
const DRAFT_BUILDERS: Readonly<Record<AgentEventDraft['type'], (base: DraftBase, event: RedactableAgentEvent) => AgentEventDraft>> = {
  started: (base) => ({ ...base, type: 'started' }),
  cancelled: (base) => ({ ...base, type: 'cancelled' }),
  stdout: (base, event) => ({ ...base, type: 'stdout', stream: 'stdout', text: draftText(event) }),
  stderr: (base, event) => ({ ...base, type: 'stderr', stream: 'stderr', text: draftText(event) }),
  structured: (base, event) => ({ ...base, type: 'structured', data: draftData(event) }),
  'changed-files': (base, event) => ({ ...base, type: 'changed-files', data: draftData(event) }),
  tests: (base, event) => ({ ...base, type: 'tests', data: draftData(event) }),
  final: (base, event) => ({ ...base, type: 'final', text: draftText(event) }),
  ended: (base, event) => ({ ...base, type: 'ended', exitCode: event.exitCode ?? null, signal: event.signal ?? null }),
  error: (base, event) => ({
    ...base,
    type: 'error',
    ...(event.text !== undefined ? { text: event.text } : {}),
    error: event.error ?? toRedactedError(null),
  }),
};

/**
 * Rebuilds the published variant from a drained event.
 *
 * Every member a variant requires was copied from a source event of that type,
 * so the fallbacks here only keep the result inside the contract: a missing
 * payload degrades to the redaction marker, never to an asserted value.
 */
export function toAgentEventDraft(event: RedactableAgentEvent): AgentEventDraft {
  return DRAFT_BUILDERS[event.type]({ sessionId: event.sessionId, timestamp: event.timestamp }, event);
}

function toRedactedError(value: MutablePortableMember): RedactableSerializedError {
  if (!isMutablePortableRecord(value)) return { __interleafError: true, code: 'internal', message: REDACTED };
  const message = value.message;
  const code = value.code;
  return {
    // Diagnostic extras a stored payload may carry are preserved as redacted.
    ...value,
    __interleafError: true,
    code: isInterleafErrorCode(code) ? code : 'internal',
    message: typeof message === 'string' ? message : REDACTED,
  };
}

function isInterleafErrorCode(value: MutablePortableMember): value is InterleafErrorCode {
  return typeof value === 'string' && (INTERLEAF_ERROR_CODES as readonly string[]).includes(value);
}
