/**
 * Prompt-history traversal for the companion composers.
 *
 * AI Chat and Agent both hold a multiline prompt field, and both are places a
 * reader repeats and adjusts an earlier instruction. The rules for walking
 * back through what was already sent are identical in the two panels, so they
 * are written once, here, as pure functions: the hook that owns the React
 * state and the focused tests both use exactly this logic, and neither panel
 * can drift into its own dialect of the same shortcut.
 *
 * Two decisions are deliberate:
 *
 *   * ArrowUp and ArrowDown keep their ordinary meaning inside the text. The
 *     field is multiline, so history is entered only at the boundary where the
 *     key would otherwise do nothing — the caret on the first line for
 *     ArrowUp, on the last line for ArrowDown — and only with no modifier held
 *     and no selection open. A composing IME owns the arrow keys outright.
 *   * The in-progress draft is a separate thing from the history. It is put
 *     aside on the way back and restored on the way forward past the newest
 *     entry, so walking the list and returning never costs the reader the text
 *     they had not sent yet.
 */

/** Where traversal currently stands. `index` is `null` while the reader is
 * editing their own draft rather than looking at a past prompt. */
export type PromptHistoryState = {
  /** Index into the entries array, oldest first; `null` when not navigating. */
  readonly index: number | null;
  /** The unsent draft set aside when traversal began. */
  readonly draft: string;
};

export const IDLE_PROMPT_HISTORY: PromptHistoryState = { index: null, draft: '' };

export type PromptHistoryDirection = 'previous' | 'next';

/** The field's state at the moment a key was pressed. */
export type PromptHistoryCaret = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

export type PromptHistoryKey = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** True while an IME is composing, which owns every key it is given. */
  readonly isComposing: boolean;
};

/**
 * The direction this key press asks for, or `null` when the field should keep
 * the key. A press with any modifier, an open selection, an active
 * composition, or a caret with more lines to move through is not a history
 * request.
 */
export function promptHistoryDirection(
  event: PromptHistoryKey,
  caret: PromptHistoryCaret,
): PromptHistoryDirection | null {
  if (event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (caret.selectionStart !== caret.selectionEnd) return null;
  if (event.key === 'ArrowUp') {
    return caret.value.slice(0, caret.selectionStart).includes('\n') ? null : 'previous';
  }
  if (event.key === 'ArrowDown') {
    return caret.value.slice(caret.selectionEnd).includes('\n') ? null : 'next';
  }
  return null;
}

/**
 * The prompts a composer offers, oldest first.
 *
 * Recall hands back exactly what was submitted. A prompt is often code or
 * indented text, where leading whitespace is the content, so trimming is used
 * only to decide whether a submission was blank — never to rewrite one. An
 * immediately repeated prompt collapses to one entry, compared by the exact
 * stored value, so a reader who sent the same instruction twice does not press
 * ArrowUp twice to get past it while two genuinely different indentations stay
 * two entries.
 */
export function promptHistoryEntries(submitted: readonly string[]): readonly string[] {
  const entries: string[] = [];
  for (const prompt of submitted) {
    if (prompt.trim().length === 0) continue;
    if (entries.at(-1) === prompt) continue;
    entries.push(prompt);
  }
  return entries;
}

/**
 * The traversal scope for a composer whose subject may be absent — the Agent
 * task field with no document open, for instance. Absence is a scope of its
 * own, so opening a document starts the reader on a clean history rather than
 * resuming one from nowhere.
 */
export function promptHistoryScope(subject: { readonly id: string } | null): string {
  return subject === null ? 'no-subject' : subject.id;
}

export type PromptHistoryStep = {
  readonly state: PromptHistoryState;
  /** What the field should now contain. */
  readonly value: string;
};

/**
 * One step through the history, or `null` when there is nowhere to go — an
 * empty history, the oldest entry already shown, or a forward step while the
 * reader is already on their own draft. A `null` step is not handled, so the
 * key keeps its ordinary behaviour instead of being silently swallowed.
 */
export function stepPromptHistory(
  entries: readonly string[],
  state: PromptHistoryState,
  direction: PromptHistoryDirection,
  currentValue: string,
): PromptHistoryStep | null {
  if (direction === 'previous') {
    if (entries.length === 0) return null;
    if (state.index === null) {
      const index = entries.length - 1;
      return { state: { index, draft: currentValue }, value: entries[index] ?? '' };
    }
    if (state.index <= 0) return null;
    const index = state.index - 1;
    return { state: { ...state, index }, value: entries[index] ?? '' };
  }
  if (state.index === null) return null;
  if (state.index >= entries.length - 1) {
    // Past the newest entry is the draft the reader was writing, exactly as
    // they left it.
    return { state: IDLE_PROMPT_HISTORY, value: state.draft };
  }
  const index = state.index + 1;
  return { state: { ...state, index }, value: entries[index] ?? '' };
}

/**
 * How traversal reconciles with a change the reader made themselves.
 *
 * Typing into a recalled prompt makes it their text rather than a position in
 * the list, so traversal ends there: the next ArrowUp starts again from the
 * newest entry, which is predictable, and the alternative — silently replacing
 * what they just edited on the next keypress — is not. A value that still
 * matches the entry on screen (a caret move, a re-render) changes nothing.
 */
export function reconcilePromptHistory(
  entries: readonly string[],
  state: PromptHistoryState,
  value: string,
): PromptHistoryState {
  if (state.index === null) return state;
  return entries[state.index] === value ? state : IDLE_PROMPT_HISTORY;
}
