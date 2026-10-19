import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { captureWindowPng, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeEpubFixture, makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * Click-to-edit for saved highlights in a real BrowserWindow, driven by
 * native pointer input: a highlight saved in an earlier launch reopens the
 * selection toolbar where it was clicked, recolours in place, attaches its
 * passage to Chat without sending anything, and deletes — while drag-select
 * through it and the note beside it keep their own behaviour.
 *
 * CSS Custom Highlights have no DOM node, so paint is asserted through
 * `CSS.highlights` and persistence through the annotation API.
 */

const HIGHLIGHTED = 'decouples layout extraction';
const NOTED = 'notes remain stable';
const NOTE_BODY = 'A note that must survive highlight edits.';
const PARAGRAPH = `The reader engine ${HIGHLIGHTED} from annotation persistence so ${NOTED} across launches.`;
const EPUB_PHRASE = 'Quantum jellyfish migrate across virtual memory';
const TOOLBAR = 'annotation-selection-toolbar';
const SCREENSHOT_DIR = process.env.INTERLEAF_HIGHLIGHT_EDIT_SCREENSHOTS;

type Point = { readonly x: number; readonly y: number };
type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

const fixtureDirs: string[] = [];

function writeFixture(fileName: string, contents: string | Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'interleaf-highlight-edit-'));
  fixtureDirs.push(dir);
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, contents);
  return filePath;
}

async function importAndOpen(app: AppHandle, filePath: string): Promise<DocumentMetadata> {
  await stubOpenDialog(app, [filePath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  await app.window.getByTestId(`read-doc-${doc!.id}`).click();
  return doc!;
}

/**
 * The live box of `needle` inside `rootSelector` in `frame`, optionally
 * selecting it through a real DOM Range — the repo's convention for creating
 * annotations; every activation afterwards is native pointer input.
 */
async function phraseBox(frame: Page | Frame, needle: string, rootSelector: string, select = false): Promise<Box> {
  return frame.evaluate(({ n, selector, shouldSelect }) => {
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        if (shouldSelect) {
          document.getSelection()?.removeAllRanges();
          document.getSelection()?.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        }
        // The first line fragment: a wrapped phrase's box centre can fall
        // between its lines, on no painted text at all.
        const { left, top, right, bottom } = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { left, top, right, bottom };
      }
    }
    throw new Error(`phrase not found: ${n}`);
  }, { n: needle, selector: rootSelector, shouldSelect: select });
}

function centre(box: Box): Point {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

async function markdownPhrase(page: Page, needle: string, select = false): Promise<Box> {
  return phraseBox(page, needle, '[data-markdown-block]', select);
}

function ebookFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null);
  if (frame === undefined) throw new Error('ebook frame missing');
  return frame;
}

/** An EPUB phrase in top-window coordinates: the iframe box plus its local box. */
async function ebookPhrase(page: Page, needle: string, select = false): Promise<Box> {
  const local = await phraseBox(ebookFrame(page), needle, 'body', select);
  const frameBox = await page.locator('iframe[title="Ebook Content"]').boundingBox();
  if (frameBox === null) throw new Error('ebook iframe missing');
  return { left: frameBox.x + local.left, top: frameBox.y + local.top, right: frameBox.x + local.right, bottom: frameBox.y + local.bottom };
}

async function listAnnotations(app: AppHandle, documentId: string): Promise<readonly Annotation[]> {
  return app.window.evaluate(async (id) => window.interleafAPI.annotations.list(id, { limit: 50 }), documentId);
}

/** Painted range counts per highlight colour, read in the top document or the ebook frame. */
async function paintedColours(frame: Page | Frame): Promise<Record<string, number>> {
  return frame.evaluate(() => {
    const registry = (CSS as { highlights?: Map<string, { size: number }> }).highlights;
    const counts: Record<string, number> = {};
    for (const [name, highlight] of registry ?? []) {
      if (name.startsWith('interleaf-') && highlight.size > 0) counts[name] = highlight.size;
    }
    return counts;
  });
}

/** The toolbar sits beside the clicked fragment and overlaps it horizontally. */
async function expectToolbarAt(page: Page, fragment: Box): Promise<void> {
  const box = await page.getByTestId(TOOLBAR).boundingBox();
  expect(box).not.toBeNull();
  const gap = Math.min(Math.abs(box!.y + box!.height - fragment.top), Math.abs(box!.y - fragment.bottom));
  expect(gap).toBeLessThan(24);
  expect(box!.x).toBeLessThan(fragment.right);
  expect(box!.x + box!.width).toBeGreaterThan(fragment.left);
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
}

async function expectEditing(page: Page, annotationId: string, color: string): Promise<void> {
  const toolbar = page.getByTestId(TOOLBAR);
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute('data-editing-annotation-id', annotationId);
  await expect(toolbar).toHaveAttribute('aria-label', 'Highlight actions');
  await expect(toolbar.getByTestId(`highlight-color-button-${color}`)).toHaveAttribute('aria-pressed', 'true');
}

async function screenshot(app: AppHandle, name: string): Promise<void> {
  if (SCREENSHOT_DIR === undefined) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await captureWindowPng(app, path.join(SCREENSHOT_DIR, name));
}

async function saveNoteOn(page: Page, needle: string): Promise<void> {
  await markdownPhrase(page, needle, true);
  const toolbar = page.getByTestId(TOOLBAR);
  await toolbar.getByRole('button', { name: /note/i }).click();
  await page.locator('#selection-note').fill(NOTE_BODY);
  await toolbar.getByRole('button', { name: 'Save note' }).click();
  await expect(toolbar).toBeHidden();
}

test.describe('Saved highlight click-to-edit (real BrowserWindow)', () => {
  test.setTimeout(150_000);
  let app: AppHandle | null = null;

  test.afterEach(async () => {
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (app === null) return;
    const { userDataDir } = app;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    app = null;
  });

  test('Markdown: a highlight from an earlier launch recolours in place, asks AI, deletes, and leaves the note alone', async () => {
    const filePath = writeFixture('Highlight Edit.md', makeMarkdownFixture({
      title: 'Highlight Edit',
      author: 'Interleaf Regression',
      body: ['# Highlight Edit', '', PARAGRAPH, '', 'A neutral closing paragraph gives the reader somewhere to click.', ''].join('\n'),
    }));
    const first = await launchInterleaf();
    app = first;
    const doc = await importAndOpen(first, filePath);
    await expect(first.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await markdownPhrase(first.window, HIGHLIGHTED, true);
    await first.window.getByTestId(TOOLBAR).getByTestId('highlight-color-button-yellow').click();
    await expect(first.window.getByTestId(TOOLBAR)).toBeHidden();
    await saveNoteOn(first.window, NOTED);
    const [saved] = (await listAnnotations(first, doc.id)).filter((item) => item.type === 'highlight');
    expect(saved).toBeDefined();

    // Restart on the same profile: the highlight comes back from the database.
    const { userDataDir } = first;
    await first.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    // Chat needs a ready provider to hold context: the offline OpenRouter seam,
    // whose requests never leave main. Ask AI sends nothing to it anyway.
    await configureOpenRouterTestSeam(app);
    const page = app.window;
    await page.getByTestId(`read-doc-${doc.id}`).click();
    await expect(page.getByTestId('markdown-content-wrapper')).toBeVisible();
    await expect.poll(async () => paintedColours(page)).toMatchObject({ 'interleaf-yellow': 1 });

    // A native click on the painted text reopens the toolbar at that fragment.
    const fragment = await markdownPhrase(page, HIGHLIGHTED);
    await page.mouse.click(centre(fragment).x, centre(fragment).y);
    await expectEditing(page, saved!.id, 'yellow');
    await expectToolbarAt(page, fragment);
    await expect(page.getByTestId(TOOLBAR).getByRole('button', { name: 'Ask AI' })).toBeVisible();
    await expect(page.getByTestId('delete-highlight-button')).toBeVisible();
    await screenshot(app, 'highlight-edit-toolbar-normal.png');

    // Recolour: the same id is updated, repainted and persisted; nothing is added.
    await page.getByTestId('highlight-color-button-blue').click();
    await expect(page.getByTestId('highlight-color-button-blue')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('highlight-color-button-yellow')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => paintedColours(page)).not.toHaveProperty('interleaf-yellow');
    expect(await paintedColours(page)).toMatchObject({ 'interleaf-blue': 1 });
    const afterRecolour = await listAnnotations(app, doc.id);
    expect(afterRecolour.filter((item) => item.type === 'highlight').map((item) => [item.id, item.color]))
      .toEqual([[saved!.id, 'blue']]);

    // Escape closes and a click away keeps it closed.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(TOOLBAR)).toBeHidden();

    // Dragging through the highlight is still a plain text selection.
    await page.mouse.move(fragment.left + 2, centre(fragment).y);
    await page.mouse.down();
    await page.mouse.move(fragment.right - 2, centre(fragment).y, { steps: 8 });
    await page.mouse.up();
    const selectionToolbar = page.getByTestId(TOOLBAR);
    await expect(selectionToolbar).toBeVisible();
    await expect(selectionToolbar).toHaveAttribute('aria-label', 'Selection actions');
    await expect(selectionToolbar).not.toHaveAttribute('data-editing-annotation-id', /.+/);
    await page.keyboard.press('Escape');
    await expect(selectionToolbar).toBeHidden();

    // The note beside it still opens its own popover.
    const noted = await markdownPhrase(page, NOTED);
    await page.mouse.click(centre(noted).x, centre(noted).y);
    await expect(page.getByTestId('note-popover-body')).toHaveText(NOTE_BODY);
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('note-popover')).toHaveCount(0);

    // Ask AI attaches the saved passage to Chat and focuses the composer; no
    // message is sent, so no provider is asked anything.
    await page.mouse.click(centre(fragment).x, centre(fragment).y);
    await expectEditing(page, saved!.id, 'blue');
    await page.getByTestId(TOOLBAR).getByRole('button', { name: 'Ask AI' }).click();
    await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('chat-context-summary')).toContainText(HIGHLIGHTED);
    await expect(page.locator('#chat-composer')).toBeFocused();
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
    const chat = await page.evaluate(async (documentId) => {
      const [session] = await window.interleafAPI.chat.listSessions(documentId);
      if (session === undefined) return { context: [], messages: -1 };
      const context = await window.interleafAPI.chat.listContext(session.id);
      const messages = await window.interleafAPI.chat.listMessages(session.id);
      return { context: context.map((item) => item.excerptText), messages: messages.length };
    }, doc.id);
    expect(chat).toEqual({ context: [HIGHLIGHTED], messages: 0 });

    // Delete removes the record and its paint; the note is untouched.
    const again = await markdownPhrase(page, HIGHLIGHTED);
    await page.mouse.click(centre(again).x, centre(again).y);
    await expectEditing(page, saved!.id, 'blue');
    await page.getByTestId('delete-highlight-button').click();
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
    await expect.poll(async () => paintedColours(page)).not.toHaveProperty('interleaf-blue');
    const remaining = await listAnnotations(app, doc.id);
    expect(remaining.map((item) => [item.type, item.note])).toEqual([['note', NOTE_BODY]]);
    await page.mouse.click(centre(again).x, centre(again).y);
    await page.waitForTimeout(150);
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
  });

  test('constrained 200% zoom: the reopened toolbar stays inside the viewport', async () => {
    const filePath = writeFixture('Highlight Zoom.md', makeMarkdownFixture({
      title: 'Highlight Zoom',
      author: 'Interleaf Regression',
      body: ['# Highlight Zoom', '', PARAGRAPH, '', ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${String(index + 1)} gives the reader scroll depth.\n`)].join('\n'),
    }));
    app = await launchInterleaf();
    const browserWindow = await app.electronApp.browserWindow(app.window);
    await browserWindow.evaluate((win) => {
      win.unmaximize();
      win.setSize(960, 608);
      win.webContents.setZoomFactor(2);
    });
    await expect.poll(async () => app!.window.evaluate(() => window.innerWidth)).toBeLessThan(520);
    const doc = await importAndOpen(app, filePath);
    const page = app.window;
    await expect(page.getByTestId('markdown-content-wrapper')).toBeVisible();
    await markdownPhrase(page, HIGHLIGHTED, true);
    await page.getByTestId(TOOLBAR).getByTestId('highlight-color-button-green').click();
    await expect(page.getByTestId(TOOLBAR)).toBeHidden();
    const [saved] = await listAnnotations(app, doc.id);
    await expect.poll(async () => paintedColours(page)).toMatchObject({ 'interleaf-green': 1 });
    await closeCompactDrawerIfOpen(page);

    const fragment = await markdownPhrase(page, HIGHLIGHTED);
    await page.mouse.click(centre(fragment).x, centre(fragment).y);
    await expectEditing(page, saved!.id, 'green');
    await expectToolbarAt(page, fragment);
    await screenshot(app, 'highlight-edit-toolbar-zoom200.png');

    // A scroll moves the text out from under the toolbar, so it closes.
    const uncovered = await readerPointOutsideToolbar(page);
    await page.mouse.move(uncovered.x, uncovered.y);
    await page.mouse.wheel(0, 200);
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
  });

  test('EPUB: a highlight painted inside the section iframe reopens, recolours and closes with its section', async () => {
    const filePath = writeFixture('Highlight Edit.epub', makeEpubFixture({
      title: 'Highlight Edit Ebook',
      author: 'Interleaf Regression',
      chapters: [
        { title: 'Chapter 1', content: `<p>${EPUB_PHRASE} without leaving the sandboxed section document.</p>` },
        { title: 'Chapter 2', content: '<p>The second chapter contains entirely different prose.</p>' },
      ],
    }));
    app = await launchInterleaf();
    const doc = await importAndOpen(app, filePath);
    const page = app.window;
    const iframe = page.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByText(EPUB_PHRASE)).toBeVisible();
    await ebookPhrase(page, EPUB_PHRASE, true);
    await page.getByTestId(TOOLBAR).getByTestId('highlight-color-button-pink').click();
    await expect(page.getByTestId(TOOLBAR)).toBeHidden();
    await expect.poll(async () => paintedColours(ebookFrame(page))).toMatchObject({ 'interleaf-pink': 1 });
    const [saved] = await listAnnotations(app, doc.id);

    const fragment = await ebookPhrase(page, EPUB_PHRASE);
    await page.mouse.click(centre(fragment).x, centre(fragment).y);
    await expectEditing(page, saved!.id, 'pink');
    await expectToolbarAt(page, fragment);

    await page.getByTestId('highlight-color-button-purple').click();
    await expect(page.getByTestId('highlight-color-button-purple')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => paintedColours(ebookFrame(page))).toEqual({ 'interleaf-purple': 1 });
    expect((await listAnnotations(app, doc.id)).map((item) => [item.id, item.color])).toEqual([[saved!.id, 'purple']]);

    // A section switch discards the iframe document the highlight was painted in.
    const nextPage = page.getByTestId('next-page-button');
    await nextPage.focus();
    await page.keyboard.press('Enter');
    await expect(iframe.getByText('entirely different prose')).toBeVisible();
    await expect(page.getByTestId(TOOLBAR)).toHaveCount(0);
  });
});

/** A reader point the toolbar does not cover; at 200% it may overlap the clicked line. */
async function readerPointOutsideToolbar(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const reader = document.querySelector('[data-testid="pdf-viewport-container"]')!.getBoundingClientRect();
    for (let y = reader.bottom - 8; y > reader.top; y -= 16) {
      const hit = document.elementFromPoint(reader.left + reader.width / 2, y);
      if (hit !== null && hit.closest('[data-testid="pdf-viewport-container"]') !== null) return { x: reader.left + reader.width / 2, y };
    }
    throw new Error('no uncovered reader point');
  });
}

/** At 200% a save opens the compact Annotations drawer over the reader. */
async function closeCompactDrawerIfOpen(page: Page): Promise<void> {
  const close = page.getByTestId('compact-drawer-right').getByRole('button', { name: 'Close drawer' });
  if (await close.count() === 0) return;
  await close.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const backdrop = page.getByTestId('compact-backdrop');
    if (await backdrop.count() === 0) return true;
    return backdrop.evaluate((element) => element.classList.contains('pointer-events-none'));
  }, { timeout: 5_000 }).toBe(true);
}
