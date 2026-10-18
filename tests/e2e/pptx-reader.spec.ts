import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWindowPng, launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makePptxFixture } from '../fixtures/pptx-fixtures';

/** Optional evidence directory supplied by the supervising harness. */
const ARTIFACTS = process.env.INTERLEAF_E2E_ARTIFACTS;

test.describe('PPTX Reader End-to-End Workflow', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let deckPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-pptx-e2e-'));
    deckPath = join(fixtureDir, 'Quarterly_Review.PPTX');
    writeFileSync(deckPath, makePptxFixture({ title: 'Quarterly Review Deck', author: 'Interleaf QA', includeExternalImage: false }));
    if (ARTIFACTS !== undefined) mkdirSync(join(ARTIFACTS, 'video'), { recursive: true });
    app = await launchInterleaf(ARTIFACTS === undefined ? undefined : { recordVideoDir: join(ARTIFACTS, 'video') });
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function evidence(name: string): Promise<void> {
    if (ARTIFACTS !== undefined) await captureWindowPng(app, join(ARTIFACTS, name));
  }

  test('imports a deck into the library, reads slides in order and navigates by slide', async () => {
    await stubOpenDialog(app, [deckPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(document?.format).toBe('pptx');
    expect(document?.title).toBe('Quarterly Review Deck');
    await evidence('pptx-library-import.png');

    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('docx-page-1')).toHaveAttribute('aria-label', 'Slide 1');
    await expect(app.window.getByRole('heading', { level: 2, name: 'Quarterly Research Review' })).toBeVisible();
    await expect(app.window.getByText('Signals from the field')).toBeVisible();
    await expect(app.window.locator('.docx-page-wrapper img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('1');
    await evidence('pptx-slide-1.png');

    await app.window.getByTestId('toggle-toc-button').click();
    const outline = app.window.getByTestId('reader-outline-sidebar');
    await expect(outline.getByText('Findings Table')).toBeVisible();
    await expect(outline.getByText('Next Steps')).toBeVisible();
    await outline.getByText('Findings Table').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(app.window.locator('.docx-table')).toContainText('Citations');
    await evidence('pptx-slide-2-table.png');

    await outline.getByText('Next Steps').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('3');
    await expect(app.window.getByText('distinctive closing remark')).toBeVisible();
    // Speaker notes are never part of the reading text.
    await expect(app.window.getByText('Speaker-only note')).toHaveCount(0);
    await evidence('pptx-slide-3.png');

    await returnToLibrary(app);
    const persisted = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(persisted.map((item) => item.format)).toEqual(['pptx']);
  });
});
