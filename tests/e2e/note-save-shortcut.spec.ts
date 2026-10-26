import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * The note save shortcut against the real application, end to end.
 *
 * The renderer suite already pins the decision — which key presses are claimed,
 * which payload each editor sends, and that a claimed press is not typed into
 * the field. What only a real window can show is the part jsdom cannot reach:
 * that a note saved with the keyboard alone reaches SQLite through main, and is
 * still there after the process is restarted against the same user data. A
 * shortcut that merely closes the popover would pass every focused test and
 * lose the reader's words.
 *
 * Plain Enter is exercised here too, on a real textarea with real native key
 * handling, because "the field stays multiline" is a claim about the browser's
 * own default action rather than about our handler.
 *
 * No AI provider is contacted: this is the reader and the annotation store.
 */

const SHORTCUT = 'ControlOrMeta+Enter';
const NOTE_PHRASE = 'leases bound the window of divergence';
const NOTE_BODY = 'Saved with the keyboard, never with the mouse.';
const EDITED_SUFFIX = 'Edited with the keyboard too.';
const LOCATION_NOTE_BODY = 'A note about where I stopped reading.';

/** Selects a phrase through the reader's own selection pathway. */
async function selectPhrase(page: Page, needle: string): Promise<void> {
  await page.evaluate((n) => {
    for (const block of document.querySelectorAll<HTMLElement>('[data-markdown-block]')) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
    }
    throw new Error(`selection target not found: ${n}`);
  }, needle);
}

/** Drops the live selection once the toolbar has done its work. */
async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test.describe('Note save shortcut', () => {
  // The restart test reads what the first test's keyboard saves left behind, so
  // the two are one scenario in two processes rather than independent cases.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let app: AppHandle;
  let userDataDir: string;
  let fixtureDir: string;
  let fixturePath: string;

  test.beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-note-shortcut-data-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-note-shortcut-'));
    fixturePath = join(fixtureDir, 'Consistency Notes.md');
    writeFileSync(
      fixturePath,
      makeMarkdownFixture({
        title: 'Consistency Notes',
        author: 'Interleaf Regression',
        body: [
          '# Consistency Notes',
          '',
          `Under a bounded clock assumption, ${NOTE_PHRASE} to the lease term rather than to the network.`,
          '',
        ].join('\n'),
      })
    );
  });

  test.afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    // The user data outlives each test on purpose: the second test is the
    // restart. Playwright still has to let go of the process between them.
    await app.close({ preserveUserData: true });
  });

  /** Opens the reader on the imported fixture, importing it if needed. */
  async function openReader(): Promise<void> {
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
  }

  test('saves a selection note and a location note with the keyboard alone', async () => {
    app = await launchInterleaf({ userDataDir });
    await openReader();

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await selectPhrase(app.window, NOTE_PHRASE);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();

    const field = app.window.locator('#selection-note');
    await expect(field).toBeFocused();
    await expect(app.window.getByTestId('selection-note-shortcut-hint')).toBeVisible();

    // Plain Enter belongs to the field: typed on a real textarea, it has to
    // leave a newline behind rather than save.
    await field.fill('First line');
    await field.press('Enter');
    await field.pressSequentially('second line');
    expect(await field.inputValue()).toBe('First line\nsecond line');

    await field.fill(NOTE_BODY);
    await field.press(SHORTCUT);
    // The same completion clicking Done produces: the toolbar closes only once
    // the annotation has been created.
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);

    // A location note is a second editor with the same chord and the same
    // persistence path, so it is worth one real press of its own.
    await app.window
      .getByTestId('reader-header-toolbar')
      .getByRole('button', { name: 'Add note' })
      .click();
    const locationField = app.window.locator('#location-note');
    await expect(locationField).toBeFocused();
    await expect(app.window.getByTestId('location-note-shortcut-hint')).toBeVisible();
    await locationField.fill(LOCATION_NOTE_BODY);
    await locationField.press(SHORTCUT);
    await expect(app.window.locator('#location-note-popover')).toBeHidden();

    const saved = await app.window.evaluate(async () => {
      const docs = await window.interleafAPI.library.listDocuments();
      return window.interleafAPI.annotations.list(docs[0]!.id);
    });
    expect(saved.map((annotation) => annotation.note).sort()).toEqual(
      [LOCATION_NOTE_BODY, NOTE_BODY].sort()
    );
  });

  test('keeps keyboard-saved notes across a restart and edits them the same way', async () => {
    app = await launchInterleaf({ userDataDir });
    await openReader();

    await app.window.locator('#companion-tab-annotations').click();
    const browser = app.window.getByTestId('annotation-browser');
    await expect(browser).toBeVisible();
    // Both notes from the previous process survived being written by the
    // shortcut: this is the regression the shortcut could silently lose.
    await expect(browser.getByTestId('annotation-row')).toHaveCount(2);
    await expect(browser.getByText(NOTE_BODY)).toBeVisible();
    await expect(browser.getByText(LOCATION_NOTE_BODY)).toBeVisible();

    const row = browser.getByTestId('annotation-row').filter({ hasText: NOTE_BODY });
    await row.getByRole('button', { name: 'Edit' }).click();
    const editField = browser.locator('textarea[id^="annotation-edit-"]');
    await expect(editField).toBeFocused();
    await expect(browser.getByTestId('annotation-edit-shortcut-hint')).toBeVisible();
    await editField.fill(`${NOTE_BODY} ${EDITED_SUFFIX}`);
    await editField.press(SHORTCUT);
    await expect(editField).toBeHidden();
    await expect(browser.getByText(`${NOTE_BODY} ${EDITED_SUFFIX}`)).toBeVisible();

    const stored = await app.window.evaluate(async () => {
      const docs = await window.interleafAPI.library.listDocuments();
      return window.interleafAPI.annotations.list(docs[0]!.id);
    });
    expect(stored.map((annotation) => annotation.note).sort()).toEqual(
      [LOCATION_NOTE_BODY, `${NOTE_BODY} ${EDITED_SUFFIX}`].sort()
    );
  });
});
