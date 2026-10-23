import { useEffect } from 'react';
import { useLibraryStore, type LibrarySection } from '../stores/use-library-store';
import { openFileFromDialog } from '../stores/use-open-file-store';
import { useUiStore } from '../stores/use-ui-store';
import { FolderTreeItem } from '../features/library/components/FolderTreeItem';
import { LibraryNavItem } from '../features/library/components/LibraryNavItem';
import { applyDocumentDrop } from '../features/library/use-document-drag';
import { useLibraryDestination } from '../features/library/use-library-destination';
import { AppIcon, type AppIconName } from './AppIcon';

export function LibrarySidebar() {
  const activeSection = useLibraryStore((s) => s.activeSection);
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId);
  const folderTree = useLibraryStore((s) => s.folderTree);
  const summary = useLibraryStore((s) => s.summary);
  const documents = useLibraryStore((s) => s.documents);
  const moveDocument = useLibraryStore((s) => s.moveDocument);

  // Every destination in this rail goes through one path, which also leaves the
  // document the reader was in; the folder management controls below do not.
  const goToDestination = useLibraryDestination();
  const setNewFolderModalOpen = useLibraryStore((s) => s.setNewFolderModalOpen);
  const setRenameFolderModal = useLibraryStore((s) => s.setRenameFolderModal);
  const setDeleteFolderModal = useLibraryStore((s) => s.setDeleteFolderModal);
  const loadFolders = useLibraryStore((s) => s.loadFolders);
  const loadSummary = useLibraryStore((s) => s.loadSummary);

  useEffect(() => {
    void loadFolders();
    void loadSummary();
  }, [loadFolders, loadSummary]);

  /**
   * Files a dropped book into a folder, or — dropped on All Documents — out of
   * whichever folder it was in. The id is all the drag carried, so it is
   * matched against the known documents before the store route runs; see
   * `applyDocumentDrop`.
   */
  const dropDocument = (documentId: string, folderId: string | null): void => {
    applyDocumentDrop(documents, moveDocument, documentId, folderId);
  };

  // Semantic icons, not emoji: these tint from the button's own text token, so
  // the rail reads correctly in every theme.
  const navItems: { id: LibrarySection; label: string; icon: AppIconName; testId: string }[] = [
    { id: 'all', label: 'All Documents', icon: 'library-all', testId: 'nav-all-documents' },
    { id: 'continue_reading', label: 'Continue Reading', icon: 'library-continue-reading', testId: 'nav-continue-reading' },
    { id: 'recent_added', label: 'Recently Added', icon: 'library-recently-added', testId: 'nav-recently-added' },
    { id: 'recent_read', label: 'Recently Read', icon: 'library-recently-read', testId: 'nav-recently-read' },
  ];

  return (
    <aside
      data-testid="sidebar-library"
      id="library-sidebar"
      aria-label="Library Navigation"
      className="flex h-full w-full min-w-0 flex-col justify-between bg-bg-primary"
    >
      <div className="flex flex-col gap-6 p-4 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Library
            </h2>
            {/* Reads a file in place without importing it. The compact drawer
                covers the reader, so it closes before the file opens. */}
            <button
              type="button"
              data-testid="library-open-file"
              title="Open a file to read without adding it to your library (Ctrl+O)"
              aria-label="Open file"
              onClick={() => {
                useUiStore.getState().setCompactActivePanel(null);
                void openFileFromDialog();
              }}
              className="flex shrink-0 items-center justify-center rounded-md p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary"
            >
              {/* One step smaller than the 18px nav icons below it. */}
              <AppIcon name="library-open-file" size={16} />
            </button>
          </div>
          {/* Navigation items */}
          <nav aria-label="Library sections" className="flex flex-col gap-1">
            {navItems.map((item) => (
              <LibraryNavItem
                key={item.id}
                label={item.label}
                icon={item.icon}
                testId={item.testId}
                isActive={activeSection === item.id}
                acceptsDrop={item.id === 'all'}
                onSelect={() => {
                  goToDestination(item.id);
                }}
                onDropDocument={dropDocument}
              />
            ))}
          </nav>
        </div>

        {/* Folders hierarchy */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Folders
            </h2>
            <button
              type="button"
              data-testid="new-folder-button"
              title="Create new folder"
              aria-label="Create new folder"
              onClick={() => {
                setNewFolderModalOpen(true);
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-text-secondary hover:bg-bg-surface hover:text-text-primary"
            >
              <AppIcon name="add" size={13} className="shrink-0" />
              New
            </button>
          </div>

          {folderTree.length === 0 ? (
            <div
              data-testid="folder-tree"
              aria-label="Virtual folders"
              className="flex flex-col gap-0.5"
            >
              <p className="px-2 py-1 text-xs italic text-text-secondary">
                No folders created yet.
              </p>
            </div>
          ) : (
            <ul
              aria-label="Virtual folders"
              data-testid="folder-tree"
              className="flex flex-col gap-0.5"
            >
              {folderTree.map((folder) => (
                <FolderTreeItem
                  key={folder.id}
                  node={folder}
                  selectedFolderId={activeSection === 'folder' ? selectedFolderId : null}
                  onSelect={(folderId) => {
                    goToDestination('folder', folderId);
                  }}
                  onNewSubfolder={(parentId) => {
                    setNewFolderModalOpen(true, parentId);
                  }}
                  onRename={(f) => {
                    setRenameFolderModal(f);
                  }}
                  onDelete={(f) => {
                    setDeleteFolderModal(f);
                  }}
                  onDropDocument={(documentId, folderId) => {
                    dropDocument(documentId, folderId);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Storage Health & Summary Footer */}
      {summary && (
        <div
          data-testid="library-summary-footer"
          className="border-t border-border-subtle bg-bg-surface/50 p-3 text-2xs text-text-secondary"
        >
          <div className="flex items-center justify-between">
            <span>Total Books</span>
            <span className="font-semibold text-text-primary">{summary.totalDocuments}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-2xs">
            <span>{summary.managedCount} managed • {summary.linkCount} linked</span>
            {summary.missingCount > 0 && (
              <span className="flex items-center gap-1 font-semibold text-danger" title={`${String(summary.missingCount)} linked files missing`}>
                <AppIcon name="warning" size={12} className="shrink-0" />
                {summary.missingCount} missing
              </span>
            )}
            {summary.changedCount > 0 && (
              <span className="flex items-center gap-1 font-semibold text-warning" title={`${String(summary.changedCount)} linked files modified`}>
                <AppIcon name="warning" size={12} className="shrink-0" />
                {summary.changedCount} changed
              </span>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
