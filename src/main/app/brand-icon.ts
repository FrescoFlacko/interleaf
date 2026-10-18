import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Locates the Interleaf application icon raster at runtime.
 *
 * macOS reads the bundle's `.icns` for the Dock and window proxy in a packaged
 * build, so this only matters for (a) development, where the process would
 * otherwise show the stock Electron icon in the Dock, and (b) Windows and
 * Linux, where `BrowserWindow` wants an explicit icon.
 *
 * Two fixed, app-owned locations are checked in order. Nothing here accepts a
 * caller- or renderer-supplied path, and a missing icon is not an error: the
 * caller simply omits the option and the platform default applies.
 */

export const BRAND_ICON_FILE_NAME = 'icon.png' as const;

export type BrandIconLookup = {
  /** Electron's `process.resourcesPath` in a packaged build. */
  readonly resourcesPath?: string | undefined;
  /** Directory of the compiled main bundle (`out/main` in development). */
  readonly mainDirectory: string;
};

/**
 * Ordered candidate paths, packaged location first.
 *
 * Packaged: electron-builder copies `resources/icon.png` next to the app's
 * other resources (`extraResources` in electron-builder.yml).
 * Development: `out/main/../../resources/icon.png` is the repository copy.
 */
export function brandIconCandidatePaths(lookup: BrandIconLookup): readonly string[] {
  const candidates: string[] = [];
  if (lookup.resourcesPath !== undefined && lookup.resourcesPath.length > 0) {
    candidates.push(join(lookup.resourcesPath, BRAND_ICON_FILE_NAME));
  }
  candidates.push(join(lookup.mainDirectory, '..', '..', 'resources', BRAND_ICON_FILE_NAME));
  return candidates;
}

/** First candidate that exists, or `undefined` when none does. */
function resolveBrandIconPath(lookup: BrandIconLookup): string | undefined {
  return brandIconCandidatePaths(lookup).find((candidate) => existsSync(candidate));
}

/** Convenience wrapper bound to this process's own layout. */
export function defaultBrandIconPath(): string | undefined {
  return resolveBrandIconPath({
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname,
  });
}
