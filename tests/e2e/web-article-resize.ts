import { expect } from '@playwright/test';
import type { AppHandle } from './helpers';

/** What `setWindowSize` watches in the page between its calls. */
type ResizeReadiness = {
  reported: { readonly wrapper: number; readonly scroller: number } | null;
  observer: ResizeObserver | null;
  /** False once the helper has finished, by success or failure. */
  active: boolean;
  /** Animation frames it has asked for and not yet seen run. */
  frames: Set<number>;
  /** Settle the waits for frames still pending when the helper finishes (a poll can start a new one before the last ends). */
  wakes: Set<() => void>;
};

/**
 * Resizes the window and returns once the reader has laid out at the new size.
 *
 * The window cannot go below its minimum size, so the width actually reached is
 * read back from the window rather than assumed (a 720px request lands at the
 * 960px minimum). Then the reader must have caught up: its viewport matches the
 * window's content width, a ResizeObserver this helper installs on the reader's
 * content box and scroller has reported their current widths, and those widths
 * hold over the next frame. The reader's own observer on those boxes was
 * created first, so it has already run for that size: whatever it sets (a
 * table's tab stop, role and name) is then checked as it stands, unchanged.
 *
 * Whatever happens, including a failure to resize or a wait that times out,
 * the observer is disconnected, the frames it asked for are cancelled and a
 * pending wait is settled before it returns or throws.
 */
export async function setWindowSize(app: AppHandle, width: number, height: number): Promise<void> {
  const readiness = await app.window.evaluateHandle(() => {
    const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
    let scroller = wrapper?.parentElement ?? null;
    while (scroller !== null && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const state: ResizeReadiness = { reported: null, observer: null, active: true, frames: new Set(), wakes: new Set() };
    if (wrapper !== null && scroller !== null) {
      const box = scroller;
      state.observer = new ResizeObserver(() => {
        if (state.active) state.reported = { wrapper: wrapper.clientWidth, scroller: box.clientWidth };
      });
      state.observer.observe(wrapper);
      state.observer.observe(box);
    }
    return state;
  });
  try {
    const reached = await app.electronApp.evaluate(({ BrowserWindow }, size: { width: number; height: number }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error('No window to resize.');
      window.setSize(size.width, size.height);
      const [minWidth = 0] = window.getMinimumSize();
      return { width: Math.max(size.width, minWidth), zoom: window.webContents.getZoomFactor() };
    }, { width, height });
    await expect
      .poll(async () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds().width ?? 0), {
        message: `the window reaches ${String(reached.width)}px wide`,
      })
      .toBe(reached.width);
    const viewportWidth = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds().width ?? 0);
    await expect
      .poll(async () => readiness.evaluate(async (state: ResizeReadiness, expected: number) => {
        const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
        let scroller = wrapper?.parentElement ?? null;
        while (scroller !== null && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        const settled = (): boolean => {
          const now = { wrapper: wrapper?.clientWidth ?? -1, scroller: scroller?.clientWidth ?? -1 };
          return state.active && Math.abs(window.innerWidth - expected) <= 1 && state.reported?.wrapper === now.wrapper && state.reported.scroller === now.scroller;
        };
        if (!settled()) return false;
        await new Promise<void>((resolve) => {
          state.wakes.add(resolve);
          const first = requestAnimationFrame(() => {
            state.frames.delete(first);
            const second = requestAnimationFrame(() => {
              state.frames.delete(second);
              resolve();
            });
            state.frames.add(second);
          });
          state.frames.add(first);
        });
        return settled();
      }, viewportWidth / reached.zoom), { message: 'the reader has laid out at the new window size' })
      .toBe(true);
  } finally {
    await readiness.evaluate((state: ResizeReadiness) => {
      state.active = false;
      state.observer?.disconnect();
      for (const frame of state.frames) cancelAnimationFrame(frame);
      state.frames.clear();
      for (const wake of state.wakes) wake();
      state.wakes.clear();
    });
    await readiness.dispose();
  }
}
