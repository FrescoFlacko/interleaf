import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeEpubFixture, makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Opening a note on a selected passage, in a real window.
 *
 * The renderer suite pins where the box is placed and when the passage mark is
 * set and cleared. Only a real window shows the parts that matter to a reader:
 * the note field really takes focus and the browser's selection really goes
 * away, the mark is registered in the page's own highlight registry on the
 * exact text, and the box measured on screen keeps the top-left the toolbar
 * had before the note opened, through typing and every save status.
 *
 * No AI provider is contacted: this is the reader and the annotation store.
 */

const PHRASE = 'leases bound the window of divergence';
const TOP_PHRASE = 'Filler paragraph 2 keeps the passage';
const FOOT_PHRASE = 'Filler paragraph 20 keeps the passage';
const MARK = 'interleaf-note-selection';
const filler = (count: number): string => Array.from(
  { length: count },
  (_, index) => `Filler paragraph ${String(index + 1)} keeps the passage away from the top of the reader so the toolbar sits above it.`,
).join('\n\n');
const BODY = [
  filler(3), '',
  `Under a bounded clock assumption, ${PHRASE} to the lease term rather than to the network.`, '',
  filler(30), '',
].join('\n');

type Box = { left: number; top: number; right: number; bottom: number };

type Points = { x1: number; y1: number; x2: number; y2: number };

/** Where a drag across `needle` starts and ends, in the coordinates of the document under `scope`. */
function phrasePoints({ scope, needle }: { scope: string; needle: string }): Points {
  for (const block of document.querySelectorAll<HTMLElement>(scope)) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf(needle);
      if (index < 0) continue;
      const first = document.createRange();
      first.setStart(node, index);
      first.setEnd(node, index + 1);
      const last = document.createRange();
      last.setStart(node, index + needle.length - 1);
      last.setEnd(node, index + needle.length);
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
  }
  throw new Error(`selection target not found: ${needle}`);
}

async function drag(page: Page, points: Points): Promise<void> {
  await page.mouse.move(points.x1, points.y1);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y2, { steps: 10 });
  await page.mouse.up();
}

/** Drags across the phrase with the mouse, as a reader selects. */
async function dragSelect(page: Page, needle: string, scope = '[data-markdown-block]'): Promise<void> {
  await drag(page, await page.evaluate(phrasePoints, { scope, needle }));
}

/** The toolbar and passage on screen, and what the page's highlight registry marks. */
async function measure(page: Page, needle: string): Promise<{ panel: Box; passage: Box; marked: string[]; nativeCollapsed: boolean }> {
  return page.evaluate(({ n, mark }) => {
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const panel = document.querySelector('[data-testid="annotation-selection-toolbar"]')!.getBoundingClientRect();
    let passage: DOMRect | null = null;
    for (const block of document.querySelectorAll<HTMLElement>('[data-markdown-block]')) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null && passage === null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        passage = range.getBoundingClientRect();
      }
      if (passage) break;
    }
    const marked = [...(CSS.highlights.get(mark) ?? [])].map((range) => (range as Range).toString());
    return { panel: box(panel), passage: box(passage!), marked, nativeCollapsed: document.getSelection()?.isCollapsed ?? true };
  }, { n: needle, mark: MARK });
}

async function marked(page: Page): Promise<string[]> {
  return page.evaluate((mark) => [...(CSS.highlights.get(mark) ?? [])].map((range) => (range as Range).toString()), MARK);
}

/** The panel's top-left, and the note field's height. */
async function origin(page: Page): Promise<{ left: number; top: number; bottom: number; field: number }> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="annotation-selection-toolbar"]')!.getBoundingClientRect();
    const field = document.querySelector('#selection-note')?.getBoundingClientRect().height ?? 0;
    return { left: panel.left, top: panel.top, bottom: panel.bottom, field };
  });
}

function expectSameOrigin(actual: { left: number; top: number }, expected: { left: number; top: number }): void {
  expect(Math.abs(actual.top - expected.top), `top ${String(actual.top)} vs ${String(expected.top)}`).toBeLessThanOrEqual(2);
  expect(Math.abs(actual.left - expected.left), `left ${String(actual.left)} vs ${String(expected.left)}`).toBeLessThanOrEqual(2);
}

/** The note field holds focus with its caret after everything typed. */
async function expectCaretAtEnd(page: Page): Promise<void> {
  const caret = await page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('#selection-note')!;
    return { focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd, length: field.value.length };
  });
  expect(caret).toEqual({ focused: true, start: caret.length, end: caret.length, length: caret.length });
  expect(caret.length).toBeGreaterThan(0);
}

const TEN_LINES = Array.from({ length: 11 }, (_, index) => `Line ${String(index + 1)} of a longer note.`).join('\n');

test.describe('Selection note stability', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-note-'));
    const fixture = join(fixtureDir, 'Margin Notes.md');
    writeFileSync(fixture, makeMarkdownFixture({ title: 'Margin Notes', author: 'Interleaf Regression', body: BODY }));
    app = await launchInterleaf();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.unmaximize();
      window.setContentSize(1280, 820);
      window.webContents.setZoomFactor(1);
    });
    await stubOpenDialog(app, [fixture]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documentId = (await app.window.evaluate(() => window.interleafAPI.library.listDocuments()))[0]!.id;
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
  });

  test.afterAll(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('a pointer Add note keeps the passage marked and the box at the bar\'s top-left through typing and saving', async () => {
    const page = app.window;
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    await dragSelect(page, PHRASE);
    await expect(toolbar).toBeVisible();
    const before = await measure(page, PHRASE);
    expect(before.panel.bottom).toBeLessThanOrEqual(before.passage.top);
    const collapsed = await origin(page);

    await toolbar.getByRole('button', { name: 'Add note' }).click();
    const field = page.locator('#selection-note');
    await expect(field).toBeFocused();
    // Measured straight away, before any later re-measure could settle it.
    const opened = await origin(page);
    expectSameOrigin(opened, collapsed);
    expect(opened.bottom - opened.top).toBeGreaterThan(collapsed.bottom - collapsed.top + 100);
    await expect.poll(() => marked(page)).toEqual([PHRASE]);
    // The note field took the browser's selection; the mark stands in for it.
    expect((await measure(page, PHRASE)).nativeCollapsed).toBe(true);

    await page.keyboard.type(TEN_LINES);
    const typing = await origin(page);
    expect(typing.field).toBeGreaterThan(opened.field + 40);
    expectSameOrigin(typing, collapsed);
    await expect(page.getByTestId('selection-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    expectSameOrigin(await origin(page), collapsed);
    expect(await marked(page)).toEqual([PHRASE]);
    await expectCaretAtEnd(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-note-open="true"]')).toHaveCount(0);
    await expect.poll(() => marked(page)).toEqual([]);
    const notes = await page.evaluate(async () => {
      const documentId = (await window.interleafAPI.library.listDocuments())[0]!.id;
      return (await window.interleafAPI.annotations.list(documentId)).map((note) => ({ type: note.type, text: note.selectedText }));
    });
    expect(notes).toEqual([{ type: 'note', text: PHRASE }]);
  });

  test('a keyboard Add note near the top of the reader opens at the bar\'s top-left over the passage, not below it', async () => {
    const page = app.window;
    await page.evaluate(() => { document.getSelection()?.removeAllRanges(); });
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    await dragSelect(page, TOP_PHRASE);
    await expect(toolbar).toBeVisible();
    const collapsed = await origin(page);

    await toolbar.getByRole('button', { name: 'Add note' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#selection-note')).toBeFocused();
    expectSameOrigin(await origin(page), collapsed);
    await expect.poll(() => marked(page)).toEqual([TOP_PHRASE]);
    await page.keyboard.type('Kept.');
    await expectCaretAtEnd(page);
    expectSameOrigin(await origin(page), collapsed);

    // A new selection retires the mark with the note.
    await page.keyboard.press('Escape');
    await dragSelect(page, PHRASE);
    await expect.poll(() => marked(page)).toEqual([]);
    await page.evaluate(() => { document.getSelection()?.removeAllRanges(); });
  });

  test('near the foot of the reader the box moves up by only the least that fits, with Done reachable', async () => {
    const page = app.window;
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    const reader = await page.evaluate((n) => {
      const block = [...document.querySelectorAll<HTMLElement>('[data-markdown-block]')].find((candidate) => candidate.textContent.includes(n))!;
      const rect = document.querySelector('[data-reader-focus-target="true"]')!.getBoundingClientRect();
      // Bring the passage to just above the reader's foot.
      const scroller = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]')!;
      scroller.scrollTop += block.getBoundingClientRect().bottom - (rect.bottom - 40);
      return { top: rect.top, bottom: rect.bottom };
    }, FOOT_PHRASE);
    await dragSelect(page, FOOT_PHRASE);
    await expect(toolbar).toBeVisible();
    const collapsed = await origin(page);

    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    const opened = await origin(page);
    expect(Math.abs(opened.left - collapsed.left)).toBeLessThanOrEqual(2);
    expect(opened.top).toBeLessThan(collapsed.top - 2);
    expect(Math.abs(opened.bottom - (reader.bottom - 8))).toBeLessThanOrEqual(2);
    // Done is on screen without scrolling the box.
    await expect(page.getByRole('button', { name: /^Done/u })).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: /^Done/u }).click();
    await expect(page.locator('[data-note-open="true"]')).toHaveCount(0);
    await expect.poll(() => marked(page)).toEqual([]);
    await page.evaluate(() => { document.getSelection()?.removeAllRanges(); });
  });

  test('at 200% zoom in the narrowest window the open box is capped inside the reader with Done reachable', async () => {
    const page = app.window;
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(960, 820);
      window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480);
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    // The reader restores its place after the zoom reflow, so keep bringing the
    // passage into view until it stays there, then drag.
    await expect.poll(() => page.evaluate((n) => {
      const block = [...document.querySelectorAll<HTMLElement>('[data-markdown-block]')].find((candidate) => candidate.textContent.includes(n));
      const rect = block?.getBoundingClientRect();
      if (rect !== undefined && rect.top > 100 && rect.top < window.innerHeight - 40) return true;
      block?.scrollIntoView({ block: 'center' });
      return false;
    }, PHRASE), { intervals: [250] }).toBe(true);
    await dragSelect(page, PHRASE);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    await expect.poll(() => marked(page)).toEqual([PHRASE]);

    // Shrinking the window while the note is open re-clamps it.
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600); });
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(300);
    const panel = (await toolbar.boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(480);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.y + panel.height).toBeLessThanOrEqual(300);
    // Taller than the reader here, the box is capped to it and scrolls.
    const done = page.getByRole('button', { name: /^Done/u });
    await done.scrollIntoViewIfNeeded();
    await expect(done).toBeInViewport();
    await done.click();
    await expect(page.locator('[data-note-open="true"]')).toHaveCount(0);
    await expect.poll(() => marked(page)).toEqual([]);
  });

  test('a failed save leaves the box where it opened', async () => {
    const page = app.window;
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1280, 820);
      window.webContents.setZoomFactor(1);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
    await expect.poll(() => page.evaluate((n) => {
      const block = [...document.querySelectorAll<HTMLElement>('[data-markdown-block]')].find((candidate) => candidate.textContent.includes(n))!;
      const rect = block.getBoundingClientRect();
      if (rect.top > 300 && rect.top < window.innerHeight - 300) return true;
      block.scrollIntoView({ block: 'center' });
      return false;
    }, PHRASE), { intervals: [250] }).toBe(true);
    await dragSelect(page, PHRASE);
    await expect(toolbar).toBeVisible();
    const collapsed = await origin(page);
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    // Every save fails from here on, in this test process only.
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('annotations:create');
      ipcMain.handle('annotations:create', () => { throw new Error('disk full'); });
    });
    await page.keyboard.type('This will not save.');
    await expect(page.getByTestId('selection-note-error')).toBeVisible({ timeout: 10_000 });
    expectSameOrigin(await origin(page), collapsed);
    expect(await marked(page)).toEqual([PHRASE]);
  });
});

const PDF_LINES = [
  'Alpha: the opening line of the note fixture page.',
  'Bravo: a passage the reader wants to annotate.',
  'Charlie: another passage for the keyboard path.',
  'Delta: the line a later selection lands on.',
] as const;
const PDF_POINTER = 'a passage the reader wants';
const PDF_KEYBOARD = 'another passage for the keyboard';
const PDF_LATER = 'the line a later selection';
const PDF_READABLE = 'the opening line of the note';

test.describe('Selection note paint in a PDF', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-note-pdf-'));
    const fixture = join(fixtureDir, 'Note Paint.pdf');
    writeFileSync(fixture, makePdfFixture({
      title: 'Note Paint',
      author: 'Interleaf Regression',
      pageLines: [[...PDF_LINES], ['Second page.']],
      pageStartPositions: [[72, 700], [72, 700]],
      outline: [],
    }));
    app = await launchInterleaf();
    await stubOpenDialog(app, [fixture]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documentId = (await app.window.evaluate(() => window.interleafAPI.library.listDocuments()))[0]!.id;
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
  });

  test.afterAll(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('pointer and keyboard Add note keep the text-layer passage marked while typing, and a new selection clears it', async () => {
    const page = app.window;
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    const layer = '[data-testid="pdf-textlayer-p1"]';

    await dragSelect(page, PDF_POINTER, layer);
    await expect(toolbar).toBeVisible();
    const collapsed = await origin(page);
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    expectSameOrigin(await origin(page), collapsed);
    await expect.poll(() => marked(page)).toEqual([PDF_POINTER]);
    await page.keyboard.type('Typed over a PDF passage.');
    await expect(page.getByTestId('selection-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    expect(await marked(page)).toEqual([PDF_POINTER]);
    await expectCaretAtEnd(page);
    expectSameOrigin(await origin(page), collapsed);
    await page.keyboard.press('Escape');
    await expect.poll(() => marked(page)).toEqual([]);

    await dragSelect(page, PDF_KEYBOARD, layer);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#selection-note')).toBeFocused();
    await expect.poll(() => marked(page)).toEqual([PDF_KEYBOARD]);
    await page.keyboard.type('Keyboard note.');
    expect(await marked(page)).toEqual([PDF_KEYBOARD]);
    await expectCaretAtEnd(page);

    // Selecting elsewhere while the note is open retires its mark.
    await dragSelect(page, PDF_LATER, layer);
    await expect.poll(() => marked(page)).toEqual([]);
    await expect(page.locator('[data-note-open="true"]')).toHaveCount(0);
  });

  test('the marked passage stays readable on the page canvas while the note is open and after it saves', async () => {
    const page = app.window;
    const toolbar = page.getByTestId('annotation-selection-toolbar');
    const layer = '[data-testid="pdf-textlayer-p1"]';
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-note-open="true"]')).toHaveCount(0);

    // Bring the passage to the top of the reader so the box opens below it and
    // nothing but the mark lies over its glyphs.
    await page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.querySelector('[data-testid="pdf-textlayer-p1"]')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(needle);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const reader = document.querySelector('[data-reader-focus-target="true"]')!.getBoundingClientRect();
        document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]')!.scrollTop += range.getBoundingClientRect().top - (reader.top + 8);
        return;
      }
      throw new Error(`selection target not found: ${needle}`);
    }, PDF_READABLE);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await dragSelect(page, PDF_READABLE, layer);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    await expect.poll(() => marked(page)).toEqual([PDF_READABLE]);

    const open = await markedGlyphs(page);
    test.info().annotations.push({ type: 'pdf-glyphs-open', description: JSON.stringify(open) });
    expectReadableMark(open);
    // Alone on the page canvas, the mark keeps nearly all the glyph ink, black included.
    expect(open.on.ink, 'the marked passage keeps its legible ink').toBeGreaterThan(open.off.ink * 0.7);
    expect(open.on.black, 'the marked passage keeps its black glyphs').toBeGreaterThan(open.off.black * 0.7);

    await page.keyboard.type(TEN_LINES);
    await expect(page.getByTestId('selection-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    expect(await marked(page)).toEqual([PDF_READABLE]);
    await expectCaretAtEnd(page);
    // Once saved, the note's own tint lies under the mark too; the letters must still read.
    const saved = await markedGlyphs(page);
    test.info().annotations.push({ type: 'pdf-glyphs-saved', description: JSON.stringify(saved) });
    expectReadableMark(saved);
    expect(await marked(page)).toEqual([PDF_READABLE]);
    await expectCaretAtEnd(page);
  });
});

type Ink = { ink: number; black: number; contrast: number };

type GlyphProof = { passageBottom: number; panelTop: number; on: Ink; off: Ink; tint: number };

function luminance(r: number, g: number, b: number): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * How much of a crop is glyph ink. `ink` counts pixels with at least 3:1
 * contrast against the crop's own background (its 90th-percentile
 * luminance), so a tint that keeps the letters legible still counts them;
 * `black` counts only near-black pixels; `contrast` is the glyph cores' (5th
 * percentile) contrast ratio against that background.
 */
async function inkIn(png: Buffer): Promise<Ink> {
  const pixels = await sharp(png).removeAlpha().raw().toBuffer();
  const values: number[] = [];
  let black = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const [r, g, b] = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
    values.push(luminance(r, g, b));
    if (r < 80 && g < 80 && b < 80) black += 1;
  }
  const sorted = [...values].sort((x, y) => x - y);
  const background = sorted[Math.floor(values.length * 0.9)]!;
  const core = sorted[Math.floor(values.length * 0.05)]!;
  const ink = values.filter((value) => (background + 0.05) / (value + 0.05) >= 3).length;
  return { ink: ink / values.length, black: black / values.length, contrast: (background + 0.05) / (core + 0.05) };
}

/**
 * Photographs the marked passage with the mark and again with only its
 * registry entry removed, so the paint is all that differs. The crop is the
 * text layer's own geometry, inset to stay off neighbouring lines.
 */
async function markedGlyphs(page: Page): Promise<GlyphProof> {
  const facts = await page.evaluate((mark) => {
    const range = [...CSS.highlights.get(mark)!][0] as Range;
    const passage = range.getBoundingClientRect();
    const panel = document.querySelector('[data-testid="annotation-selection-toolbar"]')!.getBoundingClientRect();
    return { left: passage.left, top: passage.top, width: passage.width, height: passage.height, passageBottom: passage.bottom, panelTop: panel.top };
  }, MARK);
  expect(facts.passageBottom, 'the box opens below the passage').toBeLessThan(facts.panelTop);
  const inset = 2;
  const clip = { x: facts.left + inset, y: facts.top + inset, width: facts.width - inset * 2, height: facts.height - inset * 2 };
  const on = await page.screenshot({ clip });
  const highlight = await page.evaluateHandle((mark) => CSS.highlights.get(mark)!, MARK);
  await page.evaluate((mark) => CSS.highlights.delete(mark), MARK);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const off = await page.screenshot({ clip });
  await page.evaluate(([mark, held]) => { CSS.highlights.set(mark, held); }, [MARK, highlight] as const);
  await highlight.dispose();
  const [a, b] = await Promise.all([sharp(on).removeAlpha().raw().toBuffer(), sharp(off).removeAlpha().raw().toBuffer()]);
  let delta = 0;
  for (let index = 0; index < a.length; index += 1) delta += Math.abs(a[index]! - b[index]!);
  return { passageBottom: facts.passageBottom, panelTop: facts.panelTop, on: await inkIn(on), off: await inkIn(off), tint: delta / a.length };
}

/** The mark visibly tints the passage, and its glyphs keep large-text contrast against the tint. */
function expectReadableMark(proof: GlyphProof): void {
  expect(proof.off.ink, 'the unmarked crop holds glyphs').toBeGreaterThan(0.05);
  expect(proof.tint, 'the mark visibly tints the passage').toBeGreaterThan(5);
  expect(proof.on.ink, 'the marked passage shows glyph ink').toBeGreaterThan(0.05);
  expect(proof.on.contrast, 'the marked glyphs keep at least 3:1 contrast').toBeGreaterThanOrEqual(3);
}

const EPUB_POINTER = 'Processes provide memory isolation';
const EPUB_KEYBOARD = 'Threads share one address space';
const EPUB_LATER = 'Scheduling decides which thread runs';

/** The marks registered in the book iframe's own document. */
async function iframeMarked(frame: FrameLocator): Promise<string[]> {
  return frame.locator('body').evaluate((_body, mark) => [...(CSS.highlights.get(mark) ?? [])].map((range) => (range as Range).toString()), MARK);
}

/**
 * Selects a phrase inside the book iframe. A real mouse drag over the
 * sandboxed, script-free frame stalls Playwright, so this sets the frame's own
 * selection the way the EPUB reader spec does; Add note is still a real click
 * or key press in the app.
 */
async function selectInFrame(frame: FrameLocator, needle: string): Promise<void> {
  await frame.locator('body').evaluate((body, n) => {
    const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const start = (node.textContent ?? '').indexOf(n);
      if (start < 0) continue;
      const range = body.ownerDocument.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + n.length);
      const selection = body.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      body.ownerDocument.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`selection target not found: ${n}`);
  }, needle);
}

test.describe('Selection note paint in an EPUB', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-note-epub-'));
    const fixture = join(fixtureDir, 'Note Paint.epub');
    writeFileSync(fixture, makeEpubFixture({
      title: 'Note Paint Book',
      author: 'Interleaf Regression',
      chapters: [{
        title: 'Chapter 1: Processes',
        content: `<p>${EPUB_POINTER} across address spaces.</p><p>${EPUB_KEYBOARD} and its heap.</p><p>${EPUB_LATER} next.</p>`,
      }],
    }));
    app = await launchInterleaf();
    await stubOpenDialog(app, [fixture]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documentId = (await app.window.evaluate(() => window.interleafAPI.library.listDocuments()))[0]!.id;
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByText(EPUB_POINTER)).toBeVisible();
  });

  test.afterAll(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('pointer and keyboard Add note mark the passage in the book frame while typing, and a new selection clears it', async () => {
    const page = app.window;
    const frame = page.frameLocator('iframe[title="Ebook Content"]');
    const toolbar = page.getByTestId('annotation-selection-toolbar');

    await selectInFrame(frame, EPUB_POINTER);
    await expect(toolbar).toBeVisible();
    const collapsed = await origin(page);
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#selection-note')).toBeFocused();
    expectSameOrigin(await origin(page), collapsed);
    await expect.poll(() => iframeMarked(frame)).toEqual([EPUB_POINTER]);
    await page.keyboard.type('Typed over a book passage.');
    await expect(page.getByTestId('selection-note-save-status')).toHaveText('Saved', { timeout: 10_000 });
    expect(await iframeMarked(frame)).toEqual([EPUB_POINTER]);
    await expectCaretAtEnd(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => iframeMarked(frame)).toEqual([]);

    await selectInFrame(frame, EPUB_KEYBOARD);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#selection-note')).toBeFocused();
    await expect.poll(() => iframeMarked(frame)).toEqual([EPUB_KEYBOARD]);
    await page.keyboard.type('Keyboard note.');
    expect(await iframeMarked(frame)).toEqual([EPUB_KEYBOARD]);
    await expectCaretAtEnd(page);

    await selectInFrame(frame, EPUB_LATER);
    await expect.poll(() => iframeMarked(frame)).toEqual([]);
  });
});
