// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocumentLocation, DocumentMetadata, OpenedDocument } from '@shared/types/document';
import type { DocumentAdapter, DocumentSource, ExternalLinkCallback } from '../../src/renderer/features/reader/types';
import type { SearchMatchAnchor } from '@shared/types/search';
import type { InterleafAPI } from '@shared/types/api';

const adapterFactory = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/features/reader/adapters/adapter-factory', () => ({
  createDocumentAdapter: adapterFactory,
}));

import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useSearchStore } from '../../src/renderer/stores/use-search-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { testDocumentAdapter, type CapabilityStubs } from '../helpers/document-adapter';

function makeDocument(id: string, pageIndex = 1): DocumentMetadata {
  const now = new Date().toISOString();
  return {
    id,
    title: `Document ${id}`,
    author: null,
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 1024,
    fileMtimeMs: 1,
    fileHash: id.padEnd(64, 'a').slice(0, 64),
    pageCount: 10,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: {
      location: { format: 'pdf', pageIndex },
      progress: (pageIndex + 1) / 10,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    source: null,
  };
}

function makeAdapter(capabilityStubs: CapabilityStubs<'pdf'> = {}): DocumentAdapter {
  return testDocumentAdapter(
    'pdf',
    {
      open: vi.fn<(container: HTMLElement, source: DocumentSource) => Promise<void>>(() =>
        Promise.resolve()
      ),
      close: vi.fn(() => Promise.resolve()),
      getTableOfContents: vi.fn(() => Promise.resolve([])),
      goToLocation: vi.fn(() => Promise.resolve()),
      getReadingLocation: vi.fn(() => ({
        location: { format: 'pdf' as const, pageIndex: 0 },
        progress: 0.1,
      })),
      getProgress: vi.fn(() => 0.1),
      search: vi.fn(() => Promise.resolve([])),
      applySearchHighlight: vi.fn(() =>
        Promise.resolve({ status: 'not-found' as const, text: null, rangeCount: 0 })
      ),
      clearSearchHighlight: vi.fn(),
      extractText: async function* () {
        await Promise.resolve();
        return;
      },
      extractLocationText: vi.fn(() => Promise.resolve([])),
      setZoom: vi.fn(() => Promise.resolve()),
      getZoom: vi.fn(() => 1),
      getZoomMode: vi.fn(() => 'fit-width' as const),
      getPageCount: vi.fn(() => 10),
      getCurrentPage: vi.fn(() => 1),
      goToPage: vi.fn(() => Promise.resolve()),
      setLocationChangeCallback: vi.fn(),
      setSelectionChangeCallback: vi.fn(),
      setAnnotationResolutionCallback: vi.fn(),
      setAnnotations: vi.fn(() => Promise.resolve([])),
      goToAnnotation: vi.fn(() => Promise.resolve()),
      getAnnotationScope: vi.fn(() => null),
    },
    capabilityStubs
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installLibraryApi(
  openDocument: (id: string) => Promise<OpenedDocument>,
  closeDocument = vi.fn(() => Promise.resolve()),
  updateReadingPosition = vi.fn<InterleafAPI['library']['updateReadingPosition']>(
    (_documentId, location, progress) => Promise.resolve({ location, progress, updatedAt: '2026-01-01T00:00:00.000Z' })
  )
): { readonly closeDocument: typeof closeDocument; readonly updateReadingPosition: typeof updateReadingPosition } {
  const library = {
    openDocument,
    closeDocument,
    updateReadingPosition,
  };
  stubBridge({ library });
  return { closeDocument, updateReadingPosition };
}

describe('reader store lifecycle', () => {
  beforeEach(async () => {
    adapterFactory.mockReset();
    // The previous test's document is still open; its stubs were restored, so
    // close it against fresh ones.
    installLibraryApi(() => Promise.reject(new Error('No document is opened during reset.')));
    await useReaderStore.getState().closeDocument();
    useReaderStore.setState({ error: null, isLoading: false });
  });

  test('passes an explicit initial location through to the adapter', async () => {
    const document = makeDocument('doc-explicit', 1);
    installLibraryApi(() =>
      Promise.resolve({ document, assetUrl: 'interleaf-media://explicit', mediaAssets: [] })
    );
    const adapter = makeAdapter();
    adapterFactory.mockReturnValue(adapter);
    const requested: DocumentLocation = { format: 'pdf', pageIndex: 6 };

    await useReaderStore.getState().openDocument(document.id, requested);
    const container = documentNode();
    await useReaderStore.getState().mountAdapter(container);

    expect(adapter.open).toHaveBeenCalledWith(container, {
      documentId: document.id,
      documentHash: document.fileHash,
      assetUrl: 'interleaf-media://explicit',
      mediaAssets: [],
      initialLocation: requested,
    });
  });

  test('ignores a late finish after clear and a newer identical request', () => {
    const location = { format: 'pdf' as const, pageIndex: 0, textStart: 0, textEnd: 6 };
    const anchor = (chunkId: string): SearchMatchAnchor => ({
      version: 1, chunkId, documentId: 'doc-store', documentHash: makeDocument('doc-store').fileHash,
      location, queryTerms: ['needle'],
      ranges: [{ start: 0, end: 6, text: 'needle', queryTermIndex: 0, queryTermIndices: [0] }],
    });
    useReaderStore.setState({ session: testReaderSession(makeDocument('doc-store'), { adapter: makeAdapter() }), pageCount: 10 });
    const input = { documentId: 'doc-store', documentHash: makeDocument('doc-store').fileHash, query: 'needle', location, anchor: anchor('one') };
    useReaderStore.getState().requestSearchHighlight(input);
    const first = useReaderStore.getState().searchHighlightRequest;
    expect(first?.requestId).toBeGreaterThan(0);
    useReaderStore.getState().clearSearchHighlight();
    useReaderStore.getState().finishSearchHighlight(first!, { status: 'applied', text: 'needle', rangeCount: 1 });
    expect(useReaderStore.getState().searchHighlightStatus).toBe('idle');

    useReaderStore.getState().requestSearchHighlight({ ...input, anchor: anchor('two') });
    const second = useReaderStore.getState().searchHighlightRequest;
    useReaderStore.getState().finishSearchHighlight(first!, { status: 'applied', text: 'needle', rangeCount: 1 });
    expect(useReaderStore.getState().searchHighlightRequest?.requestId).toBe(second?.requestId);
    expect(useReaderStore.getState().searchHighlightStatus).toBe('pending');
  });

  test('ignores and revokes an older open that completes after a newer request', async () => {
    const first = deferred<OpenedDocument>();
    const second = deferred<OpenedDocument>();
    const { closeDocument } = installLibraryApi((id) =>
      id === 'doc-first' ? first.promise : second.promise
    );
    adapterFactory.mockImplementation(() => makeAdapter());

    const firstOpen = useReaderStore.getState().openDocument('doc-first');
    await Promise.resolve();
    const secondOpen = useReaderStore.getState().openDocument('doc-second');
    second.resolve({
      document: makeDocument('doc-second'),
      assetUrl: 'interleaf-media://second',
      mediaAssets: [],
    });
    await secondOpen;
    first.resolve({
      document: makeDocument('doc-first'),
      assetUrl: 'interleaf-media://first',
      mediaAssets: [],
    });
    await firstOpen;

    expect(useReaderStore.getState().session?.document.id).toBe('doc-second');
    expect(useReaderStore.getState().session?.assetUrl).toBe('interleaf-media://second');
    expect(closeDocument).toHaveBeenCalledWith('doc-first');
  });

  // Regression: opening a second document used to clear the first one's
  // document and adapter but leave its asset URL behind, so the store paired
  // the new open with the previous document's capability until it settled.
  test('drops the previous document’s asset URL as soon as another open starts', async () => {
    const next = deferred<OpenedDocument>();
    installLibraryApi((id) =>
      id === 'doc-previous'
        ? Promise.resolve({ document: makeDocument('doc-previous'), assetUrl: 'interleaf-media://previous', mediaAssets: [] })
        : next.promise
    );
    adapterFactory.mockImplementation(() => makeAdapter());
    await useReaderStore.getState().openDocument('doc-previous');
    expect(useReaderStore.getState().session?.assetUrl).toBe('interleaf-media://previous');

    const opening = useReaderStore.getState().openDocument('doc-next');
    await vi.waitFor(() => { expect(useReaderStore.getState().isLoading).toBe(true); });
    expect(useReaderStore.getState().session).toBeNull();

    next.resolve({ document: makeDocument('doc-next'), assetUrl: 'interleaf-media://next', mediaAssets: [] });
    await opening;
    expect(useReaderStore.getState().session?.assetUrl).toBe('interleaf-media://next');
  });

  test('flushes a pending position immediately for shutdown lifecycle events', async () => {
    const activeDocument = makeDocument('doc-flush');
    const { updateReadingPosition } = installLibraryApi(() =>
      Promise.resolve({
        document: activeDocument,
        assetUrl: 'interleaf-media://flush',
        mediaAssets: [],
      })
    );
    adapterFactory.mockImplementation(() => makeAdapter());
    await useReaderStore.getState().openDocument(activeDocument.id);
    const location: DocumentLocation = { format: 'pdf', pageIndex: 4 };

    useReaderStore.getState().onLocationUpdate(location, 0.5);
    await useReaderStore.getState().flushPendingReadingPosition();

    expect(updateReadingPosition).toHaveBeenCalledWith(activeDocument.id, location, 0.5);
  });

  test('invalidates transient search state before closing the active document', async () => {
    const activeDocument = makeDocument('doc-search-close');
    const adapter = makeAdapter();
    installLibraryApi(() => Promise.resolve({ document: activeDocument, assetUrl: 'interleaf-media://close', mediaAssets: [] }));
    useReaderStore.setState({ session: testReaderSession(activeDocument, { adapter }), pageCount: 10 });
    const before = useSearchStore.getState().transientResetRevision;

    await useReaderStore.getState().closeDocument();

    expect(useSearchStore.getState().transientResetRevision).toBe(before + 1);
    expect(useReaderStore.getState().session).toBeNull();
    expect(adapter.clearSearchHighlight).toHaveBeenCalled();
  });

  test('coalesces concurrent same-container StrictMode mounts to a single adapter.open call', async () => {
    const activeDocument = makeDocument('doc-coalesce');
    installLibraryApi(() => Promise.resolve({
      document: activeDocument,
      assetUrl: 'interleaf-media://coalesce',
      mediaAssets: [],
    }));
    const openDeferred = deferred<undefined>();
    const adapter = makeAdapter();
    vi.mocked(adapter.open).mockImplementation(() => openDeferred.promise);
    adapterFactory.mockReturnValue(adapter);
    await useReaderStore.getState().openDocument(activeDocument.id);

    const container = documentNode();
    const firstMount = useReaderStore.getState().mountAdapter(container);
    const secondMount = useReaderStore.getState().mountAdapter(container);

    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(useReaderStore.getState().isLoading).toBe(true);

    openDeferred.resolve(undefined);
    await Promise.all([firstMount, secondMount]);

    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(useReaderStore.getState().session?.adapter).toBe(adapter);
    expect(useReaderStore.getState().error).toBeNull();
    expect(useReaderStore.getState().isLoading).toBe(false);
    expect(useReaderStore.getState().currentPage).toBe(1);
    expect(useReaderStore.getState().pageCount).toBe(10);

    // Subsequent call on already mounted container returns immediately without calling open again
    await useReaderStore.getState().mountAdapter(container);
    expect(adapter.open).toHaveBeenCalledTimes(1);
  });

  test('allows a fresh retry when a coalesced mount fails', async () => {
    const activeDocument = makeDocument('doc-retry-mount');
    installLibraryApi(() => Promise.resolve({
      document: activeDocument,
      assetUrl: 'interleaf-media://retry-mount',
      mediaAssets: [],
    }));
    const adapter = makeAdapter();
    vi.mocked(adapter.open)
      .mockImplementationOnce(() => Promise.reject(new Error('Canvas creation failed')))
      .mockImplementationOnce(() => Promise.resolve());
    adapterFactory.mockReturnValue(adapter);
    await useReaderStore.getState().openDocument(activeDocument.id);

    const container = documentNode();
    const firstMount = useReaderStore.getState().mountAdapter(container);
    const secondMount = useReaderStore.getState().mountAdapter(container);
    await Promise.all([firstMount, secondMount]);

    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(useReaderStore.getState().error).toBe('Canvas creation failed');
    expect(useReaderStore.getState().isLoading).toBe(false);

    // Retry mount on the container initiates a fresh mount attempt
    await useReaderStore.getState().mountAdapter(container);
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(useReaderStore.getState().error).toBeNull();
    expect(useReaderStore.getState().isLoading).toBe(false);
    expect(useReaderStore.getState().pageCount).toBe(10);
  });

  /**
   * A link in an open document.
   *
   * The store is what connects an adapter's report to the one main-owned way
   * out of the application. It hands over a callback at mount so the adapter
   * never holds the bridge itself, and the target is validated before the
   * bridge is asked at all.
   */
  test('wires the mounted adapter to the main-owned external link capability', async () => {
    const activeDocument = makeDocument('doc-external');
    installLibraryApi(() =>
      Promise.resolve({
        document: activeDocument,
        assetUrl: 'interleaf-media://external',
        mediaAssets: [],
      })
    );
    const openExternal = vi.fn(() => Promise.resolve({ opened: true }));
    stubBridge({ app: { openExternal } });
    const setExternalLinkCallback = vi.fn<(callback: ExternalLinkCallback | null) => void>();
    const adapter = makeAdapter({ setExternalLinkCallback });
    adapterFactory.mockReturnValue(adapter);

    await useReaderStore.getState().openDocument(activeDocument.id);
    await useReaderStore.getState().mountAdapter(documentNode());

    const firstCall = setExternalLinkCallback.mock.calls[0];
    expect(firstCall).toBeDefined();
    const report = firstCall![0]!;
    expect(report).toBeTypeOf('function');

    await report('https://example.org/paper');
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.org/paper');

    // Anything that is not a plain external link never reaches the bridge.
    await report('javascript:alert(1)');
    await report('#page-3');
    expect(openExternal).toHaveBeenCalledOnce();

    // A refusal in main is not something the reader can act on mid-document.
    openExternal.mockRejectedValueOnce(new Error('refused'));
    await expect(report('https://example.org/other')).resolves.toBeUndefined();
  });

  test('a stale different-container mount cannot close or fail the newer mount', async () => {
    const activeDocument = makeDocument('doc-strict');
    installLibraryApi(() => Promise.resolve({
      document: activeDocument,
      assetUrl: 'interleaf-media://strict',
      mediaAssets: [],
    }));
    const firstOpen = deferred<undefined>();
    const adapter = makeAdapter();
    vi.mocked(adapter.open)
      .mockImplementationOnce(() => firstOpen.promise)
      .mockImplementationOnce(() => Promise.resolve());
    adapterFactory.mockReturnValue(adapter);
    await useReaderStore.getState().openDocument(activeDocument.id);

    const firstMount = useReaderStore.getState().mountAdapter(documentNode());
    const secondMount = useReaderStore.getState().mountAdapter(documentNode());
    await secondMount;
    firstOpen.reject(new DOMException('superseded', 'AbortError'));
    await firstMount;

    expect(adapter.close).not.toHaveBeenCalled();
    expect(useReaderStore.getState().session?.adapter).toBe(adapter);
    expect(useReaderStore.getState().error).toBeNull();
    expect(useReaderStore.getState().isLoading).toBe(false);
  });
});
function documentNode(): HTMLElement {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
}
