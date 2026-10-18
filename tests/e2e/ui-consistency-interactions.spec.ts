import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';

/**
 * Interaction claims of the UI consistency work that only a real Chromium
 * layout and focus model can prove: Tab out of the header theme menu, one menu
 * recipe across the three pickers, a theme change that does not move the
 * gallery, and a library sidebar that cannot be scrolled sideways.
 */

async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.dataset.testid ?? (active.id !== '' ? active.id : active.tagName) : null;
  });
}

type MenuRecipe = {
  readonly surface: Readonly<Record<string, string>>;
  readonly item: Readonly<Record<string, string | number>>;
};

/** The computed properties the shared menu recipe fixes, for a surface and its first row. */
async function menuRecipe(surface: Locator, item: Locator): Promise<MenuRecipe> {
  const surfaceStyle = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: style.borderTopLeftRadius,
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      // Utility shadows carry fully transparent ring layers; they paint nothing.
      shadow: style.boxShadow.split(/,(?![^(]*\))/u).map((layer) => layer.trim())
        .filter((layer) => !layer.startsWith('rgba(0, 0, 0, 0) ')).join(', '),
      padding: style.paddingTop,
    };
  });
  const itemStyle = await item.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: Math.round(element.getBoundingClientRect().height),
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      borderRadius: style.borderTopLeftRadius,
      paddingLeft: style.paddingLeft,
    };
  });
  return { surface: surfaceStyle, item: itemStyle };
}

test.describe('UI consistency interactions', () => {
  let app: AppHandle | undefined;
  let fixtureDir: string;

  test.beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-ui-interactions-'));
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('Tab out of the open theme menu continues from the trigger, and the fading menu is inert', async () => {
    app = await launchInterleaf();
    const page = app.window;
    const trigger = page.getByTestId('theme-menu-trigger');

    // Where the header's own order goes from the closed trigger, both ways.
    await trigger.focus();
    await page.keyboard.press('Tab');
    const forward = await focusedTestId(page);
    await trigger.focus();
    await page.keyboard.press('Shift+Tab');
    const backward = await focusedTestId(page);
    expect(forward).not.toBe('theme-menu-trigger');

    for (const [key, expected] of [['Tab', forward], ['Shift+Tab', backward]] as const) {
      await trigger.click();
      const menu = page.getByTestId('theme-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[aria-checked="true"]')).toBeFocused();
      await page.keyboard.press(key);
      // During its exit fade the menu takes no input and no focus.
      const exiting = await menu.evaluate((element) => ({
        phase: element.dataset.phase ?? null,
        inert: element instanceof HTMLElement && element.inert,
        hidden: element.getAttribute('aria-hidden'),
      }));
      expect(exiting).toEqual({ phase: 'exiting', inert: true, hidden: 'true' });
      expect(await focusedTestId(page)).toBe(expected);
      await expect(menu).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    }

    // Escape still hands focus back to the trigger.
    await trigger.click();
    await expect(page.getByTestId('theme-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('the model picker, the listbox and the theme menu share one surface and row recipe', async () => {
    const markdownPath = join(fixtureDir, 'Menus.md');
    writeFileSync(markdownPath, '# Menus\n\nA page to open the companion beside.');
    app = await launchInterleaf();
    const page = app.window;
    await stubOpenDialog(app, [markdownPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
    if (entry === undefined) throw new Error('Fixture was not imported.');
    await page.getByTestId(`read-doc-${entry.id}`).click();
    await expect(page.getByTestId('markdown-scroll-container')).toBeVisible();

    await page.getByTestId('theme-menu-trigger').click();
    const themeMenu = page.getByTestId('theme-menu');
    await expect(themeMenu).toBeVisible();
    // Entry animation settles before measuring.
    await page.waitForTimeout(250);
    const theme = await menuRecipe(themeMenu, themeMenu.locator('[role="menuitemradio"]').first());
    await page.keyboard.press('Escape');
    await expect(themeMenu).toHaveCount(0);

    await page.getByRole('tab', { name: /Chat/i }).click();
    await page.getByTestId('chat-model-picker').click();
    const chatPicker = page.getByTestId('chat-model-picker-popover');
    await expect(chatPicker).toBeVisible();
    await page.waitForTimeout(250);
    const chatItem = chatPicker.locator('[role="option"], [data-testid="chat-provider-edit"]').first();
    const chat = await menuRecipe(chatPicker, chatItem);
    await page.keyboard.press('Escape');
    await expect(chatPicker).toHaveCount(0);

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-rail-theme').click();
    const combobox = page.getByTestId('settings-reader-background');
    await combobox.click();
    await expect(combobox).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.locator(`[id="${String(await combobox.getAttribute('aria-controls'))}"]`);
    await expect(listbox).toBeVisible();
    await page.waitForTimeout(250);
    // "Match app theme" carries no description, so it is a plain one-line row.
    const select = await menuRecipe(listbox, listbox.locator('[role="option"][data-value="palette"]'));

    // The model picker is a searchable list: its search field runs edge to
    // edge and a row can carry a second, model-ID line. It shares the surface
    // and the row type, not the padding or the row height.
    expect({ ...chat.surface, padding: theme.surface.padding }).toEqual(theme.surface);
    expect(chat.item.fontSize).toBe(theme.item.fontSize);
    expect(select).toEqual(theme);
  });

  test('choosing a theme in the gallery leaves the gallery where it was', async () => {
    app = await launchInterleaf();
    const page = app.window;
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-rail-theme').click();
    const anchor = page.getByTestId('theme-option-paper');
    await expect(anchor).toBeVisible();
    const before = await anchor.boundingBox();

    // Sample the card's box on every frame across the change and its fade.
    const samples = await page.evaluate(async () => {
      const card = document.querySelector<HTMLElement>('[data-testid="theme-option-paper"]');
      const target = document.querySelector<HTMLElement>('[data-testid="theme-option-heather"]');
      if (card === null || target === null) throw new Error('Gallery is not open.');
      const boxes: { x: number; y: number }[] = [];
      target.click();
      const end = performance.now() + 600;
      while (performance.now() < end) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
        const box = card.getBoundingClientRect();
        boxes.push({ x: box.x, y: box.y });
      }
      return boxes;
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'heather');
    expect(samples.length).toBeGreaterThan(5);
    for (const sample of samples) expect(sample).toEqual({ x: before?.x, y: before?.y });
    // The saved status is announced in the footer, not above the gallery.
    await expect(page.getByText('Settings saved on this device.')).toBeVisible();
    expect((await anchor.boundingBox())?.y).toBe(before?.y);
  });

  test('the library sidebar cannot be scrolled sideways and keeps its 16px inset', async () => {
    app = await launchInterleaf();
    const page = app.window;
    const panel = page.getByTestId('resizable-panel-left');
    await expect(panel).toBeVisible();

    // A programmatic scroll is what used to shift it; focus the far edge too.
    const scroll = await panel.evaluate((element) => {
      element.scrollLeft = 40;
      element.querySelector<HTMLElement>('[data-testid="library-summary-footer"]')?.scrollIntoView({ inline: 'end' });
      const content = element.querySelector<HTMLElement>('[data-testid="resizable-panel-left-content"]');
      return {
        scrollLeft: element.scrollLeft,
        overflowX: getComputedStyle(element).overflowX,
        contentWidth: content?.getBoundingClientRect().width ?? 0,
        clientWidth: element.clientWidth,
      };
    });
    expect(scroll.scrollLeft).toBe(0);
    expect(scroll.overflowX).toBe('clip');
    expect(scroll.contentWidth).toBeLessThanOrEqual(scroll.clientWidth);

    const inset = await panel.evaluate((element) => {
      const nav = element.querySelector('nav[aria-label="Library sections"]');
      const left = element.getBoundingClientRect().left;
      return nav === null ? null : Math.round(nav.getBoundingClientRect().left - left);
    });
    expect(inset).toBe(16);
  });

  test('a listbox opened inside the compact drawer at 200% zoom opens under its trigger, on screen', async () => {
    const markdownPath = join(fixtureDir, 'Drawer.md');
    writeFileSync(markdownPath, '# Drawer\n\nA page to open the companion drawer beside.');
    app = await launchInterleaf();
    const page = app.window;
    await stubOpenDialog(app, [markdownPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
    if (entry === undefined) throw new Error('Fixture was not imported.');
    await page.getByTestId(`read-doc-${entry.id}`).click();
    await expect(page.getByTestId('markdown-scroll-container')).toBeVisible();

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (!main) throw new Error('Main BrowserWindow was not found.');
      main.setContentSize(1440, 900);
      main.webContents.setZoomFactor(2);
    });
    await expect.poll(async () => page.evaluate(() => window.innerWidth < 920)).toBe(true);
    await page.getByTestId('toggle-right-panel').click();
    const drawer = page.getByTestId('compact-drawer-right');
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect.poll(async () => drawer.evaluate((node) =>
      node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
    await page.locator('#companion-tab-annotations').click();

    // The drawer rests at an identity transform, which makes it the containing
    // block of the portalled list; the list must still land under its trigger.
    const sort = page.getByRole('combobox', { name: 'Sort annotations' });
    await sort.click();
    const listbox = page.locator(`[id="${String(await sort.getAttribute('aria-controls'))}"]`);
    await expect(listbox).toBeVisible();
    await page.waitForTimeout(250);
    const geometry = await page.evaluate((id) => {
      const list = document.getElementById(id);
      const trigger = document.querySelector<HTMLElement>('[aria-label="Sort annotations"]');
      if (list === null || trigger === null) throw new Error('The sort listbox is not open.');
      const box = list.getBoundingClientRect();
      const anchor = trigger.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, anchorBottom: anchor.bottom, innerWidth: window.innerWidth };
    }, String(await sort.getAttribute('aria-controls')));
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.innerWidth);
    expect(Math.abs(geometry.top - geometry.anchorBottom - 6)).toBeLessThanOrEqual(1);
    await listbox.locator('[role="option"]').last().click();
    await expect(listbox).toHaveCount(0);
  });

  test('the agent page-range popover opens on screen, above its trigger, at 100% and in the 200% drawer', async () => {
    const pdfPath = join(fixtureDir, 'Pages.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Pages', author: 'Interleaf', pageLines: [['Page 1'], ['Page 2'], ['Page 3']] }));
    app = await launchInterleaf({ testSeam: true });
    const handle = app;
    const page = handle.window;
    await handle.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900); });
    await stubOpenDialog(handle, [pdfPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
    if (entry === undefined) throw new Error('Fixture was not imported.');
    await page.getByTestId(`read-doc-${entry.id}`).click();
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
    await page.getByRole('tab', { name: 'Agent' }).click();
    await selectFakeAgentForTest(handle);

    // The task card clips its overflow; the popover used to be drawn above the
    // card, cut off and unreachable, while reporting itself open.
    const expectOnScreen = async (): Promise<void> => {
      const trigger = page.getByTestId('agent-pages-trigger');
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Add pages to agent context' });
      await expect(dialog).toHaveAttribute('data-phase', 'open');
      await page.waitForTimeout(250);
      const geometry = await dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const anchor = document.querySelector<HTMLElement>('[data-testid="agent-pages-trigger"]')?.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          anchorTop: anchor?.top ?? Number.NaN,
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          centreHitsSelf: hit !== null && element.contains(hit),
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.innerWidth);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.innerHeight);
      expect(Math.abs(geometry.anchorTop - geometry.bottom - 6)).toBeLessThanOrEqual(1);
      expect(geometry.centreHitsSelf).toBe(true);
      await expect(dialog.getByRole('spinbutton').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    };

    await expectOnScreen();
    await handle.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2); });
    await expect.poll(async () => page.evaluate(() => window.innerWidth < 920)).toBe(true);
    await page.getByTestId('toggle-right-panel').click();
    const drawer = page.getByTestId('compact-drawer-right');
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect.poll(async () => drawer.evaluate((node) =>
      node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
    await expectOnScreen();
  });

  test('both agent session overlays open whole and on screen in the 280px companion', async () => {
    const pdfPath = join(fixtureDir, 'Runs.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Runs', author: 'Interleaf', pageLines: [['Page 1'], ['Page 2']] }));
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-ui-interactions-ws-'));
    try {
      app = await launchInterleaf({ testSeam: true });
      const handle = app;
      const page = handle.window;
      await handle.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900); });
      await stubOpenDialog(handle, [pdfPath]);
      await page.getByTestId('import-files-button').click();
      await expect(page.getByTestId('success-banner')).toBeVisible();
      const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
      if (entry === undefined) throw new Error('Fixture was not imported.');
      await page.getByTestId(`read-doc-${entry.id}`).click();
      await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
      await page.getByRole('tab', { name: 'Agent' }).click();
      await selectFakeAgentForTest(handle);
      await stubOpenDialog(handle, [workingDirectory]);
      await page.getByRole('button', { name: 'Choose…' }).click();
      await page.getByLabel('Task description').fill('a run to list');
      await page.getByRole('button', { name: 'Start agent' }).click();
      await expect(page.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });

      // The narrowest companion wraps the run menu's trigger to the left, where
      // a right-aligned panel used to run out past the companion and be cut off.
      const resizer = page.getByTestId('panel-resizer-right');
      await resizer.focus();
      await page.keyboard.press('Home');
      await expect(resizer).toHaveAttribute('aria-valuenow', String(await resizer.getAttribute('aria-valuemin')));
      await resizer.blur();

      const expectWhole = async (trigger: Locator, regionId: string): Promise<void> => {
        await trigger.click();
        const region = page.locator(`[id="${regionId}"]`);
        await expect(region).toHaveAttribute('data-phase', 'open');
        await page.waitForTimeout(250);
        const geometry = await region.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const middle = box.top + box.height / 2;
          const owns = (x: number, y: number): boolean => {
            const hit = document.elementFromPoint(x, y);
            return hit !== null && element.contains(hit);
          };
          return {
            left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            edgesOwned: owns(box.left + 4, middle) && owns(box.right - 4, middle) && owns(box.left + box.width / 2, middle),
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.innerWidth);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.innerHeight);
        expect(geometry.edgesOwned).toBe(true);
        await page.keyboard.press('Escape');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      };

      await expectWhole(page.getByTestId('agent-run-menu-button'), 'agent-run-menu-region');
      await page.getByTestId('agent-back-button').click();
      await expectWhole(page.getByTestId('agent-session-list').getByRole('button', { name: 'All sessions' }), 'agent-session-list-region');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
