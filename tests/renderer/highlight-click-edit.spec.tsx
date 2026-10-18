// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import {
  notePointerDetachOwner,
  notePointerPaint,
  resetNotePointer,
  type RangeLike,
} from '../../src/renderer/features/reader/annotations/note-pointer';
import type { UpdateAnnotationInput } from '@shared/types/annotation';
import type { ChatSelectionDescriptor } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { testReaderSession } from '../helpers/reader-session';
import { testAnnotation, testLoadedAnnotations } from '../helpers/annotation';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

/* A saved highlight is painted through the CSS Custom Highlight API, which
   gives the painted text no pointer events of its own; activation is geometric
   through the shared note-pointer registry, driven here with structural fake
   ranges because jsdom performs no layout. */

type RectTuple = readonly [l: number, t: number, r: number, b: number];

function fakeRange(rects: readonly RectTuple[]): RangeLike {
  const list = rects.map(([l, t, r, b]) => ({ left: l, top: t, right: r, bottom: b }));
  return { getClientRects: () => list };
}

const DOC: DocumentMetadata = {
  id: 'doc-1',
  title: 'doc-1',
  author: null,
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 10,
  fileMtimeMs: 0,
  fileHash: 'hash-1',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  source: null,
};

const HIGHLIGHT: Annotation = testAnnotation({
  id: 'hl-1',
  type: 'highlight',
  color: 'blue',
  selectedText: 'selected quote',
});

const RECT: readonly RectTuple[] = [[10, 40, 210, 60]];
const testOwner = {};

let chat: ChatStore;

beforeEach(() => {
  chat = createChatStore();
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 });
  document.body.replaceChildren();
  useAnnotationStore.setState({
    annotations: [HIGHLIGHT],
    selection: null,
    selectionIssue: null,
    error: null,
    loaded: testLoadedAnnotations('doc-1'),
    isLoading: false,
  });
  useReaderStore.setState({ session: testReaderSession(DOC), isLoading: false, error: null });
  resetNotePointer();
});

afterEach(() => {
  cleanup();
  chat.dispose();
  document.body.replaceChildren();
  resetNotePointer();
});

async function mountReader(): Promise<HTMLElement> {
  const { ReaderView } = await import('../../src/renderer/features/reader/ReaderView');
  renderWithChatStore(chat, <ReaderView />);
  return waitFor(() => screen.getByTestId('pdf-viewport-container'));
}

function clickAt(target: HTMLElement, x: number, y: number): void {
  fireEvent.pointerDown(target, { clientX: x, clientY: y, buttons: 1 });
  fireEvent.pointerUp(target, { clientX: x, clientY: y, buttons: 0 });
  fireEvent.click(target, { clientX: x, clientY: y, buttons: 0 });
}

const NOTE: Annotation = testAnnotation({
  id: 'note-1',
  type: 'note',
  color: null,
  note: 'A note over the highlight.',
  selectedText: 'selected quote',
});

/** The bridge as main answers it: one persisted list that update/delete edit. */
function stubAnnotationBridge(initial: readonly Annotation[]) {
  let persisted = [...initial];
  const update = vi.fn((input: UpdateAnnotationInput) => {
    const current = persisted.find((item) => item.id === input.id);
    if (current === undefined) return Promise.resolve(null);
    const next = { ...current, color: input.color ?? current.color };
    persisted = persisted.map((item) => item.id === next.id ? next : item);
    return Promise.resolve(next);
  });
  const remove = vi.fn((_documentId: string, id: string) => {
    const removed = persisted.find((item) => item.id === id) ?? null;
    persisted = persisted.filter((item) => item.id !== id);
    return Promise.resolve(removed);
  });
  const create = vi.fn();
  const page = vi.fn(() => Promise.resolve({ items: persisted, total: persisted.length, offset: 0, limit: 100 }));
  stubBridge({ annotations: { update, delete: remove, create, page } });
  return { update, remove, create };
}

async function openHighlight(): Promise<HTMLElement> {
  const container = await mountReader();
  clickAt(container, 100, 50);
  await screen.findByTestId('annotation-selection-toolbar');
  return container;
}

/** The toolbar's own error line; the stubbed reader shows an alert of its own. */
function toolbarAlert(): Promise<HTMLElement> {
  return within(screen.getByTestId('annotation-selection-toolbar')).findByRole('alert');
}

function toolbarQuery(): HTMLElement | null {
  return screen.queryByTestId('annotation-selection-toolbar');
}

function paintHighlight(annotations: readonly Annotation[] = [HIGHLIGHT]): void {
  notePointerPaint(testOwner, document, annotations.map((annotation) => ({ annotation, range: fakeRange(RECT) })));
}

const LIVE_DESCRIPTOR: ChatSelectionDescriptor = {
  format: 'markdown',
  startBlockIndex: 2,
  endBlockIndex: 2,
  startQuote: { exact: 'other words', prefix: '', suffix: '' },
  endQuote: { exact: 'other words', prefix: '', suffix: '' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saved highlight click-to-edit', () => {
  it('clicking already-highlighted text reopens the selection toolbar for that highlight', async () => {
    notePointerPaint(testOwner, document, [{ annotation: HIGHLIGHT, range: fakeRange(RECT) }]);
    const container = await mountReader();

    clickAt(container, 100, 50);

    const toolbar = await screen.findByTestId('annotation-selection-toolbar');
    expect(toolbar.getAttribute('data-editing-annotation-id')).toBe('hl-1');
    expect(screen.getByTestId('highlight-color-button-blue').getAttribute('aria-pressed')).toBe('true');
  });

  it('positions the toolbar from the clicked fragment and offers the edit actions', async () => {
    paintHighlight();
    await openHighlight();

    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe('Highlight actions');
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeTruthy();
    expect(screen.getByTestId('delete-highlight-button').textContent).toBe('Delete highlight');
    for (const swatch of screen.getAllByTestId(/^highlight-color-button-/)) {
      const pressed = swatch.getAttribute('data-testid') === 'highlight-color-button-blue';
      expect(swatch.getAttribute('aria-pressed')).toBe(String(pressed));
    }
  });

  it('recolours the same annotation id without creating another highlight', async () => {
    const bridge = stubAnnotationBridge([HIGHLIGHT]);
    paintHighlight();
    await openHighlight();

    fireEvent.click(screen.getByTestId('highlight-color-button-green'));

    await waitFor(() => {
      expect(screen.getByTestId('highlight-color-button-green').getAttribute('aria-pressed')).toBe('true');
    });
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'hl-1', color: 'green' });
    expect(bridge.create).not.toHaveBeenCalled();
    expect(screen.getByTestId('highlight-color-button-blue').getAttribute('aria-pressed')).toBe('false');
    expect(useAnnotationStore.getState().annotations.map((item) => [item.id, item.color])).toEqual([['hl-1', 'green']]);
    expect(screen.getByText('Highlight changed to Green')).toBeTruthy();

    // Choosing the colour it already has is not another write.
    fireEvent.click(screen.getByTestId('highlight-color-button-green'));
    expect(bridge.update).toHaveBeenCalledTimes(1);
  });

  it('shows a failed recolour and retries it on the next choice', async () => {
    const bridge = stubAnnotationBridge([HIGHLIGHT]);
    bridge.update.mockRejectedValueOnce(new Error('The database is busy.'));
    paintHighlight();
    await openHighlight();

    fireEvent.click(screen.getByTestId('highlight-color-button-pink'));
    expect((await toolbarAlert()).textContent).toBe('The database is busy.');
    expect(screen.getByTestId('highlight-color-button-blue').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('highlight-color-button-pink'));
    await waitFor(() => {
      expect(screen.getByTestId('highlight-color-button-pink').getAttribute('aria-pressed')).toBe('true');
    });
    expect(within(screen.getByTestId('annotation-selection-toolbar')).queryByRole('alert')).toBeNull();
    expect(bridge.update).toHaveBeenCalledTimes(2);
  });

  it('deletes the highlight and closes the toolbar; a failed delete stays visible', async () => {
    const bridge = stubAnnotationBridge([HIGHLIGHT]);
    bridge.remove.mockResolvedValueOnce(null);
    useAnnotationStore.setState({ error: null });
    paintHighlight();
    await openHighlight();

    fireEvent.click(screen.getByTestId('delete-highlight-button'));
    expect((await toolbarAlert()).textContent).toBe('Could not delete the highlight.');
    expect(toolbarQuery()).not.toBeNull();

    fireEvent.click(screen.getByTestId('delete-highlight-button'));
    await waitFor(() => { expect(toolbarQuery()).toBeNull(); });
    expect(bridge.remove).toHaveBeenLastCalledWith('doc-1', 'hl-1');
    expect(useAnnotationStore.getState().annotations).toEqual([]);
  });

  it('asks AI about the full saved passage through the existing chat context flow', async () => {
    const addSelectionContext = vi.fn(() => Promise.resolve(true));
    chat.setState({ addSelectionContext });
    paintHighlight();
    await openHighlight();

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));

    await waitFor(() => { expect(addSelectionContext).toHaveBeenCalledTimes(1); });
    expect(addSelectionContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1' }),
      expect.objectContaining({
        format: 'markdown',
        startBlockIndex: 1,
        endBlockIndex: 1,
        startQuote: HIGHLIGHT.anchor.quote,
        selectedTextSnippet: 'selected quote',
      }),
      true,
    );
    expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'chat' });
    await waitFor(() => { expect(toolbarQuery()).toBeNull(); });
  });

  it('leaves Focus Mode before Ask AI opens Chat', async () => {
    const addSelectionContext = vi.fn(() => Promise.resolve(true));
    chat.setState({ addSelectionContext });
    useUiStore.setState({ focusMode: false, focusSnapshot: null });
    act(() => { useUiStore.getState().toggleFocusMode(); });
    paintHighlight();
    await openHighlight();

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));

    await waitFor(() => { expect(addSelectionContext).toHaveBeenCalledTimes(1); });
    expect(useUiStore.getState()).toMatchObject({ focusMode: false, rightTab: 'chat', rightOpen: true });
  });

  it('a drag through highlighted text never opens the toolbar', async () => {
    paintHighlight();
    const container = await mountReader();

    fireEvent.pointerDown(container, { clientX: 20, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 150, clientY: 50, buttons: 1 });
    fireEvent.pointerUp(container, { clientX: 150, clientY: 50, buttons: 0 });
    fireEvent.click(container, { clientX: 150, clientY: 50, buttons: 0 });

    expect(toolbarQuery()).toBeNull();
  });

  it('a note painted over the highlight opens the note popover, not the toolbar', async () => {
    useAnnotationStore.setState({ annotations: [HIGHLIGHT, NOTE] });
    paintHighlight([HIGHLIGHT, NOTE]);
    const container = await mountReader();

    clickAt(container, 100, 50);

    await screen.findByTestId('note-popover');
    expect(toolbarQuery()).toBeNull();
  });

  it('a live selection takes the toolbar over from the reopened highlight', async () => {
    paintHighlight();
    await openHighlight();

    act(() => {
      useAnnotationStore.setState({
        selection: {
          selectedText: 'other words',
          totalSelectedLength: 11,
          chatDescriptor: LIVE_DESCRIPTOR,
          anchor: null,
          clientRect: { left: 10, top: 100, width: 80, height: 18 },
        },
      });
    });

    const toolbar = await screen.findByTestId('annotation-selection-toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe('Selection actions');
    expect(toolbar.hasAttribute('data-editing-annotation-id')).toBe(false);
    expect(screen.queryByTestId('delete-highlight-button')).toBeNull();
    act(() => { useAnnotationStore.setState({ selection: null }); });
    expect(toolbarQuery()).toBeNull();
  });

  it.each([
    ['a click away', (container: HTMLElement) => { clickAt(container, 600, 600); }],
    ['a scroll', (container: HTMLElement) => { fireEvent.scroll(container); }],
    ['Escape', () => { fireEvent.keyDown(document, { key: 'Escape' }); }],
    ['the surface detaching', () => { act(() => { notePointerDetachOwner(testOwner); }); }],
    ['a document switch', () => {
      act(() => { useReaderStore.setState({ session: testReaderSession({ ...DOC, id: 'doc-2', title: 'doc-2' }) }); });
    }],
  ])('%s dismisses the reopened highlight', async (_name, dismiss) => {
    paintHighlight();
    const container = await openHighlight();

    dismiss(container);

    await waitFor(() => { expect(toolbarQuery()).toBeNull(); });
  });

  it('keyboard activation focuses the current colour and Escape returns focus to the proxy', async () => {
    paintHighlight();
    await mountReader();
    const proxy = await screen.findByTestId('highlight-focus-proxy-hl-1');
    expect(proxy.getAttribute('aria-label')).toBe('Edit highlight: selected quote');

    proxy.focus();
    fireEvent.click(proxy);

    const pressed = await screen.findByTestId('highlight-color-button-blue');
    await waitFor(() => { expect(document.activeElement).toBe(pressed); });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(toolbarQuery()).toBeNull(); });
    expect(document.activeElement).toBe(proxy);
  });

  it('activates a highlight painted in a section iframe through its top-window geometry', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    await waitFor(() => { expect(frame.contentDocument?.body).toBeTruthy(); });
    const frameDoc = frame.contentDocument!;
    notePointerPaint(testOwner, frameDoc, [{ annotation: HIGHLIGHT, range: fakeRange(RECT) }], {
      toTopClientRect: (rect) => ({ left: rect.left + 200, top: rect.top + 200, right: rect.right + 200, bottom: rect.bottom + 200 }),
    });
    await mountReader();

    clickAt(frameDoc.body, 100, 50);

    const toolbar = await screen.findByTestId('annotation-selection-toolbar');
    expect(toolbar.getAttribute('data-editing-annotation-id')).toBe('hl-1');
    // Escape typed inside the section never reaches the top document.
    fireEvent.keyDown(frameDoc, { key: 'Escape' });
    await waitFor(() => { expect(toolbarQuery()).toBeNull(); });
  });
});
