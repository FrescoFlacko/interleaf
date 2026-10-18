import { useEffect } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { LoadingShimmerText } from '../../components/LoadingShimmer';
import { useLibraryStore } from '../../stores/use-library-store';
import { useReaderStore } from '../../stores/use-reader-store';
import { ImportMenu } from './components/ImportMenu';
import { DocumentCard } from './components/DocumentCard';
import { DocumentListItem } from './components/DocumentListItem';
import { ImportDropzone } from './components/ImportDropzone';
import { bridge } from '../../app/api-client';
import { LibraryHeaderControls } from './components/LibraryHeaderControls';

export function LibraryView() {
  const activeSection = useLibraryStore((s) => s.activeSection);
  const selectedFolderId = useLibraryStore((s) => s.selectedFolderId);
  const viewMode = useLibraryStore((s) => s.viewMode);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const formatFilter = useLibraryStore((s) => s.formatFilter);

  const documents = useLibraryStore((s) => s.documents);
  const folders = useLibraryStore((s) => s.folders);
  const summary = useLibraryStore((s) => s.summary);
  const isLoading = useLibraryStore((s) => s.isLoading);
  const isLoadingMore = useLibraryStore((s) => s.isLoadingMore);
  const hasMore = useLibraryStore((s) => s.hasMore);
  const isImporting = useLibraryStore((s) => s.isImporting);
  const errorMessage = useLibraryStore((s) => s.errorMessage);
  const successMessage = useLibraryStore((s) => s.successMessage);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);
  const loadSummary = useLibraryStore((s) => s.loadSummary);
  const loadMore = useLibraryStore((s) => s.loadMore);
  const loadFolders = useLibraryStore((s) => s.loadFolders);
  const resetLibraryView = useLibraryStore((s) => s.resetLibraryView);

  const importDroppedFiles = useLibraryStore((s) => s.importDroppedFiles);
  const openFileDialog = useLibraryStore((s) => s.openFileDialog);
  const setWebImportModalOpen = useLibraryStore((s) => s.setWebImportModalOpen);

  const setSelectedDocumentDetails = useLibraryStore((s) => s.setSelectedDocumentDetails);

  const clearError = useLibraryStore((s) => s.clearError);
  const clearSuccess = useLibraryStore((s) => s.clearSuccess);

  const readerError = useReaderStore((s) => s.error);
  const failedDocumentId = useReaderStore((s) => s.failedDocumentId);
  const retryOpenDocument = useReaderStore((s) => s.retryOpenDocument);
  const clearReaderError = useReaderStore((s) => s.clearReaderError);
  useEffect(() => {
    void loadLibrary();
    void loadFolders();
    void loadSummary();
    let summaryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.library.onStorageHealthUpdated((update) => {
      useLibraryStore.getState().updateDocumentHealth(update);
      summaryRefreshTimer ??= setTimeout(() => {
          summaryRefreshTimer = null;
          void loadSummary();
        }, 250);
    });
    return () => {
      if (summaryRefreshTimer !== null) clearTimeout(summaryRefreshTimer);
      unsubscribe();
    };
  }, [loadLibrary, loadFolders, loadSummary]);
  const selectedFolder = selectedFolderId ? folders.find((f) => f.id === selectedFolderId) : null;
  const totalDocuments = summary?.totalDocuments ?? null;
  const hasLibraryBooks = documents.length > 0 || (totalDocuments !== null && totalDocuments > 0);
  const hasActiveViewFilter =
    activeSection !== 'all' ||
    searchQuery.trim().length > 0 ||
    formatFilter !== 'all';
  const showFirstRunImport =
    !isLoading &&
    !errorMessage &&
    totalDocuments === 0 &&
    documents.length === 0;

  function getSectionTitle(): string {
    switch (activeSection) {
      case 'continue_reading':
        return 'Continue Reading';
      case 'recent_added':
        return 'Recently Added';
      case 'recent_read':
        return 'Recently Read';
      case 'folder':
        return selectedFolder ? selectedFolder.name : 'Folder';
      case 'all':
      default:
        return 'All Documents';
    }
  }

  return (
    <div data-testid="library-view" className="flex flex-1 flex-col overflow-hidden bg-bg-reader">
      {/* Header Toolbar.

          The row's height is the shared workspace row height rather than its
          own padding, because the companion tab bar sits beside it at the same
          y: the two dividers read as one line across the window only if both
          rows are exactly as tall. That is also why the row no longer wraps —
          wrapping is what made this header 99 px against the companion's 43.
          Width pressure is absorbed instead: the search field narrows first,
          then the filters scroll horizontally inside their own strip (below).
          A fixed section title is short and is never cut; only a folder name,
          which the user chose and which can be any length, truncates, keeping
          its full text as its accessible name and as the native tooltip. */}
      <header className="flex h-[var(--workspace-header-row-height)] shrink-0 flex-nowrap items-center gap-2 border-b border-border-subtle bg-bg-primary px-4 shadow-2xs">
        <LibraryTitleCluster title={getSectionTitle()} userNamed={activeSection === 'folder'} count={documents.length} />

        {/* The filters scroll inside their own strip rather than wrap. The
            import split button is deliberately outside it: its menu must
            layer over the library, which a scroll container clips. */}
        <LibraryHeaderControls />

        {/* Import Menu. Outside the scrolling strip so the split button keeps
            its place at the end of the row at every width, and so its menu
            layers over the library instead of being clipped by a scroll box. */}
        <div className="shrink-0 text-xs">
          <ImportMenu
            isImporting={isImporting}
            onImportFromFiles={() => {
              void openFileDialog({ folderId: selectedFolderId });
            }}
            onImportFromWeb={() => {
              setWebImportModalOpen(true);
            }}
          />
        </div>
      </header>

      {/* Alert Notifications */}
      {readerError && (
        <div
          data-testid="reader-open-error-banner"
          role="alert"
          className="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-6 py-2 text-xs text-danger"
        >
          <div className="flex items-center gap-3">
            <span>{readerError}</span>
            {failedDocumentId && (
              <button
                type="button"
                data-testid="retry-open-document-button"
                onClick={() => {
                  void retryOpenDocument();
                }}
                className="rounded border border-danger/40 bg-bg-primary px-2 py-0.5 font-medium text-danger hover:bg-danger/10"
              >
                Retry opening document
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => {
              clearReaderError();
            }}
            className="ml-4 font-bold hover:opacity-75"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          data-testid="error-banner"
          role="alert"
          className="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-6 py-2 text-xs text-danger"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => {
              clearError();
            }}
            className="ml-4 font-bold hover:opacity-75"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>
      )}
      {successMessage && (
        <div
          data-testid="success-banner"
          role="status"
          className="flex items-center justify-between border-b border-success/20 bg-success/10 px-6 py-2 text-xs text-success"
        >
          <span>{successMessage}</span>
          <button
            type="button"
            aria-label="Dismiss success message"
            onClick={() => {
              clearSuccess();
            }}
            className="ml-4 font-bold hover:opacity-75"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>
      )}

      {/* Content area. The shell's reader viewport is the one main landmark
          that contains this view, so this is a plain container. */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">
          {/* First-run import hero is shown only after the authoritative
              library summary confirms that there are zero books. */}
          {showFirstRunImport && (
            <ImportDropzone
              isImporting={isImporting}
              onImportDroppedFiles={(files, mode) => {
                void importDroppedFiles(files, {
                  storageMode: mode,
                  folderId: selectedFolderId,
                });
              }}
              onOpenFileDialog={(mode) => {
                void openFileDialog({
                  storageMode: mode,
                  folderId: selectedFolderId,
                });
              }}
              onImportFromWeb={() => {
                setWebImportModalOpen(true);
              }}
            />
          )}
          {/* Document list / grid */}
          {isLoading ? (
            <div data-testid="library-loading" className="flex h-48 items-center justify-center text-xs text-text-secondary">
              <LoadingShimmerText>Loading documents...</LoadingShimmerText>
            </div>
          ) : errorMessage && documents.length === 0 ? (
            <div
              data-testid="library-load-error-state"
              className="flex h-48 flex-col items-center justify-center rounded-lg border border-danger/20 bg-danger/5 p-6 text-center text-xs text-text-secondary"
            >
              <AppIcon name="warning" size={30} className="text-danger" />
              <p className="mt-2 font-medium text-text-primary">Unable to load your library</p>
              <button
                type="button"
                data-testid="retry-library-load-button"
                onClick={() => {
                  void loadLibrary();
                  void loadSummary();
                }}
                className="mt-3 rounded-md border border-border-subtle bg-bg-primary px-3 py-1.5 font-medium text-text-primary hover:border-accent"
              >
                Retry
              </button>
            </div>
          ) : summary === null && documents.length === 0 ? (
            <div data-testid="library-status-pending" className="flex h-48 items-center justify-center text-xs text-text-secondary">
              <LoadingShimmerText>Checking your library...</LoadingShimmerText>
            </div>
          ) : showFirstRunImport ? null : documents.length === 0 ? (
            <div
              data-testid={hasLibraryBooks ? 'library-no-results-state' : 'library-empty-state'}
              className="flex h-48 flex-col items-center justify-center rounded-lg border border-border-subtle bg-bg-primary/50 p-6 text-center text-xs text-text-secondary"
            >
              <AppIcon name={hasLibraryBooks ? 'no-results' : 'library-empty'} size={30} />
              <p className="mt-2 font-medium text-text-primary">
                {hasLibraryBooks ? 'No documents match this view' : 'No documents found'}
              </p>
              <p className="mt-1 text-2xs">
                {hasLibraryBooks
                  ? 'Your library has books, but none match the current search or section.'
                  : 'Import a document above to begin reading.'}
              </p>
              {hasLibraryBooks && hasActiveViewFilter && (
                <button
                  type="button"
                  data-testid="clear-library-filters-button"
                  onClick={resetLibraryView}
                  className="mt-3 rounded-md border border-border-subtle bg-bg-primary px-3 py-1.5 font-medium text-text-primary hover:border-accent"
                >
                  Clear search and filters
                </button>
              )}
            </div>
          ) : viewMode === 'grid' ? (
            <div
              data-testid="document-grid"
              // Cover-first cards have their own 2:3 shape, so the grid tracks
              // the reference's ~200px column instead of a fixed column count.
              // `min()` keeps the track from exceeding the container at 200%
              // zoom or the minimum window width, where a fixed floor would
              // force horizontal overflow.
              className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr))]"
            >
              {documents.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  document={doc}
                  onOpen={(d) => {
                    void useReaderStore.getState().openDocument(d.id);
                  }}
                  onDetails={(d) => {
                    setSelectedDocumentDetails(d);
                  }}
                />
              ))}
            </div>
          ) : (
            <div
              data-testid="document-list"
              className="flex flex-col rounded-lg border border-border-subtle bg-bg-primary overflow-hidden shadow-2xs"
            >
              <div className="flex items-center justify-between border-b border-border-subtle bg-bg-surface px-3 py-2 text-2xs font-semibold text-text-secondary uppercase tracking-wider">
                <div className="flex-1">Title & Author</div>
                <div className="flex items-center gap-6">
                  <div className="w-16">Storage</div>
                  <div className="w-24 text-right">Progress</div>
                  <div className="w-20 text-right">Size</div>
                  <div className="w-24 text-right">Added</div>
                  <div className="w-16 text-right">Actions</div>
                </div>
              </div>
              {documents.map((doc) => (
                <DocumentListItem
                  key={doc.id}
                  document={doc}
                  onOpen={(d) => {
                    void useReaderStore.getState().openDocument(d.id);
                  }}
                  onDetails={(d) => {
                    setSelectedDocumentDetails(d);
                  }}
                />
              ))}
            </div>
          )}

          {/* Load More Button */}
          {hasMore && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                data-testid="load-more-button"
                disabled={isLoadingMore}
                onClick={() => {
                  void loadMore();
                }}
                className="rounded-md border border-border-subtle bg-bg-surface px-4 py-2 text-xs font-medium text-text-primary shadow-xs hover:border-accent hover:bg-bg-primary disabled:opacity-50"
              >
                {isLoadingMore
                  ? 'Loading more documents...'
                  : `Load More Documents (${String(documents.length)} loaded)`}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Library modals are mounted once at the app root by LibraryModalHost so
          sidebar triggers keep working while the reader owns this viewport. */}
    </div>
  );
}

/** Layout of the title cluster for a fixed section and for a folder the user named. */
const TITLE_LAYOUT = {
  fixed: { cluster: 'shrink-0 grow', heading: 'whitespace-nowrap' },
  userNamed: { cluster: 'min-w-28 flex-auto', heading: 'min-w-0 truncate' },
} as const;

/**
 * The section title and its document count. A fixed section title is short and
 * never cut; a folder name can be any length, so it truncates and keeps its
 * full text as the native tooltip.
 */
function LibraryTitleCluster({ title, userNamed, count }: {
  readonly title: string;
  readonly userNamed: boolean;
  readonly count: number;
}) {
  const layout = userNamed ? TITLE_LAYOUT.userNamed : TITLE_LAYOUT.fixed;
  return (
    <div className={`flex items-center gap-2 ${layout.cluster}`}>
      <h1
        data-testid="section-title"
        title={userNamed ? title : undefined}
        className={`text-lg font-semibold text-text-primary ${layout.heading}`}
      >
        {title}
      </h1>
      <span
        data-testid="document-count-badge"
        className="shrink-0 rounded-full bg-border-subtle px-2 py-0.5 text-xs font-medium text-text-secondary"
      >
        {count}
      </span>
    </div>
  );
}
