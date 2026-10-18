import type { ChatMessage } from '@shared/types/ai';
import { LoadingShimmerText } from '../../components/LoadingShimmer';
import { ChatAssistantLabel } from './ChatAssistantLabel';

/**
 * Whether the transcript should carry the "generating" turn. It stands in for
 * an answer that has not started arriving; once the first tokens land, the
 * streaming answer itself is the evidence that the model is working, and a
 * second Reader AI label above it would read as a second turn.
 */
export function shouldShowGeneratingNotice(
  isStreaming: boolean,
  lastMessage: ChatMessage | undefined
): boolean {
  if (!isStreaming) return false;
  if (lastMessage?.role !== 'assistant') return true;
  return !(lastMessage.status === 'streaming' && lastMessage.content.length > 0);
}

type ChatGeneratingNoticeProps = {
  readonly isStreaming: boolean;
  readonly lastMessage: ChatMessage | undefined;
};

/**
 * The turn that is being generated, standing where its answer will appear.
 *
 * It is the last entry in the transcript rather than a line in the composer
 * footer, so waiting reads as part of the conversation and the reader's eye
 * stays where the answer will arrive. It is announced politely, once, and it
 * exists only while the request is live: the panel drops it the moment the turn
 * finishes, fails or is stopped, so there is never a completion notice left
 * behind to be mistaken for the answer.
 */
export function ChatGeneratingNotice({ isStreaming, lastMessage }: ChatGeneratingNoticeProps) {
  if (!shouldShowGeneratingNotice(isStreaming, lastMessage)) return null;
  return (
    <article
      data-testid="chat-generating-notice"
      aria-label="Reader AI response"
      className="chat-design-assistant flex min-w-0 flex-col gap-2.5"
    >
      <ChatAssistantLabel />
      <p role="status" className="companion-readable companion-readable-xs leading-[1.62] text-text-secondary">
        <LoadingShimmerText>Generating response…</LoadingShimmerText>
      </p>
    </article>
  );
}
