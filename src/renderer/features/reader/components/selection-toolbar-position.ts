/**
 * Where the selection toolbar (and its note editor) sits.
 *
 * The toolbar is `position: fixed`, but it belongs to the reader: clamping it
 * only to the window let it spill over the companion panel and cover its
 * controls. The bounds are therefore the reader viewport's rect, intersected
 * with the window, and the toolbar is narrowed to fit them when the reader is
 * the narrower of the two. It prefers the space above the selection, flips
 * below when that does not fit, and is clamped inside the bounds either way.
 */

export type ToolbarRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
export type ToolbarSize = { readonly width: number; readonly height: number };
export type ToolbarPosition = { readonly left: number; readonly top: number; readonly maxWidth: number };

const MARGIN = 8;

/** The reader rect clipped to the window, or the window when there is no reader. */
export function selectionToolbarBounds(reader: ToolbarRect | null, windowSize: ToolbarSize): ToolbarRect {
  const windowRect = { left: 0, top: 0, width: windowSize.width, height: windowSize.height };
  if (reader === null || reader.width <= 0 || reader.height <= 0) return windowRect;
  const left = Math.max(0, reader.left);
  const top = Math.max(0, reader.top);
  const right = Math.min(windowSize.width, reader.left + reader.width);
  const bottom = Math.min(windowSize.height, reader.top + reader.height);
  if (right <= left || bottom <= top) return windowRect;
  return { left, top, width: right - left, height: bottom - top };
}

export function selectionToolbarPosition(selection: ToolbarRect, size: ToolbarSize, bounds: ToolbarRect): ToolbarPosition {
  const maxWidth = Math.max(0, bounds.width - MARGIN * 2);
  const width = Math.min(size.width, maxWidth);
  const minLeft = bounds.left + MARGIN;
  const maxLeft = Math.max(minLeft, bounds.left + bounds.width - width - MARGIN);
  const left = Math.max(minLeft, Math.min(maxLeft, selection.left));

  const minTop = bounds.top + MARGIN;
  const maxTop = Math.max(minTop, bounds.top + bounds.height - size.height - MARGIN);
  const spaceAbove = selection.top - bounds.top;
  const spaceBelow = bounds.top + bounds.height - (selection.top + selection.height);
  const above = selection.top - size.height - MARGIN;
  const below = selection.top + selection.height + MARGIN;
  const rawTop = spaceAbove < size.height + MARGIN && spaceBelow >= size.height + MARGIN ? below : above;
  const top = Math.max(minTop, Math.min(maxTop, rawTop));
  return { left, top, maxWidth };
}
