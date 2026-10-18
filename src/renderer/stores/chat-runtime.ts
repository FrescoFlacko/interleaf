import type { ChatState } from './use-chat-store';
import type { ChatLifecycle } from './chat-lifecycle';
import { turnProjection, type ChatTurns, type TurnEvent } from './chat-turns';
import type { PreSendDrafts } from './chat-pre-send-drafts';
import type { ProviderDiscovery } from './chat-provider-discovery';
import type { SessionBindingRevisions } from './chat-session-binding';
import type { SessionSummaryRefresh } from './chat-session-summaries';
import type { CleaningSessions } from './chat-clean-context';

export type ChatStatePatch = Partial<ChatState> | ((current: ChatState) => Partial<ChatState>);

/**
 * One chat controller's state and the collaborators that own its race
 * bookkeeping. Every module that implements a chat action receives this rather
 * than reaching for shared module state, so two controllers never interfere.
 */
export type ChatRuntime = {
  readonly get: () => ChatState;
  /** Publishes to the store; a no-op once the controller is disposed. */
  readonly set: (patch: ChatStatePatch) => void;
  readonly lifecycle: ChatLifecycle;
  readonly turns: ChatTurns;
  readonly drafts: PreSendDrafts;
  readonly discovery: ProviderDiscovery;
  readonly bindings: SessionBindingRevisions;
  readonly summaries: SessionSummaryRefresh;
  readonly cleaning: CleaningSessions;
};

/** The open document's id, or `null` when none is open. */
export function chatDocumentId(state: ChatState): string | null {
  return state.activeDocument?.id ?? null;
}

/** Whether the store still holds the document load this work was started for. */
export function sameDocumentLoad(state: ChatState, documentId: string, documentHash: string): boolean {
  return state.activeDocument?.id === documentId && state.activeDocument.fileHash === documentHash;
}

/**
 * True while the store still shows the document load these reads were started
 * for. A newer document (or a closed one) owns the state from that point on.
 */
export function documentLoadStillCurrent(runtime: ChatRuntime, documentSeq: number, documentId: string): boolean {
  return runtime.lifecycle.isCurrentDocument(documentSeq) && chatDocumentId(runtime.get()) === documentId;
}

/**
 * Moves the turn and publishes its projection in the same update as `patch`, so
 * `isStreaming` and `activeRequestId` are never out of step with the turn model.
 */
export function moveTurn(runtime: ChatRuntime, event: TurnEvent, patch: ChatStatePatch = {}): void {
  runtime.turns.apply(event);
  const projection = turnProjection(runtime.turns.phase);
  runtime.set((current) => ({ ...(typeof patch === 'function' ? patch(current) : patch), ...projection }));
}

/**
 * Replaces whatever turn is running — a switch, a document change or disposal —
 * and stops the request it was following, which now belongs to nobody.
 */
export function supersedeTurn(runtime: ChatRuntime): string | null {
  const previousRequest = turnProjection(runtime.turns.phase).activeRequestId;
  runtime.turns.apply({ type: 'supersede' });
  return previousRequest;
}

export function errorMessage(cause: Error | null, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}
