import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { HIGHLIGHT_COLOR_OPTIONS } from '../../src/shared/constants/annotations';
import { choosePalette } from './listbox';

/** WCAG 1.4.11 non-text contrast: a boundary that carries meaning needs 3:1. */
const BOUNDARY_CONTRAST_MIN = 3;

/** `#facc15` as Chromium reports a resolved `background-color`. */
function hexToRgbString(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 0xff)}, ${String((value >> 8) & 0xff)}, ${String(value & 0xff)})`;
}

/** What a selection attempt found on page 1's current text layer. */
type LayerSelection = { readonly selected: string; readonly layer: number } | { readonly notReady: string };

/** A phrase selected on one text layer generation, to check again before acting on it. */
type PhraseSelection = { readonly phrase: string; readonly layer: number };

/**
 * Runs in the renderer. Page 1's text layer is replaced on every re-render,
 * and the retired one is emptied, so a layer handle taken earlier can be stale
 * by the time it is used. This waits until the current layer is committed —
 * in its page, no zoom preview, its canvas at its committed size, the same for
 * two frames — and then finds the phrase and selects it in the same
 * synchronous step, through the reader's own `selectionchange` pathway.
 */
async function selectInCurrentLayer(needle: string): Promise<LayerSelection> {
  const store = window as Window & { __opacityLayerIds?: WeakMap<Element, number>; __opacityLayerSerial?: number };
  const idOf = (layer: Element): number => {
    const ids = (store.__opacityLayerIds ??= new WeakMap<Element, number>());
    const known = ids.get(layer);
    if (known !== undefined) return known;
    store.__opacityLayerSerial = (store.__opacityLayerSerial ?? 0) + 1;
    ids.set(layer, store.__opacityLayerSerial);
    return store.__opacityLayerSerial;
  };
  const checks: readonly ((layer: HTMLElement, canvas: HTMLCanvasElement) => boolean)[] = [
    (layer, canvas) => layer.isConnected && canvas.parentElement === layer.parentElement,
    (layer, canvas) => layer.style.getPropertyValue('--preview-scale') === '' && canvas.style.transform === '',
    (_layer, canvas) => canvas.style.width === canvas.parentElement?.style.width,
    (_layer, canvas) => Math.abs(canvas.width - Number.parseFloat(canvas.style.width) * window.devicePixelRatio) <= 1,
  ];
  type Committed = { readonly layer: HTMLElement; readonly signature: string };
  const committed = (): Committed | null => {
    const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas-p1"]');
    if (layer === null || canvas === null) return null;
    return checks.every((check) => check(layer, canvas)) ? { layer, signature: `${String(idOf(layer))}:${String(canvas.width)}x${String(canvas.height)}` } : null;
  };
  const textContaining = (layer: HTMLElement): Text | undefined => {
    const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes.find((node) => node.textContent.includes(needle));
  };
  const frame = (): Promise<number> => new Promise((resolve) => { requestAnimationFrame(resolve); });
  const signatureNow = (): string | undefined => committed()?.signature;
  const first = signatureNow();
  await frame();
  const second = signatureNow();
  await frame();
  // From here on, nothing else runs in the renderer until this returns.
  const current = committed();
  const stable = (candidate: Committed | null): candidate is Committed => candidate !== null && candidate.signature === first && first === second;
  if (!stable(current)) return { notReady: `page 1 text layer not committed and stable over two frames (${String(first)} / ${String(second)})` };
  const target = textContaining(current.layer);
  if (!target) return { notReady: `current page 1 text layer lacks the phrase: ${current.layer.textContent.slice(0, 160)}` };
  const start = target.textContent.indexOf(needle);
  const range = current.layer.ownerDocument.createRange();
  range.setStart(target, start);
  range.setEnd(target, start + needle.length);
  const selection = current.layer.ownerDocument.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  current.layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
  return { selected: selection.toString(), layer: idOf(current.layer) };
}

/**
 * Selects a phrase in the PDF text layer through the reader's own pathway, on
 * the current committed layer (see `selectInCurrentLayer`), retrying only
 * while that layer is not ready, within the expect deadline. The native
 * selection must be exactly the phrase.
 */
async function selectPhraseInTextLayer(page: Page, phrase: string): Promise<PhraseSelection> {
  const last: { outcome: LayerSelection } = { outcome: { notReady: 'not attempted' } };
  await expect.poll(async () => {
    last.outcome = await page.evaluate(selectInCurrentLayer, phrase);
    return 'selected' in last.outcome ? last.outcome.selected : last.outcome.notReady;
  }).toBe(phrase);
  return { phrase, layer: 'layer' in last.outcome ? last.outcome.layer : -1 };
}

/**
 * Runs in the renderer: the native selection and the identity of page 1's
 * current text layer, as `selectInCurrentLayer` numbered it.
 */
function currentSelection(): { readonly selected: string; readonly layer: number } {
  const store = window as Window & { __opacityLayerIds?: WeakMap<Element, number> };
  const layer = document.querySelector('[data-testid="pdf-textlayer-p1"]');
  return { selected: document.getSelection()?.toString() ?? '', layer: layer === null ? -1 : store.__opacityLayerIds?.get(layer) ?? -1 };
}

/** Before acting on a selection: still exactly that phrase, on the layer it was made on. */
async function expectSelectionKept(page: Page, selection: PhraseSelection): Promise<void> {
  expect(await page.evaluate(currentSelection), 'page 1 re-rendered or the selection changed before the highlight action').toEqual({ selected: selection.phrase, layer: selection.layer });
}

type PaintedSwatch = {
  readonly backgroundColor: string;
  readonly borderWidth: number;
  readonly borderColor: string;
  readonly boxShadow: string;
  readonly forcedColorAdjust: string;
  readonly width: number;
  readonly height: number;
};

/** `rgb()`/`rgba()` channels as Chromium reports them; alpha defaults to opaque. */
function parseColorChannels(color: string): readonly [number, number, number, number] {
  const parts = /rgba?\(([^)]+)\)/.exec(color)![1]!.split(',').map((part) => Number.parseFloat(part));
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/** WCAG relative luminance of already-composited sRGB channels. */
function relativeLuminance(channels: readonly number[]): number {
  const [r, g, b] = channels.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * WCAG contrast ratio of `over` once it is composited onto the opaque `under`.
 * A translucent boundary only separates the swatch from the toolbar as strongly
 * as its blended result, so the blend has to happen before the ratio.
 */
function contrastRatioOver(over: string, under: string): number {
  const [red, green, blue, alpha] = parseColorChannels(over);
  const base = parseColorChannels(under);
  const blended = [red, green, blue].map((channel, index) => channel * alpha + base[index]! * (1 - alpha));
  const [first, second] = [relativeLuminance(blended), relativeLuminance([...base].slice(0, 3))];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** The swatch's real painted values, which only a browser can answer. */
function readPaintedSwatch(swatch: HTMLElement): PaintedSwatch {
  const style = getComputedStyle(swatch);
  const box = swatch.getBoundingClientRect();
  return {
    backgroundColor: style.backgroundColor,
    borderWidth: Number.parseFloat(style.borderTopWidth),
    borderColor: style.borderTopColor,
    boxShadow: style.boxShadow,
    forcedColorAdjust: style.forcedColorAdjust,
    width: box.width,
    height: box.height,
  };
}

test.describe('Defect 08: Highlight selection and color opacity', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-highlight-opacity-'));
    samplePdfPath = join(fixtureDir, 'Highlight_Opacity_Fixture.pdf');

    // Clean ASCII-only lines without blank line gaps to ensure 1:1 pixel alignment
    // between PDF canvas rendering and PDF.js text-layer span geometry.
    const pageLines = [
      'Architecture and Design Principles for Local First Software',
      'Text selection preview must remain explicitly translucent and readable.',
      'All six reading palettes provide accessible high contrast reading themes.',
      'Persisted annotations use consistent highlight colors across all formats.',
      'Reading progress and annotations persist reliably across application restarts.',
    ];

    writeFileSync(
      samplePdfPath,
      makePdfFixture({
        title: 'Highlight Opacity Fixture',
        author: 'Interleaf Architecture',
        pageLines: [pageLines],
      })
    );

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('ensures text selection is visibly translucent and readable across palettes, persists highlights, and maintains 200% zoom containment', async () => {
    // 1. Import and open the fixture
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [openedDocument] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(openedDocument?.title).toBe('Highlight Opacity Fixture');

    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

    // 2. Select "Architecture and Design Principles" on Line 1.
    const targetPhrase = 'Architecture and Design Principles';
    const firstSelection = await selectPhraseInTextLayer(app.window, targetPhrase);
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // Assert that --selection-translucent is defined and translucent
    const translucentToken = await app.window.evaluate(() => {
      return window.getComputedStyle(document.documentElement).getPropertyValue('--selection-translucent').trim();
    });
    const alpha = parseAlpha(translucentToken);
    expect(alpha, 'selection alpha must be translucent (< 0.7)').toBeLessThan(0.7);
    expect(alpha, 'selection alpha must be visible (> 0.2)').toBeGreaterThan(0.2);

    // Assert selection range geometry aligns directly over canvas text
    const selectionRangeRect = await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer) => {
      const sel = layer.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    });
    expect(selectionRangeRect, 'Selection range must exist').not.toBeNull();
    expect(selectionRangeRect!.width, 'Selection range width must be > 0').toBeGreaterThan(50);
    expect(selectionRangeRect!.height, 'Selection range height must be > 0').toBeGreaterThan(8);

    // Assert text layer text content remains readable in DOM
    const textLayerText = await app.window.getByTestId('pdf-textlayer-p1').innerText();
    expect(textLayerText).toContain('Architecture and Design Principles');

    // Assert all 5 highlight buttons exist on toolbar and are contained
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Yellow highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Blue highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Green highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Pink highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Purple highlight' })).toBeVisible();

    // 4. Create and persist highlights
    // Apply Pink highlight to first selection ("Architecture and Design Principles")
    await expectSelectionKept(app.window, firstSelection);
    await toolbar.getByRole('button', { name: 'Pink highlight' }).click();

    // Verify pink highlight registered in CSS Highlight API and SQLite
    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, openedDocument!.id)).toBe(1);

    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-pink') ?? false;
    })).toBe(true);

    // Select second passage for Yellow highlight: "Text selection preview must remain" on Line 2
    const secondSelection = await selectPhraseInTextLayer(app.window, 'Text selection preview must remain');

    await expect(toolbar).toBeVisible();
    await expectSelectionKept(app.window, secondSelection);
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();

    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, openedDocument!.id)).toBe(2);

    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-yellow') ?? false;
    })).toBe(true);

    // 5. Test Palette Switching across all 6 reading palettes
    const paletteIds = ['sepia', 'moss', 'ocean', 'graphite', 'midnight', 'paper'] as const;
    for (const paletteId of paletteIds) {
      await choosePalette(app.window, paletteId);
      await app.window.getByTestId('theme-menu-trigger').click();
      await expect(app.window.getByTestId(`palette-option-${paletteId}`)).toHaveAttribute('aria-checked', 'true');
      await app.window.keyboard.press('Escape');

      const currentTheme = await app.window.evaluate(() => document.documentElement.dataset.theme);
      expect(currentTheme).toBe(paletteId);

      const paletteTranslucentToken = await app.window.evaluate(() =>
        window.getComputedStyle(document.documentElement).getPropertyValue('--selection-translucent').trim()
      );
      const paletteAlpha = parseAlpha(paletteTranslucentToken);
      expect(paletteAlpha, `${paletteId} selection alpha must be translucent (< 0.7)`).toBeLessThan(0.7);
      expect(paletteAlpha, `${paletteId} selection alpha must be visible (> 0.2)`).toBeGreaterThan(0.2);
    }

    // 6. Constrained 200% zoom factor in a 960x608 BrowserWindow
    // Select the phrase "All six reading palettes" on Line 3.
    // Above it are the persisted Pink highlight (Line 1) and Yellow highlight (Line 2).
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 608);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 608 });
    await app.window.waitForTimeout(400);

    const zoomTarget = 'All six reading palettes';
    await selectPhraseInTextLayer(app.window, zoomTarget);

    await expect(toolbar).toBeVisible();
    await app.window.waitForTimeout(300);

    // Assert strict 4-sided bounding box containment for toolbar within viewport
    const viewport = await app.window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    const toolbarRect = await toolbar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    });

    expect(toolbarRect.left, 'Toolbar left must be >= 0').toBeGreaterThanOrEqual(0);
    expect(toolbarRect.top, 'Toolbar top must be >= 0').toBeGreaterThanOrEqual(0);
    expect(toolbarRect.right, `Toolbar right (${String(toolbarRect.right)}) must be <= viewport width (${String(viewport.width)})`).toBeLessThanOrEqual(viewport.width);
    expect(toolbarRect.bottom, `Toolbar bottom (${String(toolbarRect.bottom)}) must be <= viewport height (${String(viewport.height)})`).toBeLessThanOrEqual(viewport.height);

    // Assert every action button within toolbar is fully within viewport and toolbar bounds
    const buttonRects = await toolbar.evaluate((el) => {
      const buttons = Array.from(el.querySelectorAll('button'));
      return buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          name: b.getAttribute('aria-label') ?? b.getAttribute('title') ?? (b.innerText.length > 0 ? b.innerText : 'button'),
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      });
    });

    expect(buttonRects.length, 'Must have all toolbar buttons').toBeGreaterThanOrEqual(10);
    for (const btn of buttonRects) {
      expect(btn.left, `Button "${btn.name}" left must be >= 0`).toBeGreaterThanOrEqual(0);
      expect(btn.top, `Button "${btn.name}" top must be >= 0`).toBeGreaterThanOrEqual(0);
      expect(btn.right, `Button "${btn.name}" right (${String(btn.right)}) must be <= viewport width (${String(viewport.width)})`).toBeLessThanOrEqual(viewport.width);
      expect(btn.bottom, `Button "${btn.name}" bottom (${String(btn.bottom)}) must be <= viewport height (${String(viewport.height)})`).toBeLessThanOrEqual(viewport.height);
      expect(btn.width, `Button "${btn.name}" width must be > 0`).toBeGreaterThan(0);
      expect(btn.height, `Button "${btn.name}" height must be > 0`).toBeGreaterThan(0);
    }

    // Assert selected text range is actually in the visible viewport
    const zoomSelectionRect = await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer) => {
      const sel = layer.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    });
    expect(zoomSelectionRect, 'Zoom selection range must be present').not.toBeNull();
    expect(zoomSelectionRect!.top, 'Zoom selection range top must be in viewport').toBeGreaterThanOrEqual(0);
    expect(zoomSelectionRect!.bottom, 'Zoom selection range bottom must be in viewport').toBeLessThanOrEqual(viewport.height);
    expect(zoomSelectionRect!.left, 'Zoom selection range left must be in viewport').toBeGreaterThanOrEqual(0);
    expect(zoomSelectionRect!.right, 'Zoom selection range right must be in viewport').toBeLessThanOrEqual(viewport.width);

    // Assert body and header have no horizontal overflow
    const overflow = await app.window.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      headerScrollWidth: document.querySelector<HTMLElement>('[data-testid="app-header"]')?.scrollWidth ?? 0,
      headerClientWidth: document.querySelector<HTMLElement>('[data-testid="app-header"]')?.clientWidth ?? 0,
    }));
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.bodyClientWidth);
    expect(overflow.headerScrollWidth).toBeLessThanOrEqual(overflow.headerClientWidth);

    // Reset zoom before relaunch
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.setZoomFactor(1.0);
        win.setSize(1280, 800);
      }
    });

    // 7. Restart and persistence verification across reload
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });

    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

    // Verify highlights are still registered in CSS Highlight API
    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return (highlights?.has('interleaf-pink') ?? false) && (highlights?.has('interleaf-yellow') ?? false);
    })).toBe(true);

    // Open Annotations tab in Companion Drawer
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    // Each restored row names its colour through its actions rather than in a
    // line of body text: the row's menu names the colour it belongs to, and the
    // row's colour control for that colour is the pressed one.
    const annotationRows = app.window.getByTestId('annotation-row');
    await expect(annotationRows).toHaveCount(2);
    for (const colorName of ['pink', 'yellow']) {
      const label = `${colorName[0]!.toUpperCase()}${colorName.slice(1)}`;
      const row = annotationRows.filter({
        has: app.window.getByRole('button', { name: `More actions for ${colorName} highlight at Page 1` }),
      });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('button', { name: `${label} highlight for Page 1` }))
        .toHaveAttribute('aria-pressed', 'true');
    }
  });

  /**
   * The five direct highlight actions used to render as white circles with the
   * letters Y/B/G/P/V, because their per-color utility class was interpolated at
   * runtime and never reached the production stylesheet. Only a real browser can
   * settle whether the replacement paints: jsdom has no cascade, so every claim
   * below — the fill, the boundary, the focus ring, the forced-colors fallback
   * and the containment of the color name — is measured from computed style and
   * real layout here.
   */
  test('paints real swatch colors, names the focused color, and keeps both contained at 200%', async () => {
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [openedDocument] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

    await selectPhraseInTextLayer(app.window, 'Architecture and Design Principles');
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // The boundary exists to separate a swatch from the surface behind it, so
    // the toolbar's own painted background is the reference for the ratio below.
    const surface = await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(parseColorChannels(surface)[3], 'toolbar surface must be opaque').toBe(1);

    // 1. Every action paints its own shared color, keeps its name, keeps a
    //    28x28 target, and says nothing with a letter.
    for (const option of HIGHLIGHT_COLOR_OPTIONS) {
      const button = toolbar.getByRole('button', { name: `${option.label} highlight` });
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('title', `${option.label} highlight`);
      // The toolbar applies a color immediately; it is not a selection control.
      await expect(button).not.toHaveAttribute('aria-pressed', /.*/);
      expect(await button.innerText(), `${option.label} button must show no initial`).toBe('');

      const target = (await button.boundingBox())!;
      expect(Math.round(target.width), `${option.label} target width`).toBe(28);
      expect(Math.round(target.height), `${option.label} target height`).toBe(28);

      const swatch = button.getByTestId(`highlight-color-swatch-${option.id}`);
      await expect(swatch).toHaveAttribute('aria-hidden', 'true');
      const painted = await swatch.evaluate(readPaintedSwatch);
      expect(painted.backgroundColor, `${option.label} fill`).toBe(hexToRgbString(option.hexValue));
      expect(painted.borderWidth, `${option.label} boundary width`).toBeGreaterThanOrEqual(1);
      expect(
        contrastRatioOver(painted.borderColor, surface),
        `${option.label} boundary must reach ${String(BOUNDARY_CONTRAST_MIN)}:1 against the toolbar surface`
      ).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST_MIN);
      expect(painted.boxShadow, `${option.label} inner boundary`).toContain('inset');
      expect(painted.width, `${option.label} swatch width`).toBeGreaterThanOrEqual(16);
      expect(painted.height, `${option.label} swatch height`).toBeGreaterThanOrEqual(16);
    }

    // 2. Pointing at a swatch names it in visible text.
    const colorName = toolbar.getByTestId('highlight-color-name');
    await expect(colorName).toHaveText('');
    await toolbar.getByRole('button', { name: 'Green highlight' }).hover();
    await expect(colorName).toHaveText('Green');

    // 3. Keyboard focus names it too, and is visibly indicated. Focus arrives by
    //    Tab, which is the toolbar's current keyboard model; the separately
    //    scoped arrow-key/roving-tabindex gap is not exercised here.
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).focus();
    await app.window.keyboard.press('Tab');
    const focused = await app.window.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const style = getComputedStyle(element);
      return {
        testId: String(element.dataset.testid),
        focusVisible: element.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineColor: style.outlineColor,
      };
    });
    expect(focused.testId).toBe('highlight-color-button-blue');
    expect(focused.focusVisible, 'a keyboard-focused swatch must show focus').toBe(true);
    expect(focused.outlineStyle).toBe('solid');
    expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(focused.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
    await app.window.mouse.move(0, 0);
    await expect(colorName).toHaveText('Blue');
    await expect(colorName).toBeVisible();

    // 4. Forced colors: the fill is kept deliberately and the boundary moves to
    //    a system color, so five swatches never collapse into five identical
    //    system-surface circles.
    await app.window.emulateMedia({ forcedColors: 'active' });
    const forced = await toolbar
      .getByTestId('highlight-color-swatch-yellow')
      .evaluate(readPaintedSwatch);
    expect(forced.forcedColorAdjust).toBe('none');
    expect(forced.backgroundColor).toBe(hexToRgbString(HIGHLIGHT_COLOR_OPTIONS[0]!.hexValue));
    expect(forced.borderWidth).toBeGreaterThanOrEqual(1);
    expect(forced.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    await expect(colorName).toHaveText('Blue');
    await app.window.emulateMedia({ forcedColors: 'none' });

    // 5. Constrained 200%: the toolbar, every swatch and the color name all stay
    //    inside the viewport, and the name stays inside the toolbar.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 608);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 608 });
    await app.window.waitForTimeout(400);

    const zoomedSelection = await selectPhraseInTextLayer(app.window, 'All six reading palettes');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).focus();
    await app.window.keyboard.press('Tab');
    await app.window.keyboard.press('Tab');
    await expect(colorName).toHaveText('Green');

    const layout = await toolbar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const rectOf = (node: Element): { left: number; top: number; right: number; bottom: number } => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        toolbar: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        name: rectOf(element.querySelector('[data-testid="highlight-color-name"]')!),
        swatches: [...element.querySelectorAll<HTMLElement>('[data-testid^="highlight-color-button-"]')].map(
          (node) => ({ id: node.dataset.testid ?? '', ...rectOf(node) })
        ),
      };
    });

    expect(layout.toolbar.left).toBeGreaterThanOrEqual(0);
    expect(layout.toolbar.top).toBeGreaterThanOrEqual(0);
    expect(layout.toolbar.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.toolbar.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(layout.swatches).toHaveLength(5);
    for (const swatch of [...layout.swatches, { id: 'color name', ...layout.name }]) {
      expect(swatch.left, `${swatch.id} left`).toBeGreaterThanOrEqual(layout.toolbar.left - 0.5);
      expect(swatch.top, `${swatch.id} top`).toBeGreaterThanOrEqual(layout.toolbar.top - 0.5);
      expect(swatch.right, `${swatch.id} right`).toBeLessThanOrEqual(layout.toolbar.right + 0.5);
      expect(swatch.bottom, `${swatch.id} bottom`).toBeLessThanOrEqual(layout.toolbar.bottom + 0.5);
      expect(swatch.right, `${swatch.id} inside viewport`).toBeLessThanOrEqual(layout.viewport.width);
      expect(swatch.bottom, `${swatch.id} inside viewport`).toBeLessThanOrEqual(layout.viewport.height);
    }

    // 6. The focused swatch still creates the color it paints. Enter first.
    const storedColors = async (): Promise<(string | null)[]> => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.map((item) => item.color);
    }, openedDocument!.id);

    await expectSelectionKept(app.window, zoomedSelection);
    await app.window.keyboard.press('Enter');
    await expect.poll(storedColors).toEqual(['green']);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.setZoomFactor(1.0);
        win.setSize(1280, 800);
      }
    });
    await app.window.setViewportSize({ width: 1280, height: 800 });
    await app.window.waitForTimeout(400);

    // 7. Space is the other native activation key for a button, and it has to
    //    produce the same payload as Enter: the color of the focused swatch.
    const resetSelection = await selectPhraseInTextLayer(app.window, 'Persisted annotations use consistent');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Pink highlight' }).focus();
    await expect(colorName).toHaveText('Pink');
    await expectSelectionKept(app.window, resetSelection);
    await app.window.keyboard.press('Space');
    await expect.poll(async () => (await storedColors()).sort((a, b) => String(a).localeCompare(String(b))))
      .toEqual(['green', 'pink']);
  });
});

function parseAlpha(colorStr: string): number {
  const trimmed = colorStr.trim();
  if (trimmed.startsWith('#') && trimmed.length === 9) {
    const hexAlpha = Number.parseInt(trimmed.slice(7, 9), 16);
    return hexAlpha / 255;
  }
  const rgbaMatch = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(trimmed);
  if (rgbaMatch?.[1]) {
    return Number.parseFloat(rgbaMatch[1]);
  }
  return 1;
}
