import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DocumentMetadata } from '@shared/types/document';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makeDocxFixture, makeEpubFixture, makeMarkdownFixture, makeMobiFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue } from './listbox';

/**
 * Defect 20 regressions in a real BrowserWindow: note activation, pointer
 * affordance, drag suppression, keyboard activation and popover containment
 * across Markdown, EPUB, MOBI, PDF and DOCX.
 *
 * PNGs cannot capture OS cursor glyphs, so cursor behavior is asserted via
 * computed-style probes (top document for Markdown/PDF/DOCX, iframe document
 * for EPUB/MOBI).
 */

const NOTE_BODY = 'Regression note for defect 20: pointer affordance plus accessible popover.';
const PHRASE = 'decouples layout extraction';
const PARAGRAPH = `The reader engine ${PHRASE} from annotation persistence so notes remain stable.`;
const EPUB_PHRASE = 'Quantum jellyfish migrate across virtual memory';
const PROXY_SELECTOR = '[data-testid^="note-focus-proxy-"]';

type Point = { readonly x: number; readonly y: number };

/** Every fixture directory the current test created; afterEach removes them. */
const fixtureDirs: string[] = [];

function writeFixture(fileName: string, contents: string | Buffer): string {
  const dir = path.join(tmpdir(), `interleaf-d20-${String(Date.now())}-${String(Math.random()).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  fixtureDirs.push(dir);
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, contents);
  return filePath;
}

function markdownFixture(title: string, leadingLines: readonly string[] = []): string {
  return writeFixture(
    `${title}.md`,
    makeMarkdownFixture({
      title,
      author: 'Interleaf Regression',
      body: [`# ${title}`, '', ...leadingLines, PARAGRAPH, ''].join('\n'),
    })
  );
}

async function importAndOpen(app: AppHandle, filePath: string): Promise<DocumentMetadata> {
  await stubOpenDialog(app, [filePath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  const doc = docs[0]!;
  await app.window.getByTestId(`read-doc-${doc.id}`).click();
  return doc;
}

/** Selects `needle` through a real DOM Range inside the given top-document roots. */
async function selectInTop(page: Page, needle: string, rootSelector = '[data-markdown-block]'): Promise<void> {
  await page.evaluate(({ n, selector }) => {
    for (const block of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
    }
    throw new Error(`selection target not found: ${n}`);
  }, { n: needle, selector: rootSelector });
}

/** Selects `needle` through a real DOM Range inside the ebook section iframe. */
async function selectInEbook(page: Page, needle: string): Promise<void> {
  await page.frames().find((f) => f.parentFrame() !== null)!.evaluate((n) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf(n);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + n.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`EPUB selection target not found: ${n}`);
  }, needle);
}

async function saveNote(page: Page, body: string): Promise<void> {
  const toolbar = page.getByTestId('annotation-selection-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: /note/i }).click();
  await page.locator('#selection-note').fill(body);
  await toolbar.getByRole('button', { name: /^Done/u }).click();
  await expect(toolbar).toBeHidden();
}

/**
 * Raw-CDP native mouse drag. Playwright's page.mouse.move wraps every
 * non-click move in its drag-interception machinery, which stalls for text
 * drags inside the foliate srcdoc iframe. CDP Input is the native input
 * pipeline Playwright itself uses.
 */
async function cdpDrag(app: AppHandle, from: Point, to: Point): Promise<void> {
  const cdp = await app.window.context().newCDPSession(app.window);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'left', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (const frac of [0.34, 0.67, 1]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * frac,
      y: from.y + (to.y - from.y) * frac,
      button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await cdp.detach().catch(() => undefined);
}

/** Resolves a phrase in visible reader content to a top-window viewport point. */
async function phrasePointTop(page: Page, needle: string): Promise<Point> {
  return page.evaluate((n) => {
    // Reader content roots only: a whole-body walk would match duplicate
    // note text in sidebar/status UI and false-pass.
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>('[data-markdown-block], .textLayer span, [data-docx-paragraph]')
    );
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const rect = range.getBoundingClientRect();
        const onscreen = rect.width > 0 && rect.right > 0 && rect.bottom > 0
          && rect.left < window.innerWidth && rect.top < window.innerHeight;
        if (onscreen) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    throw new Error(`phrase not found in visible reader content: ${n}`);
  }, needle);
}

/** Resolves a phrase in the ebook iframe, translated by the iframe's top-window box. */
async function phrasePointEbook(page: Page, needle: string): Promise<Point> {
  const ebookFrame = page.frames().find((f) => f.parentFrame() !== null);
  if (ebookFrame === undefined) throw new Error('ebook frame missing');
  const local = await ebookFrame.evaluate((n) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf(n);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + n.length);
      const rect = range.getBoundingClientRect();
      const onscreen = rect.width > 0 && rect.right > 0 && rect.bottom > 0
        && rect.left < window.innerWidth && rect.top < window.innerHeight;
      if (onscreen) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`phrase not found in iframe: ${n}`);
  }, needle);
  const frameBox = await page.locator('iframe[title="Ebook Content"]').boundingBox();
  if (frameBox === null) throw new Error('ebook iframe missing');
  return { x: frameBox.x + local.x, y: frameBox.y + local.y };
}

async function readerCursorTop(app: AppHandle): Promise<string> {
  return app.window.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="pdf-viewport-container"]');
    return root !== null ? getComputedStyle(root).cursor : '';
  });
}

async function readerEffectiveCursorAt(app: AppHandle, point: Point): Promise<string> {
  return app.window.evaluate(({ x, y }) => {
    const root = document.querySelector<HTMLElement>('[data-testid="pdf-viewport-container"]');
    const target = document.elementFromPoint(x, y);
    if (target instanceof Element && root?.contains(target)) return getComputedStyle(target).cursor;
    return root !== null ? getComputedStyle(root).cursor : '';
  }, point);
}

async function ebookCursor(app: AppHandle): Promise<string> {
  const frame = app.window.frames().find((f) => f.parentFrame() !== null);
  if (frame === undefined) throw new Error('ebook frame missing');
  return frame.evaluate(() => getComputedStyle(document.body).cursor);
}

async function clickNoteAndAssert(app: AppHandle, point: Point, body: string): Promise<void> {
  await app.window.mouse.click(point.x, point.y);
  const popover = app.window.getByTestId('note-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expect(popover).toHaveAttribute('aria-label', 'Reader note');
  await expect(popover.getByTestId('note-popover-body')).toHaveText(body);
}

async function activeIdentity(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null);
}

async function focusIsOnProxy(page: Page): Promise<boolean> {
  return page.evaluate((selector) =>
    document.activeElement instanceof Element && document.activeElement.matches(selector), PROXY_SELECTOR);
}

/** Native Tab traversal only (no programmatic focus) until the note focus proxy holds focus. */
async function tabToProxy(page: Page, maxSteps: number): Promise<boolean> {
  for (let step = 0; step < maxSteps; step += 1) {
    await page.keyboard.press('Tab');
    if (await focusIsOnProxy(page)) return true;
  }
  return false;
}

/**
 * From focus on the proxy, Enter and Space each open the exact note above its
 * anchor, and Escape returns focus to the proxy.
 */
async function assertProxyKeyboardActivation(page: Page, body: string): Promise<void> {
  const proxyBox = await page.locator(PROXY_SELECTOR).boundingBox();
  expect(proxyBox).not.toBeNull();
  const popover = page.getByTestId('note-popover');
  for (const key of ['Enter', ' ']) {
    await page.keyboard.press(key);
    await expect(popover).toBeVisible();
    await expect(page.getByTestId('note-popover-body')).toHaveText(body);
    const popoverBox = await popover.boundingBox();
    expect(popoverBox).not.toBeNull();
    // Anchored above the noted text: popover bottom at/above the proxy top.
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(proxyBox!.y + 4);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    expect(await focusIsOnProxy(page)).toBe(true);
  }
}

/** Document-space top of the noted phrase, independent of scroll position. */
async function notedPhraseTop(page: Page, needle: string): Promise<number> {
  return page.evaluate((n) => {
    for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-block]'))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const rect = range.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        let parent: HTMLElement | null = root.parentElement;
        while (parent !== null && !['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) {
          parent = parent.parentElement;
        }
        return rect.top + (parent?.scrollTop ?? 0);
      }
    }
    throw new Error(`phrase not found in visible reader content: ${n}`);
  }, needle);
}

/** Top edges of the first and last live client rects of the noted range, plus the last rect's center. */
async function fragmentEdges(page: Page, needle: string): Promise<{ firstTop: number; lastTop: number; lastCenter: Point }> {
  return page.evaluate((n) => {
    for (const block of Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-block]'))) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (rects.length === 0) throw new Error('no live fragments');
        const last = rects[rects.length - 1]!;
        return {
          firstTop: rects[0]!.top,
          lastTop: last.top,
          lastCenter: { x: last.left + last.width / 2, y: last.top + last.height / 2 },
        };
      }
    }
    throw new Error('noted range not found');
  }, needle);
}

async function popoverFollowsLastFragment(page: Page, needle: string): Promise<boolean> {
  const edges = await fragmentEdges(page, needle);
  const box = await page.getByTestId('note-popover').boundingBox();
  if (box === null) return false;
  const bottom = box.y + box.height;
  return Math.abs(bottom - edges.lastTop) < Math.abs(bottom - edges.firstTop);
}

async function expectPopoverInViewport(page: Page): Promise<void> {
  const box = await page.getByTestId('note-popover').boundingBox();
  const [innerWidthPx, innerHeightPx] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(innerWidthPx + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(innerHeightPx + 1);
}

test.describe('Defect 20 note regressions (real BrowserWindow)', () => {
  test.setTimeout(120_000);
  let app: AppHandle | null = null;

  test.afterEach(async () => {
    await Promise.all(fixtureDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
    if (app === null) return;
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    app = null;
  });

  test('native Markdown drag across the text released outside the note does not open it; a clean click does', async () => {
    app = await launchInterleaf();
    const filePath = writeFixture(
      'Defect 20 Popover Fixture.md',
      makeMarkdownFixture({
        title: 'Defect 20 Popover Fixture',
        author: 'Interleaf Regression',
        body: [
          '# Defect 20 Popover Fixture',
          '',
          PARAGRAPH,
          '',
          'Overview paragraph provides neutral scroll depth.',
          '',
          'Details paragraph closes the document body.',
          '',
        ].join('\n'),
      })
    );
    await importAndOpen(app, filePath);
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectInTop(app.window, PHRASE);
    await saveNote(app.window, NOTE_BODY);

    const onRange = await phrasePointTop(app.window, PHRASE);
    await app.window.mouse.move(onRange.x, onRange.y);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('pointer');

    // Real mouse drag STARTING on the noted text and releasing outside: the
    // browser fires a click on the common ancestor afterwards; the retained
    // drag distance must suppress note activation.
    await app.window.mouse.move(onRange.x - 20, onRange.y);
    await app.window.mouse.down();
    await app.window.mouse.move(onRange.x + 220, onRange.y + 40, { steps: 8 });
    await app.window.mouse.up();
    await app.window.waitForTimeout(150);
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // A clean click on the noted text opens the exact note (the click itself
    // collapses the drag's live selection natively; the retained drag
    // distance has been consumed and zeroed).
    await clickNoteAndAssert(app, onRange, NOTE_BODY);
    await expect(app.window.getByTestId('annotation-selection-toolbar')).toHaveCount(0);

    // Escape restores focus to the opener (whatever the browser focused).
    const openerId = await activeIdentity(app.window);
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
    await expect.poll(async () => activeIdentity(app!.window)).toBe(openerId);

    // Outside pointerdown closes without stealing focus from the control.
    // The outside point is reader prose below the noted line (never noted).
    const beforeFocus = await activeIdentity(app.window);
    await clickNoteAndAssert(app, onRange, NOTE_BODY);
    await app.window.mouse.click(onRange.x, onRange.y + 120);
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
    const afterFocus = await activeIdentity(app.window);
    expect(afterFocus).toBe(beforeFocus);
  });

  test('drag leaving the reader surface while pressed suppresses re-entry release on the note', async () => {
    app = await launchInterleaf();
    await importAndOpen(app, markdownFixture('Defect 20 Leave Fixture'));
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectInTop(app.window, PHRASE);
    await saveNote(app.window, NOTE_BODY);
    // Collapse the live selection so the later clean click is unambiguous.
    const anchor = await phrasePointTop(app.window, PHRASE);
    await app.window.mouse.click(anchor.x, anchor.y + 120);
    await app.window.waitForTimeout(150);

    // Press on the note, travel, LEAVE the reader content surface into the
    // app header while the button is still held, re-enter, and release ON the
    // note: the release-generated click must stay suppressed.
    const cdp = await app.window.context().newCDPSession(app.window);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: anchor.x, y: anchor.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: anchor.x + 80, y: anchor.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: anchor.x + 80, y: 20, button: 'left', buttons: 1, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: anchor.x, y: anchor.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: anchor.x, y: anchor.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await app.window.waitForTimeout(250);
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
    await cdp.detach().catch(() => undefined);

    // The next clean click opens the exact note.
    await app.window.mouse.click(anchor.x, anchor.y);
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    await expect(app.window.getByTestId('note-popover-body')).toHaveText(NOTE_BODY);
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
  });

  test('Markdown keyboard path: sidebar edit/cancel and noted-text proxy via native Enter/Space', async () => {
    app = await launchInterleaf();
    await importAndOpen(app, markdownFixture('Defect 20 Keyboard Fixture'));
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectInTop(app.window, PHRASE);
    await saveNote(app.window, NOTE_BODY);

    // Buttons are activated by real Enter/Space key events; no element.click().
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    const list = app.window.getByTestId('annotation-page-list');
    const editButton = list.getByRole('button', { name: 'Edit' });
    await expect(editButton).toBeVisible();
    for (const key of ['Enter', ' ']) {
      await editButton.focus();
      await app.window.keyboard.press(key);
      await expect(list.getByRole('textbox')).toBeVisible();
      await expect(list.getByRole('textbox')).toHaveValue(NOTE_BODY);
      // Tab walks from the edit surface to its Done control; Enter closes the
      // unchanged note without rewriting it, and focus returns to Edit.
      await app.window.keyboard.press('Tab');
      expect(await app.window.evaluate(() => document.activeElement?.textContent ?? '')).toMatch(/^Done/u);
      await app.window.keyboard.press('Enter');
      await expect(list.getByRole('textbox')).toHaveCount(0);
      await expect(list).toContainText(NOTE_BODY);
      await expect(editButton).toBeFocused();
    }

    // Sequential Tab traversal reaches the focus proxy over the noted text.
    expect(await tabToProxy(app.window, 80)).toBe(true);
    await assertProxyKeyboardActivation(app.window, NOTE_BODY);

    // The keyboard open announces the exact body through the live region.
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    await expect(app.window.getByTestId('note-popover-status')).toHaveText(`Reader note: ${NOTE_BODY}`);
    await app.window.keyboard.press('Escape');
  });

  test('real EPUB: keyboard proxy, iframe affordance, drag suppression, section and reader cleanup', async () => {
    const filePath = writeFixture(
      'Defect 20 Ebook.epub',
      makeEpubFixture({
        title: 'Defect 20 Ebook',
        author: 'Interleaf Regression',
        chapters: [
          {
            title: 'Chapter 1: Frame Isolation',
            content: `<p>${EPUB_PHRASE} without leaving the sandboxed section document.</p>` +
              Array.from({ length: 200 }, (_, index) => `<p>Filler passage ${String(index + 1)} for scroll depth.</p>`).join(''),
          },
          { title: 'Chapter 2: Section Switching', content: '<p>The second chapter contains entirely different prose.</p>' },
        ],
      })
    );
    app = await launchInterleaf();
    const doc = await importAndOpen(app, filePath);
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    const iframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(iframe.getByText(EPUB_PHRASE)).toBeVisible();

    // The note is created from a real iframe DOM selection (the repo's EPUB
    // selection convention); everything after this point is native input.
    const phrase = await phrasePointEbook(app.window, EPUB_PHRASE);
    await selectInEbook(app.window, EPUB_PHRASE);
    await saveNote(app.window, NOTE_BODY);

    const proxy = app.window.locator(PROXY_SELECTOR);
    await expect(proxy).toHaveCount(1);
    await expect(proxy).toBeVisible();
    expect(await tabToProxy(app.window, 120)).toBe(true);
    await assertProxyKeyboardActivation(app.window, NOTE_BODY);

    // Pointer affordance is applied inside the iframe document; off-range the
    // computed cursor returns to the body's baseline.
    const ebookBaseline = await ebookCursor(app);
    await app.window.mouse.move(24, 24);
    await expect.poll(async () => ebookCursor(app!), { timeout: 5_000 }).toBe(ebookBaseline);
    // Re-resolve and re-hover each poll: a single move can land before the
    // iframe layout settles and never fire another pointermove.
    await expect.poll(async () => {
      const hoverPoint = await phrasePointEbook(app!.window, EPUB_PHRASE);
      await app!.window.mouse.move(hoverPoint.x, hoverPoint.y);
      return ebookCursor(app!);
    }, { timeout: 5_000 }).toBe('pointer');
    await app.window.mouse.move(24, 24);
    await expect.poll(async () => ebookCursor(app!), { timeout: 5_000 }).toBe(ebookBaseline);

    // Collapse the note-creation selection on non-noted filler text.
    await app.window.mouse.click(phrase.x, phrase.y + 120);
    await app.window.waitForTimeout(120);

    // Native iframe drag across the noted text opens the selection toolbar and
    // its release-generated click does not open the note popover.
    await cdpDrag(app, { x: phrase.x - 50, y: phrase.y }, { x: phrase.x + 50, y: phrase.y });
    await expect(app.window.getByTestId('annotation-selection-toolbar')).toBeVisible();
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // The next separate clean click opens the popover in the top frame.
    await clickNoteAndAssert(app, phrase, NOTE_BODY);

    // Keyboard section switch while open: the old iframe document's detach
    // must close the bubble (no Escape, no outside pointerdown).
    const nextPage = app.window.getByTestId('next-page-button');
    await nextPage.focus();
    await app.window.keyboard.press('Enter');
    await expect(iframe.getByText('entirely different prose')).toBeVisible();
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // The discarded section's stale coordinates must not open anything.
    await app.window.mouse.click(phrase.x, phrase.y);
    await app.window.waitForTimeout(150);
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // Back to the noted section: the note re-anchors and opens again.
    await app.window.getByTestId('prev-page-button').click();
    await expect(iframe.getByText(EPUB_PHRASE)).toBeVisible();
    await clickNoteAndAssert(app, await phrasePointEbook(app.window, EPUB_PHRASE), NOTE_BODY);

    // Keyboard-activating the library destination with the popover open: the
    // reader lifecycle, not Escape or focus handling, must remove the bubble.
    const readerBack = app.window
      .getByTestId('sidebar-library')
      .first()
      .locator('nav[aria-label="Library sections"] button.font-semibold')
      .first();
    await readerBack.focus();
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    await expect(iframe.getByText(EPUB_PHRASE)).toBeVisible();
    await clickNoteAndAssert(app, await phrasePointEbook(app.window, EPUB_PHRASE), NOTE_BODY);
    await app.window.keyboard.press('Escape');
  });

  test('native 200% zoom: long multiline note contained, later fragment followed across resize', async () => {
    const longBody = Array.from({ length: 14 }, (_, line) =>
      `Line ${String(line + 1)}: noted text wraps across the measured panel and must stay contained.`
    ).join('\n');
    app = await launchInterleaf();
    // Playwright's mouse domain is CSS pixels and stays correct at zoom 2.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect.poll(async () => app!.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    await importAndOpen(app, markdownFixture('Defect 20 Zoom Fixture'));
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    // The noted range wraps to several rendered lines at zoom 2.
    await selectInTop(app.window, PARAGRAPH);
    await saveNote(app.window, longBody);

    await expect(app.window.locator(PROXY_SELECTOR)).toHaveCount(1, { timeout: 15_000 });
    // Saving opens the compact Annotations drawer with a full-screen backdrop
    // at 200%; close it through its keyboard toggle before pointer input.
    const closeCompanion = app.window.getByTestId('compact-drawer-right').getByRole('button', { name: 'Close drawer' });
    await closeCompanion.focus();
    await app.window.keyboard.press('Enter');
    await expect.poll(async () => {
      const backdrop = app!.window.getByTestId('compact-backdrop');
      if (await backdrop.count() === 0) return true;
      return backdrop.evaluate((element) => element.classList.contains('pointer-events-none'));
    }, { timeout: 5_000 }).toBe(true);
    const point = await phrasePointTop(app.window, PHRASE);
    await app.window.mouse.move(24, 24);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('auto');
    await app.window.mouse.move(point.x, point.y);
    await expect.poll(async () => readerEffectiveCursorAt(app!, point), { timeout: 5_000 }).toBe('pointer');
    await app.window.mouse.click(point.x, point.y);
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    // The body renders each note line on its own line (`<br>`), so compare the
    // rendered text, which keeps the line breaks textContent drops.
    await expect.poll(async () => app!.window.getByTestId('note-popover').getByTestId('note-popover-body').innerText())
      .toBe(longBody);
    await expectPopoverInViewport(app.window);
    const overflowX = await app.window.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
    expect(overflowX).toBeLessThanOrEqual(1);

    // Activate a LATER fragment: the popover anchors to that line and keeps
    // following it across a runtime resize, never collapsing to the first rect.
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
    const { lastCenter } = await fragmentEdges(app.window, PARAGRAPH);
    await app.window.mouse.click(lastCenter.x, lastCenter.y);
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    expect(await popoverFollowsLastFragment(app.window, PARAGRAPH)).toBe(true);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const size = win!.getContentSize();
      win!.setContentSize(Math.max((size[0] ?? 800) - 120, 700), Math.max((size[1] ?? 600) - 80, 480));
    });
    // Reconciliation is asynchronous: wait for the live geometry to follow.
    await expect.poll(async () => popoverFollowsLastFragment(app!.window, PARAGRAPH), { timeout: 5_000 }).toBe(true);
    await expectPopoverInViewport(app.window);
  });

  test('runtime window resize keeps the open popover reconciled and contained', async () => {
    app = await launchInterleaf();
    await importAndOpen(app, markdownFixture('Defect 20 Reflow Fixture'));
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectInTop(app.window, PHRASE);
    await saveNote(app.window, 'Reflow reconciliation body.');
    await app.window.waitForTimeout(120);

    await clickNoteAndAssert(app, await phrasePointTop(app.window, PHRASE), 'Reflow reconciliation body.');

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const size = win!.getContentSize();
      win!.setContentSize(Math.min(size[0] ?? 980, 980), 640);
    });
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    await expectPopoverInViewport(app.window);
    await app.window.keyboard.press('Escape');
  });

  test('display reflow invalidates a warm rect cache and re-anchors the popover', async () => {
    // The noted phrase sits below 40 filler paragraphs so a line-spacing
    // change shifts it far enough that the old anchor lands on filler.
    const filler = Array.from({ length: 40 }, (_, i) => `Filler passage ${String(i + 1)} keeps the noted paragraph far down the flow.`);
    app = await launchInterleaf();
    await importAndOpen(app, markdownFixture('Defect 20 Warm Reflow Fixture', filler.flatMap((line) => [line, ''])));
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectInTop(app.window, PHRASE);
    await saveNote(app.window, 'Reflow reconciliation body.');

    const scrollPhraseIntoView = async (): Promise<void> => {
      await app!.window.locator('[data-markdown-block]', { hasText: PHRASE }).evaluate((root) => {
        root.scrollIntoView({ block: 'center' });
      });
      await app!.window.waitForTimeout(250);
    };
    await scrollPhraseIntoView();

    // Warm the rect cache with a real hit-test plus a full open/close cycle.
    const pointWarm = await phrasePointTop(app.window, PHRASE);
    const topBefore = await notedPhraseTop(app.window, PHRASE);
    await app.window.mouse.move(pointWarm.x, pointWarm.y);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('pointer');
    await app.window.mouse.click(pointWarm.x, pointWarm.y);
    await expect(app.window.getByTestId('note-popover')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // No scroll event may fire between warm-up and the line-spacing change,
    // otherwise scrolling, not the setter, would invalidate the cache. Scroll
    // anchoring would itself fire one, so it is disabled.
    await app.window.evaluate(() => {
      const w = window as { __d20ScrollEvents?: number };
      w.__d20ScrollEvents = 0;
      for (const el of [document.documentElement, document.body, ...document.querySelectorAll('*')]) {
        (el as HTMLElement).style.overflowAnchor = 'none';
      }
      document.addEventListener('scroll', () => { w.__d20ScrollEvents = (w.__d20ScrollEvents ?? 0) + 1; }, true);
    });

    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    await chooseListboxValue(app.window.getByTestId('line-spacing-select'), '1.9');
    await app.window.getByTestId('document-settings-button').click();
    await app.window.waitForTimeout(250);

    // The reflow actually moved the noted geometry, with no scroll event.
    const topAfter = await notedPhraseTop(app.window, PHRASE);
    expect(topAfter - topBefore).toBeGreaterThan(10);
    const scrollEvents = await app.window.evaluate(
      () => (window as { __d20ScrollEvents?: number }).__d20ScrollEvents ?? -1
    );
    expect(scrollEvents).toBe(0);

    // Old geometry no longer activates. Move away and back so the hover
    // hit-test genuinely re-runs against the reflowed geometry.
    await app.window.mouse.move(120, 300);
    await app.window.waitForTimeout(120);
    await app.window.mouse.move(pointWarm.x, pointWarm.y);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('auto');
    await app.window.mouse.click(pointWarm.x, pointWarm.y);
    await app.window.waitForTimeout(150);
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);

    // New geometry opens the exact note and the live region announces it.
    await scrollPhraseIntoView();
    await clickNoteAndAssert(app, await phrasePointTop(app.window, PHRASE), 'Reflow reconciliation body.');
    await expect(app.window.getByTestId('note-popover-status')).toHaveText('Reader note: Reflow reconciliation body.');
    await app.window.keyboard.press('Escape');
  });

  test('PDF path: native drag note, pointer affordance, popover content', async () => {
    const filePath = writeFixture(
      'Defect 20 Pdf.pdf',
      makePdfFixture({ pages: [`The reader engine ${PHRASE} from annotation persistence on page one.`] })
    );
    app = await launchInterleaf();
    await importAndOpen(app, filePath);
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    // Real mouse drag across the phrase inside the PDF text layer.
    await expect(app.window.locator('.textLayer span').first()).toBeVisible({ timeout: 20_000 });
    const span = app.window.locator('.textLayer span', { hasText: PHRASE }).first();
    const point = await span.evaluate((element, n) => {
      const text = element.textContent;
      const index = text.indexOf(n);
      const rect = element.getBoundingClientRect();
      const charW = rect.width / Math.max(1, text.length);
      return { startX: rect.left + index * charW, endX: rect.left + (index + n.length) * charW, y: rect.top + rect.height / 2 };
    }, PHRASE);
    await app.window.mouse.move(point.startX, point.y);
    await app.window.mouse.down();
    await app.window.mouse.move(point.endX, point.y, { steps: 6 });
    await app.window.mouse.up();
    await saveNote(app.window, NOTE_BODY);

    // Collapse the drag's live selection on non-noted content.
    await app.window.mouse.click(point.startX, point.y + 80);
    await app.window.waitForTimeout(120);

    const onRange = await phrasePointTop(app.window, PHRASE);
    await app.window.mouse.move(onRange.x, onRange.y);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('pointer');
    await clickNoteAndAssert(app, onRange, NOTE_BODY);
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('note-popover')).toHaveCount(0);
  });

  test('DOCX path: pointer affordance and popover content', async () => {
    const docxPhrase = 'Stable semantic anchors make DOCX research notes durable.';
    app = await launchInterleaf();
    await importAndOpen(app, writeFixture('Defect 20 Doc.docx', makeDocxFixture({ title: 'Defect 20 Doc', bodyText: docxPhrase })));
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByText(docxPhrase)).toBeVisible({ timeout: 20_000 });

    await selectInTop(app.window, docxPhrase, '[data-docx-paragraph], p');
    await saveNote(app.window, NOTE_BODY);
    // Collapse the live selection on non-noted page content. (The window's
    // top-left corner now holds the left-panel toggle.)
    const docxPoint = await phrasePointTop(app.window, docxPhrase);
    await app.window.mouse.click(docxPoint.x, docxPoint.y + 120);
    await app.window.waitForTimeout(120);

    await app.window.mouse.move(docxPoint.x, docxPoint.y);
    await expect.poll(async () => readerCursorTop(app!), { timeout: 5_000 }).toBe('pointer');
    await clickNoteAndAssert(app, docxPoint, NOTE_BODY);
    await app.window.keyboard.press('Escape');
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
  });

  test('MOBI path: native iframe drag, pointer affordance, popover content', async () => {
    const filePath = writeFixture(
      'Defect 20 Ebook.mobi',
      makeMobiFixture({
        title: 'Defect 20 Mobi',
        author: 'Interleaf Regression',
        chapters: [
          { title: 'Chapter 1: Frame Isolation', content: `<p>${EPUB_PHRASE} without leaving the sandboxed section document.</p>` },
          { title: 'Chapter 2', content: '<p>Second chapter prose.</p>' },
        ],
      })
    );
    app = await launchInterleaf();
    await importAndOpen(app, filePath);
    const mobiIframe = app.window.frameLocator('iframe[title="Ebook Content"]');
    await expect(mobiIframe.getByText(EPUB_PHRASE)).toBeVisible();

    const mobiPoint = await phrasePointEbook(app.window, EPUB_PHRASE);
    await cdpDrag(app, { x: mobiPoint.x - 60, y: mobiPoint.y }, { x: mobiPoint.x + 60, y: mobiPoint.y });
    await saveNote(app.window, NOTE_BODY);

    await app.window.mouse.move(mobiPoint.x, mobiPoint.y);
    await expect.poll(async () => ebookCursor(app!), { timeout: 5_000 }).toBe('pointer');
    await clickNoteAndAssert(app, mobiPoint, NOTE_BODY);
    await app.window.keyboard.press('Escape');
  });
});
