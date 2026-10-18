// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationSelectionToolbar } from '../../src/renderer/features/reader/components/AnnotationSelectionToolbar';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import {
  isNoteSaveShortcut,
  noteSaveShortcutOutcome,
} from '../../src/renderer/hooks/note-save-shortcut';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * Cmd+Enter (macOS) / Ctrl+Enter (Windows, Linux) commits a note from inside
 * the field the reader is typing in.
 *
 * What these tests are actually for: the shortcut must be the SAME save, not a
 * second one. Every case below either proves the chord reaches the exact
 * validation and persistence call the Save button makes, or proves a press
 * that is not that chord is left alone — plain Enter still types a newline, a
 * composing IME still owns its Enter, and a draft the button would refuse is
 * refused here too, without a duplicate write.
 */

const now = '2026-09-20T12:00:00.000Z';

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

const chatDescriptor = {
  format: 'pdf' as const,
  startPageIndex: 1,
  endPageIndex: 1,
  startPageLabel: '2',
  endPageLabel: '2',
  startQuote: rangeAnchor.quote,
  endQuote: rangeAnchor.quote,
};

function savedNote(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-note',
    documentId: 'doc-1',
    documentHash: 'hash-v1',
    type: 'note',
    anchor: rangeAnchor,
    selectedText: 'selected quote',
    note: 'first thought',
    label: null,
    color: 'yellow',
    isLocationNote: false,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The chord as a fireEvent init, per platform modifier. */
const COMMAND_ENTER = { key: 'Enter', metaKey: true } as const;
const CONTROL_ENTER = { key: 'Enter', ctrlKey: true } as const;

describe('note save shortcut', () => {
  describe('the press decision itself', () => {
    const base = {
      key: 'Enter',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
    };

    it.each([
      { name: 'Cmd+Enter (macOS)', event: { ...base, metaKey: true }, outcome: 'save' },
      { name: 'Ctrl+Enter (Windows, Linux)', event: { ...base, ctrlKey: true }, outcome: 'save' },
      // Plain Enter is the newline the multiline field exists for.
      { name: 'plain Enter', event: base, outcome: 'ignore' },
      { name: 'Shift+Enter', event: { ...base, shiftKey: true }, outcome: 'ignore' },
      { name: 'Shift+Cmd+Enter', event: { ...base, metaKey: true, shiftKey: true }, outcome: 'ignore' },
      { name: 'Alt+Cmd+Enter', event: { ...base, metaKey: true, altKey: true }, outcome: 'ignore' },
      { name: 'Cmd+S', event: { ...base, key: 's', metaKey: true }, outcome: 'ignore' },
      // An IME commits its candidate with Enter; that must not commit the note.
      { name: 'Cmd+Enter while composing', event: { ...base, metaKey: true, isComposing: true }, outcome: 'ignore' },
      // A held chord is claimed (no newline) but saves exactly once.
      { name: 'auto-repeated Cmd+Enter', event: { ...base, metaKey: true, repeat: true }, outcome: 'claim' },
    ])('$name resolves to $outcome with a saveable draft', ({ event, outcome }) => {
      expect(noteSaveShortcutOutcome(event, true)).toBe(outcome);
    });

    it('claims the chord without saving when the Save action is unavailable', () => {
      expect(noteSaveShortcutOutcome({ ...base, metaKey: true }, false)).toBe('claim');
      // Still the chord: the field must not get a newline out of it.
      expect(isNoteSaveShortcut({ ...base, metaKey: true })).toBe(true);
      // A non-chord press is never claimed, saveable draft or not.
      expect(noteSaveShortcutOutcome(base, false)).toBe('ignore');
    });
  });

  describe('in the note editors', () => {
    const create = vi.fn();
    const update = vi.fn();
    const page = vi.fn();

    beforeEach(() => {
      cleanup();
      create.mockReset();
      update.mockReset();
      page.mockReset();
      page.mockResolvedValue({ items: [savedNote()], total: 1 });
      const api = testInterleafApi({
        annotations: { create, list: vi.fn(() => Promise.resolve([])), page, update },
      });
      stubBridge(api);
      useAnnotationStore.getState().reset();
      useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
      useReaderStore.setState({
        session: testReaderSession(documentRecord),
        currentPage: 2,
        pageCount: 5,
        goToLocation: () => Promise.resolve(),
      });
      useUiStore.setState({ rightOpen: false, rightTab: 'chat', focusMode: false });
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    function openSelectionNote(): HTMLElement {
      useAnnotationStore.setState({
        selection: {
          selectedText: 'selected quote',
          totalSelectedLength: 14,
          chatDescriptor,
          anchor: rangeAnchor,
          clientRect: { left: 20, top: 100, width: 100, height: 20 },
        },
      });
      renderWithChatStore(chat, <AnnotationSelectionToolbar />);
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      return screen.getByRole('textbox', { name: 'Note on selected text' });
    }

    it('creates the selection note from Cmd+Enter exactly as the Save button does', async () => {
      create.mockResolvedValue(savedNote({ note: 'typed in the field' }));
      const field = openSelectionNote();
      expect(screen.getByTestId('selection-note-shortcut-hint')).toHaveTextContent(/to save$/u);
      fireEvent.change(field, { target: { value: 'typed in the field' } });
      fireEvent.keyDown(field, COMMAND_ENTER);

      await waitFor(() => {
        expect(create).toHaveBeenCalledWith({
          documentId: 'doc-1',
          type: 'note',
          anchor: rangeAnchor,
          // The anchor-quote contract the Save button also satisfies.
          selectedText: 'selected quote',
          note: 'typed in the field',
        });
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(useAnnotationStore.getState().selection).toBeNull();
    });

    it('leaves plain Enter, Shift+Enter and a composing Enter to the field', () => {
      const field = openSelectionNote();
      fireEvent.change(field, { target: { value: 'still writing' } });

      const plain = fireEvent.keyDown(field, { key: 'Enter' });
      const shifted = fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
      // `isComposing` lives on the native event, which is why the editors read
      // the press through `noteSaveShortcutKey`.
      const composing = fireEvent.keyDown(field, { ...COMMAND_ENTER, isComposing: true });

      expect(create).not.toHaveBeenCalled();
      // Not claimed: the default action (inserting the newline) still stands.
      expect(plain).toBe(true);
      expect(shifted).toBe(true);
      expect(composing).toBe(true);
      expect(screen.getByRole('dialog', { name: 'Note on selected text' })).toBeInTheDocument();
    });

    it('refuses a blank draft on the shortcut, and takes no newline for it either', () => {
      const field = openSelectionNote();
      fireEvent.change(field, { target: { value: '   ' } });

      const claimed = fireEvent.keyDown(field, COMMAND_ENTER);

      expect(create).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
      // The chord was consumed, so the whitespace draft gains no newline.
      expect(claimed).toBe(false);
    });

    it('writes one note when the chord is pressed twice while the first save is in flight', async () => {
      let settle: (value: Annotation | null) => void = () => undefined;
      create.mockReturnValue(new Promise<Annotation | null>((resolve) => { settle = resolve; }));
      const field = openSelectionNote();
      fireEvent.change(field, { target: { value: 'only once' } });

      fireEvent.keyDown(field, COMMAND_ENTER);
      fireEvent.keyDown(field, COMMAND_ENTER);
      fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
      expect(create).toHaveBeenCalledTimes(1);

      settle(savedNote({ note: 'only once' }));
      await waitFor(() => { expect(useAnnotationStore.getState().selection).toBeNull(); });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('saves a location note from the shortcut through the same create path', async () => {
      seatReaderAdapter(testDocumentAdapter('pdf', {
          getReadingLocation: () => ({ location: { format: 'pdf' as const, pageIndex: 1 }, progress: 0.4 }),
          getCurrentPage: () => 2,
        }));
      create.mockResolvedValue(savedNote({ isLocationNote: true }));
      renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      const field = screen.getByRole('textbox', { name: 'Note at current location' });
      fireEvent.change(field, { target: { value: 'come back to this page' } });
      expect(screen.getByTestId('location-note-shortcut-hint')).toHaveTextContent(/to save$/u);
      fireEvent.keyDown(field, COMMAND_ENTER);

      await waitFor(() => {
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          documentId: 'doc-1',
          type: 'note',
          note: 'come back to this page',
          isLocationNote: true,
        }));
      });
      expect(create).toHaveBeenCalledTimes(1);
      // A saved location note closes its own popover, as the button path does.
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Note at current location' })).toBeNull();
      });
    });

    it('commits an Annotations-panel edit from the shortcut, and refuses to empty a note', async () => {
      update.mockResolvedValue(savedNote({ note: 'revised' }));
      renderWithChatStore(chat, <AnnotationBrowser />);
      const edit = await screen.findByRole('button', { name: /edit/iu });
      fireEvent.click(edit);
      const field = screen.getByRole('textbox', { name: 'Note text' });

      // A note may not be emptied — the same rule the Save button enforces.
      fireEvent.change(field, { target: { value: '  ' } });
      fireEvent.keyDown(field, COMMAND_ENTER);
      expect(update).not.toHaveBeenCalled();

      fireEvent.change(field, { target: { value: 'revised' } });
      fireEvent.keyDown(field, CONTROL_ENTER);
      await waitFor(() => {
        expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-note', note: 'revised' });
      });
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
