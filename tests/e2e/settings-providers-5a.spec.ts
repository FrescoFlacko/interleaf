import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CREDENTIAL_STORAGE_BACKENDS } from '@shared/schemas/credential-preview';
import { launchInterleaf, revealNotInstalledProviders, type AppHandle } from './helpers';

/**
 * The redesigned AI Providers section (design 5a) with the built-in agent
 * profile editors merged into their provider rows (design 5d), exercised in the
 * real desktop application. No provider request is ever made: every assertion
 * is about the local surface, its keyboard behaviour and its layout.
 */

const BUILT_IN_ROWS = ['codex', 'claude-code', 'antigravity', 'opencode', 'pi', 'cursor'] as const;

/**
 * The storage diagnostic main reports once a key has been stored: the store is
 * usable by definition, on this machine's platform. macOS and Windows always
 * use the OS keychain; a Linux runner's backend is whichever secret service
 * its session provides, so only membership in the declared set is fixed.
 */
const STORAGE_PLATFORM = (['darwin', 'win32', 'linux'] as const).find((name) => name === process.platform) ?? 'other';
const USABLE_STORAGE = {
  available: true,
  backend: STORAGE_PLATFORM === 'darwin' || STORAGE_PLATFORM === 'win32'
    ? 'os_keychain'
    : expect.stringMatching(new RegExp(`^(?:${CREDENTIAL_STORAGE_BACKENDS.join('|')})$`, 'u')),
  platform: STORAGE_PLATFORM,
};

async function openSettings(app: AppHandle) {
  await app.window.getByTestId('open-settings').click();
  const modal = app.window.getByTestId('ai-providers-settings-modal');
  await expect(modal).toBeVisible();
  await expect(app.window.getByTestId('settings-rail-ai')).toBeEnabled({ timeout: 15_000 });
  await revealNotInstalledProviders(modal);
  return modal;
}

/**
 * Reports provider controls the window clips, so a dense layout cannot hide
 * one. The section rail is excluded: it is a deliberately scrollable strip at
 * dense zoom, which predates this redesign.
 */
async function clippedControls(app: AppHandle): Promise<readonly string[]> {
  return await app.window.evaluate(() => {
    const dialog = document.querySelector('[data-testid="settings-content"]');
    if (dialog === null) return ['settings content missing'];
    const clipped: string[] = [];
    for (const control of dialog.querySelectorAll('button, select, input')) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        clipped.push(control.getAttribute('data-testid') ?? control.tagName);
      }
    }
    return clipped;
  });
}

test.describe('Settings AI providers — 5a list and 5d merged profiles', () => {
  let userDataDir: string;
  let app: AppHandle;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-providers-5a-'));
    app = await launchInterleaf({ userDataDir });
  });

  test.afterEach(async () => {
    await app.close({ preserveUserData: true });
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('shows one accordion list, opens at most one row, and merges its profile editor', async () => {
    const modal = await openSettings(app);

    // Every provider is one row of a single bordered list, with a plain status
    // label rather than a coloured pill, and no Refresh Status control.
    await expect(modal.getByTestId('provider-summary-openrouter')).toBeVisible();
    for (const id of BUILT_IN_ROWS) {
      await expect(modal.getByTestId(`provider-summary-${id}`)).toHaveCount(1);
      await expect(modal.getByTestId(`provider-status-${id}`)).toBeVisible();
    }
    // GitHub Copilot is refused for Agent Mode, so it is not offered at all.
    await expect(modal.getByTestId('provider-summary-copilot')).toHaveCount(0);
    await expect(modal.getByTestId('refresh-ai-providers-button')).toHaveCount(0);
    await expect(modal.getByTestId('agent-profile-selector')).toHaveCount(0);
    await expect(modal.getByTestId('settings-rail-profiles')).toHaveCount(0);

    // Keyboard: a summary is a real button that toggles its own row.
    const codex = modal.getByTestId('provider-summary-codex');
    await codex.focus();
    await app.window.keyboard.press('Enter');
    await expect(modal.getByTestId('provider-panel-codex')).toBeVisible();
    await expect(codex).toHaveAttribute('aria-expanded', 'true');
    await expect(modal.getByTestId('provider-panel-openrouter')).toHaveCount(0);

    // The merged editor is the only built-in profile editor in the dialog.
    await expect(modal.getByTestId('profile-editor-codex')).toBeVisible();
    expect(await modal.locator('[data-testid^="profile-editor-"]').count()).toBe(1);
    for (const field of ['binary', 'arguments', 'model', 'models', 'reasoning', 'permission', 'sandbox', 'working-directory-default']) {
      await expect(modal.getByTestId(`profile-codex-${field}`)).toBeVisible();
    }

    // Opening another row closes this one.
    await modal.getByTestId('provider-summary-opencode').click();
    await expect(modal.getByTestId('provider-panel-codex')).toHaveCount(0);
    await expect(modal.getByTestId('profile-editor-opencode')).toBeVisible();

    // Custom profiles keep their own section, with no built-in editor in it.
    await modal.getByTestId('settings-rail-custom-profiles').click();
    await expect(modal.getByRole('heading', { name: 'Your custom profiles' })).toBeVisible();
    expect(await modal.locator('[data-testid^="profile-editor-"]').count()).toBe(0);

    // Escape still closes the one dialog and returns focus to its trigger.
    await app.window.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(app.window.getByTestId('open-settings')).toBeFocused();
  });

  test('routes the legacy built-in profiles deep link to its provider row', async () => {
    const modal = await openSettings(app);
    await app.window.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="open-settings"]')?.click();
    });
    // The rail no longer offers Agent Profiles, and the AI section is the one
    // that owns those settings.
    await expect(modal.getByTestId('settings-rail-ai')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByTestId('provider-summary-openrouter')).toHaveAttribute('aria-expanded', 'true');
  });

  test('keeps every control reachable at 200% zoom and in a narrow window', async () => {
    const modal = await openSettings(app);
    await modal.getByTestId('provider-summary-codex').click();
    await expect(modal.getByTestId('profile-editor-codex')).toBeVisible();

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main BrowserWindow was not found.');
      win.setSize(1_200, 800);
      win.webContents.setZoomFactor(2);
    });
    await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    await expect(modal.getByTestId('profile-codex-sandbox')).toBeVisible();
    expect(await clippedControls(app)).toEqual([]);

    // Defect 17: the dialog, the row that selects the profile, its editor and
    // the active section tab stay in the viewport with no horizontal overflow.
    // The 5d editor sits below the row's own content, so each is scrolled to
    // the top of the content viewport and measured there in CSS pixels.
    const contained = await app.window.evaluate(() => {
      const byTestId = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const content = byTestId('settings-content');
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]')!;
      const activeTab = byTestId('settings-rail-ai');
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const inContentView = (node: HTMLElement): boolean => {
        node.scrollIntoView({ block: 'start' });
        const box = node.getBoundingClientRect();
        const port = content.getBoundingClientRect();
        return box.top >= port.top - 4 && box.top < port.bottom - 24 && box.width > 0;
      };
      const rects = [byTestId('ai-providers-settings-modal'), byTestId('provider-summary-codex'), byTestId('profile-editor-codex')]
        .map((node) => node.getBoundingClientRect());
      const tabBox = activeTab.getBoundingClientRect();
      const navBox = nav.getBoundingClientRect();
      return {
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        rectsContained: rects.every((rect) => rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.width > 0),
        contentOverflowX: content.scrollWidth - content.clientWidth,
        selectorVisible: inContentView(byTestId('provider-summary-codex')),
        editorVisible: inContentView(byTestId('profile-editor-codex')),
        navActiveTabFullyVisible: tabBox.left >= navBox.left - 1 && tabBox.right <= navBox.right + 1,
      };
    });
    expect(contained.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(contained.contentOverflowX).toBeLessThanOrEqual(1);
    expect(contained).toMatchObject({
      rectsContained: true,
      selectorVisible: true,
      editorVisible: true,
      navActiveTabFullyVisible: true,
    });

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main BrowserWindow was not found.');
      win.webContents.setZoomFactor(1);
      win.setSize(520, 760);
    });
    await expect(modal.getByTestId('provider-summary-codex')).toBeVisible();
    await expect(modal.getByTestId('profile-codex-sandbox')).toBeVisible();
    expect(await clippedControls(app)).toEqual([]);
  });

  test('shows a masked key preview only, and never the raw key', async () => {
    const modal = await openSettings(app);
    // No key is configured in a fresh profile: the panel offers Add provider
    // and an empty password field rather than a preview.
    await expect(modal.getByTestId('add-provider-button')).toBeVisible();
    await modal.getByTestId('add-provider-button').click();
    await expect(modal.getByTestId('openrouter-key-input')).toBeFocused();
    await expect(modal.getByTestId('openrouter-key-input')).toHaveAttribute('type', 'password');

    // Store a key through the real main-owned vault, with no network request,
    // then confirm only its masked projection crosses the boundary.
    // Saving the unchanged default model performs no catalog or provider
    // request, so this stores a key without any paid call.
    const stored = await app.window.evaluate(() => window.interleafAPI.ai.configureOpenRouter({
      apiKey: 'sk-or-v1-e2e0000000000000000000000000000000000000000000000000000000wxyz',
      model: 'openrouter/auto',
    }).then(() => window.interleafAPI.credentials.getOpenRouterStatus(), () => null));
    test.skip(stored === null, 'OS credential storage is unavailable in this environment.');
    // The exact projection: the masked preview and the non-secret storage
    // diagnostic, and no other field that could carry credential material.
    expect(stored).toEqual({
      configured: true,
      keyPreview: { prefix: 'sk-or-v1', lastFour: 'wxyz' },
      storageBackend: USABLE_STORAGE,
    });
    expect(JSON.stringify(stored)).not.toContain('e2e0000');

    await app.window.keyboard.press('Escape');
    const reopened = await openSettings(app);
    const preview = reopened.getByTestId('openrouter-key-preview');
    await expect(preview).toContainText('wxyz');
    await expect(preview).not.toContainText('e2e0000');
    // The same single password field serves the configured state; it holds
    // nothing, because the stored key never crosses into the renderer.
    await expect(reopened.getByTestId('openrouter-key-input')).toHaveCount(1);
    await expect(reopened.getByTestId('openrouter-key-input')).toHaveAttribute('type', 'password');
    await expect(reopened.getByTestId('openrouter-key-input')).toHaveValue('');
    await expect(reopened.getByTestId('replace-openrouter-key-button')).toHaveCount(0);

    // Remove deletes the credential at once, and the open panel says so
    // without waiting for Done.
    await reopened.getByTestId('remove-openrouter-key-button').click();
    await expect(reopened.getByTestId('openrouter-key-preview')).toHaveCount(0);
    await expect(reopened).toBeVisible();
    expect(await app.window.evaluate(() => window.interleafAPI.credentials.getOpenRouterStatus())).toEqual({
      configured: false,
      keyPreview: null,
      storageBackend: USABLE_STORAGE,
    });
  });
});
