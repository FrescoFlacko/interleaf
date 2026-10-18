import type { RectLike } from './note-pointer';

/**
 * Pure placement math for the reader note popover (Defect 20).
 *
 * The popover measures its real rendered size (wrapping, explicit newlines,
 * max-height clamping) via useLayoutEffect + ResizeObserver in the component
 * and asks this function for a clamped top-window position. Placement rules:
 *  - prefer fully clear space ABOVE the anchor, then BELOW;
 *  - only when neither side has room, overlap is allowed on the side with
 *    more room, clamped inside the viewport (the panel scrolls internally);
 *  - horizontally clamped to the viewport inset at any zoom.
 */
export type PopoverSize = { readonly width: number; readonly height: number };
export type PopoverViewport = { readonly width: number; readonly height: number };
export type PopoverPlacement = { readonly left: number; readonly top: number };

export const POPOVER_INSET_PX = 8;
export const POPOVER_GAP_PX = 8;

export function computeNotePopoverPlacement(
  anchor: RectLike,
  size: PopoverSize,
  viewport: PopoverViewport
): PopoverPlacement {
  const inset = POPOVER_INSET_PX;
  const gap = POPOVER_GAP_PX;
  const maxLeft = Math.max(inset, viewport.width - size.width - inset);
  const left = Math.max(inset, Math.min(maxLeft, anchor.left));

  const spaceAbove = anchor.top - inset;
  const spaceBelow = viewport.height - anchor.bottom - inset;
  const fitsAbove = spaceAbove >= size.height + gap;
  const fitsBelow = spaceBelow >= size.height + gap;

  let top: number;
  if (fitsAbove) {
    top = anchor.top - gap - size.height;
  } else if (fitsBelow) {
    top = anchor.bottom + gap;
  } else {
    // Neither side fully fits: use the roomier side, clamp inside the
    // viewport; the panel's max-height + internal scrolling keep it usable.
    const topCandidate = spaceAbove >= spaceBelow
      ? anchor.top - gap - size.height
      : anchor.bottom + gap;
    const minTop = inset;
    const maxTop = Math.max(minTop, viewport.height - size.height - inset);
    top = Math.max(minTop, Math.min(maxTop, topCandidate));
  }
  return { left, top };
}
