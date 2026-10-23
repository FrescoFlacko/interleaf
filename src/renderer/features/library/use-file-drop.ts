import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useLibraryStore } from '../../stores/use-library-store';
import { isFileDrag } from './document-drag';
import { DROP_TARGET_CLASS, useDocumentDropTarget } from './use-document-drag';

/**
 * Importing files dropped from the operating system onto the library.
 *
 * A drop goes through the same store route as the first-run drop zone, so the
 * main process resolves and validates every path, checks the folder, and
 * enforces the per-import limit. Nothing here is a security boundary: this
 * only decides which drags are files and where they should land.
 */

/**
 * Files dropped from the system, imported at the target's destination.
 *
 * While `isImporting` is true a file drag is still claimed — so the browser
 * never opens the file itself — but it is refused: no tint, a `none` drop
 * effect, and no second import started beside the first.
 */
export type FileDropHandler<Destination> = {
  readonly onDropFiles: (files: readonly File[], destination: Destination) => void;
  readonly isImporting: boolean;
};

type DropTargetProps = {
  readonly 'data-drop-active': 'true' | undefined;
  readonly onDragOver: (event: ReactDragEvent) => void;
  readonly onDragLeave: (event: ReactDragEvent) => void;
  readonly onDrop: (event: ReactDragEvent) => void;
};

/** The store's import route as a drop handler; dropped files become managed copies. */
export function useFileImport(): FileDropHandler<string | null> {
  const importDroppedFiles = useLibraryStore((s) => s.importDroppedFiles);
  const isImporting = useLibraryStore((s) => s.isImporting);
  return {
    isImporting,
    onDropFiles: (files, folderId) => {
      void importDroppedFiles(files, { storageMode: 'managed', folderId });
    },
  };
}

/**
 * The file half of a drop target. A drag that is not files — a library book
 * or anything foreign — is left alone, and a handled drop stops here so an
 * enclosing surface never imports it a second time.
 */
function useFileDropTarget<Destination>(
  fileDrop: FileDropHandler<Destination> | undefined,
  destination: Destination
) {
  const [isActive, setIsActive] = useState(false);
  const accepts = (event: ReactDragEvent): boolean =>
    fileDrop !== undefined && isFileDrag(event.dataTransfer);
  const refused = fileDrop?.isImporting === true;

  return {
    isActive,
    onDragOver: (event: ReactDragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = refused ? 'none' : 'copy';
      setIsActive(!refused);
    },
    onDragLeave: (event: ReactDragEvent) => {
      // Moving between a surface's own children is not leaving the surface.
      const moved = event.relatedTarget;
      if (moved instanceof Node && event.currentTarget.contains(moved)) return;
      setIsActive(false);
    },
    onDrop: (event: ReactDragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setIsActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (!refused && files.length > 0) fileDrop?.onDropFiles(files, destination);
    },
  };
}

/**
 * A library surface that takes books, files, or both, at `destination`.
 *
 * Books and files are told apart by drag type before either handler runs, so
 * a book is never imported and a file is never moved; each half ignores the
 * other's drags, and a surface given neither leaves every drag alone.
 */
export function useLibraryDropTarget<Destination>(
  onDropDocument: ((documentId: string, destination: Destination) => void) | undefined,
  destination: Destination,
  fileDrop?: FileDropHandler<Destination>
): { readonly dropProps: DropTargetProps; readonly dropClass: string } {
  const documents = useDocumentDropTarget(onDropDocument, destination).dropProps;
  const files = useFileDropTarget(fileDrop, destination);
  const isActive = documents['data-drop-active'] === 'true' || files.isActive;

  return {
    dropClass: isActive ? DROP_TARGET_CLASS : '',
    dropProps: {
      'data-drop-active': isActive ? 'true' : undefined,
      onDragOver: (event) => {
        documents.onDragOver(event);
        files.onDragOver(event);
      },
      onDragLeave: (event) => {
        documents.onDragLeave(event);
        files.onDragLeave(event);
      },
      onDrop: (event) => {
        documents.onDrop(event);
        files.onDrop(event);
      },
    },
  };
}

/**
 * The library view's own surface: files dropped anywhere on it are imported
 * into the folder being viewed, or the root. It stands down while `disabled`,
 * which the view sets while the first-run drop zone — with its own storage
 * choice — is shown.
 */
export function useLibraryViewFileDrop(disabled: boolean): {
  readonly dropProps: DropTargetProps;
  readonly dropClass: string;
} {
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId);
  const fileImport = useFileImport();
  const target = useLibraryDropTarget(undefined, selectedFolderId, disabled ? undefined : fileImport);
  // Inset, because the surface is a scroll box whose parent clips an outer ring.
  return { dropProps: target.dropProps, dropClass: target.dropClass && `${target.dropClass} ring-inset` };
}
