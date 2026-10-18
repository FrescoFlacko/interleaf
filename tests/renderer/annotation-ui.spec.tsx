// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { Annotation } from '@shared/types/annotation';
import { HIGHLIGHT_COLOR_OPTIONS } from '@shared/constants/annotations';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { hasOpenTopLayer, useShortcuts } from '../../src/renderer/hooks/use-shortcuts';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const now = '2026-08-24T12:00:00.000Z';
const documentRecord: DocumentMetadata = {
  id: 'doc-1',
  title: 'Annotated Book',
  author: 'Reader',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'hash-v1',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: now,
  updatedAt: now,
  source: null,
};

const rangeAnchor = {
  format: 'pdf' as const,
  pageIndex: 1,
  quote: { exact: 'selected quote', prefix: 'before ', suffix: ' after' },
  textStart: 7,
  textEnd: 21,
};

const defaultChatDescriptor = {
  format: 'pdf' as const,
  startPageIndex: 1,
  endPageIndex: 1,
  startPageLabel: '2',
  endPageLabel: '2',
  startQuote: { exact: 'selected quote', prefix: 'before ', suffix: ' after' },
  endQuote: { exact: 'selected quote', prefix: 'before ', suffix: ' after' },
};
/** `#facc15` in the form `style.backgroundColor` reports it back as. */
function hexToRgbString(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 0xff)}, ${String((value >> 8) & 0xff)}, ${String(value & 0xff)})`;
}

type Selection = NonNullable<ReturnType<typeof useAnnotationStore.getState>['selection']>;

/** Selects a passage in the reader; overrides replace the default quote, descriptor, or anchor. */
function selectPassage(overrides: Partial<Selection> = {}): void {
  useAnnotationStore.setState({
    selection: {
      selectedText: 'selected quote',
      totalSelectedLength: 14,
      chatDescriptor: defaultChatDescriptor,
      anchor: rangeAnchor,
      clientRect: { left: 20, top: 100, width: 100, height: 20 },
      ...overrides,
    },
  });
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-highlight',
    documentId: 'doc-1',
    documentHash: 'hash-v1',
    type: 'highlight',
    anchor: rangeAnchor,
    selectedText: 'selected quote',
    note: null,
    label: null,
    color: 'yellow',
    isLocationNote: false,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('annotation renderer UX', () => {
  const create = vi.fn();
  const list = vi.fn();
  const page = vi.fn();
  const update = vi.fn();
  const deleteAnnotation = vi.fn();
  const repairAnchor = vi.fn();
  const clipboardWriteText = vi.fn();

  beforeEach(() => {
    cleanup();
    const attachContext = vi.fn(() =>
      Promise.resolve({
        id: 'ctx-sel',
        sessionId: 'session-1',
        kind: 'selection' as const,
        sourceRef: {},
        excerptText: 'selected quote',
        excerptHash: 'h-1',
        documentHash: 'hash-v1',
        location: { format: 'pdf' as const, pageIndex: 1 },
        provenance: {},
        displayLabel: '“selected quote”',
        pinned: true,
        createdAt: now,
      })
    );
    const api = testInterleafApi({
      annotations: {
        create,
        list,
        page,
        update,
        delete: deleteAnnotation,
        repairAnchor,
      },
      chat: {
        attachContext,
        listSessions: vi.fn(() => Promise.resolve([{
          id: 'session-1',
          documentId: 'doc-1',
          documentHash: 'hash-v1',
          title: 'Notes',
          providerId: 'fake' as const,
          modelId: 'fake-grounded',
          reasoningEffort: null,
          messageCount: 0,
          previewText: null,
          compactedThroughOrdinal: null,
          isArchived: false,
          createdAt: now,
          updatedAt: now,
        }])),
        createSession: vi.fn(),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        cancel: vi.fn(() => Promise.resolve(undefined)),
        onStreamEvent: vi.fn(() => () => {
          // unregister noop
        }),
      },
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
      },
      clipboard: {
        writeText: clipboardWriteText,
      },
    });
    clipboardWriteText.mockResolvedValue({ copied: true as const, characterCount: 14 });
    stubBridge(api);
    useAnnotationStore.getState().reset();
    useAgentStore.setState({ contextPacket: null, activeSession: null, events: [], sessions: [], error: null });
    useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
    useReaderStore.setState({
      session: testReaderSession(documentRecord),
      currentPage: 2,
      pageCount: 5,
      zoom: 1,
      zoomMode: 'fit-width',
      tableOfContents: [],
      isTocOpen: false,
    });
    useUiStore.setState({ rightOpen: false, rightTab: 'chat', focusMode: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('creates a named-color highlight from a normalized selection', async () => {
    const created = annotation({ color: 'green' });
    create.mockResolvedValue(created);
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    expect(screen.getByRole('button', { name: 'Yellow highlight' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purple highlight' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Green highlight' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        documentId: 'doc-1',
        type: 'highlight',
        anchor: rangeAnchor,
        selectedText: 'selected quote',
        color: 'green',
      });
    });
    expect(useAnnotationStore.getState().selection).toBeNull();
    expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'annotations' });
  });

  it('shows the five highlight actions as real painted swatches that name themselves on hover and focus', async () => {
    create.mockResolvedValue(annotation({ color: 'blue' }));
    selectPassage();
    const { container } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    // The order the reader sees is the shared definition's order.
    expect(
      screen.getAllByTestId(/^highlight-color-button-/).map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Yellow highlight', 'Blue highlight', 'Green highlight', 'Pink highlight', 'Purple highlight']);

    for (const option of HIGHLIGHT_COLOR_OPTIONS) {
      const button = screen.getByRole('button', { name: `${option.label} highlight` });
      expect(button).toHaveAttribute('title', `${option.label} highlight`);
      // Applying a color is an immediate action, not a selection state.
      expect(button).not.toHaveAttribute('aria-pressed');
      // No initial survives: the color has to carry itself.
      expect(button.textContent).toBe('');

      const swatch = within(button).getByTestId(`highlight-color-swatch-${option.id}`);
      expect(swatch).toHaveAttribute('aria-hidden', 'true');
      // The paint is the shared definition's own value, at full opacity, from an
      // inline style the production build cannot drop.
      expect(swatch.style.backgroundColor).toBe(hexToRgbString(option.hexValue));
    }

    // Hovering names the color in visible text, and stops naming it on exit.
    const name = screen.getByTestId('highlight-color-name');
    expect(name.textContent).toBe('');
    const green = screen.getByRole('button', { name: 'Green highlight' });
    fireEvent.mouseOver(green);
    expect(name).toBeVisible();
    expect(name.textContent).toBe('Green');
    fireEvent.mouseOut(green);
    expect(name.textContent).toBe('');

    // Keyboard focus names it too; `title` alone would never reach a keyboard.
    const pink = screen.getByRole('button', { name: 'Pink highlight' });
    act(() => { pink.focus(); });
    expect(pink).toHaveFocus();
    expect(name).toBeVisible();
    expect(name.textContent).toBe('Pink');
    act(() => { pink.blur(); });
    expect(name.textContent).toBe('');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);

    // And the swatch still creates the color it paints.
    fireEvent.click(screen.getByRole('button', { name: 'Blue highlight' }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        documentId: 'doc-1',
        type: 'highlight',
        anchor: rangeAnchor,
        selectedText: 'selected quote',
        color: 'blue',
      });
    });
  });

  it('submits an untrusted selection packet and moves focus to the agent task', async () => {
    const task = document.createElement('textarea');
    task.id = 'agent-task-description';
    document.body.appendChild(task);
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit selected passage to agent' }));
    await waitFor(() => { expect(document.activeElement).toBe(task); });
    expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'agent' });
    expect(useAgentStore.getState().contextPacket).toMatchObject({
      document: { id: 'doc-1', hash: 'hash-v1', title: 'Annotated Book', author: 'Reader' },
      selection: { exactQuote: 'selected quote', surroundingText: 'before  …  after' },
      provenance: { contentIsUntrustedReference: true },
    });
  });

  it('copies selected text via interleafAPI clipboard and updates status to Copied', async () => {
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    const copyButton = screen.getByRole('button', { name: 'Copy' });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('selected quote');
    });
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('displays Copy failed when clipboard writeText rejects or fails', async () => {
    clipboardWriteText.mockRejectedValueOnce(new Error('Copy rejected'));
    selectPassage({
      selectedText: 'failing quote',
      totalSelectedLength: 13,
    });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    const copyButton = screen.getByRole('button', { name: 'Copy' });
    fireEvent.click(copyButton);

    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('filters, jumps, edits, and confirms deletion in the annotation browser', async () => {
    const jump = vi.fn(() => Promise.resolve());
    seatReaderAdapter(testDocumentAdapter('pdf', { goToAnnotation: jump }));
    const highlight = annotation();
    const bookmark = annotation({
      id: 'ann-bookmark',
      type: 'bookmark',
      anchor: { format: 'pdf', pageIndex: 3, quote: { exact: '', prefix: '', suffix: '' } },
      selectedText: null,
      color: null,
      label: 'Review later',
    });
    page.mockImplementation((_documentId: string, filter?: { searchQuery?: string }) => {
      const items = filter?.searchQuery ? [bookmark] : [highlight, bookmark];
      return Promise.resolve({ items, total: items.length, offset: 0, limit: filter?.searchQuery ? 50 : 100 });
    });
    update.mockImplementation((input: { id: string; note?: string | null }) =>
      Promise.resolve(annotation({ note: input.note ?? null }))
    );
    list.mockResolvedValue([highlight, bookmark]);
    deleteAnnotation.mockResolvedValue(bookmark);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithChatStore(chat, <AnnotationBrowser />);

    await screen.findByText('Review later');

    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: 'Review later' } });
    expect(screen.getByText('Review later')).toBeInTheDocument();
    await waitFor(() => { expect(screen.queryByText('“selected quote”')).toBeNull(); });
    fireEvent.change(screen.getByLabelText('Search annotations'), { target: { value: '' } });
    await screen.findByText('“selected quote”');

    fireEvent.click(screen.getAllByRole('button', { name: 'Jump' })[0]!);
    expect(jump).toHaveBeenCalledWith(highlight);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'Useful connection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-highlight', note: 'Useful connection' });
    });

    // Deletion is deliberately one step removed from the row's own controls:
    // it lives behind that row's overflow menu, so a mis-aimed click on a dense
    // list cannot destroy an annotation.
    fireEvent.click(screen.getAllByTestId('annotation-row-menu')[1]!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => { expect(deleteAnnotation).toHaveBeenCalledWith('doc-1', 'ann-bookmark'); });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('creates bookmarks and location notes from the adapter reading location', async () => {
    const adapter = testDocumentAdapter('pdf', {
      getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 1 }, progress: 0.4 }),
      getCurrentPage: () => 2,
    });
    seatReaderAdapter(adapter);
    create.mockImplementation((input: { type: string }) =>
      Promise.resolve(annotation({
        id: input.type === 'bookmark' ? 'bookmark-new' : 'note-new',
        type: input.type === 'bookmark' ? 'bookmark' : 'note',
      }))
    );
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);

    fireEvent.click(screen.getByTestId('add-bookmark-button'));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        documentId: 'doc-1',
        type: 'bookmark',
        label: 'Page 2',
        anchor: expect.objectContaining({ format: 'pdf', pageIndex: 1 }),
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note at current location' }), { target: { value: 'Check this page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        documentId: 'doc-1',
        type: 'note',
        note: 'Check this page',
        isLocationNote: true,
      }));
    });
  });

  it('dismisses note popovers with Escape and restores focus to their invokers', async () => {
    selectPassage();
    const { unmount } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const selectionInvoker = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(selectionInvoker);
    const selectionDialog = screen.getByRole('dialog', { name: 'Note on selected text' });
    expect(selectionDialog).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note on selected text' }), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Note on selected text' })).toBeNull();
      expect(selectionInvoker).toHaveFocus();
    });
    unmount();

    const adapter = testDocumentAdapter('pdf', {
      getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 1 }, progress: 0.4 }),
      getCurrentPage: () => 2,
    });
    seatReaderAdapter(adapter);
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    const locationInvoker = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(locationInvoker);
    expect(screen.getByRole('dialog', { name: 'Note at current location' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note at current location' }), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Note at current location' })).toBeNull();
      expect(locationInvoker).toHaveFocus();
    });
  });

  it('passes a WCAG audit with the selection note dialog expanded', async () => {
    selectPassage();
    const { container } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await screen.findByRole('dialog', { name: 'Note on selected text' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('says why an empty note cannot be saved, and drops the hint once there is text', () => {
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    const field = screen.getByRole('textbox', { name: 'Note on selected text' });
    expect(screen.getByTestId('selection-note-empty')).toHaveTextContent('Write something to save this note.');
    expect(field.getAttribute('aria-describedby')).toBe('selection-note-empty');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'A thought' } });
    expect(screen.queryByTestId('selection-note-empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
  });

  it('shows a failed note save inside the note editor and keeps the draft', async () => {
    create.mockRejectedValue(new Error('The annotation could not be saved.'));
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    const field = screen.getByRole('textbox', { name: 'Note on selected text' });
    fireEvent.change(field, { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    const dialog = await screen.findByRole('dialog', { name: 'Note on selected text' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The annotation could not be saved. Your note is still here, so you can try again.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(field).toHaveValue('Keep me');
    // The recovery hint is its own line, not run on after the diagnostic text.
    const lines = Array.from(alert.querySelectorAll('p'), (line) => line.textContent);
    expect(lines).toEqual(['The annotation could not be saved.', 'Your note is still here, so you can try again.']);
    // A failed save describes the field; it does not call the note invalid.
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
  });

  it('keeps the toolbar inside the reader rather than over the companion panel', () => {
    const reader = document.createElement('div');
    reader.dataset.readerFocusTarget = 'true';
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 40, width: 800, height: 700 });
    document.body.appendChild(reader);
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
    selectPassage({ clientRect: { left: 960, top: 300, width: 30, height: 20 } });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    // The unmeasured toolbar is assumed 420 wide: right edge 1000 - 8 margin.
    expect(toolbar.style.left).toBe('572px');
    expect(toolbar.style.maxWidth).toBe('784px');
    reader.remove();
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  });

  it('re-clamps the toolbar when a failed save widens it, instead of letting it grow over the companion', async () => {
    const reader = document.createElement('div');
    reader.dataset.readerFocusTarget = 'true';
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 40, width: 800, height: 700 });
    document.body.appendChild(reader);
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
    // The error line is what widens the box; the measurement follows it.
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== 'annotation-selection-toolbar') return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      return DOMRect.fromRect({ x: 0, y: 0, width: this.querySelector('[role="alert"]') === null ? 420 : 700, height: 200 });
    });
    create.mockRejectedValue(new Error('The annotation could not be saved.'));
    selectPassage({ clientRect: { left: 960, top: 300, width: 30, height: 20 } });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    expect(toolbar.style.left).toBe('572px');

    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByTestId('selection-note-error');
    // Reader right edge 1000, less the 700 px box and the 8 px margin.
    await waitFor(() => { expect(toolbar.style.left).toBe('292px'); });
    measure.mockRestore();
    reader.remove();
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  });

  it('keeps the box inside the reader when the note field is dragged taller', () => {
    const reader = document.createElement('div');
    reader.dataset.readerFocusTarget = 'true';
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 40, width: 800, height: 700 });
    document.body.appendChild(reader);
    // A drag on the resize handle changes the box without a render; only the
    // browser's resize notice reports it.
    const notices: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notices.push(callback); }
      observe(): void { /* the test delivers notices by hand */ }
      disconnect(): void { /* nothing to release */ }
    });
    let height = 200;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== 'annotation-selection-toolbar') return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      return DOMRect.fromRect({ x: 0, y: 0, width: 420, height });
    });
    selectPassage({ clientRect: { left: 400, top: 300, width: 30, height: 20 } });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    const note = screen.getByRole('textbox', { name: 'Note on selected text' });
    expect(toolbar.style.top).toBe('92px');

    height = 680;
    act(() => { for (const notify of notices) notify(); });
    // Reader top 40 plus the 8 px margin; the 680 px box now ends at 728, inside the reader's 740.
    expect(toolbar.style.top).toBe('48px');
    expect(note).toHaveFocus();
    measure.mockRestore();
    vi.unstubAllGlobals();
    reader.remove();
  });

  it('draws every selection action from one button recipe, with Ask AI as the accent', () => {
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const names = ['Add note', 'Copy', 'Ask AI', 'Submit selected passage to agent'];
    const classes = names.map((name) => screen.getByRole('button', { name }).className);
    for (const className of classes) {
      expect(className).toContain('h-7');
      expect(className).not.toContain('border');
    }
    expect(classes[2]).toContain('text-accent');
    expect(classes.filter((className) => className.includes('text-accent'))).toHaveLength(1);
  });

  it('moves focus to the reader after a selected-text note is saved by keyboard', async () => {
    const readerTarget = document.createElement('div');
    readerTarget.tabIndex = -1;
    readerTarget.dataset.readerFocusTarget = 'true';
    document.body.appendChild(readerTarget);
    create.mockResolvedValue(annotation({ id: 'range-note', type: 'note', note: 'Keyboard note', color: null }));
    selectPassage();
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    const invoker = screen.getByRole('button', { name: 'Add note' });
    invoker.focus();
    fireEvent.keyDown(invoker, { key: 'Enter' });
    fireEvent.click(invoker);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), {
      target: { value: 'Keyboard note' },
    });
    const save = screen.getByRole('button', { name: 'Save note' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Enter' });
    fireEvent.click(save);

    await waitFor(() => { expect(readerTarget).toHaveFocus(); });
    readerTarget.remove();
  });

  it('passes a WCAG audit with explicit type, color, and location labels', async () => {
    page.mockResolvedValue({ items: [annotation()], total: 1, offset: 0, limit: 50 });
    const { container } = renderWithChatStore(chat, <AnnotationBrowser />);
    await screen.findByText('“selected quote”');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('paginates more than 10,000 annotations while keeping the mounted card DOM bounded', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => annotation({ id: `ann-${String(index)}` }));
    page.mockResolvedValue({ items: firstPage, total: 10_001, offset: 0, limit: 50 });
    renderWithChatStore(chat, <AnnotationBrowser />);

    await screen.findByText('10001 in this document');
    expect(screen.getByTestId('annotation-page-list').children).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(page).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ offset: 50, limit: 50 }));
    });
    expect(screen.getByTestId('annotation-page-list').children.length).toBeLessThanOrEqual(50);
  });

  it('refreshes the paged browser after an automatic anchor repair', async () => {
    const original = annotation();
    const repaired = annotation({ documentHash: 'hash-v2', status: 'unanchored' });
    let repairComplete = false;
    page.mockImplementation(() => Promise.resolve({
      items: [repairComplete ? repaired : original],
      total: 1,
      offset: 0,
      limit: 50,
    }));
    repairAnchor.mockImplementation(() => {
      repairComplete = true;
      return Promise.resolve(repaired);
    });
    useAnnotationStore.setState({ annotations: [original] });
    renderWithChatStore(chat, <AnnotationBrowser />);
    // A working anchor is the expectation, so it carries no badge at all: the
    // row simply says nothing about anchoring.
    await waitFor(() => {
      expect(screen.getByTestId('annotation-row')).toHaveAttribute('data-annotation-status', 'anchored');
    });
    expect(screen.queryByTestId('annotation-unanchored-warning')).toBeNull();

    await useAnnotationStore.getState().repairResolution('hash-v2', {
      annotationId: original.id,
      status: 'unanchored',
      anchor: original.anchor,
      stage: 'unanchored',
    });

    // Losing the anchor is the only state worth chrome, and it is stated in
    // the reader's terms rather than as a status word — naming what was lost,
    // which here is a highlight rather than a note.
    await screen.findByText('Text moved — this highlight lost its place in the page');
    expect(page.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('attaches the selection to chat from the single Ask AI action', async () => {
    selectPassage();
    const nonceBefore = chat.getState().composerFocusNonce;
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    // Ask AI is the only chat-context action; the redundant second button that
    // attached the same passage without asking anything is gone.
    expect(screen.queryByRole('button', { name: 'AI context' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Context' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Ask AI$/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => {
      expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'chat' });
      expect(useAnnotationStore.getState().selection).toBeNull();
    });
    // Ask AI always hands the composer the question it just armed.
    expect(chat.getState().composerFocusNonce).toBe(nonceBefore + 1);
    expect(chat.getState().composerPlaceholder).toBe('Ask something about this passage…');
  });

  it('enforces separate annotation limits on highlight/note while allowing Ask AI on large selections', async () => {
    const hugeAnchor = {
      format: 'pdf' as const,
      pageIndex: 0,
      quote: { exact: 'huge quote', prefix: '', suffix: '' },
      segments: [
        { pageIndex: 0, quote: { exact: 'p1', prefix: '', suffix: '' } },
        { pageIndex: 55, quote: { exact: 'p56', prefix: '', suffix: '' } },
      ],
    };

    selectPassage({
      selectedText: 'huge quote across 56 pages',
      chatDescriptor: {
        format: 'pdf' as const,
        startPageIndex: 0,
        endPageIndex: 55,
        startPageLabel: '1',
        endPageLabel: '56',
      },
      anchor: hugeAnchor,
    });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    create.mockClear();
    // 1. Try to create a highlight on >50 page selection -> shows action error
    fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Highlights and notes are limited to 50 pages');
    });
    expect(create).not.toHaveBeenCalled();

    // 2. Click "Ask AI" on the same large selection -> succeeds and attaches to Chat
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => {
      expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'chat' });
      expect(useAnnotationStore.getState().selection).toBeNull();
    });
  });

  it('enforces the Agent context limit on submit to agent while allowing Ask AI', async () => {
    const largeText = 'A'.repeat(256_001);
    selectPassage({
      selectedText: largeText,
      totalSelectedLength: largeText.length,
    });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);

    // 1. Try submit to agent -> shows action error
    fireEvent.click(screen.getByRole('button', { name: 'Submit selected passage to agent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Agent context is limited to 256,000 characters');
    });

    // 2. Click "Ask AI" -> succeeds
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => {
      expect(useUiStore.getState()).toMatchObject({ rightOpen: true, rightTab: 'chat' });
    });
  });
  it('validates annotation error order: checks descriptor span first even when anchor is null', async () => {
    // 1. PDF 51 pages (0 -> 50) with anchor: null -> returns 50 page span limit, not mapping failure
    selectPassage({
      selectedText: 'A'.repeat(100),
      totalSelectedLength: 100,
      chatDescriptor: {
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 50, // 51 pages
        startPageLabel: '1',
        endPageLabel: '51',
      },
      anchor: null,
    });
    const { unmount } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Highlights and notes are limited to 50 pages. Use Ask AI for large ranges.');
    });
    unmount();

    // 2. Markdown 101 blocks (0 -> 100) with anchor: null -> returns 100 block span limit
    selectPassage({
      selectedText: 'A'.repeat(100),
      totalSelectedLength: 100,
      chatDescriptor: {
        format: 'markdown',
        startBlockIndex: 0,
        endBlockIndex: 100, // 101 blocks
      },
      anchor: null,
    });
    const { unmount: unmountMd } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Highlights and notes are limited to 100 blocks. Use Ask AI for large ranges.');
    });
    unmountMd();

    // 3. Size > 256,000 characters with anchor: null -> returns size limit
    selectPassage({
      selectedText: 'A'.repeat(100),
      totalSelectedLength: 256_001,
      chatDescriptor: {
        format: 'markdown',
        startBlockIndex: 0,
        endBlockIndex: 5,
      },
      anchor: null,
    });
    const { unmount: unmountSize } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Highlights and notes are limited to 256,000 characters. Use Ask AI for large passages.');
    });
    unmountSize();

    // 4. Within limits but anchor: null -> returns mapping failure message
    selectPassage({
      selectedText: 'Short text',
      totalSelectedLength: 10,
      chatDescriptor: {
        format: 'markdown',
        startBlockIndex: 0,
        endBlockIndex: 0,
      },
      anchor: null,
    });
    renderWithChatStore(chat, <AnnotationSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Highlights and notes could not be mapped to document segments deterministically. Use Ask AI for this selection.');
    });
  });

  describe('selection actions inside Focus Mode', () => {
    /**
     * Enters Focus Mode from a deliberately non-default workspace through the
     * real store action, so the snapshot an exiting action restores is the one
     * production captures rather than a hand-written `focusMode: true`.
     */
    function enterFocusMode(): void {
      useUiStore.setState({
        leftOpen: true,
        rightOpen: true,
        leftWidth: 300,
        rightWidth: 360,
        rightTab: 'annotations',
        focusMode: false,
        focusSnapshot: null,
      });
      act(() => { useUiStore.getState().toggleFocusMode(); });
      expect(useUiStore.getState()).toMatchObject({ focusMode: true, leftOpen: false, rightOpen: false });
    }

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
      useUiStore.setState({ compactActivePanel: null });
    });

    it('keeps a highlight created in Focus Mode inside Focus Mode', async () => {
      create.mockResolvedValue(annotation({ color: 'yellow' }));
      selectPassage();
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
      await waitFor(() => {
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'highlight', color: 'yellow' }));
      });
      expect(useUiStore.getState().focusMode).toBe(true);
      expect(useUiStore.getState().focusSnapshot).not.toBeNull();
      expect(useAnnotationStore.getState().selection).toBeNull();
    });

    it('keeps a note saved in Focus Mode inside Focus Mode', async () => {
      create.mockResolvedValue(annotation({ id: 'focus-note', type: 'note', note: 'Focused note', color: null }));
      selectPassage();
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), {
        target: { value: 'Focused note' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
      await waitFor(() => {
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'note', note: 'Focused note' }));
      });
      expect(useUiStore.getState().focusMode).toBe(true);
      expect(useUiStore.getState().focusSnapshot).not.toBeNull();
    });

    it('exits Focus Mode and restores the workspace before Ask AI opens Chat', async () => {
      selectPassage();
      enterFocusMode();
      const nonceBefore = chat.getState().composerFocusNonce;
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
      await waitFor(() => {
        expect(useAnnotationStore.getState().selection).toBeNull();
      });
      const ui = useUiStore.getState();
      expect(ui.focusMode).toBe(false);
      expect(ui.focusSnapshot).toBeNull();
      // The pre-focus workspace is back...
      expect(ui).toMatchObject({ leftOpen: true, leftWidth: 300, rightWidth: 360, rightOpen: true });
      // ...but Chat, requested after the restore, wins over the snapshot's tab.
      expect(ui.rightTab).toBe('chat');
      expect(chat.getState().composerFocusNonce).toBe(nonceBefore + 1);
      expect(chat.getState().composerPlaceholder).toBe('Ask something about this passage…');
    });

    it('exits Focus Mode and opens Agent once a submission passes validation', async () => {
      // Earlier tests append their own task field to the body; the component
      // focuses the first match, so this test owns the only one.
      for (const stale of document.querySelectorAll('#agent-task-description')) stale.remove();
      const task = document.createElement('textarea');
      task.id = 'agent-task-description';
      document.body.appendChild(task);
      selectPassage();
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Submit selected passage to agent' }));
      await waitFor(() => { expect(document.activeElement).toBe(task); });
      const ui = useUiStore.getState();
      expect(ui.focusMode).toBe(false);
      expect(ui.focusSnapshot).toBeNull();
      expect(ui).toMatchObject({ leftOpen: true, leftWidth: 300, rightWidth: 360, rightOpen: true });
      expect(ui.rightTab).toBe('agent');
      expect(useAgentStore.getState().contextPacket).toMatchObject({
        document: { id: 'doc-1', hash: 'hash-v1' },
        selection: { exactQuote: 'selected quote' },
      });
      task.remove();
    });

    it('keeps Focus Mode and shows the error when an agent submission fails validation', async () => {
      const largeText = 'A'.repeat(256_001);
      selectPassage({
        selectedText: largeText,
        totalSelectedLength: largeText.length,
      });
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Submit selected passage to agent' }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Agent context is limited to 256,000 characters');
      });
      expect(useUiStore.getState().focusMode).toBe(true);
      expect(useUiStore.getState().rightTab).not.toBe('agent');
      expect(useAgentStore.getState().contextPacket).toBeNull();
      // The rejected selection is still there to narrow.
      expect(useAnnotationStore.getState().selection).not.toBeNull();
    });

    it('leaves the compact companion drawer closed when a Focus Mode highlight or note succeeds', async () => {
      // Below 920px `showRightTab` opens the compact drawer, which would cover
      // and inert the distraction-free reader these two actions stay inside.
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
      create.mockResolvedValue(annotation({ color: 'yellow' }));
      selectPassage();
      enterFocusMode();
      // A tab the annotations destination would visibly overwrite.
      useUiStore.setState({ rightTab: 'chat', compactActivePanel: null });
      const { unmount } = renderWithChatStore(chat, <AnnotationSelectionToolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Yellow highlight' }));
      await waitFor(() => { expect(useAnnotationStore.getState().selection).toBeNull(); });
      expect(useUiStore.getState()).toMatchObject({
        focusMode: true,
        compactActivePanel: null,
        rightTab: 'chat',
      });
      unmount();

      create.mockResolvedValue(annotation({ id: 'focus-note', type: 'note', note: 'Focused note', color: null }));
      selectPassage();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Note on selected text' }), {
        target: { value: 'Focused note' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
      await waitFor(() => { expect(useAnnotationStore.getState().selection).toBeNull(); });
      expect(useUiStore.getState()).toMatchObject({
        focusMode: true,
        compactActivePanel: null,
        rightTab: 'chat',
      });
    });

    it('dismisses the toolbar on the first Escape and exits Focus Mode on the next', async () => {
      const readerTarget = document.createElement('div');
      readerTarget.tabIndex = -1;
      readerTarget.dataset.readerFocusTarget = 'true';
      document.body.appendChild(readerTarget);
      selectPassage();
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);
      renderHook(() => { useShortcuts(); });

      // The visible toolbar is a top layer, so Escape belongs to it first.
      expect(hasOpenTopLayer()).toBe(true);
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => { expect(readerTarget).toHaveFocus(); });
      expect(useAnnotationStore.getState().selection).toBeNull();
      expect(screen.queryByTestId('annotation-selection-toolbar')).toBeNull();
      // Dismissing the selection is all the first Escape does.
      expect(useUiStore.getState().focusMode).toBe(true);

      // With no top layer left, the next Escape reaches Focus Mode itself.
      expect(hasOpenTopLayer()).toBe(false);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(useUiStore.getState().focusMode).toBe(false);
      readerTarget.remove();
    });

    it('keeps the note editor contract: Escape closes the editor and keeps the selection', async () => {
      selectPassage();
      enterFocusMode();
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);
      const invoker = screen.getByRole('button', { name: 'Add note' });
      fireEvent.click(invoker);
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note on selected text' }), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Note on selected text' })).toBeNull();
        expect(invoker).toHaveFocus();
      });
      // The note editor owns that Escape: the passage and Focus Mode both stay.
      expect(useAnnotationStore.getState().selection).not.toBeNull();
      expect(useUiStore.getState().focusMode).toBe(true);
    });
  });
});
