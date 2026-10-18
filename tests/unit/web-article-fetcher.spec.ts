import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import http, { createServer, type IncomingMessage, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  MAX_COMPRESSION_RATIO,
  MAX_DECOMPRESSED_BYTES,
  WebArticleFetcher,
  type RequestFactory,
  type ResolvedAddress,
} from '@main/net/web-article-fetcher';

/**
 * Transport-level tests for the bounded fetcher.
 *
 * The socket is scripted rather than real: no test here contacts a network, and
 * the injected factory only replaces the wire. Address validation, redirect
 * revalidation, DNS pinning, and every bound run exactly as they do in
 * production, which is the point — the assertions are about the checks, not
 * about the fake.
 */

const PUBLIC_ADDRESS: ResolvedAddress = { address: '93.184.216.34', family: 4 };

type ScriptedResponse = {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer | string;
  /** Emits no response at all, so only the deadline can end the request. */
  readonly silent?: boolean;
  /** Emits a socket-level failure instead of a response. */
  readonly failure?: boolean;
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
  response.headers = {
    'content-type': 'text/html; charset=utf-8',
    ...(spec.headers ?? {}),
  };
  return response;
}

/**
 * Drives the fetcher through a fixed sequence of hops and records what it asked
 * the transport to do.
 */
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
      if (spec.failure === true) {
        self.emit('error', new Error('socket failure'));
        return;
      }
      const response = buildResponse(spec);
      self.emit('response', response);
      // Pushed after the emit returns, because the fetcher attaches its body
      // listeners synchronously while handling the response event.
      const body = spec.body ?? '';
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      if (buffer.byteLength > 0) response.push(buffer);
      response.push(null);
    });
  };
  return { factory, calls };
}

function resolverReturning(...batches: readonly (readonly ResolvedAddress[])[]): {
  readonly lookupAddresses: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly hostnames: string[];
} {
  const hostnames: string[] = [];
  let index = 0;
  return {
    hostnames,
    lookupAddresses: (hostname) => {
      hostnames.push(hostname);
      const batch = batches[Math.min(index, batches.length - 1)] ?? [PUBLIC_ADDRESS];
      index += 1;
      return Promise.resolve(batch);
    },
  };
}

function fetcherFor(
  script: readonly ScriptedResponse[],
  overrides: {
    readonly addresses?: readonly (readonly ResolvedAddress[])[];
    readonly maxRedirects?: number;
    readonly maxTransferBytes?: number;
    readonly timeoutMs?: number;
  } = {}
): {
  readonly fetcher: WebArticleFetcher;
  readonly calls: RecordedCall[];
  readonly hostnames: string[];
} {
  const { factory, calls } = scriptTransport(script);
  const resolver = resolverReturning(...(overrides.addresses ?? [[PUBLIC_ADDRESS]]));
  const fetcher = new WebArticleFetcher({
    requestFactory: factory,
    lookupAddresses: resolver.lookupAddresses,
    ...(overrides.maxRedirects !== undefined ? { maxRedirects: overrides.maxRedirects } : {}),
    ...(overrides.maxTransferBytes !== undefined
      ? { maxTransferBytes: overrides.maxTransferBytes }
      : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  return { fetcher, calls, hostnames: resolver.hostnames };
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

describe('WebArticleFetcher', () => {
  describe('successful fetch', () => {
    it('returns decoded HTML, the final URL, and the transferred size', async () => {
      const { fetcher } = fetcherFor([{ body: '<html><body><p>Hello</p></body></html>' }]);
      const page = await fetcher.fetchArticleHtml('https://example.com/article');
      expect(page.html).toContain('<p>Hello</p>');
      expect(page.finalUrl).toBe('https://example.com/article');
      expect(page.transferredBytes).toBeGreaterThan(0);
    });

    it('decodes Windows-1252 when declared in the Content-Type header', async () => {
      // 0x93 and 0x94 are smart quotes in Windows-1252.
      const raw = Buffer.from([0x93, 0x68, 0x69, 0x94]);
      const { fetcher } = fetcherFor([
        {
          headers: { 'content-type': 'text/html; charset=windows-1252' },
          body: raw,
        },
      ]);
      const page = await fetcher.fetchArticleHtml('https://example.com/article');
      expect(page.html).toBe('“hi”');
    });

    it('sniffs charset from a <meta> tag when the header has none', async () => {
      const html = '<!doctype html><meta charset="iso-8859-1"><p>Caf\xe9</p>';
      const { fetcher } = fetcherFor([
        {
          headers: { 'content-type': 'text/html' },
          body: Buffer.from(html, 'latin1'),
        },
      ]);
      const page = await fetcher.fetchArticleHtml('https://example.com/article');
      expect(page.html).toContain('Café');
    });

    it('sends no authorization, cookie, or referrer header', async () => {
      const { fetcher, calls } = fetcherFor([{ body: '<html><body><p>Hi</p></body></html>' }]);
      await fetcher.fetchArticleHtml('https://example.com/article');
      const headers = calls[0]?.options.headers as Record<string, string>;
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
    });
  });

  describe('DNS pinning', () => {
    it('pins the validated address onto the connection instead of resolving again', async () => {
      const { fetcher, calls } = fetcherFor([{ body: '<html><body><p>Hi</p></body></html>' }]);
      await fetcher.fetchArticleHtml('https://example.com/a');

      const lookup = calls[0]?.options.lookup;
      expect(typeof lookup).toBe('function');

      // The socket layer's only route to an address is this hook, and the hook
      // is a constant: a resolver that starts answering with a private address
      // after the check has nothing left to influence.
      const single = await new Promise<[string, number]>((resolve) => {
        lookup?.('example.com', {}, (_error, address, family) => {
          if (typeof address === 'string' && typeof family === 'number') {
            resolve([address, family]);
          }
        });
      });
      expect(single).toEqual(['93.184.216.34', 4]);

      const all = await new Promise<string | readonly LookupAddress[]>((resolve) => {
        lookup?.('example.com', { all: true }, (_error, addresses) => {
          resolve(addresses);
        });
      });
      expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });

    it('rejects when any answer for the host is private, not just the first', async () => {
      const { fetcher } = fetcherFor([{ body: '<html><body><p>Hi</p></body></html>' }], {
        addresses: [[PUBLIC_ADDRESS, { address: '169.254.169.254', family: 4 }]],
      });
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'security-violation');
    });

    it('rejects when the resolver answers only with a private address', async () => {
      const { fetcher, calls } = fetcherFor([{ body: '<html><body><p>Hi</p></body></html>' }], {
        addresses: [[{ address: '10.1.2.3', family: 4 }]],
      });
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'security-violation');
      // No connection was ever attempted.
      expect(calls).toHaveLength(0);
    });

    it('rejects when the host resolves to nothing', async () => {
      const { fetcher } = fetcherFor([{ body: '<html><body><p>Hi</p></body></html>' }], {
        addresses: [[]],
      });
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
    });

    it('re-resolves and re-pins for each redirect hop', async () => {
      const { fetcher, calls, hostnames } = fetcherFor(
        [
          { status: 302, headers: { location: 'https://other.example.org/final' } },
          { body: '<html><body><p>Final</p></body></html>' },
        ],
        { addresses: [[PUBLIC_ADDRESS], [{ address: '8.8.8.8', family: 4 }]] }
      );
      const page = await fetcher.fetchArticleHtml('https://example.com/a');
      expect(page.finalUrl).toBe('https://other.example.org/final');
      expect(hostnames).toEqual(['example.com', 'other.example.org']);

      const secondLookup = calls[1]?.options.lookup;
      const pinned = await new Promise<string>((resolve) => {
        secondLookup?.('other.example.org', {}, (_error, address) => {
          if (typeof address === 'string') {
            resolve(address);
          }
        });
      });
      expect(pinned).toBe('8.8.8.8');
    });
  });

  describe('redirects', () => {
    it('revalidates a redirect into private space and refuses it', async () => {
      for (const location of [
        'http://127.0.0.1/admin',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/admin',
        'https://example.com:8080/a',
        'file:///etc/passwd',
        'https://user:pw@example.com/a',
      ]) {
        const { fetcher } = fetcherFor([
          { status: 302, headers: { location } },
          { body: '<html><body><p>should never be reached</p></body></html>' },
        ]);
        await expectFailure(
          fetcher.fetchArticleHtml('https://example.com/a'),
          'security-violation'
        );
      }
    });

    it('resolves a relative redirect against the current hop', async () => {
      const { fetcher } = fetcherFor([
        { status: 301, headers: { location: '/moved/here' } },
        { body: '<html><body><p>Arrived</p></body></html>' },
      ]);
      const page = await fetcher.fetchArticleHtml('https://example.com/a/b');
      expect(page.finalUrl).toBe('https://example.com/moved/here');
    });

    it('stops after the redirect budget', async () => {
      const { fetcher, calls } = fetcherFor(
        [{ status: 302, headers: { location: 'https://example.com/loop' } }],
        { maxRedirects: 2 }
      );
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'security-violation');
      expect(calls).toHaveLength(3);
    });

    it('rejects a redirect with no location', async () => {
      const { fetcher } = fetcherFor([{ status: 302 }]);
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
    });
  });

  describe('response bounds', () => {
    it('rejects a non-HTML content type', async () => {
      for (const contentType of [
        'application/json',
        'text/plain',
        'application/pdf',
        'application/octet-stream',
        'text/html-ish',
      ]) {
        const { fetcher } = fetcherFor([
          { headers: { 'content-type': contentType }, body: '<html><body>x</body></html>' },
        ]);
        await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
      }
    });

    it('accepts XHTML as well as HTML', async () => {
      const { fetcher } = fetcherFor([
        {
          headers: { 'content-type': 'application/xhtml+xml' },
          body: '<html><body><p>Hi</p></body></html>',
        },
      ]);
      await expect(fetcher.fetchArticleHtml('https://example.com/a')).resolves.toBeDefined();
    });

    it('rejects a response with no content type at all', async () => {
      const { fetcher } = fetcherFor([{ headers: { 'content-type': '' }, body: '<html></html>' }]);
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
    });

    it('rejects an oversized declared content length before reading a body', async () => {
      const { fetcher } = fetcherFor(
        [{ headers: { 'content-length': '99999999' }, body: 'x' }],
        { maxTransferBytes: 1024 }
      );
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
    });

    it('stops reading a body that exceeds the transfer budget', async () => {
      const { fetcher } = fetcherFor([{ body: Buffer.alloc(4096, 0x61) }], {
        maxTransferBytes: 1024,
      });
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/a'),
        'validation'
      );
      expect(error.message).toContain('too large');
    });

    it('refuses a compressed body that would expand past the decompression budget', async () => {
      const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024, 0x20));
      const { fetcher } = fetcherFor([
        { headers: { 'content-encoding': 'gzip' }, body: bomb },
      ]);
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/a'),
        'validation'
      );
      expect(error.message).toContain('too large');
    });

    it('refuses a body that expands far beyond what it cost to send', async () => {
      // Well under the absolute decompressed ceiling, so only the ratio can
      // catch it: a couple of kilobytes on the wire becoming two megabytes.
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x20);
      const bomb = gzipSync(payload);
      expect(bomb.byteLength * MAX_COMPRESSION_RATIO).toBeLessThan(payload.byteLength);
      expect(payload.byteLength).toBeLessThan(MAX_DECOMPRESSED_BYTES);
      const { fetcher } = fetcherFor([
        { headers: { 'content-encoding': 'gzip' }, body: bomb },
      ]);
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/a'),
        'validation'
      );
      expect(error.message).toContain('too large');
    });

    it('still allows a small page to expand by the fixed allowance', async () => {
      // A short document compresses to almost nothing, so its ratio is wild
      // while its size is trivial. The floor is what keeps that readable.
      const html = `<html><body>${'<p>Readable prose.</p>'.repeat(200)}</body></html>`;
      expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(64 * 1024);
      const { fetcher } = fetcherFor([
        { headers: { 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(html, 'utf8')) },
      ]);
      const page = await fetcher.fetchArticleHtml('https://example.com/a');
      expect(page.html).toBe(html);
    });

    it('decompresses a well-behaved gzip body', async () => {
      const html = '<html><body><p>Compressed</p></body></html>';
      const { fetcher } = fetcherFor([
        { headers: { 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(html, 'utf8')) },
      ]);
      const page = await fetcher.fetchArticleHtml('https://example.com/a');
      expect(page.html).toBe(html);
    });

    it('rejects an unsupported content encoding', async () => {
      const { fetcher } = fetcherFor([
        { headers: { 'content-encoding': 'exotic' }, body: '<html></html>' },
      ]);
      await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
    });

    it('rejects a non-success status', async () => {
      for (const status of [400, 401, 403, 404, 500, 503]) {
        const { fetcher } = fetcherFor([{ status, body: '<html></html>' }]);
        await expectFailure(fetcher.fetchArticleHtml('https://example.com/a'), 'validation');
      }
    });
  });

  describe('time and failure bounds', () => {
    it('gives up on a server that never responds', async () => {
      const { fetcher } = fetcherFor([{ silent: true }], { timeoutMs: 30 });
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/a'),
        'validation'
      );
      expect(error.message).toContain('too long');
    });

    it('reports a socket failure without leaking its detail', async () => {
      const { fetcher } = fetcherFor([{ failure: true }]);
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/a'),
        'validation'
      );
      expect(error.message).toBe('Interleaf could not reach that website.');
      expect(error.message).not.toContain('socket failure');
    });

    it('rejects a blocked submitted URL before opening any connection', async () => {
      const { fetcher, calls, hostnames } = fetcherFor([{ body: '<html></html>' }]);
      await expectFailure(
        fetcher.fetchArticleHtml('http://localhost/secret'),
        'security-violation'
      );
      expect(calls).toHaveLength(0);
      expect(hostnames).toHaveLength(0);
    });

    it('aborts and times out when DNS lookup stalls', async () => {
      const fetcher = new WebArticleFetcher({
        timeoutMs: 40,
        lookupAddresses: () => new Promise<readonly ResolvedAddress[]>(() => {
          // Intentionally unresolved promise simulating stalled DNS
        }),
      });
      const error = await expectFailure(
        fetcher.fetchArticleHtml('https://example.com/stalled-dns'),
        'validation'
      );
      expect(error.message).toContain('too long');
    });

    it('destroys redirect response immediately without draining endless body', async () => {
      let redirectResponseDestroyed = false;
      let firstHop = true;
      const fetcher = new WebArticleFetcher({
        lookupAddresses: () => Promise.resolve([PUBLIC_ADDRESS]),
        requestFactory: () => {
          if (firstHop) {
            firstHop = false;
            return new FakeRequest((self) => {
              const stream = new Readable({
                read() {
                  this.push(Buffer.from('infinite redirect data...'));
                },
                destroy(err, cb) {
                  redirectResponseDestroyed = true;
                  cb(err);
                },
              });
              const response = stream as IncomingMessage & { statusCode: number };
              response.statusCode = 302;
              response.headers = {
                location: 'https://example.com/final',
                'content-type': 'text/html',
              };
              self.emit('response', response);
            });
          }
          return new FakeRequest((self) => {
            const response = buildResponse({ body: '<html>final</html>' });
            self.emit('response', response);
            response.push(Buffer.from('<html>final</html>'));
            response.push(null);
          });
        },
      });

      const result = await fetcher.fetchArticleHtml('https://example.com/start');
      expect(result.html).toBe('<html>final</html>');
      expect(redirectResponseDestroyed).toBe(true);
    });

    it('uses explicit non-proxy agent and pinned lookup even if environment proxies are set', async () => {
      let proxyHit = false;
      const proxyServer = createServer((_req, res) => {
        proxyHit = true;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>hostile proxy</html>');
      });
      await new Promise<void>((resolve) => {
        proxyServer.listen(0, '127.0.0.1', () => { resolve(); });
      });
      const port = (proxyServer.address() as AddressInfo).port;

      const prevEnvProxy = process.env.NODE_USE_ENV_PROXY;
      const prevHttpProxy = process.env.HTTP_PROXY;
      process.env.NODE_USE_ENV_PROXY = '1';
      process.env.HTTP_PROXY = `http://127.0.0.1:${String(port)}`;

      try {
        let pinnedLookupUsed = false;
        const fetcher = new WebArticleFetcher({
          lookupAddresses: () => Promise.resolve([PUBLIC_ADDRESS]),
          requestFactory: (_url, options) => {
            expect(options.agent).toBeDefined();
            return new FakeRequest((self) => {
              options.lookup?.('example.com', {}, () => {
                pinnedLookupUsed = true;
              });
              const response = buildResponse({ body: '<html><article><p>Direct article content</p></article></html>' });
              self.emit('response', response);
              response.push(Buffer.from('<html><article><p>Direct article content</p></article></html>'));
              response.push(null);
            });
          },
        });

        const page = await fetcher.fetchArticleHtml('http://example.com/article');
        expect(page.html).toContain('Direct article content');
        expect(proxyHit).toBe(false);
        expect(pinnedLookupUsed).toBe(true);
      } finally {
        if (prevEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
        else process.env.NODE_USE_ENV_PROXY = prevEnvProxy;
        if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = prevHttpProxy;
        await new Promise<void>((resolve) => {
          proxyServer.close(() => { resolve(); });
        });
      }
    });

    it('fails closed against loopback fixtures directly and never connects to the server', async () => {
      let serverHit = false;
      const server = createServer((_req, res) => {
        serverHit = true;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>payload</html>');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => { resolve(); });
      });
      const port = (server.address() as AddressInfo).port;
      try {
        const fetcher = new WebArticleFetcher();
        await expect(
          fetcher.fetchArticleHtml(`http://127.0.0.1:${String(port)}/article`)
        ).rejects.toMatchObject({ code: 'security-violation' });

        expect(serverHit).toBe(false);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => { resolve(); });
        });
      }
    });

    it('handles real HTTP server with chunked transfer and redirect', async () => {
      let redirectCount = 0;
      const server = createServer((req, res) => {
        if (req.url === '/initial') {
          redirectCount += 1;
          res.writeHead(302, { location: '/final', 'content-type': 'text/html' });
          res.end();
          return;
        }
        if (req.url === '/final') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.write('<html><head><title>Chunked Article</title></head>');
          setTimeout(() => {
            res.write('<body><article><p>First chunk of text content. ');
            res.write('Second chunk of readable text.</p></article></body></html>');
            res.end();
          }, 10);
          return;
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => { resolve(); });
      });
      const port = (server.address() as AddressInfo).port;

      try {
        // Lookup returns public address for security validation, and socket lookup connects to port
        const fetcher = new WebArticleFetcher({
          lookupAddresses: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
          requestFactory: (url, options) => {
            return http.request(url, {
              ...options,
              hostname: '127.0.0.1',
              port,
              lookup: undefined, // connect to local test server
            });
          },
        });

        const result = await fetcher.fetchArticleHtml('http://example.com/initial');
        expect(redirectCount).toBe(1);
        expect(result.html).toContain('Chunked Article');
        expect(result.html).toContain('First chunk of text content');
        expect(result.html).toContain('Second chunk of readable text');
        expect(result.transferredBytes).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => { resolve(); });
        });
      }
    });
  });
});
