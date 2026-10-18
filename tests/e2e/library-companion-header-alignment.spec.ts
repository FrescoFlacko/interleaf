import { expect, test } from '@playwright/test';
import { launchInterleaf, type AppHandle } from './helpers';

/**
 * The library header and the companion tab bar are one line across the window.
 *
 * This is the library's half of the contract the reader header already keeps
 * (`reader-companion-header-alignment.spec.ts`). The two rows start at the same
 * y and each carries a bottom hairline, so any difference in their height shows
 * as a step in that line. Before this contract the library header was 99 CSS px
 * against the companion bar's 43: its controls wrapped onto a second row,
 * because `flex-wrap` plus 48 px of horizontal padding left an 824 px header
 * holding a ~158 px title block and ~637 px of controls. Only the running
 * engine can say where those edges land — the widths come from Tailwind
 * utilities, native select intrinsic sizes and a border-box together — so this
 * measures rendered rects in the shipped window rather than class names.
 */

/** Half a CSS pixel: the 56 px defect is two orders of magnitude above it. */
const TOLERANCE = 0.5;

/** Below this window width the companion moves into the compact drawer. */
const COMPACT_WIDTH = 920;

/** Every control the header must keep reachable, in visual order. */
const HEADER_CONTROLS = [
  'library-search-input',
  'format-filter-select',
  'sort-by-select',
  'grid-view-toggle',
  'list-view-toggle',
  'import-files-button',
  'import-options-button',
] as const;

type Rows = {
  readonly libraryHeight: number;
  readonly libraryBottom: number;
  readonly libraryTop: number;
  readonly libraryWidth: number;
  readonly companionHeight: number;
  readonly companionBottom: number;
  readonly companionTop: number;
  readonly innerWidth: number;
};

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchInterleaf();
  // The unchanged, default library view: no import, no filter, no selection.
  await expect(app.window.getByTestId('library-view')).toBeVisible();
  await expect(app.window.getByTestId('section-title')).toBeVisible();
});

test.afterAll(async () => {
  await app.close();
});

/** Both rows as painted: the library header, and the row holding the tablist. */
async function measureRows(): Promise<Rows> {
  return app.window.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="library-view"] > header');
    if (header === null) throw new Error('The library header was not mounted.');
    const tablist = document.querySelector<HTMLElement>('[data-testid="companion-panel"] [role="tablist"]');
    if (tablist === null) throw new Error('The companion tab bar was not mounted.');
    const companionRow = tablist.parentElement;
    if (companionRow === null) throw new Error('The companion tab bar has no row.');
    const headerRect = header.getBoundingClientRect();
    const companionRect = companionRow.getBoundingClientRect();
    return {
      libraryHeight: headerRect.height,
      libraryBottom: headerRect.bottom,
      libraryTop: headerRect.top,
      libraryWidth: headerRect.width,
      companionHeight: companionRect.height,
      companionBottom: companionRect.bottom,
      companionTop: companionRect.top,
      innerWidth: window.innerWidth,
    };
  });
}

/**
 * Whether every header control is on the header's own single line and can be
 * brought fully into view.
 *
 * "One line" is measured, not assumed: each control's vertical centre must sit
 * inside the header's box, which a wrapped second row cannot satisfy. Reachable
 * means the control has real painted area once its own scroll container has
 * been asked to reveal it — the sanctioned answer to insufficient width here is
 * a horizontally scrolling control strip, not a taller row.
 */
async function inspectControls(testIds: readonly string[]): Promise<readonly {
  readonly testId: string;
  readonly centreInsideHeader: boolean;
  readonly width: number;
  readonly height: number;
  readonly visibleWidth: number;
}[]> {
  return app.window.evaluate((ids) => {
    const header = document.querySelector<HTMLElement>('[data-testid="library-view"] > header');
    if (header === null) throw new Error('The library header was not mounted.');
    const headerRect = header.getBoundingClientRect();
    return ids.map((testId) => {
      const control = header.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (control === null) throw new Error(`The header no longer holds "${testId}".`);
      control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = control.getBoundingClientRect();
      const centre = rect.top + rect.height / 2;
      return {
        testId,
        centreInsideHeader: centre >= headerRect.top && centre <= headerRect.bottom,
        width: rect.width,
        height: rect.height,
        visibleWidth: Math.max(
          0,
          Math.min(rect.right, headerRect.right) - Math.max(rect.left, headerRect.left)
        ),
      };
    });
  }, [...testIds]);
}

/**
 * A fixed section title is never truncated: the search field gives up its
 * width first. Only a user-named folder may truncate, so a fixed title carries
 * no tooltip that would stand in for text the row failed to paint.
 */
async function expectTitleUncut(): Promise<void> {
  const title = app.window.getByTestId('section-title');
  await expect(title).not.toHaveAttribute('title');
  const fit = await title.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(fit.scrollWidth - fit.clientWidth, 'the fixed section title is cut').toBeLessThanOrEqual(0);
}

async function setZoomFactor(factor: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, value) => {
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Main BrowserWindow was not found.');
    main.webContents.setZoomFactor(value);
  }, factor);
}

test('the library header and the companion tab bar share a height and a bottom edge', async () => {
  await setZoomFactor(1.0);
  await expect(app.window.getByTestId('companion-panel')).toBeVisible();

  const rows = await measureRows();
  expect(rows.innerWidth, 'this check needs the side-by-side layout').toBeGreaterThanOrEqual(COMPACT_WIDTH);
  // The premise of a shared bottom edge: the two rows start at the same y.
  expect(Math.abs(rows.libraryTop - rows.companionTop), 'the two rows do not start at the same y')
    .toBeLessThanOrEqual(TOLERANCE);

  console.log(
    `[library-header] 100% at ${String(rows.innerWidth)} CSS px: library ${rows.libraryHeight.toFixed(2)} px `
    + `(width ${rows.libraryWidth.toFixed(2)}, bottom ${rows.libraryBottom.toFixed(2)}), `
    + `companion ${rows.companionHeight.toFixed(2)} px (bottom ${rows.companionBottom.toFixed(2)})`
  );

  expect(rows.companionHeight, 'the companion row is not the shared 43 px').toBeCloseTo(43, 1);
  expect(Math.abs(rows.libraryHeight - rows.companionHeight), 'the two rows differ in height')
    .toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(rows.libraryBottom - rows.companionBottom), 'the two dividers are not on one line')
    .toBeLessThanOrEqual(TOLERANCE);
});

test('every header control stays on that one line, unscrolled, at the default width', async () => {
  await setZoomFactor(1.0);
  const rows = await measureRows();
  expect(rows.innerWidth, 'this check is about the ordinary desktop width').toBeGreaterThanOrEqual(1200);

  // Nothing may need scrolling to be seen at this width: the strip that holds
  // the filters is at its natural size, so its scroll range is zero.
  const strip = await app.window.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="library-header-controls"]');
    if (element === null) throw new Error('The library header control strip was not mounted.');
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  console.log(
    `[library-header] control strip at ${String(rows.innerWidth)} CSS px: `
    + `${String(strip.scrollWidth)} px of content in ${String(strip.clientWidth)} px`
  );
  expect(strip.scrollWidth - strip.clientWidth, 'the controls need scrolling at the default width')
    .toBeLessThanOrEqual(1);

  const controls = await inspectControls(HEADER_CONTROLS);
  for (const control of controls) {
    expect(control.centreInsideHeader, `"${control.testId}" is not on the header's line`).toBe(true);
    expect(control.height, `"${control.testId}" has no height`).toBeGreaterThan(0);
    expect(control.visibleWidth, `"${control.testId}" is clipped`).toBeCloseTo(control.width, 1);
  }

  // The heading and its count are untouched by the containment design.
  await expect(app.window.getByTestId('section-title')).toHaveText('All Documents');
  await expectTitleUncut();
  await expect(app.window.getByTestId('document-count-badge')).toBeVisible();
});

/**
 * A 1280 px window with the default companion width.
 *
 * The header is too narrow there for every control at its natural size, and
 * the strip used to scroll, which cut the sort control mid-word and hid the
 * view toggle, and later the title was cut to "All Docu…". The search field
 * now gives up width first, down to its icon, so the fixed title is painted
 * whole and nothing needs scrolling to be seen.
 */
test('at a 1280 px window every control is fully visible without scrolling', async () => {
  await setZoomFactor(1.0);
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Main BrowserWindow was not found.');
    main.setContentSize(1280, 820);
  });
  await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBe(1280);

  const layout = await app.window.evaluate((ids) => {
    const strip = document.querySelector<HTMLElement>('[data-testid="library-header-controls"]');
    const header = document.querySelector<HTMLElement>('[data-testid="library-view"] > header');
    if (strip === null || header === null) throw new Error('The library header was not mounted.');
    const headerRect = header.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    return {
      overflow: strip.scrollWidth - strip.clientWidth,
      hidden: ids.filter((testId) => {
        const control = header.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (control === null) return true;
        const rect = control.getBoundingClientRect();
        const box = strip.contains(control) ? stripRect : headerRect;
        return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
      }),
    };
  }, [...HEADER_CONTROLS]);
  expect(layout.overflow, 'the control strip needs scrolling at 1280 px').toBeLessThanOrEqual(1);
  expect(layout.hidden, 'controls are cut off at 1280 px').toEqual([]);
  await expectTitleUncut();
});

/**
 * The same contract under real insufficient width.
 *
 * The window is taken to the app's own 960 px minimum and then to 200% browser
 * zoom, which is the narrowest library header the product can be asked to
 * paint. Below 920 CSS px the companion legitimately becomes the compact
 * drawer, so the drawer is opened and the two rows' heights are compared where
 * they really render; bottom edges are not compared there, because the drawer
 * is an overlay with its own origin and a shared page-origin bottom edge would
 * be an invented requirement. What the library header must still do is stay one
 * row tall and keep every control reachable.
 */
test('the library row stays one line, with every control reachable, at 200% zoom', async () => {
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Main BrowserWindow was not found.');
    const minimum = main.getMinimumSize();
    const minWidth = minimum[0];
    const minHeight = minimum[1];
    if (minWidth === undefined || minHeight === undefined) {
      throw new Error('The window reported no minimum size.');
    }
    main.setSize(minWidth, minHeight);
    main.webContents.setZoomFactor(2.0);
  });
  await expect.poll(async () => app.window.evaluate(() => window.innerWidth < 920), { timeout: 5_000 })
    .toBe(true);
  await app.window.waitForTimeout(350);

  const sideBySide = await app.window.evaluate(() => window.innerWidth) >= COMPACT_WIDTH;
  if (!sideBySide) {
    const drawerToggle = app.window.getByTestId('toggle-right-panel');
    if (await drawerToggle.isVisible()) await drawerToggle.click();
    await expect(app.window.getByTestId('compact-drawer-right')).toHaveAttribute('data-slide-phase', 'open');
    // The phase is set when the slide starts, so wait for the drawer to rest.
    await expect.poll(async () => app.window.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
      if (drawer === null) return false;
      const running = drawer.getAnimations().filter((animation) => animation.playState === 'running');
      return running.length === 0 && drawer.getBoundingClientRect().left < window.innerWidth;
    }), { timeout: 5_000 }).toBe(true);
  }

  const rows = await measureRows();
  console.log(
    `[library-header] 200% at ${String(rows.innerWidth)} CSS px (${sideBySide ? 'side-by-side' : 'compact drawer'}): `
    + `library ${rows.libraryHeight.toFixed(2)} px over ${rows.libraryWidth.toFixed(2)} px, `
    + `companion ${rows.companionHeight.toFixed(2)} px`
  );
  expect(rows.libraryHeight, 'the library header must have a real height at 200%').toBeGreaterThan(0);
  expect(Math.abs(rows.libraryHeight - rows.companionHeight), 'the two rows differ in height at 200%')
    .toBeLessThanOrEqual(TOLERANCE);
  if (sideBySide) {
    expect(Math.abs(rows.libraryBottom - rows.companionBottom), 'the two dividers are not on one line at 200%')
      .toBeLessThanOrEqual(TOLERANCE);
  }

  // The drawer is modal over the workspace, so it is dismissed before the
  // header behind it is exercised: reaching a control through an open overlay
  // is not what this asserts, and the app is right to block it.
  if (!sideBySide) {
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('compact-drawer-right')).toHaveCount(0);
  }

  // One line, and every control still has painted area once revealed.
  const controls = await inspectControls(HEADER_CONTROLS);
  for (const control of controls) {
    expect(control.centreInsideHeader, `"${control.testId}" left the header's line at 200%`).toBe(true);
    expect(control.visibleWidth, `"${control.testId}" cannot be brought into view at 200%`).toBeGreaterThan(0);
  }

  // Reachable in practice, not only in geometry: the import menu still opens
  // from its trigger and layers above the header at this width.
  await app.window.getByTestId('import-options-button').click();
  await expect(app.window.getByTestId('library-import-menu')).toBeVisible();
  const menu = await app.window.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="library-import-menu"]');
    if (element === null) throw new Error('The import menu was not mounted.');
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, right: rect.right, innerWidth: window.innerWidth };
  });
  expect(menu.width, 'the import menu is clipped to nothing').toBeGreaterThan(0);
  expect(menu.height, 'the import menu is clipped to nothing').toBeGreaterThan(0);
  expect(menu.right, 'the import menu is pushed off the viewport').toBeLessThanOrEqual(menu.innerWidth + 1);
  await app.window.keyboard.press('Escape');

  await setZoomFactor(1.0);
});
