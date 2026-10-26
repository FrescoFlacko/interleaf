import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/** The labels the companion bar owes the reader, in order. */
const TAB_LABELS = ['Chat', 'Search', 'Annotations', 'Agent'] as const;

/** WCAG 2.2 SC 2.5.8 target minimum. */
const MIN_TARGET = 24;

type StripGeometry = {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly tabs: readonly {
    readonly label: string;
    readonly truncated: boolean;
    readonly leftOfStrip: boolean;
    readonly rightOfStrip: boolean;
    readonly width: number;
  }[];
  /** Anything the bar carries beside its tabs; it carries nothing. */
  readonly extraControls: number;
};

/**
 * The companion tab bar is the one row that has to survive every width the
 * panel can take: a 280 px sidebar, the default column, and a small window at
 * 200 % zoom. It scrolls sideways as a last resort and its scrollbar is
 * hidden, so a label that does not fit is not merely awkward — it is invisible
 * and the tab behind it is unreachable by pointer. "Agent" was in exactly that
 * state at the default column, where the strip could show 262 px of a 277 px
 * row.
 */
test.describe('Companion tab strip', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-tab-strip-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Opens a document, which is what puts the companion panel on screen. */
  async function openDocument(): Promise<void> {
    const pdfPath = join(fixtureDir, 'companion-tabs.pdf');
    writeFileSync(
      pdfPath,
      makePdfFixture({
        title: 'Companion Tab Strip',
        author: 'Interleaf',
        pageLines: [['Body text for the companion tab strip fixture.']],
      })
    );
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture document was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
  }

  /**
   * Measures the strip the way a reader experiences it: whether the row needs
   * more width than it shows, whether any label is cut inside its own tab, and
   * whether any tab sits outside the part of the row that is painted.
   */
  async function readStrip(): Promise<StripGeometry> {
    return app.window.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.companion-tablist');
      const panel = document.querySelector<HTMLElement>('[data-testid="companion-panel"]');
      if (strip === null || panel === null) throw new Error('Companion tab strip is not rendered');
      const stripBox = strip.getBoundingClientRect();
      return {
        clientWidth: strip.clientWidth,
        scrollWidth: strip.scrollWidth,
        tabs: [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
          const box = tab.getBoundingClientRect();
          return {
            label: tab.textContent.trim(),
            // A label wider than the tab it is in is clipped by the tab.
            truncated: tab.scrollWidth > Math.ceil(tab.clientWidth),
            leftOfStrip: box.left < stripBox.left - 0.5,
            rightOfStrip: box.right > stripBox.right + 0.5,
            width: box.width,
          };
        }),
        extraControls: panel.querySelectorAll('[data-testid="companion-text-size"]').length,
      };
    });
  }

  /** Every label whole and inside the painted strip, with nothing else in the bar. */
  function expectNothingClipped(geometry: StripGeometry, at: string): void {
    expect(geometry.tabs.map((tab) => tab.label), at).toEqual([...TAB_LABELS]);
    // The row shows everything it has: no hidden overflow behind the hidden
    // scrollbar, which is the state that made a tab unreachable by pointer.
    expect(geometry.scrollWidth, at).toBeLessThanOrEqual(geometry.clientWidth);
    for (const tab of geometry.tabs) {
      expect(tab.truncated, `${at}: ${tab.label} label is cut off`).toBe(false);
      expect(tab.leftOfStrip || tab.rightOfStrip, `${at}: ${tab.label} sits outside the strip`).toBe(false);
      expect(tab.width, `${at}: ${tab.label} has no usable target`).toBeGreaterThanOrEqual(MIN_TARGET);
    }
    expect(geometry.extraControls, at).toBe(0);
  }

  /** Keyboard resize: End goes to the 560 px maximum, each ArrowRight removes 16 px. */
  async function setPanelWidth(width: number): Promise<void> {
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    for (let step = 0; step < (560 - width) / 16; step += 1) await app.window.keyboard.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(width));
  }

  test('keeps every tab label and control visible from the default column down to the 280 px minimum', async () => {
    await openDocument();

    const atDefault = await readStrip();
    expectNothingClipped(atDefault, 'default column');

    for (const width of [560, 480, 352, 280] as const) {
      // `setPanelWidth` returns only once the resizer reports the new width,
      // so the strip has already been laid out at it.
      await setPanelWidth(width);
      const geometry = await readStrip();
      expectNothingClipped(geometry, `panel ${String(width)} px`);
    }

    // Every tab is also still operable by pointer at the narrowest width.
    for (const label of TAB_LABELS) {
      const tab = app.window.getByRole('tab', { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('keeps them visible in a 960x640 window at 200% zoom', async () => {
    await openDocument();

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main BrowserWindow not found');
      win.setSize(960, 640);
      win.webContents.setZoomFactor(2);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(600);

    // At this size the companion panel is a drawer; opening it is the only way
    // to see the row the reader would use.
    const toggle = app.window.getByTestId('toggle-right-panel');
    if (await toggle.isVisible()) await toggle.click();
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();

    expectNothingClipped(await readStrip(), '960x640 at 200% zoom');

    // 100% zoom in the same small window keeps the panel at its minimum width.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThan(900);
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    expectNothingClipped(await readStrip(), '960x640 at 100% zoom');
  });
});
