import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AppIcon } from '../../../components/AppIcon';
import { cn } from '../../../components/ui/cn';
import {
  MENU_CHECK_SLOT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SURFACE_CLASS,
  dismissMenuOnKey,
  phaseAttributes,
  usePopoverPresence,
} from '../../../components/ui/popover-presence';

type ImportMenuProps = {
  readonly isImporting: boolean;
  readonly onImportFromFiles: () => void;
  readonly onImportFromWeb: () => void;
};

const ITEM_SELECTOR = '[role="menuitem"]';

function focusStep(container: HTMLElement | null, step: number): void {
  const items = container ? [...container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : [];
  if (items.length === 0) return;
  const index = items.findIndex((item) => item === document.activeElement);
  if (index === -1) {
    const target = step > 0 ? items[0] : items[items.length - 1];
    target?.focus();
    return;
  }
  const nextItem = items[(index + step + items.length) % items.length];
  nextItem?.focus();
}

/**
 * The library's import control, as a split button.
 *
 * The primary half keeps doing exactly what `+ Import` has always done — open
 * the file picker in one press — because file import is the common path and
 * putting a menu in front of it would cost every existing user an extra click.
 * The caret half names both sources explicitly, which is where the web option
 * lives. Both halves are ordinary buttons, so keyboard users reach the menu by
 * tabbing rather than by discovering a hidden gesture.
 */
export function ImportMenu({ isImporting, onImportFromFiles, onImportFromWeb }: ImportMenuProps) {
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    });
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  function dismiss(restoreFocus: boolean): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // Tab moves on from the trigger, as if the menu had never opened.
    if (dismissMenuOnKey(event, () => { dismiss(false); }, triggerRef.current)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(menuRef.current, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(menuRef.current, -1);
    }
  }

  return (
    <div className="relative flex items-stretch">
      <button
        type="button"
        data-testid="import-files-button"
        disabled={isImporting}
        onClick={onImportFromFiles}
        className="rounded-l-md bg-accent px-3 py-1.5 font-medium text-on-accent shadow-xs hover:opacity-90 disabled:opacity-50"
      >
        {isImporting ? 'Importing...' : '+ Import'}
      </button>
      <button
        ref={triggerRef}
        type="button"
        data-testid="import-options-button"
        aria-label="Choose an import source"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'library-import-menu' : undefined}
        disabled={isImporting}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
        className="ml-px flex items-center rounded-r-md bg-accent px-2 py-1.5 text-on-accent shadow-xs hover:opacity-90 disabled:opacity-50"
      >
        <AppIcon name="menu-caret" size={14} />
      </button>

      {presence.present && (
        <div
          ref={menuRef}
          id="library-import-menu"
          role="menu"
          aria-label="Import source"
          onKeyDown={handleMenuKeyDown}
          data-testid="library-import-menu"
          {...phaseAttributes(presence.phase)}
          className={cn(MENU_SURFACE_CLASS, 'absolute right-0 top-full z-40 mt-1 flex w-52 origin-top-right flex-col')}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="import-from-files-item"
            onClick={() => {
              // Focus returns to the trigger before the action runs, so the
              // dialog or native picker that follows has a real element to
              // hand focus back to when it closes.
              dismiss(true);
              onImportFromFiles();
            }}
            className={MENU_ITEM_CLASS}
          >
            <span aria-hidden="true" className={cn(MENU_CHECK_SLOT_CLASS, 'text-text-secondary')}>
              <AppIcon name="import-from-files" size={12} />
            </span>
            From files…
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="import-from-web-item"
            onClick={() => {
              dismiss(true);
              onImportFromWeb();
            }}
            className={MENU_ITEM_CLASS}
          >
            <span aria-hidden="true" className={cn(MENU_CHECK_SLOT_CLASS, 'text-text-secondary')}>
              <AppIcon name="import-from-web" size={12} />
            </span>
            From web URL…
          </button>
        </div>
      )}
    </div>
  );
}
