import {
  decodeRasterInWorker,
  type RasterDecodeWorkerOptions,
} from '../workers/raster-decode-worker';

/**
 * Format admission for downloaded article images.
 *
 * Everything here reads a byte buffer that came off the network and decides
 * whether it is a still raster the reader can safely display. Admission is not
 * a header peek: every byte of the response has to belong to a container an
 * isolated worker handed to the pinned sharp decoder (ADR 0013), which decodes
 * the full raster offline and reports the format, the frame count, and the
 * dimensions from that decode rather than from the first field a server chose
 * to write. Accepted pixels are re-encoded to deterministic canonical PNG
 * before archiving, so nothing else from the original container survives.
 *
 * The declared `Content-Type` is never trusted on its own. A server can label
 * an SVG — which is a scriptable document — as `image/png`, so the format is
 * decided by the bytes and the declared type only has to agree. Vector and
 * markup-shaped payloads have no structure that can match, so they are rejected
 * by construction rather than by a blocklist.
 *
 * Format support is the set of still rasters ADR 0013 approved for the pinned
 * sharp decoder: PNG, JPEG, WebP, GIF, and AVIF, still images only. Animated
 * or multi-frame input is refused before archiving rather than silently
 * flattened to its first frame.
 */


export type RasterFormat = {
  /** What the archived bytes are: canonical PNG for every accepted format. */
  readonly mimeType: string;
  /** What the submitted bytes were, as decided by the decoder. */
  readonly sourceMimeType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  readonly safeBytes?: Buffer;
};

/**
 * Size policy the caller enforces, applied inside validation rather than after.
 *
 * The order matters: a header claiming 30000×30000 is refused *before* its image
 * data is inflated, so an oversized declaration cannot make Interleaf stream
 * gigabytes of decompressed output just to discover it was too big.
 */
export type RasterLimits = {
  readonly minDimension: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
  readonly maxDecompressedBytes?: number;
};

export async function validateRasterImage(
  bytes: Buffer,
  limits: RasterLimits,
  options?: RasterDecodeWorkerOptions
): Promise<RasterFormat | null> {
  const result = await decodeRasterInWorker(bytes, limits, options);
  if (result === null) return null;
  return {
    mimeType: result.mimeType,
    sourceMimeType: result.sourceMimeType,
    extension: result.extension,
    width: result.width,
    height: result.height,
    safeBytes: result.safeBytes,
  };
}
/**
 * Content types a response may declare for an archivable raster.
 *
 * The value is the format the decoder must report for that declaration to be
 * honest. `image/jpg` is not a registered type but is common enough on real
 * servers that refusing it would drop ordinary article images.
 */
const DECLARED_TYPE_TO_MIME: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
  'image/avif': 'image/avif',
};

/**
 * True when a declared content type is an archivable raster type at all.
 *
 * This runs on the response header before a body byte is buffered, so an
 * `image/svg+xml`, `text/html`, or `application/octet-stream` reply costs
 * nothing beyond the headers.
 */
export function isArchivableDeclaredType(declared: string): boolean {
  const essence = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return DECLARED_TYPE_TO_MIME[essence] !== undefined;
}

/**
 * True when the decoded format is the one the server declared.
 *
 * The comparison is against the format the decoder found in the bytes, not
 * against the format the archived copy is stored as — every accepted image is
 * canonicalized to PNG, so comparing against storage would let a server label
 * anything `image/png` and be believed.
 */
export function declaredTypeMatches(declared: string, sniffed: string): boolean {
  const essence = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return DECLARED_TYPE_TO_MIME[essence] === sniffed;
}

/** The `Accept` header the media fetcher offers, matching what it will admit. */
export const ARCHIVABLE_ACCEPT_HEADER =
  'image/png,image/jpeg,image/webp,image/gif,image/avif';
