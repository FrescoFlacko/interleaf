// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LibrarySidebar } from '../../src/renderer/components/LibrarySidebar';
import { DocumentCard } from '../../src/renderer/features/library/components/DocumentCard';
import { DocumentListItem } from '../../src/renderer/features/library/components/DocumentListItem';
import { getDocumentPreviewInfo } from '../../src/renderer/features/library/components/DocumentPreview';
import { LibraryModalHost } from '../../src/renderer/features/library/components/LibraryModalHost';
import { LibraryView } from '../../src/renderer/features/library/LibraryView';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import type { DocumentMetadata, Folder, FolderTree } from '@shared/types/document';
import axe from 'axe-core';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { InterleafAPI } from '@shared/types/api';
import { type BridgeStubs, stubBridge, testBridge } from '../helpers/interleaf-api';
import { VisibleIntersectionObserver } from '../helpers/intersection-observer';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

const MOCK_DOCS: DocumentMetadata[] = [
  {
    id: 'doc-pdf-1',
    title: 'Designing Data-Intensive Applications',
    author: 'Martin Kleppmann',
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 1024 * 1024 * 5,
    fileMtimeMs: Date.now(),
    fileHash: 'pdfhash123',
    pageCount: 560,
    folderId: 'f1',
    storageHealth: 'ok',
    readingPosition: {
      location: { format: 'pdf', pageIndex: 42 },
      progress: 0.42,
      updatedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: null,
  },
  {
    id: 'doc-epub-2',
    title: 'Clean Architecture',
    author: 'Robert C. Martin',
    format: 'epub',
    storageMode: 'link',
    fileSize: 1024 * 1024 * 2,
    fileMtimeMs: Date.now(),
    fileHash: 'epubhash456',
    pageCount: 300,
    folderId: null,
    storageHealth: 'missing',
    storageHealthMessage: 'File not found on original disk path',
    readingPosition: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: null,
  },
];

const MOCK_FOLDERS: Folder[] = [
  {
    id: 'f1',
    name: 'Computer Science',
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    documentCount: 1,
  },
];

const MOCK_TREE: FolderTree[] = [
  {
    id: 'f1',
    name: 'Computer Science',
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    documentCount: 1,
    children: [],
  },
];

function setupBridge(): void {
  const api: BridgeStubs = {
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
      importDroppedFiles: () =>
        Promise.resolve({ imported: [MOCK_DOCS[0]!], failed: [], totalAttempted: 1 }),
      openFileDialog: () =>
        Promise.resolve({ imported: [MOCK_DOCS[0]!], failed: [], totalAttempted: 1 }),
      importWebArticle: () =>
        Promise.resolve({ document: MOCK_DOCS[0]!, alreadyInLibrary: false, media: { archived: 0, omitted: 0 } }),
      listDocuments: () => Promise.resolve(MOCK_DOCS),
      openDocument: (id) => {
        const doc = MOCK_DOCS.find((d) => d.id === id) ?? MOCK_DOCS[0]!;
        return Promise.resolve({ document: doc, assetUrl: `interleaf-media://${id}`, mediaAssets: [] });
      },
      closeDocument: () => Promise.resolve(),
      deleteDocument: () => Promise.resolve(),
      getContinueReading: () => Promise.resolve([MOCK_DOCS[0]!]),
      getRecentlyAdded: () => Promise.resolve(MOCK_DOCS),
      getRecentlyRead: () => Promise.resolve([MOCK_DOCS[0]!]),
      getSummary: () =>
        Promise.resolve({
          totalDocuments: 2,
          formatCounts: { pdf: 1, epub: 1, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
          managedCount: 1,
          linkCount: 1,
          missingCount: 1,
          changedCount: 0,
          totalFolders: 1,
        }),
      createFolder: (name, parentId) =>
        Promise.resolve({
          id: 'new-f2',
          name,
          parentId: parentId ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documentCount: 0,
        }),
      renameFolder: (id, name) =>
        Promise.resolve({
          id,
          name,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documentCount: 0,
        }),
      deleteFolder: () => Promise.resolve(),
      listFolders: () => Promise.resolve(MOCK_FOLDERS),
      getFolderTree: () => Promise.resolve(MOCK_TREE),
      moveDocumentToFolder: () => Promise.resolve(),
      updateReadingPosition: (_docId, location, progress) =>
        Promise.resolve({
          location,
          progress,
          updatedAt: new Date().toISOString(),
        }),
      getDocumentPreview: (id) => {
        const doc = MOCK_DOCS.find((d) => d.id === id) ?? MOCK_DOCS[0]!;
        const info = getDocumentPreviewInfo(doc);
        return Promise.resolve({
          documentId: doc.id,
          format: doc.format,
          locationLabel: info.locationLabel,
          isLastRead: info.isLastRead,
          snippet: `Excerpt from ${doc.title}`,
          coverAssetUrl: null,
          fallback: false,
        });
      },
      onStorageHealthUpdated: () => () => undefined,
    },
    annotations: {
      list: () => Promise.resolve([]),
      page: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 50 }),
    },
    search: { getIndexState: () => Promise.resolve(null) },
    ai: { listProviders: () => Promise.resolve([]) },
    credentials: {
      getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS),
    },
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
  };

  stubBridge(api);
}

describe('Library Renderer UI', () => {
  beforeEach(() => {
    cleanup();
    setupBridge();
    // Every card these specs render sits in the visible part of the library.
    window.IntersectionObserver = VisibleIntersectionObserver;
    useLibraryStore.setState({
      activeSection: 'all',
      selectedFolderId: null,
      viewMode: 'grid',
      searchQuery: '',
      formatFilter: 'all',
      sortBy: 'recent_added',
      documents: MOCK_DOCS,
      folders: MOCK_FOLDERS,
      folderTree: MOCK_TREE,
      summary: {
        totalDocuments: 2,
        formatCounts: { pdf: 1, epub: 1, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
        managedCount: 1,
        linkCount: 1,
        missingCount: 1,
        changedCount: 0,
        totalFolders: 1,
      },
      isLoading: false,
      isImporting: false,
      errorMessage: null,
      successMessage: null,
    });
  });

  test('renders sidebar navigation items and an accessible nested folder list', () => {
    render(<LibrarySidebar />);

    expect(screen.getByTestId('nav-all-documents')).toBeTruthy();
    expect(screen.getByTestId('nav-continue-reading')).toBeTruthy();
    expect(screen.getByTestId('nav-recently-added')).toBeTruthy();
    expect(screen.getByTestId('nav-recently-read')).toBeTruthy();

    const folderList = screen.getByRole('list', { name: 'Virtual folders' });
    expect(folderList).toBeInTheDocument();
    expect(within(folderList).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByText('Computer Science')).toBeTruthy();
    expect(screen.getByTestId('folder-count-f1').textContent).toBe('1');
    expect(screen.getByTestId('library-summary-footer')).toBeTruthy();
  });

  test('selects an item in the accessible folder list', () => {
    render(<LibrarySidebar />);
    const f1 = screen.getByTestId('folder-item-f1');
    f1.focus();
    expect(f1).toHaveFocus();

    fireEvent.click(f1);
    expect(useLibraryStore.getState().selectedFolderId).toBe('f1');
    expect(useLibraryStore.getState().activeSection).toBe('folder');
  });

  test('renders document cards without type badges, with edge progress and titles', async () => {
    render(<LibraryView />);

    await waitFor(() => {
      expect(screen.getByTestId('document-card-doc-pdf-1')).toBeTruthy();
    });

    expect(screen.queryByTestId('format-badge-doc-pdf-1')).toBeNull();
    // The title appears twice by design: once as the generated cover's own
    // typography and once on the scrim, exactly as in reference 7a.
    expect(screen.getByTestId('document-title-doc-pdf-1')).toHaveTextContent(
      'Designing Data-Intensive Applications'
    );
    expect(screen.getByTestId('document-author-doc-pdf-1')).toHaveTextContent('Martin Kleppmann');

    // Progress reads only as the hairline on the card's bottom edge, which
    // carries the value for assistive technology instead of scrim text.
    expect(screen.queryByTestId('reading-progress-percent-doc-pdf-1')).toBeNull();
    const progressTrack = screen.getByTestId('reading-progress-track-doc-pdf-1');
    expect(progressTrack.getAttribute('role')).toBe('progressbar');
    expect(progressTrack.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByTestId('reading-progress-bar-doc-pdf-1')).toHaveStyle({ width: '42%' });
    expect(screen.getByTestId('document-card-doc-epub-2')).toBeTruthy();
    expect(screen.getByTestId('health-badge-doc-epub-2')).toHaveTextContent('Missing');

    // DocumentPreview integration
    expect(screen.getByTestId('document-preview-doc-pdf-1')).toBeTruthy();
    expect(screen.getByTestId('document-preview-doc-epub-2')).toBeTruthy();
    expect(screen.getByTestId('preview-location-badge-doc-pdf-1').textContent).toContain('Page 43');
    expect(screen.getByTestId('preview-location-badge-doc-epub-2').textContent).toContain('Cover');
  });

  test('never truncates a fixed section title, and truncates only a folder name with its tooltip', () => {
    const { rerender } = render(<LibraryView />);
    const fixed = screen.getByTestId('section-title');
    expect(fixed).toHaveTextContent('All Documents');
    expect(fixed).not.toHaveAttribute('title');
    expect(fixed.className).not.toContain('truncate');
    expect(fixed.parentElement?.className).toContain('shrink-0');
    expect(screen.getByTestId('library-search-input')).toHaveAttribute('placeholder', 'Search');
    expect(screen.getByRole('searchbox', { name: 'Search library by title or author' })).toBeTruthy();

    act(() => { useLibraryStore.setState({ activeSection: 'folder', selectedFolderId: 'f1' }); });
    rerender(<LibraryView />);
    const folder = screen.getByTestId('section-title');
    expect(folder).toHaveTextContent('Computer Science');
    expect(folder).toHaveAttribute('title', 'Computer Science');
    expect(folder.className).toContain('truncate');
  });

  test('toggles grid and list view modes', async () => {
    render(<LibraryView />);

    await waitFor(() => {
      expect(screen.getByTestId('document-grid')).toBeTruthy();
    });

    const listToggle = screen.getByTestId('list-view-toggle');
    fireEvent.click(listToggle);

    await waitFor(() => {
      expect(screen.getByTestId('document-list')).toBeTruthy();
      expect(screen.getByTestId('document-row-doc-pdf-1')).toBeTruthy();
    });
  });

  test('traps modal focus, closes with Escape, and restores trigger focus', async () => {
    render(
      <>
        <LibrarySidebar />
        <LibraryView />
        <LibraryModalHost />
      </>
    );

    const trigger = screen.getByTestId('new-folder-button');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Create new folder' });
    const input = screen.getByTestId('folder-name-input');
    const submit = screen.getByTestId('submit-folder-button');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    submit.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(input).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  test('mutation modals display and announce failures directly inside the modal with role=alert', async () => {

    // 1. NewFolderModal failure
    stubBridge({ library: { createFolder: vi.fn<InterleafAPI['library']['createFolder']>().mockRejectedValueOnce(
      new Error('Folder creation failed safely.')
    ) } });
    render(
      <>
        <LibrarySidebar />
        <LibraryView />
        <LibraryModalHost />
      </>
    );

    fireEvent.click(screen.getByTestId('new-folder-button'));
    fireEvent.change(await screen.findByTestId('folder-name-input'), {
      target: { value: 'Unavailable Folder' },
    });
    fireEvent.click(screen.getByTestId('submit-folder-button'));

    await waitFor(() => {
      const modal = screen.getByTestId('new-folder-modal');
      expect(modal).toBeInTheDocument();
      const alert = within(modal).getByRole('alert');
      expect(alert).toHaveTextContent('Folder creation failed safely.');
      expect(screen.getByTestId('error-banner')).toHaveTextContent('Folder creation failed safely.');
    });
    cleanup();

    // 2. RenameFolderModal failure
    stubBridge({ library: { renameFolder: vi.fn<InterleafAPI['library']['renameFolder']>().mockRejectedValueOnce(
      new Error('Folder rename failed safely.')
    ) } });
    useLibraryStore.setState({
      renameFolderModal: MOCK_FOLDERS[0]!,
    });
    render(<LibraryModalHost />);

    fireEvent.change(await screen.findByTestId('rename-folder-input'), {
      target: { value: 'New Name' },
    });
    fireEvent.click(screen.getByTestId('submit-rename-folder'));

    await waitFor(() => {
      const modal = screen.getByTestId('rename-folder-modal');
      expect(modal).toBeInTheDocument();
      const alert = within(modal).getByRole('alert');
      expect(alert).toHaveTextContent('Folder rename failed safely.');
    });
    cleanup();

    // 3. DeleteFolderModal failure
    stubBridge({ library: { deleteFolder: vi.fn<InterleafAPI['library']['deleteFolder']>().mockRejectedValueOnce(
      new Error('Folder delete failed safely.')
    ) } });
    useLibraryStore.setState({
      deleteFolderModal: MOCK_FOLDERS[0]!,
    });
    render(<LibraryModalHost />);

    fireEvent.click(await screen.findByTestId('confirm-delete-folder'));

    await waitFor(() => {
      const modal = screen.getByTestId('delete-folder-modal');
      expect(modal).toBeInTheDocument();
      const alert = within(modal).getByRole('alert');
      expect(alert).toHaveTextContent('Folder delete failed safely.');
    });
    cleanup();

    // 4. MoveDocumentModal failure
    stubBridge({ library: { moveDocumentToFolder: vi.fn<InterleafAPI['library']['moveDocumentToFolder']>().mockRejectedValueOnce(
      new Error('Document move failed safely.')
    ) } });
    useLibraryStore.setState({
      moveDocumentModal: MOCK_DOCS[0]!,
    });
    render(<LibraryModalHost />);

    fireEvent.click(await screen.findByTestId('submit-move-document'));

    await waitFor(() => {
      const modal = screen.getByTestId('move-document-modal');
      expect(modal).toBeInTheDocument();
      const alert = within(modal).getByRole('alert');
      expect(alert).toHaveTextContent('Document move failed safely.');
    });
    cleanup();

    // 5. DeleteDocumentModal failure
    stubBridge({ library: { deleteDocument: vi.fn<InterleafAPI['library']['deleteDocument']>().mockRejectedValueOnce(
      new Error('Document delete failed safely.')
    ) } });
    useLibraryStore.setState({
      deleteDocumentModal: MOCK_DOCS[0]!,
    });
    render(<LibraryModalHost />);

    fireEvent.click(await screen.findByTestId('confirm-delete-document'));

    await waitFor(() => {
      const modal = screen.getByTestId('delete-document-modal');
      expect(modal).toBeInTheDocument();
      const alert = within(modal).getByRole('alert');
      expect(alert).toHaveTextContent('Document delete failed safely.');
    });
  });

  test('opens the reader from the primary card and exposes details from the ellipsis', async () => {
    render(
      <>
        <LibraryView />
        <LibraryModalHost />
      </>
    );

    const openButton = await screen.findByRole('button', {
      name: 'Open Designing Data-Intensive Applications',
    });
    openButton.focus();
    expect(openButton).toHaveFocus();
    const openDocument = vi.spyOn(testBridge.library, 'openDocument');
    fireEvent.keyDown(openButton, { key: 'Enter' });
    fireEvent.click(openButton);
    await waitFor(() => {
      expect(openDocument).toHaveBeenCalledWith('doc-pdf-1');
    });

    const detailsButton = await screen.findByRole('button', {
      name: 'More actions for Designing Data-Intensive Applications',
    });
    detailsButton.focus();
    expect(detailsButton).toHaveFocus();
    fireEvent.click(detailsButton);

    expect(await screen.findByRole('dialog', { name: 'Document details' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(detailsButton).toHaveFocus();
    });

    fireEvent.click(detailsButton);
    const backdrop = await screen.findByTestId('document-details-backdrop');
    fireEvent.mouseDown(backdrop);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Document details' })).toBeNull();
    });
  });

  test('transitions details to Move/Delete without duplicate dialogs and returns focus to ellipsis', async () => {
    render(
      <>
        <LibraryView />
        <LibraryModalHost />
      </>
    );
    const menu = await screen.findByRole('button', {
      name: 'More actions for Designing Data-Intensive Applications',
    });

    menu.focus();
    fireEvent.click(menu);
    const details = await screen.findByRole('dialog', { name: 'Document details' });
    fireEvent.click(within(details).getByTestId('document-details-actions-trigger'));
    fireEvent.click(within(details).getByRole('menuitem', { name: 'Move...' }));
    expect(screen.queryByRole('dialog', { name: 'Document details' })).toBeNull();
    const move = await screen.findByRole('dialog', { name: 'Move document to folder' });
    expect(move).toBeInTheDocument();
    await waitFor(() => {
      expect(move.contains(document.activeElement)).toBe(true);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(menu).toHaveFocus();
    });

    fireEvent.click(menu);
    const detailsForDelete = await screen.findByRole('dialog', { name: 'Document details' });
    fireEvent.click(within(detailsForDelete).getByTestId('document-details-actions-trigger'));
    fireEvent.click(within(detailsForDelete).getByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByRole('dialog', { name: 'Document details' })).toBeNull();
    const deleteDialog = await screen.findByRole('alertdialog', { name: 'Delete document' });
    expect(deleteDialog).toBeInTheDocument();
    await waitFor(() => {
      expect(deleteDialog.contains(document.activeElement)).toBe(true);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(menu).toHaveFocus();
    });
  });

  test('does not let an older library response overwrite a newer request', async () => {
    let resolveOlder!: (documents: readonly DocumentMetadata[]) => void;
    let resolveNewer!: (documents: readonly DocumentMetadata[]) => void;
    const older = new Promise<readonly DocumentMetadata[]>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<readonly DocumentMetadata[]>((resolve) => {
      resolveNewer = resolve;
    });
    stubBridge({ library: { listDocuments: vi.fn<InterleafAPI['library']['listDocuments']>()
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer) } });

    useLibraryStore.setState({ searchQuery: 'older' });
    const olderRequest = useLibraryStore.getState().loadLibrary();
    useLibraryStore.setState({ searchQuery: 'newer' });
    const newerRequest = useLibraryStore.getState().loadLibrary();
    resolveNewer([MOCK_DOCS[1]!]);
    await newerRequest;
    resolveOlder([MOCK_DOCS[0]!]);
    await olderRequest;

    expect(useLibraryStore.getState().documents.map((doc) => doc.id)).toEqual(['doc-epub-2']);
  });

  test('clears a selected descendant when its ancestor folder is deleted', async () => {
    const child: FolderTree = {
      id: 'child-folder',
      name: 'Child',
      parentId: 'f1',
      documentCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: [],
    };
    useLibraryStore.setState({
      activeSection: 'folder',
      selectedFolderId: child.id,
      folderTree: [{ ...MOCK_TREE[0]!, children: [child] }],
    });

    expect(await useLibraryStore.getState().deleteFolder('f1')).toBe(true);
    expect(useLibraryStore.getState().activeSection).toBe('all');
    expect(useLibraryStore.getState().selectedFolderId).toBeNull();
  });

  test('handles drag and drop import on dropzone', async () => {
    stubBridge({ library: { listDocuments: vi.fn<InterleafAPI['library']['listDocuments']>().mockResolvedValue([]) } });
    stubBridge({ library: { getSummary: vi.fn<InterleafAPI['library']['getSummary']>().mockResolvedValue({
      totalDocuments: 0,
      formatCounts: { pdf: 0, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
      managedCount: 0,
      linkCount: 0,
      missingCount: 0,
      changedCount: 0,
      totalFolders: 0,
    }) } });
    useLibraryStore.setState({ documents: [], summary: { totalDocuments: 0, formatCounts: { pdf: 0, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 }, managedCount: 0, linkCount: 0, missingCount: 0, changedCount: 0, totalFolders: 0 } });
    render(<LibraryView />);

    const dropzone = await screen.findByTestId('import-dropzone');
    const fakeFile = new File(['%PDF-1.4 sample content'], 'dropped_book.pdf', {
      type: 'application/pdf',
    });

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [fakeFile],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('success-banner')).toBeTruthy();
    });
  });

  test('shows the first-run hero only for an authoritative zero-book library', async () => {
    stubBridge({ library: { listDocuments: vi.fn<InterleafAPI['library']['listDocuments']>().mockResolvedValue([]) } });
    stubBridge({ library: { getSummary: vi.fn<InterleafAPI['library']['getSummary']>().mockResolvedValue({
      totalDocuments: 0,
      formatCounts: { pdf: 0, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
      managedCount: 0,
      linkCount: 0,
      missingCount: 0,
      changedCount: 0,
      totalFolders: 0,
    }) } });
    useLibraryStore.setState({ documents: [], summary: null });

    render(<LibraryView />);

    await waitFor(() => {
      expect(screen.getByTestId('import-dropzone')).toBeInTheDocument();
    });
    expect(screen.getByText('Add books to your library')).toBeInTheDocument();
    expect(screen.queryByTestId('document-grid')).toBeNull();
    expect(screen.queryByTestId('library-empty-state')).toBeNull();
    expect(screen.getByTestId('import-files-button')).toBeEnabled();
  });

  test('keeps documents front and center and replaces the hero after books exist', async () => {
    render(<LibraryView />);

    await screen.findByTestId('document-grid');

    expect(screen.queryByTestId('import-dropzone')).toBeNull();
    expect(screen.queryByText('Add books to your library')).toBeNull();
    expect(screen.getByTestId('document-card-doc-pdf-1')).toBeInTheDocument();
    expect(screen.getByTestId('import-files-button')).toBeEnabled();
  });

  test('shows a filtered no-results state instead of the first-run hero when books exist', async () => {
    stubBridge({ library: { listDocuments: vi.fn<InterleafAPI['library']['listDocuments']>().mockResolvedValue([]) } });
    stubBridge({ library: { getSummary: vi.fn<InterleafAPI['library']['getSummary']>().mockResolvedValue({
      totalDocuments: 2,
      formatCounts: { pdf: 1, epub: 1, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
      managedCount: 1,
      linkCount: 1,
      missingCount: 0,
      changedCount: 0,
      totalFolders: 1,
    }) } });
    useLibraryStore.setState({
      documents: [],
      summary: null,
      searchQuery: 'does-not-exist',
    });

    render(<LibraryView />);

    await waitFor(() => {
      expect(screen.getByTestId('library-no-results-state')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('import-dropzone')).toBeNull();
    expect(screen.queryByText('Add books to your library')).toBeNull();
    expect(screen.getByTestId('clear-library-filters-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('clear-library-filters-button'));
    expect(useLibraryStore.getState().searchQuery).toBe('');
  });

  test('offers no storage-mode view filter while keeping format and sort', () => {
    render(<LibraryView />);

    expect(screen.queryByTestId('storage-mode-filter-select')).toBeNull();
    expect(screen.queryByText('All Storage')).toBeNull();
    expect(screen.queryByLabelText('Filter by storage mode')).toBeNull();
    expect(screen.getByTestId('format-filter-select')).toBeInTheDocument();
    expect(screen.getByTestId('sort-by-select')).toBeInTheDocument();
    // The renderer no longer carries the filter, so a listing request cannot
    // send a storage-mode narrowing the user has no way to choose.
    expect('storageModeFilter' in useLibraryStore.getState()).toBe(false);
  });

  test('passes automated accessibility checks for the library and an open modal', async () => {
    // Composed as the shell composes it: the view sits inside the reader
    // viewport's single main landmark.
    render(
      <>
        <LibrarySidebar />
        <main id="main-content"><LibraryView /></main>
        <LibraryModalHost />
      </>
    );
    await screen.findByTestId('document-grid');

    const base = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(base.violations.map((violation) => violation.id)).toEqual([]);

    fireEvent.click(screen.getByTestId('new-folder-button'));
    await screen.findByRole('dialog', { name: 'Create new folder' });
    const modal = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(modal.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('adds no landmark of its own inside the shell\'s single main landmark', async () => {
    // The app shell renders the library inside its reader viewport, which is
    // the document's one `main#main-content`.
    render(<main id="main-content"><LibraryView /></main>);
    await screen.findByTestId('document-grid');
    expect(document.querySelectorAll('main, [role="main"]')).toHaveLength(1);
    const landmarks = await axe.run(document.body, {
      runOnly: { type: 'rule', values: ['landmark-main-is-top-level', 'landmark-no-duplicate-main', 'landmark-unique'] },
    });
    expect(landmarks.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('updates document storage health badge progressively when onStorageHealthUpdated fires', async () => {
    let healthCallback: ((update: { documentId: string; storageHealth: 'ok' | 'missing' | 'changed' | 'checking'; storageHealthMessage?: string }) => void) | undefined;
    stubBridge({ library: { onStorageHealthUpdated: vi.fn<InterleafAPI['library']['onStorageHealthUpdated']>().mockImplementation((cb) => {
      healthCallback = cb;
      return () => {
        healthCallback = undefined;
      };
    }) } });

    const initialDocs: DocumentMetadata[] = [
      {
        id: 'doc-checking-1',
        title: 'Checking Document',
        author: 'Author',
        format: 'epub',
        storageMode: 'link',
        fileSize: 2048,
        fileMtimeMs: 123456789,
        fileHash: 'hash-checking',
        pageCount: null,
        folderId: null,
        storageHealth: 'checking',
        readingPosition: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: null,
      },
    ];

    stubBridge({ library: { listDocuments: vi.fn<InterleafAPI['library']['listDocuments']>().mockResolvedValue(initialDocs) } });

    render(<LibraryView />);
    await screen.findByTestId('document-grid');

    const badge = await screen.findByTestId('health-badge-doc-checking-1');
    expect(badge.textContent).toContain('Checking...');

    // Simulate main process progressive health update notification
    expect(healthCallback).toBeDefined();
    healthCallback!({
      documentId: 'doc-checking-1',
      storageHealth: 'missing',
      storageHealthMessage: 'File not found on original disk path',
    });

    await waitFor(() => {
      const updatedBadge = screen.getByTestId('health-badge-doc-checking-1');
      expect(updatedBadge.textContent).toContain('Missing');
    });
  });

  test('real openDocument rejection records retry target and location, then real retry succeeds into activeDocument', async () => {
    const { useReaderStore } = await import('../../src/renderer/stores/use-reader-store');
    useReaderStore.setState({ session: null, error: null, failedDocumentId: null, failedInitialLocation: null });

    const openDocSpy = vi.spyOn(testBridge.library, 'openDocument');
    // First call rejects
    openDocSpy.mockRejectedValueOnce(new Error('EBUSY: resource locked'));

    const targetLocation = { format: 'pdf' as const, pageIndex: 4 };
    await useReaderStore.getState().openDocument('doc-pdf-1', targetLocation);

    expect(useReaderStore.getState().session).toBeNull();
    expect(useReaderStore.getState().error).toBe('EBUSY: resource locked');
    expect(useReaderStore.getState().failedDocumentId).toBe('doc-pdf-1');
    expect(useReaderStore.getState().failedInitialLocation).toEqual(targetLocation);

    render(<LibraryView />);

    const banner = await screen.findByTestId('reader-open-error-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('EBUSY: resource locked');

    // Second call will succeed
    openDocSpy.mockResolvedValueOnce({
      document: MOCK_DOCS[0]!,
      assetUrl: 'interleaf-media://doc-pdf-1',
      mediaAssets: [],
    });

    const retryBtn = screen.getByTestId('retry-open-document-button');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(useReaderStore.getState().session?.document.id).toBe('doc-pdf-1');
      expect(useReaderStore.getState().error).toBeNull();
      expect(useReaderStore.getState().failedDocumentId).toBeNull();
      expect(useReaderStore.getState().session?.initialLocation).toEqual(targetLocation);
    });
  });

  test('dismissing reader open error banner clears error from useReaderStore', async () => {
    const { useReaderStore } = await import('../../src/renderer/stores/use-reader-store');
    useReaderStore.setState({
      error: 'Corrupted document archive or invalid file.',
      failedDocumentId: 'doc-pdf-1',
      failedInitialLocation: null,
    });

    render(<LibraryView />);

    const banner = await screen.findByTestId('reader-open-error-banner');
    expect(banner).toBeInTheDocument();

    const dismissBtn = within(banner).getByLabelText('Dismiss error');
    fireEvent.click(dismissBtn);
    expect(useReaderStore.getState().error).toBeNull();
    expect(useReaderStore.getState().failedDocumentId).toBeNull();
  });

  test('useLibraryStore and LibraryView paginate in bounded batches through the load more button without duplicates', async () => {
    const bulkDocs: DocumentMetadata[] = Array.from({ length: 130 }, (_, index) => ({
      id: `doc-bulk-${String(index + 1).padStart(3, '0')}`,
      title: `Scalable System Design Vol ${String(index + 1)}`,
      author: `Author ${String(index % 10)}`,
      format: 'pdf',
      storageMode: 'managed',
      fileSize: 1024 * 1024,
      fileMtimeMs: Date.now(),
      fileHash: `hash-${String(index + 1)}`,
      pageCount: 100,
      folderId: null,
      source: null,
      storageHealth: 'ok',
      readingPosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const listCalls: { offset: number; limit: number }[] = [];
    stubBridge({
      library: {
        listDocuments: vi.fn((filter?: { offset?: number; limit?: number }) => {
          const offset = filter?.offset ?? 0;
          const limit = filter?.limit ?? 50;
          listCalls.push({ offset, limit });
          return Promise.resolve(bulkDocs.slice(offset, offset + limit));
        }),
      },
    });
    useLibraryStore.setState({
      documents: [],
      hasMore: false,
      isLoading: false,
      activeSection: 'all',
    });

    // 1. Render LibraryView and wait for initial 50 cards to be mounted
    const { container } = render(<LibraryView />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="document-card-"]').length).toBe(50);
    });

    expect(listCalls[0]).toEqual({ offset: 0, limit: 50 });
    expect(useLibraryStore.getState().documents.length).toBe(50);
    expect(useLibraryStore.getState().hasMore).toBe(true);

    // 2. Load the second page from the load more button
    const loadMoreButton = await screen.findByTestId('load-more-button');
    expect(loadMoreButton.textContent).toContain('50 loaded');
    fireEvent.click(loadMoreButton);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="document-card-"]').length).toBe(100);
    });
    expect(listCalls[1]).toEqual({ offset: 50, limit: 50 });
    expect(useLibraryStore.getState().documents.length).toBe(100);

    // 3. Trigger loadMore for the short final page, which ends pagination
    await useLibraryStore.getState().loadMore();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="document-card-"]').length).toBe(130);
    });
    expect(listCalls[2]).toEqual({ offset: 100, limit: 50 });
    expect(useLibraryStore.getState().documents.length).toBe(130);
    expect(useLibraryStore.getState().hasMore).toBe(false);
    expect(screen.queryByTestId('load-more-button')).toBeNull();

    // 4. Verify absolute uniqueness: no duplicate document IDs across all pages
    const allIds = useLibraryStore.getState().documents.map((d) => d.id);
    expect(new Set(allIds).size).toBe(130);
  });

  test('DocumentCard opens on primary keyboard/pointer activation, isolates ellipsis/actions, and avoids nested buttons', () => {
    const onOpen = vi.fn();
    const onDetails = vi.fn();

    const doc: DocumentMetadata = {
      id: 'doc-long-test',
      title: 'A Very Long Document Title That Tests Overflow And Edge Case Containment Behavior Across Multiple Viewports',
      author: 'Author With Extremely Long Name and Affiliation Details',
      format: 'markdown',
      storageMode: 'link',
      fileSize: 4500,
      fileMtimeMs: Date.now(),
      fileHash: 'mdhash456',
      pageCount: null,
      folderId: null,
      storageHealth: 'ok',
      readingPosition: {
        location: { format: 'markdown', blockIndex: 5 },
        progress: 0.75,
        updatedAt: new Date(1774444800000).toISOString(),
      },
      createdAt: new Date(1774444800000).toISOString(),
      updatedAt: new Date(1774444800000).toISOString(),
      source: null,
    };

    const { container } = render(
      <DocumentCard
        document={doc}
        onOpen={onOpen}
        onDetails={onDetails}
      />
    );

    // 1. Verify card element has overflow-hidden
    const card = screen.getByTestId('document-card-doc-long-test');
    expect(card.className).toContain('overflow-hidden');

    // 2. Verify no button is nested inside another button
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      expect(btn.parentElement?.closest('button')).toBeNull();
    }

    // 3. Verify accessible names
    const openBtn = screen.getByRole('button', { name: `Open ${doc.title}` });
    const detailsBtn = screen.getByRole('button', { name: `More actions for ${doc.title}` });

    expect(screen.getByTestId(`read-doc-${doc.id}`)).toBe(openBtn);
    expect(screen.queryByRole('button', { name: `Read ${doc.title}` })).toBeNull();
    expect(screen.queryByRole('button', { name: `Move ${doc.title} to folder` })).toBeNull();
    expect(screen.queryByRole('button', { name: `Delete ${doc.title}` })).toBeNull();
    expect(detailsBtn).toBeInTheDocument();

    fireEvent.click(card);
    fireEvent.click(openBtn);
    fireEvent.keyDown(openBtn, { key: 'Enter' });
    fireEvent.keyDown(openBtn, { key: ' ' });
    // Native buttons synthesize the click for Enter/Space; the explicit click below
    // models that browser activation in jsdom while the key events verify focusable semantics.
    fireEvent.click(openBtn);
    expect(onOpen).toHaveBeenCalledTimes(3);

    fireEvent.click(detailsBtn);
    expect(onDetails).toHaveBeenCalledWith(doc);
  });

  test('DocumentListItem exposes the same open/details contract for linked, missing, and changed files', () => {
    const onOpen = vi.fn();
    const onDetails = vi.fn();
    const doc = { ...MOCK_DOCS[1]!, storageHealth: 'changed' as const, storageHealthMessage: 'Changed on disk' };

    const { rerender } = render(
      <DocumentListItem
        document={doc}
        onOpen={onOpen}
        onDetails={onDetails}
      />
    );

    const open = screen.getByRole('button', { name: `Open ${doc.title}` });
    const details = screen.getByRole('button', { name: `More actions for ${doc.title}` });
    fireEvent.click(open);
    fireEvent.click(details);
    expect(onOpen).toHaveBeenCalledWith(doc);
    expect(onDetails).toHaveBeenCalledWith(doc);
    expect(screen.getByText('Linked')).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Open ${doc.title}` })).toBeInTheDocument();

    rerender(
      <DocumentListItem
        document={{ ...doc, storageHealth: 'missing', storageHealthMessage: 'File missing' }}
        onOpen={onOpen}
        onDetails={onDetails}
      />
    );
    expect(screen.getByText('Missing')).toBeInTheDocument();

    rerender(
      <DocumentListItem
        document={{ ...doc, storageMode: 'managed', storageHealth: 'ok' }}
        onOpen={onOpen}
        onDetails={onDetails}
      />
    );
    expect(screen.queryByText('Linked')).toBeNull();
  });

  test('getDocumentPreviewInfo resolves page 1/cover by default and last-read location when reading position exists', () => {
    const baseDoc: DocumentMetadata = {
      id: 'doc-preview-test',
      title: 'Distributed Systems',
      author: 'Leslie Lamport',
      format: 'pdf',
      storageMode: 'managed',
      fileSize: 1024 * 1024,
      fileMtimeMs: Date.now(),
      fileHash: 'pdf123',
      pageCount: 100,
      folderId: null,
      storageHealth: 'ok',
      readingPosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: null,
    };

    // Default PDF preview -> Page 1
    const pdfDefault = getDocumentPreviewInfo(baseDoc);
    expect(pdfDefault.locationLabel).toBe('Page 1');
    expect(pdfDefault.isLastRead).toBe(false);
    expect(pdfDefault.pageNumber).toBe(1);

    // PDF with reading progress -> Page 42
    const pdfRead = getDocumentPreviewInfo({
      ...baseDoc,
      readingPosition: {
        location: { format: 'pdf', pageIndex: 41, pageLabel: 'Page 42' },
        progress: 0.42,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(pdfRead.locationLabel).toBe('Page 42');
    expect(pdfRead.isLastRead).toBe(true);
    expect(pdfRead.pageNumber).toBe(42);

    // Markdown default -> Page 1
    const mdDefault = getDocumentPreviewInfo({ ...baseDoc, format: 'markdown' });
    expect(mdDefault.locationLabel).toBe('Page 1');
    expect(mdDefault.isLastRead).toBe(false);

    // Markdown with reading progress -> Section 5
    const mdRead = getDocumentPreviewInfo({
      ...baseDoc,
      format: 'markdown',
      readingPosition: {
        location: { format: 'markdown', blockIndex: 4 },
        progress: 0.5,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(mdRead.locationLabel).toBe('Section 5');
    expect(mdRead.isLastRead).toBe(true);

    // Markdown with a heading anchor -> the heading
    const mdHeading = getDocumentPreviewInfo({
      ...baseDoc,
      format: 'markdown',
      readingPosition: {
        location: { format: 'markdown', blockIndex: 4, headingId: 'architecture' },
        progress: 0.25,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(mdHeading.format).toBe('markdown');
    expect(mdHeading.locationLabel).toBe('# architecture');
    expect(mdHeading.isLastRead).toBe(true);

    // EPUB default -> Cover
    const epubDefault = getDocumentPreviewInfo({ ...baseDoc, format: 'epub' });
    expect(epubDefault.locationLabel).toBe('Cover');
    expect(epubDefault.isLastRead).toBe(false);

    // EPUB with reading progress -> percentage
    const epubRead = getDocumentPreviewInfo({
      ...baseDoc,
      format: 'epub',
      readingPosition: {
        location: { format: 'epub', cfi: '/6/4[chap01]!/4/2/10' },
        progress: 0.68,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(epubRead.locationLabel).toBe('p. 68%');
    expect(epubRead.isLastRead).toBe(true);
  });

  test('DocumentPreview renders cover image when the preview carries a cover and format preview surface with location badge otherwise', async () => {
    const docWithCover: DocumentMetadata = {
      id: 'doc-with-cover',
      title: 'Clean Code',
      author: 'Robert C. Martin',
      format: 'epub',
      storageMode: 'managed',
      fileSize: 2048,
      fileMtimeMs: Date.now(),
      fileHash: 'epub123',
      pageCount: null,
      folderId: null,
      storageHealth: 'ok',
      readingPosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: null,
    };

    // Covers arrive through main's preview answer, never on the document metadata.
    stubBridge({ library: { getDocumentPreview: (id) => {
      const doc = id === docWithCover.id ? docWithCover : { ...docWithCover, id, format: 'pdf' as const };
      const info = getDocumentPreviewInfo(doc);
      return Promise.resolve({
        documentId: id,
        format: doc.format,
        locationLabel: info.locationLabel,
        isLastRead: info.isLastRead,
        snippet: `Excerpt from ${doc.title}`,
        coverAssetUrl: id === docWithCover.id ? 'interleaf-media://covers/doc-with-cover.png' : null,
        fallback: false,
      });
    } } });

    const { rerender } = render(<DocumentCard document={docWithCover} onOpen={vi.fn()} onDetails={vi.fn()} />);

    // 1. Image element rendered with alt text and lazy loading
    const img = await screen.findByRole('img', { name: 'Cover of Clean Code' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('loading', 'lazy');
    // The opaque capability URL main issued is used as-is, and it replaces the
    // generated cover.
    expect(img).toHaveAttribute('src', 'interleaf-media://covers/doc-with-cover.png');
    expect(screen.queryByTestId('generated-cover-doc-with-cover')).toBeNull();

    // 2. Location badge present
    const badge = screen.getByTestId('preview-location-badge-doc-with-cover');
    expect(badge).toHaveTextContent('Cover');

    // 3. Rerender with PDF format and reading progress (no coverAssetUrl)
    const docPdf: DocumentMetadata = {
      ...docWithCover,
      id: 'doc-pdf-preview',
      format: 'pdf',
      readingPosition: {
        location: { format: 'pdf', pageIndex: 2 },
        progress: 0.3,
        updatedAt: new Date().toISOString(),
      },
    };

    rerender(<DocumentCard document={docPdf} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const previewContainer = screen.getByTestId('document-preview-doc-pdf-preview');
    expect(previewContainer).toBeInTheDocument();
    expect(previewContainer).toHaveAttribute('aria-label', 'Preview of Clean Code (Page 3)');
    // Without artwork the card falls back to the generated typographic cover.
    expect(screen.getByTestId('generated-cover-doc-pdf-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-cover-image-doc-pdf-preview')).toBeNull();

    const pdfBadge = screen.getByTestId('preview-location-badge-doc-pdf-preview');
    expect(pdfBadge).toHaveTextContent('Page 3');
  });

  test('web import modal in LibraryModalHost restores focus to import-options-button when closed', async () => {
    render(
      <>
        <LibraryView />
        <LibraryModalHost />
      </>
    );

    const optionsBtn = screen.getByTestId('import-options-button');
    fireEvent.click(optionsBtn);

    const webItem = await screen.findByTestId('import-from-web-item');
    fireEvent.click(webItem);

    const modal = await screen.findByTestId('import-web-article-modal');
    expect(modal).toBeInTheDocument();

    // Press Escape on document to dismiss the modal
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('import-web-article-modal')).toBeNull();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(optionsBtn);
    });
  });
});
