import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';

/** How long a resting pointer waits before an explanation appears. */
const HOVER_DELAY_MS = 300;
/** Time the pointer has to cross the gap from the button onto the tooltip. */
const LEAVE_GRACE_MS = 120;
/** Distance between the button and the tooltip, and kept from the pane edges. */
const GAP = 6;
const EDGE = 8;
/** The tooltip stays inside the chat pane, not just the window. */
const PANE_SELECTOR = '.chat-design';
/** The scrolling thread a focused button must stay visible in to keep its tooltip. */
const THREAD_SELECTOR = '.chat-design-messages';

type Shown<K extends string = string> = { readonly key: K; readonly anchor: HTMLElement; readonly instant: boolean };

/** The handlers one action button needs to show and dismiss its explanation. */
export type TooltipTriggerProps = {
  readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onPointerDown: () => void;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  readonly onClick: () => void;
};

/**
 * One explanation at a time for a row of icon-only actions.
 *
 * Keyboard focus shows it at once; a resting pointer shows it after a short
 * delay, and moving on to a neighbour while one is open swaps it with no delay
 * or animation. A press, Escape, a scroll, a resize or a text selection all
 * dismiss it, and it goes with the row when the row unmounts.
 */
export function useAnswerActionTooltip<K extends string>() {
  const [shown, setShown] = useState<Shown<K> | null>(null);
  const shownRef = useRef<Shown<K> | null>(null);
  const timerRef = useRef<number | null>(null);
  const pressedRef = useRef(false);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const update = useCallback((next: Shown<K> | null): void => {
    clearTimer();
    shownRef.current = next;
    setShown(next);
  }, [clearTimer]);

  const hide = useCallback((): void => { update(null); }, [update]);

  const keep = clearTimer;
  const release = useCallback((): void => {
    clearTimer();
    timerRef.current = window.setTimeout(hide, LEAVE_GRACE_MS);
  }, [clearTimer, hide]);

  useEffect(() => clearTimer, [clearTimer]);
  useDismissal(shown !== null, hide);

  const trigger = (key: K): TooltipTriggerProps => ({
    onPointerEnter: (event) => {
      const anchor = event.currentTarget;
      if (shownRef.current !== null) {
        update({ key, anchor, instant: true });
        return;
      }
      clearTimer();
      timerRef.current = window.setTimeout(() => { update({ key, anchor, instant: false }); }, HOVER_DELAY_MS);
    },
    onPointerLeave: release,
    onPointerDown: () => { pressedRef.current = true; },
    // A press also focuses the button; only focus that arrives without one is
    // the keyboard's, and that is the focus an explanation should follow.
    onFocus: (event) => {
      if (pressedRef.current) {
        pressedRef.current = false;
        return;
      }
      update({ key, anchor: event.currentTarget, instant: true });
    },
    onBlur: () => {
      pressedRef.current = false;
      hide();
    },
    onClick: hide,
  });

  return { shown, trigger, keep, release, hide };
}

/**
 * Dismisses an open tooltip on anything that makes its purpose stale. A scroll
 * is the tooltip's own to judge, because it may be following its button.
 */
function useDismissal(open: boolean, hide: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The most transient layer takes the first Escape.
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    const handleSelection = (): void => {
      if (document.getSelection()?.isCollapsed === false) hide();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('selectionchange', handleSelection);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('selectionchange', handleSelection);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Centres the tooltip over its button, below it when there is no room above,
 * and keeps it inside the chat pane so a narrow pane never lets it spill over
 * the reader or under the window edge.
 */
function place(anchor: HTMLElement, tooltip: HTMLElement): void {
  const pane = anchor.closest(PANE_SELECTOR)?.getBoundingClientRect();
  const left = Math.max(pane?.left ?? 0, 0) + EDGE;
  const right = Math.min(pane?.right ?? window.innerWidth, window.innerWidth) - EDGE;
  const top = Math.max(pane?.top ?? 0, 0) + EDGE;
  const bottom = Math.min(pane?.bottom ?? window.innerHeight, window.innerHeight) - EDGE;

  tooltip.style.maxWidth = `${String(Math.max(right - left, 0))}px`;
  const rect = anchor.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const above = rect.top - GAP - height;
  const opensUp = above >= top || rect.bottom + GAP + height > bottom;

  tooltip.style.left = `${String(Math.round(clamp(rect.left + rect.width / 2 - width / 2, left, right - width)))}px`;
  tooltip.style.top = `${String(Math.round(opensUp ? above : rect.bottom + GAP))}px`;
  tooltip.dataset.side = opensUp ? 'top' : 'bottom';
}

/**
 * Whether a scroll leaves the tooltip with a button worth following: one that
 * holds keyboard focus (focusing it may itself scroll the thread to reveal it)
 * and is still wholly visible in the thread.
 */
function followsAfterScroll(anchor: HTMLElement): boolean {
  if (document.activeElement !== anchor) return false;
  const rect = anchor.getBoundingClientRect();
  const thread = (anchor.closest(THREAD_SELECTOR) ?? anchor.closest(PANE_SELECTOR))?.getBoundingClientRect();
  if (thread === undefined) return true;
  return rect.top >= thread.top && rect.bottom <= thread.bottom;
}

/**
 * The painted explanation. It repeats the description the button already
 * carries, so it is hidden from assistive technology rather than read twice,
 * and it is portalled out of the scrolling thread so the thread can neither
 * clip it nor make room for it.
 */
export function AnswerActionTooltip<K extends string>({
  shown,
  hints,
  ...handlers
}: {
  readonly shown: Shown<K> | null;
  readonly hints: Readonly<Record<K, string>>;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onDismiss: () => void;
}) {
  if (shown === null) return null;
  return <PlacedTooltip shown={shown} text={hints[shown.key]} {...handlers} />;
}

function PlacedTooltip({
  shown,
  text,
  onPointerEnter,
  onPointerLeave,
  onDismiss,
}: {
  readonly shown: Shown;
  readonly text: string;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onDismiss: () => void;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { anchor } = shown;

  // Before paint, so it never shows at an unplaced position.
  useLayoutEffect(() => {
    if (tooltipRef.current !== null) place(anchor, tooltipRef.current);
  }, [anchor, text]);

  // A hover tooltip leaves with the scroll; a focused button's stays with it.
  useEffect(() => {
    const handleScroll = (): void => {
      if (!followsAfterScroll(anchor)) onDismiss();
      else if (tooltipRef.current !== null) place(anchor, tooltipRef.current);
    };
    window.addEventListener('scroll', handleScroll, true);
    return () => { window.removeEventListener('scroll', handleScroll, true); };
  }, [anchor, onDismiss]);

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      aria-hidden="true"
      data-testid="chat-answer-action-tooltip"
      data-instant={shown.instant ? '' : undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="chat-design-tooltip"
    >
      {text}
    </div>,
    document.body
  );
}
