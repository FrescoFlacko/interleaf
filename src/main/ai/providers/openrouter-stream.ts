import { InterleafError } from '@shared/errors/interleaf-error';
import { CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS } from '@shared/constants/ai';
import type { ChatWebSource, ReasoningEffort } from '@shared/types/ai';
import { splitToSafeChunks } from './cli-ai-provider';
import { NO_CITATIONS, parseCitationAnnotations, type OpenRouterCitation } from './openrouter-citations';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, isPortableRecord, parsePortableJson } from '@shared/models/portable';

/**
 * Server-Sent Events parser that honors event boundaries, multiline data,
 * and EOF flushing.
 */
export class SseEventParser {
  remainder = '';

  feed(input: string): readonly string[] {
    const events: string[] = [];
    const normalizedInput = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normalized = combineSseInput(this.remainder, normalizedInput);
    const parts = normalized.split('\n\n');
    this.remainder = parts.pop() ?? '';

    for (const part of parts) {
      const eventData = this.parseEventBlock(part);
      if (eventData !== null) {
        events.push(eventData);
      }
    }
    return events;
  }

  flush(finalInput: string): readonly string[] {
    const events: string[] = [];
    const normalizedInput = finalInput.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normalized = combineSseInput(this.remainder, normalizedInput);
    const parts = normalized.split('\n\n');
    for (const part of parts) {
      const eventData = this.parseEventBlock(part);
      if (eventData !== null) {
        events.push(eventData);
      }
    }
    this.remainder = '';
    return events;
  }

  private parseEventBlock(block: string): string | null {
    const lines = block.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice(5).trimStart());
      }
    }
    return dataLines.length > 0 ? dataLines.join('\n') : null;
  }
}

type ParsedOpenRouterEvent = {
  readonly content: string;
  /** Provider-hosted web sources this delta cited, in the order given. */
  readonly citations: readonly OpenRouterCitation[];
  readonly error: string | null;
  /** The choice's `finish_reason`, when this delta carried one. */
  readonly finishReason: string | null;
};

const EMPTY_EVENT: ParsedOpenRouterEvent = { content: '', citations: NO_CITATIONS, error: null, finishReason: null };
const MAX_FINISH_REASON_LENGTH = 32;

/** What one streamed answer reported beside its text. */
export type OpenRouterStreamState = {
  /** URL -> link text, in the order the provider first cited each source. */
  readonly citations: Map<string, string>;
  finishReason: string | null;
};

function parseOpenRouterData(data: string): ParsedOpenRouterEvent {
  try {
    const parsed: PortableValue = parsePortableJson(data);
    if (typeof parsed !== 'object' || parsed === null) {
      return EMPTY_EVENT;
    }

    // Check for in-band error object inside 200 response
    if ('error' in parsed && typeof parsed.error === 'object' && parsed.error !== null) {
      const errorObj = parsed.error as { message?: PortableValue; code?: PortableValue };
      const msg = typeof errorObj.message === 'string'
        ? errorObj.message.slice(0, 500)
        : 'Unknown in-band stream error';
      return { ...EMPTY_EVENT, error: msg };
    }
    if ('error' in parsed && typeof parsed.error === 'string') {
      return { ...EMPTY_EVENT, error: parsed.error.slice(0, 500) };
    }

    if ('choices' in parsed && isPortableArray(parsed.choices)) {
      const first: PortableMember = parsed.choices[0];
      if (isPortableRecord(first)) {
        const delta: PortableRecord = isPortableRecord(first.delta) ? first.delta : {};
        const finish = first.finish_reason;
        return {
          content: typeof delta.content === 'string' ? delta.content : '',
          citations: parseCitationAnnotations(delta),
          error: null,
          finishReason: typeof finish === 'string' ? finish.slice(0, MAX_FINISH_REASON_LENGTH) : null,
        };
      }
    }
    return EMPTY_EVENT;
  } catch {
    return EMPTY_EVENT;
  }
}

/**
 * Decodes one batch of SSE payloads into the text chunks to stream, recording
 * any citations they carried in `citations` (first title wins, bounded by the
 * same limit the request asked the provider to enforce).
 *
 * The read loop and the EOF flush both go through here, so a trailing event can
 * never be handled differently from one that arrived mid-stream.
 */
export function decodeEventChunks(
  events: readonly string[],
  state: OpenRouterStreamState
): readonly string[] {
  const citations = state.citations;
  const chunks: string[] = [];
  for (const sseData of events) {
    if (sseData === '[DONE]') continue;
    const parsed = parseOpenRouterData(sseData);
    if (parsed.error) {
      throw new InterleafError('internal', `OpenRouter error: ${parsed.error}`);
    }
    for (const citation of parsed.citations) {
      if (citations.size >= CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS) break;
      if (!citations.has(citation.url)) citations.set(citation.url, citation.title);
    }
    if (parsed.finishReason !== null) state.finishReason = parsed.finishReason;
    if (parsed.content.length > 0) chunks.push(...splitToSafeChunks(parsed.content));
  }
  return chunks;
}

/**
 * The collected citations as the turn's structured web-source metadata.
 *
 * They travel beside the answer rather than inside it. The renderer shows them
 * as inert labelled hosts under their own heading, which keeps them visibly
 * separate from `[src-*]` chips — those point into the reader's own documents,
 * these point out at the web — and keeps an untrusted webpage title out of the
 * model-authored text that later turns replay as assistant history.
 */
export function toWebSources(citations: ReadonlyMap<string, string>): readonly ChatWebSource[] {
  return [...citations].map(([url, title]) => ({ url, title }));
}

function combineSseInput(previous: string, incoming: string): string {
  if (previous.length === 0) return incoming;
  // The provider loop passes the complete prior remainder, while direct
  // parser consumers generally pass only the next chunk. Support both forms
  // without duplicating bytes at a chunk boundary.
  return incoming.startsWith(previous) ? incoming : previous + incoming;
}

/**
 * A turn that asked for an explicit reasoning effort and then produced no
 * answer, or stopped at the response budget, is reported as something the
 * reader can act on: the level spent the budget, not that the provider broke.
 * `null` leaves every other outcome to the ordinary checks.
 */
export function reasoningBudgetError(
  effort: ReasoningEffort | undefined,
  state: OpenRouterStreamState,
  tokenCount: number
): InterleafError | null {
  if (effort === undefined || (tokenCount > 0 && state.finishReason !== 'length')) return null;
  return new InterleafError(
    'validation',
    'The model used its response budget before finishing an answer. Choose a lower reasoning effort or Default, then send again.'
  );
}
