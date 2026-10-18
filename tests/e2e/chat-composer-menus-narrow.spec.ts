import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * The composer's model picker opens from the tool row at the minimum companion
 * width. A picker drawn inside that row would be clipped at its edge and stop
 * receiving pointer events where it is clipped — a failure a CSS assertion in
 * jsdom cannot see, because jsdom has no layout and no hit testing.
 *
 * This regression therefore runs in the real Chromium the app ships with and
 * checks the property that matters: every entry in the picker is the topmost
 * element at its own coordinates, and choosing it changes the binding.
 *
 * No provider request is made. The provider list is served by replacing the
 * `ai:list-providers` IPC handler in the test's own main process, the
 * OpenRouter catalog is answered by the offline network guard, and with no
 * conversation open a selection is local composer state.
 */

type MenuProbe = {
  readonly portalled: boolean;
  readonly insideViewport: boolean;
  readonly aboveTrigger: boolean;
  readonly outsideToolbar: boolean;
  readonly items: readonly { readonly label: string; readonly topmost: boolean }[];
};

const PROVIDER_FIXTURE = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    available: true,
    installed: false,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: [
      { id: 'openrouter/auto', name: 'Auto Router', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true },
      { id: 'openrouter/second', name: 'Second Router Model', contextWindow: 64_000, maxOutputTokens: 4_096, supportsStreaming: true },
      { id: 'openrouter/third', name: 'Third Router Model', contextWindow: 8_000, maxOutputTokens: 1_024, supportsStreaming: true },
    ],
    capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  },
  {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    installed: true,
    authentication: 'connected',
    version: '1',
    errorMessage: null,
    models: [
      { id: 'claude-primary', name: 'Claude Primary', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true },
      { id: 'claude-secondary', name: 'Claude Secondary', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true },
    ],
    capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  },
];

test.describe('Composer model picker at the minimum companion width', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-menus-narrow-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('opens the model picker clear of the wrapping tool row and selects entries by pointer and keyboard', async () => {
    const pdfPath = join(fixtureDir, 'Chat_Composer_Menus_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Chat Composer Menus Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic document for composer menu layout testing.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [fixtureDocument] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(fixtureDocument).toBeDefined();

    // Serve a deterministic provider list so both controls have something to
    // choose between. This replaces one IPC handler in this test process only.
    await app.electronApp.evaluate(({ ipcMain }, providers) => {
      ipcMain.removeHandler('ai:list-providers');
      ipcMain.handle('ai:list-providers', () => ({ ok: true, data: providers }));
    }, PROVIDER_FIXTURE);
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');

    await app.window.getByTestId(`read-doc-${fixtureDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    const picker = app.window.getByTestId('chat-model-picker');
    await expect(picker).toContainText('OpenRouter');

    // The minimum supported companion width.
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('Home');
    await app.window.waitForTimeout(350);

    const row = await app.window.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.chat-design-controls');
      if (!toolbar) throw new Error('The composer tool row was not mounted.');
      const rowRect = toolbar.getBoundingClientRect();
      const controls = [...toolbar.querySelectorAll<HTMLElement>('button')];
      return {
        overflowAmount: toolbar.scrollWidth - toolbar.clientWidth,
        // The row wraps rather than scrolls: no control is reachable only
        // through a hidden scrollbar.
        everyControlInside: controls.every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1;
        }),
      };
    });
    expect(row.overflowAmount).toBeLessThanOrEqual(1);
    expect(row.everyControlInside).toBe(true);

    /** Where the open picker sits, and whether Chromium hit-tests every entry. */
    const probe = async (): Promise<MenuProbe> =>
      app.window.evaluate(() => {
        const menu = document.querySelector<HTMLElement>('[data-testid="chat-model-picker-popover"]');
        const trigger = document.querySelector<HTMLElement>('[data-testid="chat-model-picker"]');
        const toolbar = document.querySelector<HTMLElement>('.chat-design-controls');
        if (!menu || !trigger || !toolbar) throw new Error('The model picker or its trigger was not mounted.');
        const menuRect = menu.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const items = [...menu.querySelectorAll<HTMLElement>('[role="option"], [data-testid="chat-provider-edit"]')];
        return {
          portalled: menu.parentElement === document.body && !toolbar.contains(menu),
          insideViewport:
            menuRect.top >= 0 &&
            menuRect.left >= 0 &&
            menuRect.right <= window.innerWidth &&
            menuRect.bottom <= window.innerHeight,
          aboveTrigger: menuRect.bottom <= triggerRect.top + 1,
          // Drawn clear of the row so nothing in it is clipped.
          outsideToolbar: menuRect.bottom <= toolbarRect.top + 1,
          items: items.map((item) => {
            // Scrolled into the capped list first: the list scrolls, the
            // picker does not clip.
            item.scrollIntoView({ block: 'nearest' });
            const shown = item.getBoundingClientRect();
            const hit = document.elementFromPoint(shown.left + shown.width / 2, shown.top + shown.height / 2);
            return {
              label: (item.querySelector('.chat-model-picker-name') ?? item).textContent.trim(),
              // A clipped entry is not the topmost element at its own centre,
              // so a click never reaches it.
              topmost: hit !== null && item.contains(hit),
            };
          }),
        };
      });

    await picker.click();
    const popover = app.window.getByTestId('chat-model-picker-popover');
    await expect(popover).toBeVisible();
    await expect(app.window.getByRole('combobox', { name: 'Search models and providers' })).toBeFocused();
    const pickerProbe = await probe();
    expect(pickerProbe.portalled).toBe(true);
    expect(pickerProbe.insideViewport).toBe(true);
    expect(pickerProbe.aboveTrigger).toBe(true);
    expect(pickerProbe.outsideToolbar).toBe(true);
    // The capped list scrolls vertically and never sideways.
    expect(await popover.getByRole('listbox').evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(1);
    const labels = pickerProbe.items.map((item) => item.label);
    // Claude's two models in its own group, after OpenRouter's, then the
    // provider settings action.
    expect(labels.slice(-3)).toEqual(['Claude Primary', 'Claude Secondary', 'Manage providers…']);
    await expect(popover.getByRole('group', { name: 'Claude Code' })).toBeVisible();
    for (const item of pickerProbe.items) {
      expect(item.topmost, `picker entry "${item.label}" must be hit-testable`).toBe(true);
    }

    // Playwright's own actionability check hit-tests the entry again before it
    // dispatches, so this click would fail on a clipped picker.
    await popover.getByRole('option', { name: /Claude Secondary/ }).click();
    await expect(popover).toHaveCount(0);
    await expect(picker).toContainText('Claude Secondary');
    await expect(picker).toContainText('Claude Code');
    await expect(picker).toBeFocused();

    // Keyboard: open, search, arrow, select — one choice binds both halves.
    await picker.press('Enter');
    await expect(popover).toBeVisible();
    await app.window.keyboard.type('primary');
    await expect(popover.getByRole('option')).toHaveCount(1);
    await app.window.keyboard.press('Enter');
    await expect(popover).toHaveCount(0);
    await expect(picker).toContainText('Claude Primary');
    await expect(picker).toBeFocused();

    // Escape closes the picker only and returns focus to the trigger.
    await picker.press('Enter');
    await expect(popover).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    await picker.click();
    await expect(popover).toBeVisible();
    // A real press in the middle of the page, outside both the picker and its
    // trigger, wherever the reader happens to render it.
    const page = await app.window.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[data-testid="pdf-canvas-p1"]');
      if (!canvas) throw new Error('The rendered page was not mounted.');
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await app.window.mouse.click(page.x, page.y);
    await expect(popover).toHaveCount(0);
    await expect(picker).toContainText('Claude Primary');
  });
});
