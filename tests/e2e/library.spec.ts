import { expect, test } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeDocxFixture,
  makeEpubFixture,
  makeMarkdownFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';

test.describe('Phase 3 Library & Folders E2E Workflow', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;
  let sampleEpubPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-fixtures-'));
    samplePdfPath = join(fixtureDir, 'Distributed_Systems.pdf');
    writeFileSync(
      samplePdfPath,
      '%PDF-1.4\n1 0 obj\n<< /Title (Distributed Systems) /Author (Leslie Lamport) /Count 100 >>\nendobj\n'
    );

    sampleEpubPath = join(fixtureDir, 'Clean_Code.epub');
    writeFileSync(sampleEpubPath, makeEpubFixture('Clean Code', 'Uncle Bob'));

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('creates virtual folders, imports documents through narrow bridge, moves documents, and persists reading progress across restart', async () => {
    // 1. Verify library sidebar and view are visible
    await expect(app.window.getByTestId('sidebar-library')).toBeVisible();
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('nav-all-documents')).toBeVisible();

    // 2. Create a virtual folder via UI modal
    await app.window.getByTestId('new-folder-button').click();
    await expect(app.window.getByTestId('new-folder-modal')).toBeVisible();
    await expect(app.window.locator('[data-app-shell]')).toHaveAttribute('inert', '');
    await expect(app.window.locator('[data-app-shell]')).toHaveAttribute('aria-hidden', 'true');
    await app.window.getByTestId('folder-name-input').fill('Research Papers');
    await app.window.getByTestId('submit-folder-button').click();
    await expect(app.window.locator('[data-app-shell]')).not.toHaveAttribute('inert', '');

    // Verify folder appears in the sidebar tree
    await expect(app.window.getByTestId('folder-tree').getByText('Research Papers')).toBeVisible();
    // 3. Exercise the actual UI -> preload -> native-dialog IPC path. The main
    // process dialog is deterministically stubbed; no renderer path API exists.
    // A renderable PDF lets the page-one cover be checked after restart.
    writeFileSync(samplePdfPath, makePdfFixture({ title: 'Distributed Systems', author: 'Leslie Lamport' }));
    await stubOpenDialog(app, [samplePdfPath, sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('2 documents');
    const importedDocuments = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(importedDocuments).toHaveLength(2);
    const pdfDoc = importedDocuments.find((document) => document.format === 'pdf')!;
    const epubDoc = importedDocuments.find((document) => document.format === 'epub')!;

    // 4. Verify documents render without type badges (defect 28) with titles and author
    await expect(app.window.getByTestId(`document-card-${pdfDoc.id}`)).toBeVisible();
    await expect(app.window.getByTestId(`document-title-${pdfDoc.id}`)).toHaveText('Distributed Systems');
    await expect(app.window.getByTestId(`document-author-${pdfDoc.id}`)).toHaveText('Leslie Lamport');
    await expect(app.window.getByTestId(`format-badge-${pdfDoc.id}`)).toHaveCount(0);

    await expect(app.window.getByTestId(`document-card-${epubDoc.id}`)).toBeVisible();
    await expect(app.window.getByTestId(`document-title-${epubDoc.id}`)).toHaveText('Clean Code');
    await expect(app.window.getByTestId(`format-badge-${epubDoc.id}`)).toHaveCount(0);
    // 5. Move PDF into the "Research Papers" folder
    const folders = await app.window.evaluate(async () => {
      return window.interleafAPI.library.listFolders();
    });
    const researchFolder = folders.find((f) => f.name === 'Research Papers')!;

    await app.window.evaluate(
      async ({ docId, folderId }) => {
        await window.interleafAPI.library.moveDocumentToFolder(docId, folderId);
      },
      { docId: pdfDoc.id, folderId: researchFolder.id }
    );

    // Click on the folder in the sidebar and verify only the PDF is in this folder view
    await app.window.getByTestId(`folder-item-${researchFolder.id}`).click();
    await expect(app.window.getByTestId('section-title')).toHaveText('Research Papers');
    await expect(app.window.getByTestId(`document-card-${pdfDoc.id}`)).toBeVisible();
    await expect(app.window.getByTestId(`document-card-${epubDoc.id}`)).toHaveCount(0);

    // 6. Update reading position to 60% on the PDF document
    await app.window.evaluate(
      async (docId) => {
        await window.interleafAPI.library.updateReadingPosition(
          docId,
          { format: 'pdf', pageIndex: 60, pageLabel: 'Page 60' },
          0.6
        );
      },
      pdfDoc.id
    );

    // Navigate to "Continue Reading" section
    await app.window.getByTestId('nav-continue-reading').click();
    await expect(app.window.getByTestId('section-title')).toHaveText('Continue Reading');
    await expect(app.window.getByTestId(`document-card-${pdfDoc.id}`)).toBeVisible();
    // Progress is the hairline alone: no visible percentage on the card, and
    // the value lives on the progressbar the hairline exposes.
    await expect(app.window.getByTestId(`reading-progress-percent-${pdfDoc.id}`)).toHaveCount(0);
    await expect(app.window.getByTestId(`reading-progress-track-${pdfDoc.id}`)).toHaveAttribute(
      'aria-valuenow',
      '60'
    );
    await expect(app.window.getByTestId(`reading-progress-${pdfDoc.id}`)).toHaveCount(0);

    // 7. Test persistence across application restart!
    const userDataDir = app.userDataDir;
    await app.electronApp.close();

    const relaunched = await launchInterleaf({ userDataDir });
    try {
      // Verify folder still exists after restart
      await expect(relaunched.window.getByTestId('folder-tree').getByText('Research Papers')).toBeVisible();
      // Verify continue reading still contains the document with 60% progress
      await relaunched.window.getByTestId('nav-continue-reading').click();
      await expect(relaunched.window.getByTestId(`document-card-${pdfDoc.id}`)).toBeVisible();
      await expect(
        relaunched.window.getByTestId(`reading-progress-track-${pdfDoc.id}`)
      ).toHaveAttribute('aria-valuenow', '60');

      // Verify All Documents contains both books
      await relaunched.window.getByTestId('nav-all-documents').click();
      await expect(relaunched.window.getByTestId(`document-card-${pdfDoc.id}`)).toBeVisible();
      await expect(relaunched.window.getByTestId(`document-card-${epubDoc.id}`)).toBeVisible();

      // Defect 26: the rasterized page-one PDF cover survives restart as a decoded image.
      const restartedCover = relaunched.window.getByTestId(`preview-cover-image-${pdfDoc.id}`);
      await restartedCover.scrollIntoViewIfNeeded();
      await expect(restartedCover).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => restartedCover.evaluate((element) => {
        const image = element as HTMLImageElement;
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      })).toBe(true);
    } finally {
      await relaunched.close();
    }
  });

  test('safely rejects unsupported or malformed files without crashing', async () => {
    const invalidFile = join(fixtureDir, 'bad_file.xyz');
    writeFileSync(invalidFile, 'malformed payload');

    await stubOpenDialog(app, [invalidFile]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('error-banner')).toContainText('Unsupported file extension');
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(documents).toHaveLength(0);

    // App remains completely healthy and responsive
    await expect(app.window.getByTestId('library-view')).toBeVisible();
  });

  test('defect 3: first-run import hero is limited to a genuinely empty library and import remains available afterward', async () => {
    // Empty-library state is authoritative only after the initial load settles.
    await expect(app.window.getByTestId('import-dropzone')).toBeVisible();
    await expect(app.window.getByText('Add books to your library')).toBeVisible();
    await expect(app.window.getByTestId('library-empty-state')).toHaveCount(0);

    // After the first import, documents become the primary content and the
    // first-run hero is removed; cards are the primary populated-library content.
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('1 document');
    const imported = (await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    ))[0]!;
    await expect(app.window.getByTestId(`document-card-${imported.id}`)).toBeVisible();
    await expect(app.window.getByTestId('document-grid')).toBeVisible();
    await expect(app.window.getByTestId('import-dropzone')).toHaveCount(0);
    await expect(app.window.getByTestId('import-files-button')).toBeEnabled();
    await expect(app.window.getByText('Add books to your library')).toHaveCount(0);

    // A filtered no-match view must not regress to the first-run hero.
    await app.window.getByTestId('library-search-input').fill('does-not-exist');
    await expect(app.window.getByTestId('library-no-results-state')).toBeVisible();
    await expect(app.window.getByTestId('import-dropzone')).toHaveCount(0);
    await expect(app.window.getByTestId('clear-library-filters-button')).toBeVisible();
    await app.window.getByTestId('clear-library-filters-button').click();
    await expect(app.window.getByTestId(`document-card-${imported.id}`)).toBeVisible();

    // The persistent Import button remains usable after the hero disappears.
    await stubOpenDialog(app, [sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('1 document');

    // Restart against the same user-data directory to verify persistence does
    // not show the first-run hero again.
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await expect(app.window.getByTestId('import-dropzone')).toHaveCount(0);
    await expect(app.window.getByTestId('document-grid')).toBeVisible();
    await expect(app.window.getByTestId(`document-card-${imported.id}`)).toBeVisible();
    await expect(app.window.getByTestId('import-files-button')).toBeEnabled();

    // Actual BrowserWindow zoomFactor(2.0) constrained layout.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 640);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 640 });
    await app.window.waitForTimeout(400);
    await expect(app.window.getByTestId('import-dropzone')).toHaveCount(0);
    await expect(app.window.getByTestId('document-grid')).toBeVisible();
    await app.window.getByTestId(`document-card-${imported.id}`).scrollIntoViewIfNeeded();
  });

  test('supports keyboard-only subfolder, rename, and delete folder operations', async () => {
    await app.window.getByTestId('new-folder-button').click();
    await app.window.getByTestId('folder-name-input').fill('Keyboard Folder');
    await app.window.getByTestId('submit-folder-button').click();
    const folder = (await app.window.evaluate(async () =>
      window.interleafAPI.library.listFolders()
    )).find((candidate) => candidate.name === 'Keyboard Folder')!;

    await app.window.getByTestId(`folder-item-${folder.id}`).focus();
    await app.window.keyboard.press('Tab');
    const addSubfolder = app.window.getByRole('button', {
      name: 'Add subfolder to Keyboard Folder',
    });
    await expect(addSubfolder).toBeFocused();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByRole('dialog', { name: 'Create new subfolder' })).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(addSubfolder).toBeFocused();

    await app.window.keyboard.press('Tab');
    const rename = app.window.getByRole('button', { name: 'Rename Keyboard Folder' });
    await expect(rename).toBeFocused();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByRole('dialog', { name: 'Rename folder' })).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(rename).toBeFocused();

    await app.window.keyboard.press('Tab');
    const remove = app.window.getByRole('button', { name: 'Delete Keyboard Folder' });
    await expect(remove).toBeFocused();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByRole('alertdialog', { name: 'Delete folder' })).toBeVisible();
  });

  test('defect 1 regression: library document cards maintain alignment and containment without icon overflow under standard and constrained viewports', async () => {
    // 1. Prepare 3 deterministic fixtures matching baseline cards
    const pdf2Path = join(fixtureDir, 'Google_Gemma_Paper.pdf');
    writeFileSync(
      pdf2Path,
      Buffer.concat([
        Buffer.from(
          "%PDF-1.4\n1 0 obj\n<< /Title (Google's Gemma AI Research Paper and Model Evaluation) /Author (Unknown author) /Count 25 >>\nendobj\n"
        ),
        Buffer.alloc(1024 * 1024 * 1.5, 0x20),
      ])
    );

    const pdf1Path = join(fixtureDir, 'Smol_Training_Playbook.pdf');
    writeFileSync(
      pdf1Path,
      Buffer.concat([
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<< /Title (The Smol Training Playbook: Deep Optimization and Scale) /Author (Unknown author) /Count 50 >>\nendobj\n'
        ),
        Buffer.alloc(1024 * 1024 * 24, 0x20),
      ])
    );

    const mdPath = join(fixtureDir, 'Session_Migration_Protocol.md');
    writeFileSync(
      mdPath,
      '---\ntitle: Session Migration Protocol Guide and Architecture Notes\nauthor: Unknown author\n---\n\n# Session Migration Protocol\n\n' +
        'Comprehensive architectural guide and migration steps for agent session context.\n\n' +
        'A'.repeat(4300)
    );
    await stubOpenDialog(app, [mdPath, pdf1Path, pdf2Path]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('3 documents');

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docs).toHaveLength(3);

    const mdDoc = docs.find((d) => d.format === 'markdown')!;
    const pdf1Doc = docs.find((d) => d.title.includes('Smol'))!;
    const pdf2Doc = docs.find((d) => d.title.includes('Gemma'))!;

    // 2. Set reading progress to match baseline screenshot state
    await app.window.evaluate(
      async ({ mdId, p1Id, p2Id }) => {
        await window.interleafAPI.library.updateReadingPosition(
          mdId,
          { format: 'markdown', blockIndex: 3 },
          0.75
        );
        await window.interleafAPI.library.updateReadingPosition(
          p1Id,
          { format: 'pdf', pageIndex: 1, pageLabel: 'Page 1' },
          0.01
        );
        await window.interleafAPI.library.updateReadingPosition(
          p2Id,
          { format: 'pdf', pageIndex: 18, pageLabel: 'Page 18' },
          0.75
        );
      },
      { mdId: mdDoc.id, p1Id: pdf1Doc.id, p2Id: pdf2Doc.id }
    );
    await app.window.getByTestId('nav-all-documents').click();

    // The document surface is now the sole primary action. The ellipsis is the
    // sole visible secondary action; Move/Delete/Read remain in its details
    // surface rather than duplicating controls on every card.
    async function assertCardSurface(docList: typeof docs, label: string): Promise<void> {
      for (const doc of docList) {
        const card = app.window.getByTestId(`document-card-${doc.id}`);
        await expect(card, `${label}: card ${doc.id} should be visible`).toBeVisible();

        const openBtn = app.window.getByTestId(`read-doc-${doc.id}`);
        const menuBtn = app.window.getByTestId(`document-menu-${doc.id}`);

        await expect(openBtn, `${label}: primary open ${doc.id} should be visible`).toBeVisible();
        await expect(menuBtn, `${label}: ellipsis ${doc.id} should be visible`).toBeVisible();
        await expect(app.window.getByTestId(`move-doc-${doc.id}`)).toHaveCount(0);
        await expect(app.window.getByTestId(`delete-doc-${doc.id}`)).toHaveCount(0);

        const cardBox = await card.boundingBox();
        const openBox = await openBtn.boundingBox();
        const menuBox = await menuBtn.boundingBox();

        expect(cardBox, `${label}: cardBox should not be null`).not.toBeNull();
        expect(openBox, `${label}: openBox should not be null`).not.toBeNull();
        expect(menuBox, `${label}: menuBox should not be null`).not.toBeNull();

        if (cardBox && openBox && menuBox) {
          expect(openBox.width, `${label}: openBox width > 10`).toBeGreaterThan(10);
          expect(openBox.height, `${label}: openBox height > 10`).toBeGreaterThan(10);
          expect(menuBox.width, `${label}: menuBox width > 10`).toBeGreaterThan(10);
          expect(menuBox.height, `${label}: menuBox height > 10`).toBeGreaterThan(10);
          expect(openBox.x, `${label}: openBox within card left`).toBeGreaterThanOrEqual(cardBox.x - 1);
          expect(openBox.x + openBox.width, `${label}: openBox within card right`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);
          expect(menuBox.x, `${label}: menuBox within card left`).toBeGreaterThanOrEqual(cardBox.x - 1);
          expect(menuBox.x + menuBox.width, `${label}: menuBox within card right`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);
          expect(menuBox.y + menuBox.height, `${label}: menuBox within card bottom`).toBeLessThanOrEqual(cardBox.y + cardBox.height + 2);
        }

        const overflowCheck = await app.window.evaluate(({ openId, menuId }) => {
          const open = document.querySelector<HTMLElement>(`[data-testid="${openId}"]`);
          const menu = document.querySelector<HTMLElement>(`[data-testid="${menuId}"]`);
          return {
            openOverflow: open ? open.scrollWidth > open.clientWidth + 2 || open.scrollHeight > open.clientHeight + 2 : false,
            menuOverflow: menu ? menu.scrollWidth > menu.clientWidth + 2 || menu.scrollHeight > menu.clientHeight + 2 : false,
          };
        }, { openId: `read-doc-${doc.id}`, menuId: `document-menu-${doc.id}` });

        expect(overflowCheck.openOverflow, `${label} ${doc.id}: primary button should not overflow scroll boundaries`).toBe(false);
        expect(overflowCheck.menuOverflow, `${label} ${doc.id}: ellipsis should not overflow scroll boundaries`).toBe(false);
      }
    }

    // 3. Standard desktop test (1280x800, 100% zoom)
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1280, 800);
        win.webContents.setZoomFactor(1.0);
      }
    });
    await app.window.setViewportSize({ width: 1280, height: 800 });
    await app.window.waitForTimeout(500);

    await assertCardSurface([mdDoc, pdf1Doc, pdf2Doc], '1280x800 @ 100% zoom');

    // 4. Constrained viewport test (960x640 at 200% zoom factor)
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 640);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.waitForTimeout(500);

    await assertCardSurface([mdDoc, pdf1Doc, pdf2Doc], '960x640 @ 200% zoom');

    // Reset zoom back to 1.0
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.setZoomFactor(1.0);
      }
    });
  });

  test('defect 2 regression: library document cards render visual document preview thumbnails with page 1 or last-read location badges', async () => {
    // 1. Prepare 4 representative fixtures
    const pdfPath = join(fixtureDir, 'Distributed_Systems_Guide.pdf');
    const mdPath = join(fixtureDir, 'Session_Architecture_Guide.md');
    const epubPath = join(fixtureDir, 'Clean_Code_Principles.epub');
    const docxPath = join(fixtureDir, 'DOCX_Foundations.docx');

    writeFileSync(
      pdfPath,
      makePdfFixture({ title: 'Distributed Systems Guide', author: 'Leslie Lamport' })
    );
    writeFileSync(
      mdPath,
      makeMarkdownFixture({
        title: 'Session Architecture Guide',
        author: 'Interleaf Team',
        body: '# Session Architecture Guide\n\nFoundations of local preview extraction.\n\n## Architecture Pipeline\n\nDeep dive into document preview architecture.',
      })
    );
    writeFileSync(epubPath, makeEpubFixture('Clean Code Principles', 'Robert C. Martin'));
    writeFileSync(docxPath, makeDocxFixture('DOCX Technical Foundations', 'Engineering Team'));

    await stubOpenDialog(app, [pdfPath, mdPath, epubPath, docxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toContainText('4 documents');

    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docs).toHaveLength(4);

    const pdfDoc = docs.find((d) => d.format === 'pdf')!;
    const mdDoc = docs.find((d) => d.format === 'markdown')!;
    const epubDoc = docs.find((d) => d.format === 'epub')!;
    const docxDoc = docs.find((d) => d.format === 'docx')!;

    // 2. Set reading progress for PDF and Markdown (last-read positions)
    await app.window.evaluate(
      async ({ pId, mId }) => {
        await window.interleafAPI.library.updateReadingPosition(
          pId,
          { format: 'pdf', pageIndex: 2, pageLabel: 'Page 3' },
          0.45
        );
        await window.interleafAPI.library.updateReadingPosition(
          mId,
          { format: 'markdown', blockIndex: 3 },
          0.6
        );
      },
      { pId: pdfDoc.id, mId: mdDoc.id }
    );

    // Refresh documents in store
    await app.window.getByTestId('nav-continue-reading').click();
    await app.window.getByTestId('nav-all-documents').click();
    await app.window.waitForTimeout(500);
    // 3. Verify all 4 cards have visible preview containers and location badges
    for (const doc of [pdfDoc, mdDoc, epubDoc, docxDoc]) {
      const preview = app.window.getByTestId(`document-preview-${doc.id}`);
      await expect(preview).toBeVisible();

      const badge = app.window.getByTestId(`preview-location-badge-${doc.id}`);
      await expect(badge).toBeVisible();

      // Verify accessibility
      await expect(preview).toHaveAttribute('role', 'group');
      const ariaLabel = await preview.getAttribute('aria-label');
      expect(ariaLabel).toContain(`Preview of ${doc.title}`);

      // PDFs use the persisted page-one cover image; every other format gets
      // the generated typographic cover, which carries the document's title.
      if (doc.format === 'pdf') {
        await expect(app.window.getByTestId(`preview-cover-image-${doc.id}`)).toBeVisible();
      } else {
        const generated = app.window.getByTestId(`generated-cover-${doc.id}`);
        await expect(generated).toBeVisible();
        await expect(generated).toContainText(doc.title);
      }

      // Check bounding box is within card
      const card = app.window.getByTestId(`document-card-${doc.id}`);
      const cardBox = await card.boundingBox();
      const previewBox = await preview.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(previewBox).not.toBeNull();
      if (cardBox && previewBox) {
        expect(previewBox.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);
        expect(previewBox.width).toBeGreaterThan(40);
        expect(previewBox.height).toBeGreaterThan(40);
      }
    }

    // PDF has last-read badge 'Page 3'
    await expect(app.window.getByTestId(`preview-location-badge-${pdfDoc.id}`)).toHaveText('Page 3');
    // Markdown has last-read badge 'Section 4'
    await expect(app.window.getByTestId(`preview-location-badge-${mdDoc.id}`)).toHaveText('Section 4');
    // EPUB has default 'Cover'
    await expect(app.window.getByTestId(`preview-location-badge-${epubDoc.id}`)).toHaveText('Cover');
    // DOCX has default 'Page 1'
    await expect(app.window.getByTestId(`preview-location-badge-${docxDoc.id}`)).toHaveText('Page 1');

    // 4. Constrained 960x640 at 200% zoom
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 640);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.waitForTimeout(500);

    // Verify previews remain visible and contained at 200% zoom
    for (const doc of [pdfDoc, mdDoc, epubDoc, docxDoc]) {
      await expect(app.window.getByTestId(`document-preview-${doc.id}`)).toBeVisible();
    }
  });
});
