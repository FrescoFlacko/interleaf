type ChatSessionsPlaceholderProps = {
  /** Whether the persisted session read for the open document has settled. */
  readonly sessionsLoaded: boolean;
};

/**
 * What the Conversations screen shows in place of cards.
 *
 * An empty list means two different things: the persisted read has not answered
 * yet, or it answered with nothing. Only the second one is "No conversations
 * yet", so the first announces the wait through a live region instead of
 * telling the reader their conversations do not exist.
 */
export function ChatSessionsPlaceholder({ sessionsLoaded }: ChatSessionsPlaceholderProps) {
  if (!sessionsLoaded) {
    return (
      <p
        data-testid="chat-sessions-loading"
        role="status"
        className="px-1 py-6 text-center text-xs text-text-secondary"
      >
        Loading conversations…
      </p>
    );
  }
  return <p className="px-1 py-6 text-center text-xs text-text-secondary">No conversations yet.</p>;
}
