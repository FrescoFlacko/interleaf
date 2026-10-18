import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { submenuSide, type SubmenuSide } from './reasoning-submenu-geometry';
import { useSubmenuIntent, type SubmenuIntent } from './use-submenu-intent';

/** Whose levels are open, and how they were opened. */
type OpenSubmenu = {
  readonly key: string;
  /** Opened by a click: pointer movement no longer closes it. */
  readonly pinned: boolean;
  /** Opened from the keyboard: focus moves into the levels. */
  readonly focusLevels: boolean;
};

export type ReasoningSubmenu = {
  readonly side: SubmenuSide;
  readonly open: OpenSubmenu | null;
  readonly flyoutRef: RefObject<HTMLDivElement | null>;
  readonly intent: SubmenuIntent;
  readonly show: (key: string, how: { readonly pinned: boolean; readonly focusLevels: boolean }) => void;
  readonly close: () => void;
};

/**
 * The model picker's one open set of levels. Which side it opens on is
 * re-read whenever the picker moves or the window resizes; with room on
 * neither side, hover does nothing and only a click or a key opens the levels
 * in place.
 */
export function useReasoningSubmenu(
  popupRef: RefObject<HTMLElement | null>,
  /** The picker's own placement; the side is re-read whenever it changes. */
  anchor: Pick<CSSProperties, 'left' | 'top'>
): ReasoningSubmenu {
  const [side, setSide] = useState<SubmenuSide>('nested');
  const [open, setOpen] = useState<OpenSubmenu | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const update = (): void => {
      const popup = popupRef.current;
      if (popup === null) return;
      // The picker scales in about its horizontal centre, so its centre and
      // its untransformed width give the box it settles at.
      const rect = popup.getBoundingClientRect();
      const centre = (rect.left + rect.right) / 2;
      const half = popup.offsetWidth / 2;
      setSide(submenuSide({ left: centre - half, right: centre + half }, window.innerWidth));
    };
    update();
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); };
  }, [popupRef, anchor.left, anchor.top]);

  const setOpenKey = useCallback((key: string | null): void => {
    setOpen(key === null ? null : { key, pinned: false, focusLevels: false });
  }, []);

  const intent = useSubmenuIntent({
    openKey: open?.key ?? null,
    pinned: open?.pinned ?? false,
    hoverEnabled: side !== 'nested',
    submenuRef: flyoutRef,
    setOpenKey,
  });

  const { cancel } = intent;
  const show = useCallback((key: string, how: { readonly pinned: boolean; readonly focusLevels: boolean }): void => {
    cancel();
    setOpen({ key, ...how });
  }, [cancel]);
  const close = useCallback((): void => {
    cancel();
    setOpen(null);
  }, [cancel]);

  return { side, open, flyoutRef, intent, show, close };
}
