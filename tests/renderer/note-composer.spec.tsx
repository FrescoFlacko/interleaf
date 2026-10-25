// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
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
 * The margin sticky note in its three real placements: the header's location
 * note, the note on a selected passage, and an Annotations-panel row.
 *
 * Saving is automatic, so what these tests pin down is what autosave must not
 * get wrong: one annotation per note, the newest text last, "Saved" only after
 * a write lands, dismissals that never lose text, and writes bound to the book
 * and passage the note was opened on even when the reader moves on.
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

describe('note composer: selected passage', () => {
  function openSelectionNote(): HTMLElement {
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    return screen.getByRole('textbox', { name: 'Note on selected text' });
  }

  it('sits under the selection actions with only the anchored passage, in the reader font', () => {
    useReaderStore.setState({ reflowFontFamily: 'dyslexic' });
    selectPassage();
    openSelectionNote();

    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    const composer = within(toolbar).getByTestId('selection-note-composer');
    expect(composer).toHaveAttribute('data-variant', 'embedded');
    expect(composer).toHaveAttribute('data-note-font', 'dyslexic');
    expect(within(composer).getByTestId('selection-note-quote')).toHaveTextContent('selected quote');
    expect(composer).toHaveTextContent('Note on selection');
    // No Save or Cancel: the card saves itself and Done finishes.
    expect(within(composer).queryByRole('button', { name: /^(Save|Cancel|Save note)$/u })).toBeNull();
    // The action row it opened from is still above it.
    expect(within(toolbar).getByRole('button', { name: 'Add note' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands the selection panel into one note surface rather than a card inside it', () => {
    selectPassage();
    openSelectionNote();

    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    const composer = within(toolbar).getByTestId('selection-note-composer');
    // An embedded part of the panel: a named group, never a dialog in a toolbar.
    expect(composer).toHaveAttribute('data-variant', 'embedded');
    expect(composer).toHaveAttribute('role', 'group');
    expect(within(toolbar).queryByRole('dialog')).toBeNull();
    expect(within(toolbar).getByRole('group', { name: 'Note on selected text' })).toBe(composer);
    // The panel itself takes the note's surface while it is expanded.
    expect(toolbar).toHaveAttribute('data-note-open', 'true');
    // One close action for the whole surface, and it names what it closes.
    const closes = within(toolbar).getAllByRole('button', { name: /close/iu });
    expect(closes).toHaveLength(1);
    expect(closes[0]).toHaveAccessibleName('Close note');
    expect(within(composer).queryByRole('button', { name: /close/iu })).toBeNull();
  });

  it('creates once while typing, then updates that note, without moving focus or opening panels', async () => {
    create.mockResolvedValue(annotation({ id: 'sel-note', note: 'A first' }));
    update.mockResolvedValue(annotation({ id: 'sel-note', note: 'A first, then more' }));
    selectPassage();
    const field = openSelectionNote();
    const selection = useAnnotationStore.getState().selection;

    fireEvent.change(field, { target: { value: 'A first' } });
    await waitFor(() => { expect(screen.getByTestId('selection-note-save-status')).toHaveTextContent('Saved'); }, AUTOSAVE);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      type: 'note',
      anchor: rangeAnchor,
      selectedText: 'selected quote',
      note: 'A first',
    }));
    // The passage stays selected and the card stays put while it autosaves.
    expect(useAnnotationStore.getState().selection).toBe(selection);
    expect(field).toHaveFocus();
    expect(useUiStore.getState()).toMatchObject({ rightOpen: false, rightTab: 'chat' });
    expect(useAnnotationStore.getState().revealRequest).toBeNull();

    fireEvent.change(field, { target: { value: 'A first, then more' } });
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1); }, AUTOSAVE);
    expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'sel-note', note: 'A first, then more' });
    expect(create).toHaveBeenCalledTimes(1);

    // Only Done reveals the note, and it writes nothing more for unchanged text.
    fireEvent.click(done());
    await waitFor(() => { expect(useUiStore.getState().rightTab).toBe('annotations'); });
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('closes only after a pending Done lands, writing the newest text typed during the save', async () => {
    const first = deferred<Annotation>();
    create.mockReturnValueOnce(first.promise);
    update.mockResolvedValue(annotation({ id: 'sel-note', note: 'one two' }));
    selectPassage();
    const field = openSelectionNote();

    fireEvent.change(field, { target: { value: 'one' } });
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); }, AUTOSAVE);
    expect(screen.getByTestId('selection-note-save-status')).toHaveTextContent('Saving…');

    fireEvent.change(field, { target: { value: 'one two' } });
    fireEvent.click(done());
    // Still saving: the card stays open and says so.
    expect(screen.getByTestId('selection-note-composer')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('group', { name: 'Note on selected text' })).toBeInTheDocument();

    await act(async () => { first.resolve(annotation({ id: 'sel-note', note: 'one' })); await first.promise; });
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'sel-note', note: 'one two' });
  });

  it('flushes the newest text on Escape and on the panel close before closing', async () => {
    create.mockResolvedValue(annotation({ id: 'sel-note', note: 'Escaped' }));
    selectPassage();
    const field = openSelectionNote();
    fireEvent.change(field, { target: { value: 'Escaped' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ note: 'Escaped' });
    cleanup();

    create.mockClear();
    create.mockResolvedValue(annotation({ id: 'sel-note-2', note: 'Closed' }));
    selectPassage('another quote');
    const second = openSelectionNote();
    fireEvent.change(second, { target: { value: 'Closed' } });
    // A real click presses first: the panel's close is not a click "outside" the note.
    const close = screen.getByRole('button', { name: 'Close note' });
    fireEvent.pointerDown(close);
    fireEvent.click(close);
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ note: 'Closed', selectedText: 'another quote' });
    // The note exists, so its passage is done and the reader gets focus back.
    expect(useAnnotationStore.getState().selection).toBeNull();
  });

  it('closes an empty note from the panel close back to Add note, keeping the passage', async () => {
    selectPassage();
    openSelectionNote();
    const close = screen.getByRole('button', { name: 'Close note' });
    fireEvent.pointerDown(close);
    fireEvent.click(close);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    await waitFor(() => { expect(addNote).toHaveFocus(); });
    expect(addNote).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Close selection toolbar' })).toBeInTheDocument();
    expect(useAnnotationStore.getState().selection).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('flushes on a click elsewhere without taking focus there', async () => {
    create.mockResolvedValue(annotation({ id: 'sel-note', note: 'Clicked away' }));
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    selectPassage();
    const field = openSelectionNote();
    fireEvent.change(field, { target: { value: 'Clicked away' } });

    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull(); });
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it('keeps the card, text and a Retry open when a dismissal cannot save', async () => {
    create.mockResolvedValue(null);
    selectPassage();
    const field = openSelectionNote();
    fireEvent.change(field, { target: { value: 'Do not lose me' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    const alert = await screen.findByTestId('selection-note-error');
    expect(screen.getByRole('group', { name: 'Note on selected text' })).toBeInTheDocument();
    expect(field).toHaveValue('Do not lose me');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);

    // Waiting does not retry the same text on its own.
    await new Promise((resolve) => { setTimeout(resolve, 1_200); });
    expect(create).toHaveBeenCalledTimes(1);

    // Discard gives up the draft and closes, writing nothing more.
    fireEvent.click(within(alert).getByRole('button', { name: 'Discard note' }));
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull(); });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('writes to the passage it opened on when the selection moves before the save', async () => {
    create.mockResolvedValue(annotation({ id: 'sel-note', note: 'About the first passage' }));
    selectPassage();
    const field = openSelectionNote();
    fireEvent.change(field, { target: { value: 'About the first passage' } });

    // The reader selects something else before the pause ends.
    act(() => { selectPassage('a different passage'); });
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    expect(create.mock.calls[0]![0]).toMatchObject({
      anchor: rangeAnchor,
      selectedText: 'selected quote',
      note: 'About the first passage',
    });
    // The new passage gets its own fresh toolbar, not the old note.
    expect(screen.queryByRole('group', { name: 'Note on selected text' })).toBeNull();
    expect(useAnnotationStore.getState().selection?.selectedText).toBe('a different passage');
  });

  it('leaves an IME Enter to the IME, for both Escape and the Done chord', () => {
    selectPassage();
    const field = openSelectionNote();
    fireEvent.change(field, { target: { value: 'にほん' } });

    expect(fireEvent.keyDown(field, { key: 'Enter', metaKey: true, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(field, { key: 'Escape', isComposing: true })).toBe(true);
    expect(screen.getByRole('group', { name: 'Note on selected text' })).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('note composer: location note', () => {
  function renderHeader(progress = 0.4): void {
    seatReaderAdapter(testDocumentAdapter('pdf', {
      getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 1 }, progress }),
      getCurrentPage: () => 2,
    }));
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
  }

  it('opens under the Note button showing only the real page and percentage', () => {
    renderHeader(0.42);
    const invoker = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(invoker);

    const composer = screen.getByTestId('location-note-composer');
    expect(composer).toHaveTextContent('Current position · Page 2 of 5 · 42%');
    expect(within(composer).queryByTestId('location-note-quote')).toBeNull();
    expect(invoker.closest('.relative')?.contains(composer)).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Note at current location' })).toHaveFocus();
  });

  it('autosaves quietly, then Done reveals it and returns focus to the Note button', async () => {
    create.mockResolvedValue(annotation({ id: 'loc-note', isLocationNote: true, note: 'Check this' }));
    renderHeader();
    const invoker = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(invoker);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'Check this' } });

    await waitFor(() => { expect(screen.getByTestId('location-note-save-status')).toHaveTextContent('Saved'); }, AUTOSAVE);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', type: 'note', note: 'Check this', isLocationNote: true }),
    );
    expect(useUiStore.getState()).toMatchObject({ rightOpen: false, rightTab: 'chat' });

    fireEvent.click(done());
    await waitFor(() => { expect(invoker).toHaveFocus(); });
    expect(useUiStore.getState().rightTab).toBe('annotations');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('closes from the Note button toggle after writing the newest text', async () => {
    create.mockResolvedValue(annotation({ id: 'loc-note', isLocationNote: true }));
    renderHeader();
    const invoker = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(invoker);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'Toggle' } });
    fireEvent.click(invoker);

    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ note: 'Toggle' });
  });

  it('writes to the book it was opened in when the reader switches books', async () => {
    create.mockResolvedValue(annotation({ id: 'loc-note', isLocationNote: true }));
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'For book one' } });

    act(() => {
      useReaderStore.setState({ session: testReaderSession(documentRecord('doc-2', 'Another Book')) });
    });
    await waitFor(() => { expect(screen.queryByTestId('location-note-composer')).toBeNull(); });
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1); });
    expect(create.mock.calls[0]![0]).toMatchObject({ documentId: 'doc-1', note: 'For book one' });
  });

  it('keeps the bookmark button creating a page bookmark', async () => {
    create.mockResolvedValue(annotation({ id: 'bm', type: 'bookmark', label: 'Page 2' }));
    renderHeader();
    fireEvent.click(screen.getByTestId('add-bookmark-button'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'bookmark', label: 'Page 2' }));
    });
  });
});

describe('note composer: Annotations panel row', () => {
  async function renderBrowser(items: Annotation[]): Promise<void> {
    page.mockResolvedValue({ items, total: items.length, offset: 0, limit: 100 });
    list.mockResolvedValue(items);
    renderWithChatStore(chat, <AnnotationBrowser />);
    await screen.findAllByRole('button', { name: /^(Edit|Add note)$/u });
  }

  it("edits inline with the row's own metadata and quote, and saves the latest text", async () => {
    update.mockImplementation((input: { note: string }) => Promise.resolve(annotation({ note: input.note })));
    await renderBrowser([annotation()]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const composer = screen.getByTestId('annotation-edit-composer');
    expect(composer).toHaveAttribute('data-variant', 'inline');
    expect(composer).toHaveAttribute('role', 'group');
    expect(composer).toHaveTextContent(/^Note · /u);
    expect(within(composer).getByTestId('annotation-edit-quote')).toHaveTextContent('selected quote');
    const field = within(composer).getByRole<HTMLTextAreaElement>('textbox', { name: 'Note text' });
    expect(field).toHaveValue('first thought');
    // Editing continues the note: the caret starts after the existing text.
    expect(field.selectionStart).toBe('first thought'.length);

    fireEvent.change(field, { target: { value: 'second thought' } });
    fireEvent.change(field, { target: { value: 'second thought, final' } });
    await waitFor(() => { expect(screen.getByTestId('annotation-edit-save-status')).toHaveTextContent('Saved'); }, AUTOSAVE);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-note', note: 'second thought, final' });
    // Still open, and still the reader's field.
    expect(field).toHaveFocus();

    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('annotation-edit-composer')).toBeNull(); });
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus(); });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("clears a highlight's note when it is emptied", async () => {
    const highlight = annotation({ id: 'ann-hl', type: 'highlight', color: 'yellow', note: 'remove me' });
    update.mockResolvedValue({ ...highlight, note: null });
    await renderBrowser([highlight]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), { target: { value: '' } });
    fireEvent.click(done());
    await waitFor(() => { expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-hl', note: null }); });
  });

  it('keeps the bookmark label editor with Save, Cancel and label semantics', async () => {
    const bookmark = annotation({
      id: 'ann-bm',
      type: 'bookmark',
      selectedText: null,
      note: null,
      label: 'Review later',
      anchor: { format: 'pdf', pageIndex: 3, quote: { exact: '', prefix: '', suffix: '' } },
    });
    update.mockResolvedValue({ ...bookmark, label: null });
    await renderBrowser([bookmark]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.queryByTestId('annotation-edit-composer')).toBeNull();
    const field = screen.getByLabelText('Bookmark label');
    expect(field).toHaveAttribute('maxLength', '500');
    expect(screen.getByTestId('annotation-edit-shortcut-hint')).toHaveTextContent(/to save$/u);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '   ' } });
    // A bookmark label is never autosaved.
    await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => { expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-bm', label: null }); });
  });
});

describe('annotation store create', () => {
  it('clears the selection by default and keeps it only when asked', async () => {
    create.mockResolvedValue(annotation());
    const input = { documentId: 'doc-1', type: 'note' as const, anchor: rangeAnchor, note: 'x' };

    selectPassage();
    await useAnnotationStore.getState().create(input, { keepSelection: true });
    expect(useAnnotationStore.getState().selection).not.toBeNull();

    await useAnnotationStore.getState().create(input);
    expect(useAnnotationStore.getState().selection).toBeNull();
  });
});
