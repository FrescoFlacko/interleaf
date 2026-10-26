import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentCliFixture } from './agent-cli-fixture';
import { chooseChatModel, captureWindowPng, launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { choosePalette } from './listbox';

/**
 * Captures the screenshots shown on the Interleaf website.
 *
 * Opt-in only: it runs when both `INTERLEAF_SITE_BOOKS_DIR` (the downloaded
 * demo books) and `INTERLEAF_SITE_CAPTURE_DIR` (where raw PNGs go) are set, so
 * the ordinary E2E suite skips it. The app runs through `launchInterleaf`,
 * which gives it a brand-new temporary profile and the offline environment,
 * so no existing library, document or credential can reach a capture. Every
 * book is checked against `website/demo-library.json` by SHA-256 before it is
 * imported, and nothing else is ever imported.
 *
 * The Chat answer is a fixed sample served by a stubbed `fetch` in main; no
 * provider is called. The website labels it as a sample.
 */

type DemoBook = {
  readonly id: string;
  readonly importAs: string;
  readonly title: string;
  readonly sha256: string;
};

const booksDir = process.env.INTERLEAF_SITE_BOOKS_DIR ?? '';
const captureDir = process.env.INTERLEAF_SITE_CAPTURE_DIR ?? '';
const WINDOW = { width: 1440, height: 900 } as const;

const SAMPLE_ANSWER = [
  'The passage turns the Tower of Hanoi into two smaller copies of itself [CITE]:',
  '',
  '1. Move the top *n − 1* disks to the spare peg.',
  '2. Move the largest disk straight to its destination.',
  '3. Move the *n − 1* disks from the spare peg on top of it.',
  '',
  'The whole argument rests on one assumption: **there is a largest disk** [CITE].',
].join('\n');

function loadVerifiedBooks(): { readonly books: readonly DemoBook[]; readonly staging: string } {
  const manifest = JSON.parse(readFileSync(resolve('website/demo-library.json'), 'utf8')) as { books: DemoBook[] };
  const staging = mkdtempSync(join(tmpdir(), 'interleaf-site-books-'));
  for (const book of manifest.books) {
    const source = join(booksDir, `${book.id}${book.importAs.slice(book.importAs.lastIndexOf('.'))}`);
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (digest !== book.sha256) throw new Error(`${book.id} does not match the verified SHA-256 in demo-library.json.`);
    copyFileSync(source, join(staging, book.importAs));
  }
  return { books: manifest.books, staging };
}

async function sizeWindow(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setSize(size.width, size.height);
    win.center();
    win.webContents.setZoomFactor(1);
  }, WINDOW);
  await app.window.waitForTimeout(500);
}

async function shoot(app: AppHandle, name: string): Promise<void> {
  // Let entrance transitions, lazy covers and text layers settle first.
  await app.window.waitForTimeout(900);
  await captureWindowPng(app, join(captureDir, `${name}.png`));
}

/** Answers OpenRouter chat requests in main with the fixed sample; everything else is untouched. */
async function stubSampleChat(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate((_electron, answer) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
      const body = typeof init?.body === 'string' ? init.body : '';
      const source = /id=["'](src-\d+)["']/u.exec(body)?.[1] ?? 'src-1';
      const text = answer.replaceAll('[CITE]', `[${source}]`);
      const stream = `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: [DONE]\n\n`;
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }, SAMPLE_ANSWER);
  await app.window.evaluate(async () => {
    await window.interleafAPI.ai.configureOpenRouter({ apiKey: 'sk-or-v1-site-sample-seam', model: 'openrouter/auto' });
  });
  await app.window.reload();
  await app.window.waitForLoadState('domcontentloaded');
}

async function documentIds(app: AppHandle, books: readonly DemoBook[]): Promise<Map<string, string>> {
  const listed = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  const ids = new Map<string, string>();
  for (const book of books) {
    const match = listed.find((document) => document.title.startsWith(book.title));
    if (match === undefined) throw new Error(`${book.title} was not imported.`);
    ids.set(book.id, match.id);
  }
  expect(listed).toHaveLength(books.length);
  return ids;
}

async function openDocument(app: AppHandle, id: string): Promise<void> {
  await app.window.getByTestId(`read-doc-${id}`).click();
  await expect(app.window.getByTestId('reader-view')).toBeVisible();
}

async function goToPdfPage(app: AppHandle, page: number): Promise<void> {
  await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible({ timeout: 30_000 });
  const input = app.window.getByTestId('page-number-input');
  // The page field re-renders while the document settles, so the jump is retried.
  await expect(async () => {
    await input.fill(String(page));
    await input.press('Enter');
    await expect(app.window.getByTestId(`pdf-textlayer-p${String(page)}`)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  await app.window.waitForTimeout(600);
}

/**
 * Selects `phrase` inside one PDF text layer, ignoring whitespace so a phrase
 * that spans several PDF.js spans still resolves to one DOM range.
 */
async function selectPdfPhrase(app: AppHandle, page: number, phrase: string): Promise<void> {
  const selected = await app.window.getByTestId(`pdf-textlayer-p${String(page)}`).evaluate((layer, needle) => {
    const chars: { node: Text; offset: number; ch: string }[] = [];
    const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let offset = 0; offset < text.length; offset += 1) {
        const ch = text[offset] ?? '';
        if (!/\s/u.test(ch)) chars.push({ node: node as Text, offset, ch });
      }
    }
    const compact = needle.replace(/\s+/gu, '');
    const index = chars.map((entry) => entry.ch).join('').indexOf(compact);
    const first = chars[index];
    const last = chars[index + compact.length - 1];
    if (index < 0 || first === undefined || last === undefined) return '';
    const range = layer.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    const selection = layer.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
    return selection?.toString() ?? '';
  }, phrase);
  expect(selected.length, `phrase "${phrase}" on page ${String(page)}`).toBeGreaterThan(0);
  await expect(app.window.getByTestId('annotation-selection-toolbar')).toBeVisible();
}

async function highlight(app: AppHandle, page: number, phrase: string, colour: string): Promise<void> {
  await selectPdfPhrase(app, page, phrase);
  await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: `${colour} highlight` }).click();
  await app.window.waitForTimeout(300);
}

async function setPalette(app: AppHandle, palette: string): Promise<void> {
  await choosePalette(app.window, palette);
  await expect(app.window.locator('html')).toHaveAttribute('data-theme', palette);
}

async function openCompanionTab(app: AppHandle, name: RegExp): Promise<void> {
  const tab = app.window.getByRole('tab', { name });
  if (!(await tab.isVisible().catch(() => false))) await app.window.getByTestId('toggle-right-panel').click();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Gutenberg outlines list plates and licence pages, so EPUBs are positioned by section. */
async function goToSection(app: AppHandle, section: number, text: RegExp): Promise<void> {
  const input = app.window.getByTestId('page-number-input');
  const body = app.window.frameLocator('iframe[title="Ebook Content"]').locator('body');
  await expect(body).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await input.fill(String(section));
    await input.press('Enter');
    await expect(body).toContainText(text, { timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  await input.blur();
  await app.window.waitForTimeout(800);
}

async function setCompanionPanel(app: AppHandle, open: boolean): Promise<void> {
  const toggle = app.window.getByTestId('toggle-right-panel');
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
  await app.window.waitForTimeout(400);
}

test.describe('Website screenshots from an isolated demo library', () => {
  test.skip(booksDir.length === 0 || captureDir.length === 0, 'Set INTERLEAF_SITE_BOOKS_DIR and INTERLEAF_SITE_CAPTURE_DIR to capture.');
  test.setTimeout(300_000);

  let app: AppHandle;
  let binDir: string;
  let staging: string;
  let books: readonly DemoBook[];

  test.beforeAll(() => {
    mkdirSync(captureDir, { recursive: true });
    ({ books, staging } = loadVerifiedBooks());
  });

  test.beforeEach(async () => {
    // Codex answers detection probes only, so the Agent tab shows a real
    // installed profile without a real CLI or any network access.
    binDir = createAgentCliFixture('codex');
    app = await launchInterleaf({ binDir });
    await sizeWindow(app);
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(binDir, { recursive: true, force: true });
  });

  test.afterAll(() => {
    rmSync(staging, { recursive: true, force: true });
  });

  test('captures library, reading, annotations, notes, search, chat and agent views', async () => {
    await stubSampleChat(app);
    await stubOpenDialog(app, books.map((book) => join(staging, book.importAs)));
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible({ timeout: 60_000 });
    await app.window.getByRole('button', { name: 'Dismiss success message' }).click();
    const ids = await documentIds(app, books);
    const id = (key: string): string => ids.get(key) ?? '';

    // Algorithms: highlights, a note and the Annotations browser.
    await openDocument(app, id('erickson-algorithms'));
    await goToPdfPage(app, 43);
    await highlight(app, 43, 'the secret to solving this puzzle is to think recursively', 'Yellow');
    await highlight(app, 43, 'let them do their job in peace', 'Green');
    await highlight(app, 43, 'There is a largest disk', 'Pink');
    await selectPdfPhrase(app, 43, 'reduced the n-disk Tower of Hanoi problem to two instances');
    await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill('Recursion Fairy: trust the smaller instances, never unroll them.');
    // The note card autosaves; capture it open once it reports Saved.
    await expect(app.window.getByTestId('selection-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    await shoot(app, 'notes-selection');
    await app.window.getByRole('button', { name: /^Done/u }).click();
    await openCompanionTab(app, /Annotations/u);
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(4);
    await shoot(app, 'reader-annotations');

    // Chat: the selection becomes context; the answer is the fixed sample.
    await selectPdfPhrase(app, 44, 'Our only task is to reduce the problem instance we’re given to one or more simpler instances');
    await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Ask AI' }).click();
    await expect(app.window.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await app.window.locator('#chat-composer').fill('How does this reduce the puzzle to recursion?');
    await app.window.getByRole('button', { name: 'Send' }).click();
    await expect(app.window.locator('[data-testid^="chat-message-"]').nth(1)).toContainText('largest disk', { timeout: 20_000 });
    await expect(app.window.locator('button[title^="Jump to"]').first()).toBeVisible();
    await shoot(app, 'reader-chat');

    // Agent: the same passage attached to a new task; no folder, no run.
    await selectPdfPhrase(app, 44, 'Hanoi ( n , src , dst , tmp )');
    await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Submit selected passage to agent' }).click();
    await expect(app.window.getByLabel('Task description')).toBeVisible();
    await app.window.getByLabel('Task description').fill('Build an interactive Tower of Hanoi visualiser from the attached pseudocode, with a step-through control.');
    await expect(app.window.getByTestId('agent-context-summary')).toBeVisible();
    await shoot(app, 'reader-agent');

    // Open Data Structures: in-document full-text search.
    await returnToLibrary(app);
    await openDocument(app, id('morin-ods-java'));
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status ?? 'missing', id('morin-ods-java')), { timeout: 60_000 }).toBe('ready');
    await openCompanionTab(app, /Search/u);
    const panel = app.window.getByTestId('search-panel');
    await panel.getByLabel('Search indexed text').fill('skiplist');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    const results = panel.getByRole('list', { name: 'Search results' }).getByRole('listitem');
    await expect(results.first()).toBeVisible();
    await results.nth(1).getByRole('button', { name: /Jump to/u }).click();
    await shoot(app, 'reader-search');

    // The library before the ebooks are opened: the PDFs carry real progress.
    await returnToLibrary(app);
    await setCompanionPanel(app, false);
    await app.window.getByTestId('nav-all-documents').click();
    await expect(app.window.getByTestId('document-grid')).toBeVisible();
    await shoot(app, 'library');

    // Alice: EPUB in Sepia.
    await setPalette(app, 'sepia');
    await openDocument(app, id('gutenberg-28885'));
    await setCompanionPanel(app, false);
    await goToSection(app, Number(process.env.INTERLEAF_SITE_ALICE_SECTION ?? '3'), /Rabbit-Hole/iu);
    await shoot(app, 'epub-sepia');

    // A location note in the same chapter, themed by the Sepia palette.
    await app.window.getByTestId('reader-header-toolbar').getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#location-note').fill('The fall takes a whole page: the narration slows down exactly when Alice does.');
    await expect(app.window.getByTestId('location-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    await shoot(app, 'notes-location');
    await app.window.getByRole('button', { name: /^Done/u }).click();
    await expect(app.window.locator('#location-note-popover')).toBeHidden();

    // Babbage: Midnight palette with the outline, then Focus Reading Mode.
    await returnToLibrary(app);
    await setPalette(app, 'midnight');
    await openDocument(app, id('gutenberg-57532'));
    await setCompanionPanel(app, false);
    await goToSection(app, Number(process.env.INTERLEAF_SITE_BABBAGE_SECTION ?? '20'), /Analytical Engine/iu);
    await app.window.getByTestId('toggle-toc-button').click();
    await expect(app.window.getByTestId('reader-outline-sidebar')).toBeVisible();
    await shoot(app, 'epub-midnight');
    await app.window.getByTestId('close-toc-button').click();
    await app.window.getByTestId('reader-focus-button').click();
    await expect(app.window.getByTestId('reader-focus-button')).toHaveAttribute('aria-pressed', 'true');
    await shoot(app, 'focus-mode');
  });
});
