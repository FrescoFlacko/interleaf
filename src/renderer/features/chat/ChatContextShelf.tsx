import type { RefObject } from 'react';
import type { ChatContextItem, ChatSession } from '@shared/types/ai';
import { ChatContextBudgetMeter, type CleanContextWiring } from './ChatContextBudgetMeter';
import { ChatContextShelfSummary } from './ChatContextShelfSummary';
import { useContextWindowReadout } from './use-context-window-readout';

type ChatContextShelfProps = {
  readonly activeSession: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  readonly isStreaming: boolean;
  /** A running clean, a stream or an archived session withholds every context change. */
  readonly disabled: boolean;
  /**
   * Whether this conversation can be compacted right now, and the request that
   * would compact it, for the context-window panel at the shelf's edge.
   */
  readonly cleanContext: CleanContextWiring;
  /** Where focus goes once the last attached item is removed. */
  readonly addContextRef: RefObject<HTMLButtonElement | null>;
  readonly removeContext: (contextItemId: string) => Promise<void>;
};

/**
 * The whole document is listed first and only once; everything else keeps the
 * order main attached it in.
 */
function shelfOrder(items: readonly ChatContextItem[]): readonly ChatContextItem[] {
  return [
    ...items.filter((item) => item.kind === 'entire_document'),
    ...items.filter((item) => item.kind !== 'entire_document'),
  ];
}

/**
 * The one-line context shelf docked on top of the composer (DESIGN.md, Inline
 * context): what the next turn reads — the first attachment and a count of the
 * rest, opening the full list on demand — and, at its edge, the context-window
 * control that reports on the last request.
 *
 * With nothing attached the shelf stays only while that control has something
 * truthful to say, so it never reserves a line for an empty claim.
 */
export function ChatContextShelf({
  activeSession,
  contextItems,
  isStreaming,
  disabled,
  cleanContext,
  addContextRef,
  removeContext,
}: ChatContextShelfProps) {
  const readout = useContextWindowReadout({ session: activeSession, contextItems, isStreaming, cleanContext });
  const items = shelfOrder(contextItems);
  if (items.length === 0 && readout === null) return null;
  return (
    <section
      aria-label="AI context"
      data-testid="chat-context-bar"
      data-context-layout="shelf"
      data-budget-level={readout?.level}
      className="chat-context-shelf"
    >
      {items.length > 0 ? (
        <ChatContextShelfSummary
          items={items}
          canRemove={activeSession?.isArchived !== true}
          disabled={disabled}
          addContextRef={addContextRef}
          removeContext={removeContext}
        />
      ) : (
        <p data-testid="chat-context-summary" className="chat-context-shelf-empty">No context attached</p>
      )}
      {readout !== null && <ChatContextBudgetMeter readout={readout} cleanContext={cleanContext} />}
    </section>
  );
}
