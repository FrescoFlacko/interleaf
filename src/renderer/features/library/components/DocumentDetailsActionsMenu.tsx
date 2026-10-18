import { useEffect, useRef, useState } from 'react';
import { AppIcon } from '../../../components/AppIcon';
import { cn } from '../../../components/ui/cn';
import {
  MENU_CHECK_SLOT_CLASS,
  MENU_DANGER_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MENU_SURFACE_CLASS,
  phaseAttributes,
  usePopoverPresence,
} from '../../../components/ui/popover-presence';

export type DetailsActionItem = {
  readonly id: string;
  readonly label: string;
  readonly testId: string;
  readonly title?: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
};

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

const DIALOG_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]';

/**
 * Where Tab should leave focus when it closes the menu.
 *
 * Tab must not be trapped on the trigger: a reader tabbing out of an overflow
 * menu expects the dialog's own order to continue, so forward moves to the
 * control after the trigger (`Read`) and backward returns to the trigger, which
 * is itself the control before the menu. Roving focus keeps the items untabbable,
 * so they are skipped by the same `tabIndex` filter that skips the dialog shell.
 */
function tabTarget(trigger: HTMLElement, backward: boolean): HTMLElement | null {
  if (backward) return trigger;
  const dialog = trigger.closest('[role="dialog"]');
  if (dialog === null) return trigger;
  const focusables = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0
  );
  const index = focusables.indexOf(trigger);
  // Wrapping at the end matches the dialog's own trap rather than escaping it.
  return focusables[index + 1] ?? focusables[0] ?? trigger;
}

/** Roving focus wraps at both ends; with nothing focused yet, enter from the edge the key came from. */
function nextIndex(current: number, delta: number, length: number): number {
  if (current !== -1) return (current + delta + length) % length;
  return delta > 0 ? 0 : length - 1;
}

function menuItemsOf(container: HTMLElement | null): readonly HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)] : [];
}

/**
 * The details dialog's secondary commands, behind one labelled overflow menu.
 *
 * It is rendered inside the dialog rather than portalled, because the dialog is
 * not a scroll container and keeping it in the tree keeps it inside the dialog's
 * own focus trap. Roving focus leaves exactly one item tabbable; Escape dismisses
 * the menu and hands focus back to the trigger, and it is stopped here so
 * dismissing the menu does not also close the dialog behind it. Tab also
 * dismisses, then continues in the dialog's order rather than trapping focus on
 * the trigger. An outside pointer press dismisses the menu and nothing else.
 */
export function DocumentDetailsActionsMenu({ items }: { readonly items: readonly DetailsActionItem[] }) {
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const dismiss = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    // The dialog claims initial focus on an animation frame of its own, so take
    // the first item on a later frame rather than racing it.
    const animationFrame = window.requestAnimationFrame(() => {
      // A menu already fading out is inert and never takes focus back.
      if (menuRef.current?.dataset.phase === 'exiting') return;
      menuItemsOf(menuRef.current)[0]?.focus();
    });
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const step = (delta: number): void => {
    const entries = menuItemsOf(menuRef.current);
    if (entries.length === 0) return;
    const index = entries.findIndex((entry) => entry === document.activeElement);
    entries[nextIndex(index, delta, entries.length)]?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="document-details-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="document-details-actions-menu"
        aria-label="Document actions"
        title="Document actions"
        onClick={() => { setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface hover:text-text-primary"
      >
        <AppIcon name="more-horizontal" size={14} />
        <span>Actions</span>
      </button>
      {presence.present && (
        <div
          ref={menuRef}
          id="document-details-actions-menu"
          role="menu"
          aria-label="Document actions"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              dismiss(true);
            } else if (event.key === 'Tab') {
              // The menu closes, but focus continues in dialog order instead of
              // snapping back to the trigger in both directions.
              event.preventDefault();
              event.stopPropagation();
              const target = triggerRef.current === null ? null : tabTarget(triggerRef.current, event.shiftKey);
              dismiss(false);
              target?.focus();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              step(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              step(-1);
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const entries = menuItemsOf(menuRef.current);
              (event.key === 'Home' ? entries[0] : entries[entries.length - 1])?.focus();
            }
          }}
          {...phaseAttributes(presence.phase)}
          className={cn(MENU_SURFACE_CLASS, 'absolute bottom-full left-0 z-10 mb-1 flex min-w-44 origin-bottom-left flex-col')}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid={item.testId}
              {...(item.title !== undefined ? { title: item.title } : {})}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={item.danger === true ? MENU_DANGER_ITEM_CLASS : MENU_ITEM_CLASS}
            >
              <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
