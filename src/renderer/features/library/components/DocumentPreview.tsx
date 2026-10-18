import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DocumentFormat, DocumentLocation, DocumentMetadata, DocumentPreviewData } from '@shared/types/document';
import { bridge } from '../../../app/api-client';

export type DocumentPreviewInfo = {
  readonly locationLabel: string;
  readonly isLastRead: boolean;
  readonly format: string;
  readonly pageNumber?: number | undefined;
  readonly blockIndex?: number | undefined;
};

const DEFAULT_PREVIEW_INFO: Readonly<Record<DocumentFormat, DocumentPreviewInfo>> = {
  pdf: { locationLabel: 'Page 1', isLastRead: false, format: 'pdf', pageNumber: 1 },
  markdown: { locationLabel: 'Page 1', isLastRead: false, format: 'markdown', blockIndex: 0 },
  docx: { locationLabel: 'Page 1', isLastRead: false, format: 'docx' },
  pptx: { locationLabel: 'Slide 1', isLastRead: false, format: 'pptx' },
  epub: { locationLabel: 'Cover', isLastRead: false, format: 'epub' },
  mobi: { locationLabel: 'Cover', isLastRead: false, format: 'mobi' },
};

function lastReadLabel(location: DocumentLocation, progress: number): string {
  switch (location.format) {
    case 'pdf':
      return location.pageLabel ?? `Page ${String(location.pageIndex + 1)}`;
    case 'markdown':
      return location.headingId ? `# ${location.headingId}` : `Section ${String(location.blockIndex + 1)}`;
    case 'pptx':
      return `Slide ${String((location.renderedPageIndex ?? 0) + 1)}`;
    case 'docx':
      return `Para ${String(location.paragraphIndex + 1)}`;
    case 'epub':
      return `p. ${String(Math.round(progress * 100))}%`;
    case 'mobi':
      return `Section ${String(location.sectionIndex + 1)}`;
  }
}

function lastReadInfo(location: DocumentLocation, progress: number): DocumentPreviewInfo {
  return {
    locationLabel: lastReadLabel(location, progress),
    isLastRead: true,
    format: location.format,
    ...(location.format === 'pdf' ? { pageNumber: location.pageIndex + 1 } : {}),
    ...(location.format === 'markdown' ? { blockIndex: location.blockIndex } : {}),
  };
}

export function getDocumentPreviewInfo(doc: DocumentMetadata): DocumentPreviewInfo {
  const position = doc.readingPosition;
  if (position && position.progress > 0) {
    return lastReadInfo(position.location, position.progress);
  }
  // Default preview location (Page 1 or Cover)
  return Object.hasOwn(DEFAULT_PREVIEW_INFO, doc.format)
    ? DEFAULT_PREVIEW_INFO[doc.format]
    : { locationLabel: 'Page 1', isLastRead: false, format: doc.format };
}

/**
 * Bounded LRU Cache (max 200 items)
 */
export class PreviewLRUCache<K, V> {
  private readonly max: number;
  private readonly map: Map<K, V>;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(max = 200, onEvict?: (key: K, value: V) => void) {
    this.max = max;
    this.map = new Map<K, V>();
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        if (oldestValue !== undefined) {
          this.onEvict?.(oldestKey, oldestValue);
        }
      }
    }
    this.map.set(key, val);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key);
    this.map.delete(key);
    if (value !== undefined) {
      this.onEvict?.(key, value);
    }
    return true;
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.map.entries()) {
        this.onEvict(key, value);
      }
    }
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Concurrency Scheduler (max 3 in-flight requests with in-flight deduplication)
 */
export class PreviewScheduler {
  private readonly maxConcurrency: number;
  private runningCount = 0;
  private readonly queue: (() => void)[] = [];
  private readonly inFlight = new Map<string, Promise<DocumentPreviewData>>();

  constructor(maxConcurrency = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  async schedule(
    cacheKey: string,
    fetcher: () => Promise<DocumentPreviewData>
  ): Promise<DocumentPreviewData> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      await this.acquireSlot();
      try {
        return await fetcher();
      } finally {
        this.inFlight.delete(cacheKey);
        this.releaseSlot();
      }
    })();

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async acquireSlot(): Promise<void> {
    if (this.runningCount < this.maxConcurrency) {
      this.runningCount++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private releaseSlot(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = this.queue.shift();
    if (next) {
      this.runningCount++;
      next();
    }
  }

  get activeCount(): number {
    return this.runningCount;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  clear(): void {
    this.inFlight.clear();
    this.queue.length = 0;
    this.runningCount = 0;
  }
}

const PREVIEW_COVER_REFRESH_MS = 50 * 60 * 1000;
const previewCoverIssuedAt = new Map<string, number>();
const previewCoverRetryKeys = new Set<string>();

const previewCache = new PreviewLRUCache<string, DocumentPreviewData>(
  200,
  (cacheKey) => {
    // Keep the metadata maps bounded with the cache. Without this callback,
    // long-lived library sessions would retain one timestamp/retry marker per
    // document even after its preview data had been evicted.
    previewCoverIssuedAt.delete(cacheKey);
    previewCoverRetryKeys.delete(cacheKey);
  }
);
const previewScheduler = new PreviewScheduler(3);

function getUsableCachedPreview(cacheKey: string): DocumentPreviewData | undefined {
  const value = previewCache.get(cacheKey);
  if (!value?.coverAssetUrl) return value;

  const issuedAt = previewCoverIssuedAt.get(cacheKey) ?? 0;
  if (Date.now() - issuedAt >= PREVIEW_COVER_REFRESH_MS) {
    previewCache.delete(cacheKey);
    previewCoverIssuedAt.delete(cacheKey);
    return undefined;
  }
  return value;
}

export function resetPreviewCacheForTesting(): void {
  previewCache.clear();
  previewScheduler.clear();
  previewCoverIssuedAt.clear();
  previewCoverRetryKeys.clear();
}

/**
 * What a cover-first card needs from the asynchronous preview: the artwork to
 * paint, the reading location to state on the scrim, and the two image
 * callbacks that keep an expired one-hour media capability from becoming a
 * permanently broken cover.
 */
export type DocumentPreviewState = {
  /** Attach to the visible cover surface; it drives lazy fetching. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly locationLabel: string;
  readonly isLastRead: boolean;
  readonly coverAssetUrl: string | null;
  readonly onCoverLoad: () => void;
  readonly onCoverError: () => void;
};

/**
 * Owns preview fetching for one document: visibility gating, the bounded
 * scheduler, the LRU cache and capability refresh. The card composes the
 * result; nothing here decides how a cover looks.
 */
export function useDocumentPreview(doc: DocumentMetadata): DocumentPreviewState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const syncInfo = getDocumentPreviewInfo(doc);
  const targetLocation: DocumentLocation | null =
    doc.readingPosition && doc.readingPosition.progress > 0
      ? doc.readingPosition.location
      : null;

  const cacheKey = `${doc.id}:${doc.fileHash}:${doc.storageHealth}:${JSON.stringify(targetLocation)}`;
  const cached = getUsableCachedPreview(cacheKey);

  const [previewData, setPreviewData] = useState<DocumentPreviewData | null>(cached ?? null);
  const [isVisible, setIsVisible] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [coverFailed, setCoverFailed] = useState(false);

  // 1. Visibility tracking via IntersectionObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '100px' }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  // 2. Fetching via bounded concurrency scheduler once visible
  useEffect(() => {
    setCoverFailed(false);
    const freshCached = getUsableCachedPreview(cacheKey);
    if (freshCached) {
      setPreviewData(freshCached);
      return;
    }

    // Reset previewData if key changed and not yet cached
    setPreviewData(null);

    if (!isVisible) {
      return;
    }

    let isMounted = true;

    previewScheduler
      .schedule(cacheKey, () => bridge.library.getDocumentPreview(doc.id, targetLocation))
      .then((data) => {
        previewCache.set(cacheKey, data);
        if (data.coverAssetUrl) {
          previewCoverIssuedAt.set(cacheKey, Date.now());
        } else {
          previewCoverIssuedAt.delete(cacheKey);
        }
        if (isMounted) {
          setPreviewData(data);
        }
      })
      .catch(() => {
        const fallbackData: DocumentPreviewData = {
          documentId: doc.id,
          format: doc.format,
          locationLabel: syncInfo.locationLabel,
          isLastRead: syncInfo.isLastRead,
          snippet: `${doc.title} (${syncInfo.locationLabel})`,
          coverAssetUrl: null,
          fallback: true,
        };
        previewCache.set(cacheKey, fallbackData);
        previewCoverIssuedAt.delete(cacheKey);
        if (isMounted) {
          setPreviewData(fallbackData);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [
    isVisible,
    cacheKey,
    refreshNonce,
    doc.id,
    doc.fileHash,
    doc.title,
    doc.format,
    targetLocation,
    syncInfo.locationLabel,
    syncInfo.isLastRead,
  ]);

  // Opaque media capabilities expire in main after one hour. Refresh before
  // that boundary even when the library card stays mounted and visible.
  useEffect(() => {
    const cachedPreview = getUsableCachedPreview(cacheKey);
    if (!cachedPreview?.coverAssetUrl) return;
    const issuedAt = previewCoverIssuedAt.get(cacheKey);
    if (issuedAt === undefined) return;
    const delay = Math.max(0, PREVIEW_COVER_REFRESH_MS - (Date.now() - issuedAt));
    const timer = window.setTimeout(() => {
      previewCache.delete(cacheKey);
      previewCoverIssuedAt.delete(cacheKey);
      previewCoverRetryKeys.delete(cacheKey);
      setPreviewData(null);
      setRefreshNonce((value) => value + 1);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [cacheKey, previewData?.coverAssetUrl]);

  return {
    containerRef,
    locationLabel: previewData?.locationLabel ?? syncInfo.locationLabel,
    isLastRead: previewData?.isLastRead ?? syncInfo.isLastRead,
    coverAssetUrl: coverFailed ? null : previewData?.coverAssetUrl ?? null,
    onCoverLoad: () => {
      previewCoverRetryKeys.delete(cacheKey);
    },
    onCoverError: () => {
      // A renderer can outlive a one-hour main-process capability. One refresh
      // obtains a new opaque URL; a second failure falls back to the generated
      // cover without retrying forever.
      if (!previewCoverRetryKeys.has(cacheKey)) {
        previewCache.delete(cacheKey);
        previewCoverIssuedAt.delete(cacheKey);
        // Deleting invokes the cache eviction hook, so set this marker after
        // deletion to prevent a second failed URL from looping.
        previewCoverRetryKeys.add(cacheKey);
        setPreviewData(null);
        setRefreshNonce((value) => value + 1);
      } else {
        setCoverFailed(true);
      }
    },
  };
}
