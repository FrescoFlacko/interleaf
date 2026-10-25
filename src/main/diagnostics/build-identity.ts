import packageJson from '../../../package.json';

export type AppVersionSource = {
  getVersion(): string;
  isPackaged: boolean;
};

/**
 * Returns the true application version for diagnostics.
 * Packaged installs use Electron's `app.getVersion()`.
 * Unpackaged development runs use main-owned package metadata (0.13.0)
 * rather than Electron's own runtime version (e.g. 44.7.0).
 */
export function resolveDiagnosticsAppVersion(electronApp: AppVersionSource): string {
  if (electronApp.isPackaged) {
    return electronApp.getVersion();
  }
  return packageJson.version;
}
