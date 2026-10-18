import {
  CHAT_COMPACTION_MAX_STREAM_EVENTS,
  CHAT_COMPACTION_MAX_STREAM_TEXT_UNITS,
  CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS,
  CHAT_COMPACTION_TIMEOUT_MS,
} from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from './providers/types';

/** What a caller learns when a compaction call does not produce a usable summary. */
const FAILED = 'Interleaf could not clean this conversation. Nothing was changed.';
const TIMED_OUT = 'Cleaning this conversation took too long, so nothing was changed.';
const UNUSABLE = 'The provider returned no usable summary, so nothing was changed.';

/**
 * One bounded compaction call, and nothing else.
 *
 * Every bound is a hard failure rather than a repair: a stream that runs past the
 * event or text limit, a provider that ends without its own `done` event, a
 * summary longer than the stored bound and an empty summary all leave the caller
 * with an error instead of a prefix of provider output, because a partial summary
 * would be stored as if it stood for the whole conversation.
 *
 * The call has a fixed wall-clock deadline covering the wait for the first event
 * and every wait between events, so a provider that stalls cannot hold the
 * session's clean lock open. On every exit — success, bound, timeout,
 * cancellation or shutdown — the iterator is released and the provider is
 * cancelled, and the message handed back never carries provider diagnostics.
 */
export async function runBoundedCompaction(input: {
  readonly provider: AIProvider;
  readonly request: ProviderChatRequest;
  readonly log: Logger;
  /** Asked before every step: true once the run is cancelled or main is closing. */
  readonly isAbandoned: () => boolean;
  readonly timeoutMs?: number;
}): Promise<string> {
  const iterator = input.provider.streamChat(input.request)[Symbol.asyncIterator]();
  const deadline = startDeadline(input.timeoutMs ?? CHAT_COMPACTION_TIMEOUT_MS);
  let text = '';
  let events = 0;
  let sawDone = false;
  try {
    for (;;) {
      if (input.isAbandoned()) throw new InterleafError('internal', FAILED);
      const step = await Promise.race([iterator.next(), deadline.expiry]);
      if (step.done === true) break;
      events += 1;
      if (events > CHAT_COMPACTION_MAX_STREAM_EVENTS) {
        throw new InterleafError('internal', FAILED);
      }
      text = appendBounded(text, step.value);
      if (step.value.type === 'done') {
        sawDone = true;
        break;
      }
    }
    if (!sawDone) throw new InterleafError('internal', FAILED);
    return requireUsableSummary(text);
  } catch (error) {
    input.log.error('Conversation compaction failed', {
      providerId: input.provider.id,
      requestId: input.request.requestId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error instanceof InterleafError ? error : new InterleafError('internal', FAILED);
  } finally {
    deadline.clear();
    // Neither release is awaited: a provider stalled inside its own generator
    // would never settle them, and waiting would hold the failed call — and the
    // session's clean lock — open past the deadline that just fired.
    void iterator.return?.().catch(() => undefined);
    void input.provider.cancel(input.request.requestId).catch(() => undefined);
  }
}

/** Accumulates streamed text, failing rather than truncating at the bound. */
function appendBounded(text: string, event: ProviderChatEvent): string {
  if (event.type !== 'token') return text;
  const next = text + event.token;
  if (next.length > CHAT_COMPACTION_MAX_STREAM_TEXT_UNITS) {
    throw new InterleafError('internal', FAILED);
  }
  return next;
}

/**
 * The summary as it will be stored, or a failure.
 *
 * Nothing here inspects the text for instructions or acts on it: it is data,
 * required only to be non-empty and within the stored bound. Output over that
 * bound is rejected, never cut down, so a truncated sentence is never persisted
 * as a complete account of the conversation.
 */
function requireUsableSummary(text: string): string {
  const summary = text.trim();
  if (summary.length === 0) throw new InterleafError('validation', UNUSABLE);
  if (summary.length > CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS) {
    throw new InterleafError('internal', FAILED);
  }
  return summary;
}

/**
 * One timer for the whole call. `expiry` never resolves, so racing it against the
 * next step turns a stalled provider into a timeout instead of an open wait, and
 * clearing it on exit leaves no pending timer and no rejection behind.
 */
function startDeadline(timeoutMs: number): {
  readonly expiry: Promise<never>;
  readonly clear: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new InterleafError('internal', TIMED_OUT)); }, timeoutMs);
  });
  // The race always attaches a handler, but a timeout that fires as the loop is
  // already leaving must not surface as an unhandled rejection.
  expiry.catch(() => undefined);
  return {
    expiry,
    clear: () => { if (timer) clearTimeout(timer); },
  };
}
