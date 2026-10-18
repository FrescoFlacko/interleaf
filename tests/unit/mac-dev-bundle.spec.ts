import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP_ID, APP_NAME } from '@shared/constants/brand';
import {
  BRAND_ICNS_SOURCE,
  DEV_BUNDLE_DIRECTORY,
  DEV_BUNDLE_IDENTIFIER,
  applyMacDevAppIdentity,
  applyPlistIdentity,
  devBundleIdentity,
  devBundleIsCurrent,
  devBundleStamp,
  macDevBundlePaths,
  prepareMacDevBundle,
} from '../../electron.dev-bundle';

/**
 * An unpackaged macOS run must present itself as Interleaf, including in the
 * Dock hover tooltip.
 *
 * The tooltip paints the bundle's *file system* name, and macOS takes that from
 * the bundle directory name — not from `CFBundleName`, `CFBundleDisplayName`,
 * or the LaunchServices display name a running process registers. A clone still
 * called `Electron.app` therefore still hovers as "Electron" even with both
 * display keys rewritten, which is exactly the bug these tests pin.
 *
 * So the generated bundle is `Interleaf.app`, its executable is
 * `Contents/MacOS/Interleaf`, and it carries a development-only bundle
 * identifier. The installed dependency is never touched.
 */

const STOCK_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Electron</string>
\t<key>CFBundleExecutable</key>
\t<string>Electron</string>
\t<key>CFBundleIconFile</key>
\t<string>electron.icns</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
\t<key>CFBundleName</key>
\t<string>Electron</string>
</dict>
</plist>
`;

const EXECUTABLE_SUB_PATH = 'Electron.app/Contents/MacOS/Electron';

/** Stand-in for the app-owned `resources/icon.icns`. */
const BRAND_ICNS_BYTES = 'interleaf-book-and-leaf-icns';

let projectRoot = '';

function writeBrandIcns(bytes = BRAND_ICNS_BYTES): void {
  const icon = join(projectRoot, BRAND_ICNS_SOURCE);
  mkdirSync(dirname(icon), { recursive: true });
  writeFileSync(icon, bytes, 'utf8');
}

/** A minimal stand-in for the installed `electron` package layout. */
function writeStockElectron(version: string): void {
  const electron = join(projectRoot, 'node_modules', 'electron');
  const executable = join(electron, 'dist', EXECUTABLE_SUB_PATH);
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  // The stock bundle ships its own icon; the clone must not keep pointing at it.
  mkdirSync(join(electron, 'dist', 'Electron.app', 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(electron, 'dist', 'Electron.app', 'Contents', 'Resources', 'electron.icns'), 'stock', 'utf8');
  writeBrandIcns();
  writeFileSync(join(electron, 'path.txt'), EXECUTABLE_SUB_PATH, 'utf8');
  writeFileSync(join(electron, 'dist', 'version'), version, 'utf8');
  writeFileSync(
    join(electron, 'dist', 'Electron.app', 'Contents', 'Info.plist'),
    STOCK_INFO_PLIST,
    'utf8',
  );
}

function sourceInfoPlistPath(): string {
  return join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
}

function devBundlePath(...segments: readonly string[]): string {
  return join(projectRoot, DEV_BUNDLE_DIRECTORY, ...segments);
}

function generatedInfoPlist(): string {
  return readFileSync(devBundlePath(`${APP_NAME}.app`, 'Contents', 'Info.plist'), 'utf8');
}

function prepare(): string | undefined {
  return prepareMacDevBundle({ projectRoot, appName: APP_NAME, platform: 'darwin' });
}

describe('macOS development app bundle', () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'interleaf-dev-bundle-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('Info.plist rewriting', () => {
    it('rewrites every identity key', () => {
      const rewritten = applyPlistIdentity(STOCK_INFO_PLIST, devBundleIdentity(APP_NAME));

      expect(rewritten).toContain(`<key>CFBundleName</key>\n\t<string>${APP_NAME}</string>`);
      expect(rewritten).toContain(`<key>CFBundleDisplayName</key>\n\t<string>${APP_NAME}</string>`);
      // Must track the renamed executable file, or macOS cannot start the bundle.
      expect(rewritten).toContain(`<key>CFBundleExecutable</key>\n\t<string>${APP_NAME}</string>`);
      expect(rewritten).toContain(`<key>CFBundleIdentifier</key>\n\t<string>${DEV_BUNDLE_IDENTIFIER}</string>`);
      // macOS reads the bundle icon before the process runs, so this key, not a
      // runtime Dock call, is what stops the clone showing Electron artwork.
      expect(rewritten).toContain(`<key>CFBundleIconFile</key>\n\t<string>${APP_NAME}.icns</string>`);
      expect(rewritten).not.toContain('electron.icns');
      expect(rewritten).not.toContain('com.github.Electron');
    });

    it('escapes the value rather than injecting markup', () => {
      const identity = { ...devBundleIdentity(APP_NAME), CFBundleName: 'A & B' };

      expect(applyPlistIdentity(STOCK_INFO_PLIST, identity)).toContain('<string>A &amp; B</string>');
    });

    it('refuses a property list it cannot rewrite exactly once', () => {
      const identity = devBundleIdentity(APP_NAME);

      expect(() => applyPlistIdentity('<plist></plist>', identity)).toThrow(/CFBundle/);
      expect(() => applyPlistIdentity(STOCK_INFO_PLIST + STOCK_INFO_PLIST, identity)).toThrow();
    });
  });

  describe('paths', () => {
    it('names the generated bundle and executable after the product, not after Electron', () => {
      writeStockElectron('43.4.1');
      const paths = macDevBundlePaths(projectRoot, APP_NAME);

      expect(paths?.bundle).toBe(devBundlePath(`${APP_NAME}.app`));
      expect(paths?.executable).toBe(devBundlePath(`${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME));
      expect(paths?.sourceExecutableName).toBe('Electron');
      expect(paths?.bundle).not.toContain('node_modules');
    });

    it('reports nothing when the installed Electron is not an app bundle', () => {
      const electron = join(projectRoot, 'node_modules', 'electron');
      mkdirSync(electron, { recursive: true });
      writeFileSync(join(electron, 'path.txt'), 'electron', 'utf8');

      expect(macDevBundlePaths(projectRoot, APP_NAME)).toBeUndefined();
    });

    it('refuses a product name that is not a single safe path component', () => {
      writeStockElectron('43.4.1');

      expect(macDevBundlePaths(projectRoot, '../escape')).toBeUndefined();
      expect(macDevBundlePaths(projectRoot, 'a/b')).toBeUndefined();
      expect(macDevBundlePaths(projectRoot, '')).toBeUndefined();
    });
  });

  describe('preparation', () => {
    it('produces a bundle whose file system name is the product name', () => {
      writeStockElectron('43.4.1');

      const executable = prepare();

      // The directory name is the label macOS paints in the Dock tooltip.
      expect(executable).toBe(devBundlePath(`${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME));
      expect(existsSync(devBundlePath(`${APP_NAME}.app`))).toBe(true);
      expect(existsSync(devBundlePath('Electron.app'))).toBe(false);
      expect(existsSync(devBundlePath(`${APP_NAME}.app`, 'Contents', 'MacOS', 'Electron'))).toBe(false);
    });

    it('gives the bundle a development-only identity', () => {
      writeStockElectron('43.4.1');
      prepare();
      const plist = generatedInfoPlist();

      expect(plist).toContain(`<key>CFBundleName</key>\n\t<string>${APP_NAME}</string>`);
      expect(plist).toContain(`<key>CFBundleDisplayName</key>\n\t<string>${APP_NAME}</string>`);
      expect(plist).toContain(`<key>CFBundleExecutable</key>\n\t<string>${APP_NAME}</string>`);
      expect(plist).toContain(`<key>CFBundleIdentifier</key>\n\t<string>${DEV_BUNDLE_IDENTIFIER}</string>`);
      // Never the packaged identity itself, only a development sibling of it.
      expect(plist).not.toContain(`<string>${APP_ID}</string>`);
    });

    it('points the generated plist at an Interleaf icon copied from the app-owned resource', () => {
      writeStockElectron('43.4.1');

      prepare();

      expect(generatedInfoPlist()).toContain(`<key>CFBundleIconFile</key>\n\t<string>${APP_NAME}.icns</string>`);
      const copied = devBundlePath(`${APP_NAME}.app`, 'Contents', 'Resources', `${APP_NAME}.icns`);
      expect(existsSync(copied)).toBe(true);
      // Byte-identical to the checked-in artwork, not the stock Electron icon.
      expect(readFileSync(copied, 'utf8')).toBe(readFileSync(join(projectRoot, BRAND_ICNS_SOURCE), 'utf8'));
      expect(readFileSync(copied, 'utf8')).not.toBe('stock');
      // The app-owned source is read only.
      expect(readFileSync(join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Resources', 'electron.icns'), 'utf8')).toBe('stock');
    });

    it('rebuilds a clone that predates the icon, and after the artwork changes', () => {
      writeStockElectron('43.4.1');
      prepare();

      // A clone left by the pre-icon revision: right name, no icon.
      const iconInClone = devBundlePath(`${APP_NAME}.app`, 'Contents', 'Resources', `${APP_NAME}.icns`);
      rmSync(iconInClone);
      prepare();
      expect(existsSync(iconInClone)).toBe(true);

      const marker = devBundlePath(`${APP_NAME}.app`, 'stale');
      writeFileSync(marker, 'discard', 'utf8');
      writeBrandIcns('redrawn-artwork');
      const icon = statSync(join(projectRoot, BRAND_ICNS_SOURCE));
      utimesSync(join(projectRoot, BRAND_ICNS_SOURCE), icon.atime, new Date(icon.mtimeMs + 5_000));

      prepare();

      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(iconInClone, 'utf8')).toBe('redrawn-artwork');
    });

    it('falls back to the stock bundle when the app-owned icon is missing', () => {
      writeStockElectron('43.4.1');
      rmSync(join(projectRoot, BRAND_ICNS_SOURCE));
      const warnings: string[] = [];

      const executable = prepareMacDevBundle({
        projectRoot, appName: APP_NAME, platform: 'darwin', warn: (message) => warnings.push(message),
      });

      expect(executable).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it('leaves the installed Electron dependency untouched', () => {
      writeStockElectron('43.4.1');
      prepare();

      expect(readFileSync(sourceInfoPlistPath(), 'utf8')).toBe(STOCK_INFO_PLIST);
      expect(existsSync(join(projectRoot, 'node_modules', 'electron', 'dist', EXECUTABLE_SUB_PATH))).toBe(true);
    });

    it('replaces a clone left behind by an earlier layout', () => {
      writeStockElectron('43.4.1');
      mkdirSync(devBundlePath('Electron.app', 'Contents'), { recursive: true });
      writeFileSync(devBundlePath('Electron.app', 'Contents', 'Info.plist'), STOCK_INFO_PLIST, 'utf8');

      prepare();

      expect(existsSync(devBundlePath('Electron.app'))).toBe(false);
      expect(existsSync(devBundlePath(`${APP_NAME}.app`))).toBe(true);
    });

    it('reuses an existing clone', () => {
      writeStockElectron('43.4.1');
      prepare();
      const marker = devBundlePath(`${APP_NAME}.app`, 'reused');
      writeFileSync(marker, 'kept', 'utf8');

      prepare();

      expect(readFileSync(marker, 'utf8')).toBe('kept');
    });

    it('rebuilds the clone after the installed Electron changes', () => {
      writeStockElectron('43.4.1');
      prepare();
      const marker = devBundlePath(`${APP_NAME}.app`, 'stale');
      writeFileSync(marker, 'discard', 'utf8');

      writeFileSync(sourceInfoPlistPath(), `${STOCK_INFO_PLIST}<!-- newer -->`, 'utf8');
      const source = statSync(sourceInfoPlistPath());
      utimesSync(sourceInfoPlistPath(), source.atime, new Date(source.mtimeMs + 5_000));

      prepare();

      expect(existsSync(marker)).toBe(false);
    });

    it('does nothing off macOS', () => {
      writeStockElectron('43.4.1');

      expect(prepareMacDevBundle({ projectRoot, appName: APP_NAME, platform: 'win32' })).toBeUndefined();
    });

    it('falls back to the stock bundle instead of failing the run', () => {
      writeStockElectron('43.4.1');
      writeFileSync(sourceInfoPlistPath(), '<plist></plist>', 'utf8');
      const warnings: string[] = [];

      const executable = prepareMacDevBundle({
        projectRoot,
        appName: APP_NAME,
        platform: 'darwin',
        warn: (message) => warnings.push(message),
      });

      expect(executable).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });

  describe('electron-vite wiring', () => {
    afterEach(() => {
      delete process.env.ELECTRON_EXEC_PATH;
    });

    it('leaves a build alone', () => {
      writeStockElectron('43.4.1');

      applyMacDevAppIdentity(projectRoot, 'build');

      expect(process.env.ELECTRON_EXEC_PATH).toBeUndefined();
    });

    it('keeps an explicit developer override', () => {
      writeStockElectron('43.4.1');
      process.env.ELECTRON_EXEC_PATH = '/somewhere/else';

      applyMacDevAppIdentity(projectRoot, 'serve');

      expect(process.env.ELECTRON_EXEC_PATH).toBe('/somewhere/else');
    });
  });

  describe('staleness', () => {
    it('treats a missing bundle or a different source as out of date', () => {
      const identity = devBundleIdentity(APP_NAME);
      const base = { electronVersion: '43.4.1', sourceSize: 10, sourceModifiedMs: 1, iconSize: 20, iconModifiedMs: 2 };
      const expected = devBundleStamp({ identity, ...base });
      const newerElectron = devBundleStamp({ identity, ...base, electronVersion: '44.0.0' });
      const otherIdentity = devBundleStamp({ identity: { ...identity, CFBundleExecutable: 'Electron' }, ...base });
      const newerIcon = devBundleStamp({ identity, ...base, iconModifiedMs: 3 });

      expect(devBundleIsCurrent({ bundleExists: true, recordedStamp: expected, expectedStamp: expected })).toBe(true);
      expect(devBundleIsCurrent({ bundleExists: false, recordedStamp: expected, expectedStamp: expected })).toBe(false);
      expect(devBundleIsCurrent({ bundleExists: true, recordedStamp: newerElectron, expectedStamp: expected })).toBe(false);
      expect(devBundleIsCurrent({ bundleExists: true, recordedStamp: otherIdentity, expectedStamp: expected })).toBe(false);
      expect(devBundleIsCurrent({ bundleExists: true, recordedStamp: newerIcon, expectedStamp: expected })).toBe(false);
      expect(devBundleIsCurrent({ bundleExists: true, recordedStamp: undefined, expectedStamp: expected })).toBe(false);
    });
  });
});
