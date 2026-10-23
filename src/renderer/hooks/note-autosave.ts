/**
 * The autosave session behind one open note editor.
 *
 * A reader types, and the note is written a moment after they pause. The
 * session guarantees what the status line claims:
 *
 *   * One write at a time. A save that starts while another is in flight waits
 *     for it, then writes whatever is newest, so an older text can never land
 *     after a newer one and intermediate keystrokes are coalesced away.
 *   * One annotation. A new note is created by the first successful save, and
 *     every later save updates that same annotation; since writes are serial, a
 *     debounce, Done and a dismissal racing each other cannot create two.
 *   * Nothing for nothing. An empty or whitespace-only draft that was never
 *     saved creates nothing. Emptying a saved note either clears it (when the
 *     annotation may exist without text) or is refused with a message, and the
 *     last saved text stays stored.
 *   * "Saved" means saved. The status turns saved only after the write that
 *     carried the current text resolves successfully.
 *   * No retry flood. A failed write is not retried by the debounce for the
 *     same text; a new keystroke, Done, a dismissal or Retry each make exactly
 *     one more attempt.
 *
 * The session is plain TypeScript with an injected `persist`, so the races
 * above are tested without React. `use-note-autosave.ts` binds it to a
 * component's lifetime.
 */

const NOTE_AUTOSAVE_DELAY_MS = 800;

export type NotePersistResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly message: string;
      /** False when trying again cannot help, such as a selection too large to annotate. */
      readonly retryable?: boolean;
    };

export type NoteSaveStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean }
  | { readonly kind: 'blocked'; readonly message: string };

/**
 * What a flush ended with. `saved` and `clean` both mean the latest text is
 * stored; `empty` means a never-saved draft is empty, so nothing exists.
 */
export type NoteFlushResult = 'saved' | 'clean' | 'empty' | 'error' | 'blocked';

export type NoteAutosaveOptions = {
  /** The stored text when the editor opened; empty for a new note. */
  readonly initialText: string;
  /** The annotation being edited, or `null` until the first save creates it. */
  readonly initialId: string | null;
  /**
   * Whether a saved annotation may be emptied. A highlight's note can be
   * cleared; a note annotation is its text, so emptying it is refused.
   */
  readonly allowEmpty: boolean;
  /** Writes the trimmed text: creates when `id` is null, updates otherwise. */
  readonly persist: (text: string, id: string | null) => Promise<NotePersistResult>;
  readonly delayMs?: number;
};

const EMPTY_NOTE_MESSAGE = 'A note needs some text. Keep typing, or delete the note from the Annotations panel.';

function normalizeNoteText(text: string): string {
  return text.trim();
}

export class NoteAutosaveSession {
  private latest: string;
  private persisted: string;
  private id: string | null;
  private inflight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every edit, so a failure is remembered against one text only. */
  private generation = 0;
  private failedGeneration = -1;
  private current: NoteSaveStatus = { kind: 'idle' };
  private listener: ((status: NoteSaveStatus) => void) | null = null;

  constructor(private readonly options: NoteAutosaveOptions) {
    this.latest = options.initialText;
    this.persisted = normalizeNoteText(options.initialText);
    this.id = options.initialId;
  }

  get status(): NoteSaveStatus {
    return this.current;
  }

  /** The annotation the session has written to, once one exists. */
  get annotationId(): string | null {
    return this.id;
  }

  get text(): string {
    return this.latest;
  }

  /** Whether the newest text differs from what is stored. */
  get dirty(): boolean {
    return normalizeNoteText(this.latest) !== this.persisted;
  }

  /** Starts reporting status changes; `null` stops them. */
  subscribe(listener: ((status: NoteSaveStatus) => void) | null): void {
    this.listener = listener;
  }

  /** Records an edit and schedules a save after the reader pauses. */
  input(text: string): void {
    this.latest = text;
    this.generation += 1;
    this.clearTimer();
    if (!this.dirty) {
      if (this.inflight === null) this.setStatus(this.id === null ? { kind: 'idle' } : { kind: 'saved' });
      return;
    }
    if (this.inflight === null) this.setStatus({ kind: 'pending' });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain(false);
    }, this.options.delayMs ?? NOTE_AUTOSAVE_DELAY_MS);
  }

  /**
   * Writes the newest text now, waiting out any write already in flight. Done,
   * dismissal and Retry call this; each makes at most one new attempt.
   */
  flush(): Promise<NoteFlushResult> {
    this.clearTimer();
    return this.drain(true);
  }

  /**
   * Gives up the unsaved text: the pending debounce is dropped and nothing more
   * is written. What is already stored stays stored.
   */
  discard(): void {
    this.clearTimer();
    this.latest = this.persisted;
    this.generation += 1;
  }

  /**
   * The editor is going away. Unsaved text is still written, in the background
   * and after any write in flight, so closing never loses the newest edit.
   */
  close(): void {
    this.listener = null;
    if (this.dirty) void this.flush();
    else this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(status: NoteSaveStatus): void {
    this.current = status;
    this.listener?.(status);
  }

  private async drain(forced: boolean): Promise<NoteFlushResult> {
    let attempted = false;
    for (;;) {
      if (this.inflight !== null) {
        await this.inflight;
        continue;
      }
      const text = normalizeNoteText(this.latest);
      if (text === this.persisted) {
        if (this.id === null) {
          this.setStatus({ kind: 'idle' });
          return 'empty';
        }
        this.setStatus({ kind: 'saved' });
        return attempted ? 'saved' : 'clean';
      }
      if (text === '' && this.id === null) {
        this.setStatus({ kind: 'idle' });
        return 'empty';
      }
      if (text === '' && !this.options.allowEmpty) {
        this.setStatus({ kind: 'blocked', message: EMPTY_NOTE_MESSAGE });
        return 'blocked';
      }
      const generation = this.generation;
      if (generation === this.failedGeneration && (!forced || attempted)) return 'error';
      attempted = true;
      const attempt = this.write(text, generation);
      this.inflight = attempt;
      const ok = await attempt;
      if (this.inflight === attempt) this.inflight = null;
      if (!ok) return 'error';
    }
  }

  private async write(text: string, generation: number): Promise<boolean> {
    this.setStatus({ kind: 'saving' });
    let result: NotePersistResult;
    try {
      result = await this.options.persist(text, this.id);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : 'The note could not be saved.' };
    }
    if (!result.ok) {
      this.failedGeneration = generation;
      this.setStatus({ kind: 'error', message: result.message, retryable: result.retryable ?? true });
      return false;
    }
    this.id = result.id;
    this.persisted = text;
    // A newer edit made while this write was in flight is still unsaved; its
    // own debounce (or the flush that is waiting) writes it next.
    if (this.dirty) this.setStatus(this.timer === null ? { kind: 'saving' } : { kind: 'pending' });
    else this.setStatus({ kind: 'saved' });
    return true;
  }
}
