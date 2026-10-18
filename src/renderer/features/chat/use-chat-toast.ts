import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A success confirms something that already happened and may disappear; a
 * failure is the reader's only record that it did not, so it stays until it is
 * dismissed or replaced.
 */
export type ChatToastTone = 'success' | 'error';

export type ChatToastNotice = {
  /** Identity of this posting, so a repeat of the same words restarts the timer. */
  readonly id: number;
  readonly tone: ChatToastTone;
  readonly message: string;
};

/** How long a success confirmation stays on screen. */
export const CHAT_TOAST_SUCCESS_MS = 4_000;

export type ChatToastController = {
  readonly notice: ChatToastNotice | null;
  readonly publish: (tone: ChatToastTone, message: string) => void;
  readonly dismiss: () => void;
};

/**
 * The chat panel's single transient-notice slot.
 *
 * One notice exists at a time, so a second save replaces the first rather than
 * stacking, and the dismissal timer is keyed to the posting identity: posting
 * again restarts the interval instead of letting the previous timer cut the new
 * confirmation short. The timer is owned by an effect, so unmounting the panel
 * mid-interval clears it rather than leaving a scheduled state update behind.
 *
 * Only a success is timed. A failure has to survive long enough to be read and
 * acted on, so it waits for the reader.
 */
export function useChatToast(): ChatToastController {
  const [notice, setNotice] = useState<ChatToastNotice | null>(null);
  const nextId = useRef(0);

  const publish = useCallback((tone: ChatToastTone, message: string): void => {
    nextId.current += 1;
    setNotice({ id: nextId.current, tone, message });
  }, []);

  const dismiss = useCallback((): void => { setNotice(null); }, []);

  const noticeId = notice?.id ?? null;
  const isTransient = notice?.tone === 'success';

  useEffect(() => {
    if (noticeId === null || !isTransient) return undefined;
    const timer = window.setTimeout(() => { setNotice(null); }, CHAT_TOAST_SUCCESS_MS);
    return () => { window.clearTimeout(timer); };
  }, [noticeId, isTransient]);

  return { notice, publish, dismiss };
}
