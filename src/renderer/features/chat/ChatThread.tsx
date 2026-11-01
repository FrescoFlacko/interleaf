import type { AIProviderStatus, ChatContextItem, ChatMessage, ChatSession } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import { bridge } from '../../app/api-client';
import { ChatFollowUps } from './ChatFollowUps';
import { ChatMessageBubble } from './ChatMessageBubble';
import { ChatPromptDetails } from './ChatPromptDetails';
import { latestAnswerState, precedingUserPrompt } from './chat-follow-ups';
import { promptDetailTokens } from './chat-prompt-details';
import type { ChatToastTone } from './use-chat-toast';

type ChatThreadProps = {
  /** The whole transcript, which is where each answer's prompt is found. */
  readonly messages: readonly ChatMessage[];
  /** The turns painted, which can withhold a streaming placeholder. */
  readonly visibleMessages: readonly ChatMessage[];
  readonly isStreaming: boolean;
  /** The conversation citations resolve against. */
  readonly activeSessionId: string | null;
  readonly session: ChatSession | null;
  readonly sessionProvider: AIProviderStatus | undefined;
  readonly contextItems: readonly ChatContextItem[];
  readonly documentTitle: string;
  /** Whether the composer can take a draft right now. */
  readonly composerAvailable: boolean;
  readonly canSaveNote: boolean;
  readonly onSaveNote: (content: string) => Promise<boolean>;
  readonly onNotice: (tone: ChatToastTone, message: string) => void;
  readonly goToLocation: (location: DocumentLocation) => Promise<void>;
  /** Places a prompt in the composer and focuses it. It never sends. */
  readonly onFill: (prompt: string) => void;
};

function isCompletedAnswer(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.status === 'complete' && message.content.trim().length > 0;
}

/**
 * The transcript, each completed answer's Prompt details, and the suggested
 * next steps under the latest answer.
 */
export function ChatThread({
  messages,
  visibleMessages,
  isStreaming,
  activeSessionId,
  session,
  sessionProvider,
  contextItems,
  documentTitle,
  composerAvailable,
  canSaveNote,
  onSaveNote,
  onNotice,
  goToLocation,
  onFill,
}: ChatThreadProps) {
  const latest = latestAnswerState(messages, isStreaming);
  const resolveCitation = async (messageId: string, sourceId: string): Promise<void> => {
    if (!activeSessionId) return;
    const target = await bridge.chat.resolveCitation(activeSessionId, messageId, sourceId);
    if (target?.location) await goToLocation(target.location);
  };

  return (
    <>
      {visibleMessages.map((message) => (
        <ChatMessageBubble
          key={message.id}
          message={message}
          canSaveNote={canSaveNote}
          onSaveNote={onSaveNote}
          onNotice={onNotice}
          onCitation={(sourceId) => resolveCitation(message.id, sourceId)}
          details={isCompletedAnswer(message) ? (
            <ChatPromptDetails
              prompt={precedingUserPrompt(messages, messages.indexOf(message))}
              tokens={promptDetailTokens(message, session, sessionProvider)}
              reuseAvailable={composerAvailable}
              onReuse={onFill}
              onNotice={onNotice}
            />
          ) : null}
        />
      ))}
      <ChatFollowUps
        key={messages.at(-1)?.id ?? 'empty'}
        latest={latest}
        contextItems={contextItems}
        documentTitle={documentTitle}
        available={composerAvailable}
        onFill={onFill}
      />
    </>
  );
}
