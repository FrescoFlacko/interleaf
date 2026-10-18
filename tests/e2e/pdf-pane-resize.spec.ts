import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('PDF pane-drag resize stability', () => {
  const PANEL_MIN_RIGHT = 280;
  const DRAG_DELTA = 180;
  /** A meaningful gesture commits at least the first discrete drag step. */
  const MIN_COMMITTED_NARROWING = 40;
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-pane-resize-e2e-'));
    samplePdfPath = join(fixtureDir, 'Pane_Resize_Stability.pdf');

    const pdfBuffer = makePdfFixture({
      title: 'Pane Resize Stability',
      pageLines: [
        [
          'Chapter 1: Resizing the companion pane must keep the PDF surface stable.',
          ...Array.from({ length: 20 }, (_, index) => `Stability detail ${String(index + 1)}.`),
        ],
        ['Chapter 2: Atomic swap verification content.'],
      ],
    });
    writeFileSync(samplePdfPath, pdfBuffer);

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('dragging the right panel resizer keeps one attached canvas per page and settles sharp', async () => {
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const importedDoc = docs[0]!;
    await app.window.getByTestId(`read-doc-${importedDoc.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible({ timeout: 30_000 });

    const resizer = app.window.getByTestId('panel-resizer-right');
    const readerContainer = app.window.getByTestId('pdf-viewport-container');
    await expect(resizer).toBeAttached();

    const pageOneCanvasCount = (): Promise<number> =>
      app.window.evaluate(
        () => document.querySelectorAll('[data-testid="pdf-canvas-p1"]').length
      );

    // Normalize: snap the companion pane to its maximum so a fixed-width
    // narrowing drag (+x on right-side handles) never hits a clamp and the
    // fitted reader page grows every step without detaching its canvas.
    await resizer.focus();
    await app.window.keyboard.press('End');
    // The committed width eases in over 200ms; let layout settle before measuring.
    await app.window.waitForTimeout(350);
    const startPaneWidth = Number.parseInt((await resizer.getAttribute('aria-valuenow')) ?? '0', 10);
    expect(startPaneWidth).toBeGreaterThanOrEqual(PANEL_MIN_RIGHT + DRAG_DELTA);

    const box = await resizer.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    const beforeDragWidth = await app.window.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      return wrapper ? Number.parseFloat(wrapper.style.width) : 0;
    });
    expect(beforeDragWidth).toBeGreaterThan(0);

    await app.window.mouse.move(startX, startY);
    await app.window.mouse.down();

    for (const offset of [45, 90, 135, 180]) {
      await app.window.mouse.move(startX + offset, startY, { steps: 6 });
      // Exactly one generation of page 1's canvas may exist at any instant.
      expect(await pageOneCanvasCount()).toBe(1);
    }

    await app.window.mouse.up();

    // Width commit is synchronous on pointerup; require a meaningful gesture
    // without pinning the landing to the requested pointer delta.
    const settledPaneWidth = Number.parseInt((await resizer.getAttribute('aria-valuenow')) ?? '0', 10);

    // Settle window: the quiet-period commit repaints page 1 sharp.
    await expect.poll(pageOneCanvasCount, { timeout: 10_000 }).toBe(1);

    const canvasTransformDuringSettle = (): Promise<string> =>
      app.window.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
        return canvas?.style.transform ?? 'missing';
      });
    await expect.poll(canvasTransformDuringSettle, { timeout: 10_000 }).toBe('');

    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toHaveCount(1);

    const surfaceState = await app.window.evaluate(() => {
      const pageWrapper = document.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
      const canvas = pageWrapper?.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
      return {
        transform: canvas?.style.transform ?? 'missing',
        textLayersOnPage: pageWrapper?.querySelectorAll('.textLayer').length ?? -1,
        canvasesOnPage: pageWrapper?.querySelectorAll('canvas').length ?? -1,
        ariaNow: document.querySelector('[data-testid="panel-resizer-right"]')?.getAttribute('aria-valuenow') ?? null,
        wrapperWidth: (() => {
          const wrapper = pageWrapper;
          return wrapper ? Number.parseFloat(wrapper.style.width) : 0;
        })(),
      };
    });
    expect(surfaceState.transform).toBe('');
    expect(surfaceState.textLayersOnPage).toBe(1);
    expect(surfaceState.canvasesOnPage).toBe(1);
    expect(Number.parseInt(surfaceState.ariaNow ?? '0', 10)).toBe(settledPaneWidth);

    // Meaningful resize: fitted reader grows by the same order as the pane narrowed.
    const committedNarrowing = startPaneWidth - settledPaneWidth;
    expect(committedNarrowing).toBeGreaterThanOrEqual(MIN_COMMITTED_NARROWING);
    expect(surfaceState.wrapperWidth).toBeGreaterThan(beforeDragWidth);
    expect(surfaceState.wrapperWidth - beforeDragWidth).toBeGreaterThanOrEqual(committedNarrowing / 2);

    // Reader still paints inside the widened viewport after settling.
    await expect(readerContainer).toBeVisible();
  });
});
