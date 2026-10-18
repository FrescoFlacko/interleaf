import { accepted, isChunkName, refused, type RasterContainerInspection } from './raster-container-verdict';

/**
 * WebP pre-admission: exact RIFF/WEBP envelope whose declared size is the
 * whole file, then sub-chunks that must tile those bytes exactly. The VP8X
 * animation bit, and any ANIM/ANMF chunk — even around a single frame — refuse
 * admission, as does anything other than exactly one image chunk.
 */
export function inspectWebpContainer(bytes: Buffer): RasterContainerInspection {
  if (
    bytes.length < 20 ||
    !isChunkName(bytes, 0, 4, 'RIFF') ||
    !isChunkName(bytes, 8, 4, 'WEBP') ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    return refused('Payload is not an exact RIFF/WEBP container.');
  }
  let offset = 12;
  let imageChunks = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) return refused('WebP chunk runs past the bytes provided.');
    if (id === 'VP8X') {
      if ((bytes.readUInt8(offset + 8) & 0x02) !== 0) return refused('Animated WebP is not supported.');
    } else if (id === 'ANIM' || id === 'ANMF') {
      return refused('Animated WebP is not supported.');
    } else if (id === 'VP8 ' || id === 'VP8L') {
      imageChunks += 1;
    }
    offset = end + (length & 1);
  }
  if (offset !== bytes.length) return refused('Payload extends beyond the WebP container.');
  if (imageChunks !== 1) {
    return refused(
      imageChunks === 0 ? 'WebP container holds no image data.' : 'Multi-picture WebP is not supported.'
    );
  }
  return accepted('webp');
}
