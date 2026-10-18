import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('Defect 4 Focus Reading Mode visibility', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-focus-mode-'));
    samplePdfPath = join(fixtureDir, 'Focus_Reading_Fixture.pdf');
    writeFileSync(
      samplePdfPath,
      makePdfFixture({
        title: 'Focus Reading Fixture',
        author: 'Interleaf',
        pageLines: [
          ['A loaded reader is the only workspace that should expose Focus Reading Mode.'],
          ['The control remains available at a constrained 200 percent zoom.'],
        ],
      }),
    );
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('shows Focus Reading Mode only for a loaded reader and reconciles it on return/restart', async () => {
    // Library is not a reading workspace; the control is absent from both
    // layout and accessibility queries.
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [openedDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(openedDocument?.title).toBe('Focus Reading Fixture');

    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('reader-focus-button')).toBeVisible();
    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);
    await expect(app.window.getByTestId('reader-focus-button')).toHaveAttribute('aria-pressed', 'false');
    // Existing toggle semantics remain available once reading is active.
    await app.window.getByTestId('reader-focus-button').click();
    await expect(app.window.getByTestId('focus-progress')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('reader-header-toolbar')).toBeVisible();

    // Capture constrained evidence through the real BrowserWindow zoom path.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 640);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 640 });
    await app.window.waitForTimeout(400);
    await expect(app.window.getByTestId('reader-focus-button')).toBeVisible();
    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);
    const overflow = await app.window.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      headerScrollWidth: document.querySelector<HTMLElement>('[data-testid="app-header"]')?.scrollWidth ?? 0,
      headerClientWidth: document.querySelector<HTMLElement>('[data-testid="app-header"]')?.clientWidth ?? 0,
    }));
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.bodyClientWidth);
    expect(overflow.headerScrollWidth).toBeLessThanOrEqual(overflow.headerClientWidth);
    // Returning to Library removes both controls and exits any stale focus
    // state before the Library layout is shown.
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);
    await expect(app.window.getByTestId('reader-focus-button')).toHaveCount(0);

    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('document-grid')).toBeVisible();
    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);
    await expect(app.window.getByTestId('reader-focus-button')).toHaveCount(0);
  });
});
