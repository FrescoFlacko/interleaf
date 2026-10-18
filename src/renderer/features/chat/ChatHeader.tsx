import type { RefObject } from 'react';
import { AppIcon } from '../../components/AppIcon';

type ChatHeaderProps = {
  /** Title of the conversation on screen, or `null` when none exists yet. */
  readonly conversationTitle: string | null;
  readonly isArchived: boolean;
  readonly canCreateSession: boolean;
  readonly backButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onOpenSessions: () => void;
  readonly onCreateSession: () => void;
};

const ICON_BUTTON =
  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-border-subtle ' +
  'text-text-secondary hover:bg-bg-surface hover:text-text-primary focus:outline-none focus:ring-2 ' +
  'focus:ring-focus-ring disabled:opacity-40';

/**
 * Thread header: a back control to the conversations screen, the title of the
 * conversation being read, and the single create action. The document's own
 * identity is not repeated here — it names the conversation list instead.
 */
export function ChatHeader({
  conversationTitle,
  isArchived,
  canCreateSession,
  backButtonRef,
  onOpenSessions,
  onCreateSession,
}: ChatHeaderProps) {
  return (
    <div className="chat-design-header flex shrink-0 items-center gap-2">
      <button
        ref={backButtonRef}
        type="button"
        data-testid="back-to-sessions-button"
        onClick={onOpenSessions}
        aria-label="Back to conversations"
        title="Back to conversations"
        className={ICON_BUTTON}
      >
        <AppIcon name="back" size={14} />
      </button>
      <h2
        data-testid="chat-conversation-line"
        title={conversationTitle ?? undefined}
        className="chat-design-thread-title min-w-0 flex-1 truncate"
      >
        {conversationTitle ?? 'No conversation yet'}
      </h2>
      {isArchived && (
        <span data-testid="chat-thread-archived" className="shrink-0 font-mono text-2xs tracking-[0.08em] text-warning">
          ARCHIVED
        </span>
      )}
      <button
        type="button"
        data-testid="new-chat-session"
        aria-label="New chat"
        title="New chat"
        disabled={!canCreateSession}
        onClick={onCreateSession}
        className="chat-design-create-icon shrink-0 focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40"
      >
        <AppIcon name="add" size={14} />
      </button>
    </div>
  );
}
