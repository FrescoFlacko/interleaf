import { ChatEmptyArtwork } from './ChatEmptyArtwork';
import { ChatStarterPrompts, type ChatStarterPromptsProps } from './ChatStarterPrompts';

type ChatEmptyThreadProps = ChatStarterPromptsProps & {
  readonly messageCount: number;
  readonly isLoading: boolean;
};

/**
 * The thread's empty state: an invitation grounded in the open document rather
 * than an apology for an empty list (DESIGN.md, Initial CTA).
 *
 * While a session is still loading its rows the thread is unknown rather than
 * empty, so this stays silent until the session read settles. Opening a
 * conversation now enters its thread immediately, which makes that brief
 * loading window visible.
 *
 * Centring is `safe`: in a pane too short for it (200% zoom) the invitation
 * starts at the top rather than overflowing upwards out of reach.
 */
export function ChatEmptyThread({ messageCount, isLoading, ...starters }: ChatEmptyThreadProps) {
  if (messageCount > 0 || isLoading) return null;
  return (
    <div
      data-testid="chat-empty-thread"
      className="chat-design-empty flex flex-1 flex-col items-center justify-center-safe p-4 text-center text-text-secondary"
    >
      <ChatEmptyArtwork />
      <p className="text-sm font-medium text-text-primary">Start with this document</p>
      <ChatStarterPrompts {...starters} />
    </div>
  );
}
