import { useRef } from 'react';
import { ImportWebArticleModal } from './ImportWebArticleModal';
import { createPortal } from 'react-dom';
import {
  selectDeleteDocumentModal,
  selectDeleteFolderModal,
  selectDocumentDetailsModal,
  selectMoveDocumentModal,
  selectNewFolderModal,
  selectRenameFolderModal,
  selectWebImportModalOpen,
  useLibraryStore,
} from '../../../stores/use-library-store';
import { useReaderStore } from '../../../stores/use-reader-store';
import {
  NewFolderModal,
  RenameFolderModal,
  DeleteFolderModal,
  MoveDocumentModal,
  DeleteDocumentModal,
  DocumentDetailsModal,
} from './LibraryModals';

/**
 * Owns every library modal that store state can open.
 *
 * These dialogs are triggered from the library sidebar, which stays mounted
 * while a document is open in the reader. Mounting them with `LibraryView`
 * meant a sidebar trigger (for example a folder's "+") could set the store
 * flag that inerts the app shell while no dialog existed to receive focus or
 * Escape. The host is mounted once at the app root, outside the inert shell,
 * so the dialog always accompanies the state that hides the background.
 */
export function LibraryModalHost() {
  const folders = useLibraryStore((s) => s.folders);
  const newFolderModal = useLibraryStore(selectNewFolderModal);
  const renameFolderModal = useLibraryStore(selectRenameFolderModal);
  const deleteFolderModal = useLibraryStore(selectDeleteFolderModal);
  const moveDocumentModal = useLibraryStore(selectMoveDocumentModal);
  const deleteDocumentModal = useLibraryStore(selectDeleteDocumentModal);
  const selectedDocumentDetails = useLibraryStore(selectDocumentDetailsModal);
  const webImportModalOpen = useLibraryStore(selectWebImportModalOpen);
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId);
  const detailsTransitionFocusRef = useRef<HTMLElement | null>(null);

  const createFolder = useLibraryStore((s) => s.createFolder);
  const renameFolder = useLibraryStore((s) => s.renameFolder);
  const deleteFolder = useLibraryStore((s) => s.deleteFolder);
  const moveDocument = useLibraryStore((s) => s.moveDocument);
  const importWebArticle = useLibraryStore((s) => s.importWebArticle);
  const deleteDocument = useLibraryStore((s) => s.deleteDocument);

  const setNewFolderModalOpen = useLibraryStore((s) => s.setNewFolderModalOpen);
  const setRenameFolderModal = useLibraryStore((s) => s.setRenameFolderModal);
  const setDeleteFolderModal = useLibraryStore((s) => s.setDeleteFolderModal);
  const setMoveDocumentModal = useLibraryStore((s) => s.setMoveDocumentModal);
  const setDeleteDocumentModal = useLibraryStore((s) => s.setDeleteDocumentModal);
  const setWebImportModalOpen = useLibraryStore((s) => s.setWebImportModalOpen);
  const setSelectedDocumentDetails = useLibraryStore((s) => s.setSelectedDocumentDetails);

  return createPortal(
    <>
      <NewFolderModal
        open={newFolderModal !== null}
        parentId={newFolderModal === null ? null : newFolderModal.parentId}
        onClose={() => {
          setNewFolderModalOpen(false);
        }}
        onSubmit={async (name, parentId) => {
          const res = await createFolder(name, parentId);
          if (res === null) {
            throw new Error(
              useLibraryStore.getState().errorMessage ?? 'Failed to create folder.'
            );
          }
          return res;
        }}
      />

      <RenameFolderModal
        folder={renameFolderModal}
        onClose={() => {
          setRenameFolderModal(null);
        }}
        onSubmit={async (id, name) => {
          const res = await renameFolder(id, name);
          if (res === null) {
            throw new Error(
              useLibraryStore.getState().errorMessage ?? 'Failed to rename folder.'
            );
          }
          return res;
        }}
      />

      <DeleteFolderModal
        folder={deleteFolderModal}
        onClose={() => {
          setDeleteFolderModal(null);
        }}
        onConfirm={async (id) => {
          const res = await deleteFolder(id);
          if (!res) {
            throw new Error(
              useLibraryStore.getState().errorMessage ?? 'Failed to delete folder.'
            );
          }
          return res;
        }}
      />

      <MoveDocumentModal
        document={moveDocumentModal}
        folders={folders}
        focusReturnTarget={detailsTransitionFocusRef.current}
        onClose={() => {
          setMoveDocumentModal(null);
        }}
        onSubmit={async (docId, targetFolderId) => {
          const res = await moveDocument(docId, targetFolderId);
          if (!res) {
            throw new Error(
              useLibraryStore.getState().errorMessage ?? 'Failed to move document.'
            );
          }
          return res;
        }}
      />

      <DeleteDocumentModal
        document={deleteDocumentModal}
        focusReturnTarget={detailsTransitionFocusRef.current}
        onClose={() => {
          setDeleteDocumentModal(null);
        }}
        onConfirm={async (id) => {
          const res = await deleteDocument(id);
          if (!res) {
            throw new Error(
              useLibraryStore.getState().errorMessage ?? 'Failed to delete document.'
            );
          }
          return res;
        }}
      />
      <ImportWebArticleModal
        open={webImportModalOpen}
        folderId={selectedFolderId}
        onClose={() => {
          setWebImportModalOpen(false);
        }}
        onSubmit={(url, options) => importWebArticle(url, options)}
      />


      <DocumentDetailsModal
        document={selectedDocumentDetails}
        onClose={() => {
          setSelectedDocumentDetails(null);
        }}
        onOpen={(doc) => {
          void useReaderStore.getState().openDocument(doc.id);
        }}
        onMove={(doc, focusReturnTarget) => {
          detailsTransitionFocusRef.current = focusReturnTarget;
          setMoveDocumentModal(doc);
        }}
        onRemoveFromFolder={(doc) => {
          // The same move route the dialog and the drag both use, with no
          // destination folder. The store reports the outcome and refreshes
          // the view and the folder counts.
          void moveDocument(doc.id, null);
        }}
        onDelete={(doc, focusReturnTarget) => {
          detailsTransitionFocusRef.current = focusReturnTarget;
          setDeleteDocumentModal(doc);
        }}
      />
    </>,
    document.body
  );
}
