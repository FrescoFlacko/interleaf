/**
 * Pi's JSON event stream, translated into the events the rest of Interleaf
 * already understands.
 *
 * Pi's `--print --mode json` stream is generic NDJSON: nothing in it carries the
 * `final`, `error`, or `command_execution` discriminators the runtime and the
 * renderer key on. Left untranslated, two things went wrong, both of them
 * silently:
 *
 *   * **An errored turn looked like a success.** Pi's print mode only inspects
 *     the assistant `stopReason` in *text* mode (installed 0.84.4
 *     `dist/modes/print-mode.js:110-125`); in JSON mode it returns exit 0
 *     whatever the turn did. The real outcome is on the assistant message —
 *     `stopReason: "error" | "aborted"` with `errorMessage` — and it arrives on
 *     `message_end`/`turn_end`, not on `agent_end`, whose documented payload is
 *     only `messages`. A run that failed would therefore persist as `completed`.
 *   * **The answer was invisible.** Pi's assistant text lives in
 *     `message_update` deltas and, authoritatively, in the
 *     `message_end.message.content` array. The renderer's activity projection
 *     recognises none of those shapes and hides raw JSON stdout, so a normal
 *     completion showed neither prose nor a final report.
 *
 * The translation sits between `ProcessRunner` and `mapProcessEvents`, rewriting
 * Pi frames into ordinary `ProcessRunnerEvent`s. That placement is deliberate:
 * the runner has already bounded and redacted every frame, so this reads only
 * already-safe data and never reaches around the process contracts. It adds no
 * new event vocabulary — an assistant message becomes the `assistant_message`
 * structured shape the renderer already projects, a tool call becomes the
 * `command_execution` shape, an errored turn becomes a typed process error, and
 * an aborted turn becomes a cancellation.
 *
 * The final report comes only from an assistant message Pi itself completed,
 * and it is given up for good the moment anything makes the stream incomplete —
 * a dropped-frame summary, a bound overrun, a process error, a cancellation, a
 * non-zero exit, or a signal.
 *
 * Only the run's last word may speak. Each assistant message that starts or
 * completes clears the previous candidate, and only a completed message whose
 * `stopReason` is the terminal `stop` (installed `pi-ai/dist/types.d.ts`
 * `StopReason`) may replace it. A last message that is empty, over the report
 * bound, still pending, unfinished, or stopped for `toolUse`/`length`/
 * `deferred` or an unknown reason leaves no report rather than an earlier,
 * intermediate one.
 */
import type { ProcessRunnerEvent } from './process-runner';
import { isPortableArray, isPortableRecord, type PortableMember, type PortableRecord, type PortableRecordDraft } from '@shared/models/portable';

/** Bound on the assistant text that may become a final report. Past it the
 * report is withheld rather than truncated into a plausible-looking answer. */
const MAX_PI_FINAL_BYTES = 64 * 1024;

/** Bound on one tool result rendered into the activity feed. */
const MAX_PI_TOOL_OUTPUT_CHARS = 4_000;

/** Bound on a tool's displayed command line and on an error message. */
const MAX_PI_LABEL_CHARS = 512;
const MAX_PI_ERROR_CHARS = 2_000;

type PiRecord = PortableRecord;

/** What one Pi frame becomes. `structured` keeps a frame in the stream (either
 * translated or untouched); the others are terminal signals for the run. */
type PiTranslatedFrame =
  | { readonly kind: 'structured'; readonly data: PiRecord }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' };

function record(value: PortableMember): PiRecord | null {
  return isPortableRecord(value) ? value : null;
}

function text(value: PortableMember): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The prose of one Pi assistant message.
 *
 * `content` is an array of `text`, `thinking`, and `toolCall` entries
 * (`@earendil-works/pi-ai` `AssistantMessage`). Only `text` entries are the
 * answer: thinking is not the reply and tool calls are surfaced separately as
 * activity. A provider that sends a bare string is accepted too.
 */
function assistantText(message: PiRecord): string {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!isPortableArray(content)) return '';
  const parts: string[] = [];
  for (const entry of content) {
    const item = record(entry);
    if (item?.type !== 'text') continue;
    const value = text(item.text);
    if (value !== null) parts.push(value);
  }
  return parts.join('').trim();
}

/** A stable identity for one assistant message, so the streamed text and the
 * authoritative text that replaces it project onto the same activity item
 * instead of appearing twice. */
function messageIdentity(message: PiRecord, fallback: number): string {
  const stamp = message.timestamp;
  return typeof stamp === 'number' || typeof stamp === 'string'
    ? `pi-message-${String(stamp)}`
    : `pi-message-${String(fallback)}`;
}

function isReportable(body: string): boolean {
  return body.length > 0 && Buffer.byteLength(body, 'utf8') <= MAX_PI_FINAL_BYTES;
}

export class PiStreamTranslator {
  private streamingId: string | null = null;
  private deltas = new Map<number, string>();
  /** UTF-8 bytes held in `deltas`, so the bound is checked before appending. */
  private deltaBytes = 0;
  private finalText: string | null = null;
  private lastCompleted: string | null = null;
  private counter = 0;
  private withheld = false;

  /** Give up the final report for good. */
  withhold(): void {
    this.withheld = true;
    this.finalText = null;
    // Nothing streamed from here on can become the report, so the prose
    // collected for it is released rather than kept growing.
    this.resetDeltas();
  }

  /** The report to emit immediately before `ended`, or `''` when there is none:
   * only a clean, unsignalled exit whose stream arrived whole may speak. */
  report(exitCode: number | null, signal: string | null): string {
    if (this.withheld || exitCode !== 0 || signal !== null) return '';
    return this.finalText ?? '';
  }

  translate(data: PiRecord): readonly PiTranslatedFrame[] {
    // The runner's own dropped-frame summary: the stream is no longer whole, so
    // nothing left in it may speak for the run as a final answer.
    if (data.kind === 'dropped-events') {
      this.withhold();
      return [{ kind: 'structured', data }];
    }
    const type = text(data.type);
    if (type === 'message_start') return this.beginMessage(data);
    if (type === 'message_update') return this.streamDelta(data);
    if (type === 'message_end' || type === 'turn_end') return this.completeMessage(data);
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
      return this.toolActivity(data, type === 'tool_execution_end');
    }
    return [{ kind: 'structured', data }];
  }

  private beginMessage(data: PiRecord): readonly PiTranslatedFrame[] {
    const message = record(data.message);
    if (message?.role !== 'assistant') return [{ kind: 'structured', data }];
    this.counter += 1;
    this.streamingId = messageIdentity(message, this.counter);
    this.resetDeltas();
    // A newer message has begun, so an earlier one is no longer the last word.
    this.finalText = null;
    // State only: an empty assistant message has nothing to show yet.
    return [];
  }

  /**
   * One `message_update` delta.
   *
   * JSON-mode updates are delta-only — they carry no cumulative snapshot — so
   * the live text is assembled here, keyed by `contentIndex` the way
   * `docs/json.md` prescribes. Thinking and tool-call deltas are not the reply
   * and are not accumulated.
   *
   * Live text is only worth assembling while it could still become the report.
   * Once the report is withheld — by the bound or by anything else — later
   * deltas, in this message or any later one, are dropped unread: the run keeps
   * streaming tools and its completed messages still show, but the prose is no
   * longer re-joined and re-sent on every delta.
   */
  private streamDelta(data: PiRecord): readonly PiTranslatedFrame[] {
    const id = this.streamingId;
    if (id === null || this.withheld) return [];
    const event = record(data.assistantMessageEvent);
    const delta = event === null ? null : text(event.delta);
    if (event?.type !== 'text_delta' || delta === null) return [];
    const bytes = this.deltaBytes + Buffer.byteLength(delta, 'utf8');
    if (bytes > MAX_PI_FINAL_BYTES) {
      // Past the bound the run may still stream, but it can no longer produce a
      // report this process is willing to vouch for.
      this.withhold();
      return [];
    }
    const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0;
    this.deltas.set(index, `${this.deltas.get(index) ?? ''}${delta}`);
    this.deltaBytes = bytes;
    return [{ kind: 'structured', data: { type: 'assistant_message', id, text: this.assembled() } }];
  }

  private assembled(): string {
    if (this.deltas.size === 1) return this.deltas.values().next().value ?? '';
    return [...this.deltas.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
  }

  private resetDeltas(): void {
    this.deltas = new Map<number, string>();
    this.deltaBytes = 0;
  }

  /**
   * `message_end` and `turn_end` both carry the final authoritative message —
   * the same one — so the second is deduplicated rather than shown twice.
   *
   * This is also where a Pi run's real outcome is decided: the assistant's
   * `stopReason` is the only place an errored or aborted turn is reported, and
   * JSON mode's exit code says nothing about it.
   */
  private completeMessage(data: PiRecord): readonly PiTranslatedFrame[] {
    const message = record(data.message);
    if (message?.role !== 'assistant') return [{ kind: 'structured', data }];
    const id = messageIdentity(message, this.counter);
    const body = assistantText(message);
    const stopReason = text(message.stopReason);
    this.streamingId = null;
    this.resetDeltas();

    // `message_end` and `turn_end` deliver the same completed message, so the
    // second one reports nothing: not a repeated answer, and not a second
    // failure for what is one failed turn.
    if (this.lastCompleted === `${id}\u0000${body}\u0000${stopReason ?? ''}`) return [];
    this.lastCompleted = `${id}\u0000${body}\u0000${stopReason ?? ''}`;

    const frames: PiTranslatedFrame[] = [];
    if (body.length > 0) {
      frames.push({ kind: 'structured', data: { type: 'assistant_message', id, text: body } });
    }
    if (stopReason === 'error') {
      this.withhold();
      frames.push({ kind: 'error', message: this.errorMessage(message) });
      return frames;
    }
    if (stopReason === 'aborted') {
      this.withhold();
      frames.push({ kind: 'cancelled' });
      return frames;
    }
    // Only the latest completed message may speak for the run, and only when
    // Pi ended it as a terminal `stop` with reportable text.
    this.finalText = stopReason === 'stop' && isReportable(body) && !this.withheld ? body : null;
    return frames;
  }

  private errorMessage(message: PiRecord): string {
    const reported = text(message.errorMessage);
    return (reported ?? 'Pi reported an error for this turn.').slice(0, MAX_PI_ERROR_CHARS);
  }

  /**
   * Pi's tool lifecycle, projected onto the `command_execution` shape the
   * renderer already renders as a progressing item. `toolCallId` is the item
   * identity, so start/update/end collapse into one row rather than three.
   */
  private toolActivity(data: PiRecord, ended: boolean): readonly PiTranslatedFrame[] {
    const id = text(data.toolCallId);
    const name = text(data.toolName) ?? 'tool';
    if (id === null) return [{ kind: 'structured', data }];
    const args = record(data.args);
    const command = (text(args?.command) ?? name).slice(0, MAX_PI_LABEL_CHARS);
    const result = data.result ?? data.partialResult;
    const output = typeof result === 'string' ? result : result === undefined ? null : JSON.stringify(result);
    const translated: PortableRecordDraft = { type: 'command_execution', id, command };
    if (output !== null) translated.output = output.slice(0, MAX_PI_TOOL_OUTPUT_CHARS);
    if (ended) translated.exit_code = data.isError === true ? 1 : 0;
    return [{ kind: 'structured', data: translated }];
  }
}

/**
 * Rewrite a Pi run's process events into the ones the generic adapter mapping
 * already handles. Every event this does not translate passes through untouched.
 */
export function translatePiProcessEvents(events: AsyncIterable<ProcessRunnerEvent>): AsyncIterable<ProcessRunnerEvent> {
  return (async function* (): AsyncGenerator<ProcessRunnerEvent> {
    const translator = new PiStreamTranslator();
    for await (const event of events) {
      if (event.type === 'structured') {
        for (const frame of translator.translate(event.data)) {
          yield piFrameEvent(frame, event.runId, event.timestamp);
        }
        continue;
      }
      // A process-level diagnostic or a cancellation means the stream is not the
      // whole run; neither may be followed by a confident final answer.
      if (event.type === 'error' || event.type === 'cancelled') translator.withhold();
      if (event.type === 'ended') {
        const report = translator.report(event.exitCode, event.signal);
        if (report.length > 0) {
          yield {
            type: 'structured', runId: event.runId, timestamp: event.timestamp,
            data: { type: 'final', text: report }, structuredKind: 'final', structuredFinalText: report,
          };
        }
      }
      yield event;
    }
  })();
}

function piFrameEvent(frame: PiTranslatedFrame, runId: string, timestamp: string): ProcessRunnerEvent {
  if (frame.kind === 'error') return { type: 'error', runId, message: frame.message, timestamp };
  if (frame.kind === 'cancelled') return { type: 'cancelled', runId, timestamp };
  return { type: 'structured', runId, data: frame.data, timestamp, structuredKind: 'structured' };
}
