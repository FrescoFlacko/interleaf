import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, searchStatus, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Reading order, as the jump actions actually read it. The action's visible
 * text is the page it goes to; the direction is carried by a decorative SVG
 * icon rather than an arrow character, so the order is asserted on the page
 * labels and the icon semantics are asserted separately.
 */
const PAGE_ORDER = ['Page 1', 'Page 2', 'Page 10'];

test.describe('Defect 11 — FTS results follow reading order', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-search-order-e2e-'));
    samplePdfPath = join(fixtureDir, 'Search_Order_Fixture.pdf');
    const pages = [
      'Search order anchor appears on the first page.',
      'Search order anchor appears on the second page.',
      ...Array.from({ length: 7 }, (_, index) => `Unrelated page ${String(index + 3)} content.`),
      'Search order anchor appears on page ten. Search order anchor appears again on page ten. Search order anchor appears again on page ten.',
    ];
    writeFileSync(samplePdfPath, makePdfFixture({
      title: 'Search Order Fixture',
      author: 'Interleaf Test',
      pages,
      outline: pages.map((_, index) => ({ title: `Page ${String(index + 1)}`, targetPage: index + 1 })),
    }));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('orders visible results, navigates to each page, and remains deterministic after rebuild and restart', async () => {
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(document).toBeDefined();

    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByRole('tab', { name: 'Search' })).toBeVisible();
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await expect(app.window.getByTestId('search-panel')).toBeVisible();
    await expect(searchStatus(app)).toHaveText('10 passages indexed.');

    const query = app.window.getByLabel('Search indexed text');
    await query.fill('anchor');
    await app.window.getByRole('button', { name: 'Search', exact: true }).click();
    const resultList = app.window.getByRole('list', { name: 'Search results' });
    await expect(resultList).toBeVisible();
    await expect(resultList.getByRole('listitem')).toHaveCount(3);
    const resultButtons = resultList.getByRole('button', { name: /Jump to/ });
    await expect(resultButtons).toHaveText(PAGE_ORDER);
    await expect(resultList.getByRole('listitem').nth(0)).toHaveAttribute('aria-posinset', '1');
    await expect(resultList.getByRole('listitem').nth(2)).toHaveAttribute('aria-posinset', '3');

    // Each jump action still names its destination for assistive technology,
    // and the direction is drawn by a decorative icon: an SVG hidden from the
    // accessibility tree, not an arrow character in the action's text.
    for (const [index, page] of PAGE_ORDER.entries()) {
      const button = resultButtons.nth(index);
      await expect(button).toHaveAccessibleName(`Jump to ${page} in Search Order Fixture`);
      const icon = button.locator('svg[data-icon="forward"]');
      await expect(icon).toHaveCount(1);
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
    }

    const pageInput = app.window.getByTestId('page-number-input');
    await resultButtons.nth(0).click();
    await expect(pageInput).toHaveValue('1');
    await resultButtons.nth(1).click();
    await expect(pageInput).toHaveValue('2');
    await resultButtons.nth(2).click();
    await expect(pageInput).toHaveValue('10');

    const orderedBeforeRebuild = await resultButtons.allTextContents();
    expect(orderedBeforeRebuild).toEqual(PAGE_ORDER);

    // Rebuild through the same typed main-process index lifecycle used by the
    // renderer. This intentionally repeats the fixture with a later page that
    // has the strongest BM25 score.
    await app.window.evaluate(async ({ documentId, documentHash }) => {
      const api = window.interleafAPI;
      const generation = await api.search.beginIndex(documentId, documentHash);
      await api.search.appendIndex(documentId, documentHash, generation.generationId, [
        { ordinal: 0, text: 'Search order anchor appears on the first page.', location: { format: 'pdf' as const, pageIndex: 0, pageLabel: 'Page 1' }, heading: null, pageLabel: 'Page 1' },
        { ordinal: 1, text: 'Search order anchor appears on the second page.', location: { format: 'pdf' as const, pageIndex: 1, pageLabel: 'Page 2' }, heading: null, pageLabel: 'Page 2' },
        { ordinal: 2, text: 'Search order anchor appears repeatedly on page ten. Search order anchor appears again.', location: { format: 'pdf' as const, pageIndex: 9, pageLabel: 'Page 10' }, heading: null, pageLabel: 'Page 10' },
      ]);
      await api.search.completeIndex(documentId, documentHash, generation.generationId);
    }, { documentId: document!.id, documentHash: document!.fileHash });

    await query.fill('anchor');
    await app.window.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(resultButtons).toHaveText(PAGE_ORDER);

    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    const [reopened] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${reopened!.id}`).click();
    await expect(app.window.getByTestId('pdf-textlayer-p10')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await expect(searchStatus(app)).toHaveText('3 passages indexed.');
    const restartedQuery = app.window.getByLabel('Search indexed text');
    await restartedQuery.fill('anchor');
    await app.window.getByRole('button', { name: 'Search', exact: true }).click();
    const restartedList = app.window.getByRole('list', { name: 'Search results' });
    await expect(restartedList.getByRole('button', { name: /Jump to/ })).toHaveText(PAGE_ORDER);
    await restartedList.getByRole('button', { name: 'Jump to Page 10 in Search Order Fixture' }).click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('10');

    // Check the real application at 200% BrowserWindow zoom. Electron's
    // minimum width is 960px; this supported, tall window intentionally uses
    // the application's compact companion drawer, rather than a cloned or
    // CSS-zoomed test element. The drawer is the same DOM users operate.
    const originalWindowState = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main BrowserWindow is unavailable.');
      const bounds = win.getBounds();
      // 1800x1200 leaves enough physical room for the 340px compact drawer
      // after Chromium scales the 2x BrowserWindow contents, while the CSS
      // viewport remains below the app's 920px compact breakpoint.
      win.setSize(1800, 1200);
      win.webContents.setZoomFactor(2.0);
      return { bounds, zoomFactor: win.webContents.getZoomFactor() };
    });
    try {
      await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win?.webContents.getZoomFactor() ?? 0;
      })).toBe(2);
      await expect.poll(() => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);

      const rightToggle = app.window.getByTestId('toggle-right-panel');
      const rightDrawer = app.window.getByTestId('compact-drawer-right');
      await expect(rightToggle).toBeVisible();
      if (await rightDrawer.isHidden()) await rightToggle.click();
      await expect(rightDrawer).toBeVisible();
      const searchTab = rightDrawer.getByRole('tab', { name: 'Search' });
      if (await searchTab.getAttribute('aria-selected') !== 'true') await searchTab.click();
      const zoomedSearchPanel = rightDrawer.getByTestId('search-panel');
      await expect(zoomedSearchPanel).toBeVisible();

      // SearchPanel owns local result state and may remount when the shell
      // changes presentation, so perform the same real user search in the
      // real drawer before asserting.
      const zoomedQuery = zoomedSearchPanel.getByLabel('Search indexed text');
      await zoomedQuery.fill('anchor');
      await zoomedSearchPanel.getByRole('button', { name: 'Search', exact: true }).click();
      const zoomedResults = rightDrawer.getByRole('list', { name: 'Search results' });
      await expect(zoomedResults).toBeVisible();
      await expect(zoomedResults.getByRole('listitem')).toHaveCount(3);
      const zoomedButtons = zoomedResults.getByRole('button', { name: /Jump to/ });
      await expect(zoomedButtons).toHaveText(PAGE_ORDER);
      for (const button of await zoomedButtons.all()) {
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
      }
      // Keep a real drawer control focused while checking the containment
      // invariant; scrolling a result does not need to move focus outside the
      // modal drawer.
      await zoomedQuery.focus();

      const zoomedLayout = await app.window.evaluate(() => {
        const drawer = window.document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
        const controls = drawer
          ? Array.from(drawer.querySelectorAll<HTMLElement>('button, input, [role="tab"]'))
          : [];
        const drawerRect = drawer?.getBoundingClientRect();
        const controlRects = controls.map((control: HTMLElement) => {
          const rect = control.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        const viewportWidth = window.innerWidth;
        return {
          viewportWidth,
          viewportHeight: window.innerHeight,
          bodyScrollWidth: window.document.body.scrollWidth,
          htmlScrollWidth: window.document.documentElement.scrollWidth,
          drawerLeft: drawerRect?.left ?? -1,
          drawerRight: drawerRect?.right ?? -1,
          drawerTop: drawerRect?.top ?? -1,
          drawerBottom: drawerRect?.bottom ?? -1,
          controlsContained: controlRects.every((rect) => rect.left >= -1 && rect.right <= viewportWidth + 1),
          focusInsideDrawer: window.document.activeElement?.closest('[data-testid="compact-drawer-right"]') !== null,
        };
      });
      expect(zoomedLayout.bodyScrollWidth).toBeLessThanOrEqual(zoomedLayout.viewportWidth + 1);
      expect(zoomedLayout.htmlScrollWidth).toBeLessThanOrEqual(zoomedLayout.viewportWidth + 1);
      expect(zoomedLayout.drawerLeft).toBeGreaterThanOrEqual(-1);
      expect(zoomedLayout.drawerRight).toBeLessThanOrEqual(zoomedLayout.viewportWidth + 1);
      expect(zoomedLayout.drawerTop).toBeGreaterThanOrEqual(-1);
      expect(zoomedLayout.drawerBottom).toBeLessThanOrEqual(zoomedLayout.viewportHeight + 1);
      expect(zoomedLayout.controlsContained).toBe(true);
      expect(zoomedLayout.focusInsideDrawer).toBe(true);
    } finally {
      await app.electronApp.evaluate(({ BrowserWindow }, state) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        win.setBounds(state.bounds);
        win.webContents.setZoomFactor(1.0);
      }, originalWindowState);
      await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win?.webContents.getZoomFactor() ?? 0;
      })).toBe(1);
    }
  });
});
