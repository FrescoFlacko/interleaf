import { expect, test } from '@playwright/test';
import { launchInterleaf, type AppHandle } from './helpers';

/**
 * The header wordmark and the tagline must read as one line of text.
 *
 * The product name is rendered a size larger and heavier than the tagline, so
 * centring the two inside the header row put its glyphs visibly lower than the
 * tagline's. Only a real engine can answer where the glyphs actually land, so
 * this measures the rendered text in the shipped window rather than asserting a
 * class name.
 *
 * Measurement: a zero-sized inline-block probe appended to a span reports the
 * span's text baseline as its own bottom edge, and the canvas text metrics for
 * the same computed font give the ink depth below that baseline. Their sum is
 * the visible bottom of the painted word.
 */

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchInterleaf();
});

test.afterAll(async () => {
  await app.close();
});

test('the product name and the tagline share a visible bottom edge', async () => {
  const zoomFactor = await app.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Main BrowserWindow was not found.');
    // Ordinary desktop scale: the reported defect is at 100%.
    window.webContents.setZoomFactor(1.0);
    return window.webContents.getZoomFactor();
  });
  expect(zoomFactor).toBe(1);

  const name = app.window.getByTestId('app-header-name');
  const tagline = app.window.getByTestId('app-header-tagline');
  await expect(name).toBeVisible();
  await expect(tagline).toBeVisible();

  const measured = await app.window.evaluate(() => {
    const inkBottomOf = (testId: string): { readonly baseline: number; readonly inkBottom: number } => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (element === null) throw new Error(`Missing header element: ${testId}`);
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;';
      element.appendChild(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      const style = getComputedStyle(element);
      const context = document.createElement('canvas').getContext('2d');
      if (context === null) throw new Error('A 2D canvas context is required to measure text.');
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(element.textContent);
      return { baseline, inkBottom: baseline + metrics.actualBoundingBoxDescent };
    };
    return {
      name: inkBottomOf('app-header-name'),
      tagline: inkBottomOf('app-header-tagline'),
      devicePixelRatio: window.devicePixelRatio,
    };
  });

  // Sharing a baseline puts both deltas at a fraction of a pixel. The bound is
  // half a CSS pixel rather than the required whole one, because the centred
  // layout this replaces measured 1.00 px of baseline and 1.04 px of visible
  // bottom offset — a whole-pixel bound would not separate the two layouts.
  expect(Math.abs(measured.name.baseline - measured.tagline.baseline)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(measured.name.inkBottom - measured.tagline.inkBottom)).toBeLessThanOrEqual(0.5);
});
