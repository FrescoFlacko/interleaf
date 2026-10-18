// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocumentMetadata, Folder, FolderTree } from '@shared/types/document';
import { LibrarySidebar } from '../../src/renderer/components/LibrarySidebar';
import { DocumentCard } from '../../src/renderer/features/library/components/DocumentCard';
import { DOCUMENT_DRAG_MIME } from '../../src/renderer/features/library/document-drag';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { TestDataTransfer } from '../helpers/data-transfer';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * Filing a book by dragging it onto a folder, and taking it back out.
 *
 * The drag carries an opaque document id in a private MIME type and nothing
 * else, so these tests also pin the rejection side: an id this renderer does
 * not know, a malformed payload, and a foreign drag must all leave the library
 * untouched. The move itself is the same store route the Move dialog uses, and
 * the main process validates it again regardless of anything asserted here.
 */

const BASE_DOC: DocumentMetadata = {
  id: 'doc-drag-1',
  title: 'A Dragged Book',
  author: 'Someone',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 4096,
  fileMtimeMs: 1,
  fileHash: 'drag-hash',
  pageCount: 20,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const CHILD_FOLDER: FolderTree = {
  id: 'folder-child',
  name: 'Nested',
  parentId: 'folder-root',
  createdAt: BASE_DOC.createdAt,
  updatedAt: BASE_DOC.updatedAt,
  children: [],
  documentCount: 0,
};

const ROOT_FOLDER: FolderTree = {
  id: 'folder-root',
  name: 'Papers',
  parentId: null,
  createdAt: BASE_DOC.createdAt,
  updatedAt: BASE_DOC.updatedAt,
  children: [CHILD_FOLDER],
  documentCount: 1,
};

const FOLDERS: Folder[] = [ROOT_FOLDER, CHILD_FOLDER].map((folder) => ({
  id: folder.id,
  name: folder.name,
  parentId: folder.parentId,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
  documentCount: folder.documentCount,
}));

const moveDocumentToFolder = vi.fn(() => Promise.resolve());

function installLibraryBridge(): void {
  const library = {
    listDocuments: () => Promise.resolve([BASE_DOC]),
    listFolders: () => Promise.resolve(FOLDERS),
    getFolderTree: () => Promise.resolve([ROOT_FOLDER]),
    getSummary: () =>
      Promise.resolve({
        totalDocuments: 1,
        formatCounts: { pdf: 1, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
        managedCount: 1,
        linkCount: 0,
        missingCount: 0,
        changedCount: 0,
        totalFolders: 1,
      }),
    moveDocumentToFolder,
  };
  stubBridge({ library, search: { getIndexState: () => Promise.resolve(null) } });
}

function dragData(entries: Record<string, string>): DataTransfer {
  return new TestDataTransfer(entries);
}

function documentPayload(id: string): DataTransfer {
  return dragData({ [DOCUMENT_DRAG_MIME]: id });
}

function seedStore(doc: DocumentMetadata): void {
  useLibraryStore.setState({
    documents: [doc],
    folders: FOLDERS,
    folderTree: [ROOT_FOLDER],
    activeSection: 'all',
    selectedFolderId: null,
    errorMessage: null,
    successMessage: null,
  });
}

describe('Library drag to folder', () => {
  beforeEach(() => {
    cleanup();
    moveDocumentToFolder.mockClear();
    moveDocumentToFolder.mockImplementation(() => Promise.resolve());
    installLibraryBridge();
    seedStore(BASE_DOC);
  });

  afterEach(() => {
    cleanup();
  });

  test('a card dropped on a nested folder is moved into it', async () => {
    render(
      <>
        <DocumentCard document={BASE_DOC} onOpen={vi.fn()} onDetails={vi.fn()} />
        <LibrarySidebar />
      </>
    );

    const card = screen.getByTestId(`document-card-${BASE_DOC.id}`);
    expect(card).toHaveAttribute('draggable', 'true');

    const transfer = dragData({});
    fireEvent.dragStart(card, { dataTransfer: transfer });
    expect(transfer.getData(DOCUMENT_DRAG_MIME)).toBe(BASE_DOC.id);
    // Only the id travels: no path, no title, no content.
    expect([...transfer.types]).toEqual([DOCUMENT_DRAG_MIME]);

    const target = await screen.findByTestId(`folder-drop-target-${CHILD_FOLDER.id}`);
    fireEvent.dragOver(target, { dataTransfer: transfer });
    expect(target).toHaveAttribute('data-drop-active', 'true');

    fireEvent.drop(target, { dataTransfer: transfer });

    await waitFor(() => {
      expect(moveDocumentToFolder).toHaveBeenCalledWith(BASE_DOC.id, CHILD_FOLDER.id);
    });
    expect(target).not.toHaveAttribute('data-drop-active');
  });

  test('a card dropped on All Documents is removed from its folder', async () => {
    const filed = { ...BASE_DOC, folderId: CHILD_FOLDER.id };
    seedStore(filed);
    render(<LibrarySidebar />);

    const root = screen.getByTestId('nav-all-documents');
    const transfer = documentPayload(filed.id);
    fireEvent.dragOver(root, { dataTransfer: transfer });
    expect(root).toHaveAttribute('data-drop-active', 'true');
    fireEvent.drop(root, { dataTransfer: transfer });

    await waitFor(() => {
      expect(moveDocumentToFolder).toHaveBeenCalledWith(filed.id, null);
    });
    await waitFor(() => {
      expect(useLibraryStore.getState().successMessage).toBe('Document removed from folder.');
    });
  });

  test('a computed section is not a drop destination', () => {
    render(<LibrarySidebar />);

    const recents = screen.getByTestId('nav-recently-added');
    const transfer = documentPayload(BASE_DOC.id);
    fireEvent.dragOver(recents, { dataTransfer: transfer });
    expect(recents).not.toHaveAttribute('data-drop-active');
    fireEvent.drop(recents, { dataTransfer: transfer });

    expect(moveDocumentToFolder).not.toHaveBeenCalled();
  });

  test('unknown, malformed, and foreign payloads are ignored', async () => {
    render(<LibrarySidebar />);
    const target = await screen.findByTestId(`folder-drop-target-${ROOT_FOLDER.id}`);

    // An id from somewhere else: shaped like ours, but not a book this
    // renderer knows.
    fireEvent.drop(target, { dataTransfer: documentPayload('doc-from-another-window') });
    // Malformed payloads: empty, whitespace, and past the identifier bound.
    fireEvent.drop(target, { dataTransfer: documentPayload('') });
    fireEvent.drop(target, { dataTransfer: documentPayload('doc id with spaces') });
    fireEvent.drop(target, { dataTransfer: documentPayload('x'.repeat(200)) });
    // Something dragged in from outside the app.
    fireEvent.drop(target, {
      dataTransfer: dragData({ 'text/plain': BASE_DOC.id, 'text/uri-list': 'file:///etc/passwd' }),
    });

    await Promise.resolve();
    expect(moveDocumentToFolder).not.toHaveBeenCalled();
    expect(useLibraryStore.getState().errorMessage).toBeNull();
  });

  test('a drop that changes nothing asks the main process for nothing', async () => {
    const filed = { ...BASE_DOC, folderId: ROOT_FOLDER.id };
    seedStore(filed);
    render(<LibrarySidebar />);

    const target = await screen.findByTestId(`folder-drop-target-${ROOT_FOLDER.id}`);
    fireEvent.drop(target, { dataTransfer: documentPayload(filed.id) });

    await Promise.resolve();
    expect(moveDocumentToFolder).not.toHaveBeenCalled();
  });

  test('a failed move reports through the existing message surface', async () => {
    moveDocumentToFolder.mockImplementation(() => Promise.reject(new Error('Folder is gone.')));
    render(<LibrarySidebar />);

    const target = await screen.findByTestId(`folder-drop-target-${ROOT_FOLDER.id}`);
    fireEvent.drop(target, { dataTransfer: documentPayload(BASE_DOC.id) });

    await waitFor(() => {
      expect(useLibraryStore.getState().errorMessage).toBe('Folder is gone.');
    });
  });

  test('finishing a drag does not also open the book', () => {
    const onOpen = vi.fn();
    render(<DocumentCard document={BASE_DOC} onOpen={onOpen} onDetails={vi.fn()} />);

    const card = screen.getByTestId(`document-card-${BASE_DOC.id}`);
    fireEvent.dragStart(card, { dataTransfer: dragData({}) });
    fireEvent.dragEnd(card);
    // A cancelled drag can still deliver the trailing click.
    fireEvent.click(screen.getByTestId(`read-doc-${BASE_DOC.id}`));
    expect(onOpen).not.toHaveBeenCalled();

    // The card is still a card afterwards.
    fireEvent.click(screen.getByTestId(`read-doc-${BASE_DOC.id}`));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /**
   * Chromium usually delivers no click at all after a drag. Suppression armed
   * for a click that never comes used to stay armed for the life of the card,
   * so the reader's next deliberate press — opening the book, or its details —
   * was swallowed with no way to tell why.
   */
  test('a drag that delivers no trailing click stops swallowing the next press', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      const onDetails = vi.fn();
      const view = render(<DocumentCard document={BASE_DOC} onOpen={onOpen} onDetails={onDetails} />);
      const card = screen.getByTestId(`document-card-${BASE_DOC.id}`);

      fireEvent.dragStart(card, { dataTransfer: dragData({}) });
      fireEvent.dragEnd(card);
      // Well past the window a trailing click would have arrived in.
      act(() => { vi.advanceTimersByTime(1_000); });

      fireEvent.click(screen.getByTestId(`read-doc-${BASE_DOC.id}`));
      expect(onOpen).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId(`document-menu-${BASE_DOC.id}`));
      expect(onDetails).toHaveBeenCalledTimes(1);

      // Nothing is left ticking on a card the reader has navigated away from.
      fireEvent.dragStart(card, { dataTransfer: dragData({}) });
      fireEvent.dragEnd(card);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
