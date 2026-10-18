import { accepted, isChunkName, refused, type RasterContainerInspection } from './raster-container-verdict';

/**
 * JPEG pre-admission: walks the marker chain from SOI through the entropy
 * stream to the first true EOI, which must be the last two bytes. A second
 * image appended after the first EOI, or a fake trailing EOI behind junk, both
 * fail. A multi-picture (MPF) index is refused by structure as well, and every
 * frame must be a plain still (exactly one SOF).
 */

/** Markers that stand alone with no length field: TEM and the RSTn family. */
export const STANDALONE_MARKERS: Record<number, true> = {
  0x01: true,
  0xd0: true,
  0xd1: true,
  0xd2: true,
  0xd3: true,
  0xd4: true,
  0xd5: true,
  0xd6: true,
  0xd7: true,
};

/** Markers that name unsupported machinery: JMP and the arithmetic coder. */
export const UNSUPPORTED_MARKERS: Record<number, true> = {
  0xc8: true,
  0xcc: true,
};

/** SOF0–SOF15 except DHT (0xc4): each occurrence starts a picture frame. */
export function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4;
}

/** The two-byte length that ends a payload segment, bounded by the bytes. */
export function segmentLength(bytes: Buffer, offset: number): number | string {
  if (offset + 2 > bytes.length) return 'JPEG segment header is truncated.';
  const length = bytes.readUInt16BE(offset);
  if (length < 2 || offset + length > bytes.length) {
    return 'JPEG segment runs past the bytes provided.';
  }
  return length;
}

/**
 * Entropy-coded bytes after SOS: stuffed zeros and restart markers are data;
 * the next real marker — the final EOI, or a legal inter-scan DHT, DQT, DRI,
 * or further SOS — ends the scan at its own first byte. The walk stays
 * bounded by the bytes themselves: a scan that runs out of bytes before any
 * marker is a truncated stream.
 */
export function inspectJpegScan(
  bytes: Buffer,
  start: number
): { readonly refused: string } | { readonly resumeOffset: number } {
  let offset = start;
  while (offset + 1 < bytes.length) {
    if (bytes.readUInt8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes.readUInt8(offset + 1);
    if (marker === 0xff || marker === 0x00 || STANDALONE_MARKERS[marker]) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    return { resumeOffset: offset };
  }
  return { refused: 'JPEG ends before its image terminator.' };
}

export function inspectJpegContainer(bytes: Buffer): RasterContainerInspection {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
    return refused('Not a structurally plausible JPEG container.');
  }
  let offset = 2;
  let frameCount = 0;
  while (offset + 2 <= bytes.length) {
    if (bytes.readUInt8(offset) !== 0xff) return refused('JPEG marker is missing where one is required.');
    const marker = bytes.readUInt8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    if (marker === 0xd9) {
      return offset === bytes.length && frameCount === 1
        ? accepted('jpeg')
        : refused('Payload extends beyond the JPEG container.');
    }
    if (marker === 0xd8) return refused('A second JPEG image begins inside the container.');
    if (STANDALONE_MARKERS[marker]) continue;
    if (UNSUPPORTED_MARKERS[marker]) return refused('JPEG marker is not a supported one.');
    const length = segmentLength(bytes, offset);
    if (typeof length === 'string') return refused(length);
    if (marker === 0xe2 && isChunkName(bytes, offset + 2, 3, 'MPF')) {
      return refused('Multi-picture JPEG is not supported.');
    }
    if (isFrameMarker(marker)) frameCount += 1;
    if (marker === 0xda) {
      // A scan's entropy data runs to the next real marker. Progressive
      // files legally interleave table markers (DHT, DQT, DRI) between
      // scans and carry further SOS segments, so the walk resumes at that
      // marker and continues to the final EOI instead of stopping after the
      // first scan.
      const scan = inspectJpegScan(bytes, offset + length);
      if ('refused' in scan) return refused(scan.refused);
      offset = scan.resumeOffset;
      continue;
    }
    offset += length;
  }
  return refused('JPEG ends before its image terminator.');
}
