import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { REASONING_EFFORT_LABELS } from '@shared/constants/reasoning';
import type { ReasoningEffort } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { phaseAttributes } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import type { SlidePhase } from '../../components/slide-presence';
import type { ProviderDiscoveryState } from '../../stores/use-chat-store';
import { ChatModelPickerLevels, usePickerLevels } from './ChatModelPickerLevels';
import { filterGroups, flatRows, type PickerGroup, type PickerRow } from './model-picker-options';
import type { OpenRouterCatalogState } from './use-openrouter-catalog';

export const MODEL_PICKER_POPOVER_ID = 'chat-model-picker-popover';
const LISTBOX_ID = 'chat-model-picker-listbox';
const LEVELS_HINT_ID = 'chat-model-picker-levels-hint';

type ChatModelPickerPopoverProps = {
  readonly phase: SlidePhase;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly groups: readonly PickerGroup[];
  /** The key of the row the conversation is bound to, when it is listed. */
  readonly selectedKey: string | null;
  /** The level saved with the bound row; `null` is Default. */
  readonly selectedEffort: ReasoningEffort | null;
  readonly discovery: ProviderDiscoveryState;
  /** Set when the bound provider is not ready: names it, so the reader knows why. */
  readonly unavailableProvider: string | null;
  /** OpenRouter's listing, when OpenRouter is one of the groups. */
  readonly catalog: { readonly state: OpenRouterCatalogState; readonly error: string | null } | null;
  readonly onRetryCatalog: () => void;
  /** The model and its level, committed together. */
  readonly onChoose: (row: PickerRow, effort: ReasoningEffort | null) => void;
  readonly onManageProviders: () => void;
  readonly onDismiss: (restoreFocus: boolean) => void;
};

function optionId(row: PickerRow): string {
  return `chat-model-option-${row.key}`;
}

/**
 * The searchable, grouped model list: a combobox field over a listbox, so the
 * caret stays in the field while the arrows move the active option.
 *
 * A row whose model publishes reasoning levels opens them in a menu beside the
 * list — on hover, on a click (which pins it), or with ArrowRight or Enter
 * (which moves focus into it). Only choosing a level commits, and it commits
 * the model with it. Without room beside the list the levels open in place.
 */
export function ChatModelPickerPopover({
  phase,
  triggerRef,
  groups,
  selectedKey,
  selectedEffort,
  discovery,
  unavailableProvider,
  catalog,
  onRetryCatalog,
  onChoose,
  onManageProviders,
  onDismiss,
}: ChatModelPickerPopoverProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, popupRef, 'top');
  const [query, setQuery] = useState('');
  const visible = filterGroups(groups, query);
  const rows = flatRows(visible);
  const [activeKey, setActiveKey] = useState<string | null>(selectedKey);
  const active = activeRow(rows, activeKey);
  const levels = usePickerLevels({ rows, popupRef, searchRef, anchor: anchorStyle, setActiveKey, onChoose });
  const { submenu, nested } = levels;

  const leaving = phase === 'exiting';
  useEffect(() => {
    if (!leaving) searchRef.current?.focus();
  }, [leaving]);

  useEffect(() => {
    if (active === null) return;
    listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (leaving) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (submenu.flyoutRef.current?.contains(target)) return;
      onDismiss(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { document.removeEventListener('pointerdown', handlePointerDown); };
  }, [leaving, onDismiss, triggerRef, submenu.flyoutRef]);

  const move = (step: number | 'first' | 'last'): void => {
    const choosable = rows.filter((row) => !row.unavailable);
    if (choosable.length === 0) return;
    const index = active === null ? -1 : choosable.indexOf(active);
    setActiveKey(choosable[nextIndex(step, index, choosable.length)]?.key ?? null);
  };

  const handleSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const steps: Partial<Record<string, number | 'first' | 'last'>> = {
      ArrowDown: 1, ArrowUp: -1, PageDown: 'last', PageUp: 'first',
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      submenu.close();
      move(step);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active !== null) levels.activate(active, true);
    } else if (event.key === 'ArrowRight' && opensLevels(active, event.currentTarget)) {
      event.preventDefault();
      levels.activate(active, true);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Closes one layer only — open levels, then this list; the drawer and
      // dialogs around it never see it.
      event.preventDefault();
      event.stopPropagation();
      if (submenu.open === null) onDismiss(true);
      else levels.close();
      return;
    }
    if (event.key === 'Tab') trapTab(event, popupRef.current);
  };

  const view = listView(rows, active, nested, pickerEmptyMessage(discovery, groups.length, rows.length, query));

  return createPortal(
    <div
      ref={popupRef}
      id={MODEL_PICKER_POPOVER_ID}
      data-testid={MODEL_PICKER_POPOVER_ID}
      role="dialog"
      aria-label="Choose AI model"
      onKeyDown={handleKeyDown}
      {...phaseAttributes(phase)}
      style={anchorStyle}
      className="ui-popover chat-model-picker"
    >
      {unavailableProvider !== null && (
        <p data-testid="chat-model-picker-unavailable" className="chat-model-picker-notice">
          {unavailableProvider} is not ready. Choose another model, or fix it in Settings.
        </p>
      )}
      <div className="chat-model-picker-search">
        <AppIcon name="search" size={14} />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-label="Search models and providers"
          aria-expanded={view.listed}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={view.activeDescendant}
          placeholder="Search models"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveKey(null); }}
          onKeyDown={handleSearchKey}
        />
      </div>
      <ChatModelPickerLevels
        placement="nested"
        levels={levels}
        popupRef={popupRef}
        rowElementId={optionId}
        selectedKey={selectedKey}
        selectedEffort={selectedEffort}
        leaving={leaving}
        onChoose={onChoose}
      />
      {view.listed && (
        <div
          ref={listRef}
          id={LISTBOX_ID}
          role="listbox"
          aria-label="AI models"
          className="chat-model-picker-list"
          onPointerLeave={submenu.intent.listPointerLeave}
        >
          {visible.map((group) => (
            <div key={group.providerId} role="group" aria-labelledby={`chat-model-group-${group.providerId}`}>
              <div id={`chat-model-group-${group.providerId}`} role="presentation" className="chat-model-picker-group">
                {group.label}
              </div>
              {group.rows.map((row) => (
                <PickerOption
                  key={row.key}
                  row={row}
                  selected={row.key === selectedKey}
                  levelLabel={row.key === selectedKey ? effortLabel(selectedEffort) : null}
                  active={row.key === active?.key}
                  expanded={submenu.open?.key === row.key}
                  onHover={(event) => { levels.hover(row, event); }}
                  onChoose={() => { levels.activate(row, false); }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <span id={LEVELS_HINT_ID} className="sr-only">Has reasoning levels. Press Right Arrow to choose one.</span>
      <ChatModelPickerLevels
        placement="beside"
        levels={levels}
        popupRef={popupRef}
        rowElementId={optionId}
        selectedKey={selectedKey}
        selectedEffort={selectedEffort}
        leaving={leaving}
        onChoose={onChoose}
      />
      {view.emptyMessage !== null && <p role="status" className="chat-model-picker-empty">{view.emptyMessage}</p>}
      {catalog?.state === 'loading' && (
        <p role="status" data-testid="chat-model-picker-loading" className="chat-model-picker-status">
          <AppIcon name="busy" size={12} className="animate-spin motion-reduce:animate-none" />
          Loading OpenRouter models…
        </p>
      )}
      {catalog?.state === 'error' && (
        <div role="alert" data-testid="chat-model-picker-catalog-error" className="chat-model-picker-status" data-tone="error">
          <span>Couldn’t load OpenRouter models.</span>
          <button type="button" onClick={onRetryCatalog}>Retry</button>
        </div>
      )}
      <div className="chat-model-picker-footer">
        <button type="button" data-testid="chat-provider-edit" onClick={onManageProviders}>
          <AppIcon name="display-settings" size={14} />
          Manage providers…
        </button>
      </div>
    </div>,
    document.body
  );
}

/** The highlighted option, else the first choosable one. */
function activeRow(rows: readonly PickerRow[], activeKey: string | null): PickerRow | null {
  return rows.find((row) => row.key === activeKey) ?? rows.find((row) => !row.unavailable) ?? null;
}

type ListView = {
  readonly listed: boolean;
  readonly activeDescendant: string | undefined;
  readonly emptyMessage: string | null;
};

/** What the list area shows; levels opened in place replace all of it. */
function listView(rows: readonly PickerRow[], active: PickerRow | null, nested: boolean, emptyMessage: string | null): ListView {
  if (nested) return { listed: false, activeDescendant: undefined, emptyMessage: null };
  return { listed: rows.length > 0, activeDescendant: active === null ? undefined : optionId(active), emptyMessage };
}

function pickerEmptyMessage(discovery: ProviderDiscoveryState, groupCount: number, rowCount: number, query: string): string | null {
  if (rowCount > 0) return null;
  if (groupCount > 0) return `No models match “${query.trim()}”.`;
  if (discovery === 'loading') return 'Checking AI providers…';
  if (discovery === 'failed') return 'Couldn’t check AI providers.';
  return 'No AI provider is ready.';
}

/** The option after `index` by `step`, wrapping; with none active, the first or last. */
function nextIndex(step: number | 'first' | 'last', index: number, length: number): number {
  if (step === 'first') return 0;
  if (step === 'last') return length - 1;
  if (index !== -1) return (index + step + length) % length;
  return step > 0 ? 0 : length - 1;
}

/** ArrowRight opens levels only at the end of the query, so the caret can still move through it. */
function opensLevels(active: PickerRow | null, input: HTMLInputElement): active is PickerRow {
  if (active?.reasoning == null) return false;
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

function effortLabel(effort: ReasoningEffort | null): string | null {
  return effort === null ? null : REASONING_EFFORT_LABELS[effort];
}

/** Keeps Tab cycling within the picker. */
function trapTab(event: ReactKeyboardEvent<HTMLDivElement>, popup: HTMLDivElement | null): void {
  const focusable = [...(popup?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
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

type PickerOptionProps = {
  readonly row: PickerRow;
  readonly selected: boolean;
  /** The saved level, on the bound row only. */
  readonly levelLabel: string | null;
  readonly active: boolean;
  /** Its levels are open beside the list. */
  readonly expanded: boolean;
  readonly onHover: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onChoose: () => void;
};

/** A boolean data attribute: present as `true`, else absent. */
function dataFlag(on: boolean): 'true' | undefined {
  return on ? 'true' : undefined;
}

function PickerOption({ row, selected, levelLabel, active, expanded, onHover, onChoose }: PickerOptionProps) {
  const hasLevels = row.reasoning !== null;
  return (
    <div
      id={optionId(row)}
      role="option"
      aria-selected={selected}
      aria-disabled={row.unavailable || undefined}
      aria-describedby={hasLevels ? LEVELS_HINT_ID : undefined}
      data-active={dataFlag(active)}
      data-expanded={dataFlag(expanded)}
      data-has-levels={dataFlag(hasLevels)}
      data-model-id={row.modelId}
      data-provider-id={row.providerId}
      className="chat-model-picker-option"
      // The field keeps focus, so the active option stays announced through it.
      onMouseDown={(event) => { event.preventDefault(); }}
      onPointerMove={onHover}
      onClick={onChoose}
    >
      <span aria-hidden="true" className="chat-model-picker-check">
        {selected && <AppIcon name="check" size={12} />}
      </span>
      <span className="chat-model-picker-text">
        <span className="chat-model-picker-name">{row.name}</span>
        {row.detail !== null && <span className="chat-model-picker-id">{row.detail}</span>}
      </span>
      {row.unavailable && <span className="chat-model-picker-badge">Unavailable</span>}
      {levelLabel !== null && <span className="chat-model-picker-level">{levelLabel}</span>}
      {hasLevels && <AppIcon name="submenu" size={12} className="chat-model-picker-chevron" />}
    </div>
  );
}
