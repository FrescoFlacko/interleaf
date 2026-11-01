// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentMetadata, Folder } from '@shared/types/document';
import { isLibraryModalOpen, useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The library's dialogs share one slot: at most one owns the screen, and an
 * open dialog always carries the subject it acts on. A dialog that hands over
 * to another closes itself after opening its successor, so a close names the
 * dialog it means and leaves any other alone.
 */

const DOC = {
  id: 'doc-modal',
  title: 'Modal subject',
  author: null,
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 10,
  fileMtimeMs: 1,
  fileHash: 'hash',
  pageCount: null,
  folderId: 'folder-1',
  storageHealth: 'ok',
  readingPosition: null,
  source: null,
  createdAt: '2026-09-07T10:00:00.000Z',
  updatedAt: '2026-09-07T10:00:00.000Z',
} satisfies DocumentMetadata;

const FOLDER: Folder = {
  id: 'folder-1',
  name: 'Folder',
  parentId: null,
  createdAt: '2026-09-07T10:00:00.000Z',
  updatedAt: '2026-09-07T10:00:00.000Z',
  documentCount: 1,
};

afterEach(() => {
  useLibraryStore.setState({ libraryModal: null, successMessage: null, errorMessage: null });
});

describe('library modal slot', () => {
  it('starts closed and opens exactly one dialog with its subject', () => {
    const store = useLibraryStore.getState();
    expect(isLibraryModalOpen(useLibraryStore.getState())).toBe(false);
    store.setRenameFolderModal(FOLDER);
    store.setDeleteDocumentModal(DOC);
    expect(useLibraryStore.getState().libraryModal).toEqual({ kind: 'delete-document', document: DOC });
    store.setNewFolderModalOpen(true, 'folder-1');
    expect(useLibraryStore.getState().libraryModal).toEqual({ kind: 'new-folder', parentId: 'folder-1' });
    expect(isLibraryModalOpen(useLibraryStore.getState())).toBe(true);
  });

  it('keeps the successor open when Details hands over to Move and then closes itself', () => {
    const store = useLibraryStore.getState();
    store.setSelectedDocumentDetails(DOC);
    // DocumentDetailsModal runs the action first, then its own onClose.
    store.setMoveDocumentModal(DOC);
    store.setSelectedDocumentDetails(null);
    expect(useLibraryStore.getState().libraryModal).toEqual({ kind: 'move-document', document: DOC });
  });

  it('closes only the dialog a close names', () => {
    const store = useLibraryStore.getState();
    store.setWebImportModalOpen(true);
    store.setNewFolderModalOpen(false);
    store.setDeleteFolderModal(null);
    expect(useLibraryStore.getState().libraryModal).toEqual({ kind: 'web-import' });
    store.setWebImportModalOpen(false);
    expect(useLibraryStore.getState().libraryModal).toBeNull();
  });

  it('leaves Details open when it removes its document from a folder', async () => {
    stubBridge({
      library: {
        moveDocumentToFolder: () => Promise.resolve(undefined),
        listDocuments: () => Promise.resolve([DOC]),
        listFolders: () => Promise.resolve([]),
        getFolderTree: () => Promise.resolve([]),
      },
    });
    useLibraryStore.getState().setSelectedDocumentDetails(DOC);
    await expect(useLibraryStore.getState().moveDocument(DOC.id, null)).resolves.toBe(true);
    expect(useLibraryStore.getState().libraryModal).toEqual({ kind: 'document-details', document: DOC });
    expect(useLibraryStore.getState().successMessage).toBe('Document removed from folder.');
  });
});
