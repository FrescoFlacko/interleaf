import { useCallback, useEffect, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';

/**
 * Closes an anchored overlay when the pointer goes down anywhere outside the
 * element that holds both its trigger and its panel.
 *
 * `pointerdown` rather than `click`: the panel has to be gone before the
 * clicked control reacts, so the first press outside reaches its target instead
 * of only dismissing. The callback closes the overlay and nothing else — it
 * must not pull focus back to the trigger, because the user is on their way to
 * whatever they just pressed.
 *
 * The listener is attached only while the overlay is open, so a closed panel
 * costs nothing.
 */
export function useOutsidePointerDismiss(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  useEffect(() => {
    if (!active) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target) === true) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { document.removeEventListener('pointerdown', handlePointerDown); };
  }, [active, containerRef, onDismiss]);
}

type OverlayDismissalInput = {
  /** Unset for an inline region, which dismisses only through its trigger. */
  readonly overlay: boolean | undefined;
  readonly expanded: boolean;
  readonly setExpanded: Dispatch<SetStateAction<boolean>>;
  /** Holds both the trigger and the region, so a press inside is not outside. */
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
};

/**
 * The two dismissal paths an overlay owes its user, packaged for a disclosure:
 * an outside press closes it and leaves focus on whatever was pressed, and
 * Escape closes it and returns focus to the trigger, which is the only place
 * keyboard focus can sensibly land.
 *
 * The returned handler is attached unconditionally and does nothing unless the
 * region is an open overlay, so the caller keeps one code path.
 */
export function useOverlayDismissal({
  overlay,
  expanded,
  setExpanded,
  containerRef,
  triggerRef,
}: OverlayDismissalInput): (event: KeyboardEvent<HTMLElement>) => void {
  const active = overlay === true && expanded;
  const collapse = useCallback(() => { setExpanded(false); }, [setExpanded]);
  useOutsidePointerDismiss(active, containerRef, collapse);

  return useCallback((event: KeyboardEvent<HTMLElement>): void => {
    if (!active || event.key !== 'Escape') return;
    // The panel is the innermost thing Escape can close here, so the press is
    // not offered to the surfaces behind it.
    event.stopPropagation();
    collapse();
    triggerRef.current?.focus();
  }, [active, collapse, triggerRef]);
}
