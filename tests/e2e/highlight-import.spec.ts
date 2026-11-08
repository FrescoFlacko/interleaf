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

test('cancel, close and reload revoke the actual preview capability', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-revoke-'));
  const path = join(directory, 'My Clippings.txt');
  writeFileSync(path, 'Book\n- Your Highlight on page 3\n\nQuote\n==========\n');
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [path]);
    // Observe and forward the unchanged main IPC response. No request or envelope is altered.
    await app.electronApp.evaluate(({ ipcMain }) => {
      type Result = { ok: boolean; data?: { token: string } };
      type Handler = (event: Electron.IpcMainInvokeEvent, payload: undefined) => Promise<Result>;
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>;
      const preview = handlers.get('imported-highlights:preview');
      const release = handlers.get('imported-highlights:release');
      if (!preview || !release) throw new Error('Missing import handlers');
      handlers.set('imported-highlights:preview', async (event, payload) => {
        const result = await preview(event, payload);
        Reflect.set(globalThis, 'importTestPreview', result);
        return result;
      });
      handlers.set('imported-highlights:release', async (event, payload) => {
        const result = await release(event, payload);
        Reflect.set(globalThis, 'importTestReleases', (Number(Reflect.get(globalThis, 'importTestReleases')) || 0) + 1);
        return result;
      });
    });
    const token = async (): Promise<string> => app.electronApp.evaluate(() => {
      const result = Reflect.get(globalThis, 'importTestPreview') as { data?: { token: string } };
      if (!result.data?.token) throw new Error('Preview did not produce a token');
      return result.data.token;
    });
    const denied = async (value: string): Promise<boolean> => app.window.evaluate(async (previewToken) => {
      try { await window.interleafAPI.importedHighlights.commit({ token: previewToken, choices: [] }); return false; }
      catch { return true; }
    }, value);
    const releases = async (): Promise<number> => app.electronApp.evaluate(() => Number(Reflect.get(globalThis, 'importTestReleases')) || 0);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    const cancelled = await token();
    const beforeCancel = await releases();
    await app.window.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(releases).toBeGreaterThan(beforeCancel);
    expect(await denied(cancelled)).toBe(true);
    expect(await app.window.evaluate(() => window.interleafAPI.importedHighlights.list(0))).toEqual([]);

    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    const closed = await token();
    const beforeClose = await releases();
    await app.window.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(releases).toBeGreaterThan(beforeClose);
    expect(await denied(closed)).toBe(true);

    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toBeVisible();
    const reloaded = await token();
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');
    expect(await denied(reloaded)).toBe(true);
    expect(await app.window.evaluate(() => window.interleafAPI.importedHighlights.list(0))).toEqual([]);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('closing during a native chooser prevents a late result from returning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-late-'));
  const path = join(directory, 'My Clippings.txt');
  writeFileSync(path, 'Book\n- Your Highlight on page 3\n\nQuote\n==========\n');
  const app = await launchInterleaf();
  try {
    await app.electronApp.evaluate(({ dialog, ipcMain }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, payload: undefined) => Promise<{ ok: boolean }>;
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>;
      const original = handlers.get('imported-highlights:preview');
      if (!original) throw new Error('Missing preview handler');
      handlers.set('imported-highlights:preview', async (event, payload) => {
        const result = await original(event, payload);
        Reflect.set(globalThis, 'lateImportResult', result);
        return result;
      });
      dialog.showOpenDialog = () => new Promise((resolve) => { Reflect.set(globalThis, 'finishImportDialog', resolve); });
    });
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect.poll(() => app.electronApp.evaluate(() => typeof Reflect.get(globalThis, 'finishImportDialog'))).toBe('function');
    await app.window.getByRole('button', { name: 'Close', exact: true }).click();
    await app.electronApp.evaluate((_, chosenPath) => {
      const finish = Reflect.get(globalThis, 'finishImportDialog') as (result: { canceled: boolean; filePaths: string[]; bookmarks: string[] }) => void;
      finish({ canceled: false, filePaths: [chosenPath], bookmarks: [] });
    }, path);
    await expect.poll(() => app.electronApp.evaluate(() => Reflect.get(globalThis, 'lateImportResult') !== undefined)).toBe(true);
    const result = await app.electronApp.evaluate(() => Reflect.get(globalThis, 'lateImportResult') as { ok: boolean });
    expect(result.ok).toBe(false);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await expect(app.window.getByText('Preview: Kindle')).toHaveCount(0);
    expect(await app.window.evaluate(() => window.interleafAPI.importedHighlights.list(0))).toEqual([]);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('imports a synthetic Readwise bulk-header fixture through the native picker', async () => {
  const app = await launchInterleaf();
  try {
    // Synthetic fixture with publicly reported column names; not an account export.
    await stubOpenDialog(app, [join(process.cwd(), 'tests/fixtures/highlight-import/readwise-bulk-synthetic.csv')]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText('Preview: Readwise')).toBeVisible();
    await expect(app.window.getByText(/Book — Writer/)).toBeVisible();
    await app.window.getByRole('button', { name: 'Confirm import' }).click();
    await expect(app.window.getByText('Imported 1; skipped 0 duplicates.')).toBeVisible();
    const records = await app.window.evaluate(() => window.interleafAPI.importedHighlights.list(0));
    expect(records[0]).toMatchObject({ title: 'Book', author: 'Writer', quote: 'A quote', note: 'A note', location: '2', date: '2026-11-01' });
  } finally { await app.close(); }
});

test('explains that Reader metadata exports are not highlight CSVs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'interleaf-reader-metadata-'));
  const path = join(directory, 'reader.csv');
  writeFileSync(path, 'Title,Author,URL\nBook,Writer,https://example.com\n');
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [path]);
    await app.window.getByRole('button', { name: 'Imported highlights' }).click();
    await app.window.getByRole('button', { name: 'Choose export…' }).click();
    await expect(app.window.getByText(/Reader library metadata exports are not supported/)).toBeVisible();
    if (process.env.INTERLEAF_IMPORT_ERROR_SCREENSHOT) await app.window.screenshot({ path: process.env.INTERLEAF_IMPORT_ERROR_SCREENSHOT });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
