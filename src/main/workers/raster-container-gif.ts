import { accepted, isChunkName, refused, type RasterContainerInspection } from './raster-container-verdict';

/** Size in bytes of a GIF colour table selected by the packed field's 3 low bits. */
export function gifColourTableBytes(packed: number): number {
  return 3 * 2 ** ((packed & 0x07) + 1);
}

/** Advances past length-prefixed sub-blocks to their zero terminator, or -1. */
export function skipGifSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes.readUInt8(offset);
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > bytes.length) return -1;
    offset += length;
  }
  return -1;
}

/**
 * GIF pre-admission: walks blocks and sub-blocks to the trailer byte, which
 * must end the bytes exactly. Animation is refused by structure — a loop
 * extension (NETSCAPE2.0) or more than one image block — so even a
 * single-frame animation signalling file is refused rather than flattened to
 * one picture.
 */
export function inspectGifContainer(bytes: Buffer): RasterContainerInspection {
  if (bytes.length < 14) return refused('Not a structurally plausible GIF container.');
  const header = bytes.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return refused('Not a GIF87a/89a container.');
  let offset = 13 + (bytes.readUInt8(10) & 0x80 ? gifColourTableBytes(bytes.readUInt8(10)) : 0);
  let frameCount = 0;
  let loopExtension = false;
  while (offset < bytes.length) {
    const block = bytes.readUInt8(offset);
    offset += 1;
    if (block === 0x3b) {
      if (offset !== bytes.length) return refused('Payload extends beyond the GIF container.');
      return frameCount === 1 && !loopExtension
        ? accepted('gif')
        : refused('Animated or looping GIF is not supported.');
    }
    if (block === 0x21) {
      if (offset + 1 > bytes.length) return refused('GIF extension is truncated.');
      const label = bytes.readUInt8(offset);
      offset += 1;
      if (
        label === 0xff &&
        offset + 12 <= bytes.length &&
        bytes.readUInt8(offset) === 11 &&
        // NETSCAPE2.0 and its standard alternative ANIMEXTS1.0 both carry the
        // loop count that makes a single frame repeat.
        (isChunkName(bytes, offset + 1, 11, 'NETSCAPE2.0') || isChunkName(bytes, offset + 1, 11, 'ANIMEXTS1.0'))
      ) {
        loopExtension = true;
      }
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return refused('GIF sub-blocks are truncated.');
      continue;
    }
    if (block === 0x2c) {
      if (offset + 9 > bytes.length) return refused('GIF image descriptor is truncated.');
      const packed = bytes.readUInt8(offset + 8);
      offset += 9 + (packed & 0x80 ? gifColourTableBytes(packed) : 0);
      if (offset + 1 > bytes.length) return refused('GIF image data is truncated.');
      offset = skipGifSubBlocks(bytes, offset + 1);
      if (offset < 0) return refused('GIF sub-blocks are truncated.');
      frameCount += 1;
      continue;
    }
    return refused('GIF block is not a recognised one.');
  }
  return refused('GIF ends before its block trailer.');
}
