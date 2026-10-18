import { describe, expect, it } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import { WebArticleImportService } from '@main/library/web-article-import';
import type { ExtractedArticle } from '@main/library/article-content';
import type { WebArticleTransport } from '@main/net/web-article-transport';
import type {
  FetchedWebMedia,
  WebMediaTransport,
  WebMediaTransportOptions,
} from '@main/net/web-media-transport';
import { createLogger } from '@main/logging/logger';

/**
 * What running out of time means, depending on which half of an import it
 * happens in.
 *
 * A page that never arrives is an import that failed: there is nothing to show
 * and nothing to store. Images are not like that. By the time the media phase
 * runs the article is already in hand, so a slow image host must cost the
 * reader some illustrations and not the whole capture. These tests hold the two
 * apart, and hold the user cancelling fatal in both. (An address the policy
 * refuses is fatal too; the web-article-media integration suite holds that.)
 */

const IMAGE_URLS = [
  'https://cdn.example.com/figure-one.png',
  'https://cdn.example.com/figure-two.png',
  'https://cdn.example.com/figure-three.png',
] as const;

const log = createLogger('security');

function article(): ExtractedArticle {
  return {
    title: 'Three figures',
    byline: null,
    siteName: null,
    blocks: [
      { type: 'paragraph', inline: [{ text: 'Body paragraph text here.', style: 'plain' }] },
      ...IMAGE_URLS.map((src) => ({ type: 'image' as const, src, alt: 'A figure' })),
    ],
    textLength: 300,
  };
}

const pageTransport: WebArticleTransport = {
  fetchArticleHtml: (url) =>
    Promise.resolve({ html: '<html></html>', finalUrl: url, transferredBytes: 100 }),
};

/** An image host that answers every request only after `delayMs`. */
class SlowMediaTransport implements WebMediaTransport {
  readonly requested: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(private readonly delayMs: number) {}

  async fetchImage(url: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia> {
    this.requested.push(url);
    this.signals.push(options?.signal);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (options?.signal?.aborted === true) {
      throw new InterleafError('validation', 'That request was stopped.');
    }
    throw new InterleafError('validation', 'Interleaf could not reach that website.');
  }
}

/**
 * The images get `mediaTimeoutMs` beyond the page deadline, which the page half
 * here uses none of, so the phase deadline lands `timeoutMs + mediaTimeoutMs`
 * from the call.
 */
function serviceWith(
  media: WebMediaTransport,
  mediaTimeoutMs: number,
  timeoutMs = 30
): WebArticleImportService {
  return new WebArticleImportService({
    transport: pageTransport,
    media,
    log,
    extract: () => Promise.resolve(article()),
    timeoutMs,
    mediaTimeoutMs,
  });
}

describe('a media phase that runs out of time', () => {
  it('returns the article as a partial snapshot, stopping every image request in flight', async () => {
    const media = new SlowMediaTransport(300);
    const prepared = await serviceWith(media, 20).prepare('https://example.com/post');

    expect(prepared.title).toBe('Three figures');
    expect(prepared.media).toHaveLength(0);
    // Every candidate is accounted for, whether it was started or never
    // reached: three offered, none archived, three described in words.
    expect(prepared.mediaSummary).toEqual({ archived: 0, omitted: IMAGE_URLS.length });

    // Concurrency is three, so all three lanes open together and the deadline
    // has to reach the open requests; nothing is left running behind the call.
    for (const signal of media.signals) expect(signal?.aborted).toBe(true);
    expect(media.requested.length).toBeLessThanOrEqual(IMAGE_URLS.length);

    // The alt text a reader still needs stays in the snapshot, while nothing
    // about where Interleaf went survives into it.
    expect(prepared.markdown).toContain('A figure');
    expect(IMAGE_URLS.filter((url) => prepared.markdown.includes(url))).toEqual([]);
  });

  it('still fails the import when the page itself never arrives', async () => {
    const hanging: WebArticleTransport = {
      fetchArticleHtml: () => new Promise<never>(() => undefined),
    };
    const service = new WebArticleImportService({
      transport: hanging,
      media: new SlowMediaTransport(0),
      log,
      extract: () => Promise.resolve(article()),
      timeoutMs: 40,
      mediaTimeoutMs: 20,
    });

    await expect(service.prepare('https://example.com/post')).rejects.toThrow(/too long/);
  });

  it('still fails the import when the reader cancels during the media phase', async () => {
    const controller = new AbortController();
    const media = new SlowMediaTransport(200);
    const pending = serviceWith(media, 5_000, 5_000).prepare('https://example.com/post', {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
