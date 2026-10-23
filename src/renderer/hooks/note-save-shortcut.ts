/**
 * The keyboard shortcut that commits a note from inside its own editor.
 *
 * Three editors create or edit note text — the selection toolbar's note, the
 * reader header's location note, and the Annotations panel's inline edit — and
 * all three are the autosaving note composer, where the chord is Done: write the
 * newest text and close. The Annotations panel's bookmark label editor still
 * saves explicitly, with the same chord on its Save button. A reader who has
 * just finished typing should not have to leave the field to commit it. The chord is Cmd+Enter on macOS and Ctrl+Enter elsewhere, which
 * is what the app-level router already treats as the same command modifier
 * (`use-shortcuts.ts`), so accepting either here keeps one rule rather than a
 * per-panel dialect. Only the visible hint is platform-specific.
 *
 * The decision is a pure function so that all three editors and the focused
 * tests share exactly one definition of "this press asks for a save":
 *
 *   * The note fields are multiline. Plain Enter must keep inserting a newline,
 *     so the chord is the only press this module ever claims.
 *   * A composing IME owns Enter outright — committing a candidate must not
 *     also commit the note.
 *   * The chord is claimed (no newline) even when the save cannot run, because
 *     an empty draft or a save already in flight is a reason to do nothing, not
 *     a reason to type a newline the reader did not ask for. That same
 *     `canSave` gate is what prevents a held key or a double press from
 *     submitting twice.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export type NoteSaveShortcutKey = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  /** True while an IME is composing, which owns every key it is given. */
  readonly isComposing: boolean;
};

/**
 * What the editor should do with the press.
 *
 * `ignore` leaves the key to the textarea (plain Enter still inserts a newline);
 * `save` runs the same validation and persistence path as the Save button;
 * `claim` swallows the chord without saving.
 */
export type NoteSaveShortcutOutcome = 'ignore' | 'save' | 'claim';

/**
 * The fields this module needs, read off a React keyboard event. `isComposing`
 * lives only on the native event, which is why every editor reads the press
 * through here rather than passing the synthetic event along.
 */
function noteSaveShortcutKey(event: ReactKeyboardEvent): NoteSaveShortcutKey {
  return {
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    isComposing: event.nativeEvent.isComposing,
  };
}

/** True when this press is the save chord itself, whatever the draft holds. */
export function isNoteSaveShortcut(event: NoteSaveShortcutKey): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  return event.metaKey || event.ctrlKey;
}

/**
 * The outcome for one press, given whether the editor's Save action is
 * currently runnable — the same condition that disables the Save button, plus
 * "no save already in flight".
 */
export function noteSaveShortcutOutcome(
  event: NoteSaveShortcutKey,
  canSave: boolean,
): NoteSaveShortcutOutcome {
  if (!isNoteSaveShortcut(event)) return 'ignore';
  if (event.repeat || !canSave) return 'claim';
  return 'save';
}

/**
 * Applies the outcome to a real keydown in a note field.
 *
 * The three editors all do the same thing with it — leave an unclaimed press to
 * the textarea, swallow the chord, and run the editor's own save when it can
 * run — so the branching lives here once rather than in each `onKeyDown`.
 */
export function handleNoteSaveShortcut(
  event: ReactKeyboardEvent,
  canSave: boolean,
  save: () => void,
): void {
  const outcome = noteSaveShortcutOutcome(noteSaveShortcutKey(event), canSave);
  // Plain Enter is never claimed, so the field stays multiline.
  if (outcome === 'ignore') return;
  event.preventDefault();
  event.stopPropagation();
  if (outcome === 'save') save();
}

/**
 * The short visible hint for the chord.
 *
 * Written the way `src/shared/constants/shortcuts.ts` writes every other one,
 * naming both modifiers rather than guessing the platform: the chord genuinely
 * accepts either, and the only ways a renderer can tell macOS apart are the
 * deprecated `navigator.platform` or a user-agent sniff.
 */
export const NOTE_SAVE_SHORTCUT_HINT = '⌘/Ctrl + ↵ to save';

/** The same chord, shown inside the note composer's Done button. */
export const NOTE_DONE_SHORTCUT_HINT = '⌘/Ctrl ↵';
