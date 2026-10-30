import type { AIProviderId, ChatSession, ReasoningEffort } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { bridge } from '../../app/api-client';
import { applyDefaultChatBinding, resolveNewSessionBinding } from './provider-readiness';
import { loadDocumentProviders } from './provider-discovery';
import {
  chatDocumentId,
  documentLoadStillCurrent,
  errorMessage,
  sameDocumentLoad,
  supersedeTurn,
  type ChatRuntime,
} from './runtime';
import {
  claimCreatedSessionIntent,
  clearedPendingSelection,
  publishCreatedSession,
  rebindCreatedSession,
  withoutBindingIntent,
} from './session-binding';
import { titleRefreshKey } from './session-summaries';
import { mergeContextItems } from './transcript';
import { useUiStore } from '../use-ui-store';
import type { ChatState } from '../use-chat-store';

/** The state of a document load that has just begun or a document just closed. */
function emptyDocumentState(): Partial<ChatState> {
  return {
    providerDiscovery: 'loading',
    ...clearedPendingSelection(),
    bindingIntents: {},
    sessions: [],
    sessionsLoaded: false,
    activeSessionId: null,
    messages: [],
    contextItems: [],
    isStreaming: false,
    activeRequestId: null,
    isCleaningContext: false,
    error: null,
    statusMessage: '',
    lastFailedDraft: null,
  };
}

/**
 * Invalidates everything that belonged to the document being left: its loads,
 * its probe, its turn and its binding ordering. Intents are per document by
 * construction, so they leave with it rather than being carried into the next
 * one, and the revisions go with them so a conversation reopened later starts
 * clean.
 */
function leaveDocument(runtime: ChatRuntime): number {
  const documentSeq = runtime.lifecycle.nextDocument();
  runtime.lifecycle.nextSession();
  runtime.bindings.clear();
  const previousRequest = supersedeTurn(runtime);
  if (previousRequest) void bridge.chat.cancel(previousRequest).catch(() => undefined);
  return documentSeq;
}

export async function initializeDocument(
  runtime: ChatRuntime,
  document: DocumentMetadata | null,
  subscribe: () => () => void
): Promise<void> {
  runtime.lifecycle.ensureSubscribed(subscribe);
  if (!document) {
    closeDocument(runtime);
    return;
  }
  const docKey = `${document.id}:${document.fileHash}`;
  const inFlight = runtime.lifecycle.inFlightLoad(docKey);
  if (inFlight !== null) {
    await inFlight;
    return;
  }
  if (sameDocumentLoad(runtime.get(), document.id, document.fileHash)) return;

  const documentSeq = leaveDocument(runtime);
  // An explicit choice was made about the conversation the reader was about to
  // start in the document they were reading. Opening another document is not
  // that conversation, so the choice is not carried into it; and a rebinding
  // still in flight must not bind, clear an intent, or move the status line in
  // the document being opened.
  runtime.set({ ...emptyDocumentState(), activeDocument: { id: document.id, fileHash: document.fileHash }, isLoading: true });

  // Both reads leave now, in this same turn, and each publishes its own
  // result. Provider discovery can take seconds; the persisted conversation
  // is already on disk and must reach the screen as soon as it is read, so
  // the two must not share a publication barrier.
  const providersTask = loadDocumentProviders(runtime, document.id, documentSeq, runtime.discovery.begin());
  const persistedChatTask = loadPersistedChat(runtime, document.id, documentSeq);
  const load = (async () => {
    try {
      // Neither task rejects: each settles its own branch of the state, and
      // callers such as Ask AI wait here for provider readiness to be known
      // before deciding whether a session may be created.
      await Promise.all([providersTask, persistedChatTask]);
    } finally {
      runtime.lifecycle.finishLoad(docKey);
    }
  })();
  runtime.lifecycle.beginLoad(docKey, load);
  await load;
}

function closeDocument(runtime: ChatRuntime): void {
  leaveDocument(runtime);
  runtime.discovery.invalidate();
  runtime.drafts.clear();
  runtime.lifecycle.closeDocument();
  runtime.set({ ...emptyDocumentState(), activeDocument: null, isLoading: false });
}

/**
 * Publishes this document's persisted conversations as soon as the session read
 * resolves, then hydrates the selected thread.
 *
 * Nothing here waits for provider discovery: reading a stored conversation
 * needs no provider, and the sessions are already on disk. A session already in
 * the store is kept ahead of the loaded list, so a conversation created while
 * this read was in flight survives it.
 */
async function loadPersistedChat(runtime: ChatRuntime, documentId: string, documentSeq: number): Promise<void> {
  try {
    const sessions = await bridge.chat.listSessions(documentId);
    if (!documentLoadStillCurrent(runtime, documentSeq, documentId)) return;
    runtime.set((state) => {
      const mergedSessions = [...sessions];
      for (const session of state.sessions) {
        if (!mergedSessions.some((s) => s.id === session.id)) {
          mergedSessions.unshift(session);
        }
      }
      const activeSessionId = state.activeSessionId ?? mergedSessions[0]?.id ?? null;
      return {
        sessions: mergedSessions,
        sessionsLoaded: true,
        activeSessionId,
        isCleaningContext: runtime.cleaning.flagFor(activeSessionId),
        isLoading: false,
      };
    });
    const published = runtime.get();
    const activeSessionId = published.activeSessionId;
    if (activeSessionId && published.messages.length === 0 && published.contextItems.length === 0) {
      await published.switchSession(activeSessionId);
    }
  } catch (error) {
    if (!runtime.lifecycle.isCurrentDocument(documentSeq)) return;
    runtime.set({
      isLoading: false,
      sessionsLoaded: true,
      error: errorMessage(error instanceof Error ? error : null, 'Could not load document chats.'),
    });
  }
}

/**
 * What this create was explicitly asked for: the caller's arguments, or — when
 * it was called with none — the choice the reader has made for the next
 * conversation. A model is only inherited alongside the provider it was chosen
 * for, so a stale model id cannot be attached to a different provider.
 */
function explicitSelection(
  state: ChatState,
  providerId: AIProviderId | undefined,
  modelId: string | null | undefined
): { providerId: AIProviderId | undefined; modelId: string | null | undefined } {
  if (providerId !== undefined) return { providerId, modelId };
  if (state.pendingProviderId === null) return { providerId: undefined, modelId };
  return { providerId: state.pendingProviderId, modelId: modelId ?? state.pendingModelId };
}

/**
 * The level the new conversation is born with: the one chosen alongside the
 * exact model being bound, or Default. A level never moves to another model.
 */
function chosenEffort(state: ChatState, providerId: AIProviderId, modelId: string | null): ReasoningEffort | null {
  const matches = state.pendingProviderId === providerId && state.pendingModelId !== null && state.pendingModelId === modelId;
  return matches ? state.pendingReasoningEffort : null;
}

export async function createSession(
  runtime: ChatRuntime,
  providerId: AIProviderId | undefined,
  modelId: string | null | undefined
): Promise<ChatSession | null> {
  const state = runtime.get();
  const { activeDocument } = state;
  if (!activeDocument) return null;
  const { id: documentId, fileHash: documentHash } = activeDocument;
  if (state.isStreaming) return null;
  // The binding comes from a probe of the document now open. A list retained
  // from the previous document, or from a probe that failed, names providers
  // but authorizes none of them, so this fails closed no matter what the UI
  // was showing when the caller decided to create.
  // A persisted onboarding default only fills an unspecified choice, and only
  // for a conversation being created now. It is still validated below, so a
  // default that is no longer ready is named rather than replaced.
  //
  // An explicit choice the reader has already made outranks that default and
  // is read here rather than passed in, because the caller that matters most
  // — `Ask AI`, by way of `ensureSessionForDocument` — decided to create
  // before the reader chose, and passes nothing.
  const explicit = explicitSelection(state, providerId, modelId);
  const requested = applyDefaultChatBinding(
    explicit.providerId,
    explicit.modelId,
    useUiStore.getState().loadedSettings?.ai.defaultChat
  );
  const binding = resolveNewSessionBinding(state, requested.providerId, requested.modelId);
  if (!binding.ok) {
    runtime.set({ error: binding.error });
    return null;
  }

  // Which conversation is in view, as a number rather than an id: the reader
  // may navigate back to the one they started from, so "the id is unchanged"
  // is not the same question as "did the reader move the view".
  const sessionSeqAtStart = runtime.lifecycle.sessionSequence;
  runtime.set({ isLoading: true, error: null });
  try {
    const created = await bridge.chat.createSession({
      documentId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      reasoningEffort: chosenEffort(state, binding.providerId, binding.modelId),
    });
    if (!sameDocumentLoad(runtime.get(), documentId, documentHash)) return null;
    // A choice made while this create was in flight is newer than the binding
    // the session was just born with. It is claimed and recorded in the same
    // update that publishes the session, so there is no instant in which the
    // conversation is visible, sendable, and still carrying a binding the
    // reader has already moved off: from here until main answers, the recorded
    // intent refuses the send and names the provider that was chosen.
    const claimed = claimCreatedSessionIntent(runtime, created);
    publishCreatedSession(runtime, created, claimed);
    // A conversation the reader opened themselves while this one was being
    // created is the one they are looking at. Entering the new session now
    // would take the screen away from it, so the session is kept in the list
    // and the view is left where the reader put it.
    if (runtime.lifecycle.isCurrentSession(sessionSeqAtStart)) await runtime.get().switchSession(created.id);
    if (claimed === null) return created;
    if (!sameDocumentLoad(runtime.get(), documentId, documentHash)) return created;
    return await rebindCreatedSession(runtime, created, claimed);
  } catch (error) {
    runtime.set({ isLoading: false, error: errorMessage(error instanceof Error ? error : null, 'Could not create a chat session.') });
    return null;
  }
}

export async function switchSession(runtime: ChatRuntime, sessionId: string): Promise<void> {
  const sequence = runtime.lifecycle.nextSession();
  // A send still waiting for its invoke result belongs to the conversation
  // being left, so it is superseded before anything else can observe it.
  const previousRequest = supersedeTurn(runtime);
  const { activeDocument, activeSessionId: leavingSessionId } = runtime.get();
  if (!activeDocument) return;
  const documentId = activeDocument.id;
  // Record the selection before any await so the thread can render the
  // chosen session at once. A newer switch simply overwrites this state and
  // wins the sequence guard below. A message this conversation failed to send
  // before the user navigated away comes back with it, and only with it.
  runtime.set({
    activeSessionId: sessionId,
    messages: [],
    contextItems: [],
    isLoading: true,
    isStreaming: false,
    activeRequestId: null,
    // The conversation now in view decides this, not the one left behind.
    isCleaningContext: runtime.cleaning.flagFor(sessionId),
    // A clean's progress line belongs to the conversation it is cleaning, so it
    // is left behind with it rather than shown over another one.
    ...(runtime.cleaning.flagFor(leavingSessionId) ? { statusMessage: '' } : {}),
    ...runtime.drafts.recoveredDraftState(documentId, sessionId),
  });
  if (previousRequest) await bridge.chat.cancel(previousRequest).catch(() => undefined);
  if (!runtime.lifecycle.isCurrentSession(sequence)) return;
  try {
    const [messages, contextItems] = await Promise.all([
      bridge.chat.listMessages(sessionId),
      bridge.chat.listContext(sessionId),
    ]);
    const current = runtime.get();
    if (
      !runtime.lifecycle.isCurrentSession(sequence) ||
      current.activeSessionId !== sessionId ||
      chatDocumentId(current) !== documentId
    ) return;
    runtime.set((state) => ({
      messages,
      contextItems: mergeContextItems(contextItems, state.contextItems),
      isLoading: false,
    }));
  } catch (error) {
    if (!runtime.lifecycle.isCurrentSession(sequence)) return;
    runtime.set({ isLoading: false, error: errorMessage(error instanceof Error ? error : null, 'Could not load the chat session.') });
  }
}

export async function renameSession(runtime: ChatRuntime, sessionId: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (!sessionId || !trimmed) return false;
  // The reader's name wins over any automatic title re-read started before it.
  runtime.summaries.next(titleRefreshKey(sessionId));
  try {
    const updated = await bridge.chat.updateSession({ sessionId, title: trimmed });
    runtime.summaries.next(titleRefreshKey(sessionId));
    runtime.set((state) => ({
      sessions: state.sessions.map((session) => (session.id === updated.id ? updated : session)),
      error: null,
    }));
    return true;
  } catch (error) {
    runtime.set({ error: errorMessage(error instanceof Error ? error : null, 'Could not rename the chat session.') });
    return false;
  }
}

/**
 * Deletes the conversation the user acted on, which is not necessarily the
 * active one: only a deletion of the active session clears the open thread.
 */
export async function deleteSession(runtime: ChatRuntime, targetSessionId: string): Promise<void> {
  if (!targetSessionId) return;
  try {
    await bridge.chat.deleteSession(targetSessionId);
    runtime.drafts.forgetPendingDraft(chatDocumentId(runtime.get()), targetSessionId);
    // The conversation the choice was about is gone, so neither its intent nor
    // its ordering means anything; a later answer for it finds no revision to
    // match and publishes nothing.
    runtime.bindings.forget(targetSessionId);
    runtime.set((state) => ({ bindingIntents: withoutBindingIntent(state.bindingIntents, targetSessionId) }));
    const remainingSessions = runtime.get().sessions.filter((session) => session.id !== targetSessionId);
    if (runtime.get().activeSessionId !== targetSessionId) {
      runtime.set({ sessions: remainingSessions });
      return;
    }
    runtime.set({
      sessions: remainingSessions,
      activeSessionId: null,
      messages: [],
      contextItems: [],
      isCleaningContext: false,
      lastFailedDraft: null,
    });
    const next = remainingSessions[0];
    if (next) await runtime.get().switchSession(next.id);
  } catch (error) {
    runtime.set({ error: errorMessage(error instanceof Error ? error : null, 'Could not delete the chat session.') });
  }
}

/**
 * The conversation Ask AI and the attachment actions write into: the open one,
 * the first unarchived one, or a new one.
 */
export async function ensureSessionForDocument(
  runtime: ChatRuntime,
  document: DocumentMetadata
): Promise<ChatSession | null> {
  await runtime.get().initializeDocument(document);
  const state = runtime.get();
  const active = state.sessions.find((session) => session.id === state.activeSessionId && !session.isArchived);
  if (active) return active;
  const nonArchived = state.sessions.find((session) => !session.isArchived);
  if (nonArchived) {
    await state.switchSession(nonArchived.id);
    return nonArchived;
  }
  // Ask AI may only create a conversation once discovery has actually answered
  // for this document; `initializeDocument` above is what waits for that.
  // A new session consumes the persisted chat default if configured and ready,
  // or the first currently ready provider when no default is configured, and
  // fails closed without silent fallback if the default is unavailable.
  return state.createSession();
}
