import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteAutosaveOptions, NotePersistResult } from '../../src/renderer/hooks/note-autosave';
import {
  ensureNoteDraft,
  flushNoteDrafts,
  holdNoteDraft,
  newNoteDraftKey,
  noteDraftKeyForAnnotation,
  releaseNoteDraft,
  resetNoteDrafts,
  retainedNoteDraft,
  subscribeNoteDrafts,
  type NoteDraftMeta,
} from '../../src/renderer/hooks/note-drafts';

/**
 * Note drafts outlive their editors. These pin down what that buys: one writer
 * per note across editors, the newest text written last, failed drafts kept
 * with their own book, and every draft written when the app quits.
 */

type Deferred = {
  readonly text: string;
  readonly id: string | null;
  readonly resolve: (result: NotePersistResult) => void;
};

function controlledPersist() {
  const calls: Deferred[] = [];
  const persist = vi.fn((text: string, id: string | null) =>
    new Promise<NotePersistResult>((resolve) => { calls.push({ text, id, resolve }); })
  );
  return { calls, persist };
}

function options(overrides: Partial<NoteAutosaveOptions> & Pick<NoteAutosaveOptions, 'persist'>): NoteAutosaveOptions {
  return { initialText: '', initialId: null, allowEmpty: false, delayMs: 800, ...overrides };
}

function meta(documentId = 'doc-1'): NoteDraftMeta {
  return { documentId, label: 'Note', context: 'Page 2', quote: null };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNoteDrafts();
});

afterEach(() => {
  resetNoteDrafts();
  vi.useRealTimers();
});

describe('note drafts', () => {
  it('writes the newest text on release, after any write in flight', async () => {
    const { calls, persist } = controlledPersist();
    const draft = ensureNoteDraft('k', options({ persist }), meta());
    const token = holdNoteDraft(draft, meta());

    draft.session.input('first');
    await vi.advanceTimersByTimeAsync(800);
    draft.session.input('first and last');
    releaseNoteDraft(draft, token);
    // The pending debounce no longer matters: the release owns the final write.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);

    calls[0]!.resolve({ ok: true, id: 'ann-1' });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ text: 'first and last', id: 'ann-1' });
    calls[1]!.resolve({ ok: true, id: 'ann-1' });
    await settle();
    // Stored: nothing is kept, and a new editor starts a new draft.
    expect(ensureNoteDraft('k', options({ persist }), meta())).not.toBe(draft);
  });

  it('forgets a clean draft on release without writing', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: true, id: 'ann-1' }));
    const draft = ensureNoteDraft('k', options({ persist, initialText: 'same', initialId: 'ann-1' }), meta());
    releaseNoteDraft(draft, holdNoteDraft(draft, meta()));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();
    expect(ensureNoteDraft('k', options({ persist }), meta())).not.toBe(draft);
  });

  it('continues a still-saving draft in a new editor, so an old write never lands last', async () => {
    const { calls, persist } = controlledPersist();
    const key = noteDraftKeyForAnnotation('ann-a');
    const first = ensureNoteDraft(key, options({ persist, initialText: 'original', initialId: 'ann-a' }), meta());
    const firstToken = holdNoteDraft(first, meta());
    first.session.input('older first');
    void first.session.flush();
    first.session.input('older queued');
    releaseNoteDraft(first, firstToken);

    const second = ensureNoteDraft(key, options({ persist, initialText: 'stale row', initialId: 'ann-a' }), meta());
    expect(second).toBe(first);
    expect(second.session.text).toBe('older queued');
    const secondToken = holdNoteDraft(second, meta());
    second.session.input('newest A');
    const done = second.session.flush();
    // The old editor's late release changes nothing.
    releaseNoteDraft(first, firstToken);
    expect(calls.map((call) => call.text)).toEqual(['older first']);

    calls[0]!.resolve({ ok: true, id: 'ann-a' });
    await settle();
    expect(calls.map((call) => call.text)).toEqual(['older first', 'newest A']);
    calls[1]!.resolve({ ok: true, id: 'ann-a' });
    // Another waiting flush may have carried it: either way it is stored.
    expect(['saved', 'clean']).toContain(await done);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map((call) => call.text)).toEqual(['older first', 'newest A']);
    releaseNoteDraft(second, secondToken);
    await settle();
  });

  it('lists a new note under its annotation once created, so editing it continues the draft', async () => {
    const { calls, persist } = controlledPersist();
    const draft = ensureNoteDraft(newNoteDraftKey('location'), options({ persist }), meta());
    const token = holdNoteDraft(draft, meta());
    draft.session.input('created');
    void draft.session.flush();
    calls[0]!.resolve({ ok: true, id: 'ann-new' });
    await settle();
    draft.session.input('created, then more');
    releaseNoteDraft(draft, token);

    const editor = ensureNoteDraft(noteDraftKeyForAnnotation('ann-new'), options({ persist, initialText: 'created', initialId: 'ann-new' }), meta());
    expect(editor).toBe(draft);
    calls[1]!.resolve({ ok: true, id: 'ann-new' });
    await settle();
    // One annotation: the later write updates it rather than creating another.
    expect(calls.map((call) => call.id)).toEqual([null, 'ann-new']);
  });

  it('keeps a draft whose release write fails, for its own book only', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: false, message: 'Disk is full.' }));
    const changed = vi.fn();
    const unsubscribe = subscribeNoteDrafts(changed);
    const draft = ensureNoteDraft(newNoteDraftKey('location'), options({ persist }), meta('doc-1'));
    const token = holdNoteDraft(draft, meta('doc-1'));
    draft.session.input('Do not lose me');
    releaseNoteDraft(draft, token);
    await settle();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(retainedNoteDraft('doc-1')).toBe(draft);
    expect(retainedNoteDraft('doc-2')).toBeNull();
    expect(changed).toHaveBeenCalled();
    expect(draft.session.text).toBe('Do not lose me');
    expect(draft.session.status).toMatchObject({ kind: 'error', message: 'Disk is full.', retryable: true });

    // No retry flood: a kept draft waits for the reader.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(1);

    // Shown again, it is no longer listed as waiting; discarding forgets it.
    const shown = holdNoteDraft(draft, meta('doc-1'));
    expect(retainedNoteDraft('doc-1')).toBeNull();
    draft.session.discard();
    releaseNoteDraft(draft, shown);
    await settle();
    expect(retainedNoteDraft('doc-1')).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps the text of a draft that cannot be retried until the reader discards it', async () => {
    const persist = vi.fn(() => Promise.resolve<NotePersistResult>({ ok: false, message: 'Too large.', retryable: false }));
    const draft = ensureNoteDraft(newNoteDraftKey('selection'), options({ persist }), meta());
    const token = holdNoteDraft(draft, meta());
    draft.session.input('valuable text');
    releaseNoteDraft(draft, token);
    await settle();

    expect(retainedNoteDraft('doc-1')).toBe(draft);
    expect(draft.session.text).toBe('valuable text');
    expect(draft.session.status).toMatchObject({ kind: 'error', message: 'Too large.', retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(1);

    const shown = holdNoteDraft(draft, meta());
    draft.session.discard();
    releaseNoteDraft(draft, shown);
    await settle();
    expect(retainedNoteDraft('doc-1')).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('writes every draft at quit without waiting for the pause', async () => {
    const persist = vi.fn((text: string) => Promise.resolve<NotePersistResult>({ ok: true, id: `ann-${text}` }));
    const open = ensureNoteDraft(newNoteDraftKey('location'), options({ persist }), meta());
    holdNoteDraft(open, meta());
    open.session.input('typed just now');
    const kept = ensureNoteDraft(noteDraftKeyForAnnotation('ann-b'), options({ persist, initialText: 'b', initialId: 'ann-b' }), meta('doc-2'));
    holdNoteDraft(kept, meta('doc-2'));
    kept.session.input('b, edited');

    await flushNoteDrafts();
    expect(persist).toHaveBeenCalledWith('typed just now', null);
    expect(persist).toHaveBeenCalledWith('b, edited', 'ann-b');
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
