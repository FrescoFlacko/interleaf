import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle, openCompanionPanel } from './helpers';
import { installIntentRecorder, type IntentRecording, type IntentSpec } from './drawer-intent-recorder';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Defect 22 (docs/defects/22-drawer-open-close-transitions) frame-sampled
 * regressions in the real Electron window. Static screenshots cannot prove
 * timing, so each check samples discrete frames across a toggle:
 *   - desktop panes commit their width once, never animating it per frame;
 *     opening slides the content 20px and fades it in over ~200ms, closing
 *     fades it out over ~100ms before the width is released,
 *   - compact drawers travel by translateX over a fading backdrop (~280ms),
 *   - horizontal overflow stays contained on every sampled frame,
 *   - reduced motion is materially faster than measured normal motion,
 *   - focus never drops to BODY or an inert/hidden element during a switch,
 *   - PDF keeps one attached canvas per painted page through a toggle.
 */

const SETTLE_MS = 650;
/** How long a recorder waits for the action it was armed for. */
const ARM_DEADLINE_MS = 5_000;
const MIN_CORE_SPAN_MS = 60;
/** Product-fixed durations each sampled transition must match (~±40ms). */
const EXPECTED_PANEL_MS = 200;
const EXPECTED_PANEL_EXIT_MS = 100;
const EXPECTED_DRAWER_MS = 280;
const TRANSFORM_OR_ALL = /(^|,) ?(transform|all)( |,|$)/;

type Frame = {
  readonly t: number;
  readonly w: number;
  /** Horizontal travel of the panel's content, in px. */
  readonly tx: number;
  /** Opacity of the panel's content. */
  readonly op: number;
  readonly trProp: string;
  readonly trDur: string;
  readonly overflowX: number;
};

type PhaseResult = {
  readonly coreSpanMs: number;
  readonly strictIntermediates: number;
  readonly transitionPropertyIncludesTransform: boolean;
  readonly transitionDurationNearPanel: boolean;
  readonly directionOk: boolean;
  /** Distinct panel widths seen strictly between the two resting widths. */
  readonly intermediateWidths: number;
};

/**
 * Times, inside the renderer, a real click on `toggleTestId` until
 * `panelTestId` is hidden in Playwright's own sense of `toBeHidden()`: an empty
 * bounding box, or a computed `visibility` other than `visible`. Measuring in
 * the page keeps the test driver's CDP round-trips and `toBeHidden()` polling
 * gaps out of the duration, so a loaded machine cannot make a fast close look
 * slow. Arm it, click with Playwright, wait for `toBeHidden()`, then read it.
 *
 * The start is a capture-phase window listener for that click, so it runs
 * before React's root handler. The end is checked on every attribute or style
 * mutation in the panel and on every animation frame; the first check that
 * sees it hidden stops both, and a 5 s backstop stops them if it never hides.
 */
async function armHideTimer(app: AppHandle, toggleTestId: string, panelTestId: string): Promise<() => Promise<number>> {
  const timing = await app.window.evaluateHandle(({ toggleId, panelId }) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelId}"]`);
    if (panel === null) throw new Error(`No ${panelId} to time.`);
    const state = { clickedAt: null as number | null, hiddenAt: null as number | null, stopped: false };
    let frame = 0;
    const isHidden = (): boolean => {
      const box = panel.getBoundingClientRect();
      return box.width === 0 || box.height === 0 || getComputedStyle(panel).visibility !== 'visible';
    };
    const stop = (): void => {
      state.stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(backstop);
      window.removeEventListener('click', onClick, true);
    };
    const check = (): void => {
      if (state.clickedAt === null || state.stopped) return;
      if (isHidden()) {
        state.hiddenAt = performance.now();
        stop();
      }
    };
    const onFrame = (): void => {
      check();
      if (!state.stopped) frame = requestAnimationFrame(onFrame);
    };
    const onClick = (event: MouseEvent): void => {
      if (state.clickedAt !== null) return;
      if (!(event.target instanceof Element) || event.target.closest(`[data-testid="${toggleId}"]`) === null) return;
      state.clickedAt = performance.now();
      frame = requestAnimationFrame(onFrame);
    };
    const observer = new MutationObserver(check);
    observer.observe(panel, { attributes: true, subtree: true });
    window.addEventListener('click', onClick, true);
    const backstop = window.setTimeout(stop, 5_000);
    return state;
  }, { toggleId: toggleTestId, panelId: panelTestId });
  return async () => {
    const { clickedAt, hiddenAt, stopped } = await timing.evaluate((state) => ({ ...state }));
    await timing.dispose();
    expect(stopped, 'the hide timer stopped observing').toBe(true);
    if (clickedAt === null || hiddenAt === null) throw new Error('The hide timer saw no click, or the panel never hid.');
    return hiddenAt - clickedAt;
  };
}

async function withApp(run: (app: AppHandle) => Promise<void>): Promise<void> {
  const app = await launchInterleaf();
  await openCompanionPanel(app);
  try {
    await run(app);
  } finally {
    await app.window.emulateMedia({ reducedMotion: null });
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function zoomToCompact(app: AppHandle, side: 'left' | 'right'): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
  });
  await expect
    .poll(async () => app.window.getByTestId(`toggle-${side}-panel`).getAttribute('aria-controls'))
    .toBe(`compact-drawer-${side}`);
}

async function drawerOffset(drawer: Locator): Promise<number> {
  return drawer.evaluate((node) => {
    const raw = getComputedStyle(node).transform;
    return raw === 'none' ? 0 : Math.abs(new DOMMatrixReadOnly(raw).m41);
  });
}

/**
 * Records a panel toggle: one baseline sample of the resting panel, then every
 * frame and state change for SETTLE_MS from the action itself (the trusted
 * click on the toggle, or the shortcut chord), so the time the driver spends
 * delivering the action is not taken out of the window. Nothing seen after the
 * window counts, and overflow must stay clean on every sample.
 */
async function recordToggle(
  app: AppHandle,
  selector: string,
  intent: IntentSpec,
  act: () => Promise<void>,
): Promise<{ readonly frames: readonly Frame[]; readonly recording: IntentRecording }> {
  const recorder = await app.window.evaluateHandle(installIntentRecorder, { selector, intent, windowMs: SETTLE_MS, armDeadlineMs: ARM_DEADLINE_MS });
  try {
    await act();
    await expect
      .poll(async () => recorder.evaluate((state) => state.status), { message: 'the action arrived and its window ended' })
      .toBe('done');
    const recording = await recorder.evaluate((state): IntentRecording => ({
      status: state.status,
      baseline: state.baseline,
      intentAt: state.intentAt,
      frames: state.frames,
      fadeEndAt: state.fadeEndAt,
      lateCallbacks: state.lateCallbacks,
    }));
    // Kept with the test's output, so a failing check can be read against every sample.
    writeFileSync(test.info().outputPath(`recording-${String(Math.round(recording.intentAt ?? 0))}.json`), JSON.stringify(recording, null, 1));
    const frames: Frame[] = [];
    for (const sample of [recording.baseline, ...recording.frames]) {
      if (sample === null) continue;
      expect(sample.overflowX).toBeLessThanOrEqual(1);
      frames.push({ t: sample.t, w: sample.w, tx: sample.tx, op: sample.op, trProp: sample.trProp, trDur: sample.trDur, overflowX: sample.overflowX });
    }
    return { frames, recording };
  } finally {
    await recorder.evaluate((state) => { state.dispose(); });
    await recorder.dispose();
  }
}

/**
 * When, from the action, the close showed its first partly faded frame, ended
 * its fade and released the width. The fade must start early enough to run its
 * 100ms inside the window, must really end (its opacity transition reports
 * it) before the width goes, and the width must be gone inside the window.
 */
function expectCloseLatency(recording: IntentRecording): void {
  const intentAt = recording.intentAt ?? Number.NaN;
  const firstFade = recording.frames.find((frame) => frame.op > 0.02 && frame.op < 0.98);
  const collapsed = recording.frames.find((frame) => frame.w <= 2);
  expect(firstFade, 'a partly faded frame was seen').toBeDefined();
  expect((firstFade?.t ?? Number.POSITIVE_INFINITY) - intentAt, 'the fade starts in time to finish').toBeLessThanOrEqual(SETTLE_MS - EXPECTED_PANEL_EXIT_MS);
  expect(collapsed, 'the width is released inside the window').toBeDefined();
  expect(recording.fadeEndAt, 'the fade reported its end inside the window').not.toBeNull();
  expect(recording.fadeEndAt ?? Number.POSITIVE_INFINITY, 'the fade ends before the width is released').toBeLessThanOrEqual((collapsed?.t ?? Number.NEGATIVE_INFINITY) - intentAt);
}

function parseFirstDurationMs(value: string | null): number | null {
  const match = /([\d.]+)(ms|s)?/u.exec(value ?? '');
  if (match === null) return null;
  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount)) return null;
  return match[2] === 's' ? amount * 1_000 : amount;
}

function isNearMs(value: string | null, expected: number): boolean {
  const ms = parseFirstDurationMs(value);
  return ms !== null && Math.abs(ms - expected) <= 40;
}

/** True when each value is within 0.75px of monotonic in the given direction. */
function isMonotonic(values: readonly number[], increasing: boolean): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    if (previous === undefined) return true;
    return increasing ? value >= previous - 0.75 : value <= previous + 0.75;
  });
}

/**
 * Measures the content slide: its strictly-moving interior (both resting
 * offsets trimmed), and whether the panel's own width ever passed through an
 * in-between value. The width must change once, never per frame.
 */
function analyzePhase(frames: readonly Frame[], beginsOpen: boolean, restingWidthPx: number): PhaseResult {
  expect(frames.length).toBeGreaterThanOrEqual(6);
  // A zero-width panel still reports a 1px bordered rect.
  const live = frames.filter((frame) => frame.w > 2);
  expect(live.length).toBeGreaterThan(2);
  const moving = live.filter((frame) => frame.tx > 2 && frame.tx < restingWidthPx - 2);
  // Authority = frames inside the motion; a fully settled tail may legally
  // report no transition once resting styles collapse.
  const declared = moving.length > 0 ? moving : live;
  return {
    coreSpanMs: moving.length >= 2 ? moving[moving.length - 1]!.t - moving[0]!.t : 0,
    strictIntermediates: new Set(moving.map((frame) => frame.tx)).size,
    transitionPropertyIncludesTransform: declared.some((frame) => TRANSFORM_OR_ALL.test(frame.trProp)),
    transitionDurationNearPanel: declared.some((frame) => isNearMs(frame.trDur, EXPECTED_PANEL_MS)),
    // Closing slides the content out (offset grows); opening slides it back.
    directionOk: isMonotonic(live.map((frame) => frame.tx), beginsOpen),
    intermediateWidths: new Set(frames.filter((frame) => frame.w > 2 && frame.w < restingWidthPx - 2).map((frame) => frame.w)).size,
  };
}

function expectGlide(sample: PhaseResult): void {
  expect(sample.intermediateWidths).toBe(0);
  expect(sample.transitionPropertyIncludesTransform).toBe(true);
  expect(sample.transitionDurationNearPanel).toBe(true);
  expect(sample.directionOk).toBe(true);
  expect(sample.strictIntermediates).toBeGreaterThanOrEqual(3);
  expect(sample.coreSpanMs).toBeGreaterThanOrEqual(MIN_CORE_SPAN_MS);
}

/**
 * Closing fades the content out in place: it does not travel, the box keeps
 * its full width through every partly faded frame, and only afterwards does
 * the width drop to 0 in one step.
 */
function expectExitFade(frames: readonly Frame[], restingWidthPx: number): void {
  expect(frames.length).toBeGreaterThanOrEqual(6);
  const fading = frames.filter((frame) => frame.op > 0.02 && frame.op < 0.98);
  expect(new Set(fading.map((frame) => frame.op)).size).toBeGreaterThanOrEqual(2);
  expect(isMonotonic(frames.map((frame) => frame.op * 100), false)).toBe(true);
  expect(fading.every((frame) => Math.abs(frame.w - restingWidthPx) <= 0.5 && frame.tx <= 0.5)).toBe(true);
  expect(fading.some((frame) => /(^|,) ?(opacity|all)( |,|$)/u.test(frame.trProp) && isNearMs(frame.trDur, EXPECTED_PANEL_EXIT_MS))).toBe(true);
  expect(new Set(frames.filter((frame) => frame.w > 2 && frame.w < restingWidthPx - 2).map((frame) => frame.w)).size).toBe(0);
  expect(frames[frames.length - 1]?.w ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
}

async function panelWidth(app: AppHandle, selector: string): Promise<number> {
  return app.window.locator(selector).evaluate((node) => node.getBoundingClientRect().width);
}

test.describe('Defect 22 drawer transitions (frame-sampled)', () => {
  for (const side of ['left', 'right'] as const) {
    test(`desktop ${side} pane slides its content closed and open without animating width`, async () => {
      await withApp(async (app) => {
        const selector = `[data-testid="resizable-panel-${side}"]`;
        const toggle = app.window.getByTestId(`toggle-${side}-panel`);
        await expect(toggle).toBeEnabled({ timeout: 15_000 });

        const restingWidth = await panelWidth(app, selector);
        const intent = { kind: 'click', testId: `toggle-${side}-panel` } as const;
        const closing = await recordToggle(app, selector, intent, () => toggle.click());
        expectExitFade(closing.frames, restingWidth);
        expectCloseLatency(closing.recording);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        // The identical mounted node rests hidden, inert, aria-hidden, without
        // display:none, and hit-testing misses it.
        const closedState = await app.window.locator(selector).evaluate((node) => {
          const probeHit = document.elementFromPoint(14, Math.round(window.innerHeight / 2));
          return {
            state: node.getAttribute('data-panel-state'),
            inert: node.hasAttribute('inert'),
            ariaHidden: node.getAttribute('aria-hidden'),
            displayUsed: getComputedStyle(node).display,
            hitTestMissesPanel: probeHit?.closest('[data-panel-side]') !== node,
          };
        });
        expect(closedState).toEqual({
          state: 'closed',
          inert: true,
          ariaHidden: 'true',
          displayUsed: 'flex',
          hitTestMissesPanel: true,
        });

        const { frames: openFrames } = await recordToggle(app, selector, intent, () => toggle.click());
        expectGlide(analyzePhase(openFrames, false, await panelWidth(app, selector)));
        // It fades in as it slides: some frame is partly visible, and it ends opaque.
        expect(openFrames.some((frame) => frame.op > 0.02 && frame.op < 0.98)).toBe(true);
        expect(openFrames[openFrames.length - 1]?.op).toBe(1);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(await panelWidth(app, selector)).toBeGreaterThanOrEqual(side === 'left' ? 220 : 280);
      });
    });
  }

  test('keyboard and pointer closure with focus inside hands off without a body frame', async () => {
    await withApp(async (app) => {
      // Pointer-intent closure while focus lives inside the panel content: the
      // synchronous store-level handoff prevents any observable body-focus frame.
      const toggleBtn = app.window.getByTestId('toggle-right-panel');
      await app.window.getByRole('tab', { name: 'Chat' }).click();
      const chatInput = app.window.getByPlaceholder(/Ask anything/i);
      const target = (await chatInput.count()) === 1 ? chatInput : app.window.getByTestId('companion-panel');
      await target.focus();
      expect(
        await app.window.evaluate(() =>
          document.querySelector('[data-testid="companion-panel"]')?.contains(document.activeElement) ?? false
        )
      ).toBe(true);

      await toggleBtn.click();
      for (let step = 0; step < 8; step += 1) {
        const info = await app.window.evaluate(() => ({
          tag: document.activeElement?.tagName ?? 'null',
          testid: document.activeElement?.getAttribute('data-testid') ?? '',
          overflowing: document.body.scrollWidth - document.body.clientWidth,
        }));
        expect(info.tag.toLowerCase()).not.toBe('body');
        expect(info.testid.startsWith('toggle-')).toBe(true);
        expect(info.overflowing).toBeLessThanOrEqual(1);
        await app.window.waitForTimeout(20);
      }
      await expect(app.window.getByTestId('resizable-panel-right')).toBeHidden({ timeout: 900 });
      await expect(toggleBtn).toBeFocused();

      // Pure-keyboard trigger: reopen, then Enter on the focused toggle.
      await toggleBtn.click();
      await expect(app.window.getByTestId('resizable-panel-right')).toBeVisible({ timeout: 900 });
      await toggleBtn.focus();
      await app.window.keyboard.press('Enter');
      await expect(app.window.getByTestId('resizable-panel-right')).toBeHidden({ timeout: 900 });
      await expect(toggleBtn).toBeFocused();
    });
  });

  test('PDF keeps stable reader shell and single-attached canvas through toggles', async () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'interleaf-d22-pdf-'));
    const pdfPath = path.join(fixtureDir, 'Defect22_Toggle_Stability.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Defect 22 Toggle Stability',
      pageLines: [
        ['Toggle transitions must not tear down painted pages.', ...Array.from({ length: 12 }, (_, i) => `Detail ${String(i + 1)}.`)],
        ['Second page anchor content.'],
      ],
    }));
    try {
      await withApp(async (app) => {
        await stubOpenDialog(app, [pdfPath]);
        await app.window.getByTestId('import-files-button').click();
        await expect(app.window.getByTestId('success-banner')).toBeVisible();
        const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
        await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
        await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible({ timeout: 30_000 });
        await app.window.waitForTimeout(400);

        // Stamp the persistent shell nodes and remember the current canvas.
        await app.window.evaluate(() => {
          document.querySelector<HTMLElement>('[data-testid="pdf-viewport-container"]')!.dataset.d22 = 'container';
          document.querySelector<HTMLElement>('[data-testid^="pdf-page-"]')!.dataset.d22 = 'wrapper';
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]')!;
          (window as { __d22Canvas?: WeakRef<HTMLCanvasElement> }).__d22Canvas = new WeakRef(canvas);
        });

        await app.window.getByTestId('toggle-left-panel').click();
        for (let step = 0; step < 10; step += 1) {
          const snapshot = await app.window.evaluate(() => ({
            maxCanvasesPerPage: Math.max(0, ...Array.from(document.querySelectorAll('[data-testid^="pdf-page-"]')).map(
              (wrapper) => wrapper.querySelectorAll('canvas').length
            )),
            overflowX: document.body.scrollWidth - document.body.clientWidth,
          }));
          expect(snapshot.maxCanvasesPerPage).toBe(1);
          expect(snapshot.overflowX).toBeLessThanOrEqual(1);
          await app.window.waitForTimeout(25);
        }
        await expect(app.window.getByTestId('resizable-panel-left')).toBeHidden({ timeout: 2_000 });

        await app.window.getByTestId('toggle-left-panel').click();
        await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

        // Quiet-period commit repaints sharp; text layer survives intact.
        await expect.poll(async () =>
          app.window.getByTestId('pdf-canvas-p1').evaluate((canvas) => canvas.style.transform)
        ).toBe('');

        // PDF.js double-buffers paint surfaces, so at most one canvas swap is
        // allowed; the persistent reader and page wrapper nodes stay identical.
        const stability = await app.window.evaluate(() => {
          const canvasNow = document.querySelector('[data-testid="pdf-canvas-p1"]');
          const previous = (window as { __d22Canvas?: WeakRef<HTMLCanvasElement> }).__d22Canvas?.deref();
          return {
            containerStable: document.querySelector('[data-testid="pdf-viewport-container"]')?.getAttribute('data-d22'),
            wrapperStable: document.querySelector('[data-testid^="pdf-page-"]')?.getAttribute('data-d22'),
            swaps: previous !== undefined && canvasNow !== null && previous !== canvasNow ? 1 : 0,
            canvasStillAttached: canvasNow !== null,
          };
        });
        expect(stability.containerStable).toBe('container');
        expect(stability.wrapperStable).toBe('wrapper');
        expect(stability.swaps).toBeLessThanOrEqual(1);
        expect(stability.canvasStillAttached).toBe(true);
        await expect(app.window.getByTestId('pdf-textlayer-p1')).toHaveCount(1);
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('reduced motion is materially faster than measured normal motion', async () => {
    await withApp(async (app) => {
      const toggle = app.window.getByTestId('toggle-left-panel');
      const panel = app.window.getByTestId('resizable-panel-left');
      await expect(toggle).toBeEnabled({ timeout: 15_000 });

      // Baseline: measured normal close (click -> fully hidden), in the renderer.
      const normalHide = await armHideTimer(app, 'toggle-left-panel', 'resizable-panel-left');
      await toggle.click();
      await expect(panel).toBeHidden({ timeout: 1_500 });
      const normalHideMs = await normalHide();
      expect(normalHideMs).toBeGreaterThan(MIN_CORE_SPAN_MS);

      await toggle.click();
      await expect(app.window.getByTestId('new-folder-button')).toBeVisible({ timeout: 1_500 });

      // Reduced motion run on the same session/window.
      await app.window.emulateMedia({ reducedMotion: 'reduce' });
      const reduceHide = await armHideTimer(app, 'toggle-left-panel', 'resizable-panel-left');
      await toggle.click();
      await expect(panel).toBeHidden({ timeout: 800 });
      const reduceHideMs = await reduceHide();
      expect(reduceHideMs).toBeLessThanOrEqual(120);
      expect(reduceHideMs).toBeLessThan(normalHideMs * 0.5);
      await expect(panel).toHaveAttribute('data-panel-state', 'closed');

      await toggle.click();
      await expect(app.window.getByTestId('new-folder-button')).toBeVisible({ timeout: 800 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });
  });

  test('compact drawers slide over a fading backdrop at native 200% zoom', async () => {
    await withApp(async (app) => {
      await zoomToCompact(app, 'right');
      const innerWidth = await app.window.evaluate(() => window.innerWidth);
      expect(innerWidth).toBeLessThan(920);
      const toggle = app.window.getByTestId('toggle-right-panel');
      const drawer = app.window.getByTestId('compact-drawer-right');

      // Enter glide: a genuinely observed in-flight frame, partially on screen.
      await toggle.click();
      await app.window.waitForFunction(() => {
        const node = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
        if (node === null) return false;
        const raw = getComputedStyle(node).transform;
        const tx = raw === 'none' ? 0 : new DOMMatrixReadOnly(raw).m41;
        const rect = node.getBoundingClientRect();
        const visible = Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left);
        return tx > 6 && tx < window.innerWidth * 0.55 && visible > 80;
      }, undefined, { polling: 'raf', timeout: 2_500 });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
      // The phase reads 'open' while the enter glide is still running; exit
      // from the rested drawer so the whole travel is observable.
      await expect.poll(async () => drawerOffset(drawer), { timeout: 2_000 }).toBeLessThanOrEqual(1);

      // Exit through Escape from inside the drawer: attached-but-moving plus a real fade.
      await app.window.getByTestId('close-compact-drawer').focus();
      await app.window.keyboard.press('Escape');
      const exitSamples: {
        readonly offset: number;
        readonly backdropOpacity: number | null;
        readonly backdropDuration: string | null;
        readonly drawerTransitionProperty: string;
        readonly drawerTransitionDuration: string;
      }[] = [];
      for (let step = 0; step < 26; step += 1) {
        const sample = await app.window.evaluate(() => {
          const node = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
          if (node === null) return null;
          const backdrop = document.querySelector<HTMLElement>('[data-testid="compact-backdrop"]');
          const cs = getComputedStyle(node);
          return {
            offset: cs.transform === 'none' ? 0 : Math.abs(new DOMMatrixReadOnly(cs.transform).m41),
            overflowX: document.body.scrollWidth - document.body.clientWidth,
            backdropOpacity: backdrop !== null ? Number.parseFloat(getComputedStyle(backdrop).opacity) : null,
            backdropDuration: backdrop !== null ? getComputedStyle(backdrop).transitionDuration : null,
            drawerTransitionProperty: cs.transitionProperty,
            drawerTransitionDuration: cs.transitionDuration,
          };
        });
        if (sample === null) break;
        exitSamples.push(sample);
        // Attached means either still moving (>8px travel) or not yet started.
        expect(sample.offset > 8 || sample.offset === 0).toBe(true);
        expect(sample.overflowX).toBeLessThanOrEqual(1);
        await app.window.waitForTimeout(14);
      }
      await expect(drawer).toHaveCount(0);
      expect(exitSamples.length).toBeGreaterThan(4);
      const offsets = exitSamples.map((sample) => sample.offset);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(innerWidth * 0.10);

      // Backdrop fade: every sample carries opacity; it descends while the
      // drawer is still attached, with a ~280ms opacity transition declared.
      const opacities = exitSamples.flatMap((sample) => (sample.backdropOpacity === null ? [] : [sample.backdropOpacity]));
      expect(opacities.length).toBe(exitSamples.length);
      expect(Math.max(...opacities)).toBeGreaterThan(0.15);
      expect(Math.min(...opacities)).toBeLessThan(Math.max(...opacities));
      expect(opacities.filter((value) => value > 0.02 && value < 0.95).length).toBeGreaterThanOrEqual(2);
      expect(exitSamples.some((sample) => isNearMs(sample.backdropDuration, EXPECTED_DRAWER_MS))).toBe(true);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // The drawer's own exit motion declares a ~280ms transform glide.
      expect(exitSamples.some((sample) =>
        TRANSFORM_OR_ALL.test(sample.drawerTransitionProperty) && isNearMs(sample.drawerTransitionDuration, EXPECTED_DRAWER_MS)
      )).toBe(true);

      // Reopen; steady state is contained, modal and focused.
      await toggle.click();
      await expect(drawer).toBeVisible();
      await expect.poll(async () => drawerOffset(drawer), { timeout: 2_000 }).toBeLessThanOrEqual(1);
      await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
      const containment = await drawer.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          sw: document.body.scrollWidth,
          iw: window.innerWidth,
          within: rect.left >= -2 && rect.right <= window.innerWidth + 2,
          visibleArea: rect.width > 40 && rect.height > 120,
          focusInside: node.contains(document.activeElement),
          ariaModal: node.getAttribute('aria-modal'),
        };
      });
      expect(containment.sw).toBeLessThanOrEqual(containment.iw + 1);
      expect(containment).toMatchObject({ within: true, visibleArea: true, focusInside: true, ariaModal: 'true' });
    });
  });

  test('compact reduced-motion opening has no off-screen frame and focuses the visible drawer', async () => {
    await withApp(async (app) => {
      await zoomToCompact(app, 'right');
      await app.window.emulateMedia({ reducedMotion: 'reduce' });
      const drawer = app.window.getByTestId('compact-drawer-right');
      await app.window.getByTestId('toggle-right-panel').click();
      await expect(drawer).toBeVisible();
      // First visible probe: the entering phase never existed. The drawer is
      // open-phase, at rest transform, with focus already inside it.
      const firstState = await drawer.evaluate((node) => {
        const cs = getComputedStyle(node);
        return {
          phase: node.getAttribute('data-slide-phase'),
          tx: cs.transform === 'none' ? 0 : new DOMMatrixReadOnly(cs.transform).m41,
          focusInside: node.contains(document.activeElement),
          transitionProperty: cs.transitionProperty,
        };
      });
      expect(firstState).toEqual({ phase: 'open', tx: 0, focusInside: true, transitionProperty: 'transform' });
    });
  });

  test('crossing the compact breakpoint closes the drawer synchronously without stale resurrection', async () => {
    await withApp(async (app) => {
      const toggle = app.window.getByTestId('toggle-right-panel');
      const drawer = app.window.getByTestId('compact-drawer-right');
      const activeTestId = async (): Promise<string | null> =>
        app.window.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
      await zoomToCompact(app, 'right');
      await toggle.click();
      await expect(drawer).toBeVisible();
      await expect.poll(activeTestId).toBe('switch-to-library-button');

      // Widen past the breakpoint (zoom 2 -> 1 leaves the compact range).
      await app.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
      });
      await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThan(920);
      // Focus lands on the owning toggle, never BODY.
      await expect.poll(activeTestId).toBe('toggle-right-panel');
      await expect(drawer).toHaveCount(0);
      // The desktop pane returns per the persisted preference (still open).
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(async () => toggle.getAttribute('aria-controls')).toBe('companion-panel');

      // Shrink again: no stale drawer resurrects; a fresh open works.
      await zoomToCompact(app, 'right');
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(drawer).toBeVisible();
    });
  });

  test('switching compact panels keeps focus valid on every frame without duplicating surfaces', async () => {
    await withApp(async (app) => {
      await zoomToCompact(app, 'left');
      await app.window.getByTestId('toggle-left-panel').click();
      await expect(app.window.getByTestId('compact-drawer-left')).toBeVisible();
      await app.window.waitForTimeout(SETTLE_MS);

      // Per-frame focus recorder: every rAF records whether the active element
      // is a valid holder, so a BODY/HTML frame is impossible to miss.
      await app.window.evaluate(() => {
        const log: { tag: string; connected: boolean; hiddenAncestor: boolean; outsideActiveDrawer: boolean }[] = [];
        (window as { __d22FocusLog?: typeof log }).__d22FocusLog = log;
        const step = (): void => {
          const active = document.activeElement;
          const activeDrawer = document.querySelector(
            '[data-testid^="compact-drawer-"]:is([data-slide-phase="open"], [data-slide-phase="entering"])'
          );
          log.push({
            tag: active?.tagName ?? 'null',
            connected: active?.isConnected ?? false,
            hiddenAncestor: active?.closest('[inert], [aria-hidden="true"]') != null,
            outsideActiveDrawer: activeDrawer !== null && !activeDrawer.contains(active),
          });
          if (log.length < 400) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
      });
      await app.window.getByTestId('switch-to-companion-button').click();
      await expect(app.window.getByTestId('compact-drawer-right')).toBeVisible();
      const overlap = await app.window.evaluate(() => ({
        sidebarInstances: document.querySelectorAll('[data-testid="sidebar-library"]').length,
        companionInstances: document.querySelectorAll('[data-testid="companion-panel"]').length,
        leftPhase: document.querySelector('[data-testid="compact-drawer-left"]')?.getAttribute('data-slide-phase'),
        activeAfterSwitch: document.activeElement?.getAttribute('data-testid') ?? null,
      }));
      expect(overlap.companionInstances).toBe(1);
      expect(overlap.sidebarInstances).toBeLessThanOrEqual(1);
      // An outgoing left drawer may still be present, but only while exiting.
      expect([undefined, 'exiting']).toContain(overlap.leftPhase);
      // Switch suppression: no theft to a header toggle during overlap.
      expect(['toggle-left-panel', 'toggle-right-panel']).not.toContain(overlap.activeAfterSwitch);

      await expect(app.window.getByTestId('compact-drawer-left')).toHaveCount(0);
      // No late theft after the outgoing drawer's rAF cleanup window.
      const rightDrawer = app.window.getByTestId('compact-drawer-right');
      const focusInRight = async (): Promise<boolean> => rightDrawer.evaluate((node) => node.contains(document.activeElement));
      await app.window.waitForTimeout(450);
      expect(await focusInRight()).toBe(true);
      const focusAudit = await app.window.evaluate(() => {
        const log = (window as {
          __d22FocusLog?: { tag: string; connected: boolean; hiddenAncestor: boolean; outsideActiveDrawer: boolean }[];
        }).__d22FocusLog ?? [];
        const bad = log.filter((entry) =>
          ['BODY', 'HTML'].includes(entry.tag) || !entry.connected || entry.hiddenAncestor || entry.outsideActiveDrawer
        );
        return { samples: log.length, badFrames: bad.length, firstBad: bad[0] ?? null };
      });
      expect(focusAudit.samples).toBeGreaterThan(8);
      expect(
        focusAudit.badFrames,
        `every sampled frame must hold focus in a connected, non-inert, non-aria-hidden element (inside the active drawer while one is open): ${JSON.stringify(focusAudit.firstBad)}`
      ).toBe(0);
      await expect.poll(async () => rightDrawer.evaluate((node) =>
        ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform)
      )).toBe(true);
      await expect.poll(focusInRight).toBe(true);

      await app.window.mouse.click(60, 300);
      await expect(rightDrawer).toHaveCount(0);
      await expect
        .poll(async () => app.window.evaluate(() => document.activeElement?.getAttribute('data-testid')))
        .toBe('toggle-right-panel');
      expect(await app.window.evaluate(() => document.body.scrollWidth - document.body.clientWidth)).toBeLessThanOrEqual(1);
    });
  });
});
