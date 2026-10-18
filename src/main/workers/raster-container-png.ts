import { accepted, isChunkName, refused, type RasterContainerInspection } from './raster-container-verdict';

/**
 * PNG pre-admission: walks the real chunk chain (not a string search, so
 * ordinary image data that happens to contain "acTL" bytes is not mistaken for
 * animation) and refuses animation control chunks. The walk ends at IEND,
 * which must be the last thing in the bytes; anything after it was appended.
 */
export function inspectPngContainer(bytes: Buffer): RasterContainerInspection {
  if (bytes.length < 16) return refused('Not an exact PNG container.');
  if (bytes.readUInt32BE(8) !== 13 || !isChunkName(bytes, 12, 4, 'IHDR')) {
    return refused('PNG does not start with its image header chunk.');
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return refused('PNG chunk runs past the bytes provided.');
    if (type === 'acTL') return refused('Animated PNG is not supported.');
    if (type === 'IEND') {
      return length === 0 && end === bytes.length
        ? accepted('png')
        : refused('Payload extends beyond the PNG container.');
    }
    offset = end;
  }
  return refused('PNG ends before its image terminator.');
}
