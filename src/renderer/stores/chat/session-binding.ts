import type { AIProviderId, ChatSession, ReasoningEffort } from '@shared/types/ai';
import { bridge } from '../../app/api-client';
import { discoveryBlockMessage, type SessionBindingIntent, type SessionBindingIntents } from './provider-readiness';
import { chatDocumentId, documentLoadStillCurrent, errorMessage, type ChatRuntime } from './runtime';
import type { ChatState } from '../use-chat-store';

/**
 * The newest binding decision made about each conversation, by session id.
 *
 * Per conversation rather than one counter for the store: a choice made about
 * one conversation says nothing about another, and a global counter let a
 * rebinding of the session in view silently discard the answer for a session the
 * reader had left — or, worse, let a rebinding issued *later* from a slower path
 * carry a higher number than the choice that superseded it.
 *
 * Every binding mutation reserves a number here before it is issued, re-checks
 * it before crossing IPC, and re-checks it again when main answers. An older
 * decision therefore neither writes nor publishes over a newer one, whichever
 * order the answers arrive in; main keeps the same ordering for the stored row.
 */
export class SessionBindingRevisions {
  readonly #revisions = new Map<string, number>();

  reserve(sessionId: string): number {
    const next = (this.#revisions.get(sessionId) ?? 0) + 1;
    this.#revisions.set(sessionId, next);
    return next;
  }

  isCurrent(sessionId: string, revision: number): boolean {
    return this.#revisions.get(sessionId) === revision;
  }

  /** The conversation is gone, so a later answer for it finds nothing to match. */
  forget(sessionId: string): void {
    this.#revisions.delete(sessionId);
  }

  clear(): void {
    this.#revisions.clear();
  }
}

/** A choice claimed for a conversation, with the revision that orders it. */
export type ClaimedIntent = { readonly intent: SessionBindingIntent; readonly revision: number };

/** The request a binding carries, as far as the helpers below need it. */
type BindingRequest = {
  readonly sessionId: string;
  readonly providerId: AIProviderId;
  readonly modelId: string | null;
  /** Travels with the model in the same write; `null` is Default. */
  readonly reasoningEffort: ReasoningEffort | null;
  readonly revision: number;
  readonly showLoading: boolean;
};

type CommitRequest = BindingRequest & {
  /** Whether the model is the reader's, or main's to resolve for the provider. */
  readonly passModel: boolean;
  /** Already recorded by the caller, as one step with publishing the session. */
  readonly intent: SessionBindingIntent | null;
};

/**
 * Retires any standing choice for the next conversation — because the
 * conversation it was for now exists and carries it, or because the reader
 * moved to a different document.
 */
export function clearedPendingSelection(): { pendingProviderId: null; pendingModelId: null; pendingReasoningEffort: null } {
  return { pendingProviderId: null, pendingModelId: null, pendingReasoningEffort: null };
}

/** The same record without this conversation's intent. */
export function withoutBindingIntent(
  intents: SessionBindingIntents,
  sessionId: string
): SessionBindingIntents {
  if (intents[sessionId] === undefined) return intents;
  return Object.fromEntries(Object.entries(intents).filter(([id]) => id !== sessionId));
}

export async function changeSessionProvider(
  runtime: ChatRuntime,
  providerId: AIProviderId,
  modelId: string | null | undefined,
  reasoningEffort: ReasoningEffort | null = null
): Promise<void> {
  const sessionId = runtime.get().activeSessionId;
  if (!sessionId) return;
  // Rebinding may deliberately choose a provider that is not ready — the
  // panel then says so and refuses to send — but it may not be decided from a
  // list no current probe stands behind.
  const blocked = discoveryBlockMessage(runtime.get());
  if (blocked !== null) {
    runtime.set({ error: blocked });
    return;
  }
  await commitSessionBinding(runtime, {
    sessionId,
    providerId,
    // `undefined` means "whatever model main resolves for that provider", which
    // the intent records as no model rather than carrying the model the
    // conversation is on now — that one belongs to the provider being left.
    modelId: modelId ?? null,
    // A level belongs to the model it was chosen for, so a provider-only
    // change goes back to Default rather than carrying it across.
    reasoningEffort: modelId === undefined ? null : reasoningEffort,
    passModel: modelId !== undefined,
    revision: runtime.bindings.reserve(sessionId),
    showLoading: true,
    intent: null,
  });
}

/**
 * Claims the reader's standing choice for a conversation that has just been
 * created, as one step with publishing that conversation.
 *
 * Returns the intent to record, or `null` when the session was born carrying the
 * choice (or there was none). Reserving the revision here, at the moment the
 * intent is taken, is what keeps this path ordered against the provider menu: a
 * choice the reader makes afterwards reserves a higher number and this one is
 * abandoned before it is issued, rather than being issued later and winning by
 * arrival.
 */
export function claimCreatedSessionIntent(runtime: ChatRuntime, created: ChatSession): ClaimedIntent | null {
  const state = runtime.get();
  const chosenProviderId = state.pendingProviderId;
  if (chosenProviderId === null || state.activeDocument === null) return null;
  // Compared by value rather than by "did anything happen while we waited":
  // what matters is only whether the conversation as it exists now carries the
  // choice the reader last made.
  const alreadyBound =
    chosenProviderId === created.providerId &&
    (state.pendingModelId ?? created.modelId) === created.modelId &&
    state.pendingReasoningEffort === created.reasoningEffort;
  if (alreadyBound) return null;
  return {
    intent: {
      sessionId: created.id,
      documentId: state.activeDocument.id,
      providerId: chosenProviderId,
      modelId: state.pendingModelId,
      reasoningEffort: state.pendingReasoningEffort,
      status: 'pending',
      error: null,
    },
    revision: runtime.bindings.reserve(created.id),
  };
}

/**
 * Publishes a newly created conversation together with the choice it is about
 * to be moved onto, in one update.
 *
 * The two belong in the same `set` because the gap between them is exactly the
 * window in which the conversation would be visible and sendable on the binding
 * it was born with.
 */
export function publishCreatedSession(runtime: ChatRuntime, created: ChatSession, claimed: ClaimedIntent | null): void {
  if (claimed === null) {
    runtime.set((current) => ({ sessions: [created, ...current.sessions], isLoading: false }));
    if (runtime.get().pendingProviderId !== null) runtime.set(clearedPendingSelection());
    return;
  }
  runtime.set((current) => ({
    sessions: [created, ...current.sessions],
    isLoading: false,
    bindingIntents: { ...current.bindingIntents, [created.id]: claimed.intent },
    // The conversation the choice was for now exists and carries it as an
    // intent, so the standing choice for the *next* one is spent.
    ...clearedPendingSelection(),
  }));
}

/**
 * Moves a just-created conversation onto the choice claimed for it, through the
 * same validated path an ordinary rebinding uses.
 *
 * Main re-checks readiness there and refuses in the reader's words if the chosen
 * provider cannot run a turn; nothing here substitutes another provider. It runs
 * after the caller's switch, which clears the status line for the conversation
 * it enters — a refusal reported before that would be wiped.
 */
export async function rebindCreatedSession(
  runtime: ChatRuntime,
  created: ChatSession,
  claimed: ClaimedIntent
): Promise<ChatSession> {
  const bound = await commitSessionBinding(runtime, {
    sessionId: created.id,
    providerId: claimed.intent.providerId,
    modelId: claimed.intent.modelId,
    reasoningEffort: claimed.intent.reasoningEffort,
    passModel: true,
    revision: claimed.revision,
    showLoading: false,
    intent: claimed.intent,
  });
  return bound ?? created;
}

/**
 * The one path that moves a conversation onto another provider, whether the
 * reader asked from the provider menu or made the choice while the conversation
 * was still being created.
 *
 * Nothing is chosen here: the typed `updateSession` call is main's to validate,
 * and a refusal is reported in main's words. What this owns is ordering and
 * honesty about it. The reserved revision is re-checked immediately before the
 * call and again when main answers, so an older decision neither issues nor
 * publishes over a newer one; the document load is re-checked on the same terms,
 * so an answer for a document the reader has left cannot bind a session, clear an
 * intent made since, or move that document's status line. Until it settles the
 * conversation carries a recorded intent, which is what refuses a send rather
 * than letting the stored row spawn a turn the reader did not ask for.
 */
async function commitSessionBinding(runtime: ChatRuntime, request: CommitRequest): Promise<ChatSession | null> {
  const documentId = request.intent?.documentId ?? chatDocumentId(runtime.get());
  if (documentId === null) return null;
  const documentSeq = runtime.lifecycle.documentSequence;
  const intent = request.intent ?? recordPendingIntent(runtime, request, documentId);
  // A newer choice about this same conversation was made between taking this
  // intent and getting here. It owns the conversation, including the recorded
  // intent, so this one is abandoned without touching anything.
  if (!runtime.bindings.isCurrent(request.sessionId, request.revision)) return null;
  const stillOwns = (): boolean =>
    documentLoadStillCurrent(runtime, documentSeq, documentId) &&
    runtime.bindings.isCurrent(request.sessionId, request.revision);
  try {
    const updated = await bridge.chat.updateSession({
      sessionId: request.sessionId,
      providerId: request.providerId,
      ...(request.passModel ? { modelId: request.modelId } : {}),
      // Always sent, so the provider, model and level land as one write.
      reasoningEffort: request.reasoningEffort,
    });
    if (!stillOwns()) return null;
    runtime.set(settledBindingPatch(runtime.get(), request, updated));
    return updated;
  } catch (error) {
    if (!stillOwns()) return null;
    runtime.set(refusedBindingPatch(runtime.get(), request, intent, error instanceof Error ? error : null));
    return null;
  }
}

/** Records the choice as unsettled, which is what refuses a send until it lands. */
function recordPendingIntent(runtime: ChatRuntime, request: BindingRequest, documentId: string): SessionBindingIntent {
  const intent: SessionBindingIntent = {
    sessionId: request.sessionId,
    documentId,
    providerId: request.providerId,
    modelId: request.modelId,
    reasoningEffort: request.reasoningEffort,
    status: 'pending',
    error: null,
  };
  runtime.set({
    bindingIntents: { ...runtime.get().bindingIntents, [request.sessionId]: intent },
    ...(request.showLoading ? { isLoading: true } : {}),
    error: null,
  });
  return intent;
}

/** Main wrote the binding: the row is now the reader's choice, so the intent goes. */
function settledBindingPatch(state: ChatState, request: BindingRequest, updated: ChatSession): Partial<ChatState> {
  return {
    sessions: state.sessions.map((session) => (session.id === updated.id ? updated : session)),
    bindingIntents: withoutBindingIntent(state.bindingIntents, request.sessionId),
    ...(request.showLoading ? { isLoading: false } : {}),
  };
}

/**
 * Main refused the choice, so the conversation is left on the row it kept — and
 * refused for sending. Falling back to that row would spawn the next turn from
 * the provider the reader was moving away from.
 */
function refusedBindingPatch(
  state: ChatState,
  request: BindingRequest,
  intent: SessionBindingIntent,
  error: Error | null
): Partial<ChatState> {
  const message = errorMessage(error, 'Could not use the selected AI provider for this conversation.');
  return {
    bindingIntents: { ...state.bindingIntents, [request.sessionId]: { ...intent, status: 'failed', error: message } },
    ...(request.showLoading ? { isLoading: false } : {}),
    error: message,
  };
}
