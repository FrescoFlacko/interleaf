/**
 * What tells a development run apart from a packaged one.
 *
 * `app.isPackaged` is derived from the executable's file name: Electron reports
 * "packaged" for anything not called `electron`. The development bundle in
 * `electron.dev-bundle.ts` deliberately renames its executable to `Interleaf`,
 * so that flag alone calls a development run packaged.
 *
 * `process.defaultApp` is the complementary fact and is not affected by the
 * rename: Electron sets it when the application was loaded from a path passed
 * on the command line, which is how `electron-vite dev` starts the app and is
 * never how a bundled `app.asar` starts. A run is therefore development when
 * either signal says so. Free of Electron so the updater shares the same rule.
 */
export type RuntimePackagingSignals = {
  readonly isPackaged: boolean;
  /** Electron types this as a boolean, but a packaged run leaves it unset. */
  readonly defaultApp: boolean | undefined;
};

export function isDevelopmentRun(signals: RuntimePackagingSignals): boolean {
  if (signals.defaultApp === true) return true;
  return !signals.isPackaged;
}
