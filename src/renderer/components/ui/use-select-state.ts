import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { edgeEnabled, selectKeyAction, stepEnabled, typeaheadIndex, type SelectKeyAction, type SelectOption } from './select-model';

/** Typed characters within this window extend one typeahead query. */
const TYPEAHEAD_MS = 500;
const PAGE = 10;

type SelectStateInput<V extends string> = {
  readonly value: V;
  readonly options: readonly SelectOption<V>[];
  readonly onValueChange: (value: V) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
};

export type SelectState = {
  readonly open: boolean;
  readonly active: number;
  readonly minWidth: number;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly setActive: (index: number) => void;
  readonly commit: (index: number) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/** Open state, active option, typeahead and keyboard handling of a `Select`. */
export function useSelectState<V extends string>({ value, options, onValueChange, triggerRef }: SelectStateInput<V>): SelectState {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [minWidth, setMinWidth] = useState(0);
  const typed = useRef({ query: '', at: 0 });
  const selectedIndex = options.findIndex((option) => option.value === value);

  const show = useCallback((index: number): void => {
    setMinWidth(triggerRef.current?.offsetWidth ?? 0);
    setActive(index);
    setOpen(true);
  }, [triggerRef]);

  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  const commit = useCallback((index: number): void => {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    setOpen(false);
    if (option.value !== value) onValueChange(option.value);
  }, [onValueChange, options, value]);

  const current = selectedIndex >= 0 ? selectedIndex : edgeEnabled(options, 'first');

  const typeahead = (key: string): number => {
    const now = Date.now();
    const query = now - typed.current.at < TYPEAHEAD_MS ? typed.current.query + key : key;
    typed.current = { query, at: now };
    return typeaheadIndex(options, query, open ? active : current);
  };

  const moves: Partial<Record<SelectKeyAction, () => void>> = {
    'open-current': () => { show(current); },
    'open-first': () => { show(edgeEnabled(options, 'first')); },
    'open-last': () => { show(edgeEnabled(options, 'last')); },
    next: () => { setActive(stepEnabled(options, active, 1)); },
    previous: () => { setActive(stepEnabled(options, active, -1)); },
    'page-down': () => { setActive(stepEnabled(options, active, PAGE)); },
    'page-up': () => { setActive(stepEnabled(options, active, -PAGE)); },
    first: () => { setActive(edgeEnabled(options, 'first')); },
    last: () => { setActive(edgeEnabled(options, 'last')); },
    commit: () => { commit(active); },
    close,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const typing = Date.now() - typed.current.at < TYPEAHEAD_MS;
    const action = selectKeyAction(event.key, open, { alt: event.altKey, command: event.ctrlKey || event.metaKey, typing });
    if (action === 'none') return;
    if (action === 'commit-and-leave') {
      // Tab is not consumed: the browser moves focus from the trigger as usual.
      // A disabled highlight is never chosen; the list just closes.
      commit(active);
      close();
      return;
    }
    event.preventDefault();
    // Escape closes this list, not the dialog that contains it.
    event.stopPropagation();
    if (action === 'typeahead') {
      show(typeahead(event.key));
      return;
    }
    moves[action]?.();
  };

  // The active option follows the keyboard into view.
  useEffect(() => {
    if (!open || active < 0) return;
    const list = triggerRef.current?.getAttribute('aria-controls');
    const option = list === null || list === undefined ? null : document.getElementById(list)?.children.item(active);
    option?.scrollIntoView({ block: 'nearest' });
  }, [active, open, triggerRef]);

  const toggle = (): void => {
    if (open) close();
    else show(current);
  };

  return { open, active, minWidth, toggle, close, setActive, commit, handleKeyDown };
}
