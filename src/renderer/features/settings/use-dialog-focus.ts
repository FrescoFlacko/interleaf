import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Focus handling for a modal dialog: initial focus inside it, Escape to close,
 * Tab kept within it, and focus returned to where it was once it closes.
 */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  if (open && returnTargetRef.current === null && document.activeElement instanceof HTMLElement) {
    returnTargetRef.current = document.activeElement;
  }

  useEffect(() => {
    if (!open) return;
    const animationFrame = window.requestAnimationFrame(() => {
      // Initial focus only: if something inside already holds focus — a key
      // field focused by Add provider or by a removal — leave it alone.
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(document.activeElement)) return;
      const target = dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      target.focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
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
      const returnTarget = returnTargetRef.current;
      returnTargetRef.current = null;
      queueMicrotask(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
      });
    };
  }, [open]);

  return dialogRef;
}
