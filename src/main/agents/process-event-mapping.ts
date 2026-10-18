import type { AgentEvent } from '@shared/types/agent';
import type { CustomAgentProfileConfig } from '@shared/schemas/custom-agent-profile';
import type { PortableRecord } from '@shared/models/portable';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { ProcessRunnerEvent } from './process-runner';
import { TextFinalSynthesis } from './text-final-synthesis';

/**
 * Input contract for {@link mapProcessEvents}.
 *
 * `ProcessRunner` never emits `final` itself; an adapter that post-processes a
 * transcript can hand one to the mapper, so that variant is named here instead
 * of being rediscovered from an untyped event member.
 */
export type MappableProcessEvent =
  | ProcessRunnerEvent
  | { readonly type: 'final'; readonly runId: string; readonly text: string; readonly timestamp: string };

/** The published variant for one line of process output on its own stream. */
function streamEvent(
  base: { sessionId: string; ordinal: number; timestamp: string },
  stream: 'stdout' | 'stderr',
  text: string,
): AgentEvent {
  return stream === 'stdout' ? { ...base, type: 'stdout', stream, text } : { ...base, type: 'stderr', stream, text };
}

export function mapProcessEvents(events: AsyncIterable<MappableProcessEvent>, onDone?: () => void, stdoutParsingMode?: CustomAgentProfileConfig['stdoutParsingMode']): AsyncIterable<AgentEvent> {
  return (async function* (): AsyncGenerator<AgentEvent> {
    // Item M: only a text-mode run synthesizes a final report, and only from
    // redacted stdout it could collect whole. See `TextFinalSynthesis`.
    const synthesis = new TextFinalSynthesis(stdoutParsingMode === 'text');
    try { for await (const event of events) {
      const base = { sessionId: '', ordinal: 0, timestamp: event.timestamp };
      if (event.type === 'stdout' || event.type === 'stderr') {
        // `none` means suppress stdout from the renderer-facing stream as
        // well as structured parsing; stderr remains visible for diagnostics.
        if (event.type === 'stdout' && stdoutParsingMode === 'none') continue;
        if (event.type === 'stdout') synthesis.collect(event.text);
        yield streamEvent(base, event.type, event.text);
      }
      else if (event.type === 'structured') {
        const mapped = mapStructuredEvent(event, base, stdoutParsingMode, synthesis);
        if (mapped !== null) yield mapped;
      }
      else if (event.type === 'final') {
        synthesis.withhold();
        yield { ...base, type: 'final', text: event.text };
      }
      else if (event.type === 'started') yield { ...base, type: 'started' };
      else if (event.type === 'ended') {
        const synthesized = synthesis.report(event.exitCode, event.signal);
        if (synthesized.length > 0) yield { ...base, type: 'final', text: synthesized };
        yield { ...base, type: 'ended', exitCode: event.exitCode, signal: event.signal };
      }
      else if (event.type === 'cancelled') { synthesis.withhold(); yield { ...base, type: 'cancelled' }; }
      else {
        synthesis.withhold();
        yield processErrorEvent(event, base);
      }
    } } finally { onDone?.(); }
  })();
}

function classifyStructuredDataFallback(data: PortableRecord): 'structured' | 'changed-files' | 'tests' | 'final' {
  const discriminator = data.kind ?? data.type;
  return discriminator === 'changed-files' || discriminator === 'tests' || discriminator === 'final'
    ? discriminator
    : 'structured';
}

type MappedEventBase = { readonly sessionId: string; readonly ordinal: number; readonly timestamp: string };
type StructuredProcessEvent = Extract<ProcessRunnerEvent, { readonly type: 'structured' }>;

/** Maps one structured frame, or returns null when the parsing mode suppresses it. */
function mapStructuredEvent(
  event: StructuredProcessEvent,
  base: MappedEventBase,
  stdoutParsingMode: CustomAgentProfileConfig['stdoutParsingMode'] | undefined,
  synthesis: TextFinalSynthesis,
): AgentEvent | null {
  const isDroppedSummary = (event.data as PortableRecord | undefined)?.kind === 'dropped-events';
  // Item M: the runner dropped frames to stay within its queue bound, so
  // what this text-mode run collected is no longer the whole output. A
  // synthesized report would silently present a gap as the final answer.
  if (isDroppedSummary) synthesis.withhold();
  if (!isDroppedSummary && stdoutParsingMode !== undefined && stdoutParsingMode !== 'json-lines') return null;
  // ProcessRunner classifies the bounded raw frame before redacting its
  // data. Never rediscover the kind from renderer-facing strings: a
  // short secret such as `t` can legitimately redact `tests`.
  const kind = event.structuredKind ?? classifyStructuredDataFallback(event.data);
  if (kind === 'changed-files') return { ...base, type: 'changed-files', data: event.data };
  if (kind === 'tests') return { ...base, type: 'tests', data: event.data };
  if (kind === 'final' && (event.structuredFinalText !== undefined || typeof event.data.text === 'string')) {
    synthesis.withhold();
    return { ...base, type: 'final', text: event.structuredFinalText ?? (event.data.text as string) };
  }
  return { ...base, type: 'structured', data: event.data };
}

function processErrorEvent(event: MappableProcessEvent, base: MappedEventBase): AgentEvent {
  const message = 'message' in event && typeof event.message === 'string' && event.message.trim().length > 0
    ? event.message.trim().slice(0, 2_000)
    : 'Agent process failed.';
  return {
    ...base,
    type: 'error',
    text: message,
    error: new InterleafError('internal', message).toPayload(),
  };
}
