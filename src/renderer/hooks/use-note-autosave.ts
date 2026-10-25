import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NoteAutosaveOptions, NoteSaveStatus, NoteAutosaveSession } from './note-autosave';
import {
  ensureNoteDraft,
  holdNoteDraft,
  releaseNoteDraft,
  retainedNoteDraft,
  subscribeNoteDrafts,
  type NoteDraft,
  type NoteDraftMeta,
} from './note-drafts';

/**
 * Binds a note editor to the draft stored under `key`.
 *
 * The options are read once, when the draft is first made: the document,
 * anchor and annotation a note is written to are frozen at that moment, so a
 * later navigation or a change of document cannot redirect it. A draft that
 * still exists, because it is saving or its last write failed, is continued
 * as it is. Unmounting hands the draft back: unsaved text is written in the
 * background, and a failed draft is kept for the reader to retry.
 */
export function useNoteAutosave(key: string, options: NoteAutosaveOptions, meta: NoteDraftMeta): {
  readonly session: NoteAutosaveSession;
  readonly status: NoteSaveStatus;
} {
  const [draft] = useState(() => ensureNoteDraft(key, options, meta));
  const [status, setStatus] = useState<NoteSaveStatus>(draft.session.status);
  const [initialMeta] = useState(meta);
  useEffect(() => {
    const token = holdNoteDraft(draft, initialMeta);
    const unsubscribe = draft.session.subscribe(setStatus);
    setStatus(draft.session.status);
    return () => {
      unsubscribe();
      releaseNoteDraft(draft, token);
    };
  }, [draft, initialMeta]);
  return { session: draft.session, status };
}

/** The oldest kept draft for a document that no editor shows, if any. */
export function useRetainedNoteDraft(documentId: string | null): NoteDraft | null {
  return useSyncExternalStore(subscribeNoteDrafts, () => retainedNoteDraft(documentId));
}
