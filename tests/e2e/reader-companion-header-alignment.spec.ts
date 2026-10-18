import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * The reader header and the companion tab bar are one line across the window.
 *
 * The two rows start at the same y and carry the same bottom hairline, so any
 * difference in their height shows as a step in that line. Before this
 * contract the reader header was 45 CSS px (its own `py-2` padding around a
 * 28 px control group) against the companion bar's 43 px, and the divider
 * under the document sat 2 px low. Only the running engine can answer where
 * those edges actually land — the heights come from Tailwind utilities, a
 * custom property and a border-box together — so this measures rendered rects
 * in the shipped window rather than asserting a class name.
 */

/** Half a CSS pixel: the 2 px defect is an order of magnitude above it. */
const TOLERANCE = 0.5;

/** Below this window width the companion moves into the compact drawer. */
const COMPACT_WIDTH = 920;

type Rows = {
  readonly readerHeight: number;
  readonly readerBottom: number;
  readonly companionHeight: number;
  readonly companionBottom: number;
  readonly innerWidth: number;
};

let app: AppHandle;
let workspace: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'interleaf-header-align-'));
  app = await launchInterleaf();
  const pdfPath = join(workspace, 'header-alignment.pdf');
  writeFileSync(pdfPath, makePdfFixture({
    title: 'A Document With A Title Long Enough To Truncate In The Header',
    author: 'Interleaf',
    pageLines: [['The reader header sits beside the companion tab bar.']],
  }));
  await stubOpenDialog(app, [pdfPath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  if (document === undefined) throw new Error('Fixture document was not imported.');
  await app.window.getByTestId(`read-doc-${document.id}`).click();
  await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

/** Both rows as painted: the header, and the row that holds the tablist. */
async function measureRows(): Promise<Rows> {
  return app.window.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="reader-header-toolbar"]');
    if (header === null) throw new Error('The reader header was not mounted.');
    const tablist = document.querySelector<HTMLElement>('[data-testid="companion-panel"] [role="tablist"]');
    if (tablist === null) throw new Error('The companion tab bar was not mounted.');
    const companionRow = tablist.parentElement;
    if (companionRow === null) throw new Error('The companion tab bar has no row.');
    const headerRect = header.getBoundingClientRect();
    const companionRect = companionRow.getBoundingClientRect();
    return {
      readerHeight: headerRect.height,
      readerBottom: headerRect.bottom,
      companionHeight: companionRect.height,
      companionBottom: companionRect.bottom,
      innerWidth: window.innerWidth,
    };
  });
}

/**
 * The right drawer once it has finished sliding in, as geometry rather than as
 * a phase attribute.
 *
 * `data-slide-phase="open"` is set at the *start* of the 280 ms transform from
 * off-screen, so a measurement taken on it can read a drawer that is still
 * outside the viewport — which is how an evidence capture ended up showing
 * only the backdrop. These are the conditions that can only hold at rest: no
 * transition still running on the drawer, no residual x translation, the
 * drawer's own edge on the viewport's right edge, and real visible area for
 * both the drawer and the companion tab row inside it.
 */
type DrawerRest = {
  readonly translateX: number;
  readonly animations: number;
  readonly width: number;
  readonly expectedWidth: number;
  readonly left: number;
  readonly right: number;
  readonly innerWidth: number;
  readonly drawerVisibleArea: number;
  readonly rowVisibleArea: number;
};

async function measureRightDrawer(): Promise<DrawerRest> {
  return app.window.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
    if (drawer === null) throw new Error('The right drawer was not mounted.');
    const tablist = drawer.querySelector<HTMLElement>('[data-testid="companion-panel"] [role="tablist"]');
    if (tablist === null) throw new Error('The drawer holds no companion tab bar.');
    const row = tablist.parentElement;
    if (row === null) throw new Error('The companion tab bar has no row.');

    const visibleArea = (element: HTMLElement): number => {
      const rect = element.getBoundingClientRect();
      const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      return width <= 0 || height <= 0 ? 0 : width * height;
    };

    const transform = getComputedStyle(drawer).transform;
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? '' : transform);
    const rect = drawer.getBoundingClientRect();
    return {
      translateX: matrix.m41,
      // A CSS transition is an animation here until it finishes.
      animations: drawer.getAnimations().filter((animation) => animation.playState === 'running').length,
      width: rect.width,
      // The component's own contract: `w-[min(340px,85vw)]`, pinned `right-0`.
      expectedWidth: Math.min(340, window.innerWidth * 0.85),
      left: rect.left,
      right: rect.right,
      innerWidth: window.innerWidth,
      drawerVisibleArea: visibleArea(drawer),
      rowVisibleArea: visibleArea(row),
    };
  });
}

/** Waits for the slide to finish, then holds the component's resting contract. */
async function waitForRestingRightDrawer(): Promise<DrawerRest> {
  await expect.poll(async () => {
    const drawer = await measureRightDrawer();
    return drawer.animations === 0
      && Math.abs(drawer.translateX) <= TOLERANCE
      && drawer.drawerVisibleArea > 0
      && drawer.rowVisibleArea > 0;
  }, { timeout: 5_000 }).toBe(true);

  const drawer = await measureRightDrawer();
  expect(Math.abs(drawer.translateX), 'the drawer is still translated').toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(drawer.width - drawer.expectedWidth), 'the drawer is not its contracted width')
    .toBeLessThanOrEqual(1);
  expect(Math.abs(drawer.right - drawer.innerWidth), 'the drawer is not resting on the right edge')
    .toBeLessThanOrEqual(1);
  expect(drawer.left, 'the drawer starts outside the viewport').toBeGreaterThanOrEqual(-1);
  expect(drawer.drawerVisibleArea, 'the drawer has no visible area').toBeGreaterThan(0);
  expect(drawer.rowVisibleArea, 'the companion tab row has no visible area').toBeGreaterThan(0);
  return drawer;
}

async function setZoomFactor(factor: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, value) => {
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Main BrowserWindow was not found.');
    main.webContents.setZoomFactor(value);
  }, factor);
}

test('the reader header and the companion tab bar share a height and a bottom edge at 100%', async () => {
  await setZoomFactor(1.0);
  await expect(app.window.getByTestId('companion-panel')).toBeVisible();

  const rows = await measureRows();
  expect(rows.innerWidth, 'this check needs the side-by-side layout').toBeGreaterThanOrEqual(COMPACT_WIDTH);

  console.log(
    `[header-alignment] 100%: reader ${rows.readerHeight.toFixed(2)} px (bottom ${rows.readerBottom.toFixed(2)}), `
    + `companion ${rows.companionHeight.toFixed(2)} px (bottom ${rows.companionBottom.toFixed(2)})`
  );
  expect(Math.abs(rows.readerHeight - rows.companionHeight), 'the two rows differ in height')
    .toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(rows.readerBottom - rows.companionBottom), 'the two dividers are not on one line')
    .toBeLessThanOrEqual(TOLERANCE);
});

/**
 * The same contract at 200% browser zoom.
 *
 * The window is first enlarged to the display's work area so that 200% zoom
 * may still leave more than 920 CSS px of width; when it does, the full
 * side-by-side equality is asserted exactly as at 100%. On a display too small
 * for that, the companion legitimately becomes the compact drawer and no
 * side-by-side state exists to measure: the drawer is opened, waited for at
 * rest inside the viewport (see `waitForRestingRightDrawer`), and the two rows'
 * heights are compared where they really render. Bottom edges are not compared
 * in that case because the drawer is an overlay with its own origin — a
 * shared bottom edge there would be an invented requirement.
 */
test('the shared height survives 200% browser zoom', async () => {
  const workArea = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Main BrowserWindow was not found.');
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    main.setSize(width, height);
    main.webContents.setZoomFactor(2.0);
    return { width, height };
  });
  expect(workArea.width).toBeGreaterThan(0);
  await expect.poll(async () => app.window.evaluate(() => window.devicePixelRatio > 0)).toBe(true);
  await app.window.waitForTimeout(350);

  const sideBySide = await app.window.evaluate(() => window.innerWidth) >= COMPACT_WIDTH;
  if (!sideBySide) {
    const drawerToggle = app.window.getByTestId('toggle-right-panel');
    if (await drawerToggle.isVisible()) await drawerToggle.click();
    await expect(app.window.getByTestId('compact-drawer-right'))
      .toHaveAttribute('data-slide-phase', 'open');
    // The phase only says the slide has begun. Measure at rest.
    const drawer = await waitForRestingRightDrawer();
    console.log(
      `[header-alignment] 200%: drawer at rest — left ${drawer.left.toFixed(2)}, `
      + `right ${drawer.right.toFixed(2)} of ${String(drawer.innerWidth)} CSS px, `
      + `width ${drawer.width.toFixed(2)} (contract ${drawer.expectedWidth.toFixed(2)}), `
      + `tab row visible area ${drawer.rowVisibleArea.toFixed(0)} px²`
    );
  }

  const rows = await measureRows();
  console.log(
    `[header-alignment] 200%: ${sideBySide ? 'side-by-side' : 'compact drawer'} at `
    + `${String(rows.innerWidth)} CSS px — reader ${rows.readerHeight.toFixed(2)} px, `
    + `companion ${rows.companionHeight.toFixed(2)} px`
  );
  expect(rows.readerHeight, 'the header must have a real height at 200%').toBeGreaterThan(0);
  expect(Math.abs(rows.readerHeight - rows.companionHeight), 'the two rows differ in height at 200%')
    .toBeLessThanOrEqual(TOLERANCE);
  if (sideBySide) {
    expect(Math.abs(rows.readerBottom - rows.companionBottom), 'the two dividers are not on one line at 200%')
      .toBeLessThanOrEqual(TOLERANCE);
  }

  await setZoomFactor(1.0);
});
