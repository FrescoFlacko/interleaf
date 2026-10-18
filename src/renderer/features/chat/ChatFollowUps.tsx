import { useState } from 'react';
import type { ChatContextItem } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { FollowUpChip } from '../../components/companion/FollowUpChip';
import { deriveChatFollowUps, retrySuggestion, type ChatSuggestion, type LatestAnswerState } from './chat-follow-ups';

type ChatFollowUpsProps = {
  readonly latest: LatestAnswerState;
  readonly contextItems: readonly ChatContextItem[];
  readonly documentTitle: string;
  /** Chips are offered only while the composer can take the draft. */
  readonly available: boolean;
  /** Places a suggestion in the composer. It never sends. */
  readonly onFill: (prompt: string) => void;
};

/**
 * Suggested next steps under the latest answer (DESIGN.md, Follow up). A
 * completed answer gets a zoom-in, a zoom-out and an action nudge; a failed or
 * stopped one gets Retry, which returns its prompt to the composer. Nothing is
 * shown while an answer streams.
 */
export function ChatFollowUps({ latest, contextItems, documentTitle, available, onFill }: ChatFollowUpsProps) {
  const [rotation, setRotation] = useState(0);
  if (latest.kind === 'none' || !available) return null;

  if (latest.kind === 'retry') {
    return (
      <div role="group" aria-label="Suggested follow-ups" data-testid="chat-follow-ups" className="chat-design-follow-ups">
        <SuggestionChip suggestion={retrySuggestion(latest.prompt)} onFill={onFill} />
      </div>
    );
  }

  const suggestions = deriveChatFollowUps({
    answer: latest.message.content,
    citations: latest.message.citations,
    contextItems,
    documentTitle,
  }, rotation);

  return (
    <div role="group" aria-labelledby="chat-follow-ups-label" data-testid="chat-follow-ups" className="chat-design-follow-ups">
      <div className="chat-design-follow-ups-head">
        <span id="chat-follow-ups-label" className="chat-design-follow-ups-label">Suggested follow-ups</span>
        <button
          type="button"
          aria-label="Refresh suggestions"
          title="Refresh suggestions"
          data-testid="chat-follow-ups-refresh"
          className="chat-design-follow-ups-refresh"
          onClick={() => { setRotation((current) => current + 1); }}
        >
          <AppIcon name="retry" size={12} />
        </button>
      </div>
      <div className="chat-design-follow-ups-chips">
        {suggestions.map((suggestion) => (
          <SuggestionChip key={`${suggestion.kind}:${suggestion.label}`} suggestion={suggestion} onFill={onFill} />
        ))}
      </div>
    </div>
  );
}

function SuggestionChip({ suggestion, onFill }: { readonly suggestion: ChatSuggestion; readonly onFill: (prompt: string) => void }) {
  return (
    <FollowUpChip
      data-kind={suggestion.kind}
      title={`${suggestion.reason}. Fills the message field; nothing is sent.`}
      onClick={() => { onFill(suggestion.prompt); }}
    >
      {suggestion.label}
    </FollowUpChip>
  );
}
