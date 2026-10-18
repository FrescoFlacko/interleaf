// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ReaderView } from '../../src/renderer/features/reader/ReaderView';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { DocumentMetadata, TableOfContentsItem } from '@shared/types/document';
import type { SearchHighlightResult } from '../../src/renderer/features/reader/types';
import type { SearchMatchAnchor } from '@shared/types/search';
import axe from 'axe-core';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { chooseValue } from '../helpers/listbox-select';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const MOCK_PDF_DOC: DocumentMetadata = {
  id: 'doc-pdf-1',
  title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024 * 1024 * 5,
  fileMtimeMs: Date.now(),
  fileHash: 'pdfhash123',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: {
    location: { format: 'pdf', pageIndex: 0 },
    progress: 0.1,
    updatedAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: null,
};

const MOCK_TOC: TableOfContentsItem[] = [
  {
    id: 'toc-0-1',
    title: 'Chapter 1: Reliable Systems',
    location: { format: 'pdf', pageIndex: 0 },
    level: 0,
    children: [],
  },
  {
    id: 'toc-0-2',
    title: 'Chapter 2: Data Models',
    location: { format: 'pdf', pageIndex: 3 },
    level: 0,
    children: [
      {
        id: 'toc-1-1',
        title: 'Section 2.1: Relational vs Document',
        location: { format: 'pdf', pageIndex: 4 },
        level: 1,
        children: [],
      },
    ],
  },
];

describe('ReaderView Component (Phases 4 & 10 UX)', () => {
  beforeEach(() => {
    cleanup();
    useReaderStore.setState({
      session: testReaderSession(MOCK_PDF_DOC, { assetUrl: 'interleaf-media://mock-asset-id' }),
      currentPage: 1,
      pageCount: 10,
      zoom: 1.0,
      zoomMode: 'fit-width',
      tableOfContents: MOCK_TOC,
      isTocOpen: false,
      isLoading: false,
      error: null,
    });
    useUiStore.setState({
      focusMode: false,
      focusSnapshot: null,
    });
    useAnnotationStore.setState({ selection: null, selectionIssue: null });
  });

  test('renders reader header toolbar with a truncated title, no format badge, and navigation controls', () => {
    renderWithChatStore(chat, <ReaderView />);

    expect(screen.getByTestId('reader-header-toolbar')).toBeInTheDocument();
    const title = screen.getByTestId('reader-document-title');
    expect(title).toHaveTextContent('Designing Data-Intensive Applications');
    // The title is truncated so the controls beside it keep working.
    expect(title.className).toContain('truncate');
    // The format is evident from the document; the badge is gone entirely.
    expect(screen.queryByTestId('reader-format-badge')).toBeNull();
    expect(screen.getByTestId('page-number-input')).toHaveValue('1');
    expect(screen.getByTestId('total-pages')).toHaveTextContent('/ 10');
    expect(screen.getByTestId('pdf-viewport-container')).toBeInTheDocument();
  });

  test('handles page navigation via buttons and input', () => {
    const goToPageSpy = vi.fn();
    useReaderStore.setState({
      goToPage: goToPageSpy,
    });

    renderWithChatStore(chat, <ReaderView />);

    const nextBtn = screen.getByTestId('next-page-button');
    fireEvent.click(nextBtn);
    expect(goToPageSpy).toHaveBeenCalledWith(2);

    const pageInput = screen.getByTestId('page-number-input');
    fireEvent.change(pageInput, { target: { value: '5' } });
    fireEvent.blur(pageInput);
    expect(goToPageSpy).toHaveBeenCalledWith(5);
  });

  test('handles zoom controls and mode changes inside the document settings menu', () => {
    const zoomInSpy = vi.fn();
    const zoomOutSpy = vi.fn();
    const setZoomSpy = vi.fn();

    useReaderStore.setState({
      zoomIn: zoomInSpy,
      zoomOut: zoomOutSpy,
      setZoom: setZoomSpy,
    });

    renderWithChatStore(chat, <ReaderView />);

    // Defect 24: zoom controls live inside the Document settings popover.
    fireEvent.click(screen.getByTestId('document-settings-button'));
    expect(screen.getByTestId('document-settings-popover')).toBeTruthy();

    fireEvent.click(screen.getByTestId('zoom-in-button'));
    expect(zoomInSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('zoom-out-button'));
    expect(zoomOutSpy).toHaveBeenCalledTimes(1);

    const zoomSelect = screen.getByTestId('zoom-mode-select');
    chooseValue(zoomSelect, 'fit-page');
    expect(setZoomSpy).toHaveBeenCalledWith('fit-page');

    chooseValue(zoomSelect, '1.5');
    expect(setZoomSpy).toHaveBeenCalledWith(1.5);
  });

  test('toggles table of contents drawer and navigates to selected chapter', () => {
    const goToLocationSpy = vi.fn();
    useReaderStore.setState({
      goToLocation: goToLocationSpy,
    });

    renderWithChatStore(chat, <ReaderView />);

    // Click Outline button to open TOC
    const tocBtn = screen.getByTestId('toggle-toc-button');
    fireEvent.click(tocBtn);

    expect(screen.getByTestId('reader-outline-sidebar')).toBeInTheDocument();
    expect(screen.getByText('Chapter 1: Reliable Systems')).toBeInTheDocument();
    expect(screen.getByText('Chapter 2: Data Models')).toBeInTheDocument();
    expect(screen.getByText('Section 2.1: Relational vs Document')).toBeInTheDocument();

    // Click Chapter 2 TOC item
    fireEvent.click(screen.getByTestId('toc-item-toc-0-2'));
    expect(goToLocationSpy).toHaveBeenCalledWith({ format: 'pdf', pageIndex: 3 });

    // Close TOC button
    fireEvent.click(screen.getByTestId('close-toc-button'));
    expect(useReaderStore.getState().isTocOpen).toBe(false);
  });

  test('offers no library control in the reader header; the library rail owns that navigation', () => {
    renderWithChatStore(chat, <ReaderView />);
    expect(screen.queryByTestId('reader-back-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to library' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Library/ })).toBeNull();
  });

  test('shows the selection toolbar in Focus Mode instead of hiding it', () => {
    useAnnotationStore.setState({
      loaded: testLoadedAnnotations(MOCK_PDF_DOC.id),
      selection: {
        selectedText: 'a passage read distraction-free',
        totalSelectedLength: 31,
        chatDescriptor: {
          format: 'pdf',
          startPageIndex: 0,
          endPageIndex: 0,
          startPageLabel: '1',
          endPageLabel: '1',
        },
        anchor: {
          format: 'pdf',
          pageIndex: 0,
          quote: { exact: 'a passage read distraction-free', prefix: '', suffix: '' },
        },
        clientRect: { left: 20, top: 100, width: 120, height: 20 },
      },
    });
    renderWithChatStore(chat, <ReaderView />);
    act(() => { useUiStore.getState().toggleFocusMode(); });
    expect(useUiStore.getState().focusMode).toBe(true);

    // Focus Mode hides the reader chrome, not the reader's own selection: the
    // toolbar keeps the same actions it offers in normal mode, and it stays a
    // real top layer (`hasOpenTopLayer` ignores `[hidden]`).
    const toolbar = screen.getByTestId('annotation-selection-toolbar');
    expect(toolbar).not.toHaveAttribute('hidden');
    expect(toolbar).not.toHaveAttribute('aria-hidden');
    expect(toolbar).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit selected passage to agent' })).toBeVisible();
    useAnnotationStore.getState().setSelection(null, null);
  });

  test('focus mode button toggles distraction-free focus reading mode', () => {
    // ReaderView's adapter mount is covered separately; this test isolates
    // the ready toolbar toggle contract.
    seatReaderAdapter(testDocumentAdapter('pdf'));
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    fireEvent.click(screen.getByTestId('reader-focus-button'));
    expect(useUiStore.getState().focusMode).toBe(true);
  });
  test('renders error state on adapter open failure and recovers into active reader on retry', async () => {
    let openAttempts = 0;
    const fakeAdapter = {
      open: vi.fn(() => {
        openAttempts += 1;
        if (openAttempts === 1) {
          return Promise.reject(new Error('Worker initialization failed'));
        }
        return Promise.resolve();
      }),
      getTableOfContents: vi.fn(() => Promise.resolve(MOCK_TOC)),
      getCurrentPage: vi.fn(() => 1),
      getPageCount: vi.fn(() => 10),
      getReadingLocation: vi.fn(() => ({ location: { format: 'pdf' as const, pageIndex: 0 }, progress: 0 })),
      close: vi.fn(() => Promise.resolve()),
      setLocationChangeCallback: vi.fn(),
      setSelectionChangeCallback: vi.fn(),
      setAnnotationResolutionCallback: vi.fn(),
      setAnnotations: vi.fn(() => Promise.resolve([])),
      getAnnotationScope: vi.fn(() => null),
      clearSearchHighlight: vi.fn(),
    };

    useReaderStore.setState({
      session: testReaderSession(MOCK_PDF_DOC, { adapter: testDocumentAdapter('pdf', fakeAdapter), assetUrl: 'interleaf-media://mock-asset-id' }),
      error: null,
      isLoading: false,
    });

    renderWithChatStore(chat, <ReaderView />);

    // First attempt fails during initial mount
    await waitFor(() => {
      expect(screen.getByTestId('reader-error')).toBeInTheDocument();
      expect(screen.getByText('Worker initialization failed')).toBeInTheDocument();
    });

    // Clicking retry attempts mounting again, which resolves successfully
    const retryBtn = screen.getByRole('button', { name: 'Retry opening document' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('reader-error')).toBeNull();
      expect(useReaderStore.getState().error).toBeNull();
      expect(useReaderStore.getState().pageCount).toBe(10);
    });
  });

  test('mounts adapter exactly once under React StrictMode double effect invocation', async () => {
    const open = vi.fn().mockImplementation(() => Promise.resolve());
    const mockAdapter = testDocumentAdapter('pdf', {
      open,
      close: vi.fn().mockImplementation(() => Promise.resolve()),
      getTableOfContents: vi.fn().mockResolvedValue(MOCK_TOC),
      goToLocation: vi.fn().mockResolvedValue(undefined),
      getReadingLocation: vi.fn().mockReturnValue({
        location: { format: 'pdf', pageIndex: 0 },
        progress: 0,
      }),
      getProgress: vi.fn().mockReturnValue(0),
      search: vi.fn().mockResolvedValue([]),
      applySearchHighlight: vi.fn().mockResolvedValue({ status: 'not-found', text: null, rangeCount: 0 }),
      clearSearchHighlight: vi.fn(),
      extractText: vi.fn().mockImplementation(() => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.resolve({ done: true as const, value: undefined }),
          };
        },
      })),
      extractLocationText: vi.fn().mockResolvedValue([]),
      setZoom: vi.fn().mockResolvedValue(undefined),
      getZoom: vi.fn().mockReturnValue(1.0),
      getZoomMode: vi.fn().mockReturnValue('fit-width'),
      getPageCount: vi.fn().mockReturnValue(10),
      getCurrentPage: vi.fn().mockReturnValue(1),
      goToPage: vi.fn().mockResolvedValue(undefined),
      setLocationChangeCallback: vi.fn(),
      setSelectionChangeCallback: vi.fn(),
      setAnnotationResolutionCallback: vi.fn(),
      setAnnotations: vi.fn().mockResolvedValue([]),
      goToAnnotation: vi.fn().mockResolvedValue(undefined),
      getAnnotationScope: vi.fn().mockReturnValue(null),
    });

    seatReaderAdapter(mockAdapter);

    renderWithChatStore(chat,
      <React.StrictMode>
        <ReaderView />
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1);
      expect(useReaderStore.getState().error).toBeNull();
      expect(useReaderStore.getState().isLoading).toBe(false);
    });
  });

  test('aborts a pending native paint when the request is cleared', async () => {
    let resolvePaint!: (result: SearchHighlightResult) => void;
    const paint = new Promise<SearchHighlightResult>((resolve) => { resolvePaint = resolve; });
    const applySearchHighlight = vi.fn().mockReturnValue(paint);
    const clearSearchHighlight = vi.fn();
    const adapter = testDocumentAdapter('pdf', {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getTableOfContents: vi.fn().mockResolvedValue([]),
      goToLocation: vi.fn().mockResolvedValue(undefined),
      getReadingLocation: vi.fn().mockReturnValue({ location: { format: 'pdf' as const, pageIndex: 0 }, progress: 0 }),
      getProgress: vi.fn().mockReturnValue(0),
      search: vi.fn().mockResolvedValue([]),
      applySearchHighlight,
      clearSearchHighlight,
      extractText: vi.fn().mockImplementation(async function* () { await Promise.resolve(); }),
      extractLocationText: vi.fn().mockResolvedValue([]),
      setZoom: vi.fn().mockResolvedValue(undefined),
      getZoom: vi.fn().mockReturnValue(1),
      getZoomMode: vi.fn().mockReturnValue('fit-width' as const),
      getPageCount: vi.fn().mockReturnValue(10),
      getCurrentPage: vi.fn().mockReturnValue(1),
      goToPage: vi.fn().mockResolvedValue(undefined),
      setLocationChangeCallback: vi.fn(),
      setSelectionChangeCallback: vi.fn(),
      setAnnotationResolutionCallback: vi.fn(),
      setAnnotations: vi.fn().mockResolvedValue([]),
      goToAnnotation: vi.fn().mockResolvedValue(undefined),
      getAnnotationScope: vi.fn().mockReturnValue(null),
    });
    const location = { format: 'pdf' as const, pageIndex: 0, textStart: 0, textEnd: 6 };
    const anchor: SearchMatchAnchor = {
      version: 1, chunkId: 'paint', documentId: MOCK_PDF_DOC.id, documentHash: MOCK_PDF_DOC.fileHash,
      location, queryTerms: ['needle'],
      ranges: [{ start: 0, end: 6, text: 'needle', queryTermIndex: 0, queryTermIndices: [0] }],
    };
    seatReaderAdapter(adapter);
    useReaderStore.setState({
      searchHighlightRequest: { requestId: 1, documentId: MOCK_PDF_DOC.id, documentHash: MOCK_PDF_DOC.fileHash, query: 'needle', location, anchor },
      searchHighlightStatus: 'pending', searchHighlightAnnouncement: '', searchHighlightText: null,
    });
    renderWithChatStore(chat, <ReaderView />);
    await waitFor(() => { expect(applySearchHighlight).toHaveBeenCalled(); });
    useReaderStore.getState().clearSearchHighlight();
    resolvePaint({ status: 'applied', text: 'needle', rangeCount: 1 });
    await waitFor(() => { expect(useReaderStore.getState().searchHighlightStatus).toBe('idle'); });
    expect(clearSearchHighlight).toHaveBeenCalled();
    expect(useReaderStore.getState().searchHighlightRequest).toBeNull();
  });

  test('passes WCAG 2.1 AA accessibility audit', async () => {
    const { container } = renderWithChatStore(chat, <ReaderView />);
    const results = await axe.run(container, {
      rules: {
        'color-contrast': { enabled: false }, // Tested in dedicated palette suite
      },
    });
    expect(results.violations).toEqual([]);
  });
});
