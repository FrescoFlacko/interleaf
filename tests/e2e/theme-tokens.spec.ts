import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PALETTE_TOKENS } from '../../src/shared/constants/palette-tokens';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeEpubFixture } from '../fixtures/document-fixtures';
import { listboxOptionLabels } from './listbox';

/**
 * A theme is one set of tokens painted everywhere: the shell, the companion
 * panel and the sandboxed reader frame all resolve the chosen palette's
 * values, the choice survives a relaunch, and the pickers built on it only
 * offer integrations that are installed. Every launch uses a temporary
 * profile and a sanitized PATH, so no CLI provider is installed here.
 */

function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

/**
 * Choose any theme from Settings → Theme, as a reader does; the header menu
 * only lists the current and recently used themes.
 */
async function chooseTheme(page: Page, palette: string): Promise<void> {
  await page.getByTestId('open-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await page.getByTestId('settings-rail-theme').click();
  await page.getByTestId(`theme-option-${palette}`).click();
  await expect(page.getByTestId(`theme-option-${palette}`)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function rootToken(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name);
}

test.describe('Theme tokens', () => {
  let app: AppHandle | undefined;
  let fixtureDir: string;
  let epubPath: string;

  test.beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-theme-e2e-'));
    epubPath = join(fixtureDir, 'Theme_Sample.epub');
    writeFileSync(epubPath, makeEpubFixture({
      title: 'Theme Sample',
      author: 'Interleaf',
      chapters: [{ title: 'Chapter 1', content: '<p>Every surface reads from one palette.</p>' }],
    }));
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('paints the shell, companion and reader frame from the chosen palette and keeps it across a relaunch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-theme-profile-'));
    try {
      app = await launchInterleaf({ userDataDir });
      const page = app.window;
      for (const palette of ['ink', 'celadon'] as const) {
        const tokens = PALETTE_TOKENS[palette];
        await chooseTheme(page, palette);
        await expect.poll(() => rootToken(page, '--bg-primary')).toBe(tokens['bg-primary']);
        expect(await rootToken(page, '--accent')).toBe(tokens.accent);
        expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(rgb(tokens['text-primary']));
      }

      await stubOpenDialog(app, [epubPath]);
      await page.getByTestId('import-files-button').click();
      await expect(page.getByTestId('success-banner')).toBeVisible();
      const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
      if (entry === undefined) throw new Error('Fixture EPUB was not imported.');
      await page.getByTestId(`read-doc-${entry.id}`).click();
      const frame = page.frameLocator('iframe[title="Ebook Content"]');
      await expect(frame.getByText('Every surface reads from one palette.')).toBeVisible();

      const celadon = PALETTE_TOKENS.celadon;
      await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
        .toBe(rgb(celadon['bg-reader']));
      await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).color))
        .toBe(rgb(celadon['text-primary']));

      // The companion inherits the same tokens rather than carrying its own.
      const companion = page.getByTestId('resizable-panel-right-content');
      await expect(companion).toBeVisible();
      const companionTokens = await companion.evaluate((element) => {
        const style = getComputedStyle(element);
        return { accent: style.getPropertyValue('--accent').trim(), surface: style.getPropertyValue('--bg-surface').trim() };
      });
      expect(companionTokens).toEqual({ accent: celadon.accent, surface: celadon['bg-surface'] });

      // Switching palettes with the reader open repaints the frame as well.
      await chooseTheme(page, 'ink');
      await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
        .toBe(rgb(PALETTE_TOKENS.ink['bg-reader']));

      await app.close();
      app = await launchInterleaf({ userDataDir });
      await expect(app.window.locator('html')).toHaveAttribute('data-theme', 'ink');
      await expect.poll(() => rootToken(app!.window, '--bg-primary')).toBe(PALETTE_TOKENS.ink['bg-primary']);
      await expect(app.window.getByTestId('theme-menu-trigger')).toHaveAttribute('aria-label', 'Theme: Ink');
    } finally {
      await app?.close();
      app = undefined;
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('offers only installed integrations in the themed Agent and Chat pickers', async () => {
    // Main detects CLIs itself, so the expected lists come from main's own
    // report rather than from an assumption about this host.
    app = await launchInterleaf();
    const page = app.window;
    await stubOpenDialog(app, [epubPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
    if (entry === undefined) throw new Error('Fixture EPUB was not imported.');
    await page.getByTestId(`read-doc-${entry.id}`).click();

    const profiles = await page.evaluate(async () =>
      (await window.interleafAPI.agent.listProfiles()).map((profile) => ({
        name: profile.name,
        installed: profile.detection.availability === 'installed',
      })));
    const installed = profiles.filter((profile) => profile.installed).map((profile) => profile.name);
    const absent = profiles.filter((profile) => !profile.installed).map((profile) => profile.name);

    await page.getByRole('tab', { name: /Agent/i }).click();
    if (installed.length === 0) {
      // Nothing to offer: the picker gives way to a plain empty state.
      await expect(page.getByTestId('agent-profile-empty')).toBeVisible();
    } else {
      const profile = page.getByRole('combobox', { name: 'Agent profile' });
      await expect(profile).toBeVisible();
      // The themed listbox, not the platform popup.
      expect(await profile.evaluate((element) => element.tagName)).not.toBe('SELECT');
      const offered = await listboxOptionLabels(profile);
      expect(offered).toEqual(installed);
      for (const name of absent) expect(offered).not.toContain(name);
    }
    expect(await page.locator('select').count()).toBe(0);

    const providers = await page.evaluate(async () =>
      (await window.interleafAPI.ai.listProviders()).map((provider) => ({
        name: provider.name,
        ready: provider.available &&
          (provider.capabilities.toolFreeMode || provider.id === 'codex') &&
          provider.authentication === 'connected',
      })));
    await page.getByRole('tab', { name: /Chat/i }).click();
    await page.getByTestId('chat-model-picker').click();
    const picker = page.getByTestId('chat-model-picker-popover');
    await expect(picker).toBeVisible();
    // One group per ready provider; nothing unready is offered as a choice.
    await expect(picker.getByRole('group')).toHaveCount(providers.filter((provider) => provider.ready).length);
    await page.keyboard.press('Escape');
  });

  test('drops the spatial part of popover and dialog motion under reduced motion', async () => {
    app = await launchInterleaf();
    const page = app.window;
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.getByTestId('theme-menu-trigger').click();
    const menu = page.getByTestId('theme-menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('opacity');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await page.getByTestId('open-settings').click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    const motion = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, transform: style.transform };
    });
    expect(motion).toEqual({ property: 'opacity', transform: 'none' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
