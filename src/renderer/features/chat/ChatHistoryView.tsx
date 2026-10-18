import { useState, type SyntheticEvent } from 'react';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';
import { useChatStoreApi, type ProviderDiscoveryState } from '../../stores/use-chat-store';
import { AppIcon } from '../../components/AppIcon';
import { ChatSessionCard, type SessionCardMode } from './ChatSessionCard';
import { ChatSessionsPlaceholder } from './ChatSessionsPlaceholder';
import { displayProviderName, isProviderDefaultModel, modelLabel } from './chat-labels';
import { sessionProviderReady } from './session-readiness';

type ChatHistoryViewProps = {
  readonly sessions: readonly ChatSession[];
  /**
   * Whether the persisted session read for this document has settled. An empty
   * list before it has is unknown, not empty, so the screen must not announce
   * that the reader has no conversations.
   */
  readonly sessionsLoaded: boolean;
  readonly activeSessionId: string | null;
  readonly providers: readonly AIProviderStatus[];
  /**
   * How provider discovery stands. Unless it succeeded, a card's binding is
   * simply not known to be unavailable, so no card reports it as such.
   */
  readonly providerDiscovery: ProviderDiscoveryState;
  readonly error: string | null;
  readonly isStreaming: boolean;
  /**
   * The conversation whose `Clean Context` is running, or `null`. Only that
   * card's own actions are withheld; the others stay usable.
   */
  readonly cleaningSessionId: string | null;
  readonly canCreateSession: boolean;
  readonly onCreateSession: () => void;
  readonly onOpenProviderSettings: () => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onRenameSession: (sessionId: string, title: string) => Promise<boolean>;
  readonly onDeleteSession: (sessionId: string) => void;
};

/**
 * Conversations screen from reference 2b. The cards are the only session
 * browser: each one carries its own provider/model binding, counts and actions,
 * and opening one goes straight to that thread.
 */
export function ChatHistoryView({
  sessions,
  sessionsLoaded,
  activeSessionId,
  providers,
  providerDiscovery,
  error,
  isStreaming,
  cleaningSessionId,
  canCreateSession,
  onCreateSession,
  onOpenProviderSettings,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
}: ChatHistoryViewProps) {
  const chatStore = useChatStoreApi();
  const [editing, setEditing] = useState<{ readonly id: string; readonly mode: SessionCardMode } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const handleSaveRename = async (sessionId: string, event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = renameDraft.trim();
    if (!trimmed) return;
    const beforeError = chatStore.getState().error;
    try {
      const success = await onRenameSession(sessionId, trimmed);
      const afterError = chatStore.getState().error;
      if (!success || (afterError && afterError !== beforeError)) return;
      setEditing(null);
    } catch {
      // Keep rename editing open on failure
    }
  };

  const modeFor = (sessionId: string): SessionCardMode =>
    editing?.id === sessionId ? editing.mode : 'idle';

  return (
    <div className="chat-design-sessions">
      <div className="chat-design-sessions-header">
        <h2 className="chat-design-sessions-title">Conversations</h2>
        <button
          type="button"
          data-testid="configure-ai-providers"
          onClick={onOpenProviderSettings}
          aria-label="Configure AI providers"
          title="Configure AI providers"
          className="chat-design-gear focus:outline-none focus:ring-2 focus:ring-focus-ring"
        >
          {/* The app's own settings glyph at the app's icon size, so this
              control does not read a size smaller than every other icon. */}
          <AppIcon name="display-settings" size={18} />
        </button>
        <button
          type="button"
          data-testid="new-conversation-button"
          aria-label="New conversation"
          title="New conversation"
          disabled={!canCreateSession}
          onClick={onCreateSession}
          className="chat-design-create focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40"
        >
          <AppIcon name="add" size={13} />New
        </button>
      </div>

      <div className="chat-design-sessions-body">
        {error && (
          <p data-testid="chat-error-message" role="alert" className="rounded-md bg-danger/10 p-2 text-xs text-danger">
            {error}
          </p>
        )}

        {sessions.length === 0 ? (
          <ChatSessionsPlaceholder sessionsLoaded={sessionsLoaded} />
        ) : (
          <ul aria-label="Conversations" className="chat-design-card-list">
            {sessions.map((session) => {
              const providerInfo = providers.find((provider) => provider.id === session.providerId);
              return (
                <ChatSessionCard
                  key={session.id}
                  session={session}
                  isCurrent={session.id === activeSessionId}
                  bindingLabel={`${displayProviderName(session.providerId, providerInfo?.name)} · ${modelLabel(session.modelId, providerInfo)}`}
                  modelChipLabel={isProviderDefaultModel(session.modelId)
                    ? null
                    : modelLabel(session.modelId, providerInfo)}
                  providerReady={sessionProviderReady(providerDiscovery, providerInfo)}
                  isStreaming={isStreaming}
                  isCleaning={session.id === cleaningSessionId}
                  mode={modeFor(session.id)}
                  renameDraft={renameDraft}
                  onOpen={() => { onOpenSession(session.id); }}
                  onRenameDraftChange={setRenameDraft}
                  onStartRename={() => {
                    setRenameDraft(session.title);
                    setEditing({ id: session.id, mode: 'rename' });
                  }}
                  onCancelRename={() => { setEditing(null); }}
                  onSubmitRename={(event) => { void handleSaveRename(session.id, event); }}
                  onStartDelete={() => { setEditing({ id: session.id, mode: 'delete' }); }}
                  onCancelDelete={() => { setEditing(null); }}
                  onConfirmDelete={() => {
                    setEditing(null);
                    onDeleteSession(session.id);
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
