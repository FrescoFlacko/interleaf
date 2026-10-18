import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';
import { InterleafError } from '@shared/errors/interleaf-error';
import { MAX_WEB_ARTICLE_URL_LENGTH } from '@shared/constants/web-article';
import { assertRequestUrl, toProvenanceUrl, type ValidatedRequestUrl } from './address-policy';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  PinnedHttpClient,
  failNetwork,
  headerValue,
  timedOut,
  type AddressResolver,
  type PinnedHopResult,
  type RequestFactory,
  type ResolvedAddress,
} from './pinned-http';
import type { FetchedWebPage, WebArticleTransport, WebArticleTransportOptions } from './web-article-transport';

/**
 * Bounded HTTP transport for public web articles.
 *
 * The socket-level defence — address policy on every hop, DNS pinning, wire and
 * time bounds, anonymous stateless requests, and Interleaf-owned agents that
 * ignore proxy environment variables — lives in `PinnedHttpClient`, which the
 * article media transport shares. What is specific to reading a page lives
 * here: following redirects with a full re-validation of each destination,
 * refusing anything that is not HTML, bounded decompression with a ratio cap
 * against decompression bombs, and charset-aware decoding.
 *
 * `lookupAddresses` and `requestFactory` are passed straight through to the
 * shared client as test seams. They do not relax any check.
 */

export type { RequestFactory, ResolvedAddress };

const MAX_REDIRECTS = 5;
const MAX_TRANSFER_BYTES = 5 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 12 * 1024 * 1024;
/**
 * How far a response is allowed to expand relative to what it cost to send.
 *
 * The absolute cap alone lets a few kilobytes on the wire become megabytes in
 * memory, which is the cheap half of a decompression bomb. Real HTML compresses
 * by roughly three to twenty times, so a page that expands fifty-fold is not a
 * page Interleaf needs to read.
 */
export const MAX_COMPRESSION_RATIO = 50;
/**
 * Below this, the ratio says nothing useful: a few hundred bytes of gzip
 * framing legitimately unpacks to several kilobytes of markup.
 */
const MIN_DECOMPRESSION_ALLOWANCE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = DEFAULT_FETCH_TIMEOUT_MS;
const CHARSET_SNIFF_BYTES = 2048;

const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  'text/html': true,
  'application/xhtml+xml': true,
};

export type WebArticleFetcherOptions = {
  readonly lookupAddresses?: AddressResolver;
  readonly requestFactory?: RequestFactory;
  readonly maxRedirects?: number;
  readonly maxTransferBytes?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
};

function assertHtmlContentType(response: IncomingMessage): void {
  const raw = headerValue(response, 'content-type');
  const essence = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ALLOWED_CONTENT_TYPES[essence] !== true) {
    failNetwork('That web address did not return an HTML page, so there is nothing to read.');
  }
}

function charsetFromContentType(response: IncomingMessage): string | null {
  const raw = headerValue(response, 'content-type');
  const match = /charset\s*=\s*"?([a-z0-9_:.+-]+)"?/i.exec(raw);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * A `<meta charset>` sniff over the ASCII prefix only. The bytes are never
 * interpreted as markup — this reads a label so the decoder produces the text
 * the author intended, and falls back to UTF-8 on anything unrecognized.
 */
function charsetFromMeta(body: Buffer): string | null {
  const prefix = body.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1');
  const direct = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i.exec(prefix);
  if (direct?.[1]) return direct[1].toLowerCase();
  const httpEquiv = /content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.+-]+)/i.exec(prefix);
  return httpEquiv?.[1]?.toLowerCase() ?? null;
}

function decodeBody(body: Buffer, label: string | null): string {
  const candidate = label ?? 'utf-8';
  try {
    return new TextDecoder(candidate, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/**
 * The most this response is allowed to become once decompressed: the absolute
 * ceiling, or what its own wire size justifies, whichever is smaller.
 */
function decompressionBudget(wireBytes: number): number {
  const ratioBudget = Math.max(
    wireBytes * MAX_COMPRESSION_RATIO,
    MIN_DECOMPRESSION_ALLOWANCE_BYTES
  );
  return Math.min(MAX_DECOMPRESSED_BYTES, ratioBudget);
}

/**
 * Bounded decompression. `maxOutputLength` makes zlib itself refuse to expand a
 * decompression bomb, so a small response can never turn into a large buffer.
 */
async function decompressAsync(
  body: Buffer,
  encoding: string,
  maxOutputBytes: number,
  remainingMs: number
): Promise<Buffer> {
  if (encoding === '' || encoding === 'identity') {
    if (body.byteLength > maxOutputBytes) {
      failNetwork('That page is too large for Interleaf to import.');
    }
    return body;
  }

  let decompressor: Transform;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decompressor = createGunzip({ maxOutputLength: maxOutputBytes });
  } else if (encoding === 'deflate') {
    decompressor = createInflate({ maxOutputLength: maxOutputBytes });
  } else if (encoding === 'br') {
    decompressor = createBrotliDecompress({ maxOutputLength: maxOutputBytes });
  } else {
    failNetwork('That website replied in a format Interleaf cannot read.');
  }

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      decompressor.destroy();
      reject(new InterleafError('validation', 'That page took too long to respond, so Interleaf stopped waiting.'));
    }, Math.max(remainingMs, 1));
    timer.unref();

    decompressor.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        decompressor.destroy();
        reject(new InterleafError('validation', 'That page is too large for Interleaf to import.'));
      } else {
        chunks.push(chunk);
      }
    });

    decompressor.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      decompressor.destroy();
      reject(new InterleafError('validation', 'That page is too large for Interleaf to import.'));
    });

    decompressor.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    decompressor.end(body);
  });
}

export class WebArticleFetcher implements WebArticleTransport {
  private readonly client: PinnedHttpClient;
  private readonly maxRedirects: number;
  private readonly timeoutMs: number;

  constructor(options: WebArticleFetcherOptions = {}) {
    this.maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.client = new PinnedHttpClient({
      ...(options.lookupAddresses !== undefined ? { lookupAddresses: options.lookupAddresses } : {}),
      ...(options.requestFactory !== undefined ? { requestFactory: options.requestFactory } : {}),
      accept: 'text/html,application/xhtml+xml',
      acceptEncoding: 'gzip, deflate, br',
      userAgent: options.userAgent ?? 'Interleaf (offline article reader)',
      maxTransferBytes: options.maxTransferBytes ?? MAX_TRANSFER_BYTES,
      validateResponse: assertHtmlContentType,
    });
  }

  async fetchArticleHtml(rawUrl: string, options?: WebArticleTransportOptions): Promise<FetchedWebPage> {
    const deadline = options?.deadline ?? (Date.now() + (options?.timeoutMs ?? this.timeoutMs));
    const signal = options?.signal;
    if (signal?.aborted) timedOut();
    let target = assertRequestUrl(rawUrl);

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const outcome = await this.client.performHop(target, deadline, signal);
      if (outcome.kind === 'body') {
        return await finishResponse(outcome, target, deadline, signal);
      }
      // Every redirect target is re-validated from scratch, including its
      // scheme, port, credentials, host shape, and resolved addresses.
      target = assertRequestUrl(new URL(outcome.location, target.url).toString());
    }

    throw new InterleafError(
      'security-violation',
      'That web address redirected too many times, so Interleaf stopped following it.'
    );
  }
}

async function finishResponse(
  outcome: Extract<PinnedHopResult, { kind: 'body' }>,
  target: ValidatedRequestUrl,
  deadline: number,
  signal?: AbortSignal
): Promise<FetchedWebPage> {
  if (signal?.aborted) timedOut();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) timedOut();
  const encoding = headerValue(outcome.response, 'content-encoding').trim().toLowerCase();
  const decoded = await decompressAsync(
    outcome.body,
    encoding,
    decompressionBudget(outcome.body.byteLength),
    remainingMs
  );
  const charset = charsetFromContentType(outcome.response) ?? charsetFromMeta(decoded);
  return {
    html: decodeBody(decoded, charset),
    finalUrl: toProvenanceUrl(target.url, MAX_WEB_ARTICLE_URL_LENGTH),
    transferredBytes: outcome.body.byteLength,
  };
}
