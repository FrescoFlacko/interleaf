import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { aimsAtSubmenu } from './reasoning-submenu-geometry';

/** How long the pointer rests on a row before its levels open. */
export const HOVER_INTENT_MS = 70;
/** How long the levels stay open after the pointer leaves the row or the flyout. */
export const LEAVE_GRACE_MS = 300;
/** How long a row waits while the pointer is still heading for the open flyout. */
export const AIM_DELAY_MS = 260;

type PointerSample = { readonly clientX: number; readonly clientY: number; readonly pointerType: string };

type SubmenuIntentOptions = {
  /** The row whose levels are open, by key; `null` when none are. */
  readonly openKey: string | null;
  /** A clicked flyout stays open until it is dismissed or another row is clicked. */
  readonly pinned: boolean;
  /** Hover never opens a nested list; only a click or a key does. */
  readonly hoverEnabled: boolean;
  readonly submenuRef: RefObject<HTMLElement | null>;
  readonly setOpenKey: (key: string | null) => void;
};

export type SubmenuIntent = {
  /** The pointer moved over a row; `key` is `null` for a row without levels. */
  readonly rowPointerMove: (key: string | null, event: PointerSample) => void;
  /** The pointer left the list of rows. */
  readonly listPointerLeave: () => void;
  readonly submenuPointerEnter: () => void;
  readonly submenuPointerLeave: () => void;
  /** Drops any pending open or close, before a click or a key decides instead. */
  readonly cancel: () => void;
};

/**
 * Pointer timing for a row that opens a flyout: a short hover intent before
 * opening, a grace period before closing, and a safe triangle so a diagonal
 * path toward the open flyout across other rows does not switch it. Hovering
 * only ever opens or closes; it never chooses anything.
 */
export function useSubmenuIntent(options: SubmenuIntentOptions): SubmenuIntent {
  const latest = useRef(options);
  latest.current = options;
  const timer = useRef<number | null>(null);
  const lastPoint = useRef<{ readonly x: number; readonly y: number } | null>(null);

  const clear = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback((delay: number, key: string | null): void => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current.setOpenKey(key);
    }, delay);
  }, [clear]);

  useEffect(() => clear, [clear]);

  const rowPointerMove = useCallback((key: string | null, event: PointerSample): void => {
    if (event.pointerType !== 'mouse') return;
    const point = { x: event.clientX, y: event.clientY };
    const origin = lastPoint.current;
    lastPoint.current = point;
    const { openKey, pinned, hoverEnabled, submenuRef } = latest.current;
    if (pinned || !hoverEnabled) return;
    if (key === openKey) {
      clear();
      return;
    }
    if (openKey === null) {
      if (key === null) clear();
      else schedule(HOVER_INTENT_MS, key);
      return;
    }
    const flyout = submenuRef.current?.getBoundingClientRect();
    const aiming = origin !== null && flyout !== undefined && aimsAtSubmenu(origin, point, flyout);
    schedule(aiming ? AIM_DELAY_MS : HOVER_INTENT_MS, key);
  }, [clear, schedule]);

  const leave = useCallback((): void => {
    const { openKey, pinned } = latest.current;
    if (pinned) return;
    if (openKey === null) clear();
    else schedule(LEAVE_GRACE_MS, null);
  }, [clear, schedule]);

  return { rowPointerMove, listPointerLeave: leave, submenuPointerEnter: clear, submenuPointerLeave: leave, cancel: clear };
}
