import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import {
  IDLE_PROMPT_HISTORY,
  promptHistoryDirection,
  promptHistoryEntries,
  reconcilePromptHistory,
  stepPromptHistory,
  type PromptHistoryState,
} from './prompt-history';

type UsePromptHistoryOptions = {
  /** Previously submitted prompts, oldest first. */
  readonly submitted: readonly string[];
  /** Applies a recalled prompt, or the restored draft, to the field. */
  readonly onValueChange: (value: string) => void;
  /**
   * Identity of the conversation or run this composer belongs to. When it
   * changes — a different chat session, a resumed run, a new document — the
   * reader is somewhere else, so traversal starts over rather than continuing
   * from a position in a list that is no longer on screen.
   */
  readonly resetKey: string;
};

/** A recall whose caret still has to be placed once its text is on screen. */
type PendingCaret = {
  readonly field: HTMLTextAreaElement;
  readonly value: string;
};

export type PromptHistory = {
  /** Wire as the field's `onKeyDown`; handled presses are prevented. */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Call once the field's text has been submitted, so the next ArrowUp starts
   * from the newest entry rather than from where traversal left off. */
  readonly reset: () => void;
};

/**
 * ArrowUp/ArrowDown traversal of previously submitted prompts, shared by the
 * AI Chat and Agent composers. The rules live in `prompt-history.ts`; this
 * holds the position, restores the caret, and keeps the position honest when
 * the reader edits the recalled text or moves to another session.
 *
 * The position is held in a ref rather than in state because nothing renders
 * from it: the field already shows where traversal stands, and a re-render per
 * arrow key would be a re-render of the whole panel for nothing.
 *
 * The caret is placed in the commit that puts the recalled text in the field,
 * not in a later animation frame. A frame could fire after the reader had
 * already typed, selected, left the field or moved to another run, and would
 * then drag their caret back to where an old recall ended. Placement here
 * happens before the browser handles any further input, applies only to the
 * field and text that recall produced, and is dropped in every other case.
 */
export function usePromptHistory({ submitted, onValueChange, resetKey }: UsePromptHistoryOptions): PromptHistory {
  const position = useRef<PromptHistoryState>(IDLE_PROMPT_HISTORY);
  const entries = promptHistoryEntries(submitted);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pendingCaret = useRef<PendingCaret | null>(null);

  // Runs after every commit of the composer, so the recalled text is already
  // in the field. A pending caret lives for exactly one commit.
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    pendingCaret.current = null;
    if (pending !== null) placeCaretAtEnd(pending);
  });

  useEffect(() => {
    position.current = IDLE_PROMPT_HISTORY;
    pendingCaret.current = null;
  }, [resetKey]);

  const reset = useCallback(() => {
    position.current = IDLE_PROMPT_HISTORY;
    pendingCaret.current = null;
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget;
    const value = field.value;
    const direction = promptHistoryDirection(
      {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        value,
        selectionStart: field.selectionStart,
        selectionEnd: field.selectionEnd,
      },
    );
    if (direction === null) return;
    // Read the field, not a remembered value: if the reader edited the prompt
    // they recalled, traversal has already ended and this press starts over.
    const current = reconcilePromptHistory(entriesRef.current, position.current, value);
    const step = stepPromptHistory(entriesRef.current, current, direction, value);
    if (step === null) {
      position.current = current;
      return;
    }
    event.preventDefault();
    position.current = step.state;
    onValueChange(step.value);
    // The caret belongs at the end of what was just recalled: that is where
    // the reader continues typing, and for a multiline entry it is also what
    // makes the next ArrowUp a history step rather than a line move. Text the
    // field already shows will not re-render, so it is placed now.
    const pending = { field, value: step.value };
    if (field.value === step.value) placeCaretAtEnd(pending);
    else pendingCaret.current = pending;
  }, [onValueChange]);

  return { handleKeyDown, reset };
}

/** Puts the caret after a recall's text, but only in the field it recalled
 * into, while that field still shows that text and still has focus. */
function placeCaretAtEnd({ field, value }: PendingCaret): void {
  if (!field.isConnected || field.ownerDocument.activeElement !== field || field.value !== value) return;
  field.setSelectionRange(value.length, value.length);
}
