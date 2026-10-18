import { useEffect, useRef, type RefObject } from 'react';
import { useDialogFocus } from '../library/components/LibraryModals';

/** Where focus goes when the wizard closes and no opener is left to take it. */
const MAIN_CONTENT_ID = 'main-content';

/**
 * The shared dialog focus behaviour, plus a defined destination for the case
 * the shared hook cannot cover.
 *
 * `useDialogFocus` restores focus to whatever was focused when the dialog
 * opened. Onboarding has two situations where that target does not exist: the
 * wizard auto-opens at first launch, before the user has focused anything, and
 * an opener such as a Settings row can unmount while the wizard is up. In both
 * cases the shared hook correctly declines to focus a disconnected element, and
 * focus would otherwise fall to `document.body`, leaving keyboard users with no
 * position in the page (§5.3).
 *
 * The fallback runs only when focus really was lost: the shared restore is
 * queued first, so by the time this microtask runs a live opener has already
 * taken focus and this does nothing.
 */
export function useOnboardingDialogFocus(
  open: boolean,
  onClose: () => void,
  openerId: string | null = null
): RefObject<HTMLDivElement | null> {
  const openerRef = useRef<HTMLElement | null>(null);
  const named = findOpenerElement(openerId);
  const dialogRef = useDialogFocus(open, onClose, {
    returnTargetRef: openerRef,
    // A named opener wins over "whatever had focus", so a rerun started from a
    // Settings row returns there even if focus moved before the commit.
    ...(named === null ? {} : { returnTarget: named }),
  });

  useEffect(() => {
    if (!open) return;
    return () => {
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        const fallback = document.getElementById(MAIN_CONTENT_ID);
        fallback?.focus();
      });
    };
  }, [open]);

  return dialogRef;
}

/**
 * Resolves the element a named opener refers to, for the rerun entry point.
 *
 * Returns `null` rather than throwing when the control has gone: the caller
 * then falls back to the main content region above.
 */
function findOpenerElement(openerId: string | null): HTMLElement | null {
  if (openerId === null) return null;
  return document.querySelector<HTMLElement>(`[data-onboarding-opener="${CSS.escape(openerId)}"]`);
}
