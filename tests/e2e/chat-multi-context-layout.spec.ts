import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissOnboardingIfOpen, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import {
  expectComposerAligned,
  expectComposerRowContains,
  expectLabelIntact,
  measureComposerAlignment,
} from './composer-alignment';
import { createOmpCliFixture, OMP_FIXTURE_MODEL_NAME } from './omp-cli-fixture';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * The reported composer row, at the widths it was reported at.
 *
 * The reader's screenshot shows a specific combination: a short provider name
 * ("Omp"), a long model name ("Gemini 3.8 Flash"), the context meter, and Send,
 * with several page chips pinned above them. That combination is what the
 * removed `min-width` floor mis-sized, so it is the combination the test has to
 * put on screen — a provider with one model hides the model selector entirely
 * and proves nothing about the row.
 *
 * `Omp` is a CLI provider whose model list comes from running its binary, so
 * the fixture is an offline stand-in for that binary on `PATH`. Nothing reaches
 * the network and nothing is billed.
 */

/** Chooses the reported Omp model in the composer's picker, by its visible name. */
async function chooseOmpModel(page: Page, chat: Locator): Promise<void> {
  await chat.getByTestId('chat-model-picker').click();
  const picker = page.getByTestId('chat-model-picker-popover');
  await picker.getByRole('group', { name: 'Omp', exact: true })
    .getByRole('option', { name: new RegExp(OMP_FIXTURE_MODEL_NAME.replace(/\./gu, '\\.'), 'u') }).click();
  await expect(picker).toHaveCount(0);
  await expect(chat.getByTestId('chat-model-picker')).toContainText(OMP_FIXTURE_MODEL_NAME);
  await expect(chat.getByTestId('chat-model-picker')).toContainText('Omp');
}

/** The supported minimum for the right sidebar, and the width the defect shows at. */
const MINIMUM_WIDTH = 280;

/** Page ranges to pin, chosen to wrap the chip row at the minimum width. */
const RANGES: readonly (readonly [number, number])[] = [[1, 2], [3, 4], [5, 5], [6, 7], [7, 8]];

test.describe('chat composer with several page contexts attached', () => {
  let app: AppHandle;
  let workspace: string;
  let binDir: string;

  test.beforeEach(async () => {
    binDir = createOmpCliFixture();
    app = await launchInterleaf({ binDir });
    workspace = mkdtempSync(join(tmpdir(), 'interleaf-multi-context-'));
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  async function openDocument(pages: number): Promise<void> {
    const pdfPath = join(workspace, 'multi-context.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Attention Is All You Need',
      author: 'Interleaf',
      pageLines: Array.from({ length: pages }, (_, index) => [
        `Scaled dot-product attention and multi-head attention, page ${String(index + 1)}.`,
      ]),
    }));
    await dismissOnboardingIfOpen(app);
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture document was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
  }

  /** Keyboard resize: Home is the 280 px minimum for this panel. */
  async function setMinimumPanelWidth(): Promise<void> {
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(MINIMUM_WIDTH));
    await app.window.waitForTimeout(350);
  }

  async function setZoom(factor: number): Promise<void> {
    await app.electronApp.evaluate(({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(value);
    }, factor);
    await app.window.waitForTimeout(500);
  }

  /**
   * The Chat region the reader is looking at.
   *
   * Narrow layouts move Chat into a drawer that slides in over the reader. The
   * drawer is mounted and laid out before it has finished sliding, so this waits
   * for the slide to rest before handing back a region to measure — otherwise
   * the geometry would be real and entirely off-screen.
   */
  async function visibleChatRegion(): Promise<Locator> {
    const drawerToggle = app.window.getByTestId('toggle-right-panel');
    const drawer = app.window.getByTestId('compact-drawer-right');
    if (await drawer.count() === 0 && await drawerToggle.count() > 0 && await drawerToggle.isVisible()) {
      const panel = app.window.getByTestId('companion-panel');
      if (await panel.count() === 0) await drawerToggle.click();
    }
    if (await drawer.count() > 0) {
      await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
      await expect(drawer).toBeInViewport({ ratio: 0.9 });
    }
    const region = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(region).toBeVisible();
    return region;
  }
  async function lastControlToSendGap(region: Locator): Promise<number> {
    return region.evaluate((root: HTMLElement) => {
      const toolbar = root.querySelector<HTMLElement>('.chat-design-controls');
      const send = root.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
      const controls = toolbar ? Array.from(toolbar.children).filter((child) => child !== send) : [];
      const lastControl = controls[controls.length - 1];
      const lastRight = lastControl ? lastControl.getBoundingClientRect().right : 0;
      const sendLeft = send ? send.getBoundingClientRect().left : 0;
      return sendLeft - lastRight;
    });
  }
  async function sendToComposerRightGap(region: Locator): Promise<number> {
    return region.evaluate((root: HTMLElement) => {
      const composer = root.querySelector<HTMLElement>('.chat-design-composer');
      const send = root.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
      const composerRight = composer ? composer.getBoundingClientRect().right : 0;
      const paddingRight = composer ? parseFloat(window.getComputedStyle(composer).paddingRight) : 0;
      const sendRight = send ? send.getBoundingClientRect().right : 0;
      return composerRight - paddingRight - sendRight;
    });
  }

  test('shrinks a long model label beside Send at wide, middle and narrow pane widths', async () => {
    await openDocument(1);
    await app.window.getByRole('tab', { name: 'AI Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    const provider = chat.getByTestId('chat-model-picker');
    await expect(provider).toBeVisible();
    await expect(chat.getByTestId('send-chat-button')).toBeVisible();

    const measure = async () => app.window.evaluate(() => {
      const providerElement = document.querySelector<HTMLButtonElement>('[data-testid="chat-model-picker"]')!;
      const providerLabel = document.querySelector<HTMLElement>('[data-testid="chat-model-picker"] .chat-model-trigger-model')!;
      const sendRect = document.querySelector<HTMLElement>('[data-testid="send-chat-button"]')!.getBoundingClientRect();
      const form = document.querySelector<HTMLFormElement>('form:has(#chat-composer)')!;
      // Reapply after React updates from pane resizing.
      providerLabel.textContent = 'A model with a very long display name that must shrink at narrow widths';
      const providerRect = providerElement.getBoundingClientRect();
      return {
        providerWidth: providerRect.width,
        providerRight: providerRect.right,
        providerTop: providerRect.top,
        providerBottom: providerRect.bottom,
        sendLeft: sendRect.left,
        sendRight: sendRect.right,
        sendTop: sendRect.top,
        sendBottom: sendRect.bottom,
        formRight: form.getBoundingClientRect().right,
        formOverflowX: form.scrollWidth - form.clientWidth,
        providerLabelLength: providerLabel.textContent.length,
      };
    });

    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    await app.window.waitForTimeout(350);
    const wide = await measure();
    expect(wide.providerLabelLength).toBeGreaterThan(20);

    await resizer.focus();
    await app.window.keyboard.press('Home');
    await Array.from({ length: 5 }).reduce<Promise<void>>(
      async (previous) => previous.then(async () => app.window.keyboard.press('ArrowLeft')),
      Promise.resolve()
    );
    await app.window.waitForTimeout(350);
    const middle = await measure();

    await setMinimumPanelWidth();
    const narrow = await measure();

    expect(middle.providerWidth).toBeLessThan(wide.providerWidth - 1);
    expect(middle.sendRight).toBeLessThanOrEqual(middle.formRight + 1);
    expect(middle.sendTop).toBeLessThan(middle.providerBottom);
    expect(middle.sendBottom).toBeGreaterThan(middle.providerTop);
    expect(narrow.providerWidth).toBeLessThan(wide.providerWidth - 1);
    expect(narrow.providerWidth).toBeGreaterThan(80);
    expect(narrow.providerRight).toBeLessThanOrEqual(narrow.formRight + 1);
    expect(narrow.sendRight).toBeLessThanOrEqual(narrow.formRight + 1);
    expect(narrow.sendLeft).toBeGreaterThanOrEqual(narrow.providerRight - 1);
    expect(narrow.sendTop).toBeLessThan(narrow.providerBottom);
    expect(narrow.sendBottom).toBeGreaterThan(narrow.providerTop);
    expect(narrow.formOverflowX).toBeLessThanOrEqual(1);

    // The model picker trigger stays keyboard reachable at the minimum width;
    // no provider request is made.
    await provider.focus();
    await app.window.keyboard.press('Tab');
    await app.window.keyboard.press('Shift+Tab');
    await expect(provider).toBeFocused();
  });

  test('keeps Omp, a long model name, the meter and Send aligned at the minimum width and at 200% zoom', async () => {
    await openDocument(8);

    await app.window.getByRole('tab', { name: 'AI Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();

    // The reported provider, and the reported model beside it.
    await chooseOmpModel(app.window, chat);

    // The reported state: several page ranges pinned at once, attached through
    // the real popover rather than written into the store.
    for (const [start, end] of RANGES) {
      const trigger = chat.getByRole('button', { name: 'Add pages to AI context' });
      await trigger.click();
      await app.window.getByLabel('Start page for context').fill(String(start));
      await app.window.getByLabel('End page for context').fill(String(end));
      await app.window.getByRole('button', { name: 'Add range' }).click();
      await expect(trigger).toBeFocused();
    }
    await expect(chat.getByTestId('chat-context-summary')).toContainText(`${String(RANGES.length)} items`);
    const ordinaryRegion = await visibleChatRegion();
    const ordinary = await measureComposerAlignment(ordinaryRegion);
    expectComposerRowContains(ordinary, ['Omp', OMP_FIXTURE_MODEL_NAME], 'ordinary panel width');
    expectLabelIntact(ordinary, OMP_FIXTURE_MODEL_NAME, 'ordinary panel width');
    expect(ordinary.chipCount, 'every pinned range must still have a chip').toBe(RANGES.length);
    expectComposerAligned(ordinary, 'ordinary panel width');
    expect(await sendToComposerRightGap(ordinaryRegion), 'ordinary panel width Send pinned to right').toBeLessThanOrEqual(2);
    expect(await lastControlToSendGap(ordinaryRegion), 'ordinary panel width toolbar and Send do not overlap').toBeGreaterThanOrEqual(4);

    // Minimum panel width (280px)
    await setMinimumPanelWidth();
    const narrowRegion = await visibleChatRegion();
    const narrow = await measureComposerAlignment(narrowRegion);
    expectComposerRowContains(narrow, ['Omp', OMP_FIXTURE_MODEL_NAME], 'minimum panel width');
    expectLabelIntact(narrow, OMP_FIXTURE_MODEL_NAME, 'minimum panel width');
    expect(narrow.chipCount, 'every pinned range must still have a chip').toBe(RANGES.length);
    expectComposerAligned(narrow, 'minimum panel width');
    expect(await sendToComposerRightGap(narrowRegion), 'minimum width Send pinned to right').toBeLessThanOrEqual(2);
    expect(await lastControlToSendGap(narrowRegion), 'minimum width gap before Send').toBeGreaterThanOrEqual(4);

    // 200% halves the CSS viewport: the same row, half the room.
    await setZoom(2.0);
    const zoomedRegion = await visibleChatRegion();
    const zoomed = await measureComposerAlignment(zoomedRegion);
    expectComposerRowContains(zoomed, ['Omp', OMP_FIXTURE_MODEL_NAME], '200% zoom');
    expectLabelIntact(zoomed, OMP_FIXTURE_MODEL_NAME, '200% zoom');
    expect(zoomed.chipCount, 'every pinned range must still have a chip at 200%').toBe(RANGES.length);
    expectComposerAligned(zoomed, '200% zoom');
    expect(await sendToComposerRightGap(zoomedRegion), '200% zoom Send pinned to right').toBeLessThanOrEqual(2);
    expect(await lastControlToSendGap(zoomedRegion), '200% zoom gap before Send').toBeGreaterThanOrEqual(4);

    await setZoom(1.0);
  });
  test('pins Send to the right content edge in the reported single-page-range state (Pages 56-62)', async () => {
    await openDocument(70);

    await app.window.getByRole('tab', { name: 'AI Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();

    // Configure Omp and Gemini 3.8 Flash
    await chooseOmpModel(app.window, chat);

    // Attach exact reported range: Pages 56-62
    const trigger = chat.getByRole('button', { name: 'Add pages to AI context' });
    await trigger.click();
    await app.window.getByLabel('Start page for context').fill('56');
    await app.window.getByLabel('End page for context').fill('62');
    await app.window.getByRole('button', { name: 'Add range' }).click();
    await expect(trigger).toBeFocused();
    await expect(chat.getByTestId('chat-context-summary')).toContainText('Context · 1 item');

    // 1. Ordinary width: Send is pinned to the right content edge
    const ordinaryRegion = await visibleChatRegion();
    const ordinary = await measureComposerAlignment(ordinaryRegion);
    expectComposerRowContains(ordinary, ['Omp', OMP_FIXTURE_MODEL_NAME], 'single range - ordinary width');
    expectLabelIntact(ordinary, OMP_FIXTURE_MODEL_NAME, 'single range - ordinary width');
    expect(await sendToComposerRightGap(ordinaryRegion), 'single range Send pinned to right edge').toBeLessThanOrEqual(2);
    expect(await sendToComposerRightGap(ordinaryRegion), 'single range Send inside right edge').toBeGreaterThanOrEqual(-1);
    expect(await lastControlToSendGap(ordinaryRegion), 'single range toolbar and Send do not overlap').toBeGreaterThanOrEqual(4);
    expect(ordinary.sendInside, 'Send inside composer').toBe(true);
    expect(ordinary.chipsOutside, 'no chip outside').toBe(0);

    // 2. Minimum panel width (280px): Send remains pinned to the right edge with compact separation
    await setMinimumPanelWidth();
    const narrowRegion = await visibleChatRegion();
    const narrow = await measureComposerAlignment(narrowRegion);
    expectComposerRowContains(narrow, ['Omp', OMP_FIXTURE_MODEL_NAME], 'single range - 280px width');
    expectLabelIntact(narrow, OMP_FIXTURE_MODEL_NAME, 'single range - 280px width');
    expect(await sendToComposerRightGap(narrowRegion), 'single range Send pinned to right edge at 280px').toBeLessThanOrEqual(2);
    expect(await sendToComposerRightGap(narrowRegion), 'single range Send inside right edge at 280px').toBeGreaterThanOrEqual(-1);
    expect(await lastControlToSendGap(narrowRegion), 'tight separation before Send at 280px').toBeGreaterThanOrEqual(4);
    expect(narrow.sendInside, 'Send inside composer at 280px').toBe(true);
    expect(narrow.chipsOutside, 'no chip outside at 280px').toBe(0);

    // 3. 200% zoom: Send remains pinned to the right edge with compact separation
    await setZoom(2.0);
    const zoomedRegion = await visibleChatRegion();
    const zoomed = await measureComposerAlignment(zoomedRegion);
    expectComposerRowContains(zoomed, ['Omp', OMP_FIXTURE_MODEL_NAME], 'single range - 200% zoom');
    expectLabelIntact(zoomed, OMP_FIXTURE_MODEL_NAME, 'single range - 200% zoom');
    expect(await sendToComposerRightGap(zoomedRegion), 'single range Send pinned to right edge at 200%').toBeLessThanOrEqual(2);
    expect(await sendToComposerRightGap(zoomedRegion), 'single range Send inside right edge at 200%').toBeGreaterThanOrEqual(-1);
    expect(await lastControlToSendGap(zoomedRegion), 'tight separation before Send at 200%').toBeGreaterThanOrEqual(4);
    expect(zoomed.sendInside, 'Send inside composer at 200%').toBe(true);
    expect(zoomed.chipsOutside, 'no chip outside at 200%').toBe(0);

    await setZoom(1.0);
  });
});
