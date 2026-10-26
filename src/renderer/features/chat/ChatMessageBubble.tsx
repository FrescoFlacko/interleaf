import { useId, useMemo, type ReactNode } from 'react';
import type { ChatContextDisclosure, ChatMessage } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { LoadingShimmerText } from '../../components/LoadingShimmer';
import { ChatAssistantLabel } from './ChatAssistantLabel';
import { MarkdownMessage } from './MarkdownMessage';
import { ChatWebSources } from './ChatWebSources';
import { disclosureDetail } from './chat-disclosure-text';
import type { ChatToastTone } from './use-chat-toast';
import { bridge } from '../../app/api-client';
import { AnswerActionTooltip, useAnswerActionTooltip } from './ChatAnswerActionTooltip';

type ChatMessageBubbleProps = {
  readonly message: ChatMessage;
  readonly onCitation: (sourceId: string) => Promise<void>;
  /** Saving as a note requires a mounted reader adapter for the anchor. */
  readonly canSaveNote: boolean;
  readonly onSaveNote: (content: string) => Promise<boolean>;
  /**
   * Reports the outcome of an action to the panel's notice surface. The result
   * is never painted inside the message, so confirming an action cannot move
   * the row of controls the reader is still pointing at.
   */
  readonly onNotice: (tone: ChatToastTone, message: string) => void;
  /**
   * How the answer was made, shown on demand at the foot of an assistant turn.
   * The thread decides whether a turn has details; the bubble only places them.
   */
  readonly details: ReactNode;
};

/**
 * Asymmetric message treatment: the reader's own turns are compact right-aligned
 * bubbles; assistant turns are full-width prose with no competing container.
 */
export function ChatMessageBubble({
  message,
  onCitation,
  canSaveNote,
  onSaveNote,
  onNotice,
  details,
}: ChatMessageBubbleProps) {
  const citations = useMemo(
    () => new Map(message.citations.map((citation) => [citation.sourceId, citation])),
    [message.citations]
  );

  if (message.role === 'user') {
    return (
      <article
        data-testid={`chat-message-${message.id}`}
        aria-label="Your message"
        className="chat-design-user flex flex-col items-end gap-1.5"
      >
        <div className="chat-design-bubble companion-readable max-w-[82%] min-w-0 rounded-lg rounded-br-sm bg-bg-surface px-3.5 py-2.5 leading-[1.5] text-text-primary">
          <span className="sr-only">You</span>
          <MarkdownMessage content={message.content} citations={citations} onCitation={onCitation} />
        </div>
        <MessageStatusNote status={message.status} />
      </article>
    );
  }

  return (
    <article
      data-testid={`chat-message-${message.id}`}
      aria-label="Reader AI response"
      className="chat-design-assistant flex min-w-0 flex-col gap-2.5"
    >
      <ChatAssistantLabel />
      <div className="companion-readable min-w-0 leading-[1.62] text-text-primary">
        <MarkdownMessage
          content={message.content}
          citations={citations}
          onCitation={onCitation}
          streaming={message.status === 'streaming'}
        />
      </div>
      <ChatWebSources sources={message.webSources} />
      <MessageDisclosures disclosures={message.disclosures} />
      <MessageStatusNote status={message.status} />
      {message.status !== 'streaming' && <AssistantActions
        content={message.content}
        canSaveNote={canSaveNote}
        onSaveNote={onSaveNote}
        onNotice={onNotice}
      />}
      {details}
    </article>
  );
}

function MessageStatusNote({ status }: { readonly status: ChatMessage['status'] }) {
  // The same words the waiting turn showed, so the answer reads as one turn
  // still in progress; the shimmer is still under reduced motion.
  if (status === 'streaming') {
    return (
      <p data-testid="chat-streaming-indicator" className="text-2xs text-text-secondary">
        <LoadingShimmerText>Generating response…</LoadingShimmerText>
      </p>
    );
  }
  const note = ENDED_STATUS_NOTES[status];
  if (note === undefined) return null;
  return <p className={note.className}>{note.text}</p>;
}

/** How a turn that ended without a full answer says so. */
const ENDED_STATUS_NOTES: Partial<Record<ChatMessage['status'], { readonly text: string; readonly className: string }>> = {
  cancelled: { text: 'Stopped', className: 'text-2xs text-text-secondary' },
  failed: { text: 'Generation failed', className: 'text-2xs text-danger' },
};

/**
 * Disclosures that change what the reader should do with the answer.
 *
 * Boundary over-inclusion is deliberately not one of them: it says a selection
 * may have carried a little extra text from the chunk it started or ended in,
 * which never withholds anything the reader asked for and reads as an alarm
 * about nothing. It is filtered here rather than upstream, so the audit record
 * on the turn — and every other disclosure — is untouched, and stored turns
 * that already carry the old disclosure stop showing it too.
 */
function MessageDisclosures({ disclosures }: { readonly disclosures: readonly ChatContextDisclosure[] }) {
  const disclosed = disclosures.filter((disclosure) => disclosure.reason !== 'boundary_over_inclusion');
  if (disclosed.length === 0) return null;
  return (
    <div
      data-testid="chat-context-disclosure"
      role="status"
      className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-2xs leading-snug text-text-primary"
    >
      {disclosed.map((disclosure) => (
        <p key={disclosure.contextItemId + disclosure.reason}>
          <span className="font-medium text-warning">Context partially included:</span>{' '}
          {disclosureDetail(disclosure)}
        </p>
      ))}
    </div>
  );
}

/** What the panel says once the annotation write has actually settled. */
function saveOutcome(saved: boolean): readonly [ChatToastTone, string] {
  return saved ? ['success', 'Note saved'] : ['error', 'Could not save note'];
}

/**
 * Icon-only answer actions. The glyph is the whole control, so the button — not
 * the icon — carries the accessible name, and the 24px box keeps a usable hit
 * target around a 15px glyph without re-introducing the label row's height.
 */
/**
 * What each action does, spelled out for the tooltip and the button's
 * description. Saving anchors a location note where the reader is now.
 */
const ACTION_HINTS = {
  copy: 'Copy the full answer to the clipboard',
  save: 'Save the answer as a note at your current location in this document',
} as const;
type AnswerAction = keyof typeof ACTION_HINTS;

const ACTION_CLASS =
  'flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40';

function AssistantActions({
  content,
  canSaveNote,
  onSaveNote,
  onNotice,
}: {
  readonly content: string;
  readonly canSaveNote: boolean;
  readonly onSaveNote: (content: string) => Promise<boolean>;
  readonly onNotice: (tone: ChatToastTone, message: string) => void;
}) {
  const tooltip = useAnswerActionTooltip<AnswerAction>();
  const hintId = useId();
  const hintIds = { copy: `${hintId}-copy`, save: `${hintId}-save` } as const;
  const hasContent = content.trim().length > 0;
  if (!hasContent) return null;

  /** The tooltip handlers, with the press that dismisses it also doing the action. */
  const bind = (action: AnswerAction, activate: () => void) => {
    const trigger = tooltip.trigger(action);
    return { ...trigger, onClick: () => { trigger.onClick(); activate(); } };
  };

  const copy = async (): Promise<void> => {
    try {
      await bridge.clipboard.writeText(content);
      onNotice('success', 'Answer copied');
    } catch {
      onNotice('error', 'Could not copy answer');
    }
  };

  /**
   * The confirmation follows the write, never the click: `onSaveNote` resolves
   * false when the annotation was not persisted, and a rejected write is the
   * same outcome from the reader's side, so both report a failure rather than a
   * quieter success and neither is allowed to fall through unhandled.
   */
  const saveNote = async (): Promise<void> => {
    const saved = await onSaveNote(content).catch(() => false);
    onNotice(...saveOutcome(saved));
  };

  return (
    <div className="chat-design-actions flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <button
        type="button"
        data-testid="copy-chat-answer"
        aria-label="Copy answer"
        aria-describedby={hintIds.copy}
        {...bind('copy', () => { void copy(); })}
        className={ACTION_CLASS}
      >
        <AppIcon name="copy" size={15} />
      </button>
      <span id={hintIds.copy} hidden>{ACTION_HINTS.copy}</span>
      {canSaveNote && (
        <>
          <button
            type="button"
            data-testid="save-chat-answer-note"
            aria-label="Save answer as note"
            aria-describedby={hintIds.save}
            {...bind('save', () => { void saveNote(); })}
            className={ACTION_CLASS}
          >
            <AppIcon name="add-note" size={15} />
          </button>
          <span id={hintIds.save} hidden>{ACTION_HINTS.save}</span>
        </>
      )}
      <AnswerActionTooltip
        shown={tooltip.shown}
        hints={ACTION_HINTS}
        onPointerEnter={tooltip.keep}
        onPointerLeave={tooltip.release}
        onDismiss={tooltip.hide}
      />
    </div>
  );
}
