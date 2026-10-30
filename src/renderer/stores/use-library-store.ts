import { create } from 'zustand';
import type {
  BatchImportResult,
  DocumentFilter,
  DocumentFormat,
  DocumentImportOptions,
  DocumentLocation,
  DocumentMetadata,
  DocumentSortOption,
  Folder,
  FolderTree,
  WebArticleImportOutcome,
  WebArticleMediaSummary,
  LibrarySummary,
  ReadingPosition,
  StorageHealthUpdate,
} from '@shared/types/document';
import type { LibrarySettings } from '@shared/schemas/settings';
import { bridge } from '../app/api-client';

function collectFolderSubtreeIds(tree: readonly FolderTree[], rootId: string): Set<string> {
  const collected = new Set<string>([rootId]);
  const visit = (nodes: readonly FolderTree[]): void => {
    for (const node of nodes) {
      if (node.id === rootId || collected.has(node.parentId ?? '')) {
        collected.add(node.id);
      }
      visit(node.children);
    }
  };
  visit(tree);
  return collected;
}

/**
 * The sentence appended when a snapshot could not keep every picture.
 *
 * A snapshot missing images is still a good snapshot — the text is complete and
 * each missing figure keeps its caption and alt text — so this is a note on a
 * success, never a warning or a blocking state. It says how many and nothing
 * more: the reasons available on the other side of the bridge are all
 * descriptions of Interleaf's network and security behaviour. A summary the
 * bridge could not verify is `null`; the note then says the count is unknown
 * instead of implying every image was kept.
 */
function incompleteImagesNote(media: WebArticleMediaSummary | null): string {
  if (media === null) return " Interleaf couldn't confirm how many images were saved.";
  if (media.omitted <= 0) return '';
  return media.omitted === 1
    ? " One image couldn't be saved; its caption was kept."
    : ` ${String(media.omitted)} images couldn't be saved; their captions were kept.`;
}

let libraryRequestSequence = 0;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

export type LibrarySection =
  | 'all'
  | 'continue_reading'
  | 'recent_added'
  | 'recent_read'
  | 'folder';

/**
 * The one library dialog that owns the screen, with exactly the subject it
 * acts on. A single slot rather than a flag per dialog, so two dialogs can never
 * claim the screen at once and an open dialog always has its subject.
 */
export type LibraryModal =
  | { readonly kind: 'new-folder'; readonly parentId: string | null }
  | { readonly kind: 'rename-folder'; readonly folder: Folder }
  | { readonly kind: 'delete-folder'; readonly folder: Folder }
  | { readonly kind: 'move-document'; readonly document: DocumentMetadata }
  | { readonly kind: 'delete-document'; readonly document: DocumentMetadata }
  | { readonly kind: 'document-details'; readonly document: DocumentMetadata }
  | { readonly kind: 'web-import' };

type LibraryModalKind = LibraryModal['kind'];

/** True while any library dialog owns the screen. */
export function isLibraryModalOpen(state: Pick<LibraryState, 'libraryModal'>): boolean {
  return state.libraryModal !== null;
}

/** Each dialog's subject while it is the open one, for the dialogs to subscribe to. */
export const selectNewFolderModal = (state: Pick<LibraryState, 'libraryModal'>): Extract<LibraryModal, { kind: 'new-folder' }> | null =>
  state.libraryModal?.kind === 'new-folder' ? state.libraryModal : null;
export const selectRenameFolderModal = (state: Pick<LibraryState, 'libraryModal'>): Folder | null =>
  state.libraryModal?.kind === 'rename-folder' ? state.libraryModal.folder : null;
export const selectDeleteFolderModal = (state: Pick<LibraryState, 'libraryModal'>): Folder | null =>
  state.libraryModal?.kind === 'delete-folder' ? state.libraryModal.folder : null;
export const selectMoveDocumentModal = (state: Pick<LibraryState, 'libraryModal'>): DocumentMetadata | null =>
  state.libraryModal?.kind === 'move-document' ? state.libraryModal.document : null;
export const selectDeleteDocumentModal = (state: Pick<LibraryState, 'libraryModal'>): DocumentMetadata | null =>
  state.libraryModal?.kind === 'delete-document' ? state.libraryModal.document : null;
export const selectDocumentDetailsModal = (state: Pick<LibraryState, 'libraryModal'>): DocumentMetadata | null =>
  state.libraryModal?.kind === 'document-details' ? state.libraryModal.document : null;
export const selectWebImportModalOpen = (state: Pick<LibraryState, 'libraryModal'>): boolean =>
  state.libraryModal?.kind === 'web-import';

/**
 * Closes `kind` only if it is still the open dialog. A dialog that hands over
 * to another (Details → Move) closes itself after opening the next one, and
 * must not close its successor.
 */
function closingModal(state: Pick<LibraryState, 'libraryModal'>, kind: LibraryModalKind): Pick<LibraryState, 'libraryModal'> {
  return { libraryModal: state.libraryModal?.kind === kind ? null : state.libraryModal };
}

/** Which saved Library defaults a Settings save actually changed. */
type LibraryDefaultsForce = {
  readonly view: boolean;
  readonly sort: boolean;
};

export type LibraryState = {
  activeSection: LibrarySection;
  selectedFolderId: string | null;
  viewMode: 'grid' | 'list';
  searchQuery: string;
  formatFilter: DocumentFormat | 'all';
  sortBy: DocumentSortOption;

  /**
   * The saved Library preferences and whether this session has already moved
   * away from them. Hydration happens after the shell is on screen, so it must
   * not overwrite a view or sort the reader deliberately chose in the meantime.
   */
  defaultViewMode: 'grid' | 'list';
  defaultSortBy: DocumentSortOption;
  viewModeTouched: boolean;
  sortByTouched: boolean;

  documents: readonly DocumentMetadata[];
  folders: readonly Folder[];
  folderTree: readonly FolderTree[];
  summary: LibrarySummary | null;

  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  isImporting: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  libraryModal: LibraryModal | null;

  // Actions
  loadLibrary: () => Promise<void>;
  loadMore: () => Promise<void>;
  updateDocumentHealth: (update: StorageHealthUpdate) => void;
  loadFolders: () => Promise<void>;
  loadSummary: () => Promise<void>;
  setActiveSection: (section: LibrarySection, folderId?: string | null) => void;
  setSelectedFolderId: (folderId: string | null) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  setSearchQuery: (query: string) => void;
  setFormatFilter: (format: DocumentFormat | 'all') => void;
  setSortBy: (sort: DocumentSortOption) => void;
  /**
   * Applies the saved Library defaults.
   *
   * A default is normally only applied to a field the reader has not already
   * changed while browsing. `force` names the fields the reader just changed in
   * Settings, which do take effect immediately; a field that a save left alone
   * never disturbs the current view or sort.
   */
  applyLibraryDefaults: (defaults: LibrarySettings, force?: LibraryDefaultsForce) => void;
  resetLibraryView: () => void;

  importDroppedFiles: (files: readonly File[], options?: DocumentImportOptions) => Promise<BatchImportResult | null>;
  openFileDialog: (options?: DocumentImportOptions) => Promise<BatchImportResult | null>;
  /**
   * Captures a public web article. The rejection is deliberately re-thrown to
   * the dialog rather than parked in the shared error banner: the URL field is
   * still on screen and needs the message beside it.
   */
  importWebArticle: (url: string, options?: DocumentImportOptions) => Promise<WebArticleImportOutcome>;

  createFolder: (name: string, parentId?: string | null) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<Folder | null>;
  deleteFolder: (id: string) => Promise<boolean>;
  moveDocument: (documentId: string, folderId: string | null) => Promise<boolean>;
  deleteDocument: (documentId: string) => Promise<boolean>;
  updateReadingPosition: (documentId: string, location: DocumentLocation, progress: number) => Promise<ReadingPosition | null>;

  // Modal controls: a subject (or `true`) opens that dialog; `null` (or
  // `false`) closes it only while it is still the open one.
  setNewFolderModalOpen: (open: boolean, parentId?: string | null) => void;
  setRenameFolderModal: (folder: Folder | null) => void;
  setDeleteFolderModal: (folder: Folder | null) => void;
  setMoveDocumentModal: (doc: DocumentMetadata | null) => void;
  setDeleteDocumentModal: (doc: DocumentMetadata | null) => void;
  setWebImportModalOpen: (open: boolean) => void;
  setSelectedDocumentDetails: (doc: DocumentMetadata | null) => void;

  clearError: () => void;
  clearSuccess: () => void;
};

export const useLibraryStore = create<LibraryState>((set, get) => ({
  activeSection: 'all',
  selectedFolderId: null,
  viewMode: 'grid',
  searchQuery: '',
  formatFilter: 'all',
  sortBy: 'recent_added',

  defaultViewMode: 'grid',
  defaultSortBy: 'recent_added',
  viewModeTouched: false,
  sortByTouched: false,

  documents: [],
  folders: [],
  folderTree: [],
  summary: null,

  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  isImporting: false,
  errorMessage: null,
  successMessage: null,
  libraryModal: null,

  loadLibrary: async () => {
    const api = bridge.library;

    const requestSequence = ++libraryRequestSequence;
    set({ isLoading: true, errorMessage: null });
    try {
      const { activeSection, selectedFolderId, searchQuery, formatFilter, sortBy } = get();

      let docs: readonly DocumentMetadata[] = [];
      let moreAvailable = false;
      if (activeSection === 'continue_reading') {
        docs = await api.getContinueReading(50);
      } else if (activeSection === 'recent_added') {
        docs = await api.getRecentlyAdded(50);
      } else if (activeSection === 'recent_read') {
        docs = await api.getRecentlyRead(50);
      } else {
        const filter: DocumentFilter = {
          ...(activeSection === 'folder' ? { folderId: selectedFolderId } : {}),
          ...(searchQuery.trim().length > 0 ? { searchQuery: searchQuery.trim() } : {}),
          ...(formatFilter !== 'all' ? { format: formatFilter } : {}),
          sort: sortBy,
          offset: 0,
          limit: 50,
        };
        docs = await api.listDocuments(filter);
        moreAvailable = docs.length === 50;
      }

      if (requestSequence !== libraryRequestSequence) return;
      set({ documents: docs, isLoading: false, hasMore: moreAvailable });
    } catch (err) {
      if (requestSequence !== libraryRequestSequence) return;
      set({
        isLoading: false,
        hasMore: false,
        errorMessage: err instanceof Error ? err.message : 'Failed to load documents.',
      });
    }
  },

  loadMore: async () => {
    const {
      isLoadingMore,
      hasMore,
      isLoading,
      activeSection,
      selectedFolderId,
      searchQuery,
      formatFilter,
      sortBy,
      documents,
    } = get();
    if (isLoadingMore || !hasMore || isLoading) return;
    if (activeSection === 'continue_reading' || activeSection === 'recent_added' || activeSection === 'recent_read') {
      return;
    }

    const api = bridge.library;

    const requestSequence = libraryRequestSequence;
    set({ isLoadingMore: true });
    try {
      const offset = documents.length;
      const filter: DocumentFilter = {
        ...(activeSection === 'folder' ? { folderId: selectedFolderId } : {}),
        ...(searchQuery.trim().length > 0 ? { searchQuery: searchQuery.trim() } : {}),
        ...(formatFilter !== 'all' ? { format: formatFilter } : {}),
        sort: sortBy,
        offset,
        limit: 50,
      };
      const nextDocs = await api.listDocuments(filter);
      if (requestSequence !== libraryRequestSequence) return;
      const existingIds = new Set(documents.map((d) => d.id));
      const deduplicated = nextDocs.filter((d) => !existingIds.has(d.id));
      set({
        documents: [...documents, ...deduplicated],
        isLoadingMore: false,
        hasMore: nextDocs.length === 50,
      });
    } catch (err) {
      if (requestSequence !== libraryRequestSequence) return;
      set({
        isLoadingMore: false,
        errorMessage: err instanceof Error ? err.message : 'Failed to load more documents.',
      });
    }
  },

  updateDocumentHealth: (update: StorageHealthUpdate) => {
    set((state) => ({
      documents: state.documents.map((doc) =>
        doc.id === update.documentId
          ? {
              ...doc,
              storageHealth: update.storageHealth,
              ...(update.storageHealthMessage !== undefined
                ? { storageHealthMessage: update.storageHealthMessage }
                : {}),
            }
          : doc
      ),
    }));
  },

  loadFolders: async () => {
    const api = bridge.library;

    try {
      const [folders, folderTree] = await Promise.all([
        api.listFolders(),
        api.getFolderTree(),
      ]);
      set({ folders, folderTree });
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to load folders.',
      });
    }
  },

  loadSummary: async () => {
    const api = bridge.library;

    try {
      const summary = await api.getSummary();
      set({ summary });
    } catch {
      // Summary errors are non-critical
    }
  },

  setActiveSection: (section, folderId = null) => {
    set({ activeSection: section, selectedFolderId: folderId });
    void get().loadLibrary();
  },

  setSelectedFolderId: (folderId) => {
    set({ activeSection: 'folder', selectedFolderId: folderId });
    void get().loadLibrary();
  },

  setViewMode: (viewMode) => {
    set({ viewMode, viewModeTouched: true });
  },

  setSearchQuery: (searchQuery) => {
    set({ searchQuery });
    if (searchDebounce !== null) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void get().loadLibrary();
    }, 200);
  },

  setFormatFilter: (formatFilter) => {
    set({ formatFilter });
    void get().loadLibrary();
  },

  setSortBy: (sortBy) => {
    set({ sortBy, sortByTouched: true });
    void get().loadLibrary();
  },

  applyLibraryDefaults: (defaults, force) => {
    const state = get();
    const applyView = force?.view === true || !state.viewModeTouched;
    const applySort = force?.sort === true || !state.sortByTouched;
    const viewMode = applyView ? defaults.defaultView : state.viewMode;
    const sortBy = applySort ? defaults.defaultSort : state.sortBy;
    set({
      defaultViewMode: defaults.defaultView,
      defaultSortBy: defaults.defaultSort,
      viewMode,
      sortBy,
    });
    if (sortBy !== state.sortBy) void get().loadLibrary();
  },

  resetLibraryView: () => {
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    set({
      activeSection: 'all',
      selectedFolderId: null,
      searchQuery: '',
      formatFilter: 'all',
      sortBy: get().defaultSortBy,
      sortByTouched: false,
    });
    void get().loadLibrary();
  },

  importDroppedFiles: async (files, options) => {
    const api = bridge.library;

    set({ isImporting: true, errorMessage: null });
    try {
      const result = await api.importDroppedFiles(files, options);
      set({ isImporting: false });

      if (result.imported.length > 0) {
        set({
          successMessage: `Successfully imported ${String(result.imported.length)} document${result.imported.length > 1 ? 's' : ''}.`,
        });
      }
      if (result.failed.length > 0) {
        const firstError = result.failed[0]?.error ?? 'Import failed';
        set({
          errorMessage: `Import issue: ${firstError}${result.failed.length > 1 ? ` (${String(result.failed.length)} errors)` : ''}`,
        });
      }

      void get().loadLibrary();
      void get().loadFolders();
      void get().loadSummary();
      return result;
    } catch (err) {
      set({
        isImporting: false,
        errorMessage: err instanceof Error ? err.message : 'Failed to import dropped files.',
      });
      return null;
    }
  },

  openFileDialog: async (options) => {
    const api = bridge.library;

    try {
      const result = await api.openFileDialog(options);
      if (result.imported.length > 0) {
        set({
          successMessage: `Successfully imported ${String(result.imported.length)} document${result.imported.length > 1 ? 's' : ''}.`,
        });
        void get().loadLibrary();
        void get().loadFolders();
        void get().loadSummary();
      }
      if (result.failed.length > 0) {
        const firstError = result.failed[0]?.error ?? 'Import failed';
        set({
          errorMessage: `Import issue: ${firstError}${result.failed.length > 1 ? ` (${String(result.failed.length)} errors)` : ''}`,
        });
      }
      return result;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'File dialog import failed.',
      });
      return null;
    }
  },

  importWebArticle: async (url, options) => {
    const api = bridge.library;

    const result = await api.importWebArticle(url, options);
    const base = result.alreadyInLibrary
      ? `"${result.document.title}" is already in your library.`
      : `Imported "${result.document.title}".`;
    set((state) => ({
      ...closingModal(state, 'web-import'),
      successMessage: `${base}${incompleteImagesNote(result.media)}`,
      errorMessage: null,
    }));
    void get().loadLibrary();
    void get().loadSummary();
    return result;
  },

  createFolder: async (name, parentId) => {
    const api = bridge.library;

    try {
      const folder = await api.createFolder(name, parentId ?? null);
      set((state) => ({
        ...closingModal(state, 'new-folder'),
        successMessage: `Folder '${folder.name}' created.`,
      }));
      void get().loadFolders();
      void get().loadSummary();
      return folder;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to create folder.',
      });
      return null;
    }
  },

  renameFolder: async (id, name) => {
    const api = bridge.library;

    try {
      const folder = await api.renameFolder(id, name);
      set((state) => ({
        ...closingModal(state, 'rename-folder'),
        successMessage: `Folder renamed to '${folder.name}'.`,
      }));
      void get().loadFolders();
      return folder;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to rename folder.',
      });
      return null;
    }
  },

  deleteFolder: async (id) => {
    const api = bridge.library;

    const deletedIds = collectFolderSubtreeIds(get().folderTree, id);
    try {
      await api.deleteFolder(id);
      const selectedFolderId = get().selectedFolderId;
      const selectionWasDeleted =
        selectedFolderId !== null && deletedIds.has(selectedFolderId);
      set((state) => ({
        ...closingModal(state, 'delete-folder'),
        successMessage: 'Folder deleted.',
        activeSection: selectionWasDeleted ? 'all' : state.activeSection,
        selectedFolderId: selectionWasDeleted ? null : state.selectedFolderId,
      }));
      void get().loadFolders();
      void get().loadLibrary();
      void get().loadSummary();
      return true;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to delete folder.',
      });
      return false;
    }
  },

  moveDocument: async (documentId, folderId) => {
    const api = bridge.library;

    try {
      await api.moveDocumentToFolder(documentId, folderId);
      set((state) => ({
        ...closingModal(state, 'move-document'),
        // A move with no destination is a removal from a folder, and saying
        // "moved" there reads as if the book went somewhere.
        successMessage: folderId === null ? 'Document removed from folder.' : 'Document moved.',
      }));
      void get().loadLibrary();
      void get().loadFolders();
      return true;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to move document.',
      });
      return false;
    }
  },

  deleteDocument: async (documentId) => {
    const api = bridge.library;

    try {
      await api.deleteDocument(documentId);
      set((state) => ({
        ...closingModal(state, 'delete-document'),
        successMessage: 'Document removed from library.',
      }));
      void get().loadLibrary();
      void get().loadFolders();
      void get().loadSummary();
      return true;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to delete document.',
      });
      return false;
    }
  },

  updateReadingPosition: async (documentId, location, progress) => {
    const api = bridge.library;

    try {
      const position = await api.updateReadingPosition(documentId, location, progress);
      void get().loadLibrary();
      return position;
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : 'Failed to update reading position.',
      });
      return null;
    }
  },

  setWebImportModalOpen: (open) => {
    set((state) => (open ? { libraryModal: { kind: 'web-import' } } : closingModal(state, 'web-import')));
  },
  setNewFolderModalOpen: (open, parentId = null) => {
    set((state) => (open ? { libraryModal: { kind: 'new-folder', parentId } } : closingModal(state, 'new-folder')));
  },
  setRenameFolderModal: (folder) => {
    set((state) => (folder !== null ? { libraryModal: { kind: 'rename-folder', folder } } : closingModal(state, 'rename-folder')));
  },
  setDeleteFolderModal: (folder) => {
    set((state) => (folder !== null ? { libraryModal: { kind: 'delete-folder', folder } } : closingModal(state, 'delete-folder')));
  },
  setMoveDocumentModal: (document) => {
    set((state) => (document !== null ? { libraryModal: { kind: 'move-document', document } } : closingModal(state, 'move-document')));
  },
  setDeleteDocumentModal: (document) => {
    set((state) => (document !== null ? { libraryModal: { kind: 'delete-document', document } } : closingModal(state, 'delete-document')));
  },
  setSelectedDocumentDetails: (document) => {
    set((state) => (document !== null ? { libraryModal: { kind: 'document-details', document } } : closingModal(state, 'document-details')));
  },

  clearError: () => {
    set({ errorMessage: null });
  },
  clearSuccess: () => {
    set({ successMessage: null });
  },
}));
