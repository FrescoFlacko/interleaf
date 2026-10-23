import type { DocumentAnchor } from '@shared/types/annotation';
import { useAnnotationStore } from '../stores/use-annotation-store';
import type { NotePersistResult } from './note-autosave';

type NotePersist = (text: string, id: string | null) => Promise<NotePersistResult>;

/**
 * Where a new note goes, captured when its editor opens. The composer writes
 * here for its whole lifetime, so navigating, selecting something else or
 * switching books while it is open cannot move the note.
 */
export type NewNoteTarget = {
  readonly documentId: string;
  readonly anchor: DocumentAnchor;
  /** The anchor's exact quote, for a note on a passage. */
  readonly selectedText?: string;
  readonly isLocationNote?: boolean;
  /** Keep the reader selection the note came from while the editor stays open. */
  readonly keepSelection?: boolean;
  /** A reason the target cannot be annotated at all; checked before the first write. */
  readonly validate?: () => string | null;
};

function failure(before: string | null, fallback: string): NotePersistResult {
  const after = useAnnotationStore.getState().error;
  // The store reports a thrown request; an update of a row that no longer
  // exists resolves to null without one.
  if (after !== null && after !== before) return { ok: false, message: after };
  return { ok: false, message: fallback };
}

/** Saves the text of an existing annotation's note; empty text clears it. */
export function updateNoteText(documentId: string): NotePersist {
  return async (text, id) => {
    if (id === null) return { ok: false, message: 'This note could not be found.', retryable: false };
    const before = useAnnotationStore.getState().error;
    const updated = await useAnnotationStore.getState().update({ documentId, id, note: text === '' ? null : text });
    return updated ? { ok: true, id: updated.id } : failure(before, 'This note no longer exists, so it could not be saved.');
  };
}

/** Creates the note on its first write, then updates that same annotation. */
export function createThenUpdateNote(target: NewNoteTarget): NotePersist {
  const update = updateNoteText(target.documentId);
  return async (text, id) => {
    if (id !== null) return update(text, id);
    const invalid = target.validate?.() ?? null;
    if (invalid !== null) return { ok: false, message: invalid, retryable: false };
    const before = useAnnotationStore.getState().error;
    const created = await useAnnotationStore.getState().create({
      documentId: target.documentId,
      type: 'note',
      anchor: target.anchor,
      ...(target.selectedText === undefined ? {} : { selectedText: target.selectedText }),
      note: text,
      ...(target.isLocationNote === true ? { isLocationNote: true } : {}),
    }, { keepSelection: target.keepSelection === true });
    return created ? { ok: true, id: created.id } : failure(before, 'Could not create note.');
  };
}
