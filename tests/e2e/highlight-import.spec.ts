import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, stubOpenDialog } from './helpers';

test('imports and reopens a Kindle highlight through the real bridge', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-clippings-'));
  const path = join(directory, 'My Clippings.txt');
  writeFileSync(path, 'Fixture Book (Fixture Author)\n- Your Highlight on page 3 | Added today\n\nThe sample passage.\n==========\n');
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [path]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    await expect(app.window.getByText(/The sample passage/)).toBeVisible();
    if (process.env.INTERLEAF_IMPORT_SCREENSHOT) await app.window.screenshot({ path: process.env.INTERLEAF_IMPORT_SCREENSHOT });
    await app.window.getByRole('button', { name: 'Confirm import' }).click();
    await expect(app.window.getByText('Imported 1; skipped 0 duplicates.')).toBeVisible();
    await expect(app.window.getByText('No verified passage location.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText(/1 duplicates/)).toBeVisible();
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
