import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NoteAutosaveSession,
  type NoteAutosaveOptions,
  type NotePersistResult,
} from '../../src/renderer/hooks/note-autosave';

/**
 * The races behind the note composer's status line, without React: a debounce,
 * Done and a dismissal may all want to write, and the session must turn that
 * into one annotation, written in order, with "Saved" only after a success.
 */

type Persist = NoteAutosaveOptions['persist'];

type Deferred = {
  readonly text: string;
  readonly id: string | null;
  readonly resolve: (result: NotePersistResult) => void;
};

/** A persist whose every call waits until the test settles it. */
function controlledPersist() {
  const calls: Deferred[] = [];
  const persist = vi.fn((text: string, id: string | null) =>
    new Promise<NotePersistResult>((resolve) => { calls.push({ text, id, resolve }); })
  );
  return { calls, persist };
}

function session(overrides: Partial<NoteAutosaveOptions> & Pick<NoteAutosaveOptions, 'persist'>): NoteAutosaveSession {
  return new NoteAutosaveSession({ initialText: '', initialId: null, allowEmpty: false, delayMs: 800, ...overrides });
}

/** Lets pending promise callbacks run without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('NoteAutosaveSession', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates once after the reader pauses, then updates that same annotation', async () => {
    const persist = vi.fn<Persist>(() => Promise.resolve({ ok: true, id: 'ann-1' }));
    const note = session({ persist });

    note.input('First');
    note.input('First thought');
    expect(note.status.kind).toBe('pending');
    await vi.advanceTimersByTimeAsync(799);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Keystrokes inside the pause are coalesced into one write of the newest text.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith('First thought', null);
    expect(note.status.kind).toBe('saved');
    expect(note.annotationId).toBe('ann-1');

    note.input('First thought, revised  ');
    await vi.advanceTimersByTimeAsync(800);
    expect(persist).toHaveBeenCalledTimes(2);
    // The second write is an update of the created annotation, with trimmed text.
    expect(persist).toHaveBeenLastCalledWith('First thought, revised', 'ann-1');
  });

  it('never runs two writes at once, and writes the newest text after an in-flight save', async () => {
    const { calls, persist } = controlledPersist();
    const note = session({ persist });

    note.input('one');
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(1);
    expect(note.status.kind).toBe('saving');

    // Typing continues while the create is still in flight.
    note.input('one two');
    note.input('one two three');
    await vi.advanceTimersByTimeAsync(800);
    // The debounce fired, but it waits for the create rather than racing it.
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ ok: true, id: 'ann-1' });
    await settle();
    // The create landed but the newest text is not stored yet, so not "Saved".
    expect(note.status.kind).not.toBe('saved');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ text: 'one two three', id: 'ann-1' });

    calls[1]!.resolve({ ok: true, id: 'ann-1' });
    await settle();
    expect(note.status.kind).toBe('saved');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('makes a flush during an in-flight create wait for it and update, never create twice', async () => {
    const { calls, persist } = controlledPersist();
    const note = session({ persist });

    note.input('draft');
    await vi.advanceTimersByTimeAsync(800);
    note.input('draft, final');
    const done = note.flush();
    const again = note.flush();
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ ok: true, id: 'ann-1' });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ text: 'draft, final', id: 'ann-1' });
    calls[1]!.resolve({ ok: true, id: 'ann-1' });

    // Whichever waiter wrote it, both report the newest text as stored.
    expect(['saved', 'clean']).toContain(await done);
    expect(['saved', 'clean']).toContain(await again);
    expect(note.status.kind).toBe('saved');
    expect(calls.filter((call) => call.id === null)).toHaveLength(1);
  });

  it('creates nothing for an empty or whitespace-only new draft', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const note = session({ persist });

    note.input('   ');
    expect(note.status.kind).toBe('idle');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(note.flush()).resolves.toBe('empty');
    await settle();
    expect(persist).not.toHaveBeenCalled();
  });

  it('refuses to empty a saved note annotation, and keeps its stored text', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const note = session({ persist, initialText: 'kept', initialId: 'ann-1' });

    note.input('');
    await vi.advanceTimersByTimeAsync(800);
    expect(note.status).toMatchObject({ kind: 'blocked' });
    await expect(note.flush()).resolves.toBe('blocked');
    expect(persist).not.toHaveBeenCalled();
  });

  it("clears a highlight's note when emptying is allowed", async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const note = session({ persist, initialText: 'old note', initialId: 'ann-1', allowEmpty: true });

    note.input(' ');
    await expect(note.flush()).resolves.toBe('saved');
    expect(persist).toHaveBeenCalledWith('', 'ann-1');
  });

  it('does not retry a failed text on its own, and Retry makes exactly one more attempt', async () => {
    const persist = vi.fn<Persist>(() => Promise.resolve({ ok: false, message: 'Disk is full.' }));
    const note = session({ persist });

    note.input('important');
    await vi.advanceTimersByTimeAsync(800);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(note.status).toEqual({ kind: 'error', message: 'Disk is full.', retryable: true });

    // No retry flood: time passing alone does not write the same text again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(1);

    // Retry (a flush) is one attempt, and it reports the failure.
    await expect(note.flush()).resolves.toBe('error');
    expect(persist).toHaveBeenCalledTimes(2);

    // A new keystroke earns one debounced attempt of the new text.
    note.input('important!');
    await vi.advanceTimersByTimeAsync(800);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenLastCalledWith('important!', null);

    persist.mockResolvedValueOnce({ ok: true, id: 'ann-1' });
    await expect(note.flush()).resolves.toBe('saved');
    expect(note.status.kind).toBe('saved');
  });

  it('reports a thrown persist as a retryable error rather than rejecting', async () => {
    const persist = vi.fn(() => Promise.reject(new Error('IPC closed')));
    const note = session({ persist });

    note.input('text');
    await expect(note.flush()).resolves.toBe('error');
    expect(note.status).toEqual({ kind: 'error', message: 'IPC closed', retryable: true });
  });

  it('keeps a non-retryable failure non-retryable', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: false, message: 'Too large.', retryable: false }));
    const note = session({ persist });

    note.input('text');
    await note.flush();
    expect(note.status).toEqual({ kind: 'error', message: 'Too large.', retryable: false });
  });

  it('drops the pending debounce on discard, and writes nothing more', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const note = session({ persist, initialText: 'stored', initialId: 'ann-1' });

    note.input('unwanted');
    note.discard();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(note.flush()).resolves.toBe('clean');
    expect(persist).not.toHaveBeenCalled();
    expect(note.dirty).toBe(false);
  });

  it('reports to every subscriber until it unsubscribes', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const note = session({ persist });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = note.subscribe(first);
    note.subscribe(second);

    note.input('text');
    expect(first).toHaveBeenLastCalledWith({ kind: 'pending' });
    stopFirst();
    const reports = first.mock.calls.length;
    await note.flush();
    expect(first).toHaveBeenCalledTimes(reports);
    expect(second).toHaveBeenLastCalledWith({ kind: 'saved' });
  });
});
