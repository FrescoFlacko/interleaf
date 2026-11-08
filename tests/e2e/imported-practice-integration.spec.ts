import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, stubOpenDialog } from './helpers';

test('retained unmatched export creates a due card with honest source evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-import-practice-'));
  const file = join(dir, 'My Clippings.txt');
  writeFileSync(file, 'Export Book (Writer)\n- Your Highlight on page 4 | Added today\n\nRecall this imported quote.\n==========\n');
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [file]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    await app.window.getByRole('button', { name: 'Confirm import' }).click();
    await expect(app.window.getByText('Imported 1; skipped 0 duplicates.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Make practice card' }).click();
    await app.window.getByLabel('Question').fill('What did the export say?');
    await app.window.getByRole('button', { name: 'Save card' }).click();
    await expect(app.window.getByText('Practice card saved.')).toBeVisible();
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await app.window.screenshot({ path: join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'import-card.png') });
    await app.window.getByRole('button', { name: 'Close', exact: true }).click();
    await app.window.getByRole('button', { name: 'Review practice' }).click();
    await expect(app.window.getByText('What did the export say?')).toBeVisible();
    await app.window.getByLabel('Your answer').fill('An answer');
    await app.window.getByRole('button', { name: 'Reveal source' }).click();
    await expect(app.window.getByText('Source status: export-only')).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Open source passage' })).toBeDisabled();
    await app.window.getByRole('button', { name: 'View exported highlight' }).click();
    await expect(app.window.getByRole('region', { name: 'Exported highlight record' })).toContainText('Recall this imported quote.');
    if (process.env.INTERLEAF_INTEGRATION_EVIDENCE) await app.window.screenshot({ path: join(process.env.INTERLEAF_INTEGRATION_EVIDENCE, 'import-review.png') });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
