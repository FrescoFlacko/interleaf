import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchInterleaf, type AppHandle } from '../../helpers';
import { e2eBackgroundWindows } from '../../offline-environment';
import { activations, countActivations, expectBackgroundWindow, focusState, type FocusState } from '../../background-window-state';
import { MACOS_NATIVE_DEFERRED, macosNativeDeferred, requireNativeHost } from '../native-host';

/**
 * macOS evidence for the background reveal, from the system's own records:
 * the frontmost application (`lsappinfo`), CoreGraphics' on-screen window
 * list (`tests/fixtures/window-order.swift`, compiled with the system
 * `swiftc`) and the Dock. Each test window sits one native level below
 * ordinary windows and behind every one that overlaps it, across launch,
 * input, activation, hidden re-reveal and the macOS-only recreation after the
 * last window closes. The portable contract (no focus, input, painting) is
 * `tests/e2e/background-window.spec.ts`, which also runs on macOS.
 */

type CgWindow = {
  readonly index: number;
  readonly pid: number;
  readonly number: number;
  readonly layer: number;
  readonly bounds: { readonly X: number; readonly Y: number; readonly Width: number; readonly Height: number };
};

type WindowOrder = { readonly window: CgWindow; readonly overlappingOrdinary: readonly CgWindow[] };

type Checkpoint = {
  readonly state: FocusState;
  readonly frontmostPid: number;
  readonly window: CgWindow;
  readonly overlappingOrdinaryCount: number;
  readonly overlappingOrdinaryIndices: readonly number[];
};

/**
 * The process macOS reports as the frontmost application, read with the
 * read-only `lsappinfo` query. Fails rather than answering nothing, so a
 * broken query cannot make "the app is not frontmost" pass.
 */
function frontmostPid(): number {
  const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 5_000 }).trim();
  const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8', timeout: 5_000 });
  const match = /"pid"\s*=\s*(\d+)/u.exec(info);
  if (match?.[1] === undefined) throw new Error(`lsappinfo reported no frontmost pid: ${JSON.stringify(info)}`);
  return Number(match[1]);
}

function overlaps(a: CgWindow['bounds'], b: CgWindow['bounds']): boolean {
  return a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;
}

/** Where macOS has stacked the test window (CoreGraphics lists on-screen windows front to back). */
function windowOrder(helper: string, electronPid: number, windowNumber: number): WindowOrder {
  const all = JSON.parse(execFileSync(helper, { encoding: 'utf8', timeout: 10_000 })) as CgWindow[];
  const window = all.find((entry) => entry.number === windowNumber && entry.pid === electronPid);
  if (window === undefined) throw new Error(`window ${String(windowNumber)} is not on screen`);
  return {
    window,
    overlappingOrdinary: all.filter((entry) => entry.layer === 0 && entry.pid !== electronPid && overlaps(entry.bounds, window.bounds)),
  };
}

test.describe('macOS background windows: frontmost app, window level, stacking and the Dock', () => {
  test.skip(macosNativeDeferred(), MACOS_NATIVE_DEFERRED);
  test.skip(!e2eBackgroundWindows(), 'INTERLEAF_E2E_BACKGROUND=0 runs this suite in the foreground.');

  let app: AppHandle | undefined;
  let helperDir: string | undefined;
  let orderHelper = '';

  test.beforeAll(() => {
    requireNativeHost('darwin');
    helperDir = mkdtempSync(path.join(os.tmpdir(), 'interleaf-window-order-'));
    orderHelper = path.join(helperDir, 'window-order');
    execFileSync('/usr/bin/swiftc', ['-O', path.join('tests', 'fixtures', 'window-order.swift'), '-o', orderHelper], {
      timeout: 120_000,
      stdio: 'pipe',
    });
  });

  test.afterAll(() => {
    if (helperDir !== undefined) rmSync(helperDir, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test('keeps the app out of the front and its window below ordinary windows, through input, activation, re-reveal and recreation', async ({}, testInfo) => {
    test.setTimeout(90_000);
    app = await launchInterleaf();
    const { electronApp } = app;
    const electronPid = electronApp.process().pid;
    if (electronPid === undefined) throw new Error('no Electron pid');
    const checkpoints: Record<string, Checkpoint> = {};

    const expectBehindOrdinaryWindows = async (label: string): Promise<void> => {
      const state = await focusState(electronApp);
      expectBackgroundWindow(state);
      expect(state.dockVisible).toBe(false);
      const front = frontmostPid();
      expect(front).not.toBe(electronPid);
      expect(state.windowNumber).not.toBeNull();
      // One level below ordinary windows, once the system lists it on screen,
      // and behind every ordinary window that overlaps it.
      await expect.poll(() => windowOrder(orderHelper, electronPid, state.windowNumber ?? -1).window.layer).toBe(-1);
      const order = windowOrder(orderHelper, electronPid, state.windowNumber ?? -1);
      for (const ordinary of order.overlappingOrdinary) expect(ordinary.index).toBeLessThan(order.window.index);
      checkpoints[label] = {
        state,
        frontmostPid: front,
        window: order.window,
        overlappingOrdinaryCount: order.overlappingOrdinary.length,
        overlappingOrdinaryIndices: order.overlappingOrdinary.map((entry) => entry.index),
      };
    };

    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectBehindOrdinaryWindows('launched');
    await countActivations(electronApp);

    await expect(app.window.getByTestId('library-view')).toBeVisible();
    const search = app.window.getByTestId('library-search-input');
    await search.click();
    await app.window.keyboard.type('background canary');
    await expect(search).toHaveValue('background canary');
    await expectBehindOrdinaryWindows('afterInput');

    // A Dock click or second launch with the window open brings it back
    // without making it key or lifting it.
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expectBehindOrdinaryWindows('activatedExisting');

    // A hidden window is ordered back in at the same level.
    await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(false);
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectBehindOrdinaryWindows('reRevealedHidden');

    // On macOS closing the last window keeps the app; activation recreates it
    // through the same background reveal.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    const reopened = electronApp.waitForEvent('window');
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    const page = await reopened;
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectBehindOrdinaryWindows('recreated');
    const png = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (win === undefined) return null;
      return Array.from((await win.webContents.capturePage()).toPNG());
    });
    expect(png?.length ?? 0).toBeGreaterThan(2048);
    writeFileSync(testInfo.outputPath('background-recreated.png'), Buffer.from(png ?? []));

    const counted = await activations(electronApp);
    expect(counted).toEqual({ browserWindowFocus: 0, becameActive: 0 });
    writeFileSync(testInfo.outputPath('background-macos.json'), `${JSON.stringify({ electronPid, checkpoints, activations: counted }, null, 2)}\n`);
  });
});
