import { crc32 } from 'node:zlib';

/**
 * Adversarial containers the approved encoders will not write.
 *
 * Real animated WebP/GIF/AVIF sequences either exist as fixtures or cannot be
 * produced by the pinned encoder at all (AVIF sequences), so these helpers
 * assemble the borderline cases by structure: a one-frame animation, an
 * animation whose signalling bit was cleared, a looping single-frame GIF, a
 * multi-picture WebP, an AVIF sequence by branding or by movie box, and the
 * "image + junk + fake final sentinel" shapes the container walks must refuse.
 * Every helper only rearranges or appends framed structures and fixes the
 * container sizes it touches, so a refusal is about structure, not about
 * accidental byte corruption.
 */

type WebpChunk = { readonly id: string; readonly start: number; readonly end: number };

function webpChunks(bytes: Buffer): WebpChunk[] {
  const chunks: WebpChunk[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > bytes.length) break;
    chunks.push({ id, start: offset, end });
    offset = end;
  }
  return chunks;
}

function assembleWebp(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const file = Buffer.alloc(12 + body.length);
  file.write('RIFF', 0, 'latin1');
  file.writeUInt32LE(file.length - 8, 4);
  file.write('WEBP', 8, 'latin1');
  body.copy(file, 12);
  return file;
}

function webpChunkBytes(bytes: Buffer, chunk: WebpChunk): Buffer {
  return bytes.subarray(chunk.start, chunk.end);
}

/** A VP8X animation container with the animation bit still set but one frame. */
export function oneFrameAnimatedWebp(animatedWebp: Buffer): Buffer {
  const chunks = webpChunks(animatedWebp);
  const firstAnmf = chunks.find((chunk) => chunk.id === 'ANMF');
  const frame = firstAnmf === undefined ? [] : [webpChunkBytes(animatedWebp, firstAnmf)];
  const signalling = chunks
    .filter((chunk) => chunk.id === 'VP8X' || chunk.id === 'ANIM')
    .map((chunk) => webpChunkBytes(animatedWebp, chunk));
  return assembleWebp([...signalling, ...frame]);
}

/** An ANIM/ANMF container whose VP8X animation bit was cleared by one byte. */
export function webpAnmfWithoutAnimationBit(animatedWebp: Buffer): Buffer {
  const withoutBit = Buffer.from(animatedWebp);
  withoutBit.writeUInt8(0x00, 20);
  return withoutBit;
}

/** One RIFF/WEBP envelope carrying two still image chunks (multi-picture). */
export function webpWithTwoImageChunks(staticWebp: Buffer): Buffer {
  const chunks = webpChunks(staticWebp);
  const image = chunks.find((chunk) => chunk.id === 'VP8 ' || chunk.id === 'VP8L');
  const imageBytes = image === undefined ? [] : [webpChunkBytes(staticWebp, image)];
  const others = chunks
    .filter((chunk) => chunk !== image && chunk.id !== 'VP8X')
    .map((chunk) => webpChunkBytes(staticWebp, chunk));
  return assembleWebp([...imageBytes, ...imageBytes, ...others]);
}

/** An ISOBMFF `ftyp` whose major and compatible brands declare a sequence. */
export function avifImageSequenceFtyp(): Buffer {
  const ftyp = Buffer.alloc(28);
  ftyp.writeUInt32BE(28, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('avis', 8, 'latin1');
  ftyp.writeUInt32BE(0, 12);
  ftyp.write('avis', 16, 'latin1');
  ftyp.write('mif1', 20, 'latin1');
  ftyp.write('miaf', 24, 'latin1');
  return ftyp;
}

/** AVIF still branding plus a `moov` (movie) box: a sequence by structure. */
export function avifStillWithMovieBox(staticAvif: Buffer): Buffer {
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([staticAvif.subarray(0, 28), moov, staticAvif.subarray(28)]);
}

/** The static AVIF with its `mdat` re-declared through a 64-bit largesize. */
export function avifWithExtendedSizeMdat(staticAvif: Buffer): Buffer {
  const head = staticAvif.subarray(0, 242);
  const payload = staticAvif.subarray(250);
  const mdat = Buffer.alloc(16 + payload.length);
  mdat.writeUInt32BE(1, 0);
  mdat.write('mdat', 4, 'latin1');
  mdat.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  payload.copy(mdat, 16);
  return Buffer.concat([head, mdat]);
}

/** An AVIF whose declared largesize runs past the bytes provided. */
export function avifWithOverrunningExtendedSize(staticAvif: Buffer): Buffer {
  const head = staticAvif.subarray(0, 242);
  const mdat = Buffer.alloc(16);
  mdat.writeUInt32BE(1, 0);
  mdat.write('mdat', 4, 'latin1');
  mdat.writeBigUInt64BE(BigInt(16 + 4096), 8);
  return Buffer.concat([head, mdat]);
}

/** A complete PNG with one more chunk inserted after IHDR, CRC included. */
function pngWithInsertedChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

/**
 * A decodable PNG that merely contains the bytes "acTL" in an ordinary text
 * chunk — animation by string search, not by chunk structure.
 */
export function pngWithCtlTextChunk(png: Buffer): Buffer {
  return pngWithInsertedChunk(png, 'tEXt', Buffer.from('comment\x00seen: acTL elsewhere\x00', 'latin1'));
}

/** A valid PNG followed by junk and a fake, CRC-less IEND chunk. */
export function pngWithJunkBeforeFakeIend(png: Buffer): Buffer {
  const fakeIend = Buffer.alloc(12);
  fakeIend.writeUInt32BE(0, 0);
  fakeIend.write('IEND', 4, 'latin1');
  return Buffer.concat([png, Buffer.from('<script>alert(1)</script>', 'utf8'), fakeIend]);
}

/** A complete still JPEG followed by junk and a fake trailing EOI marker. */
export function jpegWithFakeFinalSentinel(jpeg: Buffer): Buffer {
  return Buffer.concat([jpeg, Buffer.from('TRAILING PAYLOAD', 'latin1'), Buffer.from([0xff, 0xd9])]);
}
export function gifWithLoopExtension(staticGif: Buffer, application = 'NETSCAPE2.0'): Buffer {
  const loop = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from(application, 'latin1'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);
  // The global colour table ends at 19 in the fixture: header (6) + logical
  // screen descriptor (7) + one 6-entry table.
  return Buffer.concat([staticGif.subarray(0, 19), loop, staticGif.subarray(19)]);
}

/** A TIFF header, which no approved raster format may borrow. */
export function tiffBytes(): Buffer {
  const tiff = Buffer.alloc(16);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  return tiff;
}

/** A PDF header, which no approved raster format may borrow. */
export function pdfBytes(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\n', 'latin1');
}
