import { describe, expect, it } from 'vitest';
import { WebArticleImportService } from '@main/library/web-article-import';
import type { WebArticleTransport } from '@main/net/web-article-transport';
import { createLogger } from '@main/logging/logger';
import type { ExtractedArticle } from '@main/library/article-content';
import { TestWebMediaTransport } from '@main/net/test-web-media-transport';

function makeMockExtractor(): (html: string, baseUrl: string) => Promise<ExtractedArticle> {
  return () => Promise.resolve({
    title: 'Test Title',
    byline: null,
    siteName: null,
    blocks: [{ type: 'paragraph', inline: [{ text: 'Body paragraph text here.', style: 'plain' }] }],
    textLength: 300,
  });
}

describe('WebArticleImportService Admission Control', () => {
  it('enforces concurrency limit and bounds queue with fast rejection on overflow', async () => {
    let unblockFirst: () => void = () => undefined;
    let unblockSecond: () => void = () => undefined;

    const firstPromise = new Promise<void>((r) => { unblockFirst = r; });
    const secondPromise = new Promise<void>((r) => { unblockSecond = r; });

    let activeRunning = 0;
    let maxObservedActive = 0;

    const transport: WebArticleTransport = {
      async fetchArticleHtml(url: string) {
        activeRunning += 1;
        maxObservedActive = Math.max(maxObservedActive, activeRunning);
        if (url.includes('first')) {
          await firstPromise;
        } else if (url.includes('second')) {
          await secondPromise;
        }
        activeRunning -= 1;
        return {
          html: '<html><body><article><p>Hello world text with enough length</p></article></body></html>',
          finalUrl: url,
          transferredBytes: 100,
        };
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: makeMockExtractor(),
      maxConcurrent: 2,
      maxQueue: 2,
      timeoutMs: 5000,
    });

    // 1. Start two active requests to saturate the 2 slots
    const p1 = service.prepare('https://example.com/first');
    const p2 = service.prepare('https://example.com/second');

    // Small yield to let both acquire slots
    await new Promise((r) => setTimeout(r, 20));
    expect(maxObservedActive).toBe(2);

    // 2. Queue two requests to fill the queue (maxQueue = 2)
    const q1 = service.prepare('https://example.com/queued-1');
    const q2 = service.prepare('https://example.com/queued-2');

    // 3. A fifth request must fail fast with validation error (queue overflow)
    await expect(service.prepare('https://example.com/overflow')).rejects.toThrow(
      /already importing as many articles/
    );

    // 4. Release first slot; q1 should be admitted
    unblockFirst();
    await p1;

    // 5. Release second slot; q2 should be admitted
    unblockSecond();
    await Promise.all([p2, q1, q2]);

    expect(maxObservedActive).toBeLessThanOrEqual(2);
  });

  it('rejects with timeout when request expires while waiting in admission queue', async () => {
    const neverEnding = new Promise<void>(() => undefined);
    const transport: WebArticleTransport = {
      async fetchArticleHtml(url: string) {
        await neverEnding;
        return { html: '', finalUrl: url, transferredBytes: 0 };
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: makeMockExtractor(),
      maxConcurrent: 1,
      maxQueue: 2,
      timeoutMs: 50,
    });

    // Saturate slot 1
    const p1 = service.prepare('https://example.com/running');
    // Queue request 2 with short timeout
    const p2 = service.prepare('https://example.com/queued', { timeoutMs: 30 });

    await expect(p2).rejects.toThrow(/too long/);

    // Silence unhandled rejection for p1 when test ends
    p1.catch(() => undefined);
  });

  it('aborts a transport that never resolves at the service-owned absolute deadline', async () => {
    let receivedSignal: AbortSignal | undefined;
    const transport: WebArticleTransport = {
      fetchArticleHtml(_url: string, options) {
        receivedSignal = options?.signal;
        // Never resolves on its own
        return new Promise<never>(() => undefined);
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: makeMockExtractor(),
      timeoutMs: 40,
      // The service's own backstop is the page deadline plus the image allowance.
      mediaTimeoutMs: 10,
    });

    const start = Date.now();
    await expect(service.prepare('https://example.com/hanging')).rejects.toThrow(/too long/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(150);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('enforces original absolute deadline after late admission without granting fresh timeout', async () => {
    let unblockFirst: () => void = () => undefined;
    const firstPromise = new Promise<void>((r) => { unblockFirst = r; });
    let secondSignal: AbortSignal | undefined;

    const transport: WebArticleTransport = {
      async fetchArticleHtml(url: string, options) {
        if (url.includes('first')) {
          await firstPromise;
          return { html: '<html><body><article><p>First</p></article></body></html>', finalUrl: url, transferredBytes: 10 };
        }
        secondSignal = options?.signal;
        // Second hangs
        return new Promise<never>(() => undefined);
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: makeMockExtractor(),
      maxConcurrent: 1,
      maxQueue: 2,
      timeoutMs: 100,
      // The service's own backstop is the page deadline plus the image allowance.
      mediaTimeoutMs: 10,
    });

    // Request 1 occupies the slot
    const p1 = service.prepare('https://example.com/first');
    // Request 2 queued with 80ms absolute deadline
    const start = Date.now();
    const p2 = service.prepare('https://example.com/second', { timeoutMs: 80 });

    // Release slot 1 after 50ms (late admission for Request 2)
    setTimeout(() => { unblockFirst(); }, 50);
    await p1;

    // Request 2 should timeout at ~80ms from start, NOT 80ms after admission!
    await expect(p2).rejects.toThrow(/too long/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(150);
    expect(secondSignal?.aborted).toBe(true);
  });

  it('drops a cancelled request from the queue before it ever fetches', async () => {
    const requestedUrls: string[] = [];
    let unblockFirst: () => void = () => undefined;
    const firstPromise = new Promise<void>((resolve) => { unblockFirst = resolve; });

    const transport: WebArticleTransport = {
      async fetchArticleHtml(url: string) {
        requestedUrls.push(url);
        if (url.includes('running')) await firstPromise;
        return {
          html: '<html><body><article><p>Body</p></article></body></html>',
          finalUrl: url,
          transferredBytes: 10,
        };
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: makeMockExtractor(),
      maxConcurrent: 1,
      maxQueue: 4,
      timeoutMs: 5_000,
    });

    const running = service.prepare('https://example.com/running');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const controller = new AbortController();
    const queued = service.prepare('https://example.com/queued', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestedUrls).toEqual(['https://example.com/running']);

    controller.abort();
    await expect(queued).rejects.toThrow(/cancelled/i);

    // Releasing the running slot must not resurrect the cancelled job.
    unblockFirst();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestedUrls).toEqual(['https://example.com/running']);

    // The slot the cancelled request never took is still available.
    await expect(service.prepare('https://example.com/after')).resolves.toBeDefined();
    expect(requestedUrls).toContain('https://example.com/after');
  });

  it('aborts the extractor when the caller cancels mid-extraction', async () => {
    const transport: WebArticleTransport = {
      fetchArticleHtml: (url: string) =>
        Promise.resolve({
          html: '<html><body><article><p>Body</p></article></body></html>',
          finalUrl: url,
          transferredBytes: 10,
        }),
    };

    let extractSignal: AbortSignal | undefined;
    let extractStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { extractStarted = resolve; });

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      // Stands in for the worker: it stops when told to and never on its own.
      extract: (_html, _baseUrl, options) =>
        new Promise<never>((_, reject) => {
          extractSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('extractor aborted'));
          });
          extractStarted();
        }),
      timeoutMs: 5_000,
    });

    const controller = new AbortController();
    const pending = service.prepare('https://example.com/slow', { signal: controller.signal });
    await started;
    expect(extractSignal?.aborted).toBe(false);

    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(extractSignal?.aborted).toBe(true);

    // The cancelled import gave its slot back rather than holding it.
    await expect(
      new WebArticleImportService({
        media: new TestWebMediaTransport(),
        transport,
        log: createLogger('security'),
        extract: makeMockExtractor(),
      }).prepare('https://example.com/next')
    ).resolves.toBeDefined();
  });

  it('aborts the extractor when the service deadline expires', async () => {
    const transport: WebArticleTransport = {
      fetchArticleHtml: (url: string) =>
        Promise.resolve({
          html: '<html><body><article><p>Body</p></article></body></html>',
          finalUrl: url,
          transferredBytes: 10,
        }),
    };

    let extractSignal: AbortSignal | undefined;
    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: (_html, _baseUrl, options) =>
        new Promise<never>((_, reject) => {
          extractSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('extractor aborted'));
          });
        }),
      timeoutMs: 40,
      // The service's own backstop is the page deadline plus the image allowance.
      mediaTimeoutMs: 10,
    });

    await expect(service.prepare('https://example.com/hangs-in-extraction')).rejects.toThrow(/too long/);
    expect(extractSignal?.aborted).toBe(true);
  });

  it('catches malformed percent escapes in fallback title derivation safely', async () => {
    const transport: WebArticleTransport = {
      fetchArticleHtml(url: string) {
        return Promise.resolve({
          html: '<html><body><article><p>Hello world</p></article></body></html>',
          finalUrl: url,
          transferredBytes: 50,
        });
      },
    };

    const service = new WebArticleImportService({
      media: new TestWebMediaTransport(),
      transport,
      log: createLogger('security'),
      extract: () => Promise.resolve({
        title: null, // Force fallback title derivation
        byline: null,
        siteName: null,
        blocks: [{ type: 'paragraph', inline: [{ text: 'Body paragraph text here.', style: 'plain' }] }],
        textLength: 300,
      }),
    });

    // URL with malformed percent escape in path
    const result = await service.prepare('https://example.com/%E0%A4%ZZ-malformed-path');
    expect(result.title).toBeDefined();
    expect(result.title).toContain('malformed path');
  });
});
