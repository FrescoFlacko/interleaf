import { expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchInterleaf, type AppHandle } from '../../helpers';
import { ISOLATED_ELECTRON_SWITCHES, e2eBackgroundWindows, isolatedLaunchEnvironment } from '../../offline-environment';
import { activations, countActivations, expectBackgroundWindow, focusState } from '../../background-window-state';
import { requireNativeHost } from '../native-host';

/**
 * Linux evidence for the background reveal, from the X server itself rather
 * than Electron's view of it: the window the X server gives input focus to
 * (XGetInputFocus) never becomes the app's window, and the window is mapped
 * and viewable (XGetWindowAttributes), read by `tests/fixtures/x11-window-state.py`.
 * On Linux an existing window is brought back by a second launch (closing the
 * last window quits the app), so a real second instance with the same
 * userData is started and must reveal the window without activating it.
 *
 * There is no Linux counterpart to macOS's below-normal window level or Dock:
 * the product applies those on macOS only. This runs on X11 (the Ozone backend
 * Playwright starts Electron with) and needs no window manager.
 */

type XWindowState = { readonly focus: string; readonly focus_in_window: boolean; readonly map_state: string };

const X11_WINDOW_STATE = path.join(__dirname, '..', '..', '..', 'fixtures', 'x11-window-state.py');
/** The Electron binary the suite already launches, on Linux. */
const ELECTRON_BINARY = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron');

function displayName(): string {
  const display = process.env.DISPLAY;
  if (display === undefined) throw new Error('DISPLAY is unset; the platform preflight should have failed first');
  return display;
}

/** The X11 window id behind the app's only window. */
async function windowXid(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const handle = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
    if (handle === undefined) throw new Error('no main window');
    return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
  });
}

function xWindowState(xid: string): XWindowState {
  const output = execFileSync('/usr/bin/python3', ['-I', X11_WINDOW_STATE, displayName(), xid], { encoding: 'utf8', timeout: 10_000 });
  return JSON.parse(output) as XWindowState;
}

/** Starts a second instance with the first one's userData; it hands over to the first and exits. */
function launchSecondInstance(userDataDir: string): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'interleaf-e2e-second-home-'));
  try {
    execFileSync(ELECTRON_BINARY, [...ISOLATED_ELECTRON_SWITCHES, 'out/main/index.js'], {
      env: { ...isolatedLaunchEnvironment({ isolatedHome: home }), NODE_ENV: 'test', INTERLEAF_USER_DATA: userDataDir },
      stdio: 'ignore',
      timeout: 30_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test.describe('Linux background windows: X input focus, map state and second-instance reveal', () => {
  test.skip(!e2eBackgroundWindows(), 'INTERLEAF_E2E_BACKGROUND=0 runs this suite in the foreground.');

  let app: AppHandle | undefined;

  test.beforeAll(() => {
    requireNativeHost('linux');
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test('never gives the app X input focus, through launch, page input and second-instance reveals of a shown and a hidden window', async ({}, testInfo) => {
    test.setTimeout(90_000);
    app = await launchInterleaf();
    const { electronApp } = app;
    const checkpoints: Record<string, { readonly x: XWindowState; readonly secondInstances: number }> = {};
    await electronApp.evaluate(({ app: electronApp }) => {
      const scope = globalThis as typeof globalThis & { __interleafSecondInstances?: number };
      scope.__interleafSecondInstances = 0;
      electronApp.on('second-instance', () => { scope.__interleafSecondInstances = (scope.__interleafSecondInstances ?? 0) + 1; });
    });
    const secondInstances = (): Promise<number> => electronApp.evaluate(() => (globalThis as typeof globalThis & { __interleafSecondInstances?: number }).__interleafSecondInstances ?? 0);

    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    const xid = await windowXid(electronApp);
    const expectUnfocusedOnX = async (label: string): Promise<void> => {
      expectBackgroundWindow(await focusState(electronApp));
      await expect.poll(() => xWindowState(xid).map_state).toBe('IsViewable');
      const x = xWindowState(xid);
      expect(x.focus_in_window, `${label}: X input focus ${x.focus} is the app window`).toBe(false);
      checkpoints[label] = { x, secondInstances: await secondInstances() };
    };

    await expectUnfocusedOnX('launched');
    await countActivations(electronApp);

    // Page input reaches the page without the X server focusing the window.
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    const search = app.window.getByTestId('library-search-input');
    await search.click();
    await app.window.keyboard.type('background canary');
    await expect(search).toHaveValue('background canary');
    await expectUnfocusedOnX('afterInput');

    // A second launch while the window is shown hands over and leaves it unfocused.
    launchSecondInstance(app.userDataDir);
    await expect.poll(secondInstances).toBe(1);
    await expectUnfocusedOnX('secondInstanceShown');

    // A second launch while the window is hidden maps it again, still unfocused.
    await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(false);
    await expect.poll(() => xWindowState(xid).map_state).not.toBe('IsViewable');
    launchSecondInstance(app.userDataDir);
    await expect.poll(secondInstances).toBe(2);
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectUnfocusedOnX('secondInstanceHidden');

    const counted = await activations(electronApp);
    expect(counted).toEqual({ browserWindowFocus: 0, becameActive: 0 });
    writeFileSync(testInfo.outputPath('background-linux.json'), `${JSON.stringify({ xid, checkpoints, activations: counted }, null, 2)}\n`);
  });
});
