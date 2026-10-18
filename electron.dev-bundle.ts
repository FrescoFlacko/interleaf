import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_NAME } from './src/shared/constants/brand';

/**
 * macOS application identity for an unpackaged development run.
 *
 * A packaged build gets its Dock name, menu-bar name, and About entry from the
 * Interleaf bundle that electron-builder produces. An unpackaged run has no
 * such bundle: `electron-vite dev` executes the prebuilt `Electron.app` from
 * `node_modules`, so macOS registers the process with LaunchServices under that
 * bundle's `CFBundleName`/`CFBundleDisplayName` and the Dock says "Electron".
 *
 * `app.setName()` cannot fix this. Electron documents it as overriding "the
 * name used internally by Electron; it does not affect the name that the OS
 * uses", and a live launch confirms that: the LaunchServices display name stays
 * "Electron" whether the call happens before or after `app.whenReady()`.
 *
 * Rewriting the bundle's `Info.plist` is not enough either. The label the Dock
 * paints in its hover tooltip is the *file system* name of the bundle, and for
 * an application bundle macOS takes that from the directory name, not from
 * `CFBundleName`/`CFBundleDisplayName`. A clone still called `Electron.app`
 * reads back as:
 *
 *   FileManager.displayName        Electron
 *   URLResourceKey.localizedName   Electron
 *   Info.plist CFBundleName        Interleaf
 *
 * Renaming the directory to `Interleaf.app` is what changes both name reads,
 * with or without the plist keys. So the development flow launches from a
 * fully renamed clone: `out/dev-app/Interleaf.app`, whose executable is
 * `Contents/MacOS/Interleaf`. That is the same rename electron-builder applies
 * when it produces the packaged bundle.
 *
 * `electron.vite.config.ts` then points electron-vite at the clone through
 * `ELECTRON_EXEC_PATH`.
 *
 * Deliberate limits:
 *
 * - The installed dependency is never modified or renamed. The clone is a
 *   generated build artifact under the already-ignored `out/` directory.
 * - The clone also carries the Interleaf artwork. A cloned bundle keeps the
 *   stock `CFBundleIconFile=electron.icns`, and macOS reads that from the
 *   bundle before the process can say anything about itself, so the Dock shows
 *   the Electron icon. The clone therefore gets the app-owned
 *   `resources/icon.icns` under its own name in `Contents/Resources`.
 * - The clone gets its own `CFBundleIdentifier`. It must not claim the packaged
 *   app's `com.interleaf.app` identity, and leaving it as the stock
 *   `com.github.Electron` would register a second, differently named bundle
 *   under the identifier the installed dependency already owns.
 * - The Mach-O binary is copied byte for byte and its ad-hoc signature covers
 *   the executable only (`Info.plist=not bound`, `Sealed Resources=none`), so
 *   renaming the file and editing the property list keeps it launchable.
 * - Every input is app-owned (the project root and the installed Electron
 *   layout). Nothing here accepts a renderer-, document-, or user-supplied
 *   path, and the only subprocess is a fixed executable with tokenized argv.
 * - Preparation is best-effort. Any failure leaves `ELECTRON_EXEC_PATH` unset
 *   so the run falls back to the stock bundle: a cosmetic name must never be
 *   able to break `npm run dev`.
 */

/** Generated bundle location, relative to the project root. */
export const DEV_BUNDLE_DIRECTORY = join('out', 'dev-app');

/** Records what the clone was built from, so a stale copy is rebuilt. */
export const DEV_BUNDLE_STAMP_FILE = 'identity.json';

/**
 * Bundle identifier for the development clone.
 *
 * Distinct from the packaged `com.interleaf.app` so a development process can
 * never be mistaken for an installed Interleaf, and distinct from the stock
 * `com.github.Electron` so two differently named bundles do not register under
 * one identifier.
 */
export const DEV_BUNDLE_IDENTIFIER = 'com.interleaf.app.dev';

/** Bundle names must stay a single path component under `out/dev-app`. */
const SAFE_BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** The app-owned macOS icon, relative to the project root. */
export const BRAND_ICNS_SOURCE = join('resources', 'icon.icns');

/** File name the clone stores its copy of that icon under. */
export function devBundleIconFileName(appName: string): string {
  return `${appName}.icns`;
}

/**
 * The `Info.plist` values the clone overrides.
 *
 * `CFBundleExecutable` has to track the renamed executable file, or macOS
 * cannot start the bundle at all. `CFBundleIconFile` has to name the copied
 * Interleaf icon, because the stock value points at the `electron.icns` the
 * clone inherited.
 */
export type DevBundleIdentity = {
  readonly CFBundleName: string;
  readonly CFBundleDisplayName: string;
  readonly CFBundleExecutable: string;
  readonly CFBundleIdentifier: string;
  readonly CFBundleIconFile: string;
};

export function devBundleIdentity(appName: string): DevBundleIdentity {
  return {
    CFBundleName: appName,
    CFBundleDisplayName: appName,
    CFBundleExecutable: appName,
    CFBundleIdentifier: DEV_BUNDLE_IDENTIFIER,
    CFBundleIconFile: devBundleIconFileName(appName),
  };
}

export type MacDevBundlePaths = {
  /** `Electron.app` inside the installed dependency; read-only here. */
  readonly sourceBundle: string;
  readonly sourceInfoPlist: string;
  /** The stock executable file name, renamed to the product name in the clone. */
  readonly sourceExecutableName: string;
  /** The app-owned `.icns` the clone is given; never a caller-supplied path. */
  readonly sourceIcon: string;
  /** Everything generated lives under this directory and is replaced wholesale. */
  readonly root: string;
  /** The generated clone and the executable electron-vite should spawn. */
  readonly bundle: string;
  readonly infoPlist: string;
  readonly executable: string;
  /** Where the app-owned icon is copied to inside the clone. */
  readonly icon: string;
  readonly stamp: string;
};

export type MacDevBundleOptions = {
  readonly projectRoot: string;
  readonly appName: string;
  /** Injected so the non-darwin short-circuit is testable. */
  readonly platform: NodeJS.Platform;
  readonly warn?: ((message: string) => void) | undefined;
};

/**
 * Resolves the stock and generated bundle layouts from the project root.
 *
 * `node_modules/electron/path.txt` is the executable subpath the Electron
 * package itself publishes (`Electron.app/Contents/MacOS/Electron` on macOS);
 * reading it avoids hard-coding a second copy of that knowledge. A subpath that
 * is not inside an `.app` is not a macOS bundle, so there is nothing to
 * rebrand.
 *
 * The generated side is deliberately *not* a mirror of that layout: the bundle
 * directory and the executable both take the product name, because the bundle
 * directory name is what macOS shows in the Dock.
 */
export function macDevBundlePaths(
  projectRoot: string,
  appName: string,
): MacDevBundlePaths | undefined {
  if (!SAFE_BUNDLE_NAME.test(appName)) return undefined;
  const electronDist = join(projectRoot, 'node_modules', 'electron', 'dist');
  const pathFile = join(projectRoot, 'node_modules', 'electron', 'path.txt');
  if (!existsSync(pathFile)) return undefined;
  const segments = readFileSync(pathFile, 'utf8').trim().split('/');
  const sourceBundleName = segments[0];
  const sourceExecutableName = segments.at(-1);
  if (!sourceBundleName?.endsWith('.app') || sourceExecutableName === undefined) return undefined;
  const root = join(projectRoot, DEV_BUNDLE_DIRECTORY);
  const bundle = join(root, `${appName}.app`);
  return {
    sourceBundle: join(electronDist, sourceBundleName),
    sourceInfoPlist: join(electronDist, sourceBundleName, 'Contents', 'Info.plist'),
    sourceExecutableName,
    sourceIcon: join(projectRoot, BRAND_ICNS_SOURCE),
    root,
    bundle,
    infoPlist: join(bundle, 'Contents', 'Info.plist'),
    executable: join(bundle, 'Contents', 'MacOS', appName),
    icon: join(bundle, 'Contents', 'Resources', devBundleIconFileName(appName)),
    stamp: join(root, DEV_BUNDLE_STAMP_FILE),
  };
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrites the identity keys of an XML property list.
 *
 * Electron ships `Info.plist` as XML, so a targeted textual replacement avoids
 * both a plist dependency and a `plutil` subprocess. It is deliberately strict:
 * a key that is absent, duplicated, or stored in some other representation
 * (a binary plist, for one) throws rather than silently producing a bundle that
 * still identifies itself as Electron.
 */
export function applyPlistIdentity(plistXml: string, identity: DevBundleIdentity): string {
  let rewritten = plistXml;
  for (const [key, value] of Object.entries(identity)) {
    const entry = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, 'g');
    const matches = rewritten.match(entry);
    if (matches?.length !== 1) {
      throw new Error(`Info.plist does not contain exactly one <string> value for ${key}`);
    }
    rewritten = rewritten.replace(entry, `$1${escapeXmlText(value)}$3`);
  }
  return rewritten;
}

/**
 * Identity of the source the clone was built from.
 *
 * Size and modification time of the source `Info.plist` plus the installed
 * Electron version are enough to notice an upgrade or a reinstall. The same
 * pair is recorded for the app-owned icon so redrawn artwork reaches the clone.
 * The whole applied identity is recorded too, so a clone built by an earlier,
 * differently named revision of this module is replaced rather than reused, and
 * the schema number retires clones built before the bundle carried an icon.
 */
export function devBundleStamp(input: {
  readonly identity: DevBundleIdentity;
  readonly electronVersion: string;
  readonly sourceSize: number;
  readonly sourceModifiedMs: number;
  readonly iconSize: number;
  readonly iconModifiedMs: number;
}): string {
  return JSON.stringify({
    schema: 3,
    identity: input.identity,
    electronVersion: input.electronVersion,
    sourceSize: input.sourceSize,
    sourceModifiedMs: input.sourceModifiedMs,
    iconSize: input.iconSize,
    iconModifiedMs: input.iconModifiedMs,
  });
}

/** True when an existing clone still matches the source it was built from. */
export function devBundleIsCurrent(input: {
  readonly bundleExists: boolean;
  readonly recordedStamp: string | undefined;
  readonly expectedStamp: string;
}): boolean {
  return input.bundleExists && input.recordedStamp === input.expectedStamp;
}

function readStamp(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readElectronVersion(projectRoot: string): string {
  const versionFile = join(projectRoot, 'node_modules', 'electron', 'dist', 'version');
  return existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'unknown';
}

/**
 * Copies the source bundle.
 *
 * `cp -Rc` asks APFS for a copy-on-write clone, which takes milliseconds and
 * effectively no disk for a ~275 MB bundle. The executable is fixed, the
 * arguments are tokenized, and no shell is involved. On a volume without clone
 * support the flag fails, so a plain recursive copy is the fallback; symlinks
 * inside the framework are preserved rather than expanded.
 */
function cloneBundle(source: string, destination: string): void {
  try {
    execFileSync('/bin/cp', ['-Rc', source, destination], { stdio: 'ignore' });
  } catch {
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
}

/**
 * Builds (or reuses) the development bundle and returns its executable.
 *
 * Returns `undefined` whenever the bundle is not applicable or could not be
 * produced; the caller then leaves the stock Electron executable in place.
 */
export function prepareMacDevBundle(options: MacDevBundleOptions): string | undefined {
  if (options.platform !== 'darwin') return undefined;
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  try {
    const paths = macDevBundlePaths(options.projectRoot, options.appName);
    if (paths === undefined || !existsSync(paths.sourceInfoPlist)) return undefined;
    const identity = devBundleIdentity(options.appName);
    const source = statSync(paths.sourceInfoPlist);
    // Strict: the rewritten plist names this file, so a clone without it would
    // fall back to a generic icon. Failing here keeps the stock bundle, whose
    // own icon the main process can still replace at runtime.
    const icon = statSync(paths.sourceIcon);
    const expectedStamp = devBundleStamp({
      identity,
      electronVersion: readElectronVersion(options.projectRoot),
      sourceSize: source.size,
      sourceModifiedMs: source.mtimeMs,
      iconSize: icon.size,
      iconModifiedMs: icon.mtimeMs,
    });
    if (devBundleIsCurrent({
      bundleExists: [paths.executable, paths.icon].every((path) => existsSync(path)),
      recordedStamp: readStamp(paths.stamp),
      expectedStamp,
    })) {
      return paths.executable;
    }
    const rebranded = applyPlistIdentity(readFileSync(paths.sourceInfoPlist, 'utf8'), identity);
    // The whole directory goes, not just this bundle: an earlier revision of
    // this module wrote a differently named clone beside it.
    rmSync(paths.root, { recursive: true, force: true });
    mkdirSync(paths.root, { recursive: true });
    cloneBundle(paths.sourceBundle, paths.bundle);
    renameSync(join(paths.bundle, 'Contents', 'MacOS', paths.sourceExecutableName), paths.executable);
    mkdirSync(dirname(paths.icon), { recursive: true });
    cpSync(paths.sourceIcon, paths.icon);
    writeFileSync(paths.infoPlist, rebranded, 'utf8');
    writeFileSync(paths.stamp, expectedStamp, 'utf8');
    return paths.executable;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    warn(`Development app identity not applied; the Dock will show the stock Electron name and icon: ${reason}`);
    return undefined;
  }
}

/** Vite's own config command; `serve` is the development run. */
export type ViteCommand = 'build' | 'serve';

/**
 * Points electron-vite at the rebranded bundle for a development run.
 *
 * `ELECTRON_EXEC_PATH` is electron-vite's own override for the executable it
 * spawns, and it reads the variable when it launches the app — after the config
 * module has been evaluated. An explicit value already set by the developer
 * always wins.
 *
 * A build is left alone: a packaged run takes its identity from the Interleaf
 * bundle electron-builder produces and must never be redirected at a rebranded
 * copy of the stock Electron bundle.
 */
export function applyMacDevAppIdentity(projectRoot: string, command: ViteCommand): void {
  if (command !== 'serve') return;
  const existing = process.env.ELECTRON_EXEC_PATH;
  if (existing !== undefined && existing.length > 0) return;
  const executable = prepareMacDevBundle({
    projectRoot,
    appName: APP_NAME,
    platform: process.platform,
  });
  if (executable === undefined) return;
  process.env.ELECTRON_EXEC_PATH = executable;
}
