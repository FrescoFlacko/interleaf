import { beforeAll, describe, expect, it } from 'vitest';
import { validateRasterImage, type RasterLimits } from '@main/net/raster-image';
import { rasterDecoderState } from '@main/workers/raster-decode-worker';
import {
  HTML_BYTES,
  makeAdversarialEmptyPaletteIndexedPng,
  makeAvifHeader,
  makeAdversarialMinimalJpeg,
  makeAnimatedPng,
  makeCorruptedPng,
  makeGifHeader,
  makeGrayscalePng,
  makeGrayscalePngWithTrns,
  makeIndexedPng,
  makeIndexedPngWithExcessPalette,
  makeIndexedPngWithTrns,
  makeInflatingPng,
  makeMalformedInterlacedPng,
  makeJpeg,
  makeJpegHeader,
  makeMismatchedPng,
  makePng,
  makePngHeader,
  makePngWithMalformedTrns,
  makeRgbaPng,
  makeTruncatedPng,
  makeTruecolourPngWithTrns,
  makeWebpHeader,
  SVG_BYTES,
} from '../fixtures/raster-fixtures';
import {
  gifWithTrailingPayload,
  jpegWithTrailingPayload,
  type FormatFixtures,
  rasterFormatFixtures,
  readCanonicalPng,
  truncatedJpeg,
} from '../fixtures/extended-raster-fixtures';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * The raster validator, on its own.
 *
 * This is the boundary that decides whether attacker-supplied bytes become a
 * file in the user's library, so the fixtures here are the hostile ones: files
 * whose header describes something other than what follows it, files that stop
 * halfway, animations, adversarial format reproductions that fool header
 * checkers but crash decoders, and containers whose payload this process has no
 * way to check.
 */

const limits: RasterLimits = { minDimension: 32, maxDimension: 20_000, maxPixels: 40_000_000 };

describe('validateRasterImage', () => {
  let formats: FormatFixtures;
  beforeAll(() => {
    formats = rasterFormatFixtures();
  });

  it('accepts real, decodable PNGs across supported color types and reports decoder dimensions', async () => {
    // 8-bit RGB truecolour, indexed with a valid palette, grayscale, and RGBA.
    for (const png of [makePng(64, 48), makeIndexedPng(64, 48), makeGrayscalePng(64, 48), makeRgbaPng(64, 48)]) {
      const result = await validateRasterImage(png, limits);
      expect(result).toMatchObject({
        mimeType: 'image/png',
        extension: '.png',
        width: 64,
        height: 48,
      });
      expect(result?.safeBytes).toBeDefined();
    }
  });

  describe('adversarial reproductions', () => {
    it('refuses adversarial reproduction 1: CRC-valid indexed PNG with an empty PLTE', async () => {
      // macOS ImageIO rejects this because indexed color cannot decode without palette entries.
      const hostilePng = makeAdversarialEmptyPaletteIndexedPng(64, 48);
      await expect(validateRasterImage(hostilePng, limits)).resolves.toBeNull();
    });
  });

  it('decodes every approved still format and reports the source format it decoded', async () => {
    const cases = [
      { bytes: makePng(64, 48), sourceMimeType: 'image/png' },
      { bytes: makeJpeg(64, 48), sourceMimeType: 'image/jpeg' },
      { bytes: formats.colourJpeg, sourceMimeType: 'image/jpeg' },
      { bytes: formats.staticGif, sourceMimeType: 'image/gif' },
      { bytes: formats.staticWebp, sourceMimeType: 'image/webp' },
      { bytes: formats.staticAvif, sourceMimeType: 'image/avif' },
    ] as const;
    for (const testCase of cases) {
      const result = await validateRasterImage(Buffer.from(testCase.bytes), limits);
      expect(result, testCase.sourceMimeType).toMatchObject({
        mimeType: 'image/png',
        sourceMimeType: testCase.sourceMimeType,
        extension: '.png',
        width: 64,
        height: 48,
      });
      expect(result?.safeBytes).toBeDefined();
    }
  });

  it('archives pixels, never the submitted container', async () => {
    const jpeg = await validateRasterImage(formats.colourJpeg, limits);
    const archivedJpeg = readCanonicalPng(jpeg?.safeBytes ?? Buffer.alloc(0));
    expect(archivedJpeg).toMatchObject({ colourType: 2, channels: 3 });
    const [red, green, blue] = archivedJpeg.sampleAt(20, 20);
    expect(red).toBeCloseTo(96, -1);
    expect(green).toBeCloseTo(96, -1);
    expect(blue).toBeCloseTo(96, -1);

    const gif = await validateRasterImage(formats.staticGif, limits);
    const archivedGif = readCanonicalPng(gif?.safeBytes ?? Buffer.alloc(0));
    expect(archivedGif.sampleAt(10, 10)[2]).toBeCloseTo(192, -1);

    const png = await validateRasterImage(makePng(64, 48), limits);
    const archivedPng = readCanonicalPng(png?.safeBytes ?? Buffer.alloc(0));
    expect(Array.from(archivedPng.sampleAt(10, 10))).toEqual([32, 96, 192]);
  });

  it('refuses animation rather than archiving one frame of it', async () => {
    await expect(validateRasterImage(makeAnimatedPng(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(formats.animatedGif, limits)).resolves.toBeNull();
    await expect(validateRasterImage(formats.animatedWebp, limits)).resolves.toBeNull();
  });

  it('refuses a payload appended after the end of a valid image', async () => {
    const pngTrailer = Buffer.concat([makePng(64, 48), Buffer.from('<script>alert(1)</script>')]);
    await expect(validateRasterImage(pngTrailer, limits)).resolves.toBeNull();
    await expect(validateRasterImage(jpegWithTrailingPayload(formats.colourJpeg), limits)).resolves.toBeNull();
    await expect(validateRasterImage(gifWithTrailingPayload(formats.staticGif), limits)).resolves.toBeNull();
  });

  it('produces the same canonical bytes for the same image every time', async () => {
    const first = await validateRasterImage(formats.colourJpeg, limits);
    const second = await validateRasterImage(Buffer.from(formats.colourJpeg), limits);
    expect(first?.safeBytes?.equals(second?.safeBytes ?? Buffer.alloc(0))).toBe(true);
    // Different pixels must not collide under the canonical encoding.
    const other = await validateRasterImage(makeJpeg(64, 48, 32), limits);
    expect(other?.safeBytes?.equals(first?.safeBytes ?? Buffer.alloc(0))).toBe(false);
  });

  it('refuses JPEG fragments that cannot complete an entropy decode', async () => {
    await expect(validateRasterImage(makeJpegHeader(64, 48), limits)).resolves.toBeNull();
    // Adversarial reproduction 2: 28-byte JPEG with SOF/SOS/EOI but no DQT or DHT
    // tables; macOS ImageIO rejects it because entropy decoding needs both.
    await expect(validateRasterImage(makeAdversarialMinimalJpeg(), limits)).resolves.toBeNull();
    await expect(validateRasterImage(truncatedJpeg(formats.colourJpeg), limits)).resolves.toBeNull();
  });

  it('refuses a header that undershoots the raster that follows it', async () => {
    await expect(validateRasterImage(makeMismatchedPng(64, 48, 12), limits)).resolves.toBeNull();
  });

  it('refuses corrupted, truncated, and malformed interlaced PNGs', async () => {
    await expect(validateRasterImage(makeCorruptedPng(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeTruncatedPng(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeMalformedInterlacedPng(64, 48), limits)).resolves.toBeNull();
  });

  it('refuses formats whose pixel data it cannot check at all', async () => {
    await expect(validateRasterImage(makeGifHeader(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeWebpHeader(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeAvifHeader(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeAvifHeader(20_000, 20_000), limits)).resolves.toBeNull();
  });

  it('refuses vector and markup documents', async () => {
    await expect(validateRasterImage(SVG_BYTES, limits)).resolves.toBeNull();
    await expect(validateRasterImage(HTML_BYTES, limits)).resolves.toBeNull();
    await expect(validateRasterImage(Buffer.alloc(0), limits)).resolves.toBeNull();
  });

  it('applies the size policy to a genuinely valid image', async () => {
    const png = makePng(64, 48);
    await expect(validateRasterImage(png, { ...limits, minDimension: 64 })).resolves.toBeNull();
    await expect(validateRasterImage(png, { ...limits, maxDimension: 63 })).resolves.toBeNull();
    await expect(validateRasterImage(png, { ...limits, maxPixels: 3071 })).resolves.toBeNull();
    await expect(validateRasterImage(png, { ...limits, maxPixels: 3072 })).resolves.not.toBeNull();
  });

  it('refuses an oversized declaration, whatever it has behind it', async () => {
    await expect(
      validateRasterImage(makeMismatchedPng(20_000, 19_999, 8), limits)
    ).resolves.toBeNull();
    await expect(validateRasterImage(makePngHeader(20_001, 64), limits)).resolves.toBeNull();
  });

  it('applies the decoder palette policy to indexed PNGs', async () => {
    // The decoder owns PNG structure now: shallow depths tolerate extra
    // palette entries, and a palette that cannot fit the chunk at all is a
    // corrupt header it refuses.
    await expect(validateRasterImage(makeIndexedPngWithExcessPalette(1), limits)).resolves.not.toBeNull();
    await expect(validateRasterImage(makeIndexedPngWithExcessPalette(2), limits)).resolves.not.toBeNull();
    await expect(validateRasterImage(makeIndexedPngWithExcessPalette(4), limits)).resolves.not.toBeNull();
    await expect(validateRasterImage(makeIndexedPngWithExcessPalette(8), limits)).resolves.toBeNull();
  });

  it('canonicalises declared transparency to alpha', async () => {
    for (const input of [
      makeIndexedPngWithTrns(64, 48),
      makeGrayscalePngWithTrns(64, 48, 128),
      makeTruecolourPngWithTrns(64, 48, [32, 96, 192]),
    ]) {
      const result = await validateRasterImage(input, limits);
      expect(result).not.toBeNull();
      const archived = readCanonicalPng(result?.safeBytes ?? Buffer.alloc(0));
      // Every transparency form the decoder accepted comes back as RGBA, and
      // the tRNS chunk itself never reaches storage.
      expect(archived.colourType).toBe(6);
      expect(result?.safeBytes?.includes(Buffer.from('tRNS', 'latin1')) ?? true).toBe(false);
    }
  });

  it('decodes benign malformed tRNS chunks without copying them into storage', async () => {
    for (const input of [
      makePngWithMalformedTrns('indexed-len'),
      makePngWithMalformedTrns('gray-len'),
      makePngWithMalformedTrns('rgb-len'),
      makePngWithMalformedTrns('rgba-trns'),
    ]) {
      const result = await validateRasterImage(input, limits);
      expect(result).not.toBeNull();
      expect(result?.safeBytes).toBeDefined();
      expect(result?.safeBytes?.includes(Buffer.from('tRNS', 'latin1')) ?? true).toBe(false);
    }
  });

  it('rejects an inflating PNG when canonical re-encoding exceeds caller admission allowance', async () => {
    const inflating = makeInflatingPng();
    expect(inflating.byteLength).toBeGreaterThanOrEqual(50_000);
    expect(inflating.byteLength).toBeLessThanOrEqual(60_000);
    // Under an 8 MiB allowance:
    await expect(
      validateRasterImage(inflating, limits, { maxOutputBytes: 8 * 1024 * 1024 })
    ).resolves.toBeNull();
  });

  describe('worker bounds, timeout, and cancellation', () => {
    it('aborts cleanly when signal is triggered', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        validateRasterImage(makePng(64, 48), limits, { signal: controller.signal })
      ).rejects.toBeInstanceOf(InterleafError);
    });

    it('does not renew the absolute deadline when a slot becomes available shortly before expiration', async () => {
      const png = makePng(64, 48);

      // Occupy both worker slots for ~120 ms
      const hang1 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 120 }).catch(() => null);
      const hang2 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 120 }).catch(() => null);

      while (rasterDecoderState().active < 2) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }

      // Slot becomes available around 120 ms. Under the bug, a 200 ms deadline
      // renewed the 200 ms timeout upon acquisition, taking ~306 ms.
      const start = Date.now();
      const deadline = start + 200;

      await expect(
        validateRasterImage(png, limits, { deadline, testWorkerHang: true })
      ).rejects.toThrow('That image took too long to respond, so Interleaf stopped waiting.');

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThanOrEqual(250);

      await Promise.all([hang1, hang2]);
      expect(rasterDecoderState().active).toBe(0);
      expect(rasterDecoderState().queued).toBe(0);
    });

    it('releases slot cleanly and fails without starting worker if expired when slot becomes available', async () => {
      const png = makePng(64, 48);

      // Occupy both slots for ~100 ms
      const hang1 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 100 }).catch(() => null);
      const hang2 = validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 100 }).catch(() => null);

      while (rasterDecoderState().active < 2) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }

      const start = Date.now();
      const deadline = start + 50; // Expires while queued

      await expect(
        validateRasterImage(png, limits, { deadline, testWorkerHang: true })
      ).rejects.toThrow('That image took too long to respond, so Interleaf stopped waiting.');

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThanOrEqual(100);

      await Promise.all([hang1, hang2]);
      expect(rasterDecoderState().active).toBe(0);
      expect(rasterDecoderState().queued).toBe(0);
    });
  });
});
