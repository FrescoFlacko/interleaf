import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_NAME } from '@shared/constants/brand';

/**
 * The application name has to be established before the profile decision, not
 * inside `bootstrap()`.
 *
 * Electron derives the default `userData` location from the app name, and the
 * pre-rebrand profile adoption runs at module load, long before `app.ready`.
 * Naming the process only once bootstrap is running leaves that decision to
 * whatever name the process happened to start with, so the ordering below is
 * the contract, not an implementation detail.
 *
 * This is the internal Electron name only. The Dock/menu name macOS shows is
 * fixed by the bundle the process was launched from and is covered by
 * `mac-dev-bundle.spec.ts`.
 */

const calls: string[] = [];

vi.mock('electron', () => ({
  app: {
    setName: (name: string) => { calls.push(`setName:${name}`); },
    setPath: (key: string) => { calls.push(`setPath:${key}`); },
    getPath: (key: string) => {
      calls.push(`getPath:${key}`);
      return appDataRoot;
    },
    isPackaged: false,
    dock: { setIcon: (path: string) => { calls.push(`setIcon:${path}`); } },
  },
}));

// The raster lookup itself is covered by the brand-icon tests; here only the
// packaged/development decision is under test.
vi.mock('@main/app/brand-icon', () => ({
  defaultBrandIconPath: () => brandIconPath,
}));

let appDataRoot = '';
const brandIconPath = '/app-owned/resources/icon.png';

const {
  applyBrandIdentity,
  applyDevelopmentDockIcon,
  applyEarlyStartupIdentity,
  runtimePackagingSignals,
} = await import('@main/app/brand-startup');
const { isDevelopmentRun } = await import('@main/app/runtime-packaging');

/**
 * The development Dock icon must survive the renamed development bundle.
 *
 * Electron derives `app.isPackaged` from the executable's file name, and the
 * development clone's executable is deliberately called `Interleaf`, so that
 * flag alone reports a development run as packaged and would skip the icon.
 * `process.defaultApp` is the signal the rename cannot move.
 */
describe('development run detection', () => {
  it('treats the stock bundle and the renamed development clone as development', () => {
    // Stock `Electron` executable, launched with an app path.
    expect(isDevelopmentRun({ isPackaged: false, defaultApp: true })).toBe(true);
    // The renamed dev clone: Electron calls this "packaged".
    expect(isDevelopmentRun({ isPackaged: true, defaultApp: true })).toBe(true);
    // A real packaged build keeps its own bundled icon.
    expect(isDevelopmentRun({ isPackaged: true, defaultApp: false })).toBe(false);
    // A packaged run leaves the flag unset rather than false.
    expect(isDevelopmentRun({ isPackaged: true, defaultApp: undefined })).toBe(false);
  });
});

describe('development Dock icon', () => {
  beforeEach(() => { calls.length = 0; });

  it('applies the Interleaf raster to the renamed development clone', () => {
    applyDevelopmentDockIcon({ isPackaged: true, defaultApp: true });

    expect(calls).toEqual([`setIcon:${brandIconPath}`]);
  });

  it('leaves a packaged build to its own bundled icon', () => {
    applyDevelopmentDockIcon({ isPackaged: true, defaultApp: false });

    expect(calls).toEqual([]);
  });

  it('reads its signals from this process', () => {
    // `defaultApp` is unset outside Electron, exactly as in a packaged run.
    expect(runtimePackagingSignals()).toEqual({ isPackaged: false, defaultApp: process.defaultApp });
  });
});

describe('early startup identity', () => {
  beforeEach(() => {
    calls.length = 0;
    appDataRoot = mkdtempSync(join(tmpdir(), 'interleaf-appdata-'));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    rmSync(appDataRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('names the process with the brand name', () => {
    applyBrandIdentity();
    expect(calls).toEqual([`setName:${APP_NAME}`]);
  });

  it('names the process before the isolated profile override is applied', () => {
    vi.stubEnv('INTERLEAF_USER_DATA', join(appDataRoot, 'isolated'));

    const decision = applyEarlyStartupIdentity();

    expect(decision.kind).toBe('continue');
    expect(calls).toEqual([`setName:${APP_NAME}`, 'setPath:userData']);
  });

  it('names the process before the default profile location is resolved', () => {
    const decision = applyEarlyStartupIdentity();

    expect(decision.kind).toBe('continue');
    expect(calls[0]).toBe(`setName:${APP_NAME}`);
    expect(calls).toContain('getPath:appData');
    expect(calls.indexOf(`setName:${APP_NAME}`)).toBeLessThan(calls.indexOf('getPath:appData'));
  });
});
