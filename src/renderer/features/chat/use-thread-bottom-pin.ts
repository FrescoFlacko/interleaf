import { useLayoutEffect, type RefObject } from 'react';
import type { ChatMessage } from '@shared/types/ai';

type ThreadBottomPinInput = {
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /**
   * The thread is only laid out while it is the visible screen and the visible
   * companion tab: a hidden scroll container has no layout box, so its offset
   * is lost while it is away and has to be re-placed when it comes back.
   */
  readonly view: 'chat' | 'history';
  readonly rightTab: string;
  /**
   * The ways a thread can arrive at its newest turn: a different conversation,
   * hydration finishing after the panel mounted, and a new turn appearing.
   */
  readonly sessionId: string | null;
  readonly loading: boolean;
  readonly messages: readonly ChatMessage[];
  /**
   * Whether the transcript currently ends with the "generating" turn. It takes
   * up room without being a message, so it has to place the thread as a message
   * does — otherwise the notice appears below the fold and the reader watches a
   * blank end of thread while the answer is being written.
   */
  readonly generating: boolean;
};

/**
 * A conversation opens where it was left off — at its newest turn — and the
 * placement happens before paint (an empty thread opens at its top), so the reader never sees the thread's opening
 * lines flash past.
 *
 * `scrollTop` is assigned on the thread's own scroller rather than calling
 * `scrollIntoView` on a message: `scrollIntoView` walks up and scrolls every
 * scrollable ancestor, which would drag the reader's document out from under
 * them to bring a chat bubble into view.
 */
/** The newest turn, except that an empty thread is the invitation, read from its top. */
function pinnedScrollTop(scroller: HTMLElement, messageCount: number, generating: boolean): number {
  return messageCount === 0 && !generating ? 0 : scroller.scrollHeight;
}

export function useThreadBottomPin({
  scrollerRef,
  view,
  rightTab,
  sessionId,
  loading,
  messages,
  generating,
}: ThreadBottomPinInput): void {
  const visible = view === 'chat' && rightTab === 'chat';
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!visible || scroller === null) return;
    scroller.scrollTop = pinnedScrollTop(scroller, messages.length, generating);
  }, [scrollerRef, visible, sessionId, loading, messages, generating]);
}
