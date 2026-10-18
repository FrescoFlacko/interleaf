import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * Format fixtures for the still-raster pipeline.
 *
 * The bytes were produced once by the approved decoder's own encoder family
 * (pinned sharp, ADR 0013) and stored as base64, so the specs exercise the
 * true decode path with real JPEG, GIF, WebP, and AVIF containers while no
 * test thread ever loads the decoder itself — only the isolated worker does,
 * and a test thread that has used libvips makes a later worker-thread decode
 * hang. Animation is the one thing the encoder will not write directly: the
 * animated GIF was assembled by splicing the encoder's own image blocks under
 * one header, and the animated WebP by wrapping its frame chunks in the
 * animation container. AVIF sequences cannot be produced here; the shared
 * page-count check they rely on is covered through GIF, WebP, and APNG.
 */

export type FormatFixtures = {
  readonly colourJpeg: Buffer;
  readonly progressiveJpeg: Buffer;
  readonly staticGif: Buffer;
  readonly staticWebp: Buffer;
  readonly staticAvif: Buffer;
  readonly animatedGif: Buffer;
  readonly animatedWebp: Buffer;
  readonly interlacedPng: Buffer;
};

// Playwright transpiles this module as CommonJS, where __dirname exists; the
// Vitest module graph is ESM, where the project root is the working directory.
const FIXTURE_DIRECTORY =
  typeof __dirname === 'string'
    ? join(__dirname, 'raster-format-fixtures')
    : join(process.cwd(), 'tests', 'fixtures', 'raster-format-fixtures');

function fixtureBuffer(name: string): Buffer {
  return Buffer.from(readFileSync(`${FIXTURE_DIRECTORY}/${name}.b64`, 'ascii').trim(), 'base64');
}

let cached: FormatFixtures | null = null;

export function rasterFormatFixtures(): FormatFixtures {
  cached ??= {
    colourJpeg: fixtureBuffer('colour-jpeg'),
    progressiveJpeg: fixtureBuffer('progressive-jpeg'),
    staticGif: fixtureBuffer('static-gif'),
    staticWebp: fixtureBuffer('static-webp'),
    staticAvif: fixtureBuffer('static-avif'),
    animatedGif: fixtureBuffer('animated-gif'),
    animatedWebp: fixtureBuffer('animated-webp'),
    interlacedPng: fixtureBuffer('interlaced-png'),
  };
  return cached;
}

export function truncatedJpeg(jpeg: Buffer): Buffer {
  return jpeg.subarray(0, Math.floor(jpeg.byteLength / 2));
}

export function jpegWithTrailingPayload(jpeg: Buffer): Buffer {
  return Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]);
}

export function gifWithTrailingPayload(gif: Buffer): Buffer {
  return Buffer.concat([gif, Buffer.from('TRAILING_DATA')]);
}

type CanonicalPng = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
  readonly channels: number;
  readonly sampleAt: (x: number, y: number) => readonly number[];
};

/**
 * Parses the canonical PNG bytes the validator archives.
 *
 * Canonical output is filter type 0 by construction, so any other first
 * scanline filter is a parse error rather than a silent misreading.
 */
export function readCanonicalPng(bytes: Buffer): CanonicalPng {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  let offset = 8;
  let header: { width: number; height: number; bitDepth: number; colourType: number } | null = null;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] ?? 0,
        colourType: data[9] ?? 0,
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    }
    offset += 12 + length;
  }
  if (header === null || idat.length === 0) throw new Error('incomplete PNG');
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[header.colourType] ?? 0;
  if (channels === 0 || header.bitDepth !== 8) throw new Error('unsupported canonical PNG');
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.byteLength !== (header.width * channels + 1) * header.height) {
    throw new Error('unexpected canonical raster size');
  }
  return {
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    colourType: header.colourType,
    channels,
    sampleAt: (x: number, y: number): readonly number[] => {
      const rowStart = y * (header.width * channels + 1);
      if (inflated[rowStart] !== 0) throw new Error('scanline is not canonically filtered');
      const start = rowStart + 1 + x * channels;
      return Array.from(inflated.subarray(start, start + channels));
    },
  };
}
