import { useEffect, useRef, useState } from 'react';
import type { AIProviderId, AIProviderStatus, ChatMessage, ChatSession, ReasoningEffort } from '@shared/types/ai';
import type { AppSettings } from '@shared/schemas/settings';
import { LoadingShimmerText } from '../../components/LoadingShimmer';
import { useAnnotationStore } from '../../stores/use-annotation-store';
import { useChatStore, actionableProviders, isProviderActionable } from '../../stores/use-chat-store';
import type { SessionBindingIntents } from '../../stores/chat/provider-readiness';
import { selectActiveDocument, selectAdapter, useReaderStore } from '../../stores/use-reader-store';
import { useUiStore } from '../../stores/use-ui-store';
import { locationToAnchor } from '../reader/annotations/dom-anchors';
import './chat-design.css';
import { ChatGeneratingNotice, shouldShowGeneratingNotice } from './ChatGeneratingNotice';
import { ChatComposer } from './ChatComposer';
import { ChatAddContextMenu } from './ChatAddContextMenu';
import { ChatContextShelf } from './ChatContextShelf';
import { ChatEmptyThread } from './ChatEmptyThread';
import { ChatErrorNotice } from './ChatErrorNotice';
import { ChatHeader } from './ChatHeader';
import { ChatHistoryView } from './ChatHistoryView';
import { ChatProviderStatusBanner } from './ChatProviderStatusBanner';
import { ChatThread } from './ChatThread';
import { ChatToast } from './ChatToast';
import { composerPlaceholder, displayProviderName } from './chat-labels';
import { cleanContextControlState } from './clean-context-readiness';
import { composerOwnerKey, placeComposerDraft } from './composer-draft-ownership';
import { panelAvailability } from './panel-availability';
import { useChatToast } from './use-chat-toast';
import { useComposerFill } from './use-composer-fill';
import { useChatWebSearch } from './use-chat-web-search';
import { useThreadBottomPin } from './use-thread-bottom-pin';

/**
 * An assistant turn that has been opened but has produced no text yet.
 *
 * While the request is live, ChatGeneratingNotice stands exactly where this
 * placeholder's answer will appear, so painting the placeholder as well would
 * put two Reader AI labels on one turn. A settled turn — complete, failed or
 * cancelled — is not a placeholder and keeps its own bubble even when empty.
 */
function isEmptyStreamingPlaceholder(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.status === 'streaming' && message.content.length === 0;
}
type ChatPanelSelection = {
  readonly currentProviderId: AIProviderId;
  readonly currentProviderInfo: AIProviderStatus | undefined;
  readonly currentProviderReady: boolean;
  readonly currentModelId: string | null;
  /** The level that goes with `currentModelId`; `null` is Default. */
  readonly currentReasoningEffort: ReasoningEffort | null;
  readonly newChatProviderReady: boolean;
};

function resolveNewChatModel(
  explicitModelId: string | null,
  explicitProviderId: AIProviderId | null,
  targetProviderId: AIProviderId,
  defaultChat: AppSettings['ai']['defaultChat'] | undefined,
  providerInfo: AIProviderStatus | undefined
): string | null {
  if (explicitModelId !== null) return explicitModelId;
  if (explicitProviderId === null && defaultChat?.providerId === targetProviderId && defaultChat.modelId !== null) {
    return defaultChat.modelId;
  }
  return providerInfo?.models[0]?.id ?? null;
}

function resolveChatPanelSelection(
  activeSession: ChatSession | null,
  explicitProviderId: AIProviderId | null,
  explicitModelId: string | null,
  explicitEffort: ReasoningEffort | null,
  defaultChat: AppSettings['ai']['defaultChat'] | undefined,
  readyProviders: readonly AIProviderStatus[],
  providers: readonly AIProviderStatus[],
  /** Choices the store is still reconciling with the stored rows, by session. */
  bindingIntents: SessionBindingIntents
): ChatPanelSelection {
  const newChatProviderId =
    explicitProviderId ?? defaultChat?.providerId ?? readyProviders[0]?.id ?? 'openrouter';
  const newChatProviderInfo = providers.find((p) => p.id === newChatProviderId);
  const newChatProviderReady = readyProviders.some((p) => p.id === newChatProviderId);

  if (activeSession !== null) {
    // While the store is still reconciling the reader's choice with the stored
    // row, the choice is what this control names: it is what the reader asked
    // for, and no turn can be sent on the row underneath it until the two agree
    // — the send gate refuses for exactly as long as this disagreement lasts.
    const bindingIntent = bindingIntents[activeSession.id];
    const boundProviderId = bindingIntent?.providerId ?? activeSession.providerId;
    const boundProviderInfo = providers.find((p) => p.id === boundProviderId);
    return {
      currentProviderId: boundProviderId,
      currentProviderInfo: boundProviderInfo,
      currentProviderReady: readyProviders.some((p) => p.id === boundProviderId),
      currentModelId:
        bindingIntent === undefined
          ? activeSession.modelId
          : (bindingIntent.modelId ?? boundProviderInfo?.models[0]?.id ?? null),
      currentReasoningEffort: bindingIntent === undefined ? activeSession.reasoningEffort : bindingIntent.reasoningEffort,
      newChatProviderReady,
    };
  }

  const newChatModelId = resolveNewChatModel(explicitModelId, explicitProviderId, newChatProviderId, defaultChat, newChatProviderInfo);
  return {
    currentProviderId: newChatProviderId,
    currentProviderInfo: newChatProviderInfo,
    currentProviderReady: newChatProviderReady,
    currentModelId: newChatModelId,
    // A level is shown only with the exact model it was chosen for, which is
    // also the only case in which the new conversation is created with it.
    currentReasoningEffort:
      explicitProviderId === newChatProviderId && explicitModelId !== null && explicitModelId === newChatModelId ? explicitEffort : null,
    newChatProviderReady,
  };
}

export function ChatPanel() {
  const activeDocument = useReaderStore(selectActiveDocument);
  const currentPage = useReaderStore((state) => state.currentPage);
  const explicitLocation = useReaderStore((state) => state.explicitNavigationLocation);
  const goToLocation = useReaderStore((state) => state.goToLocation);
  const adapter = useReaderStore(selectAdapter);
  const createAnnotation = useAnnotationStore((state) => state.create);
  const openSettings = useUiStore((state) => state.openSettings);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  // The companion panel keeps every tab mounted and hides the inactive ones.
  // A hidden scroll container has no layout box, so its scroll offset is lost
  // while it is away; the panel has to re-place itself when its tab returns.
  const rightTab = useUiStore((state) => state.rightTab);
  const state = useChatStore((chat) => chat);

  const [draft, setDraft] = useState('');
  // The choice for the next conversation is the store's, not this component's.
  // `Ask AI` can create that conversation from outside the panel while the menu
  // is open, and a choice kept in component state would be invisible to it —
  // the session would be born on another provider while this panel went on
  // naming the chosen one. `null` means no explicit choice has been made, and
  // the first ready provider is then a default rather than a substitution.
  const providerId = state.pendingProviderId;
  const modelId = state.pendingModelId;
  const [view, setView] = useState<'chat' | 'history'>('chat');
  // One transient notice slot for the whole panel, painted out of flow so a
  // confirmation never moves the control that produced it.
  const toast = useChatToast();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const addContextRef = useRef<HTMLButtonElement>(null);
  const prevViewRef = useRef(view);
  // Starters, follow-ups, Retry and Reuse prompt only ever fill the draft.
  const fillComposer = useComposerFill(composerRef, setDraft);

  const focusComposerOrToggle = () => {
    window.queueMicrotask(() => {
      if (composerRef.current && !composerRef.current.disabled) {
        composerRef.current.focus();
      } else {
        backButtonRef.current?.focus();
      }
    });
  };

  const initializeDocument = state.initializeDocument;
  useEffect(() => {
    void initializeDocument(activeDocument);
  }, [activeDocument, initializeDocument]);

  useEffect(() => {
    if (state.composerFocusNonce > 0) composerRef.current?.focus();
  }, [state.composerFocusNonce]);

  /**
   * The composer's text follows the conversation it belongs to.
   *
   * `placeComposerDraft` holds the rule; this applies it whenever the owner or
   * the store's recovery changes. The draft is read through a ref so that
   * typing does not re-run the effect and re-place the same text.
   */
  const composerOwner = composerOwnerKey(activeDocument, state.activeSessionId);
  const composerOwnerRef = useRef(composerOwner);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastFailedDraft = state.lastFailedDraft;
  const clearFailedDraft = state.clearFailedDraft;
  useEffect(() => {
    const placement = placeComposerDraft({
      ownerChanged: composerOwnerRef.current !== composerOwner,
      recovered: lastFailedDraft,
      currentDraft: draftRef.current,
    });
    composerOwnerRef.current = composerOwner;
    if (placement.draft !== null) {
      draftRef.current = placement.draft;
      setDraft(placement.draft);
    }
    if (placement.consumeRecovery) clearFailedDraft();
  }, [composerOwner, lastFailedDraft, clearFailedDraft]);

  const showGeneratingNotice = shouldShowGeneratingNotice(state.isStreaming, state.messages.at(-1));
  // Laid out at its newest turn before paint, including when the thread becomes
  // the visible screen and tab again after being hidden.
  useThreadBottomPin({
    scrollerRef: messagesRef,
    view,
    rightTab,
    sessionId: state.activeSessionId,
    loading: state.isLoading,
    messages: state.messages,
    generating: showGeneratingNotice,
  });

  useEffect(() => {
    if (prevViewRef.current === 'history' && view === 'chat') {
      focusComposerOrToggle();
    }
    prevViewRef.current = view;
  }, [view]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
  // Only a successful probe of the open document authorizes an action. The
  // provider objects themselves stay available for labels while a probe runs or
  // after one fails, which is all they are then good for.
  const readyProviders = actionableProviders(state);

  const defaultChat = useUiStore((s) => s.loadedSettings?.ai.defaultChat);
  const openRouterConfiguredModel = useUiStore((s) => s.loadedSettings?.ai.openRouterModel ?? null);
  const selection = resolveChatPanelSelection(
    activeSession,
    providerId,
    modelId,
    state.pendingReasoningEffort,
    defaultChat,
    readyProviders,
    state.providers,
    state.bindingIntents
  );
  const {
    currentProviderId,
    currentProviderInfo,
    currentProviderReady,
    currentModelId,
    currentReasoningEffort,
    newChatProviderReady,
  } = selection;
  const activeSessionProviderInfo = state.providers.find((p) => p.id === activeSession?.providerId);
  const activeSessionProviderReady = isProviderActionable(state, activeSession?.providerId);
  // The provider that will actually run the turn decides whether the control
  // exists — never the provider the composer happens to be previewing.
  const webSearch = useChatWebSearch({
    session: activeSession,
    sessionProvider: activeSessionProviderInfo,
    composerProvider: currentProviderInfo,
  });

  // Keep an explicit model choice selected when drafting a new conversation.
  // OpenRouter's choices come from the catalog main lists on demand, not from
  // the provider's published models, so an exact catalog id is kept as chosen;
  // main validates it when the conversation is bound.
  const selectModel = state.selectModel;
  useEffect(() => {
    if (activeSession || modelId === null || currentProviderInfo?.id === 'openrouter') return;
    const models = currentProviderInfo?.models ?? [];
    if (!models.some((model: { readonly id: string }) => model.id === modelId)) {
      void selectModel(models[0]?.id ?? null);
    }
  }, [activeSession, modelId, currentProviderInfo, selectModel]);

  if (!activeDocument) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        <h2 className="font-semibold text-text-primary">Chat</h2>
        <p className="mt-2 leading-relaxed">Open a document to start a grounded research conversation.</p>
      </div>
    );
  }

  const handleCreateSession = async () => {
    // No arguments: the choice is in the store, and `createSession` reads it
    // there at the moment it resolves the binding — which is also how a choice
    // made while the create is in flight still reaches the new conversation.
    const created = await state.createSession();
    if (created) {
      setView('chat');
      focusComposerOrToggle();
    }
  };

  /**
   * Sends a turn, first creating the conversation when the document has none
   * open. The open chat is the conversation the reader means, so they are never
   * asked to create one before typing. A create that fails hands the prompt
   * back to the composer and leaves its error on the status line.
   */
  const submitTurn = async (content: string, useWebSearch: boolean) => {
    if (activeSession === null) {
      const created = await state.createSession();
      if (!created) {
        setDraft(content);
        return;
      }
    }
    await state.sendMessage(content, useWebSearch);
  };

  /**
   * Opening a card enters that thread immediately. The screen change is a
   * consequence of the click, never of the session read finishing: gating it
   * on `switchSession` left the Conversations screen up for the whole IPC
   * round trip, so a card could look unresponsive after a tab-away/tab-back
   * cycle. The store records the selection synchronously, so the thread shows
   * the chosen session while its messages load.
   */
  const openSession = (sessionId: string) => {
    setView('chat');
    if (sessionId === state.activeSessionId) {
      focusComposerOrToggle();
      return;
    }
    void state.switchSession(sessionId).then(() => {
      focusComposerOrToggle();
    });
  };

  // The picker's choice is one provider-and-model pair, handed to the store as
  // a single act so it decides whether it rebinds the open conversation or
  // binds the next one. This component renders a frame before the click it is
  // reacting to, so a conversation created in between would make a decision
  // taken here wrong — and so would writing the provider and the model apart.
  const handleSelectModel = async (nextProviderId: AIProviderId, nextModelId: string, nextEffort: ReasoningEffort | null) => {
    await state.selectProvider(nextProviderId, nextModelId, nextEffort);
  };

  /**
   * Saves an answer through the existing location-note contract: a note
   * annotation anchored at the reader's current location. No new storage or
   * anchoring capability is introduced.
   */
  const handleSaveNote = async (content: string): Promise<boolean> => {
    if (!adapter) return false;
    const location = explicitLocation ?? adapter.getReadingLocation().location;
    const created = await createAnnotation({
      documentId: activeDocument.id,
      type: 'note',
      anchor: locationToAnchor(location),
      note: content,
      isLocationNote: true,
    });
    return created !== null;
  };
  // What this conversation has already asked, oldest first: the composer walks
  // back through it with ArrowUp. The transcript is the record of submitted
  // prompts, so no second copy is kept anywhere.
  const submittedPrompts = state.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const lastMessage = state.messages.at(-1);
  // The notice at the end of the transcript already carries the turn it stands
  // in for, so that one placeholder is withheld for exactly as long as it does.
  const visibleMessages = state.messages.filter(
    (message) =>
      !(showGeneratingNotice && message === lastMessage && isEmptyStreamingPlaceholder(message))
  );

  const availability = panelAvailability({
    activeSession,
    activeSessionProviderReady,
    currentProviderReady: newChatProviderReady,
    isStreaming: state.isStreaming,
    isLoading: state.isLoading,
    isCleaningContext: state.isCleaningContext,
    draft,
  });
  const cleanContextControl = cleanContextControlState({
    activeSession,
    sessionProvider: activeSessionProviderInfo,
    messages: state.messages,
    providerDiscovery: state.providerDiscovery,
    providerReady: activeSessionProviderReady,
    isStreaming: state.isStreaming,
    isLoading: state.isLoading,
    isCleaningContext: state.isCleaningContext,
  });

  // The readiness above and the request that acts on it travel together to the
  // context-window panel, which is the only place either is read.
  const cleanContextWiring = { control: cleanContextControl, onClean: state.cleanContext };

  return (
    <section aria-label="AI research chat" className="chat-design flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ChatProviderStatusBanner
        discovery={state.providerDiscovery}
        hasReadyProvider={readyProviders.length > 0}
        onOpenProviderSettings={() => { openSettings('ai'); }}
        onRetryDiscovery={() => { void state.refreshProviders({ forceRefresh: true }); }}
      />

      {view === 'history' ? (
        <ChatHistoryView
          sessions={state.sessions}
          sessionsLoaded={state.sessionsLoaded}
          activeSessionId={state.activeSessionId}
          providers={state.providers}
          providerDiscovery={state.providerDiscovery}
          error={state.error}
          isStreaming={state.isStreaming}
          cleaningSessionId={state.isCleaningContext ? state.activeSessionId : null}
          canCreateSession={availability.canCreateSession}
          onCreateSession={() => { void handleCreateSession(); }}
          onOpenProviderSettings={() => { openSettings('ai'); }}
          onOpenSession={openSession}
          onRenameSession={state.renameSession}
          onDeleteSession={(sessionId) => { void state.deleteSession(sessionId); }}
        />
      ) : (
        <>
          <ChatHeader
            conversationTitle={activeSession?.title ?? null}
            isArchived={activeSession?.isArchived ?? false}
            canCreateSession={availability.canCreateSession}
            backButtonRef={backButtonRef}
            onCreateSession={() => { void handleCreateSession(); }}
            onOpenSessions={() => { setView('history'); }}
          />
          {activeSession?.isArchived && (
            <div className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-2 text-2xs text-warning">
              <span className="font-semibold">Archived:</span> This chat belongs to an older document revision.
              Answers remain readable, but new turns require a new session for the active document.
            </div>
          )}
          {/* Calling the session's provider unavailable is a claim about a
              finished probe, never about one still running. */}
          {activeSession && state.providerDiscovery === 'succeeded' && !activeSessionProviderReady && (
            <div data-testid="active-provider-unavailable" role="alert" className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-1.5 text-2xs text-warning">
              The active session is bound to {displayProviderName(activeSession.providerId, activeSessionProviderInfo?.name)}, which is unavailable. Configure that provider in Settings before sending.
            </div>
          )}

          <div
            ref={messagesRef}
            aria-label="Chat messages"
            data-testid="chat-messages"
            className="chat-design-messages flex flex-1 min-h-0 flex-col overflow-y-auto"
          >
            <ChatEmptyThread
              messageCount={state.messages.length}
              isLoading={state.isLoading}
              documentTitle={activeDocument.title}
              contextItems={state.contextItems}
              startersAvailable={!availability.composerDisabled}
              onStarter={fillComposer}
            />

            <ChatThread
              messages={state.messages}
              visibleMessages={visibleMessages}
              isStreaming={state.isStreaming}
              activeSessionId={state.activeSessionId}
              session={activeSession}
              sessionProvider={activeSessionProviderInfo}
              contextItems={state.contextItems}
              documentTitle={activeDocument.title}
              composerAvailable={!availability.composerDisabled}
              canSaveNote={adapter !== null}
              onSaveNote={handleSaveNote}
              onNotice={toast.publish}
              goToLocation={goToLocation}
              onFill={fillComposer}
            />
            <ChatGeneratingNotice isStreaming={state.isStreaming} lastMessage={state.messages.at(-1)} />
          </div>

          <div className="chat-design-footer relative flex min-h-0 flex-col">
            <ChatToast notice={toast.notice} onDismiss={toast.dismiss} />

            {state.statusMessage && (
              <p data-testid="chat-status-message" role="status" className="shrink-0 text-2xs text-text-secondary">
                <LoadingShimmerText>{state.statusMessage}</LoadingShimmerText>
              </p>
            )}
            {state.error && (
              <ChatErrorNotice error={state.error} onOpenProviderSettings={() => { openSettings('ai:openrouter'); }} />
            )}

            <ChatComposer
              draft={draft}
              placeholder={composerPlaceholder({
                discovery: state.providerDiscovery,
                hasReadyProvider: readyProviders.length > 0,
                isArchived: activeSession?.isArchived ?? false,
                sessionPlaceholder: state.composerPlaceholder,
                hasMessages: state.messages.length > 0,
              })}
              shelf={(
                <ChatContextShelf
                  activeSession={activeSession}
                  contextItems={state.contextItems}
                  isStreaming={state.isStreaming}
                  disabled={cleanContextControl.contextMutationsDisabled}
                  cleanContext={cleanContextWiring}
                  addContextRef={addContextRef}
                  removeContext={state.removeContext}
                />
              )}
              addContext={(
                <ChatAddContextMenu
                  activeDocument={activeDocument}
                  currentPage={currentPage}
                  explicitLocation={explicitLocation}
                  contextItems={state.contextItems}
                  disabled={cleanContextControl.contextMutationsDisabled}
                  triggerRef={addContextRef}
                  addEntireDocument={state.addEntireDocument}
                  addPageRange={state.addPageRange}
                />
              )}
              composerRef={composerRef}
              composerDisabled={availability.composerDisabled}
              providers={state.providers}
              readyProviders={readyProviders}
              providerDiscovery={state.providerDiscovery}
              currentProviderId={currentProviderId}
              currentProviderReady={currentProviderReady}
              currentModelId={currentModelId}
              currentReasoningEffort={currentReasoningEffort}
              openRouterConfiguredModel={openRouterConfiguredModel}
              controlsDisabled={availability.controlsDisabled}
              settingsOpen={settingsOpen}
              isStreaming={state.isStreaming}
              canSend={availability.canSend}
              webSearchSupported={webSearch.supported}
              webSearchEnabled={webSearch.enabled}
              onWebSearchChange={webSearch.setEnabled}
              submittedPrompts={submittedPrompts}
              promptHistoryKey={composerOwner}
              onDraftChange={setDraft}
              onSubmit={() => {
                if (!availability.canSend || state.isStreaming) return;
                const content = draft.trim();
                setDraft('');
                void submitTurn(content, webSearch.consume());
              }}
              onSelectModel={(nextProviderId, nextModelId, nextEffort): void => { void handleSelectModel(nextProviderId, nextModelId, nextEffort); }}
              onOpenProviderSettings={() => { openSettings('ai'); }}
              onStop={() => { void state.cancel(); }}
            />
          </div>
        </>
      )}
    </section>
  );
}
