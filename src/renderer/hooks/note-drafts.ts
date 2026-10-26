import { NoteAutosaveSession, type NoteAutosaveOptions, type NoteFlushResult } from './note-autosave';

/**
 * The owners of note drafts, which outlive the editors that show them.
 *
 * An editor is a view of a draft, not its owner. Closing an editor, switching
 * Annotations rows or changing book unmounts it, but the draft's autosave
 * session stays here until the newest text is stored, so:
 *
 *   * One writer per note. Reopening a note that is still saving reuses its
 *     session, which keeps writes to that note in order: an older session can
 *     never write after a newer one. A new note, once created, is also listed
 *     under its annotation id, so editing it in the Annotations panel continues
 *     the same session.
 *   * A failed draft is kept. If the write made as an editor goes away fails,
 *     the draft stays here, with the document, anchor and quote it was opened
 *     on, until the reader retries or discards it (see `useRetainedNoteDraft`).
 *     That holds for a failure that cannot be retried too: only Discard gives
 *     the text up.
 *   * Quitting writes. `flushNoteDrafts` writes every draft's newest text, and
 *     the app's before-close handshake waits for it.
 *
 * Drafts live in memory only: a crash before a write lands still loses it.
 */

/** What an editor shows about a draft, so a kept draft can be shown again. */
export type NoteDraftMeta = {
  readonly documentId: string;
  readonly label: string;
  readonly context: string;
  readonly quote: string | null;
};

export type NoteDraft = {
  readonly key: string;
  readonly session: NoteAutosaveSession;
  meta: NoteDraftMeta;
  /** The editor showing the draft; `null` when no editor is open on it. */
  holder: symbol | null;
  /** True once a write made after its editor went away failed. */
  retained: boolean;
};

const drafts = new Map<string, NoteDraft>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function annotationKey(id: string): string {
  return `annotation:${id}`;
}

/** The key of an existing annotation's note draft. */
export function noteDraftKeyForAnnotation(id: string): string {
  return annotationKey(id);
}

let newNoteSequence = 0;

/** A key of its own for one opening of a new note's editor. */
export function newNoteDraftKey(placement: string): string {
  newNoteSequence += 1;
  return `new:${placement}:${String(newNoteSequence)}`;
}

function register(draft: NoteDraft): void {
  drafts.set(draft.key, draft);
  const id = draft.session.annotationId;
  if (id !== null) drafts.set(annotationKey(id), draft);
}

function unregister(draft: NoteDraft): void {
  for (const [key, entry] of drafts) if (entry === draft) drafts.delete(key);
  notify();
}

/**
 * The draft stored under `key`, created from `options` when there is none. A
 * draft that is still saving or was kept after a failure is returned as it is,
 * so its newest text and its write order carry over.
 */
export function ensureNoteDraft(key: string, options: NoteAutosaveOptions, meta: NoteDraftMeta): NoteDraft {
  const existing = drafts.get(key);
  if (existing) return existing;
  const session = new NoteAutosaveSession(options);
  const draft: NoteDraft = { key, session, meta, holder: null, retained: false };
  // A new note is listed under its annotation once its first write creates it.
  session.subscribe(() => {
    const id = session.annotationId;
    if (id !== null && drafts.get(draft.key) === draft && !drafts.has(annotationKey(id))) drafts.set(annotationKey(id), draft);
  });
  register(draft);
  return draft;
}

/** An editor opens on the draft; the newest editor holds it. */
export function holdNoteDraft(draft: NoteDraft, meta: NoteDraftMeta): symbol {
  const token = Symbol(draft.key);
  draft.holder = token;
  draft.meta = meta;
  const wasRetained = draft.retained;
  draft.retained = false;
  register(draft);
  if (wasRetained) notify();
  return token;
}

/**
 * Whether a draft may be forgotten after its last write: its text is stored,
 * there was none, or it was emptied (the stored text stays). A failed write
 * keeps the draft, even one that cannot be retried, so its text is only ever
 * given up by the reader's Discard.
 */
function finished(result: NoteFlushResult): boolean {
  return result !== 'error';
}

/**
 * The editor holding `token` goes away. Unsaved text is written after any write
 * in flight; a draft whose write fails is kept for the reader to retry. An
 * editor that no longer holds the draft releases nothing.
 */
export function releaseNoteDraft(draft: NoteDraft, token: symbol): void {
  if (draft.holder !== token) return;
  draft.holder = null;
  void draft.session.flush().then((result) => {
    if (draft.holder !== null) return;
    if (finished(result)) {
      unregister(draft);
      return;
    }
    draft.retained = true;
    notify();
  });
}

/**
 * Writes the newest text of every draft, open or kept, and resolves once each
 * attempt has finished. The before-close handshake waits on this.
 */
export async function flushNoteDrafts(): Promise<void> {
  const pending = new Set(drafts.values());
  await Promise.allSettled([...pending].map((draft) => draft.session.flush()));
}

/** The oldest kept draft for one document that no editor shows. */
export function retainedNoteDraft(documentId: string | null): NoteDraft | null {
  if (documentId === null) return null;
  for (const draft of new Set(drafts.values())) {
    if (draft.retained && draft.holder === null && draft.meta.documentId === documentId) return draft;
  }
  return null;
}

export function subscribeNoteDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forgets every draft, as a freshly loaded window has none. */
export function resetNoteDrafts(): void {
  drafts.clear();
  notify();
}
