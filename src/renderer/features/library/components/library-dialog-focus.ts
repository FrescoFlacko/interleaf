import { useEffect, useRef, type RefObject } from 'react';

/*
 * Focus handling shared by the library's modal dialogs: initial focus, the Tab
 * trap, Escape, and focus returned to the opener when the dialog closes.
 */

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export type DialogFocusOptions = {
  readonly returnTarget?: HTMLElement | null | undefined;
  readonly returnTargetRef?: RefObject<HTMLElement | null>;
  readonly suppressReturnRef?: RefObject<boolean>;
};

export function useDialogFocus(open: boolean, onClose: () => void, options?: DialogFocusOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const internalReturnTargetRef = useRef<HTMLElement | null>(null);
  const returnTargetRef = options?.returnTargetRef ?? internalReturnTargetRef;
  const suppressReturnRef = options?.suppressReturnRef;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Capture before React applies an input's autoFocus during the commit.
  if (open && returnTargetRef.current === null) {
    const active = document.activeElement;
    returnTargetRef.current = options?.returnTarget !== undefined
      ? options.returnTarget
      : (active instanceof HTMLElement && active !== document.body)
        ? active
        : null;
  }

  useEffect(() => {
    if (!open) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      // Claim initial focus only while nothing inside the dialog holds it.
      // A control that took focus deliberately before this frame ran — such as
      // the actions menu handing focus to the next dialog control on Tab —
      // must keep it rather than being yanked back to the top of the dialog.
      const active = document.activeElement;
      if (active instanceof HTMLElement && dialog.contains(active)) return;
      const target = dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      target.focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', onKeyDown);
      if (suppressReturnRef?.current === true) {
        suppressReturnRef.current = false;
        returnTargetRef.current = null;
        return;
      }
      const returnTarget = returnTargetRef.current;
      returnTargetRef.current = null;
      queueMicrotask(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
      });
    };
  }, [open, returnTargetRef, suppressReturnRef]);

  return dialogRef;
}
