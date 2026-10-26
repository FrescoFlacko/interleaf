import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureWindowPng, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * Visual regression for the note annotation surface in a real BrowserWindow:
 *
 * - the popover shows only the saved note (the redundant quote of the noted
 *   text is gone, and the text itself is still right there in the document);
 * - the note paint is stronger than a plain selection yet still translucent,
 *   and it never sets a text color, so the noted words stay readable.
 *
 * Both claims are checked at normal zoom and at 200%, where the reader
 * reflows and the popover has to stay contained. Screenshots are written for
 * human review alongside the assertions.
 *
 * No AI provider is contacted: this exercises the reader only.
 */

const VISUAL_DIR = process.env.INTERLEAF_VISUAL_DIR ?? path.join(process.cwd(), 'agent', 'visual');
const PHRASE = 'decouples layout extraction';
const NOTE_BODY = 'Note paint evidence: the popover shows only this body, never the quoted text.';

type PaintProbe = {
  readonly registered: boolean;
  readonly noteToken: string;
  readonly selectionToken: string;
  readonly ruleBody: string;
  readonly textColor: string;
  readonly textRects: number;
  readonly textWidth: number;
};

/**
 * Alpha channel of a color, opaque when the notation carries none. Both
 * notations are accepted because the bundler rewrites authored `rgba()` tokens
 * to `#rrggbbaa` while computed element colors stay functional.
 */
function alphaOf(value: string, label: string): number {
  const trimmed = value.trim();
  const functional = /rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:\s*[,/]\s*([\d.]+))?\s*\)/u.exec(trimmed);
  if (functional !== null) {
    return functional[1] === undefined ? 1 : Number.parseFloat(functional[1]);
  }
  const hex = /^#(?:[\da-f]{3}([\da-f])?|[\da-f]{6}([\da-f]{2})?)$/iu.exec(trimmed);
  expect(hex, `${label} should be an rgb()/rgba()/hex color, got "${value}"`).not.toBeNull();
  const short = hex?.[1];
  const long = hex?.[2];
  if (short !== undefined) return Number.parseInt(short.repeat(2), 16) / 255;
  if (long !== undefined) return Number.parseInt(long, 16) / 255;
  return 1;
}

/** Center of the noted phrase in top-window CSS pixels. */
async function phrasePoint(page: Page, needle: string): Promise<{ x: number; y: number }> {
  return page.evaluate((n) => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-block]'));
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        const index = text.indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        if (range.getBoundingClientRect().width <= 0) continue;
        // At 200% the reader reflows and the phrase can sit below the fold;
        // the click has to land on the painted range, so bring it into view.
        node.parentElement?.scrollIntoView({ block: 'center' });
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    throw new Error(`phrase not found in visible reader content: ${n}`);
  }, needle);
}

/** Selects the phrase through the reader's own selection pathway. */
async function selectPhrase(page: Page, needle: string): Promise<void> {
  await page.evaluate((n) => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-block]'));
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        const index = text.indexOf(n);
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

/** Reads the live paint tokens, the injected note rule, and the noted text. */
async function probePaint(page: Page, needle: string): Promise<PaintProbe> {
  return page.evaluate((n) => {
    const surface = document.querySelector<HTMLElement>('.reader-surface');
    if (surface === null) throw new Error('reader surface missing');
    const styleText = document.getElementById('interleaf-annotation-highlight-styles')?.textContent ?? '';
    const ruleBody = /::highlight\(interleaf-note\)\s*\{([^}]*)\}/u.exec(styleText)?.[1] ?? '';
    const registry = CSS.highlights;

    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-block]'));
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        const index = text.indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const rects = range.getClientRects();
        const parent = node.parentElement;
        if (parent === null) continue;
        const surfaceStyles = getComputedStyle(surface);
        return {
          registered: registry.has('interleaf-note'),
          noteToken: surfaceStyles.getPropertyValue('--note-translucent').trim(),
          // The selection token is compared at its palette scope: the reader
          // surface re-declares it through a self-referential fallback, which
          // is a pre-existing cycle and resolves to nothing.
          selectionToken: getComputedStyle(document.documentElement)
            .getPropertyValue('--selection-translucent')
            .trim(),
          ruleBody,
          textColor: getComputedStyle(parent).color,
          textRects: rects.length,
          textWidth: rects[0]?.width ?? 0,
        };
      }
    }
    throw new Error(`noted text not found: ${n}`);
  }, needle);
}

async function importAndNote(app: AppHandle, fixturePath: string): Promise<void> {
  await stubOpenDialog(app, [fixturePath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
  await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();

  await selectPhrase(app.window, PHRASE);
  const toolbar = app.window.getByTestId('annotation-selection-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: /note/i }).click();
  await app.window.locator('#selection-note').fill(NOTE_BODY);
  await toolbar.getByRole('button', { name: /^Done/u }).click();
  await expect(toolbar).toBeHidden();

  // Exactly one live focus proxy is the authoritative post-save paint symptom.
  await expect(app.window.locator('[data-testid^="note-focus-proxy-"]')).toHaveCount(1, { timeout: 15_000 });

  // A lingering selection would keep its own paint over the note.
  await app.window.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });

  // Saving a note also opens the companion Annotations drawer. In the compact
  // layout used at 200% that drawer carries a full-screen backdrop which would
  // swallow the reader click, so close it through its real keyboard control.
  const closeDrawer = app.window
    .getByTestId('compact-drawer-right')
    .getByRole('button', { name: 'Close drawer' });
  if ((await closeDrawer.count()) > 0) {
    await closeDrawer.focus();
    await app.window.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const backdrop = app.window.getByTestId('compact-backdrop');
        if ((await backdrop.count()) === 0) return true;
        // Inert *and* faded out, so the screenshot shows the real reader colors.
        return backdrop.evaluate(
          (element) =>
            element.classList.contains('pointer-events-none') &&
            Number.parseFloat(getComputedStyle(element).opacity) === 0
        );
      }, { timeout: 5_000 })
      .toBe(true);
  }
}

/** Opens the note popover by clicking the painted range and asserts its content. */
async function openPopover(app: AppHandle): Promise<void> {
  const point = await phrasePoint(app.window, PHRASE);
  await app.window.mouse.click(point.x, point.y);
  const popover = app.window.getByTestId('note-popover');
  await expect(popover).toBeVisible();

  // The saved note is the whole panel: no echoed quote of the noted text.
  await expect(popover.getByTestId('note-popover-body')).toHaveText(NOTE_BODY);
  await expect(popover.getByTestId('note-popover-quote')).toHaveCount(0);
  const popoverText = (await popover.textContent()) ?? '';
  expect(popoverText).not.toContain(PHRASE);
  expect(popoverText).not.toContain('“');

  await assertNoReservedHeaderRow(popover);
}

/**
 * The note starts at the panel's own padding, not one blank row below it.
 *
 * The close control used to sit in a header row of its own, which reserved a
 * band of empty space above every note for a single small button. It is now
 * out of flow in the corner, and the panel buys the room it needs sideways, so
 * this measures the real laid-out box in a real BrowserWindow: the first line
 * of the note must begin at the top padding, nothing may occupy the band above
 * it, and the close control must not sit on top of the text.
 */
async function assertNoReservedHeaderRow(popover: Locator): Promise<void> {
  const geometry = await popover.evaluate((panel) => {
    const body = panel.querySelector('[data-testid="note-popover-body"]');
    const close = panel.querySelector('[data-testid="note-popover-close"]');
    if (!(body instanceof HTMLElement) || !(close instanceof HTMLElement)) return null;
    const panelBox = panel.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    const borderTop = Number.parseFloat(panelStyle.borderTopWidth);
    return {
      paddingTop: Number.parseFloat(panelStyle.paddingTop),
      topGap: bodyBox.top - panelBox.top - borderTop,
      inFlowChildren: Array.from(panel.children).filter(
        (child) => getComputedStyle(child).position === 'static'
      ).length,
      overlapsBody:
        closeBox.left < bodyBox.right &&
        closeBox.right > bodyBox.left &&
        closeBox.top < bodyBox.bottom &&
        closeBox.bottom > bodyBox.top,
    };
  });

  expect(geometry, 'the popover must expose its body and close control').not.toBeNull();
  // A reserved header row would push this gap well past the panel's padding.
  expect(geometry!.topGap).toBeLessThanOrEqual(geometry!.paddingTop + 1);
  // The note body is the panel's only in-flow content: no header row exists.
  expect(geometry!.inFlowChildren).toBe(1);
  expect(geometry!.overlapsBody, 'the close control must not sit over the note').toBe(false);
}

/** Asserts the note paint is strong, still translucent, and text-color free. */
async function assertNotePaint(app: AppHandle): Promise<void> {
  const probe = await probePaint(app.window, PHRASE);
  expect(probe.registered, 'the note range must be painted through CSS.highlights').toBe(true);

  const noteAlpha = alphaOf(probe.noteToken, '--note-translucent');
  const selectionAlpha = alphaOf(probe.selectionToken, '--selection-translucent');
  expect(noteAlpha, 'note paint must be stronger than a transient selection').toBeGreaterThan(selectionAlpha);
  expect(noteAlpha, 'note paint must stay translucent').toBeLessThan(1);

  expect(probe.ruleBody).toContain('var(--note-translucent');
  expect(/(^|[;{\s])color\s*:/u.test(probe.ruleBody), 'note paint must not set a text color').toBe(false);

  // The noted words themselves are still laid out and still have a visible color.
  expect(probe.textRects).toBeGreaterThan(0);
  expect(probe.textWidth).toBeGreaterThan(0);
  expect(alphaOf(probe.textColor, 'noted text color')).toBeGreaterThan(0);
}

test.describe('note paint and popover visual regression', () => {
  test.setTimeout(120_000);
  let app: AppHandle | null = null;
  let fixtureDir = '';

  test.beforeAll(() => {
    mkdirSync(VISUAL_DIR, { recursive: true });
  });

  test.beforeEach(() => {
    fixtureDir = path.join(tmpdir(), `interleaf-note-visual-${String(Date.now())}`);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      path.join(fixtureDir, 'Note Paint Fixture.md'),
      makeMarkdownFixture({
        title: 'Note Paint Fixture',
        author: 'Interleaf Visual Evidence',
        body: [
          '# Note Paint Fixture',
          '',
          `The reader engine ${PHRASE} from annotation persistence so notes remain stable.`,
          '',
          'Overview paragraph provides neutral surrounding text for contrast.',
          '',
        ].join('\n'),
      })
    );
  });

  test.afterEach(async () => {
    if (app !== null) {
      const { userDataDir } = app;
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      app = null;
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('normal zoom: note body without quote, translucent paint, readable text', async () => {
    app = await launchInterleaf();
    await importAndNote(app, path.join(fixtureDir, 'Note Paint Fixture.md'));
    await assertNotePaint(app);
    await openPopover(app);

    const bytes = await captureWindowPng(app, path.join(VISUAL_DIR, 'note-paint-popover-100.png'));
    expect(bytes).toBeGreaterThan(2048);
  });

  test('200% zoom: note body without quote, translucent paint, readable text', async () => {
    app = await launchInterleaf();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect.poll(async () => app?.window.evaluate(() => window.innerWidth)).toBeLessThan(920);

    await importAndNote(app, path.join(fixtureDir, 'Note Paint Fixture.md'));
    await assertNotePaint(app);
    await openPopover(app);

    // Contained in the zoomed viewport: an overflowing popover is a visual defect.
    const box = await app.window.getByTestId('note-popover').boundingBox();
    expect(box).not.toBeNull();
    const viewport = await app.window.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.h + 1);

    const bytes = await captureWindowPng(app, path.join(VISUAL_DIR, 'note-paint-popover-200.png'));
    expect(bytes).toBeGreaterThan(2048);
  });
});
