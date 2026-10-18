import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { PaletteId } from '@shared/constants/palettes';
import { paletteInfo } from '@shared/constants/palette-lookup';
import type { AppSettings } from '@shared/schemas/settings';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import {
  MENU_CHECK_SLOT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SURFACE_CLASS,
  dismissMenuOnKey,
  phaseAttributes,
  usePopoverPresence,
} from '../../components/ui/popover-presence';
import type { SlidePhase } from '../../components/slide-presence';
import { AppIcon } from '../../components/AppIcon';
import { headerThemes } from './theme-choice';
import { ThemeSwatch } from './ThemeSwatch';

const ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitem"]';

function moveFocus(menu: HTMLElement | null, key: string): boolean {
  const items = menu === null ? [] : [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
  const index = items.findIndex((item) => item === document.activeElement);
  const targets: Readonly<Record<string, number>> = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  };
  const target = targets[key];
  if (target === undefined) return false;
  items[target]?.focus();
  return true;
}

type ThemeMenuListProps = {
  readonly phase: SlidePhase;
  readonly themes: readonly PaletteId[];
  readonly current: PaletteId;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onChoose: (palette: PaletteId) => void;
  readonly onAllThemes: () => void;
  readonly onDismiss: (restoreFocus: boolean) => void;
};

function ThemeMenuList({ phase, themes, current, triggerRef, onChoose, onAllThemes, onDismiss }: ThemeMenuListProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, menuRef, 'bottom');

  // Again when it reopens during its exit fade, as on a fresh open.
  const leaving = phase === 'exiting';
  useEffect(() => {
    if (leaving) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [leaving]);

  useEffect(() => {
    if (phase === 'exiting') return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      onDismiss(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { document.removeEventListener('pointerdown', handlePointerDown); };
  }, [onDismiss, phase, triggerRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (dismissMenuOnKey(event, () => { onDismiss(false); }, triggerRef.current)) return;
    if (moveFocus(menuRef.current, event.key)) event.preventDefault();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Theme"
      data-testid="theme-menu"
      onKeyDown={handleKeyDown}
      {...phaseAttributes(phase)}
      style={anchorStyle}
      className={`${MENU_SURFACE_CLASS} fixed z-[60] w-56`}
    >
      {themes.map((palette) => (
        <button
          key={palette}
          type="button"
          role="menuitemradio"
          aria-checked={palette === current}
          tabIndex={-1}
          data-testid={`palette-option-${palette}`}
          onClick={() => { onChoose(palette); }}
          className={MENU_ITEM_CLASS}
        >
          <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS}>{palette === current && <AppIcon name="check" size={12} />}</span>
          <ThemeSwatch palette={palette} size={16} />
          <span className="min-w-0 flex-1 truncate">{paletteInfo(palette).label}</span>
        </button>
      ))}
      <div role="separator" className="mx-1 my-1 h-px bg-border-subtle" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-testid="theme-menu-all"
        onClick={onAllThemes}
        className={MENU_ITEM_CLASS}
      >
        <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS} />
        All themes…
      </button>
    </div>,
    document.body
  );
}

type ThemeMenuProps = {
  readonly appearance: AppSettings['appearance'];
  readonly disabled: boolean;
  readonly onChoose: (palette: PaletteId) => void;
  readonly onAllThemes: () => void;
};

/**
 * The header's theme control: the current theme's swatch, opening a short
 * menu of the current theme, up to six recently used ones and "All themes…",
 * which opens Settings → Theme with every theme previewed.
 */
export function ThemeMenu({ appearance, disabled, onChoose, onAllThemes }: ThemeMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = appearance.palette;

  const dismiss = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="theme-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${paletteInfo(current).label}`}
        title="Theme"
        disabled={disabled}
        onClick={() => { setOpen((value) => !value); }}
        className="flex shrink-0 items-center gap-1 rounded-md p-1.5 text-text-secondary hover:bg-bg-surface hover:text-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:p-2"
      >
        <ThemeSwatch palette={current} size={18} />
        <AppIcon name="menu-caret" size={12} />
      </button>
      {presence.present && (
        <ThemeMenuList
          phase={presence.phase}
          themes={headerThemes(appearance)}
          current={current}
          triggerRef={triggerRef}
          onChoose={(palette) => { dismiss(true); onChoose(palette); }}
          onAllThemes={() => { dismiss(false); onAllThemes(); }}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
