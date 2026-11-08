import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, returnToLibrary } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

test('creates and reviews a highlight card through the real app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-practice-'));
  const file = join(dir, 'Evidence.md');
  writeFileSync(file, makeMarkdownFixture({ title: 'Evidence', author: 'Fixture', body: '# Evidence\n\nQuorums overlap.' }));
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [file]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Fixture document was not imported');
    await app.window.evaluate(async (id) => {
      await window.interleafAPI.annotations.create({ documentId: id, type: 'highlight', selectedText: 'Quorums overlap.', color: 'yellow',
        anchor: { format: 'markdown', blockIndex: 1, quote: { exact: 'Quorums overlap.', prefix: '', suffix: '' } } });
    }, doc.id);
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    // The card creation route is exercised by the actual annotations UI.
    await app.window.locator('#companion-tab-annotations').click();
    await app.window.getByRole('button', { name: 'Make practice card' }).click();
    await app.window.getByLabel('Question').fill('What overlaps?');
    const visualDir = process.env.INTERLEAF_PRACTICE_VISUAL_DIR;
    if (visualDir) await app.window.screenshot({ path: join(visualDir, 'card-form.png') });
    await app.window.getByRole('button', { name: 'Save card' }).click();
    await expect(app.window.getByText('Practice card saved.')).toBeVisible();
    if (visualDir) await app.window.screenshot({ path: join(visualDir, 'card-saved.png') });
    await returnToLibrary(app);
    await app.window.getByRole('button', { name: 'Review practice' }).click();
    await expect(app.window.getByText('What overlaps?')).toBeVisible();
    await app.window.getByLabel('Your answer').fill('Quorums');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await expect(app.window.getByText('Quorums overlap.')).toBeVisible();
    const shot = process.env.INTERLEAF_PRACTICE_SCREENSHOT;
    if (shot) await app.window.screenshot({ path: shot });
    await app.window.getByRole('button', { name: 'Open source passage' }).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByText('Source passage opened.')).toBeVisible();
    await app.window.getByTestId('sidebar-library').locator('nav[aria-label="Library sections"] button').first().click();
    await expect(app.window.getByText('What overlaps?')).toBeVisible();
    await app.window.getByLabel('Your answer').fill('Quorums');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await app.window.getByRole('button', { name: 'good', exact: true }).click();
    await expect(app.window.getByText('Review complete.')).toBeVisible();
    await app.window.evaluate(async (id) => {
      const [highlight] = await window.interleafAPI.annotations.list(id, { type: 'highlight' });
      if (!highlight) throw new Error('Fixture highlight was not found');
      await window.interleafAPI.practice.create({ documentId: id, annotationId: highlight.id, question: 'A missing source?' });
      await window.interleafAPI.annotations.delete(id, highlight.id);
    }, doc.id);
    await app.window.getByRole('button', { name: 'Back to library' }).click();
    await app.window.getByRole('button', { name: 'Review practice' }).click();
    await expect(app.window.getByText('A missing source?')).toBeVisible();
    await app.window.getByLabel('Your answer').fill('An answer');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await expect(app.window.getByText('Source status: missing')).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Open source passage' })).toBeDisabled();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
