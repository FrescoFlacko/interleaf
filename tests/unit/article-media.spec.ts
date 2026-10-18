import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  assetReference,
  collectArticleMedia,
  MAX_ARCHIVED_IMAGES,
  type ArticleMediaOptions,
} from '@main/library/article-media';
import {
  admitRasterBytes,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DIMENSION,
  MIN_MEDIA_DIMENSION,
} from '@main/net/web-media-fetcher';
import type {
  FetchedWebMedia,
  WebMediaTransport,
  WebMediaTransportOptions,
} from '@main/net/web-media-transport';
import type { Logger } from '@main/logging/logger';
import {
  HTML_BYTES,
  makeAnimatedPng,
  makeAvifHeader,
  makeGifHeader,
  makeJpeg,
  makeJpegHeader,
  makeInflatingPng,
  makeMismatchedPng,
  makePng,
  makePngHeader,
  makeWebpHeader,
  SVG_BYTES,
} from '../fixtures/raster-fixtures';
import { rasterFormatFixtures, type FormatFixtures } from '../fixtures/extended-raster-fixtures';

/**
 * Admission and budgeting for downloaded article images.
 *
 * These are the two decisions that stand between an untrusted page and a file
 * in the user's library: whether a given buffer is a raster the reader can
 * display at all, and how much of an article's images Interleaf is willing to
 * fetch. Neither one opens a socket, so the transport here is a fake — but the
 * admission check under test is the same function the live fetcher calls.
 */

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type CostlyFailure = { readonly wireBytes: number; readonly error: Error };
/** A transport that fails without saying what it moved, like a buggy one. */
type SilentFailure = { readonly silentError: Error };

type FixtureResponse =
  | Buffer
  | Error
  | { readonly bytes: Buffer; readonly delayMs: number }
  | CostlyFailure
  | SilentFailure;

function isCostlyFailure(response: FixtureResponse): response is CostlyFailure {
  return !Buffer.isBuffer(response) && !(response instanceof Error) && 'wireBytes' in response;
}

function isSilentFailure(response: FixtureResponse): response is SilentFailure {
  return !Buffer.isBuffer(response) && !(response instanceof Error) && 'silentError' in response;
}

class FakeMediaTransport implements WebMediaTransport {
  readonly requested: string[] = [];
  readonly reservations: number[] = [];
  /** The signal each request was handed, so the phase's own can be inspected. */
  readonly signals: (AbortSignal | undefined)[] = [];
  concurrent = 0;
  peakConcurrent = 0;

  constructor(private readonly responses: Record<string, FixtureResponse>) {}

  async fetchImage(url: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia> {
    const request = options ?? {};
    this.requested.push(url);
    this.reservations.push(request.maxTransferBytes ?? MAX_MEDIA_BYTES);
    this.signals.push(request.signal);
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    // Reported on every exit but the deliberately silent one, which is how the
    // production transport behaves: a request that never connected moved zero.
    let moved: number | null = 0;
    try {
      const response = this.responses[url];
      if (response === undefined) {
        throw new InterleafError('validation', 'Interleaf could not reach that website.');
      }
      if (response instanceof Error) throw response;
      if (isSilentFailure(response)) {
        moved = null;
        throw response.silentError;
      }
      if (isCostlyFailure(response)) {
        moved = response.wireBytes;
        throw response.error;
      }
      const bytes = Buffer.isBuffer(response) ? response : response.bytes;
      if (!Buffer.isBuffer(response)) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      moved = bytes.byteLength;
      const maxBytes = Math.min(request.maxTransferBytes ?? MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
      return { ...(await admitRasterBytes(bytes, 'image/png', maxBytes)), finalUrl: url };
    } finally {
      this.concurrent -= 1;
      if (moved !== null) request.onWireBytes?.(moved);
    }
  }
}

function collect(
  transport: WebMediaTransport,
  sources: readonly string[],
  options: ArticleMediaOptions = {},
  log: Logger = silentLog
): ReturnType<typeof collectArticleMedia> {
  return collectArticleMedia(sources, { transport, log }, options);
}

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('raster admission', () => {
  let formats: FormatFixtures;
  beforeAll(() => {
    formats = rasterFormatFixtures();
  });

  it('accepts the formats the reader can display and reports their real size', async () => {
    const cases = [
      { bytes: makePng(64, 48), declared: 'image/png', mimeType: 'image/png', extension: '.png' },
      { bytes: makeJpeg(64, 48), declared: 'image/jpeg', mimeType: 'image/png', extension: '.png' },
      { bytes: formats.colourJpeg, declared: 'image/jpg', mimeType: 'image/png', extension: '.png' },
      { bytes: formats.staticGif, declared: 'image/gif', mimeType: 'image/png', extension: '.png' },
      { bytes: formats.staticWebp, declared: 'image/webp', mimeType: 'image/png', extension: '.png' },
      { bytes: formats.staticAvif, declared: 'image/avif', mimeType: 'image/png', extension: '.png' },
    ] as const;

    for (const testCase of cases) {
      const admitted = await admitRasterBytes(testCase.bytes, testCase.declared, MAX_MEDIA_BYTES);
      expect(admitted.mimeType, testCase.declared).toBe(testCase.mimeType);
      expect(admitted.extension).toBe(testCase.extension);
      expect(admitted.width).toBe(64);
      expect(admitted.height).toBe(48);
    }
  });

  it('refuses a declared type that contradicts the decoded source format', async () => {
    await expect(
      admitRasterBytes(makeJpeg(64, 48), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow(InterleafError);
    await expect(
      admitRasterBytes(makeJpeg(64, 48), 'image/pjpeg', MAX_MEDIA_BYTES)
    ).rejects.toThrow(InterleafError);
    await expect(
      admitRasterBytes(formats.staticGif, 'image/webp', MAX_MEDIA_BYTES)
    ).rejects.toThrow(InterleafError);
    await expect(
      admitRasterBytes(formats.animatedGif, 'image/gif', MAX_MEDIA_BYTES)
    ).rejects.toThrow(InterleafError);
    await expect(
      admitRasterBytes(formats.animatedWebp, 'image/webp', MAX_MEDIA_BYTES)
    ).rejects.toThrow(InterleafError);
  });

  it('tolerates alternative content type parameters for PNG', async () => {
    await expect(
      admitRasterBytes(makePng(64, 48), 'image/png; charset=binary', MAX_MEDIA_BYTES)
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });
  it('refuses vector and markup payloads whatever the server calls them', async () => {
    for (const declared of ['image/png', 'image/svg+xml', 'image/jpeg']) {
      await expect(admitRasterBytes(SVG_BYTES, declared, MAX_MEDIA_BYTES)).rejects.toThrow(
        InterleafError
      );
      await expect(admitRasterBytes(HTML_BYTES, declared, MAX_MEDIA_BYTES)).rejects.toThrow(
        InterleafError
      );
    }
  });

  it('refuses bytes whose format disagrees with the declared type', async () => {
    await expect(admitRasterBytes(makePng(64, 48), 'image/jpeg', MAX_MEDIA_BYTES)).rejects.toThrow(
      InterleafError
    );
    await expect(admitRasterBytes(makeJpeg(64, 48), 'image/png', MAX_MEDIA_BYTES)).rejects.toThrow(
      InterleafError
    );
  });

  it('refuses containers whose pixel data it cannot verify offline', async () => {
    // GIF, WebP, and AVIF carry an LZW, VP8, or AV1 payload that nothing in the
    // main process can decode, so their declared size is an unverifiable claim.
    await expect(admitRasterBytes(makeGifHeader(64, 48), 'image/gif', MAX_MEDIA_BYTES)).rejects.toThrow();
    await expect(
      admitRasterBytes(makeWebpHeader(64, 48), 'image/webp', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    await expect(
      admitRasterBytes(makeAvifHeader(64, 48), 'image/avif', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
  });

  it('refuses a header with nothing behind it and a header that undershoots the raster', async () => {
    await expect(
      admitRasterBytes(makePngHeader(64, 48), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    await expect(
      admitRasterBytes(makeJpegHeader(64, 48), 'image/jpeg', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    await expect(
      admitRasterBytes(makeMismatchedPng(64, 48, 12), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    // Extra rows beyond the declared height are the decoder's to ignore: the
    // archive gets exactly the declared 64x48 raster.
    const extraRows = await admitRasterBytes(makeMismatchedPng(64, 48, 60), 'image/png', MAX_MEDIA_BYTES);
    expect(extraRows).toMatchObject({ width: 64, height: 48 });
  });

  it('refuses an animation rather than archiving its first frame', async () => {
    await expect(
      admitRasterBytes(makeAnimatedPng(64, 48), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
  });

  it('refuses an empty body, a truncated image, and an over-budget body', async () => {
    await expect(admitRasterBytes(Buffer.alloc(0), 'image/png', MAX_MEDIA_BYTES)).rejects.toThrow();
    await expect(
      admitRasterBytes(makePng(64, 48).subarray(0, 12), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    const real = makePng(64, 48);
    await expect(admitRasterBytes(real, 'image/png', real.byteLength - 1)).rejects.toThrow();
  });

  it('refuses an icon-sized image and an image that would decode into a bomb', async () => {
    await expect(
      admitRasterBytes(makePng(MIN_MEDIA_DIMENSION - 1, 64), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    await expect(
      admitRasterBytes(makeMismatchedPng(MAX_MEDIA_DIMENSION + 1, 64, 8), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
    // Inside the per-side bound, far outside the decoded-pixel bound.
    await expect(
      admitRasterBytes(makeMismatchedPng(20_000, 19_999, 8), 'image/png', MAX_MEDIA_BYTES)
    ).rejects.toThrow();
  });

  it('rejects an inflating PNG whose canonical re-encoding exceeds admission allowance', async () => {
    const inflating = makeInflatingPng();
    expect(inflating.byteLength).toBeGreaterThanOrEqual(50_000);
    expect(inflating.byteLength).toBeLessThanOrEqual(60_000);
    await expect(
      admitRasterBytes(inflating, 'image/png', 8 * 1024 * 1024)
    ).rejects.toThrow();
  });
});

describe('collectArticleMedia', () => {
  const first = makePng(64, 48, [10, 20, 30]);
  const second = makePng(64, 48, [200, 100, 50]);
  const third = makePng(48, 48, [7, 7, 7]);
  // The archive stores the canonical bytes admission produced, so every
  // expected reference below is derived from those, not from the wire bytes.
  let firstCanonical: Buffer;
  let secondCanonical: Buffer;
  beforeAll(async () => {
    const [a, b] = await Promise.all([
      admitRasterBytes(first, 'image/png', MAX_MEDIA_BYTES),
      admitRasterBytes(second, 'image/png', MAX_MEDIA_BYTES),
    ]);
    firstCanonical = a.bytes;
    secondCanonical = b.bytes;
  });

  it('archives every source and hands back durable app-owned references', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/b.png': second,
    });
    const result = await collect(transport, [
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);

    expect(result.assets).toHaveLength(2);
    expect(result.omitted).toBe(0);
    expect(result.references.get('https://cdn.example.com/a.png')).toBe(
      assetReference(hashOf(firstCanonical), '.png')
    );
    expect(result.references.get('https://cdn.example.com/b.png')).toBe(
      assetReference(hashOf(secondCanonical), '.png')
    );
    for (const reference of result.references.values()) {
      expect(reference.startsWith('interleaf-asset:')).toBe(true);
      expect(reference).not.toContain('interleaf-media:');
      expect(reference).not.toContain('https://');
    }
  });

  it('stores one file for the same picture behind two URLs', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/mirror/a.png': Buffer.from(first),
    });
    const result = await collect(transport, [
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/mirror/a.png',
    ]);

    expect(result.assets).toHaveLength(1);
    expect(result.references.size).toBe(2);
    expect(new Set(result.references.values()).size).toBe(1);
  });

  it('never archives more images than the per-article cap', async () => {
    const sources = Array.from(
      { length: MAX_ARCHIVED_IMAGES + 5 },
      (_value, index) => `https://cdn.example.com/${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const [index, url] of sources.entries()) {
      responses[url] = makePng(64, 48, [index, 60, 90]);
    }
    const transport = new FakeMediaTransport(responses);
    const result = await collect(transport, sources);

    expect(result.requested).toBe(MAX_ARCHIVED_IMAGES);
    expect(result.assets).toHaveLength(MAX_ARCHIVED_IMAGES);
    expect(transport.requested).toHaveLength(MAX_ARCHIVED_IMAGES);
    // The five the cap removed are omissions, not silence.
    expect(result.omitted).toBe(5);
    expect(result.requested + result.omitted).toBe(sources.length);
  });

  it('archives an illustrated article well past the first dozen figures', async () => {
    // The bound that used to truncate here was twelve, so an article like the
    // motivating build guide lost every figure after the twelfth with nothing
    // failing and nothing reported. Small rasters, so the byte budget is never
    // the thing under test.
    const sources = Array.from(
      { length: 26 },
      (_value, index) => `https://cdn.example.com/figure-${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const [index, url] of sources.entries()) {
      responses[url] = makePng(64, 48, [index, 120, 200]);
    }
    const transport = new FakeMediaTransport(responses);
    const result = await collect(transport, sources);

    expect(transport.requested).toHaveLength(sources.length);
    expect(result.assets).toHaveLength(sources.length);
    expect(result.references.size).toBe(sources.length);
    expect(result).toMatchObject({ requested: sources.length, omitted: 0 });
  });

  it('counts candidates a lower count cap removed as omitted, and never asks for them', async () => {
    const sources = Array.from(
      { length: 10 },
      (_value, index) => `https://cdn.example.com/capped-${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const [index, url] of sources.entries()) {
      responses[url] = makePng(64, 48, [index, 30, 210]);
    }
    const transport = new FakeMediaTransport(responses);
    const result = await collect(transport, sources, { maxImages: 4 });

    expect(transport.requested).toEqual(sources.slice(0, 4));
    expect(result).toMatchObject({ archived: 4, requested: 4, omitted: 6 });
    // The reader-visible partition: every candidate was either shown or not.
    expect(result.archived + result.omitted).toBe(sources.length);
    // Nothing past the cap reaches the snapshot under any reference.
    expect([...result.references.keys()]).toEqual(sources.slice(0, 4));
  });

  it('stops spending once the aggregate byte budget is gone', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/b.png': second,
      'https://cdn.example.com/c.png': third,
    });
    // The budget a request truly costs is the greater of its wire bytes and
    // its stored canonical bytes.
    const firstCost = Math.max(first.byteLength, firstCanonical.byteLength);
    const result = await collect(
      transport,
      ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png', 'https://cdn.example.com/c.png'],
      { maxTotalBytes: firstCost, concurrency: 1 }
    );

    expect(result.assets).toHaveLength(1);
    expect(result.omitted).toBe(2);
    // Nothing was even requested once the budget was exhausted.
    expect(transport.requested).toEqual(['https://cdn.example.com/a.png']);
  });

  it('never offers a request more of the budget than is left', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/b.png': second,
    });
    await collect(transport, ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'], {
      maxTotalBytes: 100_000,
      concurrency: 1,
    });

    expect(transport.reservations[0]).toBe(100_000);
    const firstCost = Math.max(first.byteLength, firstCanonical.byteLength);
    expect(transport.reservations[1]).toBe(100_000 - firstCost);
  });


  it('charges a failed transfer for the bytes it actually moved', async () => {
    // Twelve oversized responses at the per-image cap would move 96 MB if each
    // failure refunded its reservation in full. The aggregate cap is 24 MB, so
    // only the first three may reach the network at all.
    const sources = Array.from(
      { length: MAX_ARCHIVED_IMAGES },
      (_value, index) => `https://cdn.example.com/${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const url of sources) {
      responses[url] = {
        wireBytes: MAX_MEDIA_BYTES,
        error: new InterleafError('validation', 'That image is too large.'),
      };
    }
    const transport = new FakeMediaTransport(responses);
    const result = await collect(transport, sources, {
      maxTotalBytes: 3 * MAX_MEDIA_BYTES,
      concurrency: 1,
    });

    expect(transport.requested).toHaveLength(3);
    expect(result.omitted).toBe(MAX_ARCHIVED_IMAGES);
    expect(result.assets).toHaveLength(0);
  });

  it('burns the whole reservation when a failure reports nothing', async () => {
    // A transport that says nothing about what a failed request moved is not
    // taken at its word: the reservation is forfeited rather than recycled.
    const sources = Array.from(
      { length: 6 },
      (_value, index) => `https://cdn.example.com/${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const url of sources) {
      responses[url] = {
        silentError: new InterleafError('validation', 'Interleaf could not reach that website.'),
      };
    }
    const transport = new FakeMediaTransport(responses);
    const result = await collect(transport, sources, {
      maxTotalBytes: 2 * MAX_MEDIA_BYTES,
      concurrency: 1,
    });

    expect(transport.requested).toHaveLength(2);
    expect(result.omitted).toBe(6);
  });

  it('keeps at most the configured number of requests in flight', async () => {
    const sources = Array.from(
      { length: 6 },
      (_value, index) => `https://cdn.example.com/${String(index)}.png`
    );
    const responses: Record<string, FixtureResponse> = {};
    for (const [index, url] of sources.entries()) {
      responses[url] = { bytes: makePng(64, 48, [index * 10, 60, 90]), delayMs: 5 };
    }
    const transport = new FakeMediaTransport(responses);
    await collect(transport, sources, { concurrency: 2 });

    expect(transport.peakConcurrent).toBeLessThanOrEqual(2);
    expect(transport.peakConcurrent).toBeGreaterThan(1);
  });

  it('assembles results in source order however the responses arrive', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/slow.png': { bytes: first, delayMs: 30 },
      'https://cdn.example.com/fast.png': { bytes: second, delayMs: 0 },
    });
    const result = await collect(
      transport,
      ['https://cdn.example.com/slow.png', 'https://cdn.example.com/fast.png'],
      { concurrency: 2 }
    );

    expect(result.assets.map((asset) => asset.hash)).toEqual([
      hashOf(firstCanonical),
      hashOf(secondCanonical),
    ]);
  });

  it('drops one bad image and keeps the rest of the article', async () => {
    const log = { ...silentLog, info: vi.fn() };
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/broken.png': SVG_BYTES,
      'https://cdn.example.com/missing.png': new InterleafError(
        'validation',
        'Interleaf could not reach that website.'
      ),
      'https://cdn.example.com/c.png': third,
    });
    const result = await collect(
      transport,
      [
        'https://cdn.example.com/a.png',
        'https://cdn.example.com/broken.png',
        'https://cdn.example.com/missing.png',
        'https://cdn.example.com/c.png',
      ],
      {},
      log
    );

    expect(result.assets).toHaveLength(2);
    expect(result.omitted).toBe(2);
    expect(result.references.has('https://cdn.example.com/broken.png')).toBe(false);
    expect(result.references.has('https://cdn.example.com/missing.png')).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it('fails the whole import when an image points somewhere the policy forbids', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/blocked.png': new InterleafError(
        'security-violation',
        'That address is not allowed.'
      ),
    });
    await expect(
      collect(transport, ['https://cdn.example.com/a.png', 'https://cdn.example.com/blocked.png'], {
        concurrency: 1,
      })
    ).rejects.toMatchObject({ code: 'security-violation' });
  });

  it('refuses to start once the import has been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeMediaTransport({ 'https://cdn.example.com/a.png': first });
    await expect(
      collect(transport, ['https://cdn.example.com/a.png'], { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'validation' });
    expect(transport.requested).toHaveLength(0);
  });

  it('partitions candidates into archived and omitted even when a request fails', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/broken.png': SVG_BYTES,
    });
    const sources = ['https://cdn.example.com/a.png', 'https://cdn.example.com/broken.png'];
    const result = await collect(transport, sources);

    // `requested` overlaps both halves on purpose: the broken candidate really
    // was asked for and really is missing, and neither number is bent to make
    // some other equation come out even.
    expect(result).toMatchObject({ archived: 1, requested: 2, omitted: 1 });
    expect(result.archived + result.omitted).toBe(sources.length);
    expect(result.requested + result.omitted).not.toBe(sources.length);
  });

  it('counts two URLs holding one picture as two archived candidates', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/one.png': first,
      'https://cdn.example.com/again.png': first,
    });
    const sources = ['https://cdn.example.com/one.png', 'https://cdn.example.com/again.png'];
    const result = await collect(transport, sources);

    // Archived counts references, not files: both are shown, one is stored.
    expect(result).toMatchObject({ archived: 2, omitted: 0 });
    expect(result.assets).toHaveLength(1);
    expect(result.archived + result.omitted).toBe(sources.length);
  });

  it('returns a partial article rather than failing when the phase deadline passes', async () => {
    const sources = [
      'https://cdn.example.com/slow.png',
      'https://cdn.example.com/b.png',
      'https://cdn.example.com/c.png',
    ];
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/slow.png': { bytes: first, delayMs: 60 },
      'https://cdn.example.com/b.png': second,
      'https://cdn.example.com/c.png': third,
    });
    const result = await collect(transport, sources, {
      deadline: Date.now() + 20,
      concurrency: 1,
    });

    // The article survives with what arrived, the queue stops, and the pictures
    // it will not show are all counted.
    expect(result.archived).toBe(1);
    expect(result.omitted).toBe(2);
    expect(result.archived + result.omitted).toBe(sources.length);
    expect(transport.requested).toEqual(['https://cdn.example.com/slow.png']);
  });

  it('asks for nothing once the deadline has already gone', async () => {
    const sources = ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'];
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': first,
      'https://cdn.example.com/b.png': second,
    });
    const result = await collect(transport, sources, { deadline: Date.now() - 1 });

    expect(result).toMatchObject({ archived: 0, requested: 0, omitted: 2 });
    expect(transport.requested).toHaveLength(0);
  });

  it('aborts work still in flight when the deadline passes', async () => {
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/slow.png': { bytes: first, delayMs: 60 },
    });
    await collect(transport, ['https://cdn.example.com/slow.png'], { deadline: Date.now() + 20 });

    // The phase owns the signal it hands the transport, so expiry reaches an
    // open request instead of only stopping the ones not yet started.
    expect(transport.signals[0]?.aborted).toBe(true);
  });

  it('keeps cancellation fatal even while the deadline is generous', async () => {
    const controller = new AbortController();
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/a.png': { bytes: first, delayMs: 20 },
      'https://cdn.example.com/b.png': second,
    });
    const pending = collect(
      transport,
      ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
      { deadline: Date.now() + 5_000, concurrency: 1, signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'validation' });
  });

  it('does nothing at all when the article offered no images', async () => {
    const transport = new FakeMediaTransport({});
    const result = await collect(transport, []);
    expect(result).toMatchObject({ archived: 0, requested: 0, omitted: 0 });
    expect(result.assets).toHaveLength(0);
    expect(transport.requested).toHaveLength(0);
  });

  it('rejects approximately 53,689 input bytes re-encoding to ~12MB under 8 MiB allowance across parallel aggregate lanes', async () => {
    const inflating = makeInflatingPng();
    const transport = new FakeMediaTransport({
      'https://cdn.example.com/inflating-1.png': inflating,
      'https://cdn.example.com/inflating-2.png': inflating,
      'https://cdn.example.com/valid.png': first,
    });

    const result = await collect(
      transport,
      [
        'https://cdn.example.com/inflating-1.png',
        'https://cdn.example.com/inflating-2.png',
        'https://cdn.example.com/valid.png',
      ],
      {
        concurrency: 2,
        maxTotalBytes: 24 * 1024 * 1024,
      }
    );

    // Both inflating images must be rejected and omitted
    expect(result.omitted).toBe(2);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.hash).toBe(hashOf(firstCanonical));
    expect(result.references.has('https://cdn.example.com/inflating-1.png')).toBe(false);
    expect(result.references.has('https://cdn.example.com/inflating-2.png')).toBe(false);
    expect(result.references.get('https://cdn.example.com/valid.png')).toBe(
      assetReference(hashOf(firstCanonical), '.png')
    );
  });
});
