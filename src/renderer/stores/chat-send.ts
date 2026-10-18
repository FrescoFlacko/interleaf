import { reportRejection } from '@shared/models/caught-error';
import type { ChatMessage, SendChatMessageResult } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { bridge } from '../app/api-client';
import { ATTACH_FAILED_ERROR, attachNearbyContext, readingLocation } from './chat-context-attachments';
import type { PreSendOwner } from './chat-pre-send-drafts';
import { CLEANING_SESSION_MESSAGE, evaluateSendGate, sessionProviderBlockMessage } from './chat-provider-readiness';
import { chatDocumentId, errorMessage, moveTurn, sameDocumentLoad, type ChatRuntime } from './chat-runtime';
import { settleEarlyTerminal, type AcknowledgedTurn } from './chat-stream-events';
import { transcriptWithCompletedTurn } from './chat-transcript';
import { selectActiveDocument, useReaderStore } from './use-reader-store';
import type { ChatState } from './use-chat-store';

const IDENTITY_MISMATCH_ERROR =
  'The reader is showing a different document than this conversation, so the message was not sent. Reopen this document and try again.';
const SESSION_CHANGED_ERROR =
  'The chat session changed before the document was attached, so the message was not sent.';
/** Never shown: a newer send already owns the composer and its recovery. */
const SEND_SUPERSEDED_ERROR = 'A newer message replaced this one before it was sent.';

/**
 * Whether this send must not proceed, naming the reason when it is one the
 * reader is owed.
 *
 * Nothing is said about an empty draft or a turn already running, which the
 * composer prevents anyway. A provider that no current probe reports as ready
 * is reported: the send was asked for and did not happen.
 */
function refusedSend(runtime: ChatRuntime, sessionId: string, trimmedContent: string): boolean {
  const gate = evaluateSendGate(runtime.get(), sessionId, trimmedContent);
  if (gate.allowed) return false;
  // A reported refusal hands the words back: the composer clears itself on
  // submit, and a reader told "this did not happen" with an empty box has lost
  // their question. It only fills a composer that is empty, so a reader who has
  // started typing again keeps what they are typing.
  if (gate.error !== null) runtime.set({ error: gate.error, lastFailedDraft: trimmedContent });
  return true;
}

/** Binds a pre-send outcome to the document, conversation and turn that started it. */
function preSendOwner(runtime: ChatRuntime, sessionId: string, turn: number, draft: string): PreSendOwner {
  const documentId = chatDocumentId(runtime.get());
  return {
    documentId,
    sessionId,
    draft,
    // A session id alone does not identify a conversation across a document
    // change: another document can hold a session with the same id, and this
    // draft was never typed in it. Both have to match for the outcome to be
    // shown rather than parked for the conversation that owns it.
    isActiveSession: () => runtime.get().activeSessionId === sessionId && chatDocumentId(runtime.get()) === documentId,
    isCurrentSend: () => runtime.turns.isCurrent(turn),
    showFailure: (error) => {
      moveTurn(runtime, { type: 'settle', turn, outcome: 'failed' }, { error, statusMessage: '', lastFailedDraft: draft });
    },
  };
}

/** Why this send may no longer be dispatched, or `null` when it still may. */
function dispatchBlockMessage(state: ChatState, owner: PreSendOwner): string | null {
  if (chatDocumentId(state) !== owner.documentId) return IDENTITY_MISMATCH_ERROR;
  if (!owner.isActiveSession()) return SESSION_CHANGED_ERROR;
  // A newer send owns the composer and its own recovery; this one is dropped
  // rather than reported, which `settlePreSendFailure` takes care of.
  if (!owner.isCurrentSend()) return SEND_SUPERSEDED_ERROR;
  // A clean started while this send was preparing its context: main would refuse
  // the turn, so it is stopped here and the draft is handed back.
  if (state.isCleaningContext) return CLEANING_SESSION_MESSAGE;
  return sessionProviderBlockMessage(state, owner.sessionId);
}

/**
 * Whether this send must not reach the provider after all, having claimed the
 * composer and prepared its context.
 *
 * Synchronous on purpose. It is called from `sendMessage` in the same
 * continuation as the IPC call it guards, so between the answer and the call
 * there is no point at which a queued provider refresh, session switch or
 * document change can run. It re-asks all three questions the earlier gate
 * answered before the pre-send awaits: the conversation that typed the draft is
 * still the one on screen, no newer send has taken the composer, and a current
 * successful probe still reports this conversation's provider as ready.
 */
function refusedDispatch(runtime: ChatRuntime, owner: PreSendOwner): boolean {
  const blocked = dispatchBlockMessage(runtime.get(), owner);
  if (blocked === null) return false;
  runtime.drafts.settlePreSendFailure(owner, blocked);
  return true;
}

/**
 * The reader's document, when a question asked with nothing attached should
 * receive bounded context around the live reading position. A session that
 * already carries context is left exactly as the user built it, and with no
 * document open there is nothing to attach and nothing to mismatch.
 */
function documentNeedingContext(runtime: ChatRuntime): DocumentMetadata | null {
  if (runtime.get().contextItems.length > 0) return null;
  return selectActiveDocument(useReaderStore.getState());
}

/**
 * Attaches nearby context before the turn is sent: PDF context spans ten pages
 * on either side of the current page (clamped to the document); reflowable
 * formats attach the indexed chunk at the current location.
 *
 * Returns true when the send may proceed. When the reader no longer shows this
 * chat's document, or the attachment fails or stops being current, the send is
 * suppressed and the draft is preserved for the conversation that owns it
 * instead of reaching the provider with no context at all.
 */
async function ensureAutomaticNearbyContext(
  runtime: ChatRuntime,
  owner: PreSendOwner,
  document: DocumentMetadata,
  fallbackLocation: DocumentLocation | null
): Promise<boolean> {
  // A reader showing some other document (or another revision of this one) is
  // not authority to send this conversation's question: the identities have to
  // agree or the turn fails closed.
  if (!sameDocumentLoad(runtime.get(), document.id, document.fileHash)) {
    runtime.drafts.settlePreSendFailure(owner, IDENTITY_MISMATCH_ERROR);
    return false;
  }
  const outcome = await attachNearbyContext(runtime, document, fallbackLocation);
  if (outcome.attached && owner.isActiveSession() && owner.isCurrentSend()) {
    // The attachment announced itself in the status line, but this turn is
    // already under way and the notice is about to be stale, so it is taken
    // back down rather than left over the composer.
    runtime.set({ statusMessage: '' });
    return true;
  }
  // A rejection here is this send's failure, not the open conversation's: it is
  // handed to the owner, which shows it only while that conversation is still
  // active and otherwise parks it with the draft until the user returns.
  runtime.drafts.settlePreSendFailure(
    owner,
    outcome.error ?? (owner.isActiveSession() ? ATTACH_FAILED_ERROR : SESSION_CHANGED_ERROR)
  );
  return false;
}

export async function sendMessage(runtime: ChatRuntime, content: string, webSearch: boolean): Promise<void> {
  const sessionId = runtime.get().activeSessionId;
  const trimmed = content.trim();
  // The streaming owner is claimed before the turn advances: a second
  // submission arriving while the first one is still preparing its context
  // must bounce off this guard without invalidating the send that owns the
  // composer. The same guard refuses a turn whose provider no current probe
  // reports as ready, so a stale panel or a direct caller cannot dispatch on
  // readiness that belongs to another document or to a failed probe.
  if (!sessionId || refusedSend(runtime, sessionId, trimmed)) return;
  const fallbackLocation = readingLocation();

  // Claimed synchronously so the composer cannot submit twice while the
  // automatic attachment below is still in flight. Progress is shown in the
  // transcript, where the answer will appear; the status line carries only
  // messages the reader may need to act on, so a send clears it.
  moveTurn(runtime, { type: 'begin', sessionId }, { error: null, statusMessage: '', lastFailedDraft: null });
  const turn = runtime.turns.phase.turn;
  // Bound to the document, conversation and turn as they are right now, before
  // anything is awaited. Every outcome below belongs to this send, so a
  // document opened while it was preparing can neither inherit this draft nor
  // strand it under an identity it never had.
  const owner = preSendOwner(runtime, sessionId, turn, trimmed);
  runtime.drafts.forgetPendingDraft(chatDocumentId(runtime.get()), sessionId);

  const document = documentNeedingContext(runtime);
  if (document !== null && !(await ensureAutomaticNearbyContext(runtime, owner, document, fallbackLocation))) return;
  // The last word on readiness, taken here rather than inside a helper that
  // awaits: returning from an async call hands the event loop back, which is
  // exactly the window a queued provider refresh or document switch needs to
  // invalidate the answer this send is about to use.
  if (refusedDispatch(runtime, owner)) return;

  runtime.turns.apply({ type: 'dispatch', turn });
  let result: SendChatMessageResult;
  try {
    // Same continuation as the check above, so the readiness just confirmed is
    // still the answer when the turn crosses the bridge.
    result = await bridge.chat.sendMessage(sessionId, trimmed, fallbackLocation, webSearch);
  } catch (error) {
    if (!runtime.turns.isCurrent(turn)) return;
    moveTurn(runtime, { type: 'settle', turn, outcome: 'failed' }, {
      error: errorMessage(error instanceof Error ? error : null, 'Could not send the chat message.'),
      statusMessage: '',
      lastFailedDraft: trimmed,
    });
    return;
  }
  await acknowledgeSend(runtime, { result, sessionId, trimmed, turn });
}

/**
 * Settles the invoke result against the turn it started.
 *
 * From here the turn is the provider's, and a failure will be reported by a
 * stream event that carries only its request id, so the words the reader
 * submitted are held against that id until the turn settles. Attached context
 * is a standing statement about this conversation, so the accepted turn leaves
 * the chips in place.
 */
async function acknowledgeSend(runtime: ChatRuntime, acked: AcknowledgedTurn): Promise<void> {
  const { result, sessionId, turn } = acked;
  runtime.drafts.rememberSubmittedPrompt(result.requestId, acked.trimmed);
  const phase = runtime.turns.phase;
  if (phase.kind !== 'awaiting-ack' || phase.turn !== turn || runtime.get().activeSessionId !== sessionId) {
    await abandonAcknowledgedSend(runtime, acked);
    return;
  }
  const acknowledge = { type: 'acknowledge', turn, requestId: result.requestId } as const;
  const earlyTerminal = phase.earlyTerminals.get(result.requestId);
  if (earlyTerminal === undefined) {
    moveTurn(runtime, acknowledge, (state) => ({ messages: transcriptWithCompletedTurn(state.messages, result) }));
    return;
  }
  runtime.turns.apply(acknowledge);
  settleEarlyTerminal(runtime, earlyTerminal, acked);
}

/**
 * The invoke came back for a turn this conversation no longer runs. If the
 * reader stopped it, the transcript shows it stopped; if they navigated away or
 * a newer turn took over, its answer belongs to nobody and is cancelled.
 */
async function abandonAcknowledgedSend(runtime: ChatRuntime, acked: AcknowledgedTurn): Promise<void> {
  const { result, sessionId, turn } = acked;
  runtime.drafts.forgetSubmittedPrompt(result.requestId);
  runtime.turns.recordSettled(result.requestId);
  const sessionStillActive = runtime.get().activeSessionId === sessionId;
  if (sessionStillActive && runtime.turns.isSettledAt(turn)) {
    runtime.set((state) => ({
      messages: withCancelledRequest(transcriptWithCompletedTurn(state.messages, result), result.requestId),
    }));
    return;
  }
  if (runtime.turns.isCurrent(turn)) moveTurn(runtime, { type: 'settle', turn, outcome: 'superseded' });
  await bridge.chat.cancel(result.requestId).catch(() => undefined);
}

function withCancelledRequest(messages: readonly ChatMessage[], requestId: string): readonly ChatMessage[] {
  return messages.map((message) =>
    message.requestId === requestId && message.status === 'streaming' ? { ...message, status: 'cancelled' as const } : message
  );
}

export async function cancel(runtime: ChatRuntime): Promise<void> {
  const requestId = runtime.get().activeRequestId;
  if (!requestId) return;
  const turn = runtime.turns.phase.turn;
  runtime.turns.recordSettled(requestId);
  // Stopping is the reader's own decision, so the turn they stopped is not
  // handed back to the composer.
  runtime.drafts.forgetSubmittedPrompt(requestId);
  await reportRejection(bridge.chat.cancel(requestId), (caught) => {
    runtime.set({ error: errorMessage(caught, 'Could not stop the response.') });
  });
  if (!runtime.turns.isCurrent(turn) || runtime.get().activeRequestId !== requestId) return;
  moveTurn(runtime, { type: 'settle', turn, outcome: 'cancelled' }, (state) => ({
    statusMessage: '',
    messages: withCancelledRequest(state.messages, requestId),
  }));
}
