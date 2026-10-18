// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { DocumentMetadata, Folder, FolderTree, OpenedDocument } from '@shared/types/document';
import { App } from '../../src/renderer/app/App';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

const OPEN_DOCUMENT: DocumentMetadata = {
  id: 'doc-open-1',
  title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 4096,
  fileMtimeMs: 1,
  fileHash: 'open-doc-hash',
  pageCount: 560,
  folderId: 'f1',
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const PARENT_FOLDER: Folder = {
  id: 'f1',
  name: 'Computer Science',
  parentId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  documentCount: 1,
};

const CHILD_FOLDER: Folder = {
  id: 'f1-child',
  name: 'Distributed Systems',
  parentId: 'f1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  documentCount: 0,
};

const FOLDER_TREE: FolderTree[] = [
  { ...PARENT_FOLDER, children: [{ ...CHILD_FOLDER, children: [] }] },
];

const createFolder = vi.fn((name: string, parentId?: string | null) =>
  Promise.resolve({ ...CHILD_FOLDER, name, parentId: parentId ?? null })
);
/** The capability revocation the reader performs on its way out. */
const closeDocument = vi.fn(() => Promise.resolve());
const openDocument = vi.fn((): Promise<OpenedDocument> => Promise.reject(new Error('not implemented')));
const documents = vi.fn(() => Promise.resolve([OPEN_DOCUMENT]));

function installAppBridge(): void {
  stubBridge({
    app: {
      getInfo: () =>
        Promise.resolve({
          name: 'Interleaf',
          tagline: 'Read. Think. Build.',
          version: '0.2.0',
          platform: 'darwin',
          versions: { electron: '43.0.0', node: '24.0.0', chrome: '140.0.0' },
        }),
    },
    onboarding: {
      getLaunchState: () => Promise.resolve({
        verdict: 'done' as const,
        shouldAutoOpen: false,
        resumeStage: 'welcome' as const,
        settingsRowPresent: true,
        onboardingSectionPresent: true,
        priorInstallEvidence: true,
      }),
    },
    settings: { get: () => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS)) },
    library: {
      listDocuments: documents,
      openDocument,
      closeDocument,
      getContinueReading: documents,
      getRecentlyAdded: documents,
      getRecentlyRead: documents,
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
      createFolder,
      renameFolder: (id: string, name: string) => Promise.resolve({ ...PARENT_FOLDER, id, name }),
      deleteFolder: () => Promise.resolve(),
      listFolders: () => Promise.resolve([PARENT_FOLDER]),
      getFolderTree: () => Promise.resolve(FOLDER_TREE),
      getDocumentPreview: (documentId: string) =>
        Promise.resolve({
          documentId,
          format: 'pdf' as const,
          locationLabel: 'Page 1',
          isLastRead: false,
          snippet: 'Preview',
          coverAssetUrl: null,
          fallback: false,
        }),
    },
    annotations: {
      list: () => Promise.resolve([]),
      page: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 50 }),
    },
    search: { getIndexState: () => Promise.resolve(null) },
    ai: { listProviders: () => Promise.resolve([]) },
    credentials: { getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS) },
    chat: {
      listSessions: () => Promise.resolve([]),
      listMessages: () => Promise.resolve([]),
      listContext: () => Promise.resolve([]),
    },
    agent: {
      listProfiles: () => Promise.resolve([]),
      listProfileStatus: () => Promise.resolve({ profiles: [], modelDiscoveryPending: false }),
      listWorkingDirectories: () => Promise.resolve([]),
      listSessions: () => Promise.resolve([]),
      getModeAvailability: () => Promise.resolve([]),
    },
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  installAppBridge();
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
  useUiStore.setState({
    leftOpen: true,
    rightOpen: false,
    leftWidth: 256,
    rightWidth: 320,
    focusMode: false,
    shortcutsOpen: false,
    settingsOpen: false,
    compactActivePanel: null,
    loadedSettings: DEFAULT_APP_SETTINGS,
  });
  useReaderStore.setState({
    session: testReaderSession(OPEN_DOCUMENT),
    pageCount: 0,
    isLoading: false,
    error: null,
  });
  useLibraryStore.setState({
    folders: [PARENT_FOLDER, CHILD_FOLDER],
    folderTree: FOLDER_TREE,
    documents: [],
    activeSection: 'all',
    selectedFolderId: null,
    newFolderModalOpen: false,
    newFolderParentId: null,
    renameFolderModal: null,
    deleteFolderModal: null,
    moveDocumentModal: null,
    deleteDocumentModal: null,
    selectedDocumentDetails: null,
    errorMessage: null,
    successMessage: null,
  });
});

/** Clicks `testId` and waits for the library to have replaced the reader. */
async function goTo(testId: string): Promise<void> {
  fireEvent.click(await screen.findByTestId(testId));
  await waitFor(() => {
    expect(screen.getByTestId('library-view')).toBeInTheDocument();
  });
}

/**
 * Going to a place in the library while a document is open.
 *
 * Each destination in the rail is a request to be in the library at that place.
 * The reader owns the viewport, so the destination is only honoured if the
 * document is actually left: the section moves, the reader closes through
 * `closeDocument` — the one path that revokes the document's capabilities in
 * main — and the rail shows where the reader now is.
 */
describe('library destinations while a document is open', () => {
  test.each([
    ['nav-all-documents', 'all'],
    ['nav-continue-reading', 'continue_reading'],
    ['nav-recently-read', 'recent_read'],
  ])('%s leaves the document and lands on that destination', async (testId, section) => {
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('reader-view')).toBeInTheDocument();

    await goTo(testId);

    expect(screen.queryByTestId('reader-view')).toBeNull();
    expect(useLibraryStore.getState().activeSection).toBe(section);
    expect(useReaderStore.getState().session).toBeNull();
    // Leaving goes through the reader's own close, so the document's opaque
    // capability is revoked in main rather than left alive behind the library.
    await waitFor(() => { expect(closeDocument).toHaveBeenCalledWith(OPEN_DOCUMENT.id); });

    // The rail shows where the reader now is.
    expect(screen.getByTestId(testId).className).toContain('font-semibold');

    unmount();
  });

  test.each([
    ['folder-item-f1', 'f1'],
    ['folder-item-f1-child', 'f1-child'],
  ])('%s opens that folder in the library instead of staying in the document', async (testId, folderId) => {
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('reader-view')).toBeInTheDocument();

    await goTo(testId);

    expect(useLibraryStore.getState().activeSection).toBe('folder');
    expect(useLibraryStore.getState().selectedFolderId).toBe(folderId);
    expect(useReaderStore.getState().session).toBeNull();
    await waitFor(() => { expect(closeDocument).toHaveBeenCalledWith(OPEN_DOCUMENT.id); });
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-current', 'page');

    unmount();
  });

  test('folder management controls stay where they are', async () => {
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('reader-view')).toBeInTheDocument();

    for (const name of ['Add subfolder to Computer Science', 'Rename Computer Science', 'Delete Computer Science']) {
      fireEvent.click(await screen.findByRole('button', { name }));
      // Managing a folder is not going to it: the reader is untouched and the
      // library selection has not moved.
      expect(useReaderStore.getState().session?.document).toEqual(OPEN_DOCUMENT);
      expect(useLibraryStore.getState().activeSection).toBe('all');
      expect(closeDocument).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    }

    // Expanding a folder to see its children is not going to it either.
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse folder' }));
    expect(useReaderStore.getState().session?.document).toEqual(OPEN_DOCUMENT);
    expect(closeDocument).not.toHaveBeenCalled();

    unmount();
  });

  test('a destination chosen from the compact drawer closes the drawer with it', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
    useUiStore.setState({ compactActivePanel: 'left' });
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('reader-view')).toBeInTheDocument();

    await goTo('nav-recently-added');

    // The drawer was covering the destination it was asked to go to.
    expect(useUiStore.getState().compactActivePanel).toBeNull();
    expect(useLibraryStore.getState().activeSection).toBe('recent_added');
    expect(useReaderStore.getState().session).toBeNull();

    unmount();
  });

  test('choosing a destination from the library itself leaves the reader alone', async () => {
    useReaderStore.setState({ session: null });
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('library-view')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('nav-recently-added'));

    await waitFor(() => {
      expect(useLibraryStore.getState().activeSection).toBe('recent_added');
    });
    // Nothing was open, so nothing is closed and no capability work happens.
    expect(closeDocument).not.toHaveBeenCalled();

    unmount();
  });

  test('the destination beats an in-flight document open, whose stale capability is revoked', async () => {
    // Between the click that opened a document and the store settling, the
    // reader claims the viewport with no `session` and `isLoading`
    // true. A destination click inside that window goes through the reader's
    // own close path, which bumps the open sequence so the deferred open is
    // discarded and the capability it would have held is revoked in main.
    let resolveDeferredOpen: (opened: OpenedDocument) => void = () => undefined;
    openDocument.mockReturnValueOnce(new Promise<OpenedDocument>((resolve) => {
      resolveDeferredOpen = resolve;
    }));
    useReaderStore.setState({
      session: null,
      isLoading: true,
      failedDocumentId: null,
      failedInitialLocation: null,
    });
    const { unmount } = render(<App />);
    void useReaderStore.getState().openDocument(OPEN_DOCUMENT.id);
    await waitFor(() => {
      expect(useReaderStore.getState().isLoading).toBe(true);
    });

    fireEvent.click(await screen.findByTestId('nav-recently-added'));
    expect(useLibraryStore.getState().activeSection).toBe('recent_added');

    // The deferred open now resolves — after the user already left for the
    // library — so main revokes the capability it carried.
    resolveDeferredOpen({
      document: OPEN_DOCUMENT,
      assetUrl: 'interleaf-media://deferred',
      mediaAssets: [],
    });
    await waitFor(() => {
      expect(closeDocument).toHaveBeenCalledWith(OPEN_DOCUMENT.id);
    });

    expect(useReaderStore.getState().session).toBeNull();
    expect(useReaderStore.getState().isLoading).toBe(false);
    expect(screen.queryByTestId('reader-view')).toBeNull();
    expect(screen.getByTestId('library-view')).toBeInTheDocument();

    // The exact destination chosen stays active, and the rail shows it.
    expect(useLibraryStore.getState().activeSection).toBe('recent_added');
    expect(screen.getByTestId('nav-recently-added').className).toContain('font-semibold');

    unmount();
  });
});

/**
 * Regression for the reported defect: with a document open the reader owns the
 * viewport, so the library modals must not be mounted by `LibraryView`. The
 * sidebar's per-folder "+" sets the store flag that inerts the app shell; if
 * no dialog mounts alongside it, every control in the app becomes inert and
 * there is no Escape handler to recover.
 */
describe('subfolder creation from the sidebar while a document is open', () => {
  test('the folder "+" opens a keyboard-usable subfolder dialog and Escape leaves the reader usable', async () => {
    const { unmount } = render(<App />);

    // The reader — not the library — owns the viewport.
    expect(await screen.findByTestId('reader-view')).toBeInTheDocument();
    expect(screen.queryByTestId('library-view')).toBeNull();

    const shell = screen.getByTestId('app-shell');
    expect(shell).not.toHaveAttribute('inert');

    const plusButton = await screen.findByRole('button', {
      name: 'Add subfolder to Computer Science',
    });
    plusButton.focus();
    fireEvent.click(plusButton);

    const dialog = await screen.findByRole('dialog', { name: 'Create new subfolder' });
    // The shell is inert only because a real dialog is now mounted beside it.
    expect(shell).toHaveAttribute('inert');
    expect(shell).toHaveAttribute('aria-hidden', 'true');
    expect(dialog.closest('[inert]')).toBeNull();
    const input = screen.getByTestId('folder-name-input');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('new-folder-modal')).toBeNull();
      expect(plusButton).toHaveFocus();
    });
    expect(shell).not.toHaveAttribute('inert');
    expect(createFolder).not.toHaveBeenCalled();
    // Cancelling never touches the reader or the folder tree.
    expect(useReaderStore.getState().session?.document).toEqual(OPEN_DOCUMENT);
    expect(screen.getByTestId('reader-view')).toBeInTheDocument();
    expect(useLibraryStore.getState().folderTree).toEqual(FOLDER_TREE);

    unmount();
  });

  test('saving creates the child under the clicked parent and keeps the document open', async () => {
    const { unmount } = render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Add subfolder to Computer Science' })
    );
    await screen.findByRole('dialog', { name: 'Create new subfolder' });

    fireEvent.change(screen.getByTestId('folder-name-input'), {
      target: { value: 'Distributed Systems' },
    });
    fireEvent.click(screen.getByTestId('submit-folder-button'));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith('Distributed Systems', 'f1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('new-folder-modal')).toBeNull();
    });
    expect(screen.getByTestId('app-shell')).not.toHaveAttribute('inert');
    expect(useReaderStore.getState().session?.document).toEqual(OPEN_DOCUMENT);
    expect(screen.getByTestId('reader-view')).toBeInTheDocument();

    unmount();
  });

  test('root-folder creation from the sidebar still passes no parent', async () => {
    const { unmount } = render(<App />);

    fireEvent.click(await screen.findByTestId('new-folder-button'));
    await screen.findByRole('dialog', { name: 'Create new folder' });

    fireEvent.change(screen.getByTestId('folder-name-input'), {
      target: { value: 'Mathematics' },
    });
    fireEvent.click(screen.getByTestId('submit-folder-button'));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith('Mathematics', null);
    });

    unmount();
  });
});
