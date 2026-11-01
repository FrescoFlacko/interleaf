import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { captureWindowPng, launchInterleaf, type AppHandle } from './helpers';
import { e2eBackgroundWindows } from './offline-environment';
import { activations, countActivations, expectBackgroundWindow, focusState, type FocusCounters, type FocusState } from './background-window-state';

/**
 * The suite's windows open in the background (`INTERLEAF_E2E_BACKGROUND`, set
 * centrally in `offline-environment.ts`): rendered and visible like a real
 * launch, but never made key and never activating the app, so a run neither
 * takes the keyboard nor covers the work of whoever is using the machine. Page
 * input still arrives, because Playwright delivers it to the page rather than
 * through the operating system. Maximized geometry is not asserted here: the
 * owner retired that E2E coverage.
 *
 * This is the portable contract, read back from Electron's own window state on
 * every host. Each OS's own evidence lives in its native project: the window
 * server's stacking list, the frontmost app, the Dock and window recreation in
 * `platform/macos/background-window.macos.spec.ts`; the X server's input focus,
 * map state and a second-instance reveal in
 * `platform/linux/background-window.linux.spec.ts`.
 */

type Painting = { readonly visibilityState: DocumentVisibilityState; readonly hidden: boolean; readonly frames: number };

type CanaryEvidence = {
  readonly electronPid: number;
  readonly checkpoints: Record<string, { readonly state: FocusState }>;
  painting?: Painting;
  activations?: FocusCounters | undefined;
};

test.describe('E2E windows open in the background', () => {
  test.skip(!e2eBackgroundWindows(), 'INTERLEAF_E2E_BACKGROUND=0 runs this suite in the foreground.');

  let app: AppHandle | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test('opens, takes page input and re-reveals its window in the background without focusing or activating the app', async ({}, testInfo) => {
    test.setTimeout(90_000);
    app = await launchInterleaf();
    const { electronApp } = app;
    const electronPid = electronApp.process().pid;
    if (electronPid === undefined) throw new Error('no Electron pid');
    const evidence: CanaryEvidence = { electronPid, checkpoints: {} };

    const expectInBackground = async (label: string): Promise<void> => {
      const state = await focusState(electronApp);
      expectBackgroundWindow(state);
      evidence.checkpoints[label] = { state };
    };

    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
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

    // An activation with the window open brings it back without making it key.
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expectInBackground('activatedExisting');

    // A hidden window is ordered back in without activating the app.
    await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(false);
    await electronApp.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await expect.poll(async () => (await focusState(electronApp)).visible).toBe(true);
    await expectInBackground('reRevealedHidden');

    evidence.activations = await activations(electronApp);
    expect(evidence.activations).toEqual({ browserWindowFocus: 0, becameActive: 0 });
    writeFileSync(testInfo.outputPath('background-focus.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  });
});
