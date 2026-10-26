import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * Quitting while a note is still waiting for its autosave.
 *
 * A note saves a moment after the reader pauses. A reader who types and quits
 * inside that pause must not lose the words: the renderer's before-close
 * handshake writes every open note's newest text before the window goes. This
 * runs the real application, quits without waiting for the pause, and reads
 * the notes back from a second process on the same user data.
 *
 * No AI provider is contacted: this is the reader and the annotation store.
 */

const NEW_NOTE = 'Typed and quit before the pause ended.';
const EDITED_NOTE = 'An existing note, edited and quit at once.';

test.describe('Note autosave at quit', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let app: AppHandle;
  let userDataDir: string;
  let fixtureDir: string;
  let fixturePath: string;

  test.beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-note-quit-data-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-note-quit-'));
    fixturePath = join(fixtureDir, 'Quit Notes.md');
    writeFileSync(
      fixturePath,
      makeMarkdownFixture({
        title: 'Quit Notes',
        author: 'Interleaf Regression',
        body: ['# Quit Notes', '', 'Leases bound the window of divergence to the lease term.', ''].join('\n'),
      })
    );
  });

  test.afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await app.close({ preserveUserData: true });
  });

  async function openReader(): Promise<string> {
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    const existing = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (existing.length === 0) {
      await stubOpenDialog(app, [fixturePath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
    }
    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(docs).toHaveLength(1);
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    return docs[0]!.id;
  }

  async function storedNotes(documentId: string): Promise<(string | null)[]> {
    const stored = await app.window.evaluate((id) => window.interleafAPI.annotations.list(id), documentId);
    return stored.map((annotation) => annotation.note).sort();
  }

  test('writes a new location note typed just before quitting', async () => {
    app = await launchInterleaf({ userDataDir });
    const documentId = await openReader();
    await app.window.getByTestId('reader-header-toolbar').getByRole('button', { name: 'Add note' }).click();
    const field = app.window.locator('#location-note');
    await expect(field).toBeFocused();
    await field.fill(NEW_NOTE);
    // Nothing is stored yet: the autosave pause has not ended.
    expect(await storedNotes(documentId)).toEqual([]);
    await app.close({ preserveUserData: true });

    app = await launchInterleaf({ userDataDir });
    await openReader();
    expect(await storedNotes(documentId)).toEqual([NEW_NOTE]);
  });

  test('writes an edit to an existing note made just before quitting', async () => {
    app = await launchInterleaf({ userDataDir });
    const documentId = await openReader();
    await app.window.locator('#companion-tab-annotations').click();
    const browser = app.window.getByTestId('annotation-browser');
    const row = browser.getByTestId('annotation-row').filter({ hasText: NEW_NOTE });
    await row.getByRole('button', { name: 'Edit' }).click();
    const field = browser.locator('textarea[id^="annotation-edit-"]');
    await expect(field).toBeFocused();
    await field.fill(EDITED_NOTE);
    expect(await storedNotes(documentId)).toEqual([NEW_NOTE]);
    await app.close({ preserveUserData: true });

    app = await launchInterleaf({ userDataDir });
    await openReader();
    expect(await storedNotes(documentId)).toEqual([EDITED_NOTE]);
  });
});
