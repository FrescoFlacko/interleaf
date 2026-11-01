// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { DocumentMetadata } from '@shared/types/document';
import { testReaderSession } from '../helpers/reader-session';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

/**
 * The page-number field keeps what the reader is typing. The reader's
 * location keeps moving while a previous jump is still scrolling, and each of
 * those updates must not replace a page number the reader has started to type
 * and not yet committed: Enter or leaving the field goes to the typed page, not
 * to wherever the scroll happened to be. Without an edit in progress the field
 * follows the location, and opening another document starts from its page.
 */

function documentNamed(id: string, title: string): DocumentMetadata {
  return {
    id,
    title,
    author: 'Interleaf',
    format: 'docx',
    storageMode: 'managed',
    fileSize: 1024,
    fileMtimeMs: 0,
    fileHash: `${id}-hash`,
    pageCount: 30,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    source: null,
  };
}

const FIRST = documentNamed('doc-docx-1', 'DOCX Virtualization Stress');
const SECOND = documentNamed('doc-docx-2', 'Another Document');

let chat: ChatStore;
let goToPage: ReturnType<typeof vi.fn<(pageNumber: number) => Promise<void>>>;

beforeEach(() => {
  cleanup();
  chat = createChatStore();
  goToPage = vi.fn<(pageNumber: number) => Promise<void>>(() => Promise.resolve());
  useReaderStore.setState({
    session: testReaderSession(FIRST),
    currentPage: 1,
    pageCount: 30,
    zoom: 1,
    zoomMode: 'fit-width',
    tableOfContents: [],
    isTocOpen: false,
    isLoading: false,
    error: null,
    goToPage,
  });
  useUiStore.setState({ focusMode: false, focusSnapshot: null });
  useAnnotationStore.setState({ selection: null, selectionIssue: null });
});

afterEach(() => {
  chat.dispose();
});

/** A location update from the reader, as a scroll in progress reports it. */
function locationMovesTo(page: number): void {
  act(() => { useReaderStore.setState({ currentPage: page }); });
}

function field(): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>('page-number-input');
}

function type(value: string): void {
  fireEvent.focus(field());
  fireEvent.change(field(), { target: { value } });
}

function pressEnter(): void {
  fireEvent.submit(field().form!);
}

describe('page-number field draft', () => {
  test('keeps a typed page through location updates and goes to it on Enter', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    locationMovesTo(5);
    type('10');
    // The previous jump is still scrolling: pages 2 and 3 pass by before Enter.
    locationMovesTo(2);
    locationMovesTo(3);
    expect(field()).toHaveValue('10');
    pressEnter();
    expect(goToPage).toHaveBeenCalledTimes(1);
    expect(goToPage).toHaveBeenCalledWith(10);
  });

  test('goes to the typed page when the field is left after location updates', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    type('10');
    locationMovesTo(2);
    fireEvent.blur(field());
    expect(goToPage).toHaveBeenCalledWith(10);
  });

  test('follows the location again once the typed page is committed', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    type('10');
    pressEnter();
    locationMovesTo(10);
    expect(field()).toHaveValue('10');
    locationMovesTo(11);
    expect(field()).toHaveValue('11');
  });

  test('follows the location while nothing has been typed, focused or not', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    locationMovesTo(4);
    expect(field()).toHaveValue('4');
    fireEvent.focus(field());
    locationMovesTo(6);
    expect(field()).toHaveValue('6');
    expect(goToPage).not.toHaveBeenCalled();
  });

  test('still clamps a typed page to the document and ignores one that is not a number', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    type('99');
    locationMovesTo(2);
    pressEnter();
    expect(goToPage).toHaveBeenLastCalledWith(30);
    type('abc');
    locationMovesTo(3);
    pressEnter();
    expect(goToPage).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('3');
  });

  test('drops an uncommitted draft when another document opens, and shows that document’s page', () => {
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    type('10');
    act(() => { useReaderStore.setState({ session: testReaderSession(SECOND), currentPage: 7 }); });
    expect(field()).toHaveValue('7');
    locationMovesTo(8);
    expect(field()).toHaveValue('8');
    expect(goToPage).not.toHaveBeenCalled();
  });
});
