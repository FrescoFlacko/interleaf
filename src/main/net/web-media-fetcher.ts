import type { IncomingMessage } from 'node:http';
import { InterleafError } from '@shared/errors/interleaf-error';
import { MAX_WEB_ARTICLE_URL_LENGTH } from '@shared/constants/web-article';
import { assertRequestUrl, toProvenanceUrl } from './address-policy';
import {
  PinnedHttpClient,
  TransferBudget,
  failNetwork,
  headerValue,
  timedOut,
  type AddressResolver,
  type RequestFactory,
} from './pinned-http';
import {
  ARCHIVABLE_ACCEPT_HEADER,
  declaredTypeMatches,
  isArchivableDeclaredType,
  validateRasterImage,
  type RasterLimits,
} from './raster-image';
import type {
  FetchedWebMedia,
  WebMediaTransport,
  WebMediaTransportOptions,
} from './web-media-transport';

/**
 * Bounded HTTP transport for article images.
 *
 * It shares every socket-level control with the page fetcher through
 * `PinnedHttpClient`: address policy on the submitted URL and on each redirect
 * destination, DNS pinning against rebinding, wire and wall-clock bounds, and
 * anonymous stateless requests over Interleaf-owned agents that ignore proxy
 * environment variables. There is no second SSRF implementation to keep in
 * step, which is the point of the shared client.
 *
 * What is specific to media is admission. An image is archived only if the
 * response declares an archivable raster type, the bytes fully decode offline
 * in the isolated sharp worker (see `raster-image.ts`), the declared type
 * agrees with the format the decoder found, and the dimensions the validator
 * itself reports are within bounds. SVG and any other markup-shaped payload
 * cannot satisfy that decode, so vector and scriptable content is refused by
 * construction rather than by a blocklist.
 *
 * No response is ever decompressed here. Rasters are already compressed, so the
 * request does not offer a content encoding, and a server that applies one
 * anyway produces bytes that fail the signature check — which keeps the
 * decompression-bomb surface out of this path entirely.
 */

export const MAX_MEDIA_REDIRECTS = 3;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
/**
 * Decoded-pixel ceiling.
 *
 * A renderer allocates roughly four bytes per pixel, so this bounds memory at
 * about 160 MB for the worst accepted image regardless of how few bytes it took
 * to send — the half of an image bomb that a byte cap alone does not cover.
 */
const MAX_MEDIA_PIXELS = 40_000_000;
export const MAX_MEDIA_DIMENSION = 20_000;
/** Below this an image is an icon or a spacer, not an illustration. */
export const MIN_MEDIA_DIMENSION = 32;
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

/** The size policy the raster validator enforces on every archived image. */
const MEDIA_RASTER_LIMITS: RasterLimits = {
  minDimension: MIN_MEDIA_DIMENSION,
  maxDimension: MAX_MEDIA_DIMENSION,
  maxPixels: MAX_MEDIA_PIXELS,
};

export type WebMediaFetcherOptions = {
  readonly lookupAddresses?: AddressResolver;
  readonly requestFactory?: RequestFactory;
  readonly maxRedirects?: number;
  readonly maxTransferBytes?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
};

function assertImageContentType(response: IncomingMessage): void {
  if (!isArchivableDeclaredType(headerValue(response, 'content-type'))) {
    failNetwork('That image is not in a format Interleaf can store.');
  }
}

function rejectImage(): never {
  throw new InterleafError('validation', 'That image is not in a format Interleaf can store.');
}

/**
 * Turns validated bytes into a described asset, or refuses them.
 *
 * Exported because it is the whole admission decision for a downloaded image
 * and is worth testing directly against hostile buffers, without a socket.
 */
export type AdmitRasterOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
  readonly timeoutMs?: number | undefined;
};

export async function admitRasterBytes(
  bytes: Buffer,
  declaredType: string,
  maxBytes: number,
  options: AdmitRasterOptions = {}
): Promise<Omit<FetchedWebMedia, 'finalUrl'>> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) rejectImage();
  const format = await validateRasterImage(bytes, MEDIA_RASTER_LIMITS, {
    signal: options.signal,
    deadline: options.deadline,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: maxBytes,
  });
  if (format === null) rejectImage();
  if (!declaredTypeMatches(declaredType, format.sourceMimeType)) rejectImage();
  const finalBytes = format.safeBytes ?? bytes;
  if (finalBytes.byteLength > maxBytes) rejectImage();
  return {
    bytes: finalBytes,
    mimeType: format.mimeType,
    extension: format.extension,
    width: format.width,
    height: format.height,
  };
}

export class WebMediaFetcher implements WebMediaTransport {
  private readonly client: PinnedHttpClient;
  private readonly maxRedirects: number;
  private readonly maxTransferBytes: number;
  private readonly timeoutMs: number;

  constructor(options: WebMediaFetcherOptions = {}) {
    this.maxRedirects = options.maxRedirects ?? MAX_MEDIA_REDIRECTS;
    this.maxTransferBytes = options.maxTransferBytes ?? MAX_MEDIA_BYTES;
    this.timeoutMs = options.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS;
    this.client = new PinnedHttpClient({
      ...(options.lookupAddresses !== undefined ? { lookupAddresses: options.lookupAddresses } : {}),
      ...(options.requestFactory !== undefined ? { requestFactory: options.requestFactory } : {}),
      accept: ARCHIVABLE_ACCEPT_HEADER,
      // Rasters are already compressed; offering no encoding keeps the
      // decompression-bomb surface out of the media path entirely.
      acceptEncoding: 'identity',
      userAgent: options.userAgent ?? 'Interleaf (offline article reader)',
      maxTransferBytes: this.maxTransferBytes,
      validateResponse: assertImageContentType,
    });
  }

  async fetchImage(rawUrl: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia> {
    const signal = options?.signal;
    if (signal?.aborted) timedOut();
    // One image may never outlast the import that asked for it, and may never
    // hold a slot for longer than a single image is worth: whichever bound
    // expires first ends the fetch.
    const perImage = Date.now() + (options?.timeoutMs ?? this.timeoutMs);
    const deadline = options?.deadline === undefined ? perImage : Math.min(options.deadline, perImage);
    // The allowance the caller still has, never above this client's per-file
    // ceiling. One budget spans the whole redirect chain, so a server cannot
    // multiply its transfer by bouncing the request.
    const budget = new TransferBudget(
      Math.min(options?.maxTransferBytes ?? this.maxTransferBytes, this.maxTransferBytes)
    );

    try {
      return await this.followRedirects(rawUrl, deadline, budget, signal);
    } finally {
      // Reported on every path. A refused, oversized, or aborted image still
      // spent what it moved, so the caller refunds only the untouched part of
      // its reservation instead of handing the same bytes to the next image.
      options?.onWireBytes?.(budget.spent);
    }
  }

  private async followRedirects(
    rawUrl: string,
    deadline: number,
    budget: TransferBudget,
    signal: AbortSignal | undefined
  ): Promise<FetchedWebMedia> {
    let target = assertRequestUrl(rawUrl);

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const outcome = await this.client.performHop(target, deadline, signal, budget);
      if (outcome.kind === 'body') {
        const declared = headerValue(outcome.response, 'content-type');
        return {
          ...(await admitRasterBytes(outcome.body, declared, budget.limit, {
            signal,
            deadline,
          })),
          finalUrl: toProvenanceUrl(target.url, MAX_WEB_ARTICLE_URL_LENGTH),
        };
      }
      // Re-validated from scratch, exactly as the page fetcher does: scheme,
      // port, credentials, host shape, and resolved addresses.
      target = assertRequestUrl(new URL(outcome.location, target.url).toString());
    }

    throw new InterleafError(
      'security-violation',
      'That image redirected too many times, so Interleaf stopped following it.'
    );
  }
}
