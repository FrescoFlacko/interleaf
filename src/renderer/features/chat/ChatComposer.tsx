import type { ReactNode, RefObject } from 'react';
import type { AIProviderId, AIProviderStatus, ChatContextItem, ChatSession, ReasoningEffort } from '@shared/types/ai';
import { usePromptHistory } from '../../hooks/use-prompt-history';
import { ComposerShell } from '../../components/companion/ComposerShell';
import { AppIcon } from '../../components/AppIcon';
import type { ProviderDiscoveryState } from '../../stores/use-chat-store';
import { ChatContextBudgetMeter } from './ChatContextBudgetMeter';
import { ChatModelPicker } from './ChatModelPicker';
import { ChatWebSearchToggle } from './ChatWebSearchControl';
import type { CleanContextWiring } from './ChatContextBudgetMeter';

type ChatComposerProps = {
  readonly draft: string;
  readonly placeholder: string;
  /**
   * The context row, painted inside the composer card above the field so what
   * the next turn reads sits with the words being written (DESIGN.md, Inline
   * context). Its page-range form is portalled, and stays outside this form.
   */
  readonly context: ReactNode;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly composerDisabled: boolean;
  readonly providers: readonly AIProviderStatus[];
  /** Main's current, actionable providers: the only ones the picker offers. */
  readonly readyProviders: readonly AIProviderStatus[];
  readonly providerDiscovery: ProviderDiscoveryState;
  readonly currentProviderId: AIProviderId;
  readonly currentProviderReady: boolean;
  readonly currentModelId: string | null;
  /** The level saved with the binding; `null` is Default. */
  readonly currentReasoningEffort: ReasoningEffort | null;
  /** Settings' persisted OpenRouter model, used only to label an Auto binding. */
  readonly openRouterConfiguredModel: string | null;
  readonly controlsDisabled: boolean;
  readonly settingsOpen: boolean;
  readonly isStreaming: boolean;
  readonly canSend: boolean;
  /**
   * The session and pinned context the context-window wheel reports on. The
   * wheel reads main's accounting for the last request this session sent; it is
   * given the same inputs the context bar has, and computes nothing itself.
   */
  readonly activeSession: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  /**
   * Whether this conversation can be compacted right now, and the request that
   * would compact it. Passed straight to the context-window panel, where
   * `Clean Context` is offered; the composer derives nothing from it.
   */
  readonly cleanContext: CleanContextWiring;
  /**
   * Whether the bound provider itself declares the hosted web-search path. The
   * control is absent — not merely disabled — for every other provider, so the
   * interface never offers a capability that does not exist.
   */
  readonly webSearchSupported: boolean;
  /** Per-turn opt-in state. Off unless the user turned it on for this turn. */
  readonly webSearchEnabled: boolean;
  readonly onWebSearchChange: (enabled: boolean) => void;
  /**
   * The prompts this conversation has already sent, oldest first, for
   * ArrowUp/ArrowDown recall in the field.
   */
  readonly submittedPrompts: readonly string[];
  /** Conversation identity; traversal restarts when the reader changes chat. */
  readonly promptHistoryKey: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** One choice, one call: the provider, the exact model and its level travel together. */
  readonly onSelectModel: (providerId: AIProviderId, modelId: string, reasoningEffort: ReasoningEffort | null) => void;
  /** Opens provider Settings from the picker's Manage providers action. */
  readonly onOpenProviderSettings: () => void;
  readonly onStop: () => void;
};

/**
 * One composer card: attached context, then the field, then a quiet tool row —
 * the model picker, web search and the context-window meter —
 * with Send/Stop at its right end. The row wraps rather than scrolls, so no
 * control is ever reachable only through a hidden scrollbar.
 */
export function ChatComposer({
  draft,
  placeholder,
  context,
  composerRef,
  composerDisabled,
  providers,
  readyProviders,
  providerDiscovery,
  currentProviderId,
  currentProviderReady,
  currentModelId,
  currentReasoningEffort,
  openRouterConfiguredModel,
  controlsDisabled,
  settingsOpen,
  isStreaming,
  canSend,
  activeSession,
  contextItems,
  cleanContext,
  webSearchSupported,
  webSearchEnabled,
  onWebSearchChange,
  submittedPrompts,
  promptHistoryKey,
  onDraftChange,
  onSubmit,
  onSelectModel,
  onOpenProviderSettings,
  onStop,
}: ChatComposerProps) {
  const promptHistory = usePromptHistory({
    submitted: submittedPrompts,
    onValueChange: onDraftChange,
    resetKey: promptHistoryKey,
  });

  return (
    <ComposerShell className="chat-design-composer">
      {context}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          promptHistory.reset();
          onSubmit();
        }}
        className="chat-design-composer-form"
      >
        <label htmlFor="chat-composer" className="sr-only">Message Reader AI</label>
        <textarea
          ref={composerRef}
          id="chat-composer"
          value={draft}
          rows={2}
          maxLength={100_000}
          disabled={composerDisabled}
          placeholder={placeholder}
          onChange={(event) => { onDraftChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
              return;
            }
            promptHistory.handleKeyDown(event);
          }}
          className="chat-design-input"
        />
        <div className="chat-design-controls">
          <ChatModelPicker
            providers={providers}
            readyProviders={readyProviders}
            discovery={providerDiscovery}
            currentProviderId={currentProviderId}
            currentModelId={currentModelId}
            currentReasoningEffort={currentReasoningEffort}
            currentProviderReady={currentProviderReady}
            openRouterConfiguredModel={openRouterConfiguredModel}
            disabled={controlsDisabled}
            settingsOpen={settingsOpen}
            onSelectModel={onSelectModel}
            onOpenProviderSettings={onOpenProviderSettings}
          />
          <ChatWebSearchToggle
            supported={webSearchSupported}
            enabled={webSearchEnabled}
            providerReady={currentProviderReady}
            controlsDisabled={controlsDisabled}
            onChange={onWebSearchChange}
          />
          {/* The meter reports on the conversation rather than on the pending
            * submission, so it sits with the other per-session controls. */}
          <ChatContextBudgetMeter
            activeSession={activeSession}
            contextItems={contextItems}
            isStreaming={isStreaming}
            cleanContext={cleanContext}
          />
          {/* Send and Stop are distinct shapes as well as names, never colour alone. */}
          {isStreaming ? (
            <button type="button" data-testid="stop-chat-button" aria-label="Stop" title="Stop" onClick={onStop}
              className="chat-design-send" data-tone="stop">
              <AppIcon name="stop" size={14} />
            </button>
          ) : (
            <button type="submit" data-testid="send-chat-button" aria-label="Send" title="Send (Enter)" disabled={!canSend}
              className="chat-design-send">
              <AppIcon name="send" size={16} />
            </button>
          )}
        </div>
      </form>
    </ComposerShell>
  );
}
