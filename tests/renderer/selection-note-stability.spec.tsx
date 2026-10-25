// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { SELECTION_NOTE_HIGHLIGHT_NAME } from '../../src/renderer/features/reader/annotations/selection-note-paint';
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
 * Opening a note on a selected passage keeps the reader's place: the passage
 * stays marked while the note field holds focus, and the box grows down from
 * the toolbar's own top-left instead of moving or jumping across the selection.
 */

const now = '2026-10-25T12:00:00.000Z';
const QUOTE = 'selected quote';

const documentRecord: DocumentMetadata = {
  id: 'doc-1',
  title: 'Annotated Book',
  author: 'Reader',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'hash-doc-1',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: now,
  updatedAt: now,
  source: null,
};

const quote = { exact: QUOTE, prefix: 'before ', suffix: ' after' };

type Rect = { left: number; top: number; width: number; height: number };

/** The reader below a 48px header, as wide as jsdom's 1024px window. */
let readerRect: Rect = { left: 0, top: 48, width: 1024, height: 720 };
/** The toolbar's measured size: a bar when collapsed, a tall box with its note open. */
const COLLAPSED = { width: 648, height: 46 };
const OPEN = { width: 648, height: 225 };

function domRect({ left, top, width, height }: Rect): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

function selectPassage(clientRect: Rect, exact = QUOTE): void {
  useAnnotationStore.setState({
    selection: {
      selectedText: exact,
      totalSelectedLength: exact.length,
      chatDescriptor: {
        format: 'pdf',
        startPageIndex: 1,
        endPageIndex: 1,
        startPageLabel: '2',
        endPageLabel: '2',
        startQuote: { ...quote, exact },
        endQuote: { ...quote, exact },
      },
      anchor: { format: 'pdf', pageIndex: 1, quote: { ...quote, exact }, textStart: 7, textEnd: 7 + exact.length },
      clientRect,
    },
  });
}

/** A reader holding the passage, with the browser selection on `exact`. */
function mountReader(exact = QUOTE): HTMLElement {
  const reader = document.createElement('div');
  reader.dataset.readerFocusTarget = 'true';
  const paragraph = document.createElement('p');
  paragraph.textContent = `before ${QUOTE} after, and another passage`;
  reader.append(paragraph);
  document.body.append(reader);
  const text = paragraph.firstChild!;
  const start = text.textContent!.indexOf(exact);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + exact.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  return reader;
}

const toolbar = () => screen.getByTestId('annotation-selection-toolbar');
const placed = () => ({ left: parseFloat(toolbar().style.left), top: parseFloat(toolbar().style.top) });
const paint = () => window.CSS.highlights.get(SELECTION_NOTE_HIGHLIGHT_NAME);
const paintedText = () => [...(paint() ?? [])].map((range) => (range as Range).toString());

function openNote(): void {
  const addNote = screen.getAllByRole('button', { name: 'Add note' })
    .find((button) => button.getAttribute('aria-controls') === 'selection-note-popover');
  fireEvent.click(addNote!);
}

let chat: ChatStore;
const create = vi.fn();

beforeEach(() => {
  cleanup();
  chat = createChatStore();
  create.mockReset();
  stubBridge(testInterleafApi({ annotations: { create, list: vi.fn().mockResolvedValue([]) } }));
  useAnnotationStore.getState().reset();
  useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
  useReaderStore.setState({ session: testReaderSession(documentRecord), currentPage: 2, pageCount: 5 });
  useUiStore.setState({ rightOpen: false, rightTab: 'chat', focusMode: false, compactActivePanel: null });
  seatReaderAdapter(testDocumentAdapter('pdf', {
    getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 1 }, progress: 0.4 }),
    getCurrentPage: () => 2,
  }));
  readerRect = { left: 0, top: 48, width: 1024, height: 720 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measured(this: HTMLElement) {
    if (this.dataset.readerFocusTarget === 'true') return domRect(readerRect);
    if (this.dataset.testid === 'annotation-selection-toolbar') {
      const size = this.dataset.noteOpen === 'true' ? OPEN : COLLAPSED;
      return domRect({ left: 0, top: 0, ...size });
    }
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(() => {
  cleanup();
  chat.dispose();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('where the open note box sits', () => {
  it('opens at the bar\'s own top-left above a selection near the top, covering the passage rather than flipping below', () => {
    mountReader();
    // Room above for the bar, not for the open box: it used to flip below.
    selectPassage({ left: 300, top: 160, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const collapsed = placed();
    expect(collapsed.top + COLLAPSED.height).toBeLessThanOrEqual(160);

    openNote();
    expect(placed()).toEqual(collapsed);
  });

  it('grows down from the bar above a mid-page selection, keeping its top and left', () => {
    mountReader();
    selectPassage({ left: 300, top: 400, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const collapsed = placed();
    expect(collapsed.top + COLLAPSED.height).toBeLessThanOrEqual(400);
    openNote();
    const open = placed();
    expect(open.top).toBe(collapsed.top);
    expect(open.left).toBe(collapsed.left);
    // Typing re-renders the box; it does not move.
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), { target: { value: 'A thought' } });
    expect(placed()).toEqual(collapsed);
  });

  it('moves up by only the least that keeps a box near the reader\'s foot inside it', () => {
    mountReader();
    selectPassage({ left: 300, top: 700, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const collapsed = placed();
    openNote();
    const open = placed();
    expect(open.left).toBe(collapsed.left);
    expect(open.top + OPEN.height).toBe(readerRect.top + readerRect.height - 8);
    expect(open.top).toBeLessThan(collapsed.top);
  });

  it('grows down from a bar below a selection at the top of the reader', () => {
    mountReader();
    selectPassage({ left: 300, top: 60, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const collapsed = placed();
    expect(collapsed.top).toBeGreaterThan(60);
    openNote();
    expect(placed()).toEqual(collapsed);
  });

  it('stays inside a narrow reader, and re-clamps when the window shrinks', () => {
    readerRect = { left: 0, top: 48, width: 400, height: 720 };
    mountReader();
    selectPassage({ left: 300, top: 400, width: 60, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const collapsed = placed();
    openNote();
    expect(placed().left).toBe(collapsed.left);
    expect(toolbar().style.maxWidth).toBe('384px');

    readerRect = { left: 0, top: 48, width: 400, height: 260 };
    act(() => { window.dispatchEvent(new Event('resize')); });
    // Moved up by just enough that the box ends inside the shorter reader.
    expect(placed().top + OPEN.height).toBe(readerRect.top + readerRect.height - 8);
    // Never taller than the reader: what does not fit scrolls inside the box.
    expect(toolbar().style.maxHeight).toBe('244px');
    expect(toolbar().style.overflowY).toBe('auto');
  });
});

describe('the passage while its note is open', () => {
  it('stays marked on the exact passage while the note field holds focus, without a saved annotation', () => {
    mountReader();
    selectPassage({ left: 300, top: 400, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    expect(paint()).toBeUndefined();

    openNote();
    expect(screen.getByRole('textbox', { name: 'Note on selected text' })).toHaveFocus();
    expect(paintedText()).toEqual([QUOTE]);
    expect(create).not.toHaveBeenCalled();
  });

  it('is unmarked when the note closes', async () => {
    mountReader();
    selectPassage({ left: 300, top: 400, width: 200, height: 20 });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    openNote();
    fireEvent.click(screen.getByRole('button', { name: /^Done/u }));
    await waitFor(() => { expect(toolbar()).not.toHaveAttribute('data-note-open'); });
    expect(paint()).toBeUndefined();
  });

  it('is unmarked by a new selection, and by the toolbar going away', () => {
    mountReader();
    selectPassage({ left: 300, top: 400, width: 200, height: 20 });
    const view = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    openNote();
    act(() => { selectPassage({ left: 300, top: 400, width: 200, height: 20 }, 'another passage'); });
    expect(paint()).toBeUndefined();

    openNote();
    view.unmount();
    expect(paint()).toBeUndefined();
  });
});
