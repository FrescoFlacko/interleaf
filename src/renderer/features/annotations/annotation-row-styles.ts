/**
 * The one baseline geometry every annotation row is built from.
 *
 * Reference 4a draws notes and highlights as the same object with different
 * contents, so the container, its padding, the floor under a row, the type
 * scale of whatever leads the row, and the line the actions sit on are all
 * defined once here and shared. A note and a highlight of comparable length
 * then occupy the same space by construction rather than by coincidence, and a
 * later change to one cannot silently desynchronise the other.
 *
 * The floor is a minimum only. Long content — a note's full rendered Markdown,
 * or a long highlighted passage — grows past it; nothing here clamps or hides
 * an annotation's own words.
 */

/**
 * Row container: shared padding, gutter, separator and minimum height.
 *
 * The floor is the height a short note row reaches on its own — 15px of padding
 * top and bottom, a 24px metadata line, one 22.5px line of the reader's own
 * words, one 18px line of the passage supporting them, a 24px action line, the
 * 8px gaps between them and the 1px separator, which measures 143.5px in
 * Chromium. Rounding that up to 148 gives a short highlight, which has no
 * supporting line of its own, the same card as a short note instead of a
 * shorter one, with a few pixels of slack for font metrics. The Electron visual
 * suite measures both rows and fails if they ever stop matching.
 */
export const ANNOTATION_ROW =
  'flex min-h-[148px] gap-3 border-b border-border-subtle px-4 py-4';

/** Column beside the colour rail, holding metadata, body and actions. */
export const ANNOTATION_ROW_CONTENT = 'flex min-w-0 flex-1 flex-col gap-2';

/**
 * Action line. `mt-auto` keeps it on the bottom edge of the shared floor, so a
 * short note and a short highlight align their controls at the same height, and
 * the 24px minimum exactly absorbs the colour swatches a highlight adds — those
 * swatches are 24px targets, so the line is the same box whether or not a row
 * has them.
 */
export const ANNOTATION_ROW_ACTIONS =
  'mt-auto flex min-h-6 flex-wrap items-center gap-3.5';

/**
 * The leading text of a row: a note's rendered body, or the highlighted passage
 * itself when a highlight has no note yet. One type scale for both, so equal
 * content produces equal height. `[overflow-wrap:anywhere]` keeps an unbroken
 * token — a URL in a saved AI answer — inside the column instead of widening
 * the panel.
 */
export const ANNOTATION_ROW_PRIMARY_TEXT =
  'min-w-0 text-base leading-[1.55] text-text-primary [overflow-wrap:anywhere]';
