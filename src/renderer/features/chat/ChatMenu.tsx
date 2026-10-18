import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import { AppIcon } from '../../components/AppIcon';
import { dismissMenuOnKey, phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import type { SlidePhase } from '../../components/slide-presence';

export type ChatMenuItem = {
  readonly id: string;
  readonly label: string;
  /** `option` renders a checkable value; `action` renders a command. */
  readonly kind: 'option' | 'action';
  readonly checked?: boolean;
  readonly tone?: 'danger';
  /** Draws a real separator above this entry, dividing values from actions. */
  readonly separatorBefore?: boolean;
  readonly testId?: string;
  readonly onSelect: () => void;
};

type ChatMenuProps = {
  /** Kept mounted, inert, through the 100ms exit after this turns false. */
  readonly open: boolean;
  readonly id: string;
  /** Accessible name of the menu itself. */
  readonly label: string;
  readonly items: readonly ChatMenuItem[];
  readonly placement: 'top' | 'bottom';
  /** The control that opened the menu; pointer events on it are not "outside". */
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onDismiss: (restoreFocus: boolean) => void;
};

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

function itemsOf(container: HTMLElement | null): readonly HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : [];
}

function focusStep(container: HTMLElement | null, step: number): void {
  const items = itemsOf(container);
  if (items.length === 0) return;
  const index = items.findIndex((item) => item === document.activeElement);
  if (index === -1) {
    (step > 0 ? items[0] : items[items.length - 1])?.focus();
    return;
  }
  items[(index + step + items.length) % items.length]?.focus();
}

/** Home and End address the ends of the list, not one step from the cursor. */
function focusEdge(container: HTMLElement | null, edge: 'first' | 'last'): void {
  const items = itemsOf(container);
  (edge === 'first' ? items[0] : items[items.length - 1])?.focus();
}

/**
 * Small popup menu used where a native `select` cannot express the content: a
 * checked value list, a real separator, and commands that are not values.
 *
 * Roving focus keeps exactly one item tabbable; Escape, Tab and outside pointer
 * presses all dismiss it. Escape and Tab return focus to the trigger first, so
 * Tab then moves on from the trigger's place in the tab order.
 *
 * It is portalled to the document body and anchored to its trigger, because the
 * composer's configuration row is a horizontal scroll container that would clip
 * it. React still propagates its events along the component tree, so call sites
 * see the same bubbling as when it rendered in place.
 */
export function ChatMenu({ open, ...props }: ChatMenuProps) {
  const presence = usePopoverPresence(open);
  return presence.present ? <ChatMenuSurface {...props} phase={presence.phase} /> : null;
}

type ChatMenuSurfaceProps = Omit<ChatMenuProps, 'open'> & { readonly phase: SlidePhase };

function ChatMenuSurface({ id, label, items, placement, triggerRef, onDismiss, phase }: ChatMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, menuRef, placement);

  // Again when it reopens during its exit fade, as on a fresh open.
  const leaving = phase === 'exiting';
  useEffect(() => {
    if (leaving) return;
    const container = menuRef.current;
    const checked = container?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? itemsOf(container)[0])?.focus();
  }, [leaving]);

  useEffect(() => {
    if (phase === 'exiting') return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onDismiss(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { document.removeEventListener('pointerdown', handlePointerDown); };
  }, [onDismiss, phase, triggerRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const container = menuRef.current;
    if (dismissMenuOnKey(event, () => { onDismiss(false); }, triggerRef.current)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(container, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(container, -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusEdge(container, event.key === 'Home' ? 'first' : 'last');
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={label}
      data-placement={placement}
      onKeyDown={handleKeyDown}
      {...phaseAttributes(phase)}
      style={anchorStyle}
      className="ui-popover chat-design-menu"
    >
      {items.map((item) => (
        <MenuEntry key={item.id} item={item} />
      ))}
    </div>,
    document.body
  );
}

function MenuEntry({ item }: { readonly item: ChatMenuItem }) {
  return (
    <>
      {item.separatorBefore === true && <div role="separator" />}
      <button
        type="button"
        role={item.kind === 'option' ? 'menuitemradio' : 'menuitem'}
        {...(item.kind === 'option' ? { 'aria-checked': item.checked === true } : {})}
        {...(item.tone !== undefined ? { 'data-tone': item.tone } : {})}
        {...(item.testId !== undefined ? { 'data-testid': item.testId } : {})}
        tabIndex={-1}
        onClick={item.onSelect}
      >
        {/* Every row keeps the check slot, so action labels line up with values. */}
        <span aria-hidden="true" className="chat-design-menu-check">
          {item.kind === 'option' && item.checked === true && <AppIcon name="check" size={12} />}
        </span>
        <span className="chat-design-menu-label">{item.label}</span>
      </button>
    </>
  );
}
