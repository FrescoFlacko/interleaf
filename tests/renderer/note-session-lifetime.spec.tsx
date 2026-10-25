// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { AnnotationInlineEditor } from '../../src/renderer/features/annotations/AnnotationInlineEditor';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';

/**
 * A note outlives the editor showing it. Switching Annotations rows, closing an
 * editor while it saves, or changing book unmounts the editor, and none of
 * these may lose the newest text or let an older write land after a newer one:
 * reopening a note continues its draft, and a draft whose write fails after its
 * editor went away comes back with its own book, passage and a Retry.
 */

/** Longer than the 800 ms pause before a save, with room for a loaded host. */
const AUTOSAVE = { timeout: 4_000 } as const;

const now = '2026-10-20T12:00:00.000Z';

function documentRecord(id: string, title: string): DocumentMetadata {
  return {
    id,
    title,
    author: 'Reader',
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 100,
    fileMtimeMs: 1,
    fileHash: `hash-${id}`,
    pageCount: 5,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: now,
    updatedAt: now,
    source: null,
  };
}

const rangeAnchor = {
  format: 'pdf' as const,
  pageIndex: 1,
  quote: { exact: 'selected quote', prefix: 'before ', suffix: ' after' },
  textStart: 7,
  textEnd: 21,
};

const chatDescriptor = {
  format: 'pdf' as const,
  startPageIndex: 1,
  endPageIndex: 1,
  startPageLabel: '2',
  endPageLabel: '2',
  startQuote: rangeAnchor.quote,
  endQuote: rangeAnchor.quote,
};

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-note',
    documentId: 'doc-1',
    documentHash: 'hash-doc-1',
    type: 'note',
    anchor: rangeAnchor,
    selectedText: 'selected quote',
    note: 'first thought',
    label: null,
    color: null,
    isLocationNote: false,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function selectPassage(exact = 'selected quote'): void {
  useAnnotationStore.setState({
    selection: {
      selectedText: exact,
      totalSelectedLength: exact.length,
      chatDescriptor: { ...chatDescriptor, startQuote: { ...rangeAnchor.quote, exact }, endQuote: { ...rangeAnchor.quote, exact } },
      anchor: { ...rangeAnchor, quote: { ...rangeAnchor.quote, exact } },
      clientRect: { left: 20, top: 100, width: 100, height: 20 },
    },
  });
}

/** A persist promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let chat: ChatStore;
const create = vi.fn();
const update = vi.fn();
const page = vi.fn();
const list = vi.fn();

beforeEach(() => {
  cleanup();
  chat = createChatStore();
  create.mockReset();
  update.mockReset();
  page.mockReset();
  list.mockReset();
  list.mockResolvedValue([]);
  page.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 100 });
  stubBridge(testInterleafApi({ annotations: { create, update, page, list } }));
  useAnnotationStore.getState().reset();
  useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
  useReaderStore.setState({ session: testReaderSession(documentRecord('doc-1', 'Annotated Book')), currentPage: 2, pageCount: 5 });
  useUiStore.setState({ rightOpen: false, rightTab: 'chat', focusMode: false, compactActivePanel: null });
});

afterEach(() => {
  cleanup();
  chat.dispose();
  vi.restoreAllMocks();
});

const done = () => screen.getByRole('button', { name: /^Done/u });

function seatPdf(): void {
  seatReaderAdapter(testDocumentAdapter('pdf', {
    getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 1 }, progress: 0.4 }),
    getCurrentPage: () => 2,
  }));
}

function openBook(id: string, title: string): void {
  act(() => {
    useReaderStore.setState({ session: testReaderSession(documentRecord(id, title)) });
    seatPdf();
  });
}

/** Long enough for any stray debounce to have fired. */
async function pastThePause(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
}

describe('note drafts across editors of one note', () => {
  it('continues a still-saving edit in a reopened editor, and writes the newest text last', async () => {
    const first = deferred<Annotation>();
    const writes: string[] = [];
    let stored = 'first thought';
    update.mockImplementation(async (input: { note: string }) => {
      writes.push(input.note);
      if (writes.length === 1) await first.promise;
      stored = input.note;
      return annotation({ note: input.note });
    });
    const original = annotation();
    const onClose = vi.fn();
    const editor = () => <AnnotationInlineEditor annotation={original} context="Note · Page 2" onClose={onClose} />;
    const firstMount = renderWithChatStore(chat, editor());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old session first' } });
    fireEvent.click(done());
    expect(writes).toEqual(['old session first']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old session latest' } });
    firstMount.unmount();

    // The row still shows the stored text; the editor continues the draft.
    renderWithChatStore(chat, editor());
    expect(screen.getByRole('textbox')).toHaveValue('old session latest');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new session final' } });
    fireEvent.click(done());
    // Nothing overtakes the write in flight.
    expect(writes).toEqual(['old session first']);

    await act(async () => { first.resolve(annotation({ note: 'old session first' })); await first.promise; });
    await waitFor(() => { expect(stored).toBe('new session final'); });
    await pastThePause();
    expect(writes).toEqual(['old session first', 'new session final']);
    expect(stored).toBe('new session final');
  });

  it('switching Annotations rows mid-save cannot let the old row editor overwrite a newer save', async () => {
    const first = deferred<Annotation>();
    let rowA = annotation({ id: 'ann-a', note: 'original A' });
    const rowB = annotation({ id: 'ann-b', note: 'original B' });
    const writes: string[] = [];
    page.mockImplementation(() => Promise.resolve({ items: [rowA, rowB], total: 2, offset: 0, limit: 50 }));
    list.mockImplementation(() => Promise.resolve([rowA, rowB]));
    update.mockImplementation(async (input: { note: string }) => {
      writes.push(input.note);
      if (writes.length === 1) await first.promise;
      rowA = annotation({ id: 'ann-a', note: input.note });
      return rowA;
    });
    renderWithChatStore(chat, <AnnotationBrowser />);
    await screen.findAllByRole('button', { name: 'Edit' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), { target: { value: 'older first' } });
    // A real debounced save starts, and typing continues while it is in flight.
    await waitFor(() => { expect(writes).toEqual(['older first']); }, AUTOSAVE);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), { target: { value: 'older queued' } });

    const editB = screen.getByRole('button', { name: 'Edit' });
    fireEvent.pointerDown(editB);
    fireEvent.click(editB);
    expect(screen.getByRole('textbox', { name: 'Note text' })).toHaveValue('original B');
    const editA = screen.getByRole('button', { name: 'Edit' });
    fireEvent.pointerDown(editA);
    await act(() => Promise.resolve());
    fireEvent.click(editA);
    // Row A's draft carries on with its newest text, not the stored one.
    expect(screen.getByRole('textbox', { name: 'Note text' })).toHaveValue('older queued');
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), { target: { value: 'newest A' } });
    fireEvent.click(done());
    expect(writes).toEqual(['older first']);

    await act(async () => { first.resolve(annotation({ id: 'ann-a', note: 'older first' })); await first.promise; });
    await waitFor(() => { expect(rowA.note).toBe('newest A'); });
    await pastThePause();
    expect(writes).toEqual(['older first', 'newest A']);
    expect(update.mock.calls.every(([input]) => (input as { id: string }).id === 'ann-a')).toBe(true);
  });

  it('keeps a row edit that fails after leaving the row, and offers it again with Retry', async () => {
    let rowA = annotation({ id: 'ann-a', note: 'original A' });
    const rowB = annotation({ id: 'ann-b', note: 'original B' });
    page.mockImplementation(() => Promise.resolve({ items: [rowA, rowB], total: 2, offset: 0, limit: 50 }));
    list.mockImplementation(() => Promise.resolve([rowA, rowB]));
    update.mockRejectedValue(new Error('Disk is full.'));
    renderWithChatStore(chat, <AnnotationBrowser />);
    await screen.findAllByRole('button', { name: 'Edit' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), { target: { value: 'A, unsaved' } });

    const editB = screen.getByRole('button', { name: 'Edit' });
    fireEvent.pointerDown(editB);
    fireEvent.click(editB);
    // Pressing elsewhere tried once; leaving the row made the one last attempt.
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(2); });
    for (const [input] of update.mock.calls) expect(input).toMatchObject({ documentId: 'doc-1', id: 'ann-a', note: 'A, unsaved' });

    fireEvent.click(done());
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: 'Note text' })).toBeNull(); });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(screen.getByRole('textbox', { name: 'Note text' })).toHaveValue('A, unsaved');
    const alert = await screen.findByTestId('annotation-edit-error');
    expect(alert).toHaveTextContent('Disk is full.');

    update.mockImplementation((input: { note: string }) => {
      rowA = annotation({ id: 'ann-a', note: input.note });
      return Promise.resolve(rowA);
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(rowA.note).toBe('A, unsaved'); });
    expect(update).toHaveBeenCalledTimes(3);
  });
});

describe('note drafts when the reader changes book', () => {
  it('brings back a location note whose save failed after switching books, with Retry on its own book and anchor', async () => {
    create.mockRejectedValue(new Error('Disk is full.'));
    act(() => { seatPdf(); });
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'Do not lose me' } });

    openBook('doc-2', 'Another Book');
    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    const firstCall = create.mock.calls[0]![0] as Partial<Annotation>;
    expect(firstCall).toMatchObject({ documentId: 'doc-1', note: 'Do not lose me', isLocationNote: true });
    // The other book shows nothing of it.
    await act(() => Promise.resolve());
    expect(screen.queryByTestId('location-note-composer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add note' })).toHaveAttribute('aria-expanded', 'false');

    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    openBook('doc-1', 'Annotated Book');
    const field = await screen.findByRole('textbox', { name: 'Note at current location' });
    expect(field).toHaveValue('Do not lose me');
    expect(screen.getByText(/Current position · Page 2 of 5 · 40%/u)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Disk is full.');
    expect(screen.getByRole('button', { name: 'Add note' })).toHaveAttribute('aria-expanded', 'true');
    // Shown again without taking focus from where the reader is.
    expect(elsewhere).toHaveFocus();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockImplementation((input: { note: string }) => Promise.resolve(annotation({ id: 'ann-loc', note: input.note, isLocationNote: true })));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(screen.getByTestId('location-note-save-status')).toHaveTextContent('Saved'); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toEqual(firstCall);
    fireEvent.click(done());
    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });
    elsewhere.remove();
  });

  it('forgets a kept draft the reader discards', async () => {
    create.mockRejectedValue(new Error('Disk is full.'));
    act(() => { seatPdf(); });
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'Let it go' } });
    openBook('doc-2', 'Another Book');
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    openBook('doc-1', 'Annotated Book');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Discard note' }));
    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });

    openBook('doc-2', 'Another Book');
    openBook('doc-1', 'Annotated Book');
    await act(() => Promise.resolve());
    expect(screen.queryByTestId('location-note-composer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('textbox', { name: 'Note at current location' })).toHaveValue('');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('brings back a passage note whose save failed when the selection went away, with its quote', async () => {
    create.mockRejectedValue(new Error('Disk is full.'));
    act(() => { seatPdf(); });
    selectPassage();
    renderWithChatStore(chat, <><ReaderHeaderToolbar hidden={false} /><AnnotationSelectionToolbar /></>);
    const passageNote = screen.getAllByRole('button', { name: 'Add note' })
      .find((button) => button.getAttribute('aria-controls') === 'selection-note-popover');
    fireEvent.click(passageNote!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), { target: { value: 'About this passage' } });

    act(() => { useAnnotationStore.setState({ selection: null }); });
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    const field = await screen.findByRole('textbox', { name: 'Note on selected text' });
    expect(field).toHaveValue('About this passage');
    expect(screen.getByTestId('location-note-quote')).toHaveTextContent('selected quote');
    expect(screen.getByRole('alert')).toHaveTextContent('Disk is full.');

    create.mockImplementation((input: { note: string }) => Promise.resolve(annotation({ id: 'ann-sel', note: input.note })));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(2); });
    expect(create.mock.calls[1]![0]).toMatchObject({ documentId: 'doc-1', note: 'About this passage', selectedText: 'selected quote' });
  });

  it('keeps the text of a note that cannot be saved, offering only Discard', async () => {
    act(() => { seatPdf(); });
    selectPassage();
    // A passage with no stable anchor can never be stored as a note.
    act(() => { useAnnotationStore.setState((state) => ({ selection: state.selection && { ...state.selection, anchor: null } })); });
    renderWithChatStore(chat, <><ReaderHeaderToolbar hidden={false} /><AnnotationSelectionToolbar /></>);
    const passageNote = screen.getAllByRole('button', { name: 'Add note' })
      .find((button) => button.getAttribute('aria-controls') === 'selection-note-popover');
    fireEvent.click(passageNote!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), { target: { value: 'Worth keeping' } });

    act(() => { useAnnotationStore.setState({ selection: null }); });
    const field = await screen.findByRole('textbox', { name: 'Note on selected text' });
    expect(field).toHaveValue('Worth keeping');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be mapped');
    expect(within(screen.getByRole('alert')).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard note' }));
    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });
    expect(create).not.toHaveBeenCalled();
  });
});
