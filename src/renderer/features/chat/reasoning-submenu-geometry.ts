/** The flyout's width, matching `.chat-reasoning-flyout`. */
export const SUBMENU_WIDTH = 184;
/** Space between the picker and the flyout. */
export const SUBMENU_GAP = 4;
/** Smallest distance kept between the flyout and the viewport edge. */
const EDGE = 8;

export type SubmenuSide = 'right' | 'left' | 'nested';

type Box = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
type Point = { readonly x: number; readonly y: number };

/**
 * Where the levels open: beside the picker on the right when that fits, else
 * on the left, else in place inside the picker. A flyout is never allowed to
 * cover the picker or the row it belongs to.
 */
export function submenuSide(picker: Pick<Box, 'left' | 'right'>, viewportWidth: number): SubmenuSide {
  if (picker.right + SUBMENU_GAP + SUBMENU_WIDTH + EDGE <= viewportWidth) return 'right';
  if (picker.left - SUBMENU_GAP - SUBMENU_WIDTH >= EDGE) return 'left';
  return 'nested';
}

/**
 * Viewport coordinates for a flyout of `height`, its top level with the row and
 * clamped into the viewport.
 */
export function submenuPosition(
  side: Exclude<SubmenuSide, 'nested'>,
  picker: Box,
  row: Box,
  height: number,
  viewportHeight: number
): { readonly left: number; readonly top: number } {
  const left = side === 'right' ? picker.right + SUBMENU_GAP : picker.left - SUBMENU_GAP - SUBMENU_WIDTH;
  const top = Math.min(Math.max(row.top - 4, EDGE), Math.max(EDGE, viewportHeight - height - EDGE));
  return { left: Math.round(left), top: Math.round(top) };
}

function sign(p: Point, a: Point, b: Point): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/**
 * Whether the pointer, moving from `origin` to `point`, is heading for the open
 * flyout: inside the triangle from where it was to the flyout's near edge. A
 * diagonal path across other rows then keeps the flyout instead of switching.
 */
export function aimsAtSubmenu(origin: Point, point: Point, submenu: Box): boolean {
  if (origin.x === point.x && origin.y === point.y) return false;
  const nearX = point.x <= submenu.left ? submenu.left : submenu.right;
  const top = { x: nearX, y: submenu.top };
  const bottom = { x: nearX, y: submenu.bottom };
  const d1 = sign(point, origin, top);
  const d2 = sign(point, top, bottom);
  const d3 = sign(point, bottom, origin);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}
