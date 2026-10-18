import { describe, expect, it } from 'vitest';
import {
  IDLE_PROMPT_HISTORY,
  promptHistoryDirection,
  promptHistoryEntries,
  reconcilePromptHistory,
  stepPromptHistory,
  type PromptHistoryKey,
  type PromptHistoryState,
} from '../../src/renderer/hooks/prompt-history';

const ENTRIES = ['first prompt', 'second prompt', 'third prompt'] as const;

function key(overrides: Partial<PromptHistoryKey> = {}): PromptHistoryKey {
  return {
    key: 'ArrowUp',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

/** A collapsed caret at `offset` in `value`. */
function caret(value: string, offset: number) {
  return { value, selectionStart: offset, selectionEnd: offset };
}

describe('prompt history traversal rules', () => {
  it('enters history only at the caret boundary the key would otherwise pass', () => {
    const multiline = 'first line\nsecond line';

    // ArrowUp on the first line has no line above it to reach.
    expect(promptHistoryDirection(key(), caret(multiline, 3))).toBe('previous');
    // With a line above, the key keeps its ordinary meaning.
    expect(promptHistoryDirection(key(), caret(multiline, 14))).toBeNull();

    // ArrowDown mirrors that on the last line.
    expect(promptHistoryDirection(key({ key: 'ArrowDown' }), caret(multiline, 14))).toBe('next');
    expect(promptHistoryDirection(key({ key: 'ArrowDown' }), caret(multiline, 3))).toBeNull();

    // A single-line draft is at both boundaries at once.
    expect(promptHistoryDirection(key(), caret('one line', 4))).toBe('previous');
    expect(promptHistoryDirection(key({ key: 'ArrowDown' }), caret('one line', 4))).toBe('next');
  });

  it('never takes a modified press, a selection, a composition, or another key', () => {
    const at = caret('draft', 0);
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(promptHistoryDirection(key({ [modifier]: true }), at)).toBeNull();
    }
    // A composing IME owns the arrow keys outright: it is choosing a candidate.
    expect(promptHistoryDirection(key({ isComposing: true }), at)).toBeNull();
    // An open selection is a range the arrow key collapses or extends.
    expect(promptHistoryDirection(key(), { value: 'draft', selectionStart: 0, selectionEnd: 5 })).toBeNull();
    expect(promptHistoryDirection(key({ key: 'ArrowLeft' }), at)).toBeNull();
    expect(promptHistoryDirection(key({ key: 'Home' }), at)).toBeNull();
  });

  it('walks back from the newest entry and stops at the oldest', () => {
    const first = stepPromptHistory(ENTRIES, IDLE_PROMPT_HISTORY, 'previous', 'unsent draft');
    expect(first).toEqual({ state: { index: 2, draft: 'unsent draft' }, value: 'third prompt' });

    const second = stepPromptHistory(ENTRIES, first!.state, 'previous', first!.value);
    expect(second?.value).toBe('second prompt');
    const third = stepPromptHistory(ENTRIES, second!.state, 'previous', second!.value);
    expect(third?.value).toBe('first prompt');

    // Nothing older to reach: the press is not handled, so the field keeps it.
    expect(stepPromptHistory(ENTRIES, third!.state, 'previous', third!.value)).toBeNull();
  });

  it('restores the unsent draft on the way forward past the newest entry', () => {
    const back = stepPromptHistory(ENTRIES, IDLE_PROMPT_HISTORY, 'previous', 'half-written question');
    const forward = stepPromptHistory(ENTRIES, back!.state, 'next', back!.value);

    expect(forward).toEqual({ state: IDLE_PROMPT_HISTORY, value: 'half-written question' });
    // Already back on the draft: ArrowDown is the field's again.
    expect(stepPromptHistory(ENTRIES, forward!.state, 'next', forward!.value)).toBeNull();
  });

  it('has nowhere to go with no history', () => {
    expect(stepPromptHistory([], IDLE_PROMPT_HISTORY, 'previous', 'draft')).toBeNull();
    expect(stepPromptHistory([], IDLE_PROMPT_HISTORY, 'next', 'draft')).toBeNull();
  });

  it('ends traversal when the reader edits the prompt they recalled', () => {
    const state: PromptHistoryState = { index: 1, draft: 'unsent draft' };
    // The same text is the same position: a re-render changes nothing.
    expect(reconcilePromptHistory(ENTRIES, state, 'second prompt')).toBe(state);
    // An edit makes it the reader's text, so the next ArrowUp starts over.
    expect(reconcilePromptHistory(ENTRIES, state, 'second prompt, revised')).toEqual(IDLE_PROMPT_HISTORY);
    expect(reconcilePromptHistory(ENTRIES, IDLE_PROMPT_HISTORY, 'anything')).toEqual(IDLE_PROMPT_HISTORY);
  });

  it('offers real prompts only, without a repeat to press past', () => {
    // Blank submissions are dropped and an immediate exact repeat collapses;
    // ' summarise ' is a different stored value, so it stays its own entry.
    expect(promptHistoryEntries(['  ', 'summarise', 'summarise', '', ' summarise ', 'expand']))
      .toEqual(['summarise', ' summarise ', 'expand']);
  });

  it('recalls a submitted prompt byte for byte, indentation and all', () => {
    // A prompt is often code. Trimming it on the way into the history would
    // hand back something the reader never submitted, and re-sending it would
    // change the instruction.
    const indented = 'rewrite this:\n\n    def f(x):\n        return x + 1\n';
    const trailing = 'explain the diff  ';
    const entries = promptHistoryEntries(['  \n\t ', indented, trailing]);
    expect(entries).toEqual([indented, trailing]);

    // And traversal hands back that exact value, not a normalized one.
    const back = stepPromptHistory(entries, IDLE_PROMPT_HISTORY, 'previous', 'draft');
    expect(back?.value).toBe(trailing);
    const further = stepPromptHistory(entries, back!.state, 'previous', trailing);
    expect(further?.value).toBe(indented);
  });
});
