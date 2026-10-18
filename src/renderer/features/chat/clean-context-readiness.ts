import type { AIProviderStatus, ChatMessage, ChatSession } from '@shared/types/ai';
import { displayProviderName } from './chat-labels';

/** Everything the `Clean Context` control needs, decided in one place. */
export type CleanContextControlState = {
  /** The control is only part of a live, unarchived conversation's UI. */
  readonly present: boolean;
  /** False whenever main would refuse the request, for any of its reasons. */
  readonly canClean: boolean;
  readonly isCleaning: boolean;
  /**
   * Whether this conversation's attached-context mutations are withheld. Main
   * refuses them for an archived session, during a turn, and during a clean —
   * which clears the session's attached context itself when it commits. With no
   * conversation yet they stay available: attaching starts one, as Ask AI does
   * (`ensureSessionForDocument`), and a provider that is not ready is named.
   */
  readonly contextMutationsDisabled: boolean;
  /**
   * How the session's current main-resolved provider and model read to a person.
   * It is disclosure text only; the request carries the session id and nothing
   * else, and main resolves the provider it actually calls.
   */
  readonly target: string;
};

type CleanContextReadinessInput = {
  readonly activeSession: ChatSession | null;
  readonly sessionProvider: AIProviderStatus | undefined;
  readonly messages: readonly ChatMessage[];
  readonly providerDiscovery: string;
  readonly providerReady: boolean;
  readonly isStreaming: boolean;
  readonly isLoading: boolean;
  readonly isCleaningContext: boolean;
};

/**
 * Whether this conversation can be compacted right now, and what compacting it
 * would call.
 *
 * Compaction is offered only where main would accept it: a live session on the
 * open document, no turn or cleanup already running, a finished probe that found
 * the session's provider ready, and at least one settled turn worth summarising
 * that the stored summary does not already cover.
 * Main re-checks every one of these — this only keeps the control honest, so it
 * never offers an action that would be refused.
 */
export function cleanContextControlState(input: CleanContextReadinessInput): CleanContextControlState {
  const session = input.activeSession;
  const present = session !== null && !session.isArchived;
  return {
    present,
    canClean:
      present &&
      !input.isStreaming &&
      !input.isLoading &&
      !input.isCleaningContext &&
      input.providerDiscovery === 'succeeded' &&
      input.providerReady &&
      hasSummarisableTurn(input.messages, session.compactedThroughOrdinal),
    isCleaning: input.isCleaningContext,
    contextMutationsDisabled: session?.isArchived === true || input.isStreaming || input.isCleaningContext,
    target: compactionTarget(session, input.sessionProvider),
  };
}

/**
 * A conversation has something to summarise when a settled message sits past the
 * boundary the stored summary already covers. A conversation with nothing
 * settled, or one whose every settled turn is already summarised, does not — and
 * a single new completed turn is enough to offer the action again.
 */
function hasSummarisableTurn(messages: readonly ChatMessage[], compactedThroughOrdinal: number | null): boolean {
  const boundary = compactedThroughOrdinal ?? -1;
  return messages.some(
    (message) =>
      message.ordinal > boundary && message.status === 'complete' && message.content.trim().length > 0
  );
}

/** The session's provider, with its model when the session names one. */
function compactionTarget(session: ChatSession | null, provider: AIProviderStatus | undefined): string {
  if (session === null) return 'the current provider';
  const name = displayProviderName(session.providerId, provider?.name);
  if (session.modelId === null) return name;
  return `${name} · ${session.modelId}`;
}
