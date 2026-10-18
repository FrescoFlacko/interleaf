import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Comparison suite for the universal (PDF.js-native) PDF text selection: the
 * adapter builds each page's text layer with pdfjs-dist 6.2.108's official
 * `TextLayerBuilder`, with no app-owned pointer-to-glyph mapping.
 *
 * These specs use `page.mouse` rather than programmatically built Ranges,
 * because a synthetic Range bypasses exactly the native hit-testing path under
 * examination.
 *
 * Blank-space behaviour is *characterized*, not prescribed. On Chromium >= 148
 * upstream deliberately disables its legacy `selectionchange` sentinel
 * repositioning (`TextLayerBuilder` returns early from that branch), so the only
 * remaining blank-space mechanism is the `.selecting` / `.endOfContent` CSS.
 * Whatever the engine then does is the authoritative universal behaviour: this
 * suite asserts the invariants that must hold either way, classifies the
 * outcome.
 * Do not "fix" a recorded classification by reintroducing coordinate mapping.
 */
const PAGE_LINES = [
  'Alpha: the opening line of the pointer drag fixture.',
  'Bravo: the second line sits directly below the first.',
  'Charlie: the third line continues the sample block.',
  'Delta: the fourth line extends the selection target.',
  'Echo: the fifth line closes the fixture paragraph.',
] as const;

/** Character index the drag starts from inside line 1. */
const START_CHAR = 3;

const linesThrough = (lastLineIndex: number): readonly string[] => [
  PAGE_LINES[0].slice(START_CHAR),
  ...PAGE_LINES.slice(1, lastLineIndex + 1),
];

/** `Selection.toString()` form: the `<br>` between lines contributes a newline. */
const expectedThrough = (lastLineIndex: number): string => linesThrough(lastLineIndex).join('\n');

/** `root.textContent` form: `<br>` contributes nothing. */
const expectedThroughFlat = (lastLineIndex: number): string => linesThrough(lastLineIndex).join('');

/**
 * The outcomes a native (non-mapped) text layer can produce when the pointer is
 * dragged through blank page space. Both are legitimate engine behaviour; the
 * classifier labels which one this build actually exhibits.
 */
const BLANK_SPACE_BEHAVIOURS = [
  /** The endpoint follows the pointer's row, as if over the nearest glyph. */
  'tracks-nearest-glyph',
  /** The endpoint stops at an earlier glyph the pointer physically crossed. */
  'freezes-at-last-crossed-glyph',
  /** The endpoint resolves further into the run than the pointer's row. */
  'overshoots-past-pointer-row',
  /** The endpoint collapses onto a non-text container offset. */
  'collapses-to-container-offset',
  /** A text-node endpoint, but the resulting range selects nothing. */
  'collapses-to-empty-selection',
  /** A non-empty text-node endpoint that is not part of the dragged run. */
  'diverges-from-dragged-run',
] as const;
type BlankSpaceBehaviour = (typeof BLANK_SPACE_BEHAVIOURS)[number];

/**
 * Pressing in blank space is a separate question from dragging through it: the
 * press has to establish a selection *base*, with no existing range to extend.
 * The sentinel is `user-select: none` and the glyph spans are absolutely
 * positioned, so the engine has no line box to fall back onto.
 */
const BLANK_ANCHOR_BEHAVIOURS = [
  /** The base lands on the nearest glyph in the pressed row. */
  'anchors-at-nearest-glyph',
  /** The press sets no text base; the run starts at the first glyph crossed. */
  'anchors-at-first-crossed-glyph',
  /** The base lands on a non-text container offset. */
  'anchors-at-container-offset',
] as const;
type BlankAnchorBehaviour = (typeof BLANK_ANCHOR_BEHAVIOURS)[number];

type SelectionProbe = {
  readonly text: string;
  readonly endIsTextNode: boolean;
  readonly endContainerClass: string | null;
  readonly containedInPage: boolean;
  readonly selectingLayers: number;
};

/**
 * Classifies one blank-space probe, and — when the label claims a real text
 * endpoint — proves it.
 *
 * "Froze at the last crossed glyph" is a claim about a *live* endpoint that
 * simply stopped advancing, so it may only be recorded for a non-empty range
 * whose text is a genuine earlier point in the run the drag covered. An empty
 * range, a container offset, and text that is not part of that run are three
 * different observations; folding them into `freeze` would let the label
 * assert something the run never showed.
 *
 * @param expectedIfTracking what the run would be if the endpoint tracked the
 *   pointer's row.
 * @param fullRun the whole run the drag has covered so far; every honest
 *   text-node outcome is a prefix of it.
 */
function classifyBlankSpace(
  probe: SelectionProbe,
  expectedIfTracking: string,
  fullRun: string
): BlankSpaceBehaviour {
  const behaviour = ((): BlankSpaceBehaviour => {
    if (!probe.endIsTextNode) return 'collapses-to-container-offset';
    if (probe.text.length === 0) return 'collapses-to-empty-selection';
    if (probe.text === expectedIfTracking) return 'tracks-nearest-glyph';
    if (!fullRun.startsWith(probe.text)) return 'diverges-from-dragged-run';
    return probe.text.length < expectedIfTracking.length
      ? 'freezes-at-last-crossed-glyph'
      : 'overshoots-past-pointer-row';
  })();

  expect(BLANK_SPACE_BEHAVIOURS).toContain(behaviour);
  if (behaviour === 'tracks-nearest-glyph' || behaviour === 'freezes-at-last-crossed-glyph') {
    expect(probe.endIsTextNode).toBe(true);
    expect(probe.text.length).toBeGreaterThan(0);
    expect(fullRun.startsWith(probe.text)).toBe(true);
  }
  return behaviour;
}

test.describe('Universal PDF selection (official TextLayerBuilder)', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;
  let rotatedPdfPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-universal-selection-'));
    samplePdfPath = join(fixtureDir, 'Universal_Selection.pdf');
    writeFileSync(
      samplePdfPath,
      makePdfFixture({
        title: 'Universal Selection',
        author: 'Interleaf Team',
        // Short lines leave roughly a third of the page width blank to the right
        // of every line — the region the drag crosses.
        pageLines: [[...PAGE_LINES], ['Second page keeps virtualization realistic.']],
        pageStartPositions: [
          [72, 700],
          [72, 700],
        ],
        outline: [],
      })
    );
    rotatedPdfPath = join(fixtureDir, 'Universal_Selection_Rotated.pdf');
    writeFileSync(
      rotatedPdfPath,
      makePdfFixture({
        title: 'Universal Selection Rotated',
        author: 'Interleaf Team',
        pageLines: [
          ['Rotated page line one text.', 'Rotated page line two text.'],
          ['ABCD EFGH IJKL'],
        ],
        pageStartPositions: [
          [72, 700],
          [72, 700],
        ],
        pageRotations: [90, 0],
        rtlPages: [2],
        outline: [],
      })
    );
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function openFirstDocument(path: string, title: string): Promise<string> {
    await stubOpenDialog(app, [path]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const docs = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    const doc = docs.find((entry) => entry.title === title);
    expect(doc, `imported document "${title}"`).toBeDefined();
    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    return doc!.id;
  }

  const readSelection = async (): Promise<SelectionProbe> =>
    app.window.evaluate(() => {
      const selection = document.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const endContainer = range?.endContainer ?? null;
      const page = document.querySelector('[data-testid="pdf-page-1"]');
      return {
        text: selection?.toString() ?? '',
        endIsTextNode: endContainer?.nodeType === Node.TEXT_NODE,
        endContainerClass: endContainer instanceof Element ? endContainer.className : null,
        containedInPage:
          range !== null &&
          page !== null &&
          page.contains(range.startContainer) &&
          page.contains(range.endContainer),
        selectingLayers: document.querySelectorAll('.textLayer.selecting').length,
      };
    });

  test('characterizes native pointer selection across blank margins, line gaps and reverse drags', async () => {
    const docId = await openFirstDocument(samplePdfPath, 'Universal Selection');

    // The layer PDF.js built must carry its own sentinel, unselectable and last.
    const layerContract = await app.window.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      const end = layer?.querySelector<HTMLElement>('.endOfContent') ?? null;
      return {
        className: layer?.className ?? null,
        tabIndex: layer?.tabIndex ?? null,
        mainRotation: layer?.getAttribute('data-main-rotation') ?? null,
        hasSentinel: end !== null,
        sentinelIsLastChild: end !== null && layer?.lastElementChild === end,
        sentinelUserSelect: end ? getComputedStyle(end).userSelect : null,
        selectingClass: layer?.classList.contains('selecting') ?? null,
        // The layer must be sized, i.e. `setLayerDimensions()`'s round() got its
        // `--scale-round-*` units from the page container.
        layerWidth: layer ? getComputedStyle(layer).width : null,
      };
    });
    expect(layerContract.className).toBe('textLayer');
    expect(layerContract.tabIndex).toBe(0);
    expect(layerContract.mainRotation).toBe('0');
    expect(layerContract.hasSentinel).toBe(true);
    expect(layerContract.sentinelIsLastChild).toBe(true);
    expect(layerContract.sentinelUserSelect).toBe('none');
    expect(layerContract.selectingClass).toBe(false);
    expect(layerContract.layerWidth).not.toBe('auto');
    expect(Number.parseFloat(layerContract.layerWidth ?? '0')).toBeGreaterThan(100);

    const geometry = await app.window.evaluate((startChar) => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      if (!layer) return null;
      const spans = Array.from(layer.querySelectorAll<HTMLElement>('span')).filter(
        (span) => span.textContent.trim().length > 0
      );
      if (spans.length < 5) return null;
      const layerRect = layer.getBoundingClientRect();
      const firstText = spans[0]?.firstChild;
      if (firstText?.nodeType !== Node.TEXT_NODE) return null;
      const prefix = document.createRange();
      prefix.setStart(firstText, 0);
      prefix.setEnd(firstText, startChar);
      const prefixRect = prefix.getBoundingClientRect();
      const rects = spans.map((span) => span.getBoundingClientRect());
      const glyphRight = rects.reduce((max, rect) => Math.max(max, rect.right), 0);
      const glyphLeft = rects.reduce((min, rect) => Math.min(min, rect.left), Number.MAX_VALUE);
      return {
        // Every probe below indexes `rects` by line, so the fixture's one
        // `Tj` per line must map to exactly one span.
        spanCount: spans.length,
        startX: prefixRect.right,
        startY: prefixRect.top + prefixRect.height / 2,
        // Well right of the longest line but still inside the text layer.
        blankRightX: layerRect.right - 8,
        blankLeftX: layerRect.left + 4,
        glyphRight,
        glyphLeft,
        layerLeft: layerRect.left,
        layerRight: layerRect.right,
        // Per-line boxes. `glyphRight` is the max across *all* lines, so it is
        // only a valid "over a glyph" column on whichever line happens to be
        // longest — every other row's right edge is blank space.
        lineLeft: rects.map((rect) => rect.left),
        lineRight: rects.map((rect) => rect.right),
        lineCenterY: rects.map((rect) => rect.top + rect.height / 2),
        // A point inside the *right quarter of line 5's final glyph*. Pressing
        // or releasing here snaps the caret to the end of the line, which is
        // what "drag across the whole run" means; `lineRight[4]` itself sits on
        // the boundary and `glyphRight` is a different line's edge entirely.
        lastLineEndX: ((): number | null => {
          const span = spans[4];
          const text = span?.firstChild;
          if (!span || text?.nodeType !== Node.TEXT_NODE) return null;
          const lastChar = document.createRange();
          lastChar.setStart(text, span.textContent.length - 1);
          lastChar.setEnd(text, span.textContent.length);
          const rect = lastChar.getBoundingClientRect();
          return rect.right - rect.width * 0.25;
        })(),
        // Vertical midpoint of the gap between line 2 and line 3.
        betweenLinesY: (rects[1]!.bottom + rects[2]!.top) / 2,
      };
    }, START_CHAR);
    expect(geometry).not.toBeNull();
    const g = geometry!;
    expect(g.spanCount).toBe(PAGE_LINES.length);
    // The probe columns must genuinely be outside every glyph box.
    expect(g.blankRightX).toBeGreaterThan(g.glyphRight + 20);
    expect(g.blankLeftX).toBeLessThan(g.glyphLeft - 4);
    // Line 5 is deliberately not the longest line, so `glyphRight` lands in
    // blank margin on line 5's row. Probes that must press or land *on a glyph*
    // therefore have to use that line's own box.
    expect(g.lineRight[4]!).toBeLessThan(g.glyphRight);
    expect(g.lastLineEndX).not.toBeNull();
    expect(g.lastLineEndX!).toBeLessThan(g.lineRight[4]!);
    expect(g.lastLineEndX!).toBeGreaterThan(g.lineLeft[4]!);

    // 1. Press mid-line-1, drag right into the blank margin beside line 3.
    await app.window.mouse.move(g.startX, g.startY);
    await app.window.mouse.down();
    await app.window.mouse.move(g.blankRightX, g.lineCenterY[1]!, { steps: 6 });
    await app.window.mouse.move(g.blankRightX, g.lineCenterY[2]!, { steps: 6 });

    const blankRight = await readSelection();
    // Invariants that hold under any native behaviour:
    expect(blankRight.selectingLayers).toBe(1);
    expect(blankRight.containedInPage).toBe(true);
    expect(blankRight.text.length).toBeGreaterThan(0);
    expect(expectedThrough(4)).toContain(blankRight.text);
    classifyBlankSpace(
      blankRight,
      expectedThrough(2),
      expectedThrough(4)
    );

    // 2. Continue the same drag further down the blank right margin.
    await app.window.mouse.move(g.blankRightX, g.lineCenterY[3]!, { steps: 6 });
    await app.window.mouse.move(g.blankRightX, g.lineCenterY[4]!, { steps: 6 });
    const blankRightDeep = await readSelection();
    expect(blankRightDeep.containedInPage).toBe(true);
    expect(expectedThrough(4)).toContain(blankRightDeep.text);
    classifyBlankSpace(
      blankRightDeep,
      expectedThrough(4),
      expectedThrough(4)
    );

    // 3. Move back into the glyph run: selection must still resolve exactly.
    await app.window.mouse.move(g.lineLeft[4]! + 4, g.lineCenterY[4]!, { steps: 6 });
    await app.window.mouse.move(g.lastLineEndX!, g.lineCenterY[4]!, { steps: 6 });
    const overGlyphs = await readSelection();
    expect(overGlyphs.endIsTextNode).toBe(true);
    expect(overGlyphs.containedInPage).toBe(true);
    expect(overGlyphs.text.startsWith(PAGE_LINES[0].slice(START_CHAR))).toBe(true);
    expect(overGlyphs.text.split('\n')).toHaveLength(5);
    // Ending on a real glyph makes the forward result exact, not just shaped.
    expect(overGlyphs.text).toBe(expectedThrough(4));
    await app.window.mouse.up();
    await expect
      .poll(async () =>
        app.window.evaluate(() => document.querySelectorAll('.textLayer.selecting').length)
      )
      .toBe(0);

    // 4. Blank LEFT margin, and the vertical gap between two lines.
    await app.window.mouse.move(g.startX, g.startY);
    await app.window.mouse.down();
    await app.window.mouse.move(g.blankLeftX, g.lineCenterY[2]!, { steps: 6 });
    const blankLeft = await readSelection();
    expect(blankLeft.containedInPage).toBe(true);
    expect(blankLeft.selectingLayers).toBe(1);
    // Unlike the right margin this probe carries no `toContain` invariant: the
    // honest possibilities here include an empty range, so the validity check
    // lives inside the classifier and applies only to the labels that claim a
    // live text endpoint.
    classifyBlankSpace(
      blankLeft,
      expectedThrough(1),
      expectedThrough(4)
    );

    await app.window.mouse.move(g.blankRightX, g.betweenLinesY, { steps: 6 });
    const betweenLines = await readSelection();
    expect(betweenLines.containedInPage).toBe(true);
    classifyBlankSpace(
      betweenLines,
      expectedThrough(1),
      expectedThrough(4)
    );
    await app.window.mouse.up();

    // 4b. Pressing (rather than extending into) blank margin is a distinct
    // native question: the sentinel is `user-select: none` and the glyph spans
    // are absolutely positioned, so the engine may or may not place the
    // selection base at the press point. Characterize it from a cleared
    // selection so no earlier range can leak into the result.
    await app.window.evaluate(() => {
      document.getSelection()?.removeAllRanges();
    });
    await app.window.mouse.move(g.blankRightX, g.lineCenterY[4]!);
    await app.window.mouse.down();
    await app.window.mouse.move(g.lineLeft[2]! + 8, g.lineCenterY[2]!, { steps: 6 });
    await app.window.mouse.move(g.startX, g.startY, { steps: 6 });
    const blankPress = await readSelection();
    await app.window.mouse.up();
    expect(blankPress.containedInPage).toBe(true);
    expect(blankPress.selectingLayers).toBe(1);
    expect(expectedThrough(4)).toContain(blankPress.text);
    const blankPressBehaviour: BlankAnchorBehaviour = !blankPress.endIsTextNode
      ? 'anchors-at-container-offset'
      : blankPress.text === expectedThrough(4)
        ? 'anchors-at-nearest-glyph'
        : 'anchors-at-first-crossed-glyph';
    expect(BLANK_ANCHOR_BEHAVIOURS).toContain(blankPressBehaviour);

    // 5. Reverse (bottom-up) drag over the glyph run. The press has to land on
    // a real glyph, so it uses line 5's own final-glyph point — `glyphRight` is
    // the *longest* line's edge, which on line 5's row is blank margin (what 4b
    // deliberately measures instead).
    await app.window.evaluate(() => {
      document.getSelection()?.removeAllRanges();
    });
    await app.window.mouse.move(g.lastLineEndX!, g.lineCenterY[4]!);
    await app.window.mouse.down();
    await app.window.mouse.move(g.lineLeft[2]! + 8, g.lineCenterY[2]!, { steps: 6 });
    await app.window.mouse.move(g.startX, g.startY, { steps: 6 });
    const reverse = await readSelection();
    await app.window.mouse.up();
    expect(reverse.endIsTextNode).toBe(true);
    expect(reverse.containedInPage).toBe(true);
    expect(reverse.text).toBe(expectedThrough(4));
    // Dragging the same two glyph positions in either direction must resolve to
    // the identical run.
    expect(reverse.text).toBe(overGlyphs.text);

    // 6. The persisted annotation must equal the native selection exactly.
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    const layerOffsets = await app.window.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      const selection = document.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      if (!layer || !range) return null;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let cursor = 0;
      let start = -1;
      let end = -1;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (node === range.startContainer) start = cursor + range.startOffset;
        if (node === range.endContainer) end = cursor + range.endOffset;
        cursor += length;
      }
      return { start, end, layerText: layer.textContent };
    });
    expect(layerOffsets).not.toBeNull();
    expect(layerOffsets!.start).toBe(START_CHAR);

    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect
      .poll(async () =>
        app.window.evaluate(
          async (id) => (await window.interleafAPI.annotations.list(id, { limit: 10 })).length,
          docId
        )
      )
      .toBe(1);

    const [saved] = await app.window.evaluate(
      async (id) => window.interleafAPI.annotations.list(id, { limit: 10 }),
      docId
    );
    expect(saved).toBeDefined();
    if (saved?.anchor.format !== 'pdf') throw new Error('Expected a stored PDF annotation');
    expect(saved.status).toBe('anchored');
    expect(saved.anchor.pageIndex).toBe(0);
    expect(saved.selectedText).toBe(expectedThroughFlat(4));
    expect(saved.anchor.textStart).toBe(layerOffsets!.start);
    expect(saved.anchor.textEnd).toBe(layerOffsets!.end);
    expect(saved.anchor.quote.exact).toBe(
      layerOffsets!.layerText.slice(layerOffsets!.start, layerOffsets!.end)
    );
    expect(reverse.text.replaceAll('\n', '')).toBe(saved.anchor.quote.exact);
    expect(saved.anchor.segments).toBeUndefined();

    // 7. Painted geometry never bleeds into the blank right margin.
    const painted = await app.window.evaluate(() => {
      const ranges = Array.from(CSS.highlights.get('interleaf-yellow') ?? []).filter(
        (range) => range instanceof Range
      );
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      const spans = Array.from(layer?.querySelectorAll<HTMLElement>('span') ?? []);
      const glyphRight = spans.reduce(
        (max, span) => Math.max(max, span.getBoundingClientRect().right),
        0
      );
      const rects = ranges.flatMap((range) => Array.from(range.getClientRects()));
      return {
        rangeCount: ranges.length,
        glyphRight,
        rectCount: rects.length,
        maxRight: rects.reduce((max, rect) => Math.max(max, rect.right), 0),
      };
    });
    expect(painted.rangeCount).toBe(1);
    expect(painted.rectCount).toBeGreaterThanOrEqual(5);
    expect(painted.maxRight).toBeLessThanOrEqual(painted.glyphRight + 2);

    // 8. Zoom re-render keeps exactly one layer and one sentinel per page, and
    // the restored highlight survives the double-buffered swap.
    const readScaleFactor = async (): Promise<string> =>
      app.window.evaluate(() => {
        const layer = document.querySelector<HTMLElement>(
          '[data-testid="pdf-textlayer-p1"]'
        );
        return layer?.style.getPropertyValue('--total-scale-factor') ?? '';
      });
    const scaleBeforeZoom = await readScaleFactor();
    expect(scaleBeforeZoom).not.toBe('');

    // The zoom buttons live inside the document settings popover, not the
    // toolbar itself (see `ReaderHeaderToolbar`, and `pdf-reader.spec.ts`).
    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    await app.window.getByTestId('zoom-in-button').click();
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('document-settings-popover')).toBeHidden();

    // The adapter pins each layer to the scale it was built at, so a *changed*
    // factor is what proves the double-buffered swap actually committed.
    await expect.poll(readScaleFactor).not.toBe(scaleBeforeZoom);
    const afterZoom = await app.window.evaluate(() => {
      const page = document.querySelector('[data-testid="pdf-page-1"]');
      return {
        layers: page?.querySelectorAll('.textLayer').length ?? 0,
        sentinels: page?.querySelectorAll('.endOfContent').length ?? 0,
        canvases: page?.querySelectorAll('canvas').length ?? 0,
        painted: CSS.highlights.get('interleaf-yellow')?.size ?? 0,
      };
    });
    expect(afterZoom.layers).toBe(1);
    expect(afterZoom.sentinels).toBe(1);
    expect(afterZoom.canvases).toBe(1);
    expect(afterZoom.painted).toBe(1);

    // 9. Teardown leaves no layer, sentinel or selecting state behind.
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    expect(
      await app.window.evaluate(() => ({
        layers: document.querySelectorAll('.textLayer').length,
        sentinels: document.querySelectorAll('.endOfContent').length,
        selecting: document.querySelectorAll('.textLayer.selecting').length,
      }))
    ).toEqual({ layers: 0, sentinels: 0, selecting: 0 });

    // 10. Reopen re-anchors and repaints on a freshly built layer.
    await app.window.getByTestId(`read-doc-${docId}`).click();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await expect
      .poll(async () =>
        app.window.evaluate(() => {
          return CSS.highlights.get('interleaf-yellow')?.size ?? 0;
        })
      )
      .toBe(1);
    const restored = await app.window.evaluate(() => {
      const ranges = Array.from(CSS.highlights.get('interleaf-yellow') ?? []).filter(
        (range) => range instanceof Range
      );
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      return {
        text: ranges[0]?.toString() ?? '',
        sentinels: layer?.querySelectorAll('.endOfContent').length ?? 0,
        sentinelIsLast: layer?.lastElementChild?.className === 'endOfContent',
      };
    });
    expect(restored.text.replaceAll('\n', '')).toBe(expectedThroughFlat(4));
    expect(restored.sentinels).toBe(1);
    expect(restored.sentinelIsLast).toBe(true);

  });

  test('characterizes rotated and right-to-left pages', async () => {
    await openFirstDocument(rotatedPdfPath, 'Universal Selection Rotated');

    const rotated = await app.window.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      const canvas = document.querySelector<HTMLElement>('[data-testid="pdf-canvas-p1"]');
      if (!layer || !canvas) return null;
      const layerRect = layer.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const spans = Array.from(layer.querySelectorAll<HTMLElement>('span')).filter(
        (span) => span.textContent.trim().length > 0
      );
      const spanRects = spans.map((span) => span.getBoundingClientRect());
      return {
        mainRotation: layer.getAttribute('data-main-rotation'),
        transform: getComputedStyle(layer).transform,
        layerRect: { left: layerRect.left, top: layerRect.top, width: layerRect.width, height: layerRect.height },
        canvasRect: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
        spanCount: spans.length,
        spansInsideCanvas: spanRects.every(
          (rect) =>
            rect.left >= canvasRect.left - 2 &&
            rect.right <= canvasRect.right + 2 &&
            rect.top >= canvasRect.top - 2 &&
            rect.bottom <= canvasRect.bottom + 2
        ),
        text: layer.textContent,
      };
    });
    expect(rotated).not.toBeNull();
    expect(rotated!.mainRotation).toBe('90');
    // Rotation must actually be applied by the upstream `[data-main-rotation]`
    // rule, not left as the identity preview transform.
    expect(rotated!.transform).not.toBe('none');
    expect(rotated!.transform).not.toMatch(/^matrix\(1, 0, 0, 1,/);
    // A /Rotate 90 page paints landscape.
    expect(rotated!.canvasRect.width).toBeGreaterThan(rotated!.canvasRect.height);
    // The rotated text layer must land on top of the canvas, not beside it.
    expect(rotated!.spansInsideCanvas).toBe(true);
    expect(rotated!.text).toContain('Rotated page line one');

    // Drag across the rotated page's glyph run and confirm containment.
    const rotGeom = await app.window.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p1"]');
      const spans = Array.from(layer?.querySelectorAll<HTMLElement>('span') ?? []).filter(
        (span) => span.textContent.trim().length > 0
      );
      const first = spans[0]?.getBoundingClientRect();
      const last = spans[spans.length - 1]?.getBoundingClientRect();
      if (!first || !last) return null;
      return {
        startX: first.left + 2,
        startY: first.top + first.height / 2,
        endX: last.right - 2,
        endY: last.top + last.height / 2,
      };
    });
    expect(rotGeom).not.toBeNull();
    await app.window.mouse.move(rotGeom!.startX, rotGeom!.startY);
    await app.window.mouse.down();
    await app.window.mouse.move(rotGeom!.endX, rotGeom!.endY, { steps: 8 });
    const rotatedSelection = await readSelection();
    await app.window.mouse.up();
    expect(rotatedSelection.containedInPage).toBe(true);
    expect(rotatedSelection.text.length).toBeGreaterThan(0);
    expect(rotated!.text).toContain(rotatedSelection.text.split('\n')[0]!);

    // Page 2 carries a right-to-left run. Scroll it into view and characterize
    // the direction semantics PDF.js assigns to its spans.
    await app.window.evaluate(() => {
      document
        .querySelector('[data-testid="pdf-page-2"]')
        ?.scrollIntoView({ block: 'center' });
    });
    await expect(app.window.getByTestId('pdf-textlayer-p2')).toBeVisible();
    const rtl = await app.window.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[data-testid="pdf-textlayer-p2"]');
      const spans = Array.from(layer?.querySelectorAll<HTMLElement>('span') ?? []);
      return {
        text: layer?.textContent ?? '',
        dirs: spans.map((span) => span.getAttribute('dir')),
        containerDirection: layer ? getComputedStyle(layer).direction : null,
        computedSpanDirections: spans.map((span) => getComputedStyle(span).direction),
      };
    });
    // The fixture maps ASCII A.. onto Hebrew alef.. through the font encoding,
    // so PDF.js's bidi pass sees genuine RTL codepoints.
    expect(rtl.text).toContain('א');
    expect(rtl.dirs).toContain('rtl');
    expect(rtl.computedSpanDirections).toContain('rtl');
    // The page container stays LTR; direction is per-span, exactly as upstream.
    expect(rtl.containerDirection).toBe('ltr');
  });
});
