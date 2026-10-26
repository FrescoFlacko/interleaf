import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue } from './listbox';

test.describe('PDF Reader End-to-End Workflow (Phase 4 Slice)', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-pdf-e2e-'));
    samplePdfPath = join(fixtureDir, 'Distributed_Systems_Guide.pdf');

    const pdfBuffer = makePdfFixture({
      title: 'Distributed Systems Guide',
      author: 'Martin Kleppmann',
      pageLines: [
        [
          'Chapter 1: Reliability, Scalability, and Maintainability in Distributed Systems.',
          ...Array.from({ length: 28 }, (_, index) => `Reliability design detail ${String(index + 1)}.`),
          'Deep exact annotation target for centered navigation.',
          ...Array.from({ length: 5 }, (_, index) => `Closing design detail ${String(index + 1)}.`),
        ],
        ['Chapter 2: Data Models and Query Languages — Relational vs Document.'],
        ['Chapter 3: Storage Engines — Log-Structured Storage and B-Trees.'],
      ],
      outline: [
        { title: 'Chapter 1: Reliability', targetPage: 1 },
        { title: 'Chapter 2: Data Models', targetPage: 2 },
        { title: 'Chapter 3: Storage Engines', targetPage: 3 },
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

  test('imports PDF into library, opens in reader, navigates pages, navigates TOC outline, zooms, toggles focus mode, and returns to library', async () => {
    // 1. Initial State: Library View is active
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('section-title')).toHaveText('All Documents');
    // 2. Import multi-page PDF via native file dialog stub
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docs).toHaveLength(1);
    const pdfDoc = docs[0]!;
    expect(pdfDoc.title).toBe('Distributed Systems Guide');
    expect(pdfDoc.format).toBe('pdf');

    // 3. Document Card is displayed in library
    const card = app.window.getByTestId(`document-card-${pdfDoc.id}`);
    await expect(card).toBeVisible();

    // 4. Click Read button on document card to open in reader
    const readBtn = app.window.getByTestId(`read-doc-${pdfDoc.id}`);
    await expect(readBtn).toBeVisible();
    await readBtn.click();

    // 5. Transition to ReaderView
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-header-toolbar')).toBeVisible();
    await expect(app.window.getByTestId('reader-document-title')).toContainText(
      'Distributed Systems Guide'
    );
    // The header names the document, not its format; the PDF surfaces below
    // are what prove the format was routed to the right renderer.
    await expect(app.window.getByTestId('pdf-viewport-container')).toBeVisible();
    await expect(app.window.getByTestId('pdf-page-1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

    // Verify initial canvas is firmly attached to the page wrapper, has valid dimensions, and has rendered document ink
    const initialCanvasStatus = await inspectCanvasPaint(
      app.window.getByTestId('pdf-canvas-p1'),
      'pdf-page-1'
    );
    expect(initialCanvasStatus.isAttached).toBe(true);
    expect(initialCanvasStatus.width).toBeGreaterThan(0);
    expect(initialCanvasStatus.height).toBeGreaterThan(0);
    expect(initialCanvasStatus.hasRenderedInk).toBe(true);
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toContainText('Chapter 1: Reliability');

    // Create a real PDF text-layer highlight and verify both persistence and paint.
    await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer) => {
      const target = 'Deep exact annotation target';
      const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = layer.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = layer.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('PDF selection target was not found.');
    });
    const pinkHighlight = app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Pink highlight' });
    await pinkHighlight.focus();
    await app.window.keyboard.press('Enter');
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.annotations.list(documentId, { limit: 100 })).length,
    pdfDoc.id)).toBe(1);
    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-pink') ?? false;
    })).toBe(true);

    await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer) => {
      const target = 'Deep exact annotation target';
      const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = layer.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = layer.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('PDF selection-note target was not found.');
    });
    const selectionNoteButton = app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Add note' });
    await selectionNoteButton.focus();
    await app.window.keyboard.press('Enter');
    const selectionNoteText = app.window.getByRole('textbox', { name: 'Note on selected text' });
    await expect(selectionNoteText).toBeFocused();
    await selectionNoteText.fill('Keyboard-created selected-text note.');
    const saveSelectionNote = app.window.getByRole('button', { name: /^Done/u });
    await saveSelectionNote.focus();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('pdf-viewport-container')).toBeFocused();

    await app.window.getByTestId('annotation-page-list').getByRole('button', { name: 'Add note' }).click();
    await app.window.getByLabel('Note text').fill('Deep passage note survives restart.');
    await app.window.getByRole('button', { name: /^Done/u }).click();
    await expect(app.window.getByText('Deep passage note survives restart.')).toBeVisible();

    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    app = await launchInterleaf({ userDataDir });
    await app.window.getByTestId(`read-doc-${pdfDoc.id}`).click();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    await expect(app.window.getByText('“Deep exact annotation target”').first()).toBeVisible();
    await expect(app.window.getByText('Keyboard-created selected-text note.')).toBeVisible();
    await expect(app.window.getByText('Deep passage note survives restart.')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-pink') ?? false;
    })).toBe(true);

    const pdfScroller = app.window.getByTestId('pdf-scroll-container');
    await pdfScroller.evaluate((element) => { element.scrollTop = 0; });
    await app.window.getByRole('button', { name: 'Jump' }).first().click();
    await expect.poll(() => pdfScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);

    const noteHere = app.window.getByTestId('reader-header-toolbar').getByRole('button', { name: 'Add note' });
    await noteHere.focus();
    await app.window.keyboard.press('Enter');
    const locationNote = app.window.getByRole('textbox', { name: 'Note at current location' });
    await expect(locationNote).toBeFocused();
    await app.window.keyboard.press('Escape');
    await expect(noteHere).toBeFocused();

    // 6. Verify page indicator and jump
    await app.window.getByTestId('page-number-input').fill('1');
    await app.window.getByTestId('page-number-input').press('Enter');
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('1');
    await expect(app.window.getByTestId('total-pages')).toContainText('/ 3');
    // Click Next Page button
    await app.window.getByTestId('next-page-button').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');

    // Jump to page 1 via input
    const pageInput = app.window.getByTestId('page-number-input');
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await expect(pageInput).toHaveValue('1');

    // 7. Table of Contents Outline
    const outlineBtn = app.window.getByTestId('toggle-toc-button');
    await expect(outlineBtn).toBeVisible();
    await outlineBtn.click();

    // Verify TOC drawer opened
    const outlineSidebar = app.window.getByTestId('reader-outline-sidebar');
    await expect(outlineSidebar).toBeVisible();
    await expect(outlineSidebar.getByText('Chapter 1: Reliability')).toBeVisible();
    await expect(outlineSidebar.getByText('Chapter 2: Data Models')).toBeVisible();
    await expect(outlineSidebar.getByText('Chapter 3: Storage Engines')).toBeVisible();

    // Jump to Chapter 3 via TOC item
    await outlineSidebar.getByText('Chapter 3: Storage Engines').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('3');

    // Close TOC drawer
    await app.window.getByTestId('close-toc-button').click();
    await expect(outlineSidebar).not.toBeVisible();

    // 8. Zoom Controls (defect 24: display controls live in the settings dialog)
    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    const zoomSelect = app.window.getByTestId('zoom-mode-select');
    await chooseListboxValue(zoomSelect, '1.5');
    await app.window.getByTestId('zoom-in-button').click();
    await app.window.getByTestId('zoom-out-button').click();
    await chooseListboxValue(zoomSelect, 'fit-width');
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('document-settings-popover')).toBeHidden();

    // 9. Focus Reading Mode
    await app.window.getByTestId('reader-focus-button').click();
    // In focus mode, header toolbar is hidden and focus hint is shown
    await expect(app.window.getByTestId('reader-header-toolbar')).not.toBeVisible();
    await expect(app.window.getByText('Focus Reading Mode — press Esc to exit')).toBeVisible();

    // Press Escape to exit focus mode
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('reader-header-toolbar')).toBeVisible();

    // 10. Return to Library View
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-view')).not.toBeVisible();
  });

  test('flushes the final reading position during immediate application shutdown', async () => {
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [pdfDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await app.window.getByTestId('next-page-button').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');

    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    app = await launchInterleaf({ userDataDir });

    const [reopenedDocument] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(reopenedDocument?.readingPosition?.location).toEqual({
      format: 'pdf',
      pageIndex: 1,
    });
    await app.window.getByTestId(`read-doc-${reopenedDocument!.id}`).click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
  });

  test('renders initial multi-page PDF canvas and text content immediately without requiring any window or pane resize', async () => {
    const multiPagePdfPath = join(fixtureDir, 'Initial_Paint_Proof.pdf');
    const pdfBuffer = makePdfFixture({
      title: 'Initial Paint Proof Guide',
      author: 'Leslie Lamport',
      pages: [
        'Page 1: Zero white-screen initial render verification and canvas attachment proof.',
        'Page 2: Second page of immediate render.',
        'Page 3: Third page of immediate render.',
        'Page 4: Fourth page of immediate render.',
      ],
    });
    writeFileSync(multiPagePdfPath, pdfBuffer);

    await stubOpenDialog(app, [multiPagePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    const targetDoc = docs.find((d) => d.title === 'Initial Paint Proof Guide');
    expect(targetDoc).toBeDefined();

    // Open the 4-page PDF
    await app.window.getByTestId(`read-doc-${targetDoc!.id}`).click();

    // Verify reader view is displayed and shows 4 pages
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('total-pages')).toContainText('/ 4');

    // Verify page 1 wrapper contains attached canvas and painted content before ANY resize
    const pageWrapper = app.window.getByTestId('pdf-page-1');
    await expect(pageWrapper).toBeVisible();

    const pageCanvas = app.window.getByTestId('pdf-canvas-p1');
    await expect(pageCanvas).toBeVisible();

    const pageTextLayer = app.window.getByTestId('pdf-textlayer-p1');
    await expect(pageTextLayer).toBeVisible();
    await expect(pageTextLayer).toContainText('Zero white-screen initial render verification');

    // Confirm canvas is firmly attached inside the page wrapper, has valid dimensions, and contains rendered ink
    const initialCanvasStatus = await inspectCanvasPaint(pageCanvas, 'pdf-page-1');
    expect(initialCanvasStatus.isAttached).toBe(true);
    expect(initialCanvasStatus.width).toBeGreaterThan(0);
    expect(initialCanvasStatus.height).toBeGreaterThan(0);
    expect(initialCanvasStatus.hasRenderedInk).toBe(true);
  });
});

async function stubOpenDialog(app: AppHandle, filePaths: readonly string[]): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [...selectedPaths], bookmarks: [] });
  }, filePaths);
}

type CanvasPaintInspection = {
  readonly isAttached: boolean;
  readonly width: number;
  readonly height: number;
  readonly hasRenderedInk: boolean;
};

async function inspectCanvasPaint(
  locator: Locator,
  pageTestId: string
): Promise<CanvasPaintInspection> {
  return locator.evaluate((canvas: HTMLCanvasElement, targetPageTestId: string) => {
    const wrapper = canvas.closest(`[data-testid="${targetPageTestId}"]`);
    const isAttached = Boolean(wrapper?.contains(canvas));
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || width <= 0 || height <= 0 || !isAttached) {
      return { isAttached, width, height, hasRenderedInk: false };
    }
    const sampleWidth = Math.min(width, 600);
    const sampleHeight = Math.min(height, 400);
    const sample = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
    const data = sample.data;

    let hasRenderedInk = false;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a > 32 && (r < 200 || g < 200 || b < 200)) {
        hasRenderedInk = true;
        break;
      }
    }
    return { isAttached, width, height, hasRenderedInk };
  }, pageTestId);
}
