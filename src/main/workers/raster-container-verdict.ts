/**
 * The shared verdict shape for the raster pre-admission walks (ADR 0013).
 *
 * These pieces are deliberately tiny and dependency-free: the isolated worker
 * runs the very same compiled functions the host tests call, serialized into
 * the worker source by `raster-container.ts`, so everything they read has to
 * travel with them.
 */

export type RasterSourceFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

export type RasterContainerInspection =
  | { readonly ok: true; readonly format: RasterSourceFormat; readonly sourceMimeType: string }
  | { readonly ok: false; readonly reason: string };

export const SOURCE_MIME: Record<RasterSourceFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export function accepted(format: RasterSourceFormat): RasterContainerInspection {
  return { ok: true, format, sourceMimeType: SOURCE_MIME[format] };
}

export function refused(reason: string): RasterContainerInspection {
  return { ok: false, reason };
}

/** True when `length` bytes at `offset` spell the expected chunk/box name. */
export function isChunkName(bytes: Buffer, offset: number, length: number, name: string): boolean {
  return bytes.toString('latin1', offset, offset + length) === name;
}
