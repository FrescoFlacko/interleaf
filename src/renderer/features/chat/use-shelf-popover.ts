import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

/** Whether a press landed on the popover itself or on the control that opened it. */
function isOwnElement(target: EventTarget | null, popover: HTMLElement | null, trigger: HTMLElement | null): boolean {
  if (!(target instanceof Node)) return false;
  return [popover, trigger].some((element) => element?.contains(target) === true);
}

/** Keeps Tab and Shift+Tab inside the popover, wrapping at either end. */
function trapTab(event: ReactKeyboardEvent<HTMLElement>, popover: HTMLElement | null): void {
  const focusable = [...(popover?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Open state for one shelf or composer popover, and the trigger focus returns
 * to: its own, or one the caller also hands elsewhere.
 */
export function useShelfPopoverState(sharedTriggerRef?: RefObject<HTMLButtonElement | null>): {
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly toggle: () => void;
  readonly close: () => void;
} {
  const [open, setOpen] = useState(false);
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = sharedTriggerRef ?? ownTriggerRef;
  const close = useCallback((): void => {
    setOpen(false);
    window.queueMicrotask(() => { triggerRef.current?.focus(); });
  }, [triggerRef]);
  const toggle = useCallback((): void => {
    if (open) close();
    else setOpen(true);
  }, [close, open]);
  return { open, triggerRef, toggle, close };
}

/**
 * The dismissal rules shared by the Chat context popovers: focus moves to the
 * first enabled control on open, Tab stays inside, and Escape or a press
 * anywhere else closes this popover only and returns focus to its trigger.
 * Pressing another composer control therefore closes this one first, so two
 * context popovers never compete.
 */
export function useShelfPopover({
  popoverRef,
  triggerRef,
  leaving,
  onClose,
}: {
  readonly popoverRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly leaving: boolean;
  readonly onClose: () => void;
}): (event: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (leaving) return;
    popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [leaving, popoverRef]);

  useEffect(() => {
    if (leaving) return undefined;
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (isOwnElement(event.target, popoverRef.current, triggerRef.current)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handleOutsidePointer);
    return () => { document.removeEventListener('pointerdown', handleOutsidePointer); };
  }, [leaving, onClose, popoverRef, triggerRef]);

  return useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      // Closes this popover only; the drawer around it never sees the key.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') trapTab(event, popoverRef.current);
  }, [onClose, popoverRef]);
}
