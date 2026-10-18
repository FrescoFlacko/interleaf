import { useCallback } from 'react';
import { useLibraryStore, type LibrarySection } from '../../stores/use-library-store';
import { useReaderStore } from '../../stores/use-reader-store';
import { useUiStore } from '../../stores/use-ui-store';
import { readerOwnsViewport } from './reader-viewport';

/** Navigates to a library destination, closing whatever is being read first. */
export type GoToLibraryDestination = (section: LibrarySection, folderId?: string | null) => void;

/**
 * Going to a place in the library.
 *
 * A destination in the rail — All Documents, Continue Reading, Recently Added,
 * Recently Read, or any folder or subfolder — is a request to be in the library
 * at that place. While a document is open the reader owns the viewport, so
 * setting the section alone would move the selection somewhere the reader
 * cannot see and leave them in the document they asked to leave.
 *
 * The destination is set first, synchronously, so the library is already at the
 * requested place in the commit that reveals it and the rail's active state
 * moves with the click. Closing the reader is what reveals it: `closeDocument`
 * is the one path that also unmounts the adapter and revokes the document's
 * media and asset capabilities in main, so navigation never leaves a closed
 * document's handles alive. In compact presentation the rail is a drawer over
 * the reader; it is dismissed as well, since the destination it was covering is
 * now the whole view.
 *
 * Folder management — new subfolder, rename, delete — does not go anywhere, and
 * is deliberately not routed through here.
 */
export function useLibraryDestination(): GoToLibraryDestination {
  const setActiveSection = useLibraryStore((state) => state.setActiveSection);

  return useCallback(
    (section: LibrarySection, folderId: string | null = null): void => {
      setActiveSection(section, folderId);
      useUiStore.getState().setCompactActivePanel(null);
      // Read at call time: the reader claims the viewport while a document is
      // open and while an open is still in flight, so an ordinary click in the
      // library with no reader alive does no capability work. Closing goes
      // through the reader's own path, which is also what discards an
      // in-flight open and revokes the capability it would have held.
      if (readerOwnsViewport(useReaderStore.getState())) {
        void useReaderStore.getState().closeDocument();
      }
    },
    [setActiveSection]
  );
}
