import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatCliFixture, type ChatCliFixture } from './chat-cli-fixture';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Reader Chat's reasoning levels in the shipped Chromium, at the minimum
 * companion width: the levels open beside the picker on whichever side has
 * room, every level is hit-testable, a diagonal path to them across another
 * row does not switch them, and a level chosen from the keyboard survives a
 * reload because main stored it with the conversation.
 *
 * Offline: the levels come from an offline `codex` fixture answering main's
 * own `app-server` model listing, and no turn is ever run.
 */

const LEVELS = ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort }));
const MODELS = [
  { model: 'gpt-e2e-deep', isDefault: true, supportedReasoningEfforts: LEVELS },
  { model: 'gpt-e2e-plain' },
];

type FlyoutProbe = {
  readonly side: string | null;
  readonly insideViewport: boolean;
  readonly clearOfPicker: boolean;
  readonly levels: readonly { readonly effort: string; readonly topmost: boolean }[];
};

async function probeFlyout(page: Page): Promise<FlyoutProbe> {
  return page.evaluate(() => {
    const flyout = document.querySelector<HTMLElement>('[data-testid="chat-reasoning-flyout"]');
    const picker = document.querySelector<HTMLElement>('[data-testid="chat-model-picker-popover"]');
    if (!flyout || !picker) throw new Error('The picker or its levels were not mounted.');
    const box = flyout.getBoundingClientRect();
    const owner = picker.getBoundingClientRect();
    return {
      side: flyout.dataset.side ?? null,
      insideViewport: box.left >= 8 && box.top >= 8 && box.right <= window.innerWidth - 8 && box.bottom <= window.innerHeight - 8,
      clearOfPicker: box.right <= owner.left || box.left >= owner.right,
      levels: [...flyout.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((level) => {
        const rect = level.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { effort: level.dataset.effort ?? '', topmost: hit !== null && level.contains(hit) };
      }),
    };
  });
}

async function chooseTheme(page: Page, palette: string): Promise<void> {
  await page.getByTestId('open-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await page.getByTestId('settings-rail-theme').click();
  await page.getByTestId(`theme-option-${palette}`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test.describe('Reader Chat reasoning levels at the minimum companion width', () => {
  let app: AppHandle;
  let cli: ChatCliFixture;
  let fixtureDir: string;
  /** Screenshots go where the run asks for them, else into Playwright's output. */
  let shots: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-reasoning-'));
    cli = createChatCliFixture({ models: MODELS });
    app = await launchInterleaf({ binDir: cli.binDir });
    shots = process.env.INTERLEAF_REASONING_SCREENSHOTS ?? test.info().outputPath('screenshots');
    mkdirSync(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cli.binDir, { recursive: true, force: true });
  });

  test('opens the levels clear of the picker, keeps them on a diagonal path, and persists a keyboard choice', async () => {
    const page = app.window;
    const pdfPath = join(fixtureDir, 'Reasoning_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Reasoning Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic document for reasoning menu testing.']],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [fixtureDocument] = await page.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(fixtureDocument).toBeDefined();
    const documentId = fixtureDocument!.id;

    await chooseTheme(page, 'paper');
    await page.getByTestId(`read-doc-${documentId}`).click();
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    const resizer = page.getByTestId('panel-resizer-right');
    await resizer.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(350);
    const companionWidth = await page.getByRole('region', { name: 'AI research chat' }).evaluate((element) => element.getBoundingClientRect().width);
    expect(companionWidth).toBeLessThanOrEqual(281);

    const trigger = page.getByTestId('chat-model-picker');
    await expect(trigger).toHaveAttribute('data-provider-id', 'codex');
    await trigger.click();
    const popover = page.getByTestId('chat-model-picker-popover');
    await expect(popover).toBeVisible();
    const deep = popover.locator('[role="option"][data-model-id="gpt-e2e-deep"]');
    const plain = popover.locator('[role="option"][data-model-id="gpt-e2e-plain"]');
    await expect(deep).toHaveAttribute('data-has-levels', 'true');
    await expect(plain).not.toHaveAttribute('data-has-levels', 'true');

    // Pointer: resting on the row opens its levels; hovering chooses nothing.
    const modelBefore = await trigger.getAttribute('data-model-id');
    await deep.hover();
    const flyout = page.getByTestId('chat-reasoning-flyout');
    await expect(flyout).toBeVisible();
    await expect(deep).toHaveAttribute('data-expanded', 'true');
    await expect(trigger).toHaveAttribute('data-model-id', modelBefore ?? '');
    const probe = await probeFlyout(page);
    // The companion sits at the window's right edge, so there is no room on
    // the right: the levels open on the left, inside the window, off the list.
    expect(probe.side).toBe('left');
    expect(probe.insideViewport).toBe(true);
    expect(probe.clearOfPicker).toBe(true);
    expect(probe.levels.map((level) => level.effort)).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
    for (const level of probe.levels) expect(level.topmost, `level ${level.effort} must be hit-testable`).toBe(true);
    await expect.poll(() => popover.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await page.screenshot({ path: join(shots, 'reasoning-flyout-light.png'), animations: 'disabled' });

    // A diagonal path to the last level crosses the row below without
    // switching the open levels, and the click commits model and level.
    const high = flyout.locator('[data-effort="high"]');
    const target = await high.boundingBox();
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 16 });
    await expect(flyout).toBeVisible();
    await expect(deep).toHaveAttribute('data-expanded', 'true');
    await high.click();
    await expect(popover).toHaveCount(0);
    await expect(flyout).toHaveCount(0);
    await expect(trigger).toHaveAttribute('data-model-id', 'gpt-e2e-deep');
    await expect(page.getByTestId('chat-model-trigger-effort')).toHaveText('High');
    await expect(trigger).toBeFocused();

    // The draft choice is stored with the conversation it creates.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect.poll(async () => (await page.evaluate((id) => window.interleafAPI.chat.listSessions(id), documentId))
      .map((session) => `${session.modelId ?? ''}:${session.reasoningEffort ?? 'default'}`)).toEqual(['gpt-e2e-deep:high']);

    // Keyboard: open, ArrowRight into the bound row's levels on the checked
    // one, down to Xhigh, Enter.
    await trigger.press('Enter');
    await expect(popover).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const menu = page.getByRole('menu', { name: 'Reasoning effort for gpt-e2e-deep' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-effort="high"]')).toBeFocused();
    await expect(menu.locator('[data-effort="high"]')).toHaveAttribute('aria-checked', 'true');
    // Escape steps back one layer only.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(popover).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[data-effort="xhigh"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId('chat-model-trigger-effort')).toHaveText('Xhigh');
    await expect(trigger).toBeFocused();

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    if (!(await page.getByTestId('pdf-canvas-p1').isVisible())) {
      await page.getByTestId(`read-doc-${documentId}`).click();
    }
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByTestId('chat-model-trigger-effort')).toHaveText('Xhigh');
    await expect(trigger).toHaveAttribute('data-model-id', 'gpt-e2e-deep');
    await expect(trigger).toHaveAccessibleName(/reasoning effort Xhigh/u);
    expect((await page.evaluate((id) => window.interleafAPI.chat.listSessions(id), documentId))[0]?.reasoningEffort).toBe('xhigh');

    // Dark appearance, with the levels open from the keyboard.
    await chooseTheme(page, 'graphite');
    await trigger.focus();
    await trigger.press('Enter');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect.poll(() => popover.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await page.screenshot({ path: join(shots, 'reasoning-flyout-dark.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // Nothing here ever ran a turn.
    expect(cli.chatInvocations()).toEqual([]);
  });
});
