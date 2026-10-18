import { useEffect, useState, type RefObject } from 'react';
import { HIGHLIGHT_COLOR_CONFIGS } from '@shared/constants/annotations';
import type { HighlightColor } from '@shared/types/annotation';
import { useAnnotationStore } from '../../../stores/use-annotation-store';
import { Button } from '../../../components/ui/button';
import type { HighlightEditing } from '../annotations/use-highlight-edit';
import type { SelectionActionTarget } from '../annotations/saved-highlight-target';

type ToolbarTarget = {
  /** What the toolbar acts on: the live selection, else the reopened highlight. */
  readonly selection: SelectionActionTarget | null;
  /** The reopened highlight, only while no live selection has taken over. */
  readonly editing: HighlightEditing | null;
  /** Changes when the toolbar starts acting on something else. */
  readonly resetKey: object | string | null;
  readonly label: string;
};

/**
 * A live selection always owns the toolbar; a saved highlight reopened by a
 * click shows in it only while there is none. Recolouring replaces the
 * annotation record but not what is being edited, so the reset key is the
 * annotation id rather than the target object.
 */
export function useSelectionToolbarTarget(editing: HighlightEditing | null): ToolbarTarget {
  const live = useAnnotationStore((state) => state.selection);
  if (live !== null || editing === null) {
    return { selection: live, editing: null, resetKey: live, label: 'Selection actions' };
  }
  return { selection: editing.target, editing, resetKey: editing.annotation.id, label: 'Highlight actions' };
}

/**
 * Keyboard activation (a focused highlight proxy) moves focus to the current
 * colour, so the toolbar's actions are reachable; Escape and Close return it.
 */
export function useFocusOnKeyboardOpen(editing: HighlightEditing | null, toolbarRef: RefObject<HTMLElement | null>): void {
  const focusId = editing?.focusToolbar === true ? editing.annotation.id : null;
  useEffect(() => {
    if (focusId === null) return;
    toolbarRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }, [focusId, toolbarRef]);
}

type EditFeedback = {
  readonly setActionError: (error: string | null) => void;
  readonly setStatus: (status: string) => void;
};

/**
 * Changes the reopened highlight's colour in place: the same annotation id is
 * updated, never a second highlight created. Choosing the current colour is a
 * no-op; a failure stays visible and choosing a colour again retries it.
 */
export function useRecolorHighlight(editing: HighlightEditing | null, feedback: EditFeedback): (color: HighlightColor) => Promise<void> {
  const update = useAnnotationStore((state) => state.update);
  return async (color) => {
    if (editing === null) return;
    feedback.setActionError(null);
    const { annotation } = editing;
    if (annotation.color === color) return;
    const updated = await update({ documentId: annotation.documentId, id: annotation.id, color });
    if (updated) {
      feedback.setStatus(`Highlight changed to ${HIGHLIGHT_COLOR_CONFIGS[color].label}`);
      return;
    }
    feedback.setActionError(useAnnotationStore.getState().error ?? 'Could not change the highlight colour.');
  };
}

type DeleteHighlightButtonProps = EditFeedback & {
  readonly editing: HighlightEditing;
};

/** Deletes the reopened highlight; its paint goes with the store reload. */
export function DeleteHighlightButton({ editing, setActionError }: DeleteHighlightButtonProps) {
  const remove = useAnnotationStore((state) => state.remove);
  const [deleting, setDeleting] = useState(false);
  const deleteHighlight = async (): Promise<void> => {
    if (deleting) return;
    setActionError(null);
    setDeleting(true);
    const { annotation } = editing;
    const removed = await remove(annotation.documentId, annotation.id).finally(() => { setDeleting(false); });
    if (!removed) {
      setActionError(useAnnotationStore.getState().error ?? 'Could not delete the highlight.');
      return;
    }
    editing.release();
    const readerViewport = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]');
    window.queueMicrotask(() => { readerViewport?.focus(); });
  };
  return (
    <Button
      variant="ghost"
      size="chip"
      data-testid="delete-highlight-button"
      aria-busy={deleting}
      onClick={() => { void deleteHighlight(); }}
      className="px-2 text-danger"
    >
      Delete highlight
    </Button>
  );
}
