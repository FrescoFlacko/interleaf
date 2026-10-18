import { create } from 'zustand';
import { reportRejection } from '@shared/models/caught-error';
import type {
  DocumentLocation,
  DocumentMediaAsset,
  DocumentMetadata,
  TableOfContentsItem,
  ZoomMode,
} from '@shared/types/document';
import type {
  DocumentAdapter,
  PendingSearchHighlight,
  ReflowOptions,
  SearchHighlightInput,
  SearchHighlightResult,
} from '../features/reader/types';
import { createDocumentAdapter } from '../features/reader/adapters/adapter-factory';
import { useLibraryStore } from './use-library-store';
import { openExternalLink } from '../features/reader/open-external-link';
import { useSearchStore } from './use-search-store';
import { bridge } from '../app/api-client';

let readingPositionDebounceTimer: number | null = null;
let readerOpenSequence = 0;
let readerMountSequence = 0;
let searchHighlightRequestSequence = 0;
let latestRequestedDocumentId: string | null = null;
let pendingPositionUpdate: {
  documentId: string;
  location: DocumentLocation;
  progress: number;
} | null = null;

type ActiveMountContext = {
  readonly adapter: DocumentAdapter;
  readonly container: HTMLElement;
  readonly mountPromise: Promise<void>;
  status: 'in-flight' | 'mounted' | 'failed';
};

let activeMountContext: ActiveMountContext | null = null;
async function flushReadingPosition(): Promise<void> {
  if (readingPositionDebounceTimer !== null) {
    window.clearTimeout(readingPositionDebounceTimer);
    readingPositionDebounceTimer = null;
  }
  if (pendingPositionUpdate) {
    const state = useReaderStore.getState();
    const { documentId, location: pendingLocation, progress } = pendingPositionUpdate;
    // A smooth programmatic navigation can briefly emit an older scroll
    // location while the animation settles. An explicit navigation is the
    // user's authoritative choice until pointer/wheel interaction clears it.
    const location =
      state.session?.document.id === documentId && state.explicitNavigationLocation !== null
        ? state.explicitNavigationLocation
        : pendingLocation;
    pendingPositionUpdate = null;
    await reportRejection(
      bridge.library.updateReadingPosition(documentId, location, progress),
      (caught) => { console.warn('Failed to persist the reading position.', caught); },
    );
  }
}

/**
 * One opened document and everything the reader needs to mount it. Main
 * authorizes the asset and its media together, the adapter is created for that
 * document's format, and all of it is replaced or cleared as one value.
 */
export type ReaderSession = {
  readonly document: DocumentMetadata;
  readonly adapter: DocumentAdapter;
  readonly assetUrl: string;
  readonly mediaAssets: readonly DocumentMediaAsset[];
  /** Where the adapter opens: the requested location, else the saved reading position. */
  readonly initialLocation: DocumentLocation | null;
};

export type ReaderState = {
  /** The open document; `null` while none is open or one is still being authorized. */
  session: ReaderSession | null;
  currentLocation: DocumentLocation | null;
  explicitNavigationLocation: DocumentLocation | null;
  currentPage: number;
  pageCount: number;
  zoom: number;
  zoomMode: ZoomMode;
  reflowLineHeight: number;
  reflowHorizontalMarginRem: number;
  reflowFontSize: number;
  reflowFontFamily: 'system' | 'serif' | 'sans' | 'dyslexic';
  reflowContentWidth: number;
  reflowParagraphSpacing: number;
  tableOfContents: readonly TableOfContentsItem[];
  isTocOpen: boolean;
  isLoading: boolean;
  error: string | null;
  failedDocumentId: string | null;
  failedInitialLocation: DocumentLocation | null;
  searchHighlightRequest: PendingSearchHighlight | null;
  searchHighlightStatus: SearchHighlightResult['status'] | 'idle' | 'pending';
  searchHighlightText: string | null;
  searchHighlightAnnouncement: string;

  // Actions
  openDocument: (documentId: string, initialLocation?: DocumentLocation | null) => Promise<void>;
  retryOpenDocument: () => Promise<void>;
  clearReaderError: () => void;
  requestSearchHighlight: (request: SearchHighlightInput) => void;
  finishSearchHighlight: (request: PendingSearchHighlight, result: SearchHighlightResult) => void;
  clearSearchHighlight: () => void;
  mountAdapter: (containerElement: HTMLElement) => Promise<void>;
  closeDocument: () => Promise<void>;
  goToPage: (pageNumber: number) => Promise<void>;
  goToLocation: (location: DocumentLocation) => Promise<void>;
  setZoom: (zoom: number | 'fit-width' | 'fit-page') => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  setReflowLineHeight: (lineHeight: number) => Promise<void>;
  setReflowHorizontalMargin: (marginRem: number) => Promise<void>;
  setReaderAppearance: (options: Partial<Pick<ReaderState, 'reflowFontSize' | 'reflowFontFamily' | 'reflowContentWidth' | 'reflowParagraphSpacing' | 'reflowLineHeight' | 'reflowHorizontalMarginRem'>>) => Promise<void>;
  hydrateReaderAppearance: (options: {
    readonly fontSize: number;
    readonly fontFamily: 'system' | 'serif' | 'sans' | 'dyslexic';
    readonly contentWidth: number;
    readonly paragraphSpacing: number;
    readonly lineSpacing: number;
    readonly pageMargin: number;
  }) => void;
  toggleToc: () => void;
  setTocOpen: (open: boolean) => void;
  clearExplicitNavigationLocation: () => void;
  onLocationUpdate: (location: DocumentLocation, progress: number) => void;
  flushPendingReadingPosition: () => Promise<void>;
};

export function selectActiveDocument(state: Pick<ReaderState, 'session'>): DocumentMetadata | null {
  return state.session?.document ?? null;
}

export function selectAdapter(state: Pick<ReaderState, 'session'>): DocumentAdapter | null {
  return state.session?.adapter ?? null;
}

/**
 * Focus Reading Mode is available only once the reader has successfully
 * mounted its adapter and established a usable page/section count. An open
 * session alone is not sufficient: it is also present during adapter loading
 * and after a render failure.
 */
export function isReaderReady(
  state: Pick<ReaderState, 'session' | 'isLoading' | 'error' | 'pageCount'>,
): boolean {
  return (
    state.session !== null &&
    !state.isLoading &&
    state.error === null &&
    state.pageCount > 0
  );
}

function searchLocationLabel(location: DocumentLocation): string {
  switch (location.format) {
    case 'pdf': return `Page ${String(location.pageIndex + 1)}`;
    case 'pptx': return `Slide ${String((location.renderedPageIndex ?? 0) + 1)}`;
    case 'docx': return `Paragraph ${String(location.paragraphIndex + 1)}`;
    case 'markdown': return `Block ${String(location.blockIndex + 1)}`;
    case 'mobi': return `Section ${String(location.sectionIndex + 1)}`;
    case 'epub': return location.spineHref ?? 'Passage';
  }
}

const SEARCH_HIGHLIGHT_FAILURE_ANNOUNCEMENTS: Readonly<Record<Exclude<SearchHighlightResult['status'], 'applied'>, string>> = {
  stale: 'The selected search result is stale. Search again.',
  unsupported: 'This reader cannot paint the selected search match.',
  'not-found': 'The selected search match is no longer visible.',
};

function searchHighlightAnnouncement(request: PendingSearchHighlight, result: SearchHighlightResult): string {
  if (result.status === 'applied') {
    return `Matched “${result.text ?? request.query}” at ${searchLocationLabel(request.location)}.`;
  }
  return SEARCH_HIGHLIGHT_FAILURE_ANNOUNCEMENTS[result.status];
}

type ReflowSettings = Pick<
  ReaderState,
  | 'reflowLineHeight'
  | 'reflowHorizontalMarginRem'
  | 'reflowFontSize'
  | 'reflowFontFamily'
  | 'reflowContentWidth'
  | 'reflowParagraphSpacing'
>;

function currentReflowOptions(state: ReflowSettings): ReflowOptions {
  return {
    lineHeight: state.reflowLineHeight,
    horizontalMarginRem: state.reflowHorizontalMarginRem,
    fontSize: state.reflowFontSize,
    fontFamily: state.reflowFontFamily,
    contentWidth: state.reflowContentWidth,
    paragraphSpacing: state.reflowParagraphSpacing,
  };
}

/** Re-typesets the open document when its format reflows; fixed-layout formats ignore typography. */
async function applyReflowOptions(state: ReflowSettings & Pick<ReaderState, 'session'>): Promise<void> {
  await state.session?.adapter.capabilities.reflow?.setReflowOptions(currentReflowOptions(state));
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  session: null,
  currentLocation: null,
  explicitNavigationLocation: null,
  currentPage: 1,
  pageCount: 0,
  zoom: 1.0,
  zoomMode: 'fit-width',
  reflowLineHeight: 1.65,
  reflowHorizontalMarginRem: 2.5,
  reflowFontSize: 1,
  reflowFontFamily: 'system',
  reflowContentWidth: 72,
  reflowParagraphSpacing: 0.8,
  tableOfContents: [],
  isTocOpen: false,
  isLoading: false,
  error: null,
  failedDocumentId: null,
  failedInitialLocation: null,
  searchHighlightRequest: null,
  searchHighlightStatus: 'idle',
  searchHighlightText: null,
  searchHighlightAnnouncement: '',

  openDocument: async (documentId: string, initialLocation = null) => {
    readerOpenSequence += 1;
    readerMountSequence += 1;
    activeMountContext = null;
    get().clearSearchHighlight();
    const sequence = readerOpenSequence;
    latestRequestedDocumentId = documentId;
    await flushReadingPosition();
    // Close prior adapter if active
    const previousSession = get().session;
    if (previousSession) {
      await reportRejection(previousSession.adapter.close(), (caught) => {
        console.warn('Failed to close the previous reader adapter.', caught);
      });
    }
    if (sequence !== readerOpenSequence) {
      return;
    }

    set({
      isLoading: true,
      error: null,
      failedDocumentId: null,
      failedInitialLocation: null,
      session: null,
      explicitNavigationLocation: null,
      tableOfContents: [],
      currentPage: 1,
      pageCount: 0,
      searchHighlightRequest: null,
      searchHighlightStatus: 'idle',
      searchHighlightText: null,
      searchHighlightAnnouncement: '',
    });
    try {
      const opened = await bridge.library.openDocument(documentId);
      if (sequence !== readerOpenSequence) {
        if (opened.document.id !== latestRequestedDocumentId) {
          await reportRejection(bridge.library.closeDocument(opened.document.id), (caught) => {
            console.warn('Failed to revoke a stale document capability.', caught);
          });
        }
        return;
      }
      const adapter = createDocumentAdapter(opened.document.format);

      const resolvedInitialLocation =
        initialLocation ?? opened.document.readingPosition?.location ?? null;

      const initialPage =
        resolvedInitialLocation?.format === 'pdf'
          ? resolvedInitialLocation.pageIndex + 1
          : resolvedInitialLocation?.format === 'mobi'
          ? resolvedInitialLocation.sectionIndex + 1
          : 1;
      set({
        session: {
          document: opened.document,
          adapter,
          assetUrl: opened.assetUrl,
          mediaAssets: opened.mediaAssets,
          initialLocation: resolvedInitialLocation,
        },
        currentLocation: resolvedInitialLocation,
        // The persisted start location is not a new user navigation. Keep
        // explicitNavigationLocation reserved for a deliberate jump so a
        // later scroll/location update can become the persisted position.
        explicitNavigationLocation: null,
        currentPage: initialPage,
        isLoading: false,
      });
    } catch (err) {
      if (sequence !== readerOpenSequence) return;
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to open document.',
        failedDocumentId: documentId,
        failedInitialLocation: initialLocation,
      });
    }
  },

  retryOpenDocument: async () => {
    activeMountContext = null;
    const { failedDocumentId, failedInitialLocation } = get();
    if (failedDocumentId) {
      await get().openDocument(failedDocumentId, failedInitialLocation);
    }
  },

  clearReaderError: () => {
    set({ error: null, failedDocumentId: null, failedInitialLocation: null });
  },

  requestSearchHighlight: (request) => {
    const session = get().session;
    session?.adapter.clearSearchHighlight();
    if (!session) {
      set({
        searchHighlightRequest: { ...request, requestId: ++searchHighlightRequestSequence },
        searchHighlightStatus: 'stale',
        searchHighlightText: null,
        searchHighlightAnnouncement: 'The selected search result is stale. Search again.',
      });
      return;
    }
    if (session.document.id !== request.documentId || session.document.fileHash !== request.documentHash) {
      set({
        searchHighlightRequest: { ...request, requestId: ++searchHighlightRequestSequence },
        searchHighlightStatus: 'stale',
        searchHighlightText: null,
        searchHighlightAnnouncement: 'The selected search result is stale. Search again.',
      });
      return;
    }
    set({
      searchHighlightRequest: { ...request, requestId: ++searchHighlightRequestSequence },
      searchHighlightStatus: 'pending',
      searchHighlightText: null,
      searchHighlightAnnouncement: '',
    });
  },

  finishSearchHighlight: (request, result) => {
    const current = get().searchHighlightRequest;
    const activeDocument = selectActiveDocument(get());
    if (current === null || activeDocument === null) return;
    if (
      current.documentId !== request.documentId ||
      current.documentHash !== request.documentHash ||
      current.query !== request.query ||
      current.requestId !== request.requestId ||
      current.anchor.chunkId !== request.anchor.chunkId ||
      activeDocument.id !== request.documentId ||
      activeDocument.fileHash !== request.documentHash
    ) return;
    const announcement = searchHighlightAnnouncement(request, result);
    set({
      searchHighlightStatus: result.status,
      searchHighlightText: result.text,
      searchHighlightAnnouncement: announcement,
    });
  },

  clearSearchHighlight: () => {
    get().session?.adapter.clearSearchHighlight();
    searchHighlightRequestSequence += 1;
    set({
      searchHighlightRequest: null,
      searchHighlightStatus: 'idle',
      searchHighlightText: null,
      searchHighlightAnnouncement: '',
    });
  },

  mountAdapter: async (containerElement: HTMLElement) => {
    const session = get().session;
    if (!session) return;
    const { adapter } = session;

    // If an identical adapter + container mount is already in-flight or successfully mounted,
    // coalesce duplicate calls (e.g. from React StrictMode double-invoked effects).
    if (activeMountContext?.adapter === adapter && activeMountContext.container === containerElement) {
      if (activeMountContext.status === 'mounted') {
        return;
      }
      if (activeMountContext.status === 'in-flight') {
        await activeMountContext.mountPromise;
        return;
      }
      // If status was 'failed', allow a fresh retry below
    }

    const sequence = readerOpenSequence;
    const mountSequence = ++readerMountSequence;
    set({ isLoading: true, error: null });

    const mountTask = async (): Promise<void> => {
      try {
        adapter.setLocationChangeCallback((location, progress) => {
          get().onLocationUpdate(location, progress);
        });

        // Links found in the document leave the application through main and
        // nowhere else. The adapter reports a target; it never navigates, and
        // an adapter that is closed again below stops reporting.
        adapter.capabilities.externalLinks?.setExternalLinkCallback(async (url: string) => {
          await openExternalLink(url);
        });

        await adapter.open(containerElement, {
          documentId: session.document.id,
          documentHash: session.document.fileHash,
          assetUrl: session.assetUrl,
          mediaAssets: session.mediaAssets,
          initialLocation: session.initialLocation,
        });

        await adapter.capabilities.reflow?.setReflowOptions(currentReflowOptions(get()));

        if (
          mountSequence !== readerMountSequence ||
          sequence !== readerOpenSequence ||
          selectAdapter(get()) !== adapter
        ) {
          return;
        }

        const toc = await adapter.getTableOfContents();
        set({
          tableOfContents: toc,
          currentPage: adapter.getCurrentPage(),
          pageCount: adapter.getPageCount(),
          isLoading: false,
          error: null,
        });

        if (
          activeMountContext?.adapter === adapter &&
          activeMountContext.container === containerElement
        ) {
          activeMountContext.status = 'mounted';
        }
      } catch (err) {
        if (
          activeMountContext?.adapter === adapter &&
          activeMountContext.container === containerElement
        ) {
          activeMountContext.status = 'failed';
        }
        if (
          mountSequence !== readerMountSequence ||
          sequence !== readerOpenSequence ||
          selectAdapter(get()) !== adapter
        ) {
          return;
        }
        await reportRejection(adapter.close(), (caught) => {
          console.warn('Failed to clean up the reader after a render error.', caught);
        });
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to render document.',
        });
      }
    };

    const mountPromise = mountTask();
    activeMountContext = {
      adapter,
      container: containerElement,
      mountPromise,
      status: 'in-flight',
    };

    try {
      await mountPromise;
    } catch {
      // Handled in mountTask; callers awaiting mountAdapter settle without unhandled rejection
    }
  },

  closeDocument: async () => {
    readerOpenSequence += 1;
    readerMountSequence += 1;
    activeMountContext = null;
    latestRequestedDocumentId = null;
    // Invalidate document-bound search UI before awaiting adapter/IPC cleanup;
    // late search responses must not repopulate a closing document's panel.
    useSearchStore.getState().resetTransientSearch();
    get().clearSearchHighlight();
    const { session } = get();

    if (session) {
      await reportRejection(session.adapter.close(), (caught) => {
        console.warn('Failed to close the reader adapter.', caught);
      });
      await reportRejection(bridge.library.closeDocument(session.document.id), (caught) => {
        console.warn('Failed to revoke the document capability.', caught);
      });
    }

    set({
      session: null,
      currentLocation: null,
      explicitNavigationLocation: null,
      currentPage: 1,
      pageCount: 0,
      tableOfContents: [],
      isTocOpen: false,
      isLoading: false,
      error: null,
    });

    // Refresh library data upon return
    void useLibraryStore.getState().loadLibrary();
  },

  goToPage: async (pageNumber: number) => {
    const { session, pageCount } = get();
    if (!session) return;
    const { adapter, document: activeDocument } = session;
    const clamped = Math.max(1, Math.min(pageCount > 0 ? pageCount : 1, pageNumber));
    const fallbackLocation: DocumentLocation | null =
      activeDocument.format === 'pdf'
        ? { format: 'pdf', pageIndex: clamped - 1 }
        : null;
    set({
      currentPage: clamped,
      explicitNavigationLocation: fallbackLocation,
      ...(fallbackLocation ? { currentLocation: fallbackLocation } : {}),
    });
    await adapter.goToPage(clamped);
    const reading = adapter.getReadingLocation();
    const updatedLocation = reading.location;
    const updatedProgress = reading.progress;
    const latest = get();
    if (latest.session?.adapter === adapter && latest.session.document.id === activeDocument.id) {
      // Adapters normally report this through their callback. Record it again
      // at the store boundary so a synchronous navigation cannot be lost when
      // a renderer close races the callback installation or debounce timer.
      latest.onLocationUpdate(updatedLocation, updatedProgress);
    }
  },

  goToLocation: async (location: DocumentLocation) => {
    const adapter = selectAdapter(get());
    if (!adapter) return;
    if (location.format === 'pdf') {
      set({ currentPage: location.pageIndex + 1 });
    } else if (location.format === 'mobi') {
      set({ currentPage: location.sectionIndex + 1 });
    }
    await adapter.goToLocation(location);
    set({
      currentPage: adapter.getCurrentPage(),
      pageCount: adapter.getPageCount(),
      explicitNavigationLocation: location,
      currentLocation: location,
    });
  },

  setZoom: async (zoom: number | 'fit-width' | 'fit-page') => {
    const adapter = selectAdapter(get());
    if (!adapter) return;
    await adapter.setZoom(zoom);
    set({
      zoom: adapter.getZoom(),
      zoomMode: adapter.getZoomMode(),
    });
  },

  zoomIn: async () => {
    const { zoom, setZoom } = get();
    const nextZoom = Math.min(4.0, Number((zoom + 0.25).toFixed(2)));
    await setZoom(nextZoom);
  },

  zoomOut: async () => {
    const { zoom, setZoom } = get();
    const prevZoom = Math.max(0.25, Number((zoom - 0.25).toFixed(2)));
    await setZoom(prevZoom);
  },

  setReflowLineHeight: async (lineHeight: number) => {
    const clamped = Math.max(1.2, Math.min(2.2, lineHeight));
    set({ reflowLineHeight: clamped });
    await applyReflowOptions(get());
  },

  setReflowHorizontalMargin: async (marginRem: number) => {
    const clamped = Math.max(0.75, Math.min(5, marginRem));
    set({ reflowHorizontalMarginRem: clamped });
    await applyReflowOptions(get());
  },

  setReaderAppearance: async (options) => {
    const current = get();
    const next = {
      reflowFontSize: Math.max(0.75, Math.min(2, options.reflowFontSize ?? current.reflowFontSize)),
      reflowFontFamily: options.reflowFontFamily ?? current.reflowFontFamily,
      reflowContentWidth: Math.max(40, Math.min(100, options.reflowContentWidth ?? current.reflowContentWidth)),
      reflowParagraphSpacing: Math.max(0, Math.min(3, options.reflowParagraphSpacing ?? current.reflowParagraphSpacing)),
      reflowLineHeight: Math.max(1.2, Math.min(2.2, options.reflowLineHeight ?? current.reflowLineHeight)),
      reflowHorizontalMarginRem: Math.max(0.75, Math.min(5, options.reflowHorizontalMarginRem ?? current.reflowHorizontalMarginRem)),
    };
    set(next);
    await applyReflowOptions(get());
  },

  hydrateReaderAppearance: (options) => {
    set({
      reflowFontSize: Math.max(0.75, Math.min(2, options.fontSize)),
      reflowFontFamily: options.fontFamily,
      reflowContentWidth: Math.max(40, Math.min(100, options.contentWidth)),
      reflowParagraphSpacing: Math.max(0, Math.min(3, options.paragraphSpacing)),
      reflowLineHeight: Math.max(1.2, Math.min(2.2, options.lineSpacing)),
      reflowHorizontalMarginRem: Math.max(0.75, Math.min(5, options.pageMargin)),
    });
  },

  toggleToc: () => {
    set((s) => ({ isTocOpen: !s.isTocOpen }));
  },

  setTocOpen: (open: boolean) => {
    set({ isTocOpen: open });
  },

  clearExplicitNavigationLocation: () => {
    set({ explicitNavigationLocation: null });
  },

  onLocationUpdate: (location: DocumentLocation, progress: number) => {
    const { session } = get();
    if (!session) return;
    if (location.format === 'pdf') {
      set({ currentPage: location.pageIndex + 1, currentLocation: location });
    } else if (location.format === 'mobi') {
      set({ currentPage: location.sectionIndex + 1, currentLocation: location });
    } else {
      set({
        currentPage: session.adapter.getCurrentPage(),
        pageCount: session.adapter.getPageCount(),
        currentLocation: location,
      });
    }
    pendingPositionUpdate = {
      documentId: session.document.id,
      location,
      progress,
    };

    if (readingPositionDebounceTimer !== null) {
      window.clearTimeout(readingPositionDebounceTimer);
    }
    readingPositionDebounceTimer = window.setTimeout(() => {
      readingPositionDebounceTimer = null;
      void flushReadingPosition();
    }, 600);
  },

  flushPendingReadingPosition: () => {
    return flushReadingPosition();
  },
}));
