import { InterleafError } from '@shared/errors/interleaf-error';
import { MAX_WEB_ARTICLE_URL_LENGTH } from '@shared/constants/web-article';
import type { DocumentSource, WebArticleMediaSummary } from '@shared/types/document';
import type { Logger } from '../logging/logger';
import { assertRequestUrl, toProvenanceUrl } from '../net/address-policy';
import type { WebArticleTransport } from '../net/web-article-transport';
import type { WebMediaTransport } from '../net/web-media-transport';
import { extractArticleInWorker } from '../workers/article-extract-worker';
import type { ExtractedArticle } from './article-content';
import { articleTitle, renderArticleMarkdown } from './article-markdown';
import type { ArticleMediaAsset } from './article-media';
import { ArticleMediaPhase } from './article-media-phase';

/**
 * Turns a submitted URL into an inert Markdown snapshot.
 *
 * This service owns the untrusted half of a web import — fetching, extracting,
 * and rendering — and hands the library a plain string plus bounded metadata.
 * It touches no database and writes no file, so a failure anywhere in here can
 * leave nothing behind; storage only becomes involved once a complete snapshot
 * exists.
 */

export type PreparedWebArticle = {
  readonly markdown: string;
  readonly title: string;
  readonly author: string | null;
  readonly source: DocumentSource;
  /**
   * Admitted image bytes the snapshot refers to, for the library to store.
   *
   * They travel in memory because this service must not write files; the
   * aggregate media budget is what keeps that bounded.
   */
  readonly media: readonly ArticleMediaAsset[];
  /**
   * What the reader will and will not see, counted in pictures rather than in
   * stored files: two page images that turn out to hold the same bytes are one
   * asset and two archived images.
   */
  readonly mediaSummary: WebArticleMediaSummary;
};

export type ArticleExtractor = (
  html: string,
  baseUrl: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<ExtractedArticle>;

export type WebArticleImportServiceDeps = {
  readonly transport: WebArticleTransport;
  readonly log: Logger;
  /**
   * Image transport. A picture it cannot fetch or admit degrades to its alt
   * text; the article still imports.
   */
  readonly media: WebMediaTransport;
  /** Overridable only for tests; production always uses the bounded worker. */
  readonly extract?: ArticleExtractor;
  readonly now?: () => Date;
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly timeoutMs?: number;
  readonly mediaTimeoutMs?: number;
};

function timedOutImportError(): InterleafError {
  return new InterleafError(
    'validation',
    'That page took too long to respond, so Interleaf stopped waiting.'
  );
}

function cancelledImportError(): InterleafError {
  return new InterleafError('validation', 'That import was cancelled.');
}

/**
 * The site name to store: the page's own, trimmed, or the host it came from.
 *
 * The stored source is validated as bounded, single-line, non-empty text, and a
 * page is free to declare `og:site_name` as spaces. Falling back to the host
 * keeps provenance truthful rather than letting a blank one fail the write.
 */
function siteNameFor(declared: string | null, hostname: string): string {
  const trimmed = declared === null ? '' : declared.trim();
  return trimmed.length > 0 ? trimmed : hostname;
}

/** A readable stand-in title when the page supplies none. */
function fallbackTitleFor(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return url.hostname;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  const cleaned = decoded
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : url.hostname;
}
export class WebArticleImportService {
  private readonly transport: WebArticleTransport;
  private readonly log: Logger;
  private readonly extract: ArticleExtractor;
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly mediaPhase: ArticleMediaPhase;
  private activeImports = 0;
  private readonly waiters: { id: symbol; onSlot: () => void }[] = [];

  constructor(deps: WebArticleImportServiceDeps) {
    this.transport = deps.transport;
    this.log = deps.log;
    this.extract = deps.extract ?? ((html, baseUrl, opts) => extractArticleInWorker(html, baseUrl, opts));
    this.now = deps.now ?? (() => new Date());
    this.maxConcurrent = deps.maxConcurrent ?? 2;
    this.maxQueue = deps.maxQueue ?? 6;
    this.timeoutMs = deps.timeoutMs ?? 20_000;
    this.mediaPhase = new ArticleMediaPhase({
      transport: deps.media,
      ...(deps.mediaTimeoutMs !== undefined ? { timeoutMs: deps.mediaTimeoutMs } : {}),
      log: deps.log,
    });
  }

  /**
   * Takes one of the fixed import slots, waiting in a bounded queue if they are
   * all busy.
   *
   * A waiter that hits its deadline or is cancelled leaves the queue without
   * taking a slot, so an abandoned request never starts fetching afterwards and
   * never holds the queue against the requests behind it.
   */
  private async acquireAdmission(deadline: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      throw cancelledImportError();
    }

    if (this.activeImports < this.maxConcurrent) {
      this.activeImports += 1;
      return this.makeRelease();
    }

    if (this.waiters.length >= this.maxQueue) {
      throw new InterleafError(
        'validation',
        'Interleaf is already importing as many articles as it can handle. Try again in a moment.'
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timedOutImportError();
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const entryId = Symbol('import-waiter');

      const abandon = (error: InterleafError): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.findIndex((waiter) => waiter.id === entryId);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(error);
      };

      function onAbort(): void {
        abandon(cancelledImportError());
      }

      const onSlot = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(this.makeRelease());
      };

      timer = setTimeout(() => {
        abandon(timedOutImportError());
      }, remainingMs);
      timer.unref();

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push({ id: entryId, onSlot });
    });
  }

  /** A release callback that gives the slot back exactly once. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseAdmission();
    };
  }

  private releaseAdmission(): void {
    const next = this.waiters.shift();
    if (next) {
      next.onSlot();
    } else {
      this.activeImports -= 1;
    }
  }

  async prepare(
    rawUrl: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<PreparedWebArticle> {
    const deadline = Date.now() + (options?.timeoutMs ?? this.timeoutMs);
    // The fetch and extraction calls below still carry the page deadline
    // itself, so the media phase's extra allowance is only ever available to
    // images.
    const overallDeadline = deadline + this.mediaPhase.extraTimeMs;
    // Validated here as well as inside the transport: this service must never
    // hand an unchecked string to anything, even its own dependency.
    const requested = assertRequestUrl(rawUrl);
    const caller = options?.signal;

    const release = await this.acquireAdmission(deadline, caller);
    // One controller drives both halves of the job. The deadline, the caller's
    // cancellation, and any failure all end up aborting it, and that abort is
    // what closes the socket and terminates the extraction worker — the race
    // below only decides what this call returns, never what keeps running.
    const abortController = new AbortController();
    // Cancellation the images obey, which is only ever the user asking to stop.
    // The images deliberately do not follow the controller above: running out of
    // time is fatal to a page that never arrived and merely disappointing for a
    // figure that did not, so the media phase is given its own signal and
    // enforces the clock itself by returning what it managed to archive. Keeping
    // the two apart is what stops a slow image from being able to weaken, or
    // even reach, the page fetch and its address checks.
    const mediaCancel = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    const remainingTotalMs = overallDeadline - Date.now();
    if (remainingTotalMs <= 0) {
      release();
      throw timedOutImportError();
    }

    const onCallerAbort = (): void => {
      abortController.abort();
      mediaCancel.abort();
    };
    if (caller !== undefined) {
      if (caller.aborted) onCallerAbort();
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }

    const abortPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        abortController.abort();
        reject(timedOutImportError());
      }, remainingTotalMs);
      timeoutTimer.unref();
      abortController.signal.addEventListener(
        'abort',
        () => {
          reject(caller?.aborted === true ? cancelledImportError() : timedOutImportError());
        },
        { once: true }
      );
    });
    // An unhandled rejection is fatal in the main process, and this promise can
    // reject on a path where no race is subscribed to it yet. The races below
    // decide what this call returns; the abort is what stops the work.
    abortPromise.catch(() => undefined);

    // The only thing that can end the image phase from outside it.
    const cancelPromise = new Promise<never>((_, reject) => {
      mediaCancel.signal.addEventListener(
        'abort',
        () => {
          reject(cancelledImportError());
        },
        { once: true }
      );
    });
    cancelPromise.catch(() => undefined);

    try {
      const remainingFetchMs = deadline - Date.now();
      if (remainingFetchMs <= 0) {
        throw timedOutImportError();
      }
      const page = await Promise.race([
        this.transport.fetchArticleHtml(requested.url.toString(), {
          signal: abortController.signal,
          deadline,
          timeoutMs: remainingFetchMs,
        }),
        abortPromise,
      ]);
      const finalUrl = assertRequestUrl(page.finalUrl);

      const remainingExtractMs = deadline - Date.now();
      if (remainingExtractMs <= 0) {
        throw new InterleafError('validation', 'That page took too long to read, so Interleaf stopped.');
      }
      const article = await Promise.race([
        this.extract(page.html, finalUrl.url.toString(), {
          timeoutMs: remainingExtractMs,
          signal: abortController.signal,
        }),
        abortPromise,
      ]);
      // Raced against cancellation only. A media-phase deadline resolves rather
      // than rejects: the article is already in hand, so the snapshot is
      // finished with whatever imagery arrived and the rest is counted as
      // omitted.
      const media = await Promise.race([
        this.mediaPhase.collect(article, overallDeadline, mediaCancel.signal),
        cancelPromise,
      ]);

      const sourceUrl = toProvenanceUrl(finalUrl.url, MAX_WEB_ARTICLE_URL_LENGTH);
      const input = {
        article,
        sourceUrl,
        fallbackTitle: fallbackTitleFor(finalUrl.url),
        images: media.references,
      };
      const markdown = renderArticleMarkdown(input);

      this.log.info('Captured web article snapshot', {
        host: finalUrl.hostname,
        bytes: page.transferredBytes,
        blocks: article.blocks.length,
        images: media.assets.length,
        imagesOmitted: media.omitted,
      });

      return {
        markdown,
        title: articleTitle(input),
        author: article.byline,
        media: media.assets,
        mediaSummary: { archived: media.archived, omitted: media.omitted },
        source: {
          kind: 'web',
          url: sourceUrl,
          siteName: siteNameFor(article.siteName, finalUrl.hostname),
          capturedAt: this.now().toISOString(),
        },
      };
    } catch (error) {
      // Whatever went wrong, nothing downstream should still be fetching or
      // extracting once this call has given up on it.
      abortController.abort();
      mediaCancel.abort();
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
      caller?.removeEventListener('abort', onCallerAbort);
      release();
    }
  }
}

/**
 * Maps any failure from the untrusted pipeline to a message that is safe to
 * show. Typed failures already carry deliberate wording; anything else becomes
 * one generic sentence so an internal detail cannot leak through the renderer.
 */
export function safeWebArticleError(cause: Error | null): InterleafError {
  if (cause instanceof InterleafError && cause.code !== 'internal') {
    return cause;
  }
  return new InterleafError(
    'validation',
    'Interleaf could not import that page safely.'
  );
}
