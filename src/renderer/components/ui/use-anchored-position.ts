import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * `top` opens above and start-aligned, `bottom` below and end-aligned (the
 * composer and session-card menus), `bottom-start` below and start-aligned
 * (a select's listbox). Each flips vertically when its side has no room.
 */
export type AnchorPlacement = 'top' | 'bottom' | 'bottom-start';

/** Distance kept between the trigger chip and the popup it opens. */
const GAP = 6;
/** Smallest distance kept between the popup and the viewport edge. */
const EDGE = 8;

type Offset = { readonly left: number; readonly top: number; readonly opensUp: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where `position: fixed` coordinates start for this popup.
 *
 * A transformed or filtered ancestor, not the viewport, is the containing
 * block of a fixed descendant. The compact drawer rests at an identity
 * transform, so a list portalled into it would otherwise land a whole drawer
 * offset to the right, off the screen.
 */
function fixedOrigin(popup: HTMLElement): { readonly left: number; readonly top: number } {
  for (let element = popup.parentElement; element !== null && element !== document.body; element = element.parentElement) {
    const style = getComputedStyle(element);
    const effects = [style.transform, style.filter, style.perspective, style.backdropFilter];
    const establishes = effects.some((value) => value !== 'none')
      || /paint|layout|strict|content/u.test(style.contain)
      || /transform|filter|perspective/u.test(style.willChange);
    if (establishes) {
      const rect = element.getBoundingClientRect();
      return { left: rect.left + element.clientLeft, top: rect.top + element.clientTop };
    }
  }
  return { left: 0, top: 0 };
}

/**
 * Places a popup against its trigger in viewport coordinates.
 *
 * The composer's configuration row scrolls horizontally, which makes it a
 * scroll container that also clips vertically, so a popup positioned inside it
 * is cut off and stops receiving pointer events. The popup is therefore
 * rendered outside that ancestor and anchored here instead: the trigger's own
 * rectangle drives `position: fixed` coordinates, the requested side flips when
 * that side has no room, and the result is clamped into the viewport so the
 * whole list stays reachable near a window edge.
 *
 * Coordinates are measured before paint and refreshed while the popup is open,
 * because the anchor moves whenever the window resizes or any ancestor scrolls.
 *
 * A popup whose own content grows after it opens — a disclosure inside it being
 * expanded — is measured again too, or it would keep the coordinates taken at
 * its old height and hang off the bottom of the viewport.
 */
export function useAnchoredPosition(
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  placement: AnchorPlacement
): CSSProperties {
  const [offset, setOffset] = useState<Offset>({ left: 0, top: 0, opensUp: false });

  const measure = useCallback((): void => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (trigger === null || popup === null) return;

    const anchor = trigger.getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const above = anchor.top - height - GAP;
    const below = anchor.bottom + GAP;
    const fitsAbove = above >= EDGE;
    const fitsBelow = below + height <= viewportHeight - EDGE;
    const opensUp = placement === 'top' ? fitsAbove || !fitsBelow : fitsAbove && !fitsBelow;

    const preferredLeft = placement === 'bottom' ? anchor.right - width : anchor.left;
    const origin = fixedOrigin(popup);

    setOffset({
      left: Math.round(clamp(preferredLeft, EDGE, viewportWidth - width - EDGE) - origin.left),
      top: Math.round(clamp(opensUp ? above : below, EDGE, viewportHeight - height - EDGE) - origin.top),
      opensUp,
    });
  }, [placement, popupRef, triggerRef]);

  // Before paint, so the popup never appears at an unanchored position.
  useLayoutEffect(measure, [measure]);

  // And again, before paint, whenever the popup's own height changes: the new
  // height only exists after layout, so it is read here rather than predicted.
  // Measuring sets state and re-renders, at which point the height matches and
  // this stops.
  const measuredHeightRef = useRef(0);
  useLayoutEffect(() => {
    const height = popupRef.current?.offsetHeight ?? 0;
    if (height === measuredHeightRef.current) return;
    measuredHeightRef.current = height;
    measure();
  });

  useEffect(() => {
    window.addEventListener('resize', measure);
    // Scroll does not bubble from an inner scroller, so watch the capture phase
    // to follow the trigger when the configuration row itself is scrolled.
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  // The popup grows out of the edge that touches its trigger.
  return {
    left: `${String(offset.left)}px`,
    top: `${String(offset.top)}px`,
    transformOrigin: offset.opensUp ? 'bottom' : 'top',
  };
}
