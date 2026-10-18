import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { choosePalette } from './listbox';

test.describe('Defect 15: clear transient search state on document close', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let userDataDir: string | null = null;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-search-close-'));
    app = await launchInterleaf();
    userDataDir = app.userDataDir;
  });

  test.afterEach(async () => {
    await app.close({ preserveUserData: true });
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('clears PDF and reflow search state through close, narrow layout, zoom, and restart', async () => {
    const pdfPath = join(fixtureDir, 'Search_Close_Reset.pdf');
    const markdownPath = join(fixtureDir, 'Search_Close_Reset.md');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Search Close Reset PDF',
      author: 'Interleaf',
      pageLines: [
        ['PDF searchable phrase for lifecycle reset.'],
        ['PDF second page remains indexed after close.'],
      ],
    }));
    writeFileSync(markdownPath, makeMarkdownFixture({
      title: 'Search Close Reset Markdown',
      author: 'Interleaf',
      body: '# Search Close Reset\n\nMarkdown reflow searchable phrase for lifecycle reset.\n',
    }));

    await stubOpenDialog(app, [pdfPath, markdownPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const pdf = documents.find((document) => document.format === 'pdf');
    const markdown = documents.find((document) => document.format === 'markdown');
    expect(pdf).toBeDefined();
    expect(markdown).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdf!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    pdf!.id)).toBe('ready');
    await app.window.getByRole('tab', { name: 'Search' }).click();
    const searchInput = app.window.getByLabel('Search indexed text');
    await searchInput.fill('searchable phrase');
    await app.window.getByRole('button', { name: 'Search' }).click();
    await expect(app.window.getByRole('button', { name: /Jump to Page 1/ })).toBeVisible();

    // Closing through the real reader toolbar must clear the input, cards,
    // status, and any transient Defect 12 paint before adapter/IPC awaits end.
    await returnToLibrary(app);
    await expect(app.window.getByTestId(`read-doc-${pdf!.id}`)).toBeVisible();
    const searchTab = app.window.getByRole('tab', { name: 'Search' });
    await searchTab.click();
    await expect(searchInput).toHaveValue('');
    await expect(app.window.getByRole('list', { name: 'Search results' }).getByRole('listitem')).toHaveCount(0);
    await expect(app.window.getByTestId('search-panel').getByRole('status')).toHaveText(/Open a document to build its search index/i);

    // Reopening the same durable document does not restore transient query UI.
    await app.window.getByTestId(`read-doc-${pdf!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await searchTab.click();
    await expect(searchInput).toHaveValue('');
    await expect(app.window.getByRole('list', { name: 'Search results' }).getByRole('listitem')).toHaveCount(0);

    for (const paletteId of ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight'] as const) {
      await choosePalette(app.window, paletteId);
      await expect(searchInput).toBeVisible();
      expect(await searchInput.inputValue()).toBe('');
    }
    await app.window.emulateMedia({ forcedColors: 'active' });
    const forcedBounds = await searchInput.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { right: bounds.right, viewportWidth: window.innerWidth, color: getComputedStyle(element).color };
    });
    expect(forcedBounds.color).not.toBe('');
    expect(forcedBounds.right).toBeLessThanOrEqual(forcedBounds.viewportWidth + 1);
    await app.window.emulateMedia({ forcedColors: 'none' });
    await choosePalette(app.window, 'paper');

    // The supported narrow layout and the real compact drawer retain the same
    // empty state without body overflow at 100% and native 200% zoom.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
      window.setSize(700, 900);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(920);
    const narrowZoom = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
    expect(narrowZoom).toBe(1);
    const narrowToggle = app.window.getByTestId('toggle-right-panel');
    if ((await narrowToggle.getAttribute('aria-expanded')) !== 'true') await narrowToggle.click();
    await searchTab.click();
    const narrowMetrics = await app.window.evaluate(() => ({
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      inputRight: document.querySelector<HTMLInputElement>('[data-testid="document-search-input"]')?.getBoundingClientRect().right ?? 0,
      viewportWidth: window.innerWidth,
    }));
    expect(narrowMetrics.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(narrowMetrics.inputRight).toBeLessThanOrEqual(narrowMetrics.viewportWidth + 1);
    await expect(searchInput).toHaveValue('');
    const narrowDrawer = app.window.getByTestId('compact-drawer-right');
    if (await narrowDrawer.count() > 0 && await narrowDrawer.isVisible()) {
      await app.window.getByTestId('close-compact-drawer').click();
    }

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      // Resize only after native zoom has settled so the responsive listener
      // observes the effective compact CSS width rather than the old width.
      window.setSize(1500, 900);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    const zoomFactor = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
    expect(zoomFactor).toBe(2);
    const zoomToggle = app.window.getByTestId('toggle-right-panel');
    const compactDrawer = app.window.getByTestId('compact-drawer-right');
    // Wait for AppHeader to receive the compact presentation prop. The
    // compact aria-controls value is the accessible responsive-state signal;
    // aria-expanded alone is ambiguous while the desktop preference is true.
    await expect.poll(async () => zoomToggle.getAttribute('aria-controls')).toBe('compact-drawer-right');
    if (await compactDrawer.count() > 0 && await compactDrawer.isVisible()) {
      await app.window.getByTestId('close-compact-drawer').click();
      await expect(compactDrawer).toHaveCount(0);
    }
    await expect(zoomToggle).toHaveAttribute('aria-expanded', 'false');
    await zoomToggle.click();
    await expect(compactDrawer).toBeVisible();
    const zoomedSearch = compactDrawer.getByLabel('Search indexed text');
    await expect(zoomedSearch).toHaveValue('');
    const zoomMetrics = await app.window.evaluate(() => ({
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      inputRight: document.querySelector<HTMLInputElement>('[data-testid="document-search-input"]')?.getBoundingClientRect().right ?? 0,
      viewportWidth: window.innerWidth,
    }));
    expect(zoomMetrics.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(zoomMetrics.inputRight).toBeLessThanOrEqual(zoomMetrics.viewportWidth + 1);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
    });
    await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(1);
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(700, 900);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(920);
    await expect.poll(async () => app.window.getByTestId('toggle-right-panel').getAttribute('aria-controls')).toBe('companion-panel');
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(1400, 900);
    });

    // Confirm a reflow document follows the same close contract.
    await returnToLibrary(app);
    await expect(app.window.getByTestId(`read-doc-${markdown!.id}`)).toBeVisible();
    await app.window.getByTestId(`read-doc-${markdown!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    markdown!.id)).toBe('ready');
    await app.window.getByRole('tab', { name: 'Search' }).click();
    const reflowInput = app.window.getByLabel('Search indexed text');
    await reflowInput.fill('reflow searchable phrase');
    await app.window.getByRole('button', { name: 'Search' }).click();
    await expect(app.window.getByRole('button', { name: /Jump to/ })).toBeVisible();
    await returnToLibrary(app);
    await expect(app.window.getByTestId(`read-doc-${markdown!.id}`)).toBeVisible();
    await app.window.getByTestId(`read-doc-${markdown!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await expect(reflowInput).toHaveValue('');
    await expect(app.window.getByRole('list', { name: 'Search results' }).getByRole('listitem')).toHaveCount(0);

    // Restart is a persistence boundary too: query text is renderer-only and
    // must not be recovered from the durable database.
    userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    const reopened = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(reopened.some((document) => document.id === pdf!.id)).toBe(true);
    await app.window.getByTestId(`read-doc-${markdown!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await expect(app.window.getByLabel('Search indexed text')).toHaveValue('');
  });
});
