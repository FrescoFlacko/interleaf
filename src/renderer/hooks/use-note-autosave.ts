import { useEffect, useState } from 'react';
import { NoteAutosaveSession, type NoteAutosaveOptions, type NoteSaveStatus } from './note-autosave';

/**
 * Binds one autosave session to a note editor's lifetime.
 *
 * The options are read once, when the editor mounts: the document, anchor and
 * annotation a note is written to are frozen at that moment, so a later
 * navigation or a change of document cannot redirect an open note. Unmounting
 * writes any unsaved text in the background, and a write that completes after
 * the editor is gone updates nothing on screen.
 */
export function useNoteAutosave(options: NoteAutosaveOptions): {
  readonly session: NoteAutosaveSession;
  readonly status: NoteSaveStatus;
} {
  const [session] = useState(() => new NoteAutosaveSession(options));
  const [status, setStatus] = useState<NoteSaveStatus>(session.status);
  useEffect(() => {
    session.subscribe(setStatus);
    setStatus(session.status);
    return () => { session.close(); };
  }, [session]);
  return { session, status };
}
