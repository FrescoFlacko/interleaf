import type { ChatToastNotice } from './use-chat-toast';

type ChatToastProps = {
  readonly notice: ChatToastNotice | null;
  readonly onDismiss: () => void;
};

/**
 * The chat panel's transient notice surface.
 *
 * It is positioned out of the document flow above the composer, so a
 * confirmation never moves the message it confirms, the action row that
 * produced it, or the composer below it: the thing a reader was about to click
 * stays exactly where they aimed.
 *
 * Announcement is deliberately split so nothing is spoken twice. A success is
 * announced once through the one polite, atomic live region that is always in
 * the tree — a region inserted alongside its text is not reliably read — and
 * the painted confirmation is hidden from assistive technology. A failure has
 * no live-region text; the painted panel is itself the alert, so it is read on
 * insertion and stays visible with its own dismissal control.
 *
 * The announced text is carried by a child keyed on the notice, not written
 * straight into the region. Saving a second note says the same four words as
 * the first, and rendering that as bare text would leave the existing text node
 * untouched: no DOM change, so nothing is announced and the second save passes
 * in silence for anyone not watching the screen. Replacing the child instead
 * makes each save a real mutation of the same region, so it is spoken again —
 * once, because there is still only the one region.
 */
export function ChatToast({ notice, onDismiss }: ChatToastProps) {
  const succeeded = notice !== null && notice.tone === 'success';
  return (
    <div data-testid="chat-toast-region" className="chat-design-toast-region">
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="chat-toast-announcement"
        className="sr-only"
      >
        {succeeded && <span key={notice.id}>{notice.message}</span>}
      </p>
      {notice !== null && (
        <div
          key={notice.id}
          data-testid="chat-toast"
          data-tone={notice.tone}
          role={succeeded ? undefined : 'alert'}
          aria-hidden={succeeded ? true : undefined}
          className="chat-design-toast"
        >
          <span className="min-w-0">{notice.message}</span>
          {!succeeded && (
            <button
              type="button"
              data-testid="chat-toast-dismiss"
              onClick={onDismiss}
              className="shrink-0 rounded px-1 text-2xs underline focus:outline-none focus:ring-2 focus:ring-focus-ring"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
