import { useCallback, type RefObject } from 'react';

/**
 * Places a suggested prompt in the composer and moves focus there.
 *
 * This is the only thing a starter, a follow-up, `Retry` or `Reuse prompt`
 * does: the text becomes an editable draft and nothing is sent. The reader
 * decides whether to send it (DESIGN.md, "Nothing auto-sends").
 */
export function useComposerFill(
  composerRef: RefObject<HTMLTextAreaElement | null>,
  setDraft: (value: string) => void
): (prompt: string) => void {
  return useCallback((prompt: string) => {
    setDraft(prompt);
    window.queueMicrotask(() => {
      const field = composerRef.current;
      if (field === null || field.disabled) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }, [composerRef, setDraft]);
}
