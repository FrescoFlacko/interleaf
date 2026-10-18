import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ReasoningEffort } from '@shared/types/ai';
import { ChatReasoningFlyout, NestedReasoningLevels } from './ChatReasoningMenu';
import type { PickerRow } from './model-picker-options';
import { useReasoningSubmenu, type ReasoningSubmenu } from './use-reasoning-submenu';

/** The picker's open levels, and the row actions that open, close or commit them. */
export type PickerLevels = {
  readonly submenu: ReasoningSubmenu;
  /** The listed row whose levels are open, if any. */
  readonly row: PickerRow | null;
  /** The levels replace the list in place, for want of room beside it. */
  readonly nested: boolean;
  /** Back one layer, to the row, with the search field holding focus again. */
  readonly close: () => void;
  /** A row with levels opens them; any other row is chosen as it is. */
  readonly activate: (row: PickerRow, fromKeyboard: boolean) => void;
  readonly hover: (row: PickerRow, event: ReactPointerEvent<HTMLDivElement>) => void;
};

type PickerLevelsInput = {
  readonly rows: readonly PickerRow[];
  readonly popupRef: RefObject<HTMLElement | null>;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly anchor: Pick<CSSProperties, 'left' | 'top'>;
  readonly setActiveKey: (key: string) => void;
  readonly onChoose: (row: PickerRow, effort: ReasoningEffort | null) => void;
};

function levelsKey(row: PickerRow): string | null {
  return row.reasoning === null || row.unavailable ? null : row.key;
}

export function usePickerLevels({ rows, popupRef, searchRef, anchor, setActiveKey, onChoose }: PickerLevelsInput): PickerLevels {
  const submenu = useReasoningSubmenu(popupRef, anchor);
  const openKey = submenu.open?.key;
  const row = rows.find((candidate) => candidate.key === openKey) ?? null;

  const close = (): void => {
    if (row !== null) setActiveKey(row.key);
    submenu.close();
    searchRef.current?.focus();
  };

  const activate = (target: PickerRow, fromKeyboard: boolean): void => {
    if (target.unavailable) return;
    if (target.reasoning === null) {
      onChoose(target, null);
      return;
    }
    setActiveKey(target.key);
    submenu.show(target.key, { pinned: true, focusLevels: fromKeyboard });
  };

  const hover = (target: PickerRow, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!target.unavailable) setActiveKey(target.key);
    submenu.intent.rowPointerMove(levelsKey(target), event);
  };

  return { submenu, row, nested: submenu.side === 'nested' && row !== null, close, activate, hover };
}

type PickerLevelsProps = {
  readonly levels: PickerLevels;
  /** Where these levels render: in place of the list, or beside it. */
  readonly placement: 'nested' | 'beside';
  readonly popupRef: RefObject<HTMLDivElement | null>;
  readonly rowElementId: (row: PickerRow) => string;
  readonly selectedKey: string | null;
  readonly selectedEffort: ReasoningEffort | null;
  /** The picker is leaving, so nothing new opens beside it. */
  readonly leaving: boolean;
  readonly onChoose: (row: PickerRow, effort: ReasoningEffort | null) => void;
};

/** The open row's levels, when they belong at this placement. */
export function ChatModelPickerLevels({ levels, placement, popupRef, rowElementId, selectedKey, selectedEffort, leaving, onChoose }: PickerLevelsProps) {
  const { submenu, row } = levels;
  if (row === null || levels.nested !== (placement === 'nested')) return null;
  const common = {
    row,
    checked: row.key === selectedKey ? selectedEffort : undefined,
    onChoose: (effort: ReasoningEffort | null) => { onChoose(row, effort); },
    onBack: levels.close,
  };
  if (placement === 'nested') return <NestedReasoningLevels {...common} autoFocus />;
  if (leaving || submenu.side === 'nested') return null;
  return (
    <ChatReasoningFlyout
      {...common}
      side={submenu.side}
      flyoutRef={submenu.flyoutRef}
      pickerRef={popupRef}
      rowElementId={rowElementId(row)}
      autoFocus={submenu.open?.focusLevels === true}
      onPointerEnter={submenu.intent.submenuPointerEnter}
      onPointerLeave={submenu.intent.submenuPointerLeave}
    />
  );
}
