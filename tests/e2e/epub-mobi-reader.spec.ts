import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, type AppHandle } from './helpers';
import { makeEpubFixture, makeKf8Fixture, makeMobiFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue, choosePalette } from './listbox';

test.describe('EPUB & MOBI Reader End-to-End Workflows (Phase 4 Slice)', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let sampleEpubPath: string;
  let sampleMobiPath: string;
  let sampleKf8Path: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-ebook-e2e-'));
    sampleEpubPath = join(fixtureDir, 'Operating_Systems.epub');
    sampleMobiPath = join(fixtureDir, 'Database_Internals.mobi');
    sampleKf8Path = join(fixtureDir, 'Interleaf_KF8.azw3');

    const epubBuffer = makeEpubFixture({
      title: 'Operating Systems Principles',
      author: 'Andrew Tanenbaum',
      chapters: [
        {
          title: 'Chapter 1: Processes and Threads',
          content: '<p>Processes provide memory isolation across address spaces. ' +
            Array.from({ length: 400 }, (_, index) => `Process scheduling detail ${String(index + 1)}. `).join('') +
            '</p>',
        },
        {
          title: 'Chapter 2: Memory Management',
          content: '<p>Virtual memory paging and TLB translation.</p>',
        },
        {
          title: 'Chapter 3: File Systems',
          content: '<p>Inodes, journaling, and block storage architectures.</p>',
        },
      ],
    });
    writeFileSync(sampleEpubPath, epubBuffer);

    const mobiBuffer = makeMobiFixture({
      title: 'Database Internals',
      author: 'Alex Petrov',
      chapters: [
        {
          title: 'Chapter 1: B-Trees',
          content: '<p>B-Trees organize on-disk pages into balanced search trees. ' +
            Array.from({ length: 400 }, (_, index) => `B-Tree page detail ${String(index + 1)}. `).join('') +
            '</p>',
        },
        {
          title: 'Chapter 2: LSM-Trees',
          content: '<p>LSM-Trees append writes into MemTables and SSTables.</p>',
        },
        {
          title: 'Chapter 3: Distributed Transactions',
          content: '<p>Two-phase commit and Paxos consensus.</p>',
        },
      ],
      maliciousScript: 'window.__interleafMobiWorkerEscape = true;',
      maliciousEventHandler: 'onload="window.__interleafMobiWorkerEscape = true"',
      maliciousImgSrc: 'data:image/png;base64,PHN2Zy8+',
      rasterResource: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    writeFileSync(sampleMobiPath, mobiBuffer);
    writeFileSync(sampleKf8Path, makeKf8Fixture());

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('imports EPUB into library, opens in reader, navigates chapters, TOC outline, zooms, and restores reading position', async () => {
    // 1. Initial State: Library View is active
    await expect(app.window.getByTestId('library-view')).toBeVisible();

    // 2. Import EPUB via native file dialog stub
    await stubOpenDialog(app, [sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docs).toHaveLength(1);
    const epubDoc = docs[0]!;
    expect(epubDoc.title).toBe('Operating Systems Principles');
    expect(epubDoc.format).toBe('epub');

    // 3. Open in reader
    const readBtn = app.window.getByTestId(`read-doc-${epubDoc.id}`);
    await expect(readBtn).toBeVisible();
    await readBtn.click();

    // 4. Transition to ReaderView
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // The header no longer carries a format badge; the rendered ebook frame
    // below is the evidence that the format was routed correctly.
    await expect(app.window.getByTestId('reader-document-title')).toContainText('Operating Systems Principles');

    // 5. Verify real rendered book text inside iframe
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByRole('heading', { level: 1 })).toContainText('Chapter 1: Processes and Threads');
    await expect(iframe.getByText('Processes provide memory isolation')).toBeVisible();

    // Persist and restore a precise position inside the long first chapter.
    await iframe.locator('body').evaluate((body) => {
      const frameWindow = body.ownerDocument.defaultView!;
      frameWindow.scrollTo(0, body.ownerDocument.documentElement.scrollHeight * 0.55);
    });
    await expect.poll(async () => {
      const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
      const location = document?.readingPosition?.location;
      return location?.format === 'epub' && location.cfi.includes('!');
    }).toBe(true);
    const savedEpubFraction = await iframe.locator('body').evaluate((body) => {
      const root = body.ownerDocument.scrollingElement ?? body.ownerDocument.documentElement;
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      return root.scrollTop / maxScroll;
    });
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${epubDoc.id}`).click();
    await expect.poll(() => iframe.locator('body').evaluate((body) => {
      const root = body.ownerDocument.scrollingElement ?? body.ownerDocument.documentElement;
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      return root.scrollTop / maxScroll;
    })).toBeCloseTo(savedEpubFraction, 1);

    // 6. Navigation: Next page / chapter
    await app.window.getByTestId('next-page-button').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(iframe.getByRole('heading', { level: 1 })).toContainText('Chapter 2: Memory Management');

    // 7. Table of Contents Outline
    const outlineBtn = app.window.getByTestId('toggle-toc-button');
    await expect(outlineBtn).toBeVisible();
    await outlineBtn.click();

    const outlineSidebar = app.window.getByTestId('reader-outline-sidebar');
    await expect(outlineSidebar).toBeVisible();
    await expect(outlineSidebar.getByText('Chapter 3: File Systems')).toBeVisible();

    // Navigate to Chapter 3 via TOC
    await outlineSidebar.getByText('Chapter 3: File Systems').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('3');
    await expect(iframe.getByRole('heading', { level: 1 })).toContainText('Chapter 3: File Systems');

    // Close TOC
    await app.window.getByTestId('close-toc-button').click();
    await expect(outlineSidebar).not.toBeVisible();

    // 8. Zoom / Typography controls (inside the Display Settings popover)
    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    const zoomSelect = app.window.getByTestId('zoom-mode-select');
    await chooseListboxValue(zoomSelect, '1.25');
    await app.window.getByTestId('zoom-in-button').click();
    await app.window.getByTestId('zoom-out-button').click();

    await chooseListboxValue(app.window.getByTestId('line-spacing-select'), '1.9');
    await chooseListboxValue(app.window.getByTestId('reader-margin-select'), '4');
    const reflowStyles = await iframe.locator('body').evaluate((body) => {
      const styles = getComputedStyle(body);
      return {
        lineHeight: Number.parseFloat(styles.lineHeight),
        paddingLeft: Number.parseFloat(styles.paddingLeft),
      };
    });
    expect(reflowStyles.lineHeight).toBeGreaterThan(25);
    expect(reflowStyles.paddingLeft).toBeGreaterThan(50);

    await choosePalette(app.window, 'midnight');
    await expect(app.window.getByTestId('theme-menu-trigger')).toHaveAttribute('aria-label', 'Theme: Midnight');
    await expect
      .poll(() =>
        iframe.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)
      )
      .toBe('rgb(5, 6, 7)');

    // 9. Back to library and reopen: position restore
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();

    // Reopen document
    await app.window.getByTestId(`read-doc-${epubDoc.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('3');
  });

  test('imports MOBI into library, opens in reader, navigates sections, and restores reading position', async () => {
    // 1. Initial State: Library View is active
    await expect(app.window.getByTestId('library-view')).toBeVisible();

    // 2. Import MOBI via native file dialog stub
    await stubOpenDialog(app, [sampleMobiPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docs).toHaveLength(1);
    const mobiDoc = docs[0]!;
    expect(mobiDoc.title).toBe('Database Internals');
    expect(mobiDoc.format).toBe('mobi');

    // 3. Open in reader
    const readBtn = app.window.getByTestId(`read-doc-${mobiDoc.id}`);
    await expect(readBtn).toBeVisible();
    await readBtn.click();

    // 4. Transition to ReaderView
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // The header no longer carries a format badge; the rendered ebook frame
    // below is the evidence that the format was routed correctly.
    await expect(app.window.getByTestId('reader-document-title')).toContainText('Database Internals');

    // 5. Verify real rendered sanitized MOBI text in iframe
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByRole('heading', { level: 1 })).toContainText('Chapter 1: B-Trees');
    await expect(iframe.getByText('B-Trees organize on-disk pages')).toBeVisible();
    const embeddedRaster = iframe.getByAltText('Embedded MOBI raster');
    await expect(embeddedRaster).toHaveAttribute('src', /^data:image\/png;base64,/);
    const hostileMarkup = await app.window.locator('iframe[title="Ebook Content"]').getAttribute('srcdoc');
    expect(hostileMarkup).toContain('Adversarial MOBI Event Handler');
    expect(hostileMarkup).not.toContain('<script');
    expect(hostileMarkup).not.toContain('onload=');
    expect(hostileMarkup).not.toContain('__interleafMobiWorkerEscape');
    await expect(iframe.getByAltText('Tracker')).not.toHaveAttribute('src', /.+/);

    await iframe.locator('body').evaluate((body) => {
      const frameWindow = body.ownerDocument.defaultView!;
      frameWindow.scrollTo(0, body.ownerDocument.documentElement.scrollHeight * 0.5);
    });
    await expect.poll(async () => {
      const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
      const location = document?.readingPosition?.location;
      return location?.format === 'mobi' ? location.progression ?? 0 : 0;
    }).toBeGreaterThan(0);
    const savedMobiFraction = await iframe.locator('body').evaluate((body) => {
      const root = body.ownerDocument.scrollingElement ?? body.ownerDocument.documentElement;
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      return root.scrollTop / maxScroll;
    });
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${mobiDoc.id}`).click();
    await expect.poll(() => iframe.locator('body').evaluate((body) => {
      const root = body.ownerDocument.scrollingElement ?? body.ownerDocument.documentElement;
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      return root.scrollTop / maxScroll;
    })).toBeCloseTo(savedMobiFraction, 1);

    // 6. Navigate section
    await app.window.getByTestId('next-page-button').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(iframe.getByRole('heading', { level: 1 })).toContainText('Chapter 2: LSM-Trees');

    // 7. Back to library and reopen: position restore
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();

    // Reopen document
    await app.window.getByTestId(`read-doc-${mobiDoc.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
  });

  test('applies independent reader background/text pairs across dark and light app palettes', async () => {
    await stubOpenDialog(app, [sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByText('Processes provide memory isolation')).toBeVisible();

    // Dark application chrome with a light reader remains intentionally
    // readable; the iframe receives the selected pair through srcdoc CSS.
    await choosePalette(app.window, 'midnight');
    await app.window.getByTestId('open-settings').click();
    await expect(app.window.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await app.window.getByTestId('settings-rail-theme').click();
    await chooseListboxValue(app.window.getByTestId('settings-reader-background'), 'paper');
    await expect(app.window.getByTestId('settings-reader-background')).toHaveAttribute('data-value', 'paper');
    await expect(app.window.getByTestId('reader-view')).toHaveAttribute('data-reader-background', 'paper');
    await app.window.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => iframe.locator('body').evaluate((body) => {
      const styles = getComputedStyle(body);
      return [styles.backgroundColor, styles.color];
    })).toEqual(['rgb(251, 251, 250)', 'rgb(28, 25, 23)']);

    // Light application chrome with a dark reader is the inverse pairing.
    await choosePalette(app.window, 'paper');
    await app.window.getByTestId('open-settings').click();
    await app.window.getByTestId('settings-rail-theme').click();
    await chooseListboxValue(app.window.getByTestId('settings-reader-background'), 'midnight');
    await app.window.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => iframe.locator('body').evaluate((body) => {
      const styles = getComputedStyle(body);
      return [styles.backgroundColor, styles.color];
    })).toEqual(['rgb(5, 6, 7)', 'rgb(241, 243, 245)']);
  });

  test('creates a reflowed EPUB highlight and restores its CFI anchor after restart', async () => {
    await stubOpenDialog(app, [sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByText('Processes provide memory isolation')).toBeVisible();

    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    await chooseListboxValue(app.window.getByTestId('zoom-mode-select'), '1.25');
    await chooseListboxValue(app.window.getByTestId('line-spacing-select'), '1.9');
    await iframe.locator('body').evaluate((body) => {
      const target = 'Processes provide memory isolation';
      const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = body.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = body.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        body.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('EPUB selection target was not found.');
    });
    const greenHighlight = app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Green highlight' });
    await greenHighlight.focus();
    await app.window.keyboard.press('Enter');
    await expect.poll(() => iframe.locator('body').evaluate(() => {
      const registry = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return registry?.has('interleaf-green') ?? false;
    })).toBe(true);

    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    app = await launchInterleaf({ userDataDir });
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    const restoredIframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(restoredIframe.getByText('Processes provide memory isolation')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    await expect(app.window.getByText('“Processes provide memory isolation”')).toBeVisible();
    await expect.poll(() => restoredIframe.locator('body').evaluate(() => {
      const registry = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return registry?.has('interleaf-green') ?? false;
    })).toBe(true);
  });

  test('restores a MOBI bookmark after restart and jumps to its exact section', async () => {
    await stubOpenDialog(app, [sampleMobiPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await app.window.getByTestId('next-page-button').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await app.window.getByTestId('add-bookmark-button').click();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.annotations.page(documentId, { type: 'bookmark', limit: 50 })).total,
    document!.id)).toBe(1);

    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    app = await launchInterleaf({ userDataDir });
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByRole('heading', { level: 1 })).toContainText('Chapter 2: LSM-Trees');
    await app.window.getByTestId('page-number-input').fill('1');
    await app.window.getByTestId('page-number-input').press('Enter');
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('1');
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    await app.window.getByTestId('annotation-page-list').getByRole('button', { name: 'Go to Section 2' }).click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByRole('heading', { level: 1 })).toContainText('Chapter 2: LSM-Trees');
  });

  test('imports and renders a real KF8/AZW3 book through the pinned foliate engine', async () => {
    await stubOpenDialog(app, [sampleKf8Path]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [kf8Document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(kf8Document?.format).toBe('mobi');
    await app.window.getByTestId(`read-doc-${kf8Document!.id}`).click();

    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByText('Generated public test content for KF8 parsing.')).toBeVisible();
    await expect(app.window.getByTestId('toggle-toc-button')).toBeVisible();
    await app.window.getByTestId('toggle-toc-button').click();
    await expect(app.window.getByTestId('reader-outline-sidebar')).toContainText('Chapter 2');
    await app.window.getByTestId('close-toc-button').click();
    await app.window.getByTestId('page-number-input').fill('1');
    await app.window.getByTestId('page-number-input').press('Enter');
    await expect(iframe.getByText('Generated public test content for KF8 parsing.')).toBeVisible();
    await iframe.locator('body').evaluate((body) => {
      const target = 'Generated public test content';
      const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = body.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = body.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        body.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('KF8 selection target was not found.');
    });
    await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Purple highlight' }).click();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.annotations.page(documentId, { limit: 50 })).total,
    kf8Document!.id)).toBe(1);
    await expect.poll(() => iframe.locator('body').evaluate(() => {
      const registry = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return registry?.has('interleaf-purple') ?? false;
    })).toBe(true);
  });

  test('cancels an active production MOBI worker when the reader closes', async () => {
    const slowMobiPath = join(fixtureDir, 'Cancellation_Stress.mobi');
    writeFileSync(slowMobiPath, makeMobiFixture({
      title: 'Cancellation Stress MOBI',
      chapters: [{
        title: 'Large Worker Job',
        content: `<p>${'bounded cancellation payload '.repeat(250_000)}</p>`,
      }],
    }));
    await stubOpenDialog(app, [slowMobiPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [stressDocument] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(stressDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${stressDocument!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-loading')).toBeVisible();
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-view')).not.toBeVisible();
  });
});

async function stubOpenDialog(app: AppHandle, filePaths: readonly string[]): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [...selectedPaths], bookmarks: [] });
  }, filePaths);
}
