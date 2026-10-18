import { expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureWindowPng, launchInterleaf, type AppHandle } from './helpers';
import { e2eBackgroundWindows } from './offline-environment';

/**
 * The suite's windows open in the background (`INTERLEAF_E2E_BACKGROUND`, set
 * centrally in `offline-environment.ts`): rendered, visible and maximized to
 * the display's work area exactly like a real launch, but never made key,
 * never activating the app and — on macOS — one native level below every
 * ordinary window, so a run neither takes the keyboard nor covers the work of
 * whoever is using the machine. Page input still arrives, because Playwright
 * delivers it to the page rather than through the operating system.
 *
 * Focus and stacking are read back from Electron's native window state and,
 * on macOS, from the system's own records — the frontmost application and
 * CoreGraphics' on-screen window list — not from a mock.
 */

type Rect = { x: number; y: number; width: number; height: number };

type FocusState = {
  readonly windowCount: number;
  readonly focusedWindowExists: boolean;
  readonly windowFocused: boolean;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  readonly bounds: Rect;
  readonly workArea: Rect;
  readonly dockVisible: boolean | null;
  /** The CoreGraphics window number, from `window:<number>:0`. */
  readonly windowNumber: number | null;
};

type FocusCounters = { browserWindowFocus: number; becameActive: number };
type CounterScope = typeof globalThis & { __interleafFocusCounters?: FocusCounters };

async function focusState(electronApp: ElectronApplication): Promise<FocusState> {
  return electronApp.evaluate(({ app, BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows();
    const [win] = windows;
    if (win === undefined) throw new Error('no main window');
    const bounds = win.getBounds();
    const mediaSource = /^window:(\d+):/u.exec(win.getMediaSourceId());
    return {
      windowCount: windows.length,
      focusedWindowExists: BrowserWindow.getFocusedWindow() !== null,
      windowFocused: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      bounds,
      workArea: screen.getDisplayMatching(bounds).workArea,
      dockVisible: app.dock === undefined ? null : app.dock.isVisible(),
      windowNumber: mediaSource?.[1] === undefined ? null : Number(mediaSource[1]),
    };
  });
}

/** Counts every activation main observes from here on. */
async function countActivations(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app }) => {
    const counters: FocusCounters = { browserWindowFocus: 0, becameActive: 0 };
    (globalThis as CounterScope).__interleafFocusCounters = counters;
    app.on('browser-window-focus', () => { counters.browserWindowFocus += 1; });
    app.on('did-become-active', () => { counters.becameActive += 1; });
  });
}

async function activations(electronApp: ElectronApplication): Promise<FocusCounters | undefined> {
  return electronApp.evaluate(() => (globalThis as CounterScope).__interleafFocusCounters);
}

/**
 * The process macOS reports as the frontmost application, read with the
 * read-only `lsappinfo` query. Fails rather than answering nothing on macOS,
 * so a broken query cannot make "the app is not frontmost" pass.
 */
function frontmostPid(): number {
  const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 5_000 }).trim();
  const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8', timeout: 5_000 });
  const match = /"pid"\s*=\s*(\d+)/u.exec(info);
  if (match?.[1] === undefined) throw new Error(`lsappinfo reported no frontmost pid: ${JSON.stringify(info)}`);
  return Number(match[1]);
}

type CgWindow = {
  readonly index: number;
  readonly pid: number;
  readonly number: number;
  readonly layer: number;
  readonly bounds: { readonly X: number; readonly Y: number; readonly Width: number; readonly Height: number };
};

type WindowOrder = {
  readonly window: CgWindow;
  /** Ordinary (layer 0) windows of other applications that overlap the test window. */
  readonly overlappingOrdinary: readonly CgWindow[];
};

/** What one checkpoint observed: native state and, on macOS, the frontmost app and stacking. */
type Checkpoint = {
  readonly state: FocusState;
  readonly frontmostPid?: number;
  readonly window?: CgWindow;
  readonly overlappingOrdinaryCount?: number;
  readonly overlappingOrdinaryIndices?: readonly number[];
};

type Painting = { readonly visibilityState: DocumentVisibilityState; readonly hidden: boolean; readonly frames: number };

type CanaryEvidence = {
  readonly electronPid: number;
  readonly checkpoints: Record<string, Checkpoint>;
  painting?: Painting;
  activations?: FocusCounters | undefined;
};

function overlaps(a: CgWindow['bounds'], b: CgWindow['bounds']): boolean {
  return a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;
}

/**
 * Where macOS has stacked the test window, from the compiled read-only
 * `tests/fixtures/window-order.swift` (CoreGraphics lists on-screen windows
 * front to back).
 */
function windowOrder(helper: string, electronPid: number, windowNumber: number): WindowOrder {
  const all = JSON.parse(execFileSync(helper, { encoding: 'utf8', timeout: 10_000 })) as CgWindow[];
  const window = all.find((entry) => entry.number === windowNumber && entry.pid === electronPid);
  if (window === undefined) throw new Error(`window ${String(windowNumber)} is not on screen`);
  return {
    window,
    overlappingOrdinary: all.filter((entry) => entry.layer === 0 && entry.pid !== electronPid && overlaps(entry.bounds, window.bounds)),
  };
}

function expectBackgroundWindow(state: FocusState): void {
  expect(state).toMatchObject({
    windowCount: 1,
    focusedWindowExists: false,
    windowFocused: false,
    visible: true,
    minimized: false,
    maximized: true,
    fullScreen: false,
  });
  // The same maximized geometry a real launch has.
  expect(state.bounds).toEqual(state.workArea);
  if (process.platform === 'darwin') expect(state.dockVisible).toBe(false);
}

test.describe('E2E windows open in the background', () => {
  test.skip(!e2eBackgroundWindows(), 'INTERLEAF_E2E_BACKGROUND=0 runs this suite in the foreground.');

  let app: AppHandle | undefined;
  let helperDir: string | undefined;
  let orderHelper: string | undefined;

  test.beforeAll(() => {
    if (process.platform !== 'darwin') return;
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

  test('launches, takes page input and recreates its window behind ordinary windows without activating the app', async ({}, testInfo) => {
    test.setTimeout(90_000);
    app = await launchInterleaf();
    const { electronApp } = app;
    const electronPid = electronApp.process().pid;
    if (electronPid === undefined) throw new Error('no Electron pid');
    const evidence: CanaryEvidence = { electronPid, checkpoints: {} };

    /** Native window state, plus on macOS the frontmost app and the window's layer and stacking. */
    const expectInBackground = async (label: string): Promise<void> => {
      const state = await focusState(electronApp);
      expectBackgroundWindow(state);
      if (process.platform !== 'darwin' || orderHelper === undefined) {
        evidence.checkpoints[label] = { state };
        return;
      }
      const front = frontmostPid();
      expect(front).not.toBe(electronPid);
      expect(state.windowNumber).not.toBeNull();
      const helper = orderHelper;
      const nativeBounds = (): Rect => {
        const { X, Y, Width, Height } = windowOrder(helper, electronPid, state.windowNumber ?? -1).window.bounds;
        return { x: X, y: Y, width: Width, height: Height };
      };
      // The system's own geometry, once any show animation has settled.
      await expect.poll(nativeBounds).toEqual(state.workArea);
      const order = windowOrder(helper, electronPid, state.windowNumber ?? -1);
      // One level below ordinary windows, and behind every one that overlaps it.
      expect(order.window.layer).toBe(-1);
      for (const ordinary of order.overlappingOrdinary) expect(ordinary.index).toBeLessThan(order.window.index);
      evidence.checkpoints[label] = {
        state,
        frontmostPid: front,
        window: order.window,
        overlappingOrdinaryCount: order.overlappingOrdinary.length,
        overlappingOrdinaryIndices: order.overlappingOrdinary.map((entry) => entry.index),
      };
    };

    await expect.poll(async () => (await focusState(electronApp)).maximized).toBe(true);
    await expectInBackground('launched');
    await countActivations(electronApp);

    // Page input is delivered to the page, so it works without native focus.
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    const search = app.window.getByTestId('library-search-input');
    await search.click();
    await app.window.keyboard.type('background canary');
    await expect(search).toHaveValue('background canary');
    await expect(search).toBeFocused();
    await app.window.keyboard.press('Backspace');
    await expect(search).toHaveValue('background canar');
    await captureWindowPng(app, testInfo.outputPath('background-launch.png'));
    await expectInBackground('afterInput');

    // Behind the user's windows the page is still visible and still painting:
    // the window is not occlusion-throttled into a hidden, frozen page.
    const painting: Painting = await app.window.evaluate(async () => {
      let frames = 0;
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          frames += 1;
          if (performance.now() - start < 1_000) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return { visibilityState: document.visibilityState, hidden: document.hidden, frames };
    });
    expect(painting).toMatchObject({ visibilityState: 'visible', hidden: false });
    expect(painting.frames).toBeGreaterThan(30);
    evidence.painting = painting;

    // A Dock click or second launch with the window open brings it back
    // without making it key or lifting it.
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expectInBackground('activatedExisting');

    // A hidden window is ordered back in at the same level.
    await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(false);
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectInBackground('reRevealedHidden');

    // On macOS closing the last window keeps the app; activation recreates it
    // through the same background reveal.
    if (process.platform === 'darwin') {
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.close();
      });
      await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
      const reopened = electronApp.waitForEvent('window');
      await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
      const page = await reopened;
      await page.waitForLoadState('domcontentloaded');
      await expect.poll(async () => (await focusState(electronApp)).maximized).toBe(true);
      await expectInBackground('recreated');
      const png = await electronApp.evaluate(async ({ BrowserWindow }) => {
        const [win] = BrowserWindow.getAllWindows();
        if (win === undefined) return null;
        return Array.from((await win.webContents.capturePage()).toPNG());
      });
      expect(png?.length ?? 0).toBeGreaterThan(2048);
      writeFileSync(testInfo.outputPath('background-recreated.png'), Buffer.from(png ?? []));
    }

    evidence.activations = await activations(electronApp);
    expect(evidence.activations).toEqual({ browserWindowFocus: 0, becameActive: 0 });
    writeFileSync(testInfo.outputPath('background-focus.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  });
});
