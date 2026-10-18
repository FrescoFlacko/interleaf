/**
 * The raster pre-admission worker program (ADR 0013).
 *
 * The container walks live in sibling modules (`raster-container-png`,
 * `-jpeg`, `-gif`, `-webp`, `-isobmff`, plus the shared verdict shape in
 * `raster-container-verdict`): pure, dependency-free functions that classify
 * and admit the five approved still formats before any decoder is involved.
 * This module is the assembly point: it dispatches to those walks and builds
 * call, so the pure seam and the enforcement boundary cannot drift apart.
 *
 * The decode-and-validate body is the only part that lives as source text: it
 * is worker-only because `sharp` must never load in the main process. The
 * pixel work is never duplicated here — sharp does the full offline decode,
 * the dimension/pixel bounds, and the canonical PNG re-encode.
 */

import { accepted, refused, isChunkName, SOURCE_MIME } from './raster-container-verdict';
import { inspectPngContainer } from './raster-container-png';
import {
  inspectJpegContainer,
  inspectJpegScan,
  isFrameMarker,
  segmentLength,
  STANDALONE_MARKERS,
  UNSUPPORTED_MARKERS,
} from './raster-container-jpeg';
import {
  gifColourTableBytes,
  inspectGifContainer,
  skipGifSubBlocks,
} from './raster-container-gif';
import { inspectWebpContainer } from './raster-container-webp';
import { inspectAvifBranding, inspectAvifContainer } from './raster-container-isobmff';
import type { RasterContainerInspection } from './raster-container-verdict';

/**
 * Decides what the bytes actually are. The signature is the only cheap
 * dispatch: whichever family the leading bytes belong to, that family's
 * bounded structural walk decides admission, so a non-approved payload can
 * never borrow a decoder by labelling itself honestly.
 */
export function inspectRasterContainer(bytes: Buffer): RasterContainerInspection {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return inspectPngContainer(bytes);
  }
  if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) {
    return inspectJpegContainer(bytes);
  }
  if (bytes.length >= 6) {
    const header = bytes.toString('latin1', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return inspectGifContainer(bytes);
    if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
      return inspectWebpContainer(bytes);
    }
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return inspectAvifContainer(bytes);
  }
  return refused('Raster format is not an approved still format.');
}
/** Every function the isolated worker must carry, in dependency order. */
const WORKER_HELPERS = [
  inspectRasterContainer,
  inspectPngContainer,
  inspectJpegContainer,
  inspectJpegScan,
  segmentLength,
  isFrameMarker,
  gifColourTableBytes,
  skipGifSubBlocks,
  inspectGifContainer,
  inspectWebpContainer,
  inspectAvifContainer,
  inspectAvifBranding,
  accepted,
  refused,
  isChunkName,
];

// The helpers above are plain serialized functions. Every module value they
// read is emitted beside them by name; everything else they touch is their own.
// Vitest's Vite SSR transform additionally qualifies imported bindings inside
// transpiled function sources (`(0,__vite_ssr_import_0__.refused)(...)`); the
// worker scope resolves every helper by its plain name, so the qualifier is
// stripped — a no-op in production bundles, which carry no such qualifier.
const WORKER_HELPER_SOURCE = [
  `const SOURCE_MIME = ${JSON.stringify(SOURCE_MIME)};`,
  `const STANDALONE_MARKERS = ${JSON.stringify(STANDALONE_MARKERS)};`,
  `const UNSUPPORTED_MARKERS = ${JSON.stringify(UNSUPPORTED_MARKERS)};`,
  '',
  ...WORKER_HELPERS.map((helper) =>
    helper.toString().replace(/__vite_ssr_import_\d+__\./g, '')
  ),
].join('\n\n');
const WORKER_DECODE_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const sharp = require('sharp');

// Every decode runs in its own short-lived worker; one libvips thread each
// keeps two concurrent decodes from competing for every core and keeps the
// memory footprint of a decompressed raster predictable.
sharp.concurrency(1);

if (workerData.testWorkerFailure === true) {
  throw new Error('forced raster decode worker failure');
}
if (workerData.testWorkerHang === true) {
  setInterval(function () {}, 3600000);
} else {
  try {
    decodeAndValidate(
      Buffer.from(workerData.buffer),
      workerData.limits,
      workerData.maxInputBytes,
      workerData.maxOutputBytes
    ).then(
      function (result) {
        parentPort.postMessage(result);
      },
      function (err) {
        parentPort.postMessage({
          ok: false,
          error: err instanceof Error ? err.message : 'Unknown decode error',
        });
      }
    );
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown decode error',
    });
  }
}

function reject(error) {
  return { ok: false, error: error };
}

/**
 * The format sharp itself reports for the bytes. The structural classification
 * has already decided what the container is; this cross-check refuses the
 * decode when the decoder disagrees, because then the bytes are not the
 * container the pre-admission walk approved.
 */
function reportedSourceMime(declared, inspection) {
  const REPORTED = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  const direct = REPORTED[declared];
  if (direct !== undefined) return inspection.format === declared ? direct : undefined;
  // libvips reports every HEIF-container still as "heif"; the pre-admission
  // walk already proved the branding is AVIF still-only.
  if (declared === 'heif') return inspection.format === 'avif' ? 'image/avif' : undefined;
  return undefined;
}

async function decodeAndValidate(bytes, limits, maxInputBytes, maxOutputBytes) {
  if (!bytes || bytes.length === 0 || bytes.length > maxInputBytes) {
    return reject('Image exceeds input byte limit or is empty.');
  }
  // Pre-admission: the container is judged by structure before the decoder is
  // involved at all. Mislabeled SVG/HTML/TIFF/PDF bytes and any animation
  // signalling never reach sharp from here.
  const inspection = inspectRasterContainer(bytes);
  if (!inspection.ok) {
    return reject(inspection.reason);
  }
  const maxRawBytes = limits.maxDecompressedBytes || 67108864;
  // A renderer allocates roughly four bytes per pixel, so the raw raster the
  // decoder will materialise is bounded here, before any decompression.
  const sharpOptions = { failOn: 'warning', limitInputPixels: Math.max(1, Math.floor(maxRawBytes / 4)) };
  let metadata;
  try {
    metadata = await sharp(bytes, sharpOptions).metadata();
  } catch (err) {
    return reject('Input is not a decodable raster.');
  }
  const sourceMime = reportedSourceMime(metadata.format, inspection);
  if (sourceMime === undefined) {
    return reject('Decoder reported a different format than the container classification.');
  }
  // The structural animation scan is the primary gate; the decoder's own page
  // count stays behind it as defence in depth.
  if (typeof metadata.pages === 'number' && metadata.pages > 1) {
    return reject('Animated or multi-frame raster is not supported.');
  }
  const width = metadata.width;
  const height = metadata.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return reject('Decoder reported no usable dimensions.');
  }
  if (width < limits.minDimension || height < limits.minDimension) {
    return reject('Image dimension below minimum limit.');
  }
  if (width > limits.maxDimension || height > limits.maxDimension) {
    return reject('Image dimension exceeds maximum limit.');
  }
  if (width * height > limits.maxPixels) {
    return reject('Total pixel count exceeds maximum limit.');
  }
  if (width * height * 4 > maxRawBytes) {
    return reject('Decompressed raster exceeds maximum output limit.');
  }
  let safeBytes;
  try {
    safeBytes = await sharp(bytes, sharpOptions)
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
  } catch (err) {
    return reject('Image failed bounded offline decode.');
  }
  if (safeBytes.length > maxOutputBytes) {
    return reject('Canonical PNG re-encoding exceeded output allowance.');
  }
  return {
    ok: true,
    mimeType: 'image/png',
    sourceMimeType: sourceMime,
    extension: '.png',
    width: width,
    height: height,
    frameCount: 1,
    safeBytes: safeBytes,
  };
}
`;

/** The complete isolated worker program: helpers plus the sharp decode body. */
export const RASTER_WORKER_SOURCE = `${WORKER_HELPER_SOURCE}\n${WORKER_DECODE_SOURCE}`;
