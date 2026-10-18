/**
 * The JSON event stream shared by the Pi and Omp CLIs.
 *
 * Omp is Pi's successor and emits the same `--mode json` event vocabulary, so
 * the parser and the tool-use detector live here rather than being copied into
 * a second adapter where the two could quietly drift apart. Each adapter keeps
 * only what is genuinely its own: its flags, its model grammar, and how it
 * discovers a catalog.
 *
 * Everything here treats the stream as untrusted external process output. A
 * line is parsed, never trusted; an unrecognized shape produces nothing rather
 * than being rendered on the chance that it might be text.
 */
import { splitToSafeChunks } from './cli-runtime';
import { type PortableMember, type PortableRecord, isPortableArray, parsePortableJson } from '@shared/models/portable';

/**
 * Bounds on the aggregate message envelopes scanned for tool activity. They
 * bound the scan's cost, and exceeding one is itself a violation, so no tail is
 * ever left unscanned.
 */
const MAX_SCANNED_MESSAGES = 64;
const MAX_SCANNED_CONTENT_PARTS = 256;

/**
 * Any event meaning a tool ran, is running, or is being called.
 *
 * Reader Chat is tool-free, so such an event is not a rendering decision but a
 * violated invariant: the caller terminates the process before the payload is
 * read as text.
 *
 * Tool use is reported twice: as incremental events (`tool_execution_*`,
 * assistant `toolcall_*`) and inside the aggregate `AgentMessage` envelopes
 * that `message_start`, `message_end`, `turn_end` and `agent_end` carry. Both
 * are checked structurally — by event type, message role, stop reason and
 * content-part type — so assistant prose that merely contains the words
 * `tool_execution_start` is ordinary text and is not flagged.
 */
export function agentJsonToolActivity(line: string): boolean {
  const event = parseJsonRecord(line);
  if (event === null) return false;
  if (isToolEventType(event.type)) return true;
  const assistantEvent = asRecord(event.assistantMessageEvent);
  if (isToolEventType(assistantEvent?.type)) return true;
  // `toolcall_end` and the terminal `done`/`error` events carry the call or the
  // whole assistant message rather than a tool-shaped event type.
  if (asRecord(assistantEvent?.toolCall) !== null) return true;
  if (messageHasToolActivity(assistantEvent?.message) || messageHasToolActivity(assistantEvent?.error)) return true;
  return messagesHaveToolActivity(event.toolResults)
    || messageHasToolActivity(event.message)
    || messagesHaveToolActivity(event.messages);
}

/**
 * Event-type prefixes that mean a tool. `function_call` is included alongside
 * the CLI's own vocabulary because the same adapters front OpenAI-shaped
 * upstreams, whose tool events are named that way; matching both costs nothing
 * and a tool-free turn emits neither.
 */
function isToolEventType(value: PortableMember): boolean {
  if (typeof value !== 'string') return false;
  const type = value.toLowerCase();
  return type.startsWith('tool_execution')
    || type.startsWith('toolcall')
    || type.startsWith('tool_call')
    || type.startsWith('function_call')
    || type.startsWith('functioncall');
}

/**
 * Aggregate message lists: `turn_end.toolResults`, `agent_end.messages`.
 *
 * The scan is bounded, and the bound fails closed: an array longer than the
 * bound is itself treated as a violation rather than scanned as a prefix,
 * because an unscanned tail could carry the tool call the abort exists to
 * catch. A tool-free Reader Chat turn never approaches these sizes.
 */
function messagesHaveToolActivity(value: PortableMember): boolean {
  if (!isPortableArray(value)) return false;
  if (value.length > MAX_SCANNED_MESSAGES) return true;
  return value.some((entry) => messageHasToolActivity(entry));
}

/**
 * One `AgentMessage`. A `toolResult` message, an assistant message that stopped
 * to use a tool, and a `toolCall` content part each mean a tool was called or
 * answered, whatever event envelope delivered them.
 */
function messageHasToolActivity(value: PortableMember): boolean {
  const message = asRecord(value);
  if (message === null) return false;
  if (message.role === 'toolResult' || message.stopReason === 'toolUse') return true;
  if (typeof message.toolCallId === 'string' || typeof message.toolName === 'string') return true;
  if (!isPortableArray(message.content)) return false;
  // Same fail-closed bound as the message list: too many parts to scan is a
  // violation, never a scanned prefix with an ignored tail.
  if (message.content.length > MAX_SCANNED_CONTENT_PARTS) return true;
  return message.content.some((part) => {
    const type = asRecord(part)?.type;
    return type === 'toolCall' || type === 'toolResult';
  });
}

/** Terminal events. Seeing one is how a turn is known to have finished. */
const COMPLETION_EVENT_TYPES = new Set(['agent_end', 'turn_end']);

export type AgentJsonStreamParserOptions = {
  /**
   * Require a terminal event before the transcript is accepted.
   *
   * Without it, a process killed mid-answer — or one whose stdout was truncated
   * — yields a partial answer that reads as a complete one. The transport's
   * exit-status check does not cover that on its own: a CLI can exit 0 after
   * writing an unfinished stream. Adapters that opt in fail closed instead.
   */
  readonly requireCompletion?: boolean;
  /** Provider label used in the fail-closed message. */
  readonly providerName?: string;
  /** Raised when completion is required and absent. */
  readonly onIncomplete?: () => never;
};

/**
 * Pi/Omp's documented JSON event stream.
 *
 * Only `message_update` events carrying an assistant `text_delta` become
 * assistant text. Thinking deltas, lifecycle events, the authoritative
 * `message_end` snapshot, queue/compaction events, unknown event types and
 * malformed lines all produce nothing — the deltas alone are the transcript, so
 * nothing is duplicated and no unrecognized payload can be rendered.
 *
 * Reasoning is excluded structurally, by event type, and not by trying to strip
 * it out of text afterwards: `thinking_start`/`thinking_delta`/`thinking_end`
 * simply are not the branch that emits, so a model's private scratchpad has no
 * route to the renderer or to stored history.
 */
export class AgentJsonStreamParser {
  private sawCompletion = false;

  constructor(private readonly options: AgentJsonStreamParserOptions = {}) {}

  parseLine(line: string): readonly string[] {
    const event = parseJsonRecord(line);
    if (event === null) return [];
    if (typeof event.type === 'string' && COMPLETION_EVENT_TYPES.has(event.type)) {
      this.sawCompletion = true;
    }
    if (event.type !== 'message_update') return [];
    const assistantEvent = asRecord(event.assistantMessageEvent);
    if (assistantEvent?.type !== 'text_delta') return [];
    const delta = assistantEvent.delta;
    return typeof delta === 'string' && delta.length > 0 ? splitToSafeChunks(delta) : [];
  }

  finish(): readonly string[] {
    if (this.options.requireCompletion === true && !this.sawCompletion) {
      this.options.onIncomplete?.();
      throw new Error('agent-json-stream-incomplete');
    }
    return [];
  }

  /** Whether a terminal event was observed. Exposed for focused tests. */
  hasCompleted(): boolean {
    return this.sawCompletion;
  }
}

export function parseJsonRecord(line: string): PortableRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return asRecord(parsePortableJson(trimmed));
  } catch {
    return null;
  }
}

function asRecord(value: PortableMember): PortableRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as PortableRecord)
    : null;
}
