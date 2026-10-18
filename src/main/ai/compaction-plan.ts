import {
  CHAT_COMPACTION_INSTRUCTION,
  CHAT_COMPACTION_MAX_MESSAGES,
  CHAT_COMPACTION_MAX_TRANSCRIPT_TEXT_UNITS,
  CHAT_COMPACTION_SYSTEM_PROMPT,
  CHAT_CONTEXT_HEADROOM_TOKENS,
} from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { AIModelInfo, ChatMessage } from '@shared/types/ai';
import { estimateChatTokens } from './context-tokens';
import { serializeCompactionTranscriptXml, type CompactionTranscriptMessage } from './provenance-serializer';

/** The one compaction request main will send, and what it claims to cover. */
export type CompactionPlan = {
  /** `<transcript>` data envelope: the previous summary plus the covered turns. */
  readonly transcriptXml: string;
  /** Ordinal of the newest message the envelope contains. */
  readonly compactedThroughOrdinal: number;
  /** Ordinals in the envelope, oldest first, for the pre-commit revalidation. */
  readonly coveredOrdinals: readonly number[];
  /** Conservative estimate of the complete request, response reserve included. */
  readonly estimatedRequestTokens: number;
};

const WINDOW_REFUSAL =
  'This conversation cannot be cleaned within the current model context window. Choose a model with a larger window.';

/**
 * Whether a later request would replay this message to the model.
 *
 * This is the history rule the send path applies: everything except a streaming
 * or failed message is replayed. A summary is only allowed to stand in for a
 * message the model would otherwise have seen, so this is also the set the
 * boundary is allowed to cover.
 */
function isReplayedAsHistory(message: ChatMessage): boolean {
  return message.status !== 'streaming' && message.status !== 'failed';
}

/**
 * Whether crossing this message without representing it would lose nothing.
 *
 * A failed turn is never replayed, and an empty row carries no text the model
 * could read, so the boundary may move past either without the summary standing
 * for anything. A cancelled turn with partial text is replayed like any other, so
 * it is content — it must be summarised, not skipped. A streaming message is
 * refused outright elsewhere and stops the prefix here.
 */
function carriesNoReplayedContent(message: ChatMessage): boolean {
  return !isReplayedAsHistory(message) || message.content.trim().length === 0;
}

/**
 * The messages a compaction is allowed to represent, as one contiguous prefix.
 *
 * The oldest end of what still replays is summarised, never a recent suffix: the
 * boundary is a single ordinal, so anything left out beneath it would be claimed
 * by the summary and silently dropped from every later request. The prefix
 * therefore stops at the first message that cannot be represented — a streaming
 * turn — and only carries on past ones that lose nothing when crossed.
 *
 * Turns past the count bound stay after the boundary and keep replaying normally;
 * a later `Clean Context` summarises them in turn.
 */
function compactableMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const prefix: ChatMessage[] = [];
  for (const message of messages) {
    if (message.status === 'streaming') break;
    if (carriesNoReplayedContent(message)) {
      // Crossable: it is skipped, but only while the prefix can still grow past it.
      if (prefix.length >= CHAT_COMPACTION_MAX_MESSAGES) break;
      continue;
    }
    if (prefix.length >= CHAT_COMPACTION_MAX_MESSAGES) break;
    prefix.push(message);
  }
  return prefix;
}

/**
 * Plans one compaction against the session's own effective model.
 *
 * The fixed cost of the call — system prompt, the fixed instruction, the model's
 * own response reserve, the usual safety headroom and the previous stored summary
 * that has to be carried forward — is charged first with the same conservative
 * estimator the send path uses. If that alone does not fit the model's context
 * window, the compaction is refused here, before any provider is contacted and
 * before any state changes.
 *
 * What remains is spent on the oldest contiguous run of turns that fits, in
 * ordinal order, stopping at the first turn the budget cannot hold. The boundary
 * is a single ordinal, so representing a recent suffix would claim the messages
 * beneath it and drop them from every later request; summarising the oldest end
 * instead leaves everything above the boundary replaying normally until another
 * `Clean Context` takes it in turn.
 */
export function planCompaction(input: {
  readonly previousSummary: string | null;
  readonly messages: readonly ChatMessage[];
  readonly model: AIModelInfo;
}): CompactionPlan {
  const candidates = compactableMessages(input.messages);
  if (candidates.length === 0) {
    throw new InterleafError('validation', 'There is nothing new to summarise in this conversation yet.');
  }
  const previousSummary = normalizedSummary(input.previousSummary);
  const framing = serializeCompactionTranscriptXml({ previousSummary, messages: [] });
  const fixedTokens =
    estimateChatTokens(CHAT_COMPACTION_SYSTEM_PROMPT) +
    estimateChatTokens(CHAT_COMPACTION_INSTRUCTION) +
    input.model.maxOutputTokens +
    CHAT_CONTEXT_HEADROOM_TOKENS +
    estimateChatTokens(framing);
  const budget: TranscriptBudget = {
    tokens: input.model.contextWindow - fixedTokens,
    textUnits: CHAT_COMPACTION_MAX_TRANSCRIPT_TEXT_UNITS - framing.length,
  };
  if (budget.tokens <= 0 || budget.textUnits <= 0) {
    throw new InterleafError('validation', WINDOW_REFUSAL);
  }

  const covered = admitOldestFirst(candidates, budget);
  const boundary = covered.at(-1);
  if (!boundary) throw new InterleafError('validation', WINDOW_REFUSAL);

  const transcriptXml = serializeCompactionTranscriptXml({
    previousSummary,
    messages: covered.map(toTranscriptMessage),
  });
  return {
    transcriptXml,
    compactedThroughOrdinal: boundary.ordinal,
    coveredOrdinals: covered.map((message) => message.ordinal),
    estimatedRequestTokens: fixedTokens + estimateChatTokens(transcriptXml) - estimateChatTokens(framing),
  };
}

type TranscriptBudget = {
  readonly tokens: number;
  readonly textUnits: number;
};

/** What one turn adds to the envelope, framing included. */
function messageCost(message: ChatMessage): TranscriptBudget {
  const element = serializeCompactionTranscriptXml({
    previousSummary: null,
    messages: [toTranscriptMessage(message)],
  });
  return { tokens: estimateChatTokens(element), textUnits: element.length };
}

/**
 * The turns that fit, taken in ordinal order and stopping at the first one the
 * budget cannot hold, so the result is always a prefix of what it was given.
 */
function admitOldestFirst(
  messages: readonly ChatMessage[],
  budget: TranscriptBudget
): readonly ChatMessage[] {
  const kept: ChatMessage[] = [];
  let tokens = 0;
  let textUnits = 0;
  for (const message of messages) {
    const cost = messageCost(message);
    if (tokens + cost.tokens > budget.tokens || textUnits + cost.textUnits > budget.textUnits) break;
    tokens += cost.tokens;
    textUnits += cost.textUnits;
    kept.push(message);
  }
  return kept;
}

/** A stored summary is model output: it is carried forward, never trusted. */
function normalizedSummary(summary: string | null): string | null {
  const trimmed = summary?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function toTranscriptMessage(message: ChatMessage): CompactionTranscriptMessage {
  return { role: message.role, ordinal: message.ordinal, content: message.content };
}
