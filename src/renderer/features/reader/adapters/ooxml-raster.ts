/**
 * Structural classification of package-internal still images shared by the
 * DOCX and PPTX parsers. Only static PNG, JPEG, GIF and WebP within the pixel
 * budget are accepted; animated images and anything unrecognized are refused.
 */
export const OOXML_MAX_IMAGE_DIMENSION = 16_384;
export const OOXML_MAX_IMAGE_PIXELS = 32 * 1024 * 1024;

type RasterGeometry = { readonly width: number; readonly height: number };
export type RasterInfo = RasterGeometry & { readonly mime: string };

function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (byteAt(bytes, offset) * 0x1000000) +
    (byteAt(bytes, offset + 1) << 16) +
    (byteAt(bytes, offset + 2) << 8) +
    byteAt(bytes, offset + 3)
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

function validRasterGeometry(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= OOXML_MAX_IMAGE_DIMENSION && height <= OOXML_MAX_IMAGE_DIMENSION &&
    width * height <= OOXML_MAX_IMAGE_PIXELS;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' && ascii(bytes, 12, 16) === 'IHDR';
}

function pngIsAnimated(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (!Number.isSafeInteger(length) || offset + 12 + length > bytes.length || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function inspectPng(bytes: Uint8Array): RasterInfo | null {
  if (pngIsAnimated(bytes)) return null;
  return { mime: 'image/png', width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(bytes: Uint8Array): RasterInfo | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = byteAt(bytes, offset++);
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = readUint16Be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_SOF_MARKERS.has(marker) && length >= 7) {
      return { mime: 'image/jpeg', height: readUint16Be(bytes, offset + 3), width: readUint16Be(bytes, offset + 5) };
    }
    offset += length;
  }
  return null;
}

function isGif(bytes: Uint8Array): boolean {
  const signature = ascii(bytes, 0, 6);
  return signature === 'GIF87a' || signature === 'GIF89a';
}

/** Size in bytes of a GIF color table flagged by a packed field, or 0 when absent. */
function colorTableSize(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1));
}

/** Returns the offset after a GIF sub-block chain, or `null` when it is truncated. */
function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < bytes.length) {
    const size = byteAt(bytes, offset++);
    if (size === 0) return offset;
    if (offset + size > bytes.length) return null;
    offset += size;
  }
  return null;
}

/** Returns the offset after one GIF extension block, or `null` when it is truncated. */
function skipGifExtension(bytes: Uint8Array, offset: number): number | null {
  return offset >= bytes.length ? null : skipGifSubBlocks(bytes, offset + 1);
}

/** Returns the offset after one GIF image descriptor and its data, or `null` when it is truncated. */
function skipGifFrame(bytes: Uint8Array, start: number): number | null {
  if (start + 9 > bytes.length) return null;
  const offset = start + 9 + colorTableSize(byteAt(bytes, start + 8));
  return offset >= bytes.length ? null : skipGifSubBlocks(bytes, offset + 1);
}

function inspectGif(bytes: Uint8Array): RasterInfo | null {
  if (bytes.length < 14) return null;
  let offset: number | null = 13 + colorTableSize(byteAt(bytes, 10));
  let frames = 0;
  while (offset !== null && offset < bytes.length) {
    const marker = byteAt(bytes, offset);
    if (marker === 0x3b) {
      return frames === 1 ? { mime: 'image/gif', width: readUint16Le(bytes, 6), height: readUint16Le(bytes, 8) } : null;
    }
    if (marker === 0x21) {
      offset = skipGifExtension(bytes, offset + 1);
      continue;
    }
    frames += 1;
    if (marker !== 0x2c || frames > 1) return null;
    offset = skipGifFrame(bytes, offset + 1);
  }
  return null;
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
}

function webpExtendedGeometry(bytes: Uint8Array): RasterGeometry | null {
  if ((byteAt(bytes, 20) & 0x02) !== 0) return null;
  return {
    width: 1 + byteAt(bytes, 24) + (byteAt(bytes, 25) << 8) + (byteAt(bytes, 26) << 16),
    height: 1 + byteAt(bytes, 27) + (byteAt(bytes, 28) << 8) + (byteAt(bytes, 29) << 16),
  };
}

function webpLossyGeometry(bytes: Uint8Array): RasterGeometry | null {
  if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
  return { width: readUint16Le(bytes, 26) & 0x3fff, height: readUint16Le(bytes, 28) & 0x3fff };
}

function webpLosslessGeometry(bytes: Uint8Array): RasterGeometry | null {
  if (bytes[20] !== 0x2f) return null;
  return {
    width: 1 + byteAt(bytes, 21) + ((byteAt(bytes, 22) & 0x3f) << 8),
    height: 1 + ((byteAt(bytes, 22) >> 6) | (byteAt(bytes, 23) << 2) | ((byteAt(bytes, 24) & 0x0f) << 10)),
  };
}

const WEBP_CHUNK_GEOMETRY: ReadonlyMap<string, (bytes: Uint8Array) => RasterGeometry | null> = new Map([
  ['VP8X', webpExtendedGeometry],
  ['VP8 ', webpLossyGeometry],
  ['VP8L', webpLosslessGeometry],
]);

function inspectWebp(bytes: Uint8Array): RasterInfo | null {
  const geometry = WEBP_CHUNK_GEOMETRY.get(ascii(bytes, 12, 16))?.(bytes) ?? null;
  return geometry ? { mime: 'image/webp', ...geometry } : null;
}

const RASTER_INSPECTORS: readonly {
  readonly matches: (bytes: Uint8Array) => boolean;
  readonly inspect: (bytes: Uint8Array) => RasterInfo | null;
}[] = [
  { matches: isPng, inspect: inspectPng },
  { matches: isJpeg, inspect: inspectJpeg },
  { matches: isGif, inspect: inspectGif },
  { matches: isWebp, inspect: inspectWebp },
];

/** Structural classification of a static PNG/JPEG/GIF/WebP; anything else is `null`. */
export function inspectRaster(bytes: Uint8Array): RasterInfo | null {
  for (const inspector of RASTER_INSPECTORS) {
    const result = inspector.matches(bytes) ? inspector.inspect(bytes) : null;
    if (result) return validRasterGeometry(result.width, result.height) ? result : null;
  }
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
