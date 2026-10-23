// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InterleafAPI } from '@shared/types/api';
import type {
  BatchImportResult,
  DocumentMetadata,
  Folder,
  FolderTree,
  LibrarySummary,
} from '@shared/types/document';
import { LibrarySidebar } from '../../src/renderer/components/LibrarySidebar';
import { LibraryView } from '../../src/renderer/features/library/LibraryView';
import { DOCUMENT_DRAG_MIME } from '../../src/renderer/features/library/document-drag';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { TestDataTransfer } from '../helpers/data-transfer';
import { stubBridge } from '../helpers/interleaf-api';
import { VisibleIntersectionObserver } from '../helpers/intersection-observer';

/**
 * Importing files dropped from the system onto the library.
 *
 * A populated library view imports into the folder being viewed, a sidebar
 * folder row into that folder, and All Documents at the root. These tests also
 * pin the separation from moving books: a book drag never imports, a file drag
 * never moves, any other drag is left to the browser, and no second import is
 * started while one is running. The main process validates every file again.
 */

const DOC: DocumentMetadata = {
  id: 'doc-drop-1',
  title: 'Already Here',
  author: 'Someone',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 4096,
  fileMtimeMs: 1,
  fileHash: 'drop-hash',
  pageCount: 20,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const CHILD: FolderTree = {
  id: 'folder-child',
  name: 'Nested',
  parentId: 'folder-root',
  createdAt: DOC.createdAt,
  updatedAt: DOC.updatedAt,
  children: [],
  documentCount: 0,
};

const ROOT: FolderTree = { ...CHILD, id: 'folder-root', name: 'Papers', parentId: null, children: [CHILD] };

const FOLDERS: Folder[] = [ROOT, CHILD].map((folder) => ({
  id: folder.id,
  name: folder.name,
  parentId: folder.parentId,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
  documentCount: folder.documentCount,
}));

function summary(totalDocuments: number): LibrarySummary {
  return {
    totalDocuments,
    formatCounts: { pdf: totalDocuments, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
    managedCount: totalDocuments,
    linkCount: 0,
    missingCount: 0,
    changedCount: 0,
    totalFolders: FOLDERS.length,
  };
}

const EMPTY_RESULT: BatchImportResult = { imported: [], failed: [], totalAttempted: 1 };
const importDroppedFiles = vi.fn<InterleafAPI['library']['importDroppedFiles']>(() =>
  Promise.resolve(EMPTY_RESULT)
);
const moveDocumentToFolder = vi.fn(() => Promise.resolve());

function installBridge(documents: DocumentMetadata[]): void {
  stubBridge({
    library: {
      listDocuments: () => Promise.resolve(documents),
      listFolders: () => Promise.resolve(FOLDERS),
      getFolderTree: () => Promise.resolve([ROOT]),
      getSummary: () => Promise.resolve(summary(documents.length)),
      importDroppedFiles,
      moveDocumentToFolder,
      onStorageHealthUpdated: () => () => undefined,
    },
    search: { getIndexState: () => Promise.resolve(null) },
  });
}

function seedStore(documents: DocumentMetadata[], selectedFolderId: string | null = null): void {
  useLibraryStore.setState({
    documents,
    folders: FOLDERS,
    folderTree: [ROOT],
    summary: summary(documents.length),
    activeSection: selectedFolderId === null ? 'all' : 'folder',
    selectedFolderId,
    isLoading: false,
    isImporting: false,
    errorMessage: null,
    successMessage: null,
  });
}

const BOOK_FILE = new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' });

/** What the system attaches to a drag of files from Finder or Explorer. */
function fileTransfer(files: readonly File[] = [BOOK_FILE]): DataTransfer {
  const transfer = new TestDataTransfer({ Files: '' });
  const list = Object.assign([...files], { item: (index: number) => files[index] ?? null });
  Object.defineProperty(transfer, 'files', { value: list });
  return transfer;
}

function documentTransfer(id: string): DataTransfer {
  return new TestDataTransfer({ [DOCUMENT_DRAG_MIME]: id });
}

function textTransfer(): DataTransfer {
  return new TestDataTransfer({ 'text/plain': 'a selection' });
}

/** Holds a drag over `target`; true when the target claimed it. */
function dragOver(target: HTMLElement, dataTransfer: DataTransfer): boolean {
  return !fireEvent.dragOver(target, { dataTransfer });
}

/**
 * Leaves `target` for `relatedTarget`. jsdom builds drag events without a
 * related target, so the one a browser would report is attached here.
 */
function dragLeave(target: HTMLElement, relatedTarget: Node | null): void {
  const event = createEvent.dragLeave(target);
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  fireEvent(target, event);
}

describe('Library file drop import', () => {
  beforeEach(() => {
    cleanup();
    importDroppedFiles.mockClear();
    moveDocumentToFolder.mockClear();
    window.IntersectionObserver = VisibleIntersectionObserver;
    installBridge([DOC]);
    seedStore([DOC]);
  });

  afterEach(() => {
    cleanup();
  });

  test('files dropped on a populated view import into the folder being viewed', async () => {
    seedStore([DOC], 'folder-child');
    render(<LibraryView />);
    const target = screen.getByTestId('library-file-drop-target');
    const transfer = fileTransfer();

    expect(dragOver(target, transfer)).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    expect(target).toHaveAttribute('data-drop-active', 'true');

    // Crossing into a child of the surface does not clear the affordance.
    const child = await screen.findByTestId(`document-card-${DOC.id}`);
    dragLeave(target, child);
    expect(target).toHaveAttribute('data-drop-active', 'true');

    fireEvent.drop(child, { dataTransfer: transfer });
    expect(target).not.toHaveAttribute('data-drop-active');
    await waitFor(() => {
      expect(importDroppedFiles).toHaveBeenCalledTimes(1);
    });
    expect(importDroppedFiles).toHaveBeenCalledWith([BOOK_FILE], {
      storageMode: 'managed',
      folderId: 'folder-child',
    });
  });

  test('the view imports at the root with no folder selected, and leaving clears the affordance', async () => {
    render(<LibraryView />);
    const target = screen.getByTestId('library-file-drop-target');

    dragOver(target, fileTransfer());
    dragLeave(target, null);
    expect(target).not.toHaveAttribute('data-drop-active');

    fireEvent.drop(target, { dataTransfer: fileTransfer() });
    await waitFor(() => {
      expect(importDroppedFiles).toHaveBeenCalledWith([BOOK_FILE], { storageMode: 'managed', folderId: null });
    });
  });

  test('the view ignores book drags and foreign drags', () => {
    render(<LibraryView />);
    const target = screen.getByTestId('library-file-drop-target');

    for (const transfer of [documentTransfer(DOC.id), textTransfer()]) {
      expect(dragOver(target, transfer)).toBe(false);
      expect(target).not.toHaveAttribute('data-drop-active');
      expect(fireEvent.drop(target, { dataTransfer: transfer })).toBe(true);
    }
    expect(importDroppedFiles).not.toHaveBeenCalled();
    expect(moveDocumentToFolder).not.toHaveBeenCalled();
  });

  test('no second import starts while one is running', () => {
    useLibraryStore.setState({ isImporting: true });
    render(
      <>
        <LibraryView />
        <LibrarySidebar />
      </>
    );

    for (const target of [
      screen.getByTestId('library-file-drop-target'),
      screen.getByTestId('folder-drop-target-folder-root'),
      screen.getByTestId('nav-all-documents'),
    ]) {
      const transfer = fileTransfer();
      expect(dragOver(target, transfer)).toBe(true);
      expect(transfer.dropEffect).toBe('none');
      expect(target).not.toHaveAttribute('data-drop-active');
      fireEvent.drop(target, { dataTransfer: transfer });
    }
    expect(importDroppedFiles).not.toHaveBeenCalled();
  });

  test('the first-run drop zone imports a drop exactly once', async () => {
    installBridge([]);
    seedStore([]);
    render(<LibraryView />);

    const dropzone = await screen.findByTestId('import-dropzone');
    const target = screen.getByTestId('library-file-drop-target');
    fireEvent.dragOver(dropzone, { dataTransfer: fileTransfer() });
    expect(target).not.toHaveAttribute('data-drop-active');
    fireEvent.drop(dropzone, { dataTransfer: fileTransfer() });

    await waitFor(() => {
      expect(importDroppedFiles).toHaveBeenCalledTimes(1);
    });
    expect(importDroppedFiles).toHaveBeenCalledWith([BOOK_FILE], { storageMode: 'managed', folderId: null });
  });

  test('the first-run drop zone ignores a drop while an import is running', async () => {
    installBridge([]);
    seedStore([]);
    useLibraryStore.setState({ isImporting: true });
    render(<LibraryView />);

    const dropzone = await screen.findByTestId('import-dropzone');
    const transfer = fileTransfer();
    fireEvent.dragOver(dropzone, { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('none');
    fireEvent.drop(dropzone, { dataTransfer: transfer });
    expect(importDroppedFiles).not.toHaveBeenCalled();
  });
});

describe('Sidebar file drop import', () => {
  beforeEach(() => {
    cleanup();
    importDroppedFiles.mockClear();
    moveDocumentToFolder.mockClear();
    installBridge([DOC]);
    seedStore([DOC]);
  });

  afterEach(() => {
    cleanup();
  });

  test('files dropped on a nested folder row import into that folder and move nothing', async () => {
    render(<LibrarySidebar />);
    const row = screen.getByTestId('folder-drop-target-folder-child');
    const transfer = fileTransfer();

    expect(dragOver(row, transfer)).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    expect(row).toHaveAttribute('data-drop-active', 'true');
    fireEvent.drop(row, { dataTransfer: transfer });

    expect(row).not.toHaveAttribute('data-drop-active');
    await waitFor(() => {
      expect(importDroppedFiles).toHaveBeenCalledWith([BOOK_FILE], {
        storageMode: 'managed',
        folderId: 'folder-child',
      });
    });
    expect(importDroppedFiles).toHaveBeenCalledTimes(1);
    expect(moveDocumentToFolder).not.toHaveBeenCalled();
  });

  test('files dropped on All Documents import at the root; computed views take none', async () => {
    render(<LibrarySidebar />);

    const recents = screen.getByTestId('nav-recently-added');
    expect(dragOver(recents, fileTransfer())).toBe(false);
    expect(fireEvent.drop(recents, { dataTransfer: fileTransfer() })).toBe(true);
    expect(importDroppedFiles).not.toHaveBeenCalled();

    fireEvent.drop(screen.getByTestId('nav-all-documents'), { dataTransfer: fileTransfer() });
    await waitFor(() => {
      expect(importDroppedFiles).toHaveBeenCalledWith([BOOK_FILE], { storageMode: 'managed', folderId: null });
    });
  });

  test('a book dropped on a folder row is moved, not imported, and does not reach the view', async () => {
    render(
      <>
        <LibraryView />
        <LibrarySidebar />
      </>
    );
    const row = screen.getByTestId('folder-drop-target-folder-root');
    const transfer = documentTransfer(DOC.id);

    expect(dragOver(row, transfer)).toBe(true);
    expect(transfer.dropEffect).toBe('move');
    fireEvent.drop(row, { dataTransfer: transfer });

    await waitFor(() => {
      expect(moveDocumentToFolder).toHaveBeenCalledWith(DOC.id, 'folder-root');
    });
    expect(importDroppedFiles).not.toHaveBeenCalled();
  });

  test('a foreign text drag on a folder row is left alone', () => {
    render(<LibrarySidebar />);
    const row = screen.getByTestId('folder-drop-target-folder-root');

    expect(dragOver(row, textTransfer())).toBe(false);
    expect(row).not.toHaveAttribute('data-drop-active');
    expect(fireEvent.drop(row, { dataTransfer: textTransfer() })).toBe(true);
    expect(importDroppedFiles).not.toHaveBeenCalled();
    expect(moveDocumentToFolder).not.toHaveBeenCalled();
  });
});
