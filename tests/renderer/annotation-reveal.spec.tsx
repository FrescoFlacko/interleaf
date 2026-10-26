// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Annotation, AnnotationFilter, AnnotationPage, DocumentAnchor } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { chooseValue } from '../helpers/listbox-select';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * Revealing an annotation in the Annotations panel.
 *
 * Finishing a note with Done opens the tab and brings the new row to the very top of
 * the list container, once, even when the row above it is enormous; nothing
 * else in the panel's life (a refresh, an edit, a filter change) moves the
 * reader's scroll position. A reveal names one row in one book, and until that
 * row is on screen it has not happened: a filtered, searched, re-sorted or
 * paged view, an unrelated page and a failed page all leave it pending.
 */

const now = '2026-09-12T00:00:00.000Z';
const PAGE: Pick<AnnotationPage, 'offset' | 'limit'> = { offset: 0, limit: 50 };

const documentRecord: DocumentMetadata = {
  id: 'doc-1', title: 'A Very Long Note', author: 'Reader', format: 'pdf', storageMode: 'managed',
  fileSize: 100, fileMtimeMs: 1, fileHash: 'hash-v1', pageCount: 400,
  folderId: null, storageHealth: 'ok', readingPosition: null, createdAt: now, updatedAt: now,
  source: null,
};

const rangeAnchor: DocumentAnchor = {
  format: 'pdf', pageIndex: 3, pageLabel: '4',
  quote: { exact: 'selected quote', prefix: '', suffix: '' },
};

function annotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id, documentId: 'doc-1', documentHash: 'hash-v1', type: 'highlight', anchor: rangeAnchor,
    selectedText: 'selected quote', note: null, label: null, color: 'yellow',
    isLocationNote: false, status: 'anchored', createdAt: now, updatedAt: now, ...overrides,
  };
}

/** The row the reader was reading: one very tall note between two short rows. */
const ROW_HEIGHTS = [48, 2_000, 120] as const;
const NEW_ROW_HEIGHT = 48;

const existing = [
  annotation('ann-short', { note: 'A short earlier note.' }),
  annotation('ann-long', { note: 'A note long enough to fill the panel several times over.' }),
  annotation('ann-tail', { note: 'The note after it.' }),
];
const created = annotation('ann-new', { type: 'note', note: 'A new note.', color: null });

/** The row a reveal names, and the two rows that were already there. */
const target = annotation('ann-new', { color: 'green' });
const older = [annotation('ann-old', { note: 'An earlier note.' }), annotation('ann-tail', { type: 'note', note: 'The note after it.' })];
const revealed: AnnotationPage = { items: [target, ...older], total: 3, ...PAGE };
/** What the Notes filter shows: real rows, none of them the target. */
const notesOnly: AnnotationPage = { items: [older[1]!], total: 1, ...PAGE };

const create = vi.fn();
const page = vi.fn();
const update = vi.fn();

/**
 * Stands in for layout, which jsdom does not do.
 *
 * The list's own box is the viewport at y=0; each row sits at its stacked
 * content offset, shifted up by however far the list is scrolled — exactly the
 * relationship the reveal reads when it decides how far to scroll.
 */
function stubLayout(heights: readonly number[]): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const list = document.querySelector<HTMLElement>('[data-testid="annotation-page-list"]');
    const rect = (top: number, height: number): DOMRect =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    if (this === list) return rect(0, 600);
    if (list === null || this.parentElement !== list) return rect(0, 0);
    const index = [...list.children].indexOf(this);
    const offset = heights.slice(0, index).reduce((sum, height) => sum + height, 0);
    return rect(offset - list.scrollTop, heights[index] ?? 0);
  });
}

/** Records every scroll write to the list so "exactly once" is checkable. */
function watchScroll(list: HTMLElement): number[] {
  const writes: number[] = [];
  let value = list.scrollTop;
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next; writes.push(next); },
  });
  return writes;
}

function selectText(): void {
  useAnnotationStore.setState({
    selection: {
      selectedText: 'selected quote',
      totalSelectedLength: 14,
      chatDescriptor: {
        format: 'pdf',
        startPageIndex: 3,
        endPageIndex: 3,
        documentId: 'doc-1',
        text: 'selected quote',
      },
      anchor: rangeAnchor,
      clientRect: { left: 20, top: 100, width: 100, height: 20 },
    },
  } as Partial<ReturnType<typeof useAnnotationStore.getState>>);
}

function revealRequest(): ReturnType<typeof useAnnotationStore.getState>['revealRequest'] {
  return useAnnotationStore.getState().revealRequest;
}

beforeEach(() => {
  cleanup();
  create.mockResolvedValue(created);
  update.mockResolvedValue(existing[0]);
  page.mockResolvedValue({ items: existing, total: existing.length, ...PAGE });
  stubBridge({
    annotations: { create, list: vi.fn(() => Promise.resolve([])), page, update },
  });
  useAnnotationStore.getState().reset();
  useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
  useReaderStore.setState({ session: testReaderSession(documentRecord), currentPage: 4 });
  useUiStore.setState({ rightOpen: false, rightTab: 'chat', focusMode: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Renders the selection toolbar and the panel, and waits for its first rows. */
async function renderPanel(): Promise<HTMLElement> {
  renderWithChatStore(chat,
    <>
      <AnnotationSelectionToolbar />
      <AnnotationBrowser />
    </>
  );
  await screen.findAllByTestId('annotation-row');
  return screen.getByTestId('annotation-page-list');
}

describe('a newly created annotation is revealed in the annotations panel', () => {
  it('brings the created note to the top of a list left scrolled mid-note', async () => {
    const list = await renderPanel();
    stubLayout(ROW_HEIGHTS);
    // The reader is 900px into the tall note when they write the new one.
    list.scrollTop = 900;
    const writes = watchScroll(list);

    act(() => { selectText(); });
    page.mockResolvedValue({ items: [created, ...existing], total: existing.length + 1, ...PAGE });
    stubLayout([NEW_ROW_HEIGHT, ...ROW_HEIGHTS]);

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), { target: { value: 'A new note.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));

    // The panel is opened by the same action, and the new row arrives with the
    // page refresh the creation triggered.
    await waitFor(() => { expect(useUiStore.getState().rightTab).toBe('annotations'); });
    await waitFor(() => { expect(screen.getAllByTestId('annotation-row')).toHaveLength(4); });

    // Top of the container, not merely "somewhere nearer the top": the row's
    // own offset is zero once the list has been scrolled back.
    await waitFor(() => { expect(list.scrollTop).toBe(0); });
    expect(writes).toEqual([0]);
    expect(useAnnotationStore.getState().revealRequest).toBeNull();
  });

  it('aligns the requested row at the top even when the row above it is enormous', async () => {
    const list = await renderPanel();
    stubLayout(ROW_HEIGHTS);
    const writes = watchScroll(list);

    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-tail'); });

    // 48 + 2000: the tall note is scrolled entirely out of the way rather than
    // leaving the target part-way down the container.
    await waitFor(() => { expect(list.scrollTop).toBe(2_048); });
    expect(writes).toEqual([2_048]);
  });

  it('leaves the scroll position alone on refreshes, edits and filter changes', async () => {
    const list = await renderPanel();
    stubLayout(ROW_HEIGHTS);
    list.scrollTop = 900;
    const writes = watchScroll(list);

    // A background refresh, an edit, and a filter change: three things that all
    // re-render the list and none of which the reader asked to be moved for.
    act(() => { useAnnotationStore.setState((state) => ({ mutationRevision: state.mutationRevision + 1 })); });
    await act(async () => { await useAnnotationStore.getState().update({ documentId: 'doc-1', id: 'ann-short', note: 'edited' }); });
    fireEvent.click(screen.getByRole('button', { name: /^Notes/u }));
    await waitFor(() => { expect(page).toHaveBeenCalled(); });

    expect(writes).toEqual([]);
    expect(list.scrollTop).toBe(900);
  });

  it('reveals without taking keyboard focus away from the reader', async () => {
    const list = await renderPanel();
    stubLayout(ROW_HEIGHTS);
    const probe = document.createElement('button');
    document.body.append(probe);
    probe.focus();

    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-tail'); });
    await waitFor(() => { expect(list.scrollTop).toBe(2_048); });

    expect(document.activeElement).toBe(probe);
    probe.remove();
  });

  it('defeats browser scroll anchoring on the list container', async () => {
    const list = await renderPanel();
    // Without this the browser re-pins the row that was visible before the
    // refresh, undoing the reveal on the very next layout.
    expect(list.className).toContain('[overflow-anchor:none]');
  });
});

describe('a reveal is never consumed without rendering its target', () => {
  beforeEach(() => {
    page.mockResolvedValue(revealed);
  });

  /** Moves the panel to Notes, which holds rows but never the target. */
  async function filterToNotes(): Promise<void> {
    page.mockResolvedValue(notesOnly);
    fireEvent.click(screen.getByRole('button', { name: /^Notes/u }));
    await waitFor(() => { expect(screen.getAllByTestId('annotation-row')).toHaveLength(1); });
  }

  it('waits for the target page rather than consuming the reveal in a filtered view', async () => {
    const list = await renderPanel();
    await filterToNotes();
    stubLayout(ROW_HEIGHTS);
    list.scrollTop = 500;
    const writes = watchScroll(list);

    // The reveal-admitting page is held open, so the moment between asking and
    // the row arriving is observable rather than a race.
    let release: ((value: AnnotationPage) => void) | null = null;
    page.mockImplementation((_documentId: string, filter: AnnotationFilter) =>
      filter.type === 'note'
        ? Promise.resolve(notesOnly)
        : new Promise<AnnotationPage>((resolve) => { release = resolve; }));

    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-new'); });

    // The panel normalizes itself to the one view that admits a new annotation
    // and then waits: nothing is scrolled and nothing is cleared.
    await waitFor(() => {
      expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ offset: 0, sort: 'updated_desc' }));
    });
    expect(page.mock.lastCall?.[1]).not.toHaveProperty('type');
    expect(revealRequest()).not.toBeNull();
    expect(writes).toEqual([]);
    expect(screen.getAllByTestId('annotation-row')).toHaveLength(1);

    await act(async () => {
      release?.(revealed);
      await Promise.resolve();
    });

    // Only now, with the row actually rendered, is it brought to the top.
    await waitFor(() => { expect(screen.getAllByTestId('annotation-row')).toHaveLength(3); });
    await waitFor(() => { expect(revealRequest()).toBeNull(); });
    expect(writes).toEqual([0]);
    expect(screen.getByRole('button', { name: /^All/u })).toHaveAttribute('aria-pressed', 'true');
  });

  it('returns from oldest-first on a later page to the page the target is on', async () => {
    await renderPanel();
    // Oldest first, then paged forward: a new annotation is at neither end of
    // this view, and the request the panel would make cannot contain it.
    page.mockResolvedValue({ items: older, total: 120, ...PAGE });
    chooseValue(screen.getByLabelText('Sort annotations'), 'created_asc');
    await waitFor(() => { expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ sort: 'created_asc' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => { expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ offset: 50 })); });

    const list = screen.getByTestId('annotation-page-list');
    stubLayout(ROW_HEIGHTS);
    const writes = watchScroll(list);
    page.mockResolvedValue(revealed);

    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-new'); });

    await waitFor(() => { expect(revealRequest()).toBeNull(); });
    expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ offset: 0, sort: 'updated_desc' }));
    expect(screen.getByLabelText('Sort annotations')).toHaveAttribute('data-value', 'updated_desc');
    expect(writes).toEqual([0]);
  });

  it('is not satisfied by a page belonging to a request it is not waiting for', async () => {
    // The panel is already in the reveal view, but the row has not arrived in
    // it yet — the state a creation leaves behind until its refresh lands.
    page.mockResolvedValue({ items: older, total: 2, ...PAGE });
    const list = await renderPanel();
    stubLayout(ROW_HEIGHTS);
    list.scrollTop = 500;
    const writes = watchScroll(list);

    // The reader searches while the reveal is still outstanding. That search
    // settles with real rows, and none of them is the target.
    page.mockResolvedValue(notesOnly);
    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-new'); });
    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: 'lease' } });

    await waitFor(() => { expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ searchQuery: 'lease' })); });
    await waitFor(() => { expect(screen.getAllByTestId('annotation-row')).toHaveLength(1); });
    expect(revealRequest()).not.toBeNull();
    expect(writes).toEqual([]);

    // The reader's own filters are theirs: the panel normalizes once and then
    // leaves them alone, so the reveal lands when the reader clears the search.
    page.mockResolvedValue(revealed);
    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: '' } });

    await waitFor(() => { expect(revealRequest()).toBeNull(); });
    expect(writes).toEqual([0]);
  });

  it('keeps the reveal pending when the target page fails, and lands it on the retry', async () => {
    const list = await renderPanel();
    await filterToNotes();
    stubLayout(ROW_HEIGHTS);
    list.scrollTop = 500;
    const writes = watchScroll(list);

    page.mockRejectedValue(new Error('The annotation query failed.'));
    act(() => { useAnnotationStore.getState().requestReveal('doc-1', 'ann-new'); });

    await waitFor(() => { expect(screen.getByRole('alert')).toHaveTextContent('The annotation query failed.'); });
    expect(revealRequest()).not.toBeNull();
    expect(writes).toEqual([]);

    // The next refresh succeeds and the row the reader asked for arrives.
    page.mockResolvedValue(revealed);
    act(() => { useAnnotationStore.setState((state) => ({ mutationRevision: state.mutationRevision + 1 })); });

    await waitFor(() => { expect(screen.getAllByTestId('annotation-row')).toHaveLength(3); });
    await waitFor(() => { expect(revealRequest()).toBeNull(); });
    expect(writes).toEqual([0]);
  });

  it('leaves a panel showing another book entirely alone', async () => {
    await renderPanel();

    // The reader has this book's panel arranged their own way: filtered,
    // searched, oldest first, and paged forward.
    page.mockResolvedValue({ items: [older[1]!], total: 120, ...PAGE });
    fireEvent.click(screen.getByRole('button', { name: /^Notes/u }));
    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: 'lease' } });
    chooseValue(screen.getByLabelText('Sort annotations'), 'created_asc');
    await waitFor(() => {
      expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({
        type: 'note', searchQuery: 'lease', sort: 'created_asc',
      }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => { expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ offset: 50 })); });

    const list = screen.getByTestId('annotation-page-list');
    stubLayout(ROW_HEIGHTS);
    list.scrollTop = 500;
    const writes = watchScroll(list);
    const requestsBefore = page.mock.calls.length;
    const rowsBefore = screen.getAllByTestId('annotation-row').length;
    const focusBefore = document.activeElement;

    // Another book's reveal. It belongs to whichever panel is showing that
    // book; here it is not even normalized against.
    act(() => { useAnnotationStore.getState().requestReveal('doc-2', 'ann-new'); });
    await act(async () => { await Promise.resolve(); });

    expect(page).toHaveBeenCalledTimes(requestsBefore);
    expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({
      type: 'note', searchQuery: 'lease', sort: 'created_asc', offset: 50,
    }));
    expect(screen.getByRole('button', { name: /^Notes/u })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Search annotations')).toHaveValue('lease');
    expect(screen.getByLabelText('Sort annotations')).toHaveAttribute('data-value', 'created_asc');
    expect(screen.getAllByTestId('annotation-row')).toHaveLength(rowsBefore);
    expect(document.activeElement).toBe(focusBefore);
    expect(writes).toEqual([]);
    expect(revealRequest()).not.toBeNull();
  });
});
