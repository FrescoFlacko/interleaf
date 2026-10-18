import { useState, type KeyboardEvent } from 'react';
import { useSlidePresence, type SlidePhase, type SlidePresence } from '../slide-presence';

/**
 * Shared motion and look of every menu, popover and modal dialog
 * (docs/UX_SPEC.md, Motion). Entry is a 150ms fade and 0.96 scale out of the
 * trigger side (`.ui-popover`) or a 200ms fade up (`.ui-dialog`); every exit is
 * a 100ms fade, opacity only. While it leaves, a surface is inert and hidden
 * from assistive technology, so it can never take a click, a key or focus.
 */

/** Every exit; matches `--dur-exit` in styles/tokens.css. */
export const EXIT_MS = 100;

/**
 * Keeps a menu, popover or dialog mounted through its 100ms exit. `animateMount`
 * is for a surface rendered only while wanted, so it still transitions in.
 */
export function usePopoverPresence(open: boolean, animateMount = false): SlidePresence {
  return useSlidePresence(open, EXIT_MS, animateMount);
}

/**
 * A modal rendered only while it has a subject (a folder, a document): keeps
 * the last subject on screen through the exit, so the dialog fades out with its
 * content rather than emptying first. `shown` is null once the exit is over.
 */
export function useModalPresence<T>(subject: T | null): { readonly shown: T | null; readonly phase: SlidePhase } {
  const [kept, setKept] = useState(subject);
  if (subject !== null && subject !== kept) setKept(subject);
  const presence = usePopoverPresence(subject !== null, true);
  return { shown: presence.present ? (subject ?? kept) : null, phase: presence.phase };
}

/** The phase the CSS keys on, plus inert and hidden while the surface leaves. */
export function phaseAttributes(phase: SlidePhase): {
  readonly 'data-phase': SlidePhase;
  readonly inert?: true;
  readonly 'aria-hidden'?: true;
} {
  return phase === 'exiting' ? { 'data-phase': phase, inert: true, 'aria-hidden': true } : { 'data-phase': phase };
}

/**
 * Escape and Tab inside a menu. Both hand focus back to the trigger before the
 * menu goes inert: Escape stops there, and Tab is left to the browser, which
 * then moves on from the trigger's own place in the tab order (Shift+Tab
 * back), as if the menu had never been opened. Returns whether it handled the key.
 */
export function dismissMenuOnKey(
  event: KeyboardEvent<HTMLElement>,
  dismiss: () => void,
  trigger: HTMLElement | null
): boolean {
  if (event.key !== 'Escape' && event.key !== 'Tab') return false;
  // Escape closes this menu, not a dialog that contains it.
  event.stopPropagation();
  if (event.key === 'Escape') event.preventDefault();
  trigger?.focus();
  dismiss();
  return true;
}

/** The surface of every menu and list popover. */
export const MENU_SURFACE_CLASS =
  'ui-popover rounded-md border border-border-subtle bg-bg-surface-elevated p-1 shadow-popover';

/** A row in a menu or list popover; its leading slot is `MENU_CHECK_SLOT_CLASS`. */
export const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-text-primary hover:bg-accent-muted focus-visible:bg-accent-muted focus-visible:outline-none';

/**
 * A row whose label runs to a second line of detail: the same padding, hover
 * and focus as `MENU_ITEM_CLASS`, top-aligned so the check slot sits beside
 * the first line.
 */
export const MENU_ITEM_TWO_LINE_CLASS =
  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-text-primary hover:bg-accent-muted focus-visible:bg-accent-muted focus-visible:outline-none';

/** A destructive row: the same geometry, in the danger colour. */
export const MENU_DANGER_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-danger hover:bg-danger/10 focus-visible:bg-danger/10 focus-visible:outline-none';

/**
 * The leading 12px slot every row reserves, holding the check of a chosen
 * option or an icon; action rows keep it empty, so all labels line up.
 */
export const MENU_CHECK_SLOT_CLASS = 'flex w-3 shrink-0 justify-center text-accent';
