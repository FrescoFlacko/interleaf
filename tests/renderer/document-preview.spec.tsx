// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentCard } from '../../src/renderer/features/library/components/DocumentCard';
import {
  PreviewLRUCache,
  PreviewScheduler,
  resetPreviewCacheForTesting,
} from '../../src/renderer/features/library/components/DocumentPreview';
import type { DocumentMetadata, DocumentPreviewData } from '@shared/types/document';
import { testIntersectionObserverEntry } from '../helpers/intersection-observer';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
const MOCK_DOC_1: DocumentMetadata = {
  id: 'doc-test-1',
  title: 'Distributed Systems',
  author: 'Leslie Lamport',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024 * 1024,
  fileMtimeMs: 1000,
  fileHash: 'hash-v1',
  pageCount: 100,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: {
    location: { format: 'pdf', pageIndex: 2, pageLabel: 'Page 3' },
    progress: 0.03,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: null,
};

describe('PreviewLRUCache', () => {
  it('enforces maximum capacity and evicts least recently used items', () => {
    const cache = new PreviewLRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);

    // Access 'a' to promote to MRU
    expect(cache.get('a')).toBe(1);

    // Add 'd' -> should evict 'b' (oldest unaccessed)
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('updates existing keys without growing beyond capacity', () => {
    const cache = new PreviewLRUCache<string, string>(2);
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    expect(cache.get('k1')).toBe('v1');
    cache.set('k1', 'v1-updated');

    expect(cache.size).toBe(2);
    expect(cache.get('k1')).toBe('v1-updated');

    // Clearing works without an eviction listener.
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('notifies on eviction and explicit clearing', () => {
    const evicted: string[] = [];
    const cache = new PreviewLRUCache<string, number>(1, (key) => {
      evicted.push(key);
    });
    cache.set('first', 1);
    cache.set('second', 2);
    cache.delete('second');
    cache.set('third', 3);
    cache.clear();

    expect(evicted).toEqual(['first', 'second', 'third']);
    expect(cache.size).toBe(0);
    expect(cache.has('third')).toBe(false);
  });
});

describe('PreviewScheduler', () => {
  beforeEach(() => {
    resetPreviewCacheForTesting();
  });

  it('limits concurrent running fetches to maxConcurrency (3)', async () => {
    const scheduler = new PreviewScheduler(3);
    let running = 0;
    let maxRunningObserved = 0;
    const resolvers: (() => void)[] = [];

    const makeTask = (id: string) => () =>
      new Promise<DocumentPreviewData>((resolve) => {
        running++;
        maxRunningObserved = Math.max(maxRunningObserved, running);
        resolvers.push(() => {
          running--;
          resolve({
            documentId: id,
            format: 'pdf',
            locationLabel: 'Page 1',
            isLastRead: false,
            snippet: `Snippet ${id}`,
            fallback: false,
            coverAssetUrl: null,
          });
        });
      });

    // Schedule 6 tasks
    const p1 = scheduler.schedule('k1', makeTask('1'));
    const p2 = scheduler.schedule('k2', makeTask('2'));
    const p3 = scheduler.schedule('k3', makeTask('3'));
    const p4 = scheduler.schedule('k4', makeTask('4'));
    const p5 = scheduler.schedule('k5', makeTask('5'));
    const p6 = scheduler.schedule('k6', makeTask('6'));

    // Wait a tick for scheduler
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(3);
    expect(scheduler.queueLength).toBe(3);
    expect(maxRunningObserved).toBe(3);

    // Resolve first 3
    resolvers.forEach((r) => {
      r();
    });
    await Promise.all([p1, p2, p3]);

    await Promise.resolve();
    expect(scheduler.activeCount).toBe(3);
    expect(scheduler.queueLength).toBe(0);

    // Resolve remaining 3
    resolvers.slice(3).forEach((r) => {
      r();
    });
    const results = await Promise.all([p4, p5, p6]);
    expect(results).toHaveLength(3);
    expect(scheduler.activeCount).toBe(0);
    expect(maxRunningObserved).toBe(3);
  });

  it('deduplicates simultaneous in-flight requests for the exact same cacheKey', async () => {
    const scheduler = new PreviewScheduler(3);
    let fetchCount = 0;

    const fetcher = () => {
      fetchCount++;
      return new Promise<DocumentPreviewData>((resolve) => {
        setTimeout(() => {
          resolve({
            documentId: 'doc-1',
            format: 'pdf',
            locationLabel: 'Page 1',
            isLastRead: false,
            snippet: 'Shared Result',
            fallback: false,
            coverAssetUrl: null,
          });
        }, 10);
      });
    };

    const p1 = scheduler.schedule('doc-1:hash1:null', fetcher);
    const p2 = scheduler.schedule('doc-1:hash1:null', fetcher);
    const p3 = scheduler.schedule('doc-1:hash1:null', fetcher);

    expect(scheduler.inFlightCount).toBe(1);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(fetchCount).toBe(1);
    expect(r1.snippet).toBe('Shared Result');
    expect(r2.snippet).toBe('Shared Result');
    expect(r3.snippet).toBe('Shared Result');
    expect(scheduler.inFlightCount).toBe(0);
  });
});

describe('useDocumentPreview through DocumentCard & IntersectionObserver', () => {
  let mockIntersectionCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null;
  let getDocumentPreviewMock: Mock<InterleafAPI['library']['getDocumentPreview']>;

  beforeEach(() => {
    cleanup();
    resetPreviewCacheForTesting();

    getDocumentPreviewMock = vi.fn<InterleafAPI['library']['getDocumentPreview']>((docId) =>
      Promise.resolve({
        documentId: docId,
        format: 'pdf',
        locationLabel: 'Page 3',
        isLastRead: true,
        snippet: 'Real Preview Snippet From Worker',
        coverAssetUrl: null,
        fallback: false,
      })
    );

    stubBridge({
      library: {
        getDocumentPreview: getDocumentPreviewMock,
      },
    });

    // Mock IntersectionObserver
    mockIntersectionCallback = null;
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '0px';
      readonly scrollMargin = '0px 0px 0px 0px';
      readonly thresholds: readonly number[] = [0];
      constructor(cb: IntersectionObserverCallback) {
        // The test drives the callback directly and never inspects the observer
        // argument, so the capture hands this instance back for it.
        mockIntersectionCallback = (entries) => { cb(entries, this); };
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    window.IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    resetPreviewCacheForTesting();
  });

  function intersect(): void {
    mockIntersectionCallback?.([
      testIntersectionObserverEntry({ isIntersecting: true, target: screen.getByTestId('document-preview-doc-test-1') }),
    ]);
  }

  it('dispatches request and renders the resolved location after IntersectionObserver reports intersection', async () => {
    render(<DocumentCard document={MOCK_DOC_1} onOpen={vi.fn()} onDetails={vi.fn()} />);

    expect(getDocumentPreviewMock).not.toHaveBeenCalled();

    intersect();

    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(1);
      expect(getDocumentPreviewMock).toHaveBeenCalledWith('doc-test-1', {
        format: 'pdf',
        pageIndex: 2,
        pageLabel: 'Page 3',
      });
      expect(screen.getByTestId('preview-location-badge-doc-test-1').textContent).toContain('Page 3');
    });
  });

  it('invalidates and re-fetches when document fileHash or storage health changes', async () => {
    const { rerender } = render(<DocumentCard document={MOCK_DOC_1} onOpen={vi.fn()} onDetails={vi.fn()} />);

    intersect();
    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(1);
    });

    // Rerender with changed fileHash (e.g. document edited on disk)
    const updatedDoc: DocumentMetadata = {
      ...MOCK_DOC_1,
      fileHash: 'hash-v2-changed',
    };

    rerender(<DocumentCard document={updatedDoc} onOpen={vi.fn()} onDetails={vi.fn()} />);

    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(2);
    });

    rerender(<DocumentCard document={{ ...updatedDoc, storageHealth: 'changed' }} onOpen={vi.fn()} onDetails={vi.fn()} />);
    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(3);
    });
  });

  it('refreshes one failed cover capability, then falls back without looping', async () => {
    getDocumentPreviewMock
      .mockResolvedValueOnce({
        documentId: 'doc-test-1',
        format: 'pdf',
        locationLabel: 'Page 3',
        isLastRead: true,
        snippet: 'Fallback after a failed cover.',
        coverAssetUrl: 'interleaf-media://expired-cover',
        fallback: false,
      })
      .mockResolvedValueOnce({
        documentId: 'doc-test-1',
        format: 'pdf',
        locationLabel: 'Page 3',
        isLastRead: true,
        snippet: 'Fallback after a second failed cover.',
        coverAssetUrl: 'interleaf-media://replacement-cover',
        fallback: false,
      });
    render(<DocumentCard document={MOCK_DOC_1} onOpen={vi.fn()} onDetails={vi.fn()} />);
    intersect();
    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.error(screen.getByTestId('preview-cover-image-doc-test-1'));
    await waitFor(() => {
      expect(getDocumentPreviewMock).toHaveBeenCalledTimes(2);
    });

    const replacement = screen.getByTestId('preview-cover-image-doc-test-1');
    fireEvent.error(replacement);
    await waitFor(() => {
      // Both capabilities failed, so the card settles on its generated cover
      // instead of retrying the asset URL forever.
      expect(screen.getByTestId('generated-cover-doc-test-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('preview-cover-image-doc-test-1')).toBeNull();
    expect(getDocumentPreviewMock).toHaveBeenCalledTimes(2);
  });
});
