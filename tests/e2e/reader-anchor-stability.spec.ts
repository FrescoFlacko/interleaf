import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle, openCompanionPanel, restoreDefaultWindowSize } from './helpers';
import { makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue } from './listbox';

/**
 * Changing how much room the reader has is not a request to read somewhere
 * else. Dragging a side panel or opening the Outline changes the fitted page
 * width, which changes every page's height, which moves every scroll offset in
 * the document — so a reader parked mid-document lands on a different page
 * unless the viewport is re-anchored to the content it was showing.
 *
 * These tests exercise the real gestures rather than a synthetic resize event:
 * a pointer drag on the right panel resizer, and the Outline sidebar taking
 * width out of the reader. The measurement is the same anchor the adapter
 * preserves — the page under the viewport centre and how far into that page the
 * centre sits — so a regression shows up as "the reader moved", not as a
 * pixel diff.
 */
test.describe('Reader anchor stability across reader-width changes', () => {
  /** The page whose middle the reader is parked on: mid-document, far from either clamp. */
  const ANCHOR_PAGE = 4;
  /**
   * Fitted page heights are rounded to whole pixels, so a rescaled anchor lands
   * a fraction of a line — not a fraction of a page — away from where it was.
   */
  const PROGRESS_TOLERANCE = 0.05;
  /** A drag that moves the reader edge less than this proves nothing was resized. */
  const MIN_READER_WIDTH_CHANGE = 40;
  /** Companion pane bounds, mirrored from the panel resizer's own clamps. */
  const PANEL_MIN_RIGHT = 280;
  const DRAG_DELTA = 180;

  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;

  type Anchor = {
    readonly page: number;
    readonly progress: number;
    readonly readerWidth: number;
    readonly pageHeight: number;
  };

  /**
   * Where the reader is: the page under the centre of the viewport, and how far
   * into that page the centre sits. Both survive a pure rescale; neither
   * survives keeping `scrollTop` across one.
   */
  const readAnchor = (): Promise<Anchor | null> =>
    app.window.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      if (!scroller) return null;
      const documentY = scroller.scrollTop + scroller.clientHeight / 2;
      for (const wrapper of scroller.querySelectorAll<HTMLElement>('.pdf-page-wrapper')) {
        const height = wrapper.offsetHeight;
        if (height <= 0) continue;
        if (documentY < wrapper.offsetTop || documentY > wrapper.offsetTop + height) continue;
        return {
          page: Number.parseInt(wrapper.dataset.pageNumber ?? '', 10),
          progress: (documentY - wrapper.offsetTop) / height,
          readerWidth: scroller.clientWidth,
          pageHeight: height,
        };
      }
      return null;
    });

  /** Parks the viewport centre on the middle of `ANCHOR_PAGE`. */
  const parkMidDocument = async (): Promise<void> => {
    await app.window.evaluate((page: number) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      const wrapper = document.querySelector<HTMLElement>(`[data-testid="pdf-page-${String(page)}"]`);
      if (!scroller || !wrapper) throw new Error('PDF surface not ready');
      scroller.scrollTop = wrapper.offsetTop + wrapper.offsetHeight / 2 - scroller.clientHeight / 2;
    }, ANCHOR_PAGE);
    // Scroll handling is rAF-batched; let the page under the centre settle.
    await expect(app.window.getByTestId('page-number-input')).toHaveValue(String(ANCHOR_PAGE));
  };

  /**
   * A width change refits on the next frame and commits after a quiet period,
   * so "the sidebar is visible" is not yet "the pages have their new size".
   * Settling therefore means all three: the panel has stopped easing, the
   * fitted page width matches the room the reader now has, and no page is still
   * wearing a preview transform. Waiting only on the transform would let a
   * measurement land before the refit had started, when nothing had moved yet.
   */
  /**
   * The panel eases its width over 200ms, so the reader is still growing for
   * several frames after the gesture that resized it. Measuring the anchor
   * against a width that is still moving is how these tests would report a
   * resize they had not actually waited for.
   */
  const waitForReaderWidthStable = async (selector: string): Promise<void> => {
    let previousWidth = -1;
    const readerWidthIsStable = async (): Promise<boolean> => {
      const current = await app.window.evaluate(
        (target) => document.querySelector<HTMLElement>(target)?.clientWidth ?? -1,
        selector
      );
      const stable = current > 0 && current === previousWidth;
      previousWidth = current;
      return stable;
    };
    await expect.poll(readerWidthIsStable, { timeout: 10_000, intervals: [150] }).toBe(true);
  };

  /**
   * Every painted page, not just the anchor page: only pages near the viewport
   * are rendered at all, so asking one specific page for its transform would be
   * a question about virtualization rather than about the resize having
   * finished.
   */
  const waitForNoPreviewScaling = async (): Promise<void> => {
    const anyPagePreviewScaled = (): Promise<boolean> =>
      app.window.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLCanvasElement>('canvas[data-testid^="pdf-canvas-p"]')
        ).some((canvas) => canvas.style.transform !== '')
      );
    await expect.poll(anyPagePreviewScaled, { timeout: 15_000 }).toBe(false);
  };

  const waitForRefitSettled = async (): Promise<void> => {
    await waitForReaderWidthStable('[data-testid="pdf-scroll-container"]');

    const fittedWidthError = (): Promise<number> =>
      app.window.evaluate(() => {
        const container = document.querySelector<HTMLElement>('[data-testid="pdf-viewport-container"]');
        const wrapper = document.querySelector<HTMLElement>('[data-testid="pdf-page-1"]');
        if (!container || !wrapper) return Number.POSITIVE_INFINITY;
        // The adapter fits to the container minus its 48px of horizontal padding.
        return Math.abs(container.clientWidth - 48 - wrapper.offsetWidth);
      });
    await expect.poll(fittedWidthError, { timeout: 15_000 }).toBeLessThanOrEqual(2);
    await waitForNoPreviewScaling();
  };

  /**
   * Fit Page fits to whichever of width or height binds, so its fitted width is
   * not derivable from the container width alone. Settling is therefore read
   * from the page itself: the reader has stopped moving, the anchor page has
   * stopped changing size, and no page is still wearing a preview transform.
   */
  const waitForFitPageSettled = async (): Promise<void> => {
    await waitForReaderWidthStable('[data-testid="pdf-scroll-container"]');

    let previousHeight = -1;
    const pageHeightIsStable = async (): Promise<boolean> => {
      const current = await app.window.evaluate(
        (page: number) =>
          document.querySelector<HTMLElement>(`[data-testid="pdf-page-${String(page)}"]`)
            ?.offsetHeight ?? -1,
        ANCHOR_PAGE
      );
      const stable = current > 0 && current === previousHeight;
      previousHeight = current;
      return stable;
    };
    await expect.poll(pageHeightIsStable, { timeout: 15_000, intervals: [150] }).toBe(true);
    await waitForNoPreviewScaling();
  };

  /** Switches the reader's zoom preset through the toolbar the reader uses. */
  const selectZoomMode = async (mode: string): Promise<void> => {
    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    await chooseListboxValue(app.window.getByTestId('zoom-mode-select'), mode);
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('document-settings-popover')).toHaveCount(0);
  };

  const expectSameReadingPosition = (before: Anchor, after: Anchor): void => {
    expect(after.page).toBe(before.page);
    expect(Math.abs(after.progress - before.progress)).toBeLessThanOrEqual(PROGRESS_TOLERANCE);
  };

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-anchor-e2e-'));
    samplePdfPath = join(fixtureDir, 'Anchor_Stability.pdf');

    writeFileSync(
      samplePdfPath,
      makePdfFixture({
        title: 'Anchor Stability',
        // Eight pages so the anchor page sits well away from both ends of the
        // scroll range, where clamping would mask a real drift.
        pageLines: Array.from({ length: 8 }, (_unused, pageIndex) => [
          `Section ${String(pageIndex + 1)}: anchored reading position under panel resize.`,
          ...Array.from(
            { length: 18 },
            (_line, lineIndex) => `Page ${String(pageIndex + 1)} line ${String(lineIndex + 1)}.`
          ),
        ]),
        outline: [
          { title: 'Section 1', targetPage: 1 },
          { title: 'Section 4', targetPage: 4 },
          { title: 'Section 8', targetPage: 8 },
        ],
      })
    );

    app = await launchInterleaf();
    await restoreDefaultWindowSize(app);
    await openCompanionPanel(app);

    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible({ timeout: 30_000 });
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('dragging the right panel keeps the reader on the same page content', async () => {
    const resizer = app.window.getByTestId('panel-resizer-right');
    await expect(resizer).toBeAttached();

    // Widen the companion pane to its maximum first, so the narrowing drag has
    // room to move the reader edge instead of landing against the clamp.
    await resizer.focus();
    await app.window.keyboard.press('End');
    await waitForRefitSettled();
    const startPaneWidth = Number.parseInt((await resizer.getAttribute('aria-valuenow')) ?? '0', 10);
    expect(startPaneWidth).toBeGreaterThanOrEqual(PANEL_MIN_RIGHT + DRAG_DELTA);

    await parkMidDocument();
    await expect(app.window.getByTestId(`pdf-canvas-p${String(ANCHOR_PAGE)}`)).toBeVisible({
      timeout: 30_000,
    });
    await waitForRefitSettled();

    const before = await readAnchor();
    expect(before).not.toBeNull();
    expect(before!.page).toBe(ANCHOR_PAGE);

    const box = await resizer.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // The real gesture: a pointer drag, in steps, so the live preview scaling
    // runs the way it does for a person rather than as one jump.
    await app.window.mouse.move(startX, startY);
    await app.window.mouse.down();
    for (const offset of [45, 90, 135, 180]) {
      await app.window.mouse.move(startX + offset, startY, { steps: 6 });
    }
    await app.window.mouse.up();

    await waitForRefitSettled();
    const after = await readAnchor();
    expect(after).not.toBeNull();

    // The drag has to have actually widened the reader, or "unchanged position"
    // would be true for the uninteresting reason.
    expect(after!.readerWidth - before!.readerWidth).toBeGreaterThanOrEqual(MIN_READER_WIDTH_CHANGE);
    expect(after!.pageHeight).toBeGreaterThan(before!.pageHeight);

    expectSameReadingPosition(before!, after!);
    // Keeping the old scroll offset through a taller layout is precisely the
    // failure this guards, so the offset must have moved to stay put.
    await expect(app.window.getByTestId('page-number-input')).toHaveValue(String(ANCHOR_PAGE));
  });

  test('opening and closing the Outline keeps the reader on the same page content', async () => {
    await parkMidDocument();
    await expect(app.window.getByTestId(`pdf-canvas-p${String(ANCHOR_PAGE)}`)).toBeVisible({
      timeout: 30_000,
    });
    await waitForRefitSettled();

    const before = await readAnchor();
    expect(before).not.toBeNull();
    expect(before!.page).toBe(ANCHOR_PAGE);

    // The Outline takes its width out of the reader, so the fitted page narrows.
    await app.window.getByTestId('toggle-toc-button').click();
    await expect(app.window.getByTestId('reader-outline-sidebar')).toBeVisible();
    await waitForRefitSettled();

    const withOutline = await readAnchor();
    expect(withOutline).not.toBeNull();
    expect(before!.readerWidth - withOutline!.readerWidth).toBeGreaterThanOrEqual(
      MIN_READER_WIDTH_CHANGE
    );
    expectSameReadingPosition(before!, withOutline!);
    await expect(app.window.getByTestId('page-number-input')).toHaveValue(String(ANCHOR_PAGE));

    // And closing it returns the width without returning the reader elsewhere.
    await app.window.getByTestId('close-toc-button').click();
    await expect(app.window.getByTestId('reader-outline-sidebar')).toHaveCount(0);
    await waitForRefitSettled();

    const restored = await readAnchor();
    expect(restored).not.toBeNull();
    expect(restored!.readerWidth).toBeGreaterThan(withOutline!.readerWidth);
    expectSameReadingPosition(before!, restored!);
    await expect(app.window.getByTestId('page-number-input')).toHaveValue(String(ANCHOR_PAGE));
  });

  test('keeps the reader in place when Fit Page rescales with the reader', async () => {
    // Fit Page is a different fit rule, not a different rendering path: it fits
    // to whichever dimension binds. Fit Width was the only preset the earlier
    // resize tests covered, so a refit that only Fit Page reaches — the width
    // becoming the binding dimension — went unverified.
    await selectZoomMode('fit-page');

    // Give the companion pane its full width first, so the reader is narrow
    // enough that width, not height, is what Fit Page is fitting to.
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    await waitForFitPageSettled();

    await parkMidDocument();
    await expect(app.window.getByTestId(`pdf-canvas-p${String(ANCHOR_PAGE)}`)).toBeVisible({
      timeout: 30_000,
    });
    await waitForFitPageSettled();

    const before = await readAnchor();
    expect(before).not.toBeNull();
    expect(before!.page).toBe(ANCHOR_PAGE);

    // Returning the pane to its minimum widens the reader, which under Fit Page
    // raises the fitted scale until the height binds again.
    await app.window.keyboard.press('Home');
    await waitForFitPageSettled();

    const after = await readAnchor();
    expect(after).not.toBeNull();
    expect(after!.readerWidth - before!.readerWidth).toBeGreaterThanOrEqual(
      MIN_READER_WIDTH_CHANGE
    );
    // Without an actual rescale this test would pass for the uninteresting
    // reason that nothing had to be re-anchored.
    expect(after!.pageHeight).toBeGreaterThan(before!.pageHeight);

    expectSameReadingPosition(before!, after!);
    await expect(app.window.getByTestId('page-number-input')).toHaveValue(String(ANCHOR_PAGE));
  });
});

/**
 * The same promise for a reflowable format, where it costs more to keep.
 *
 * A PDF page is rescaled by a resize; Markdown is re-wrapped by it. Every line
 * break moves, the document's total height changes, and a preserved `scrollTop`
 * lands the reader somewhere they were not. The adapter's `ResizeObserver`
 * is what puts them back, and only a real layout can exercise it: in jsdom every
 * rectangle is zero, so the restore would be a no-op the test could not tell
 * from a regression.
 */
test.describe('Reader anchor stability across a Markdown reflow', () => {
  /** A re-wrap that changes the measure by less than this proves nothing reflowed. */
  const MIN_MEASURE_CHANGE = 40;
  /**
   * A re-wrapped paragraph is a different height and the restore rounds to
   * whole pixels, so the fraction lands near where it was rather than exactly
   * on it. Kept tight on purpose: without the restore the same gesture moves
   * the reader by an order of magnitude more than this — a fifth of the way
   * through the paragraph when the browser's own scroll anchoring softens it,
   * and eight paragraphs when it does not.
   */
  const PROGRESS_TOLERANCE = 0.02;
  /** Where inside the anchor paragraph the viewport's top edge is parked. */
  const ANCHOR_PROGRESS = 0.5;
  /** The first words of the paragraph the reader is parked inside. */
  const ANCHOR_MARKER = 'Anchor paragraph:';
  const SENTENCE =
    'A quorum of replicas acknowledges each write before it is considered durable, ' +
    'so a later read that also reaches a quorum cannot miss it. ';

  let app: AppHandle;
  let fixtureDir: string;
  let fixturePath: string;

  type BlockAnchor = {
    /** The index of the block the top of the viewport was inside. */
    readonly block: string;
    /** How far into that block the viewport's top edge sat. */
    readonly progress: number;
    /** The block's painted height, which the re-wrap changes. */
    readonly blockHeight: number;
    /** The painted measure of the text, which is what a reflow changes. */
    readonly measure: number;
  };

  /**
   * The reader's position expressed the way a reflow leaves it meaningful: the
   * block under the top of the viewport rather than a scroll offset, which is
   * the same anchor `captureReflowAnchor` records.
   */
  const readBlockAnchor = (): Promise<BlockAnchor | null> =>
    app.window.evaluate(async () => {
      // A read that forces layout between a width change and the adapter's
      // ResizeObserver sees the re-wrap before the restore, a state that is
      // never painted. Waiting out a rendered frame reads what was on screen,
      // after the scroll handlers and observers of that frame have run.
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { setTimeout(resolve, 0); }); });
      const scroller = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]');
      const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
      if (!scroller || !wrapper) return null;
      const viewportTop = scroller.getBoundingClientRect().top;
      for (const block of scroller.querySelectorAll<HTMLElement>('[data-markdown-block]')) {
        const rect = block.getBoundingClientRect();
        if (rect.height <= 0) continue;
        // The blocks are in document order, so the first one whose bottom is
        // still below the viewport top is either the block the top edge is
        // inside or — when the edge lands in the margin between two blocks —
        // the block the reader is about to read. `captureReflowAnchor` treats
        // those two cases the same way, so the measurement does too.
        if (rect.bottom > viewportTop) {
          return {
            block: block.getAttribute('data-markdown-block') ?? '',
            progress: Math.max(0, Math.min(1, (viewportTop - rect.top) / rect.height)),
            blockHeight: rect.height,
            measure: wrapper.clientWidth,
          };
        }
      }
      return null;
    });

  /**
   * Puts the viewport's top edge halfway into the marked paragraph. Halfway
   * rather than at its top edge: a paragraph's top can be preserved by keeping
   * the block in view at all, while a position *inside* one is only preserved
   * by the fraction the adapter records.
   */
  const parkInsideAnchorBlock = async (): Promise<void> => {
    await app.window.evaluate(
      ({ marker, progress }: { marker: string; progress: number }) => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]');
        if (!scroller) throw new Error('Markdown surface not ready');
        const anchor = [
          ...scroller.querySelectorAll<HTMLElement>('[data-markdown-block]'),
        ].find((block) => block.textContent.startsWith(marker));
        if (!anchor) throw new Error('Anchor paragraph not rendered');
        const viewportTop = scroller.getBoundingClientRect().top;
        const rect = anchor.getBoundingClientRect();
        scroller.scrollTop += rect.top + progress * rect.height - viewportTop;
      },
      { marker: ANCHOR_MARKER, progress: ANCHOR_PROGRESS }
    );
    // The adapter records the anchor from its scroll handler, which is
    // rAF-batched, so the position is not yet captured when scrollTop is set.
    // A read of the DOM alone would see the new offset at once; the read waits
    // out a rendered frame, which is what proves the scroll event and its
    // capture have run.
    await expect
      .poll(async () => (await readBlockAnchor())?.progress ?? -1, { timeout: 10_000 })
      .toBeCloseTo(ANCHOR_PROGRESS, 2);
  };

  /**
   * Decides when an animated measure has begun moving and then stopped.
   *
   * The re-wrap starts a frame or two after the key press, so "unchanged" only
   * counts as settled once the measure has actually moved; otherwise the reads
   * taken before the transition begins would end sampling immediately.
   */
  const measureSettler = (start: number): {
    note: (measure: number) => void;
    done: () => boolean;
    measure: () => number;
  } => {
    let moved = false;
    let unchanged = 0;
    // Seeded with the measure before the gesture, so a change that lands in a
    // single frame still counts as having moved.
    let previous = start;
    return {
      note: (measure) => {
        if (previous >= 0 && measure !== previous) moved = true;
        unchanged = measure === previous ? unchanged + 1 : 0;
        previous = measure;
      },
      done: () => moved && unchanged >= 8,
      measure: () => previous,
    };
  };

  /**
   * Watches the anchor, one rendered frame at a time, for the whole re-wrap.
   *
   * Sampling runs until the painted measure has stopped changing for several
   * consecutive frames, so it covers every intermediate wrap rather than a
   * fixed duration, and it reports the worst drift seen along the way.
   */
  const sampleDriftWhileReflowing = async (
    reference: BlockAnchor
  ): Promise<{ maxDrift: number; samples: number; finalMeasure: number }> => {
    const settler = measureSettler(reference.measure);
    let maxDrift = 0;
    let samples = 0;
    // Bounded by the same 10 s ceiling the measure-stability poll uses.
    const deadline = Date.now() + 10_000;
    while (!settler.done() && Date.now() < deadline) {
      const sample = await readBlockAnchor();
      if (sample === null) continue;
      samples += 1;
      settler.note(sample.measure);
      if (sample.block !== reference.block) {
        throw new Error(`Reflow moved the reader to block ${sample.block}`);
      }
      maxDrift = Math.max(maxDrift, Math.abs(sample.progress - reference.progress));
    }
    return { maxDrift, samples, finalMeasure: settler.measure() };
  };

  /** Waits for the painted measure to stop moving after a width change. */
  const waitForMeasureStable = async (): Promise<void> => {
    let previous = -1;
    const measureIsStable = async (): Promise<boolean> => {
      const current = await app.window.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]')
            ?.clientWidth ?? -1
      );
      const stable = current > 0 && current === previous;
      previous = current;
      return stable;
    };
    await expect.poll(measureIsStable, { timeout: 10_000, intervals: [150] }).toBe(true);
  };

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-reflow-e2e-'));
    fixturePath = join(fixtureDir, 'Reflow Stability.md');
    writeFileSync(
      fixturePath,
      makeMarkdownFixture({
        title: 'Reflow Stability',
        author: 'Interleaf',
        body: [
          // Enough ordinary prose ahead of the anchor that the text above it
          // re-wraps by hundreds of pixels: that is the height a retained
          // `scrollTop` would swallow, and it is several paragraphs' worth.
          ...Array.from(
            { length: 20 },
            (_unused, index) => `Lead-in ${String(index + 1)}: ${SENTENCE.repeat(3)}`
          ),
          `${ANCHOR_MARKER} ${SENTENCE.repeat(3)}`,
          ...Array.from(
            { length: 20 },
            (_unused, index) => `Trailing ${String(index + 1)}: ${SENTENCE.repeat(3)}`
          ),
        ].join('\n\n'),
      })
    );

    app = await launchInterleaf();
    await restoreDefaultWindowSize(app);
    await openCompanionPanel(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await stubOpenDialog(app, [fixturePath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('markdown-scroll-container')).toBeVisible({
      timeout: 30_000,
    });
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('keeps the reader on the same block when the text re-wraps', async () => {
    // Give the companion pane its full width first, so the text is wrapped to
    // the reader rather than to the `ch` cap, where a width change re-wraps
    // nothing at all.
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    await waitForMeasureStable();

    // Park mid-document, far from either end of the scroll range where clamping
    // would hide a drift.
    await parkInsideAnchorBlock();

    const before = await readBlockAnchor();
    expect(before).not.toBeNull();

    // Returning the pane to its minimum widens the reader, which re-wraps every
    // paragraph: the real gesture, observed by the adapter's own
    // ResizeObserver rather than by a synthetic resize event.
    await app.window.keyboard.press('Home');

    // The reader has to stay put on every painted frame of the re-wrap, not
    // only at the end. Sampling each frame is what distinguishes a restore
    // that holds from one that lands correctly once and is then walked away
    // from by a later change of measure — the drift this test used to see
    // only at the last step.
    const drifting = await sampleDriftWhileReflowing(before!);
    expect(drifting.samples).toBeGreaterThan(1);
    // Sampling has to have run all the way through the re-wrap, or a steady
    // anchor would only mean nothing had happened yet.
    expect(drifting.finalMeasure - before!.measure).toBeGreaterThanOrEqual(MIN_MEASURE_CHANGE);
    expect(drifting.maxDrift).toBeLessThanOrEqual(PROGRESS_TOLERANCE);

    await waitForMeasureStable();

    const after = await readBlockAnchor();
    expect(after).not.toBeNull();
    // Without an actual re-wrap, "the reader did not move" would be true for the
    // uninteresting reason: the measure has to have changed, and the anchor
    // paragraph has to have become a different height because of it.
    expect(after!.measure - before!.measure).toBeGreaterThanOrEqual(MIN_MEASURE_CHANGE);
    expect(after!.blockHeight).toBeLessThan(before!.blockHeight);

    expect(after!.block).toBe(before!.block);
    expect(Math.abs(after!.progress - before!.progress)).toBeLessThanOrEqual(PROGRESS_TOLERANCE);
  });

  type Gesture = 'keyboard' | 'toggle' | 'drag';
  type PaintedFrame = { readonly block: string; readonly progress: number; readonly measure: number };

  /**
   * Scrolls into the anchor paragraph and resizes the reader in ONE task, then
   * reads every painted frame that follows. Nothing waits between the scroll
   * and the gesture, so the adapter's rAF-batched scroll capture has not run
   * when the width is committed: the anchor must be recorded before the commit.
   */
  const scrollAndResizeInOneTask = (gesture: Gesture): Promise<{ target: string; frames: PaintedFrame[] }> =>
    app.window.evaluate(
      async ({ marker, progress, kind }: { marker: string; progress: number; kind: Gesture }) => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]');
        const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
        const resizer = document.querySelector<HTMLElement>('[data-testid="panel-resizer-right"]');
        const toggle = document.querySelector<HTMLElement>('[data-testid="toggle-right-panel"]');
        if (!scroller || !wrapper || !resizer || !toggle) throw new Error('Reader surface not ready');
        const blocks = [...scroller.querySelectorAll<HTMLElement>('[data-markdown-block]')];
        const anchor = blocks.find((block) => block.textContent.startsWith(marker));
        if (!anchor) throw new Error('Anchor paragraph not rendered');
        const performGesture = (): void => {
          if (kind === 'keyboard') {
            resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
          } else if (kind === 'toggle') {
            toggle.click();
          } else {
            const box = resizer.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const pointer = (type: string, clientX: number): void => {
              resizer.dispatchEvent(new PointerEvent(type, {
                bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
                pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX, clientY: y,
              }));
            };
            pointer('pointerdown', x);
            pointer('pointermove', x + 240);
            pointer('pointerup', x + 240);
          }
        };
        const readPaintedFrames = async (): Promise<PaintedFrame[]> => {
          const painted: PaintedFrame[] = [];
          for (let index = 0; index < 45; index += 1) {
            await new Promise<void>((resolve) => { requestAnimationFrame(() => { setTimeout(resolve, 0); }); });
            const top = scroller.getBoundingClientRect().top;
            const hit = blocks.find((block) => {
              const box = block.getBoundingClientRect();
              return box.height > 0 && box.bottom > top;
            });
            if (!hit) throw new Error('No block under the viewport top');
            const box = hit.getBoundingClientRect();
            painted.push({
              block: hit.getAttribute('data-markdown-block') ?? '',
              progress: Math.max(0, Math.min(1, (top - box.top) / box.height)),
              measure: wrapper.clientWidth,
            });
          }
          return painted;
        };

        // Scroll and gesture run in this one task; only the frame reads wait.
        const rect = anchor.getBoundingClientRect();
        scroller.scrollTop += rect.top + progress * rect.height - scroller.getBoundingClientRect().top;
        performGesture();
        const frames = await readPaintedFrames();
        return { target: anchor.getAttribute('data-markdown-block') ?? '', frames };
      },
      { marker: ANCHOR_MARKER, progress: ANCHOR_PROGRESS, kind: gesture }
    );

  /** The same assertion for every gesture: the first and every later painted frame. */
  const expectAnchorHeldOnEveryFrame = (
    result: { target: string; frames: PaintedFrame[] },
    measureBefore: number
  ): void => {
    const { target, frames } = result;
    expect(frames).toHaveLength(45);
    // The gesture has to have re-wrapped the text, or holding still is trivial.
    expect(Math.abs(frames.at(-1)!.measure - measureBefore)).toBeGreaterThanOrEqual(MIN_MEASURE_CHANGE);
    frames.forEach((frame, index) => {
      expect(frame.block, `painted frame ${String(index)} block`).toBe(target);
      expect(Math.abs(frame.progress - ANCHOR_PROGRESS), `painted frame ${String(index)} progress`)
        .toBeLessThanOrEqual(PROGRESS_TOLERANCE);
    });
  };

  const readMeasure = (): Promise<number> =>
    app.window.evaluate(
      () => document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]')?.clientWidth ?? -1
    );

  /** Widest companion, reader parked at the top: the scroll in the task is the only scroll. */
  const prepareNarrowReader = async (): Promise<number> => {
    await app.window.getByTestId('panel-resizer-right').focus();
    await app.window.keyboard.press('End');
    await waitForMeasureStable();
    await app.window.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]')!.scrollTop = 0;
    });
    await expect.poll(async () => (await readBlockAnchor())?.block ?? '').toBe('0');
    return readMeasure();
  };

  test('holds the block when a scroll and a keyboard resize land in the same task', async () => {
    const measureBefore = await prepareNarrowReader();
    expectAnchorHeldOnEveryFrame(await scrollAndResizeInOneTask('keyboard'), measureBefore);
  });

  test('holds the block when a scroll and a drag resize land in the same task', async () => {
    const measureBefore = await prepareNarrowReader();
    expectAnchorHeldOnEveryFrame(await scrollAndResizeInOneTask('drag'), measureBefore);
  });

  test('holds the block when a scroll and opening the companion land in the same task', async () => {
    await prepareNarrowReader();
    // Closed first, so the toggle in the task opens it and narrows the reader.
    await app.window.getByTestId('toggle-right-panel').click();
    await expect(app.window.getByTestId('resizable-panel-right')).toHaveAttribute('data-panel-state', 'closed');
    await waitForMeasureStable();
    await app.window.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]')!.scrollTop = 0;
    });
    await expect.poll(async () => (await readBlockAnchor())?.block ?? '').toBe('0');
    const measureBefore = await readMeasure();
    expectAnchorHeldOnEveryFrame(await scrollAndResizeInOneTask('toggle'), measureBefore);
  });
});
