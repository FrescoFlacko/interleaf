import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('PDF Link Annotations E2E Workflow', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-link-test-'));
    samplePdfPath = join(fixtureDir, 'Interactive_Links_Document.pdf');

    const pdfBuffer = makePdfFixture({
      title: 'Interactive Links Guide',
      author: 'Interleaf Testing',
      pages: [
        'Table of Contents. Click Chapter 1 below to navigate to page two.',
        'Chapter 1: Foundations of Distributed Systems. This is the navigation target on page two.',
        'Chapter 2: Storage and Retrieval. Additional document content.',
      ],
      links: [
        {
          pageNumber: 1,
          rect: [72, 700, 300, 730],
          targetPage: 2,
          destMode: 'XYZ',
          destCoords: [72, 720],
        },
        {
          pageNumber: 1,
          rect: [72, 640, 350, 670],
          url: 'https://example.com/interleaf-external-test',
        },
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

  test('renders interactive link layer and navigates internal destinations via click and keyboard', async () => {
    // 1. Initial State: Library View is active
    await expect(app.window.getByTestId('library-view')).toBeVisible();

    // 2. Import multi-page PDF via native file dialog stub
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    // 3. Open imported document in reader
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    // Named `importedDocument`, not `document`: a local binding called `document`
    // shadows the DOM global inside the `evaluate` closures below.
    const importedDocument = documents.find((entry) => entry.title === 'Interactive Links Guide');
    expect(importedDocument, 'imported interactive-links fixture document').toBeDefined();
    const documentCard = app.window.getByTestId(`document-card-${importedDocument!.id}`);
    await documentCard.click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    // 4. Verify interactive PDF annotation/link layer is rendered on page 1
    const annotationLayer = app.window.getByTestId('pdf-annotationlayer-p1');
    await expect(annotationLayer).toBeVisible();

    // 5. Verify internal link attributes (tabindex, aria-label)
    const links = annotationLayer.locator('.linkAnnotation > a');
    await expect(links).toHaveCount(2);

    const internalLink = links.first();
    await expect(internalLink).toHaveAttribute('tabindex', '0');
    const ariaLabel = await internalLink.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();

    // 6. Click internal TOC link: navigates to target Page 2
    await internalLink.click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    const pdfScroller = app.window.getByTestId('pdf-scroll-container');
    await expect.poll(() => app.window.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      const targetPage = document.querySelector<HTMLElement>('[data-testid="pdf-page-2"]');
      return scroller !== null && targetPage !== null && scroller.scrollTop >= targetPage.offsetTop;
    })).toBe(true);

    // 7. Scroll back to Page 1 for keyboard activation verification
    const p1 = app.window.getByTestId('pdf-page-1');
    await p1.scrollIntoViewIfNeeded();
    await expect(annotationLayer).toBeVisible();

    // 8. Keyboard activation: focus internal link and press Enter
    await internalLink.focus();
    await expect(internalLink).toBeFocused();
    await app.window.keyboard.press('Enter');

    // Page two stays within the virtualizer's overscan window, so assert the
    // reader's actual page state and scroll position rather than canvas presence.
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect.poll(() => pdfScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
});
