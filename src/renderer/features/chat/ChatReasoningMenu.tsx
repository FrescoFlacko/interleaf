import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { REASONING_EFFORT_LABELS } from '@shared/constants/reasoning';
import type { ReasoningEffort } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import type { PickerRow } from './model-picker-options';
import { submenuPosition, type SubmenuSide } from './reasoning-submenu-geometry';

/** Short, fixed hints; a level without one is self-explanatory. */
const LEVEL_HINTS: Partial<Record<ReasoningEffort | 'default', string>> = {
  default: 'Model decides',
  low: 'Fastest',
  high: 'More thorough',
  xhigh: 'Slower',
  max: 'Slowest',
};

type Level = { readonly effort: ReasoningEffort | null; readonly label: string; readonly hint: string | null };

function levelsFor(row: PickerRow): readonly Level[] {
  const offered = row.reasoning?.levels ?? [];
  return [
    { effort: null, label: 'Default', hint: LEVEL_HINTS.default ?? null },
    ...offered.map((effort) => ({ effort, label: REASONING_EFFORT_LABELS[effort], hint: LEVEL_HINTS[effort] ?? null })),
  ];
}

type ReasoningLevelsProps = {
  readonly row: PickerRow;
  /** The level saved for this row, when it is the bound one; else nothing is checked. */
  readonly checked: ReasoningEffort | null | undefined;
  /** Move focus into the list as it opens: it was opened from the keyboard. */
  readonly autoFocus: boolean;
  readonly onChoose: (effort: ReasoningEffort | null) => void;
  /** One layer back: to the row, keeping the picker open. */
  readonly onBack: () => void;
};

function levelItems(list: HTMLElement | null): HTMLElement[] {
  return [...(list?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
}

/**
 * One model's reasoning levels, as a menu of radio items with Default first.
 * Only levels main published for this exact model are listed.
 *
 * The roving focus belongs to one row: another model's levels start again on
 * their own checked level, or Default, never on the previous model's index.
 */
function ReasoningLevels({ row, checked, autoFocus, onChoose, onBack }: ReasoningLevelsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const levels = levelsFor(row);
  const initial = Math.max(0, levels.findIndex((level) => level.effort === (checked ?? null)));
  const [roving, setRoving] = useState({ key: row.key, index: initial });
  const currentIndex = roving.key === row.key ? Math.min(roving.index, levels.length - 1) : initial;

  useEffect(() => {
    if (autoFocus) levelItems(listRef.current)[initial]?.focus();
  }, [autoFocus, initial, row.key]);

  const focusAt = (index: number): void => {
    const next = (index + levels.length) % levels.length;
    setRoving({ key: row.key, index: next });
    levelItems(listRef.current)[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Keys act on the level that actually holds focus.
    const held = levelItems(listRef.current).findIndex((item) => item === event.target);
    const from = held === -1 ? currentIndex : held;
    const moves: Partial<Record<string, number>> = {
      ArrowDown: from + 1, ArrowUp: from - 1, Home: 0, End: levels.length - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      focusAt(target);
    } else if (event.key === 'Enter' || event.key === ' ') {
      const level = levels[from];
      if (level !== undefined) onChoose(level.effort);
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape' || event.key === 'Tab') {
      onBack();
    } else {
      return;
    }
    // Handled here only: the picker around it must not also act on the key.
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      {/* The menu's own name says this, with the model, for assistive technology. */}
      <div aria-hidden="true" className="chat-reasoning-heading">Reasoning effort</div>
      <div
        ref={listRef}
        role="menu"
        aria-label={`Reasoning effort for ${row.name}`}
        data-testid="chat-reasoning-menu"
        onKeyDown={handleKeyDown}
        className="chat-reasoning-levels"
      >
        {levels.map((level, index) => (
          <div
            key={level.effort ?? 'default'}
            role="menuitemradio"
            aria-checked={checked !== undefined && level.effort === checked}
            tabIndex={index === currentIndex ? 0 : -1}
            data-effort={level.effort ?? 'default'}
            className="chat-reasoning-level"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => { onChoose(level.effort); }}
          >
            <span aria-hidden="true" className="chat-model-picker-check">
              {checked !== undefined && level.effort === checked && <AppIcon name="check" size={12} />}
            </span>
            <span className="chat-reasoning-level-label">{level.label}</span>
            {level.hint !== null && <span className="chat-reasoning-level-hint">{level.hint}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

type FlyoutProps = ReasoningLevelsProps & {
  readonly side: Exclude<SubmenuSide, 'nested'>;
  readonly flyoutRef: RefObject<HTMLDivElement | null>;
  readonly pickerRef: RefObject<HTMLElement | null>;
  readonly rowElementId: string;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
};

/**
 * The levels beside the picker, portalled to the viewport so the picker's own
 * clipping cannot cut them off. They sit level with their row, on the side
 * that has room, and never over the picker.
 */
export function ChatReasoningFlyout({ side, flyoutRef, pickerRef, rowElementId, onPointerEnter, onPointerLeave, ...levels }: FlyoutProps) {
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const picker = pickerRef.current?.getBoundingClientRect();
      const row = document.getElementById(rowElementId)?.getBoundingClientRect();
      const height = flyoutRef.current?.offsetHeight ?? 0;
      if (picker === undefined || row === undefined) return;
      setPosition(submenuPosition(side, picker, row, height, window.innerHeight));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [side, pickerRef, flyoutRef, rowElementId]);

  return createPortal(
    <div
      ref={flyoutRef}
      data-testid="chat-reasoning-flyout"
      data-side={side}
      className="chat-reasoning-flyout"
      style={position === null ? { visibility: 'hidden' } : { left: `${String(position.left)}px`, top: `${String(position.top)}px` }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/* Focus waits until the levels are placed: a hidden element cannot take it. */}
      <ReasoningLevels {...levels} autoFocus={levels.autoFocus && position !== null} />
    </div>,
    document.body
  );
}

/** The narrow fallback: the levels in place of the list, under a Back row. */
export function NestedReasoningLevels(props: ReasoningLevelsProps) {
  return (
    <div
      data-testid="chat-reasoning-nested"
      className="chat-reasoning-nested"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.onBack();
      }}
    >
      <button type="button" aria-label={`${props.row.name}, back to models`} className="chat-reasoning-back" onClick={props.onBack}>
        <AppIcon name="back" size={12} />
        <span className="chat-reasoning-back-label">{props.row.name}</span>
      </button>
      <ReasoningLevels {...props} />
    </div>
  );
}
