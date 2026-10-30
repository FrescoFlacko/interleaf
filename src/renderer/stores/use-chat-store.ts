import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AIProviderId, AIProviderStatus, ChatContextItem, ChatMessage, ChatSession, ReasoningEffort } from '@shared/types/ai';
import type { ChatSelectionDescriptor, DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { bridge } from '../app/api-client';
import { cleanContext, CleaningSessions } from './chat/clean-context';
import {
  addEntireDocument,
  addPageRange,
  addSelectionContext,
  removeContext,
} from './chat/context-attachments';
import { ChatLifecycle } from './chat/lifecycle';
import { PreSendDrafts } from './chat/pre-send-drafts';
import { ProviderDiscovery, refreshProviders } from './chat/provider-discovery';
import type { ProviderDiscoveryState, SessionBindingIntents } from './chat/provider-readiness';
import { supersedeTurn, type ChatRuntime } from './chat/runtime';
import { cancel, sendMessage } from './chat/send';
import {
  createSession,
  deleteSession,
  initializeDocument,
  renameSession,
  switchSession,
} from './chat/session-actions';
import { changeSessionProvider, SessionBindingRevisions } from './chat/session-binding';
import { SessionSummaryRefresh, syncSessionTitle } from './chat/session-summaries';
import { handleStreamEvent } from './chat/stream-events';
import { ChatTurns } from './chat/turns';

// Readiness lives with the discovery state it depends on; the store re-exports
// it so views keep importing one module for chat state and its meaning.
export {
  actionableProviders,
  isProviderActionable,
  isProviderReady,
  type ProviderDiscoveryState,
} from './chat/provider-readiness';

/** Everything a chat view renders. */
type ChatData = {
  /** The open document revision, whose id and hash change together; `null` when none is open. */
  activeDocument: Pick<DocumentMetadata, 'id' | 'fileHash'> | null;
  providers: readonly AIProviderStatus[];
  /**
   * Counts provider configuration re-reads. Settings can change the model a
   * provider actually runs — an `openrouter/auto` session keeps its stored id
   * while the configured OpenRouter model moves — so the session row alone
   * cannot say whether main's effective binding still matches what a view is
   * showing. This number changes whenever that configuration is re-read, which
   * is the renderer's only truthful cue to ask main again.
   */
  providerBindingRevision: number;
  /**
   * How discovery stands for the open document. Probing external CLIs and a
   * loopback server can take seconds, so `providers` is authoritative only
   * while this is `succeeded`: during `loading` it may still hold the previous
   * document's list, and after `failed` it holds statuses no current probe
   * confirmed. Readiness decisions must go through `chat-provider-readiness`
   * rather than reading `providers` directly.
   */
  providerDiscovery: ProviderDiscoveryState;
  /**
   * The provider the reader explicitly chose for the next conversation, before
   * one exists to carry it.
   *
   * It lives here rather than in the panel because the panel is not the only
   * thing that creates conversations: `Ask AI` creates one through
   * `ensureSessionForDocument`, asynchronously, and a choice held in component
   * state is invisible to it. A session created while this is set is created
   * *with* it, so the name the reader is looking at, the binding persisted on
   * the session, and the provider main spawns are one decision rather than
   * three. `null` means no explicit choice — the configured default, or the
   * first ready provider, then legitimately applies.
   */
  pendingProviderId: AIProviderId | null;
  /** The model chosen alongside `pendingProviderId`, on the same terms. */
  pendingModelId: string | null;
  /** The reasoning level chosen with `pendingModelId`; `null` is Default. */
  pendingReasoningEffort: ReasoningEffort | null;
  /**
   * The same thing for conversations that already exist: a choice the stored
   * session does not carry yet, or one main refused.
   *
   * Keyed by session so one conversation's unsettled binding neither blocks nor
   * is cleared by another's. A conversation listed here cannot send: what the
   * reader chose and what the row would spawn disagree, and the disagreement is
   * resolved by main, not by falling back to the row.
   */
  bindingIntents: SessionBindingIntents;
  sessions: readonly ChatSession[];
  /**
   * Whether this document's persisted session list has settled. It is published
   * as soon as that read resolves, independently of provider discovery, so an
   * empty `sessions` before it is unknown rather than empty.
   */
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  messages: readonly ChatMessage[];
  contextItems: readonly ChatContextItem[];
  isLoading: boolean;
  isStreaming: boolean;
  activeRequestId: string | null;
  /** A `Clean Context` request is in flight for the active session. */
  isCleaningContext: boolean;
  error: string | null;
  statusMessage: string;
  composerFocusNonce: number;
  composerPlaceholder: string;
  lastFailedDraft: string | null;
};

/** Everything a chat view can ask the controller to do. */
type ChatActions = {
  initializeDocument: (document: DocumentMetadata | null) => Promise<void>;
  refreshProviders: (options?: { readonly forceRefresh?: boolean }) => Promise<void>;
  createSession: (providerId?: AIProviderId, modelId?: string | null) => Promise<ChatSession | null>;
  switchSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<void>;
  deleteActiveSession: () => Promise<void>;
  changeSessionProvider: (providerId: AIProviderId, modelId?: string | null, reasoningEffort?: ReasoningEffort | null) => Promise<void>;
  /**
   * The one entry point for "the reader picked this provider".
   *
   * Which of the two meanings it has — rebind the open conversation, or bind
   * the next one — is decided here, against the store's own current state,
   * because a view deciding it renders one frame before it acts on it: a
   * conversation created in between would make the view choose the branch for
   * "no session yet" and then drop the choice on the floor.
   */
  selectProvider: (providerId: AIProviderId, modelId: string | null, reasoningEffort?: ReasoningEffort | null) => Promise<void>;
  /**
   * The same contract for a model chosen within the current provider. A level
   * is part of the choice; leaving it out chooses Default.
   */
  selectModel: (modelId: string | null, reasoningEffort?: ReasoningEffort | null) => Promise<void>;
  addSelectionContext: (document: DocumentMetadata, descriptor: ChatSelectionDescriptor, focusComposer: boolean) => Promise<boolean>;
  addPageRange: (document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>;
  addEntireDocument: (document: DocumentMetadata, location: DocumentLocation, automatic?: boolean) => Promise<boolean>;
  removeContext: (contextItemId: string) => Promise<void>;
  /**
   * Asks main to compact this conversation: summarise it with the session's own
   * provider and model, and clear its attached context. The renderer sends no
   * transcript, model or summary of its own, and resolves to whether the
   * compaction was committed.
   */
  cleanContext: () => Promise<boolean>;
  /**
   * `webSearch` opts this single turn into the bound provider's hosted web
   * search. It defaults to off and is re-validated in main against the
   * provider's declared capability, so the renderer cannot turn it on for a
   * provider that does not offer it.
   */
  sendMessage: (content: string, webSearch?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  requestComposerFocus: (placeholder?: string) => void;
  clearFailedDraft: () => void;
};

export type ChatState = ChatData & ChatActions;

const DEFAULT_COMPOSER_PLACEHOLDER = 'Ask a question about this document…';

function initialChatData(): ChatData {
  return {
    activeDocument: null,
    providers: [],
    providerBindingRevision: 0,
    providerDiscovery: 'loading',
    pendingProviderId: null,
    pendingModelId: null,
    pendingReasoningEffort: null,
    bindingIntents: {},
    sessions: [],
    sessionsLoaded: false,
    activeSessionId: null,
    messages: [],
    contextItems: [],
    isLoading: false,
    isStreaming: false,
    activeRequestId: null,
    isCleaningContext: false,
    error: null,
    statusMessage: '',
    composerFocusNonce: 0,
    composerPlaceholder: DEFAULT_COMPOSER_PLACEHOLDER,
    lastFailedDraft: null,
  };
}

/** One chat controller: its store, and the means to end it. */
export type ChatStore = StoreApi<ChatState> & {
  /**
   * Ends the controller: the stream is unsubscribed, the running turn is
   * superseded and its request cancelled, and every continuation still in
   * flight finds it no longer owns anything, so nothing it resolves is written.
   */
  readonly dispose: () => void;
};

function chatActions(runtime: ChatRuntime): ChatActions {
  const subscribe = (): (() => void) => {
    const offStream = bridge.chat.onStreamEvent((event) => { handleStreamEvent(runtime, event); });
    const offTitles = bridge.chat.onSessionTitleChanged((event) => { syncSessionTitle(runtime, event); });
    return () => { offStream(); offTitles(); };
  };
  return {
    initializeDocument: (document) => initializeDocument(runtime, document, subscribe),
    refreshProviders: (options) => refreshProviders(runtime, options),
    createSession: (providerId, modelId) => createSession(runtime, providerId, modelId),
    switchSession: (sessionId) => switchSession(runtime, sessionId),
    renameSession: (sessionId, title) => renameSession(runtime, sessionId, title),
    deleteSession: (sessionId) => deleteSession(runtime, sessionId),
    deleteActiveSession: async () => {
      const targetSessionId = runtime.get().activeSessionId;
      if (targetSessionId) await deleteSession(runtime, targetSessionId);
    },
    changeSessionProvider: (providerId, modelId, reasoningEffort) =>
      changeSessionProvider(runtime, providerId, modelId, reasoningEffort),
    selectProvider: async (providerId, modelId, reasoningEffort = null) => {
      if (runtime.get().activeSessionId !== null) {
        await changeSessionProvider(runtime, providerId, modelId, reasoningEffort);
        return;
      }
      runtime.set({ pendingProviderId: providerId, pendingModelId: modelId, pendingReasoningEffort: reasoningEffort, error: null });
    },
    selectModel: async (modelId, reasoningEffort = null) => {
      const state = runtime.get();
      const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
      if (activeSession) {
        await changeSessionProvider(runtime, activeSession.providerId, modelId, reasoningEffort);
        return;
      }
      runtime.set({ pendingModelId: modelId, pendingReasoningEffort: reasoningEffort, error: null });
    },
    addSelectionContext: (document, descriptor, focusComposer) =>
      addSelectionContext(runtime, document, descriptor, focusComposer),
    addPageRange: (document, pageStart, pageEnd) => addPageRange(runtime, document, pageStart, pageEnd),
    addEntireDocument: (document, location, automatic = false) =>
      addEntireDocument(runtime, document, location, automatic),
    removeContext: (contextItemId) => removeContext(runtime, contextItemId),
    cleanContext: () => cleanContext(runtime),
    sendMessage: (content, webSearch = false) => sendMessage(runtime, content, webSearch),
    cancel: () => cancel(runtime),
    requestComposerFocus: (placeholder = DEFAULT_COMPOSER_PLACEHOLDER) => {
      runtime.set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1, composerPlaceholder: placeholder }));
    },
    clearFailedDraft: () => {
      const state = runtime.get();
      runtime.drafts.forgetPendingDraft(state.activeDocument?.id ?? null, state.activeSessionId);
      runtime.set({ lastFailedDraft: null });
    },
  };
}

/**
 * Creates one chat controller. All of its race bookkeeping — document and
 * conversation sequences, the turn model, parked drafts, probe ordering,
 * binding revisions, summary refreshes and clean reservations — is owned by
 * this instance, so two controllers never observe each other.
 */
export function createChatStore(): ChatStore {
  const lifecycle = new ChatLifecycle();
  const runtime: ChatRuntime = {
    get: () => store.getState(),
    set: (patch) => {
      if (!lifecycle.isDisposed) store.setState(patch);
    },
    lifecycle,
    turns: new ChatTurns(),
    drafts: new PreSendDrafts(),
    discovery: new ProviderDiscovery(),
    bindings: new SessionBindingRevisions(),
    summaries: new SessionSummaryRefresh(),
    cleaning: new CleaningSessions(),
  };
  const store = createStore<ChatState>()(() => ({ ...initialChatData(), ...chatActions(runtime) }));
  const dispose = (): void => {
    if (lifecycle.isDisposed) return;
    const previousRequest = supersedeTurn(runtime);
    runtime.discovery.invalidate();
    lifecycle.dispose();
    if (previousRequest) void bridge.chat.cancel(previousRequest).catch(() => undefined);
  };
  return { ...store, dispose };
}

/** The chat controller the views below it read; the app provides exactly one. */
export const ChatStoreContext = createContext<ChatStore | null>(null);

/** The provided chat controller, for actions taken outside render. */
export function useChatStoreApi(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (store === null) throw new Error('Chat state was read outside a ChatStoreContext provider.');
  return store;
}

/** Subscribes a view to the slice of chat state it renders. */
export function useChatStore<Selected>(selector: (state: ChatState) => Selected): Selected {
  return useStore(useChatStoreApi(), selector);
}
