import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, searchStatus, stubOpenDialog, type AppHandle } from './helpers';
import {
  makeDocxFixture,
  makeEpubFixture,
  makeMarkdownFixture,
  makeMobiFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';
import { choosePalette } from './listbox';

type ReaderFormat = 'pdf' | 'markdown' | 'docx' | 'epub' | 'mobi';

async function hasSearchRange(app: AppHandle, format: ReaderFormat): Promise<{ registered: boolean; text: string[] }> {
  if (format === 'epub' || format === 'mobi') {
    return app.window.locator('[data-testid="pdf-viewport-container"] iframe').evaluate((element) => {
      const frame = element as HTMLIFrameElement;
      const css = frame.contentDocument?.defaultView?.CSS;
      if (!css?.highlights) return { registered: false, text: [] };
      const highlights = css.highlights;
      const highlight = highlights.get('interleaf-search');
      return {
        registered: highlights.has('interleaf-search'),
        text: highlight ? Array.from(highlight as Iterable<Range>).map((range) => Range.prototype.toString.call(range)) : [],
      };
    });
  }
  return app.window.evaluate(() => {
    const highlight = CSS.highlights.get('interleaf-search');
    return {
      registered: CSS.highlights.has('interleaf-search'),
      text: highlight ? Array.from(highlight as Iterable<Range>).map((range) => Range.prototype.toString.call(range)) : [],
    };
  });
}

async function expectCausativeRanges(
  app: AppHandle,
  format: ReaderFormat,
  term: string,
  expectedCount?: number
): Promise<void> {
  await expect.poll(() => hasSearchRange(app, format)).toMatchObject({ registered: true });
  const result = await hasSearchRange(app, format);
  expect(result.registered).toBe(true);
  expect(result.text.length).toBeGreaterThanOrEqual(2);
  if (expectedCount !== undefined) expect(result.text).toHaveLength(expectedCount);
  // The exact painted string, not merely the range count: an offset that has
  // drifted by one text-item boundary still produces the right number of
  // ranges while painting the neighbouring characters.
  expect(result.text).toEqual(result.text.map(() => term));
}

test.describe('Defect 12 — exact transient yellow search result highlighting', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let paths: string[];

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-search-highlight-e2e-'));
    const needle = 'Exact Search Needle';
    const pdf = join(fixtureDir, 'Exact_Search_Needle.pdf');
    const markdown = join(fixtureDir, 'Exact_Search_Needle.md');
    const docx = join(fixtureDir, 'Exact_Search_Needle.docx');
    const epub = join(fixtureDir, 'Exact_Search_Needle.epub');
    const mobi = join(fixtureDir, 'Exact_Search_Needle.mobi');
    writeFileSync(pdf, makePdfFixture({
      title: 'Search Needle PDF',
      // Genuinely multi-item pages: every line is its own `Tj`, so PDF.js
      // emits one text item per line. The indexed page text joins those items
      // with a synthetic space while the rendered text layer concatenates them
      // with nothing, so an indexed offset applied straight to the DOM drifts
      // one character per preceding boundary. A single-item page makes both
      // spaces identical and would hide that class of defect entirely.
      //
      // Both repeated terms stay on one line so they remain fully visible in
      // the real 200% companion-drawer capture, and so the annotation
      // coexistence step below still finds a repeated term in one text node.
      pageLines: [
        ['Introductory filler line one.', 'Second filler line with padding.', `before ${needle} after`],
        ['Leading filler line for page two.', `${needle} ${needle}`],
      ],
    }));
    writeFileSync(markdown, makeMarkdownFixture({
      title: 'Search Needle Markdown',
      body: `# Search Needle Markdown\n\nfirst ${needle} then ${needle} again.`,
    }));
    writeFileSync(docx, makeDocxFixture({
      title: 'Search Needle DOCX',
      bodyText: `first ${needle} then ${needle} again.`,
      includeImage: false,
    }));
    writeFileSync(epub, makeEpubFixture({
      title: 'Search Needle EPUB',
      chapters: [{ title: 'Needle chapter', content: `\n      <div>\n        <p>first ${needle} then ${needle} again.</p>\n      </div>\n    ` }],
    }));
    writeFileSync(mobi, makeMobiFixture({
      title: 'Search Needle MOBI',
      chapters: [{ title: 'Needle chapter', content: `\n      <div>\n        <p>first ${needle} then ${needle} again.</p>\n      </div>\n    ` }],
    }));
    paths = [pdf, markdown, docx, epub, mobi];
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('paints the selected native occurrence for PDF and every reflow adapter, then cleans up', async () => {
    await stubOpenDialog(app, paths);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(documents).toHaveLength(5);
    const byFormat = new Map(documents.map((document) => [document.format, document]));
    const needle = 'Needle';

    for (const format of ['pdf', 'markdown', 'docx', 'epub', 'mobi'] as const) {
      const entry = byFormat.get(format);
      expect(entry).toBeDefined();
      if (!entry) continue;
      await app.window.getByTestId(`read-doc-${entry.id}`).click();
      await expect(app.window.getByTestId('reader-view')).toBeVisible();
      await expect.poll(async () => app.window.evaluate(async (documentId) =>
        (await window.interleafAPI.search.getIndexState(documentId))?.status ?? 'missing', entry.id
      )).toBe('ready');
      await app.window.getByRole('tab', { name: 'Search' }).click();
      const panel = app.window.getByTestId('search-panel');
      await panel.getByLabel('Search indexed text').fill(needle);
      await panel.getByRole('button', { name: 'Search', exact: true }).click();
      const result = panel.getByRole('list', { name: 'Search results' });
      await expect(result.getByRole('listitem').first()).toBeVisible();
      await result.getByRole('button', { name: /Jump to/ }).last().click();
      await expect(searchStatus(app)).toContainText('Matched');
      await expectCausativeRanges(app, format, needle, format === 'pdf' ? 2 : undefined);

      if (format === 'pdf') {
        // Guards the fixture itself: the jumped-to page must render more than
        // one glyph span, otherwise its indexed and rendered character spaces
        // coincide and the exact-text assertions above prove nothing.
        const glyphSpans = await app.window
          .locator('[data-testid="pdf-textlayer-p2"] span:not(.markedContent)')
          .count();
        expect(glyphSpans).toBeGreaterThanOrEqual(2);
      }

      if (format === 'pdf') {
        // Create a persisted annotation through the real selection toolbar. It
        // must coexist with, and outlive, the dedicated transient registry.
        const pageTwo = app.window.getByTestId('pdf-textlayer-p2');
        await expect(pageTwo).toBeVisible();
        await pageTwo.evaluate((layer) => {
          const target = 'Needle';
          const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? '';
            const first = text.indexOf(target);
            const second = first < 0 ? -1 : text.indexOf(target, first + target.length);
            if (second < 0) continue;
            const range = layer.ownerDocument.createRange();
            range.setStart(node, second);
            range.setEnd(node, second + target.length);
            const selection = layer.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
            return;
          }
          throw new Error('Expected repeated PDF search term for annotation coexistence.');
        });
        await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Yellow highlight' }).click();
        const persistedAnnotationId = await app.window.evaluate(async (documentId) =>
          (await window.interleafAPI.annotations.list(documentId, { limit: 20 }))[0]?.id ?? null, entry.id);
        expect(persistedAnnotationId).not.toBeNull();
        await expect.poll(async () => app.window.evaluate(() => CSS.highlights.has('interleaf-yellow'))).toBe(true);
      }

      if (format === 'pdf') {
        for (const palette of ['sepia', 'moss', 'ocean', 'graphite', 'midnight', 'paper']) {
          await choosePalette(app.window, palette);
          await expect(app.window.locator('html')).toHaveAttribute('data-theme', palette);
          await expect.poll(() => hasSearchRange(app, format)).toMatchObject({ registered: true });
        }
        const searchStyle = await app.window.locator('#interleaf-search-highlight-styles').textContent();
        expect(searchStyle).toContain('text-decoration: underline 2px solid var(--warning');
        expect(searchStyle).toContain('color: inherit');
        await app.window.emulateMedia({ forcedColors: 'active' });
        await expect.poll(async () => app.window.evaluate(() =>
          document.getElementById('interleaf-search-highlight-styles')?.textContent.includes('background-color: Highlight') === true &&
          document.getElementById('interleaf-search-highlight-styles')?.textContent.includes('color: HighlightText') === true,
        )).toBe(true);
        await expect.poll(() => hasSearchRange(app, format)).toMatchObject({ registered: true });
        await app.window.emulateMedia({ forcedColors: 'none' });
      }

      // A new executed query clears only the transient search range.
      if (format === 'pdf') await app.window.getByRole('tab', { name: 'Search' }).click();
      await panel.getByLabel('Search indexed text').fill('does-not-exist');
      await panel.getByRole('button', { name: 'Search', exact: true }).click();
      await expect.poll(() => hasSearchRange(app, format)).toEqual({ registered: false, text: [] });
      if (format === 'pdf') await expect.poll(async () => app.window.evaluate(() => CSS.highlights.has('interleaf-yellow'))).toBe(true);

      if (format === 'pdf') {
        // Re-running the query after a no-match search paints the range again.
        await panel.getByLabel('Search indexed text').fill(needle);
        await panel.getByRole('button', { name: 'Search', exact: true }).click();
        await result.getByRole('button', { name: /Jump to/ }).last().click();
        await expectCausativeRanges(app, format, needle);

        const originalBounds = await app.electronApp.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) throw new Error('Main BrowserWindow unavailable.');
          const bounds = win.getBounds();
          win.setSize(1800, 1200);
          win.webContents.setZoomFactor(2);
          return bounds;
        });
        try {
          await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0
          )).toBe(2);
          const rightToggle = app.window.getByTestId('toggle-right-panel');
          if (await rightToggle.isVisible()) {
            const rightDrawer = app.window.getByTestId('compact-drawer-right');
            if (await rightDrawer.isHidden()) await rightToggle.click();
            await expect(rightDrawer).toBeVisible();
            const drawerSearch = rightDrawer.getByRole('tab', { name: 'Search' });
            if (await drawerSearch.getAttribute('aria-selected') !== 'true') await drawerSearch.click();
            await expect(rightDrawer.getByTestId('search-panel')).toBeVisible();
            const zoomedPanel = rightDrawer.getByTestId('search-panel');
            await zoomedPanel.getByLabel('Search indexed text').fill(needle);
            await zoomedPanel.getByRole('button', { name: 'Search', exact: true }).click();
            await zoomedPanel.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /Jump to/ }).last().click();
            await expectCausativeRanges(app, format, needle);
          } else {
            const zoomedPanel = app.window.getByTestId('search-panel');
            await expect(zoomedPanel).toBeVisible();
            await zoomedPanel.getByLabel('Search indexed text').fill(needle);
            await zoomedPanel.getByRole('button', { name: 'Search', exact: true }).click();
            await zoomedPanel.getByRole('list', { name: 'Search results' }).getByRole('button', { name: /Jump to/ }).last().click();
            await expectCausativeRanges(app, format, needle);
          }
          await expect.poll(() => app.window.evaluate(() => {
            const layout = {
              body: document.body.scrollWidth,
              html: document.documentElement.scrollWidth,
              viewport: window.innerWidth,
              visible: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="search-panel"]')).some((panel) => panel.getBoundingClientRect().width > 0),
            };
            return layout.visible && layout.body <= layout.viewport + 1 && layout.html <= layout.viewport + 1;
          })).toBe(true);
          const zoomedLayout = await app.window.evaluate(() => ({
            body: document.body.scrollWidth,
            html: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            visible: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="search-panel"]')).some((panel) => panel.getBoundingClientRect().width > 0),
          }));
          expect(zoomedLayout.visible).toBe(true);
          expect(zoomedLayout.body).toBeLessThanOrEqual(zoomedLayout.viewport + 1);
          expect(zoomedLayout.html).toBeLessThanOrEqual(zoomedLayout.viewport + 1);
        } finally {
          await app.electronApp.evaluate(({ BrowserWindow }, bounds) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) return;
            win.setBounds(bounds);
            win.webContents.setZoomFactor(1);
          }, originalBounds);
        }
        const preservedUserDataDir = app.userDataDir;
        await app.close({ preserveUserData: true });
        app = await launchInterleaf({ userDataDir: preservedUserDataDir });
        const reopenedPdf = (await app.window.evaluate(async () => window.interleafAPI.library.listDocuments()))
          .find((candidate) => candidate.format === 'pdf');
        expect(reopenedPdf).toBeDefined();
        if (reopenedPdf) {
          await app.window.getByTestId(`read-doc-${reopenedPdf.id}`).click();
          await expect(app.window.getByTestId('reader-view')).toBeVisible();
          await expect.poll(() => hasSearchRange(app, format)).toEqual({ registered: false, text: [] });
        }
      }
      await returnToLibrary(app);
      await expect(app.window.getByTestId('library-view')).toBeVisible();
    }
  });
});
