import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  MAX_MEDIA_REDIRECTS,
  WebMediaFetcher,
} from '@main/net/web-media-fetcher';
import { ARCHIVABLE_ACCEPT_HEADER } from '@main/net/raster-image';
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { InterleafError } from '@shared/errors/interleaf-error';
import { validateRasterImage } from '@main/net/raster-image';
import { rasterDecoderState } from '@main/workers/raster-decode-worker';
import type { RequestFactory, ResolvedAddress } from '@main/net/pinned-http';
import { makePng, SVG_BYTES } from '../fixtures/raster-fixtures';
import {
  rasterFormatFixtures,
  readCanonicalPng,
  type FormatFixtures,
} from '../fixtures/extended-raster-fixtures';
/**
 * Transport-level tests for the image fetcher.
 *
 * No test here opens a socket: the injected factory replaces the wire and
 * nothing else. The address policy, DNS pinning, per-hop redirect
 * revalidation, transfer bounds, and header hygiene all run exactly as they do
 * in production, because the claim under test is that the media path reuses the
 * page fetcher's controls rather than reimplementing a weaker copy of them.
 */

const PUBLIC_ADDRESS: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PRIVATE_ADDRESS: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const IMAGE_URL = 'https://cdn.example.com/astra/comparison.png';

type ScriptedResponse = {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer;
  readonly silent?: boolean;
};

type RecordedCall = { readonly url: URL; readonly options: RequestOptions };

class FakeRequest extends EventEmitter {
  destroyed = false;

  constructor(private readonly onEnd: (request: FakeRequest) => void) {
    super();
  }

  end(): void {
    setImmediate(() => {
      if (this.destroyed) return;
      this.onEnd(this);
    });
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function buildResponse(spec: ScriptedResponse): IncomingMessage {
  const stream = new Readable({
    read() {
      void 0;
    },
  });
  const response = stream as IncomingMessage & { statusCode: number };
  response.statusCode = spec.status ?? 200;
  response.headers = { 'content-type': 'image/png', ...(spec.headers ?? {}) };
  return response;
}

function scriptTransport(script: readonly ScriptedResponse[]): {
  readonly factory: RequestFactory;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let hop = 0;
  const factory: RequestFactory = (url, options) => {
    calls.push({ url, options });
    const spec = script[Math.min(hop, script.length - 1)] ?? {};
    hop += 1;
    return new FakeRequest((self) => {
      if (spec.silent === true) return;
      const response = buildResponse(spec);
      self.emit('response', response);
      const body = spec.body ?? Buffer.alloc(0);
      if (body.byteLength > 0) response.push(body);
      response.push(null);
    });
  };
  return { factory, calls };
}

function fetcherFor(
  script: readonly ScriptedResponse[],
  overrides: {
    readonly addresses?: readonly (readonly ResolvedAddress[])[];
    readonly maxRedirects?: number;
    readonly maxTransferBytes?: number;
    readonly timeoutMs?: number;
  } = {}
): { readonly fetcher: WebMediaFetcher; readonly calls: RecordedCall[]; readonly hostnames: string[] } {
  const { factory, calls } = scriptTransport(script);
  const batches = overrides.addresses ?? [[PUBLIC_ADDRESS]];
  const hostnames: string[] = [];
  let index = 0;
  const fetcher = new WebMediaFetcher({
    requestFactory: factory,
    lookupAddresses: (hostname: string) => {
      hostnames.push(hostname);
      const batch = batches[Math.min(index, batches.length - 1)] ?? [PUBLIC_ADDRESS];
      index += 1;
      return Promise.resolve(batch);
    },
    ...(overrides.maxRedirects !== undefined ? { maxRedirects: overrides.maxRedirects } : {}),
    ...(overrides.maxTransferBytes !== undefined
      ? { maxTransferBytes: overrides.maxTransferBytes }
      : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  return { fetcher, calls, hostnames };
}

/**
 * The outgoing headers of one recorded call, indexed case-insensitively.
 *
 * Node also accepts a flat name/value array here. The fetcher always builds an
 * object, and this asserts that rather than silently reading `undefined` out of
 * an array if that ever changes.
 */
function headersOf(options: RequestOptions | undefined): ReadonlyMap<string, string> {
  const raw = options?.headers;
  expect(Array.isArray(raw), 'headers are supplied as an object').toBe(false);
  const entries = Object.entries((raw ?? {}) as OutgoingHttpHeaders);
  return new Map(entries.map(([name, value]) => [name.toLowerCase(), String(value ?? '')]));
}

async function expectFailure<T>(promise: Promise<T>, code: string): Promise<InterleafError> {
  let thrown: InterleafError | null = null;
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof InterleafError)) throw error;
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InterleafError);
  const error = thrown!;
  expect(error.code).toBe(code);
  return error;
}

describe('WebMediaFetcher', () => {
  const png = makePng(64, 48);
  let formats: FormatFixtures;
  beforeAll(() => {
    formats = rasterFormatFixtures();
  });

  describe('successful fetch', () => {
    it('returns admitted bytes, the format, the size, and the final URL', async () => {
      const { fetcher } = fetcherFor([{ body: png }]);
      const media = await fetcher.fetchImage(IMAGE_URL);

      expect(media.mimeType).toBe('image/png');
      expect(media.extension).toBe('.png');
      expect(media.width).toBe(64);
      expect(media.height).toBe(48);
      // The archive stores canonical PNG rebuilt from the decoded pixels, not
      // the wire bytes.
      const archived = readCanonicalPng(media.bytes);
      expect(archived).toMatchObject({ width: 64, height: 48, colourType: 2 });
      expect(Array.from(archived.sampleAt(10, 10))).toEqual([32, 96, 192]);
      expect(media.finalUrl).toBe(IMAGE_URL);
    });

    it('admits every supported still format the response declares honestly', async () => {
      for (const [body, contentType] of [
        [formats.colourJpeg, 'image/jpeg'],
        [formats.staticGif, 'image/gif'],
        [formats.staticWebp, 'image/webp'],
        [formats.staticAvif, 'image/avif'],
      ] as const) {
        const { fetcher } = fetcherFor([{ headers: { 'content-type': contentType }, body }]);
        const media = await fetcher.fetchImage(IMAGE_URL);
        expect(media.mimeType, contentType).toBe('image/png');
        expect(media.extension, contentType).toBe('.png');
        expect(media.width, contentType).toBe(64);
        expect(media.height, contentType).toBe(48);
        expect(readCanonicalPng(media.bytes).width, contentType).toBe(64);
      }
    });

    it('refuses bytes whose decoded format contradicts the declared type', async () => {
      for (const [body, contentType] of [
        [formats.colourJpeg, 'image/png'],
        [formats.colourJpeg, 'image/gif'],
        [formats.staticGif, 'image/webp'],
        [formats.staticWebp, 'image/jpeg'],
        [formats.staticAvif, 'image/png'],
      ] as const) {
        const { fetcher } = fetcherFor([{ headers: { 'content-type': contentType }, body }]);
        await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
      }
    });

    it('sends no cookie, authorization, or referrer, and asks for no encoding', async () => {
      const { fetcher, calls } = fetcherFor([{ body: png }]);
      await fetcher.fetchImage(IMAGE_URL);

      const headers = headersOf(calls[0]?.options);
      for (const forbidden of ['cookie', 'authorization', 'referer', 'referrer']) {
        expect([...headers.keys()], `no ${forbidden} header`).not.toContain(forbidden);
      }
      expect(headers.get('accept-encoding')).toBe('identity');
      expect(headers.get('accept')).toBe(ARCHIVABLE_ACCEPT_HEADER);
      expect(calls[0]?.options.agent, 'a Interleaf-owned agent, never a proxy default').toBeDefined();
    });
  });

  describe('address policy', () => {
    it('refuses a blocked submitted URL before opening any connection', async () => {
      for (const url of [
        'http://localhost/logo.png',
        'http://127.0.0.1/logo.png',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/logo.png',
        'https://cdn.example.com:9000/logo.png',
        'https://user:pw@cdn.example.com/logo.png',
        'file:///etc/passwd',
        'data:image/png;base64,AAAA',
      ]) {
        const { fetcher, calls } = fetcherFor([{ body: png }]);
        await expectFailure(fetcher.fetchImage(url), 'security-violation');
        expect(calls, `${url} must not reach the transport`).toHaveLength(0);
      }
    });

    it('pins the validated address instead of resolving again on connect', async () => {
      const { fetcher, calls, hostnames } = fetcherFor([{ body: png }]);
      await fetcher.fetchImage(IMAGE_URL);

      expect(hostnames).toEqual(['cdn.example.com']);
      const lookup = calls[0]?.options.lookup;
      expect(typeof lookup).toBe('function');
    });

    it('refuses a host that resolves to any private address', async () => {
      const { fetcher } = fetcherFor([{ body: png }], {
        addresses: [[PUBLIC_ADDRESS, PRIVATE_ADDRESS]],
      });
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'security-violation');
    });
  });

  describe('redirects', () => {
    it('revalidates every hop and refuses one that lands in private space', async () => {
      const { fetcher, calls } = fetcherFor(
        [{ status: 302, headers: { location: 'https://internal.example.com/logo.png' } }, { body: png }],
        { addresses: [[PUBLIC_ADDRESS], [PRIVATE_ADDRESS]] }
      );
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'security-violation');
      expect(calls).toHaveLength(1);
    });

    it('follows a relative redirect resolved against the current hop', async () => {
      const { fetcher, calls } = fetcherFor([
        { status: 301, headers: { location: '/astra/moved.png' } },
        { body: png },
      ]);
      const media = await fetcher.fetchImage(IMAGE_URL);
      expect(media.finalUrl).toBe('https://cdn.example.com/astra/moved.png');
      expect(calls).toHaveLength(2);
    });

    it('stops after the redirect budget', async () => {
      const { fetcher, calls } = fetcherFor([
        { status: 302, headers: { location: 'https://cdn.example.com/again.png' } },
      ]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'security-violation');
      expect(calls).toHaveLength(MAX_MEDIA_REDIRECTS + 1);
    });
  });

  describe('response bounds', () => {
    it('rejects a declared type that is not an archivable raster', async () => {
      for (const contentType of ['image/svg+xml', 'text/html', 'application/octet-stream', '']) {
        const { fetcher } = fetcherFor([{ headers: { 'content-type': contentType }, body: png }]);
        await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
      }
    });

    it('rejects a vector document served under an image content type', async () => {
      const { fetcher } = fetcherFor([{ headers: { 'content-type': 'image/png' }, body: SVG_BYTES }]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
    });

    it('rejects an oversized declared content length before reading a body', async () => {
      const { fetcher } = fetcherFor([
        { headers: { 'content-length': String(64 * 1024 * 1024) }, body: png },
      ]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
    });

    it('stops reading a body that exceeds the caller transfer budget', async () => {
      const { fetcher } = fetcherFor([{ body: png }], { maxTransferBytes: 64 });
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
    });

    it('rejects a non-success status', async () => {
      const { fetcher } = fetcherFor([{ status: 404, body: png }]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
    });
  });

  describe('transfer accounting', () => {
    it('enforces an allowance smaller than the client cap, on the stream itself', async () => {
      // The client would happily accept 8 MB; this caller has 64 bytes left, so
      // the body is cut off at 64 rather than buffered and judged afterwards.
      const { fetcher } = fetcherFor([{ body: png }]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL, { maxTransferBytes: 64 }), 'validation');
    });

    it('refuses a declared length above the allowance before reading a body', async () => {
      const { fetcher } = fetcherFor([
        { headers: { 'content-length': String(png.byteLength) }, body: png },
      ]);
      await expectFailure(
        fetcher.fetchImage(IMAGE_URL, { maxTransferBytes: png.byteLength - 1 }),
        'validation'
      );
    });

    it('reports what a successful fetch moved', async () => {
      const { fetcher } = fetcherFor([{ body: png }]);
      const reported: number[] = [];
      await fetcher.fetchImage(IMAGE_URL, {
        onWireBytes: (bytes) => reported.push(bytes),
      });
      expect(reported).toEqual([png.byteLength]);
    });

    it('reports what a refused fetch moved, so failures are not free', async () => {
      // Twelve of these behind an aggregate allowance must not transfer twelve
      // times the per-image cap: each attempt costs what it actually pulled.
      let total = 0;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const { fetcher } = fetcherFor([{ body: png }]);
        await expectFailure(
          fetcher.fetchImage(IMAGE_URL, {
            maxTransferBytes: 64,
            onWireBytes: (bytes) => {
              total += bytes;
            },
          }),
          'validation'
        );
      }
      expect(total).toBeGreaterThanOrEqual(12 * 64);
      expect(total).toBe(12 * png.byteLength);
    });

    it('reports zero for a request that never reached a body', async () => {
      const { fetcher } = fetcherFor([{ status: 404, body: png }]);
      const reported: number[] = [];
      await expectFailure(
        fetcher.fetchImage(IMAGE_URL, { onWireBytes: (bytes) => reported.push(bytes) }),
        'validation'
      );
      expect(reported).toEqual([0]);
    });

    it('spends one allowance across a whole redirect chain', async () => {
      const { fetcher } = fetcherFor([
        { status: 302, headers: { location: 'https://cdn.example.com/moved.png' } },
        { body: png },
      ]);
      const reported: number[] = [];
      await fetcher.fetchImage(IMAGE_URL, {
        onWireBytes: (bytes) => reported.push(bytes),
      });
      // One report for the call, not one per hop.
      expect(reported).toEqual([png.byteLength]);
    });
  });

  describe('time and cancellation', () => {
    it('gives up on a server that never responds', async () => {
      const { fetcher } = fetcherFor([{ silent: true }], { timeoutMs: 30 });
      await expectFailure(fetcher.fetchImage(IMAGE_URL), 'validation');
    });

    it('stops at whichever expires first, the import deadline or the image timeout', async () => {
      // A long import deadline must not extend one image past its own timeout.
      const short = fetcherFor([{ silent: true }], { timeoutMs: 30 });
      const startedShort = Date.now();
      await expectFailure(
        short.fetcher.fetchImage(IMAGE_URL, { deadline: Date.now() + 60_000 }),
        'validation'
      );
      expect(Date.now() - startedShort).toBeLessThan(5_000);

      // And a generous image timeout must not outlive the import.
      const long = fetcherFor([{ silent: true }], { timeoutMs: 60_000 });
      const startedLong = Date.now();
      await expectFailure(
        long.fetcher.fetchImage(IMAGE_URL, { deadline: Date.now() + 30 }),
        'validation'
      );
      expect(Date.now() - startedLong).toBeLessThan(5_000);
    });

    it('does not start a request for an already-cancelled import', async () => {
      const controller = new AbortController();
      controller.abort();
      const { fetcher, calls } = fetcherFor([{ body: png }]);
      await expectFailure(fetcher.fetchImage(IMAGE_URL, { signal: controller.signal }), 'validation');
      expect(calls).toHaveLength(0);
    });

    it('terminates active decode promptly when import is cancelled during admission', async () => {
      const controller = new AbortController();
      const { fetcher } = fetcherFor([{ body: png }]);
      setTimeout(() => {
        controller.abort();
      }, 10);
      await expectFailure(
        fetcher.fetchImage(IMAGE_URL, { signal: controller.signal }),
        'validation'
      );
    });

    it('removes queued decode work promptly when import is cancelled while queued', async () => {
      const limits = { minDimension: 32, maxDimension: 20_000, maxPixels: 40_000_000 };
      const hang1 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 500 }).catch(() => null);
      const hang2 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 500 }).catch(() => null);

      while (rasterDecoderState().active < 2) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const controller = new AbortController();
      const { fetcher } = fetcherFor([{ body: png }]);
      const queuedPromise = fetcher.fetchImage(IMAGE_URL, { signal: controller.signal });

      await new Promise((r) => setTimeout(r, 20));
      expect(rasterDecoderState().queued).toBeGreaterThanOrEqual(1);

      controller.abort();
      await expectFailure(queuedPromise, 'validation');
      expect(rasterDecoderState().queued).toBe(0);

      await Promise.all([hang1, hang2]);
    });

    it('removes queued decode work promptly when deadline expires while queued', async () => {
      const limits = { minDimension: 32, maxDimension: 20_000, maxPixels: 40_000_000 };
      const hang1 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 500 }).catch(() => null);
      const hang2 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 500 }).catch(() => null);

      while (rasterDecoderState().active < 2) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const { fetcher } = fetcherFor([{ body: png }]);
      const queuedPromise = fetcher.fetchImage(IMAGE_URL, { deadline: Date.now() + 50 });

      await new Promise((r) => setTimeout(r, 20));
      expect(rasterDecoderState().queued).toBeGreaterThanOrEqual(1);

      await expectFailure(queuedPromise, 'validation');
      expect(rasterDecoderState().queued).toBe(0);

      await Promise.all([hang1, hang2]);
    });

    it('does not renew the absolute deadline when a slot becomes available after expiration', async () => {
      const limits = { minDimension: 32, maxDimension: 20_000, maxPixels: 40_000_000 };
      const hang1 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 100 }).catch(() => null);
      const hang2 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 100 }).catch(() => null);

      while (rasterDecoderState().active < 2) {
        await new Promise((r) => { setTimeout(r, 5); });
      }

      const start = Date.now();
      const deadline = start + 50;
      const { fetcher } = fetcherFor([{ body: png }]);

      await expectFailure(
        fetcher.fetchImage(IMAGE_URL, { deadline }),
        'validation'
      );

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThanOrEqual(100);

      await Promise.all([hang1, hang2]);
      expect(rasterDecoderState().active).toBe(0);
      expect(rasterDecoderState().queued).toBe(0);
    });
  });
});
