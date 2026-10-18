import { accepted, isChunkName, refused, type RasterContainerInspection } from './raster-container-verdict';

/**
 * AVIF pre-admission: an ISOBMFF file whose top-level boxes tile the bytes
 * exactly, whose first box is a real `ftyp`, and whose branding carries AVIF
 * still-image identity. `avis` branding and a `moov` (movie) box are image
 * sequences and are refused by structure. Extended-size boxes use their
 * declared 64-bit size as the true offset advance.
 */
export function inspectAvifContainer(bytes: Buffer): RasterContainerInspection {
  if (bytes.length < 16 || bytes.readUInt32BE(0) < 12 || !isChunkName(bytes, 4, 4, 'ftyp')) {
    return refused('AVIF must begin with a real ftyp box.');
  }
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    if (size === 1) {
      if (offset + 16 > bytes.length) return refused('ISOBMFF extended box header is truncated.');
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large < 16n || large > 0xffffffffn) return refused('ISOBMFF extended box size is out of bounds.');
      size = Number(large);
    } else if (size === 0) {
      if (offset === 0) return refused('The first ISOBMFF box cannot claim the whole file.');
      size = bytes.length - offset;
    }
    if (size < 8 || offset + size > bytes.length) return refused('ISOBMFF box runs past the bytes provided.');
    if (isChunkName(bytes, offset + 4, 4, 'moov')) {
      return refused('An AVIF image sequence (moov) is not supported.');
    }
    offset += size;
  }
  if (offset !== bytes.length) return refused('Payload extends beyond the ISOBMFF container.');
  return inspectAvifBranding(bytes);
}

/** Reads the ftyp major and compatible brands and decides AVIF still identity. */
export function inspectAvifBranding(bytes: Buffer): RasterContainerInspection {
  const major = bytes.toString('latin1', 8, 12);
  if (major === 'avis') return refused('AVIF image sequences (avis branding) are not supported.');
  let branded = major === 'avif';
  const brandEnd = Math.min(bytes.readUInt32BE(0), bytes.length);
  for (let brandOffset = 16; brandOffset + 4 <= brandEnd; brandOffset += 4) {
    const brand = bytes.toString('latin1', brandOffset, brandOffset + 4);
    if (brand === 'avis') return refused('AVIF image sequences (avis branding) are not supported.');
    if (brand === 'avif') branded = true;
  }
  return branded ? accepted('avif') : refused('ISOBMFF container is not AVIF still-image branded.');
}
