import { describe, expect, it } from 'vitest';
import { rejectionOf } from '../helpers/errors';
import { inspectRasterContainer } from '@main/workers/raster-container';
import { validateRasterImage, type RasterLimits } from '@main/net/raster-image';
import { rasterDecoderState } from '@main/workers/raster-decode-worker';
import {
  makeAnimatedPng,
  makeJpeg,
  makeMultiPictureJpeg,
  makePng,
  makePngHeader,
  SVG_BYTES,
  HTML_BYTES,
} from '../fixtures/raster-fixtures';
import {
  gifWithTrailingPayload,
  jpegWithTrailingPayload,
  rasterFormatFixtures,
} from '../fixtures/extended-raster-fixtures';
import {
  avifImageSequenceFtyp,
  avifStillWithMovieBox,
  avifWithExtendedSizeMdat,
  avifWithOverrunningExtendedSize,
  gifWithLoopExtension,
  jpegWithFakeFinalSentinel,
  oneFrameAnimatedWebp,
  pdfBytes,
  pngWithCtlTextChunk,
  pngWithJunkBeforeFakeIend,
  tiffBytes,
  webpAnmfWithoutAnimationBit,
  webpWithTwoImageChunks,
} from '../fixtures/raster-animation-fixtures';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * The raster pre-admission boundary, on its own.
 *
 * `inspectRasterContainer` is the pure seam for what the isolated worker runs
 * before sharp is ever asked to touch the bytes, so these tests prove the
 * three admission rules directly: only the five approved still containers
 * classify at all, animation signalling is read from real chunk structure
 * rather than from a byte search, and every container has to end honestly at
 * the last byte. The end-to-end assertions then walk the same bytes through
 * the real worker to prove the seam and the enforcement agree.
 */

const limits: RasterLimits = { minDimension: 32, maxDimension: 20_000, maxPixels: 40_000_000 };
const formats = rasterFormatFixtures();

describe('inspectRasterContainer — the pre-admission seam', () => {
  it('classifies exactly the five approved still containers', () => {
    expect(inspectRasterContainer(makePng(64, 48))).toMatchObject({
      ok: true,
      format: 'png',
      sourceMimeType: 'image/png',
    });
    expect(inspectRasterContainer(formats.colourJpeg)).toMatchObject({
      ok: true,
      format: 'jpeg',
      sourceMimeType: 'image/jpeg',
    });
    expect(inspectRasterContainer(formats.staticGif)).toMatchObject({
      ok: true,
      format: 'gif',
      sourceMimeType: 'image/gif',
    });
    expect(inspectRasterContainer(formats.staticWebp)).toMatchObject({
      ok: true,
      format: 'webp',
      sourceMimeType: 'image/webp',
    });
    expect(inspectRasterContainer(formats.staticAvif)).toMatchObject({
      ok: true,
      format: 'avif',
      sourceMimeType: 'image/avif',
    });
  });

  it('refuses vector, markup, document, and office payloads without parsing them', () => {
    for (const bytes of [SVG_BYTES, HTML_BYTES, tiffBytes(), pdfBytes(), Buffer.alloc(0)]) {
      const inspection = inspectRasterContainer(bytes);
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(inspection.reason).toContain('not an approved still format');
      }
    }
  });

  it('refuses a PNG header with a non-PNG body behind it', () => {
    const mislabeled = Buffer.concat([
      makePngHeader(64, 48),
      Buffer.from('<!doctype html><html><body>not a picture</body></html>', 'utf8'),
    ]);
    expect(inspectRasterContainer(mislabeled)).toMatchObject({ ok: false });
  });

  it('reads animation from chunk structure, not from a string search', () => {
    expect(inspectRasterContainer(makeAnimatedPng(64, 48))).toMatchObject({
      ok: false,
      reason: 'Animated PNG is not supported.',
    });
    // The same bytes as text inside an ordinary chunk are not animation: a
    // search for "acTL" would have refused a decodable picture.
    expect(inspectRasterContainer(pngWithCtlTextChunk(makePng(64, 48)))).toMatchObject({
      ok: true,
      format: 'png',
    });

    // One-frame animation is still animation.
    expect(inspectRasterContainer(oneFrameAnimatedWebp(formats.animatedWebp))).toMatchObject({
      ok: false,
      reason: 'Animated WebP is not supported.',
    });
    expect(inspectRasterContainer(webpAnmfWithoutAnimationBit(formats.animatedWebp))).toMatchObject({
      ok: false,
      reason: 'Animated WebP is not supported.',
    });
    expect(inspectRasterContainer(webpWithTwoImageChunks(formats.staticWebp))).toMatchObject({
      ok: false,
      reason: 'Multi-picture WebP is not supported.',
    });

    expect(inspectRasterContainer(formats.animatedGif)).toMatchObject({
      ok: false,
      reason: 'Animated or looping GIF is not supported.',
    });
    // A single frame plus a loop extension is an animation waiting to repeat,
    // under either application identifier.
    expect(inspectRasterContainer(gifWithLoopExtension(formats.staticGif))).toMatchObject({
      ok: false,
      reason: 'Animated or looping GIF is not supported.',
    });
    expect(inspectRasterContainer(gifWithLoopExtension(formats.staticGif, 'ANIMEXTS1.0'))).toMatchObject({
      ok: false,
      reason: 'Animated or looping GIF is not supported.',
    });

    // Progressive JPEG and genuine Adam7-interlaced PNG are legal stills.
    expect(inspectRasterContainer(formats.progressiveJpeg)).toMatchObject({
      ok: true,
      format: 'jpeg',
      sourceMimeType: 'image/jpeg',
    });
    expect(inspectRasterContainer(formats.interlacedPng)).toMatchObject({
      ok: true,
      format: 'png',
      sourceMimeType: 'image/png',
    });
    // A payload appended after a progressive scan stream is still refused.
    expect(
      inspectRasterContainer(Buffer.concat([formats.progressiveJpeg, Buffer.from('junk', 'latin1')]))
    ).toMatchObject({ ok: false, reason: 'Payload extends beyond the JPEG container.' });

    expect(inspectRasterContainer(avifImageSequenceFtyp())).toMatchObject({
      ok: false,
      reason: 'AVIF image sequences (avis branding) are not supported.',
    });
    expect(inspectRasterContainer(avifStillWithMovieBox(formats.staticAvif))).toMatchObject({
      ok: false,
      reason: 'An AVIF image sequence (moov) is not supported.',
    });
  });

  it('requires the first complete container to end exactly where the bytes do', () => {
    expect(inspectRasterContainer(pngWithJunkBeforeFakeIend(makePng(64, 48)))).toMatchObject({
      ok: false,
      reason: 'Payload extends beyond the PNG container.',
    });
    expect(inspectRasterContainer(jpegWithTrailingPayload(formats.colourJpeg))).toMatchObject({
      ok: false,
      reason: 'Payload extends beyond the JPEG container.',
    });
    expect(inspectRasterContainer(jpegWithFakeFinalSentinel(formats.colourJpeg))).toMatchObject({
      ok: false,
      reason: 'Payload extends beyond the JPEG container.',
    });
    expect(inspectRasterContainer(makeMultiPictureJpeg(64, 48))).toMatchObject({ ok: false });
    expect(inspectRasterContainer(gifWithTrailingPayload(formats.staticGif))).toMatchObject({
      ok: false,
      reason: 'Payload extends beyond the GIF container.',
    });
    expect(
      inspectRasterContainer(Buffer.concat([formats.staticWebp, Buffer.from('junk', 'latin1')]))
    ).toMatchObject({ ok: false });
    expect(inspectRasterContainer(makeJpeg(64, 48).subarray(0, 40))).toMatchObject({ ok: false });
  });

  it('follows ISOBMFF extended-size boxes by their declared 64-bit size', () => {
    expect(inspectRasterContainer(avifWithExtendedSizeMdat(formats.staticAvif))).toMatchObject({
      ok: true,
      format: 'avif',
    });
    expect(inspectRasterContainer(avifWithOverrunningExtendedSize(formats.staticAvif))).toMatchObject({
      ok: false,
      reason: 'ISOBMFF box runs past the bytes provided.',
    });
  });
});

describe('validateRasterImage — the same rules at the real worker boundary', () => {
  it('refuses one-frame animation and AVIF sequences before decoding', async () => {
    await expect(
      validateRasterImage(oneFrameAnimatedWebp(formats.animatedWebp), limits)
    ).resolves.toBeNull();
    await expect(validateRasterImage(avifImageSequenceFtyp(), limits)).resolves.toBeNull();
    await expect(validateRasterImage(avifStillWithMovieBox(formats.staticAvif), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeAnimatedPng(64, 48), limits)).resolves.toBeNull();
    await expect(validateRasterImage(gifWithLoopExtension(formats.staticGif), limits)).resolves.toBeNull();
    await expect(
      validateRasterImage(gifWithLoopExtension(formats.staticGif, 'ANIMEXTS1.0'), limits)
    ).resolves.toBeNull();
  });

  it('refuses appended payloads and multi-picture streams before decoding', async () => {
    await expect(
      validateRasterImage(pngWithJunkBeforeFakeIend(makePng(64, 48)), limits)
    ).resolves.toBeNull();
    await expect(validateRasterImage(jpegWithFakeFinalSentinel(formats.colourJpeg), limits)).resolves.toBeNull();
    await expect(validateRasterImage(makeMultiPictureJpeg(64, 48), limits)).resolves.toBeNull();
  });

  it('still archives an ordinary picture that merely mentions animation chunks', async () => {
    const result = await validateRasterImage(pngWithCtlTextChunk(makePng(64, 48)), limits);
    expect(result).toMatchObject({ mimeType: 'image/png', width: 64, height: 48 });
    expect(result?.safeBytes).toBeDefined();
  });

  it('still decodes a genuine progressive JPEG and an Adam7-interlaced PNG', async () => {
    const progressive = await validateRasterImage(formats.progressiveJpeg, limits);
    expect(progressive).toMatchObject({ sourceMimeType: 'image/jpeg', width: 64, height: 48 });
    expect(progressive?.safeBytes).toBeDefined();
    const interlaced = await validateRasterImage(formats.interlacedPng, limits);
    expect(interlaced).toMatchObject({ sourceMimeType: 'image/png', width: 64, height: 48 });
    expect(interlaced?.safeBytes).toBeDefined();
    // An appended payload after a progressive stream is refused at the worker
    // path exactly as the seam refuses it.
    await expect(
      validateRasterImage(Buffer.concat([formats.progressiveJpeg, Buffer.from('junk', 'latin1')]), limits)
    ).resolves.toBeNull();
  });
  it('fails closed when the decoder itself cannot follow an extended-size payload', async () => {
    // The walk accepts the extended-size container (the seam test above);
    // libheif's own reader still declines to read its pixel data, and
    // admission fails closed rather than archiving a half-understood file.
    await expect(validateRasterImage(avifWithExtendedSizeMdat(formats.staticAvif), limits)).resolves.toBeNull();
  });
});

describe('raster worker admission lifecycle', () => {
  it('releases a timed-out slot only once the worker thread is really gone', async () => {
    const png = makePng(64, 48);
    const first = rejectionOf(validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 60 }));
    const second = rejectionOf(validateRasterImage(png, limits, { testWorkerHang: true, timeoutMs: 60 }));
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toBeInstanceOf(InterleafError);
    expect(secondError).toBeInstanceOf(InterleafError);
    // Both slots and both threads are gone at the moment the rejections land;
    // neither admission slot is handed on while a thread is still dying.
    expect(rasterDecoderState()).toMatchObject({ active: 0, queued: 0, workers: 0 });
    // The freed slots still admit new work.
    await expect(validateRasterImage(png, limits)).resolves.toMatchObject({ width: 64, height: 48 });
  });

  it('releases a failed worker the same way', async () => {
    await expect(
      validateRasterImage(makePng(64, 48), limits, { testWorkerFailure: true })
    ).rejects.toBeInstanceOf(InterleafError);
    expect(rasterDecoderState()).toMatchObject({ active: 0, queued: 0, workers: 0 });
  });
});
