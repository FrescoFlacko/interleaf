import type { ReactNode } from 'react';

/** One choice in a `Select`. */
export type SelectOption<V extends string = string> = {
  readonly value: V;
  readonly label: string;
  /** Secondary line drawn under the label inside the open list only. */
  readonly description?: string;
  /** Shown, announced and skipped by the keyboard, but never chosen. */
  readonly disabled?: boolean;
  /** Decorative chip drawn after the label in the list and the trigger. */
  readonly badge?: ReactNode;
  /** Decorative mark (a swatch) drawn before the label in the open list. */
  readonly leading?: ReactNode;
};

/** What a key press on the trigger means, given whether the list is open. */
export type SelectKeyAction =
  | 'open-current'
  | 'open-first'
  | 'open-last'
  | 'next'
  | 'previous'
  | 'page-down'
  | 'page-up'
  | 'first'
  | 'last'
  | 'commit'
  /** Tab: choose the highlighted option and let focus move on as usual. */
  | 'commit-and-leave'
  | 'close'
  | 'typeahead'
  | 'none';

const CLOSED_KEYS: Readonly<Record<string, SelectKeyAction>> = {
  ArrowDown: 'open-current',
  ArrowUp: 'open-current',
  Enter: 'open-current',
  ' ': 'open-current',
  Home: 'open-first',
  End: 'open-last',
};

const OPEN_KEYS: Readonly<Record<string, SelectKeyAction>> = {
  ArrowDown: 'next',
  ArrowUp: 'previous',
  PageDown: 'page-down',
  PageUp: 'page-up',
  Home: 'first',
  End: 'last',
  Enter: 'commit',
  ' ': 'commit',
  Escape: 'close',
  Tab: 'commit-and-leave',
};

/** A single printable character, without a command modifier, starts typeahead. */
function isPrintable(key: string, modified: boolean): boolean {
  return key.length === 1 && key !== ' ' && !modified;
}

/**
 * Keyboard map of the WAI-ARIA select-only combobox: arrows, Enter or Space
 * open the list on the current value; inside it, arrows, Page keys, Home and
 * End move the active option, Enter or Space choose it, Tab chooses it and
 * moves focus on (Shift+Tab back), and Escape closes without changing the
 * value. Alt+ArrowUp chooses and closes, as on
 * the platform. A printable key jumps to the next option starting with it.
 */
export function selectKeyAction(key: string, open: boolean, modifiers: { readonly alt: boolean; readonly command: boolean; readonly typing: boolean }): SelectKeyAction {
  if (open && modifiers.alt && key === 'ArrowUp') return 'commit';
  if (open && modifiers.typing && key === ' ') return 'typeahead';
  if (isPrintable(key, modifiers.command)) return 'typeahead';
  return (open ? OPEN_KEYS : CLOSED_KEYS)[key] ?? 'none';
}

/**
 * The enabled option `step` positions away from `from`, stopping at the ends
 * of the list rather than wrapping (as a native select does). When every option
 * in that direction is disabled, the position does not move.
 */
export function stepEnabled(options: readonly SelectOption[], from: number, step: number): number {
  const direction = Math.sign(step) || 1;
  let found = from;
  let remaining = Math.abs(step);
  for (let index = from + direction; index >= 0 && index < options.length && remaining > 0; index += direction) {
    if (options[index]?.disabled === true) continue;
    found = index;
    remaining -= 1;
  }
  return found;
}

export function edgeEnabled(options: readonly SelectOption[], edge: 'first' | 'last'): number {
  return edge === 'first' ? stepEnabled(options, -1, 1) : stepEnabled(options, options.length, -1);
}

/**
 * Index of the next enabled option, after `from`, whose label starts with the
 * typed text. Repeating one letter cycles through the options that share it.
 */
export function typeaheadIndex(options: readonly SelectOption[], query: string, from: number): number {
  const needle = query.toLocaleLowerCase();
  const repeated = needle.length > 1 && needle.replaceAll(needle.charAt(0), '') === '';
  const prefix = repeated ? needle.slice(0, 1) : needle;
  const start = repeated || needle.length === 1 ? from + 1 : from;
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset) % options.length;
    const option = options[index];
    if (option !== undefined && option.disabled !== true && option.label.toLocaleLowerCase().startsWith(prefix)) return index;
  }
  return from;
}
