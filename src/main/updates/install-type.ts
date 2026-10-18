import { isAbsolute, join, sep } from 'node:path';
import type { UpdateSupport } from '@shared/schemas/updates';

/**
 * How this running copy of Interleaf was installed, decided from facts main
 * reads itself. Nothing here comes from the renderer or from settings.
 *
 * Only two shapes update themselves: a packaged macOS app bundle, through
 * Squirrel.Mac's signature-checked swap, and an x64 AppImage, which
 * electron-updater replaces in place. deb and pacman installs are owned by the
 * operating system's package manager: electron-builder marks them with a
 * `resources/package-type` file, and Interleaf never overwrites those files.
 * Development runs and every other platform or layout never contact the feed.
 */

export type InstallType =
  | { readonly kind: 'development' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'mac'; readonly arch: 'arm64' | 'x64' }
  | { readonly kind: 'appimage'; readonly arch: 'x64' }
  | { readonly kind: 'package-manager'; readonly packageType: string };

export type InstallFacts = {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isDevelopment: boolean;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Trimmed contents of a small file, or undefined when it does not exist. */
  readonly readSmallFile: (path: string) => string | undefined;
};

const PACKAGE_TYPE_PATTERN = /^[a-z0-9-]{1,16}$/;

function isInside(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

/** A mounted disk image or a translocated copy cannot be replaced by Squirrel.Mac. */
function macInstallType(facts: InstallFacts): InstallType {
  if (facts.arch !== 'arm64' && facts.arch !== 'x64') return { kind: 'unsupported' };
  if (facts.execPath.startsWith('/Volumes/') || facts.execPath.includes('/AppTranslocation/')) return { kind: 'unsupported' };
  return { kind: 'mac', arch: facts.arch };
}

function linuxInstallType(facts: InstallFacts): InstallType {
  const packageType = facts.readSmallFile(join(facts.resourcesPath, 'package-type'));
  if (packageType !== undefined) {
    return PACKAGE_TYPE_PATTERN.test(packageType) ? { kind: 'package-manager', packageType } : { kind: 'unsupported' };
  }
  const appImage = facts.env.APPIMAGE;
  const appDir = facts.env.APPDIR;
  const runsFromAppImage =
    appImage !== undefined && isAbsolute(appImage) && appDir !== undefined && isAbsolute(appDir) && isInside(facts.execPath, appDir);
  if (runsFromAppImage && facts.arch === 'x64') return { kind: 'appimage', arch: 'x64' };
  return { kind: 'unsupported' };
}

export function detectInstallType(facts: InstallFacts): InstallType {
  if (facts.isDevelopment) return { kind: 'development' };
  if (facts.platform === 'darwin') return macInstallType(facts);
  if (facts.platform === 'linux') return linuxInstallType(facts);
  return { kind: 'unsupported' };
}

export function updateSupportFor(installType: InstallType): UpdateSupport {
  switch (installType.kind) {
    case 'mac':
    case 'appimage':
      return 'self-update';
    case 'package-manager':
      return 'package-manager';
    case 'development':
      return 'development';
    case 'unsupported':
      return 'unsupported';
  }
}
