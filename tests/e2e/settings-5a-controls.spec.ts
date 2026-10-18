import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getRecordedMessageBoxCalls,
  launchInterleaf,
  resetRecordedMessageBoxCalls,
  stubMessageBox,
  type AppHandle,
} from './helpers';
import { chooseListboxValue } from './listbox';

/**
 * The rebuilt Settings sections in the real desktop application.
 *
 * Every control here is expected to survive a restart and to change what the
 * application actually does. The desktop handoff for external links is replaced
 * in main so no browser is ever launched.
 */

type OpenedLink = { readonly url: string };

async function stubOpenExternal(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate(({ shell }) => {
    const store = globalThis as { __openedExternalLinks?: OpenedLink[] };
    store.__openedExternalLinks ??= [];
    shell.openExternal = (url: string) => {
      store.__openedExternalLinks?.push({ url });
      return Promise.resolve();
    };
  });
}

async function openedLinks(app: AppHandle): Promise<readonly OpenedLink[]> {
  return await app.electronApp.evaluate(() => {
    const store = globalThis as { __openedExternalLinks?: OpenedLink[] };
    return store.__openedExternalLinks ? [...store.__openedExternalLinks] : [];
  });
}

async function openSection(app: AppHandle, label: string) {
  await app.window.getByTestId('open-settings').click();
  const modal = app.window.getByTestId('ai-providers-settings-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: label, exact: true }).click();
  return modal;
}

test.describe('Settings 5a — real persisted controls', () => {
  let userDataDir: string;
  let app: AppHandle;

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-settings-5a-'));
  });

  test.afterEach(async () => {
    await app.close({ preserveUserData: true });
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('saves Library, Privacy, Advanced and Sandboxing choices across a restart', async () => {
    app = await launchInterleaf({ userDataDir });

    const library = await openSection(app, 'Library');
    await expect(library.getByTestId('settings-library-default-view')).toHaveAttribute('data-value', 'grid');
    await chooseListboxValue(library.getByTestId('settings-library-default-view'), 'list');
    await chooseListboxValue(library.getByTestId('settings-library-default-sort'), 'title_asc');
    await expect(app.window.getByText('Settings saved on this device.')).toBeVisible();

    await library.getByRole('button', { name: 'Privacy', exact: true }).click();
    await library.getByTestId('settings-privacy-confirm-external-links').check();

    await library.getByRole('button', { name: 'Advanced', exact: true }).click();
    await library.getByTestId('settings-advanced-debug-logging').check();

    await library.getByRole('button', { name: 'Agent Sandboxing', exact: true }).click();
    const mode = library.getByTestId('settings-agent-default-execution-mode');
    await expect(mode).toHaveAttribute('data-value', 'auto-isolated');
    await chooseListboxValue(mode, 'isolated-worktree');
    // Container Sandbox has no verified executor, so it is not offered at all
    // rather than presented as a choice that would fail on use.
    await expect(mode.locator('option[value="container-sandbox"]')).toHaveCount(0);
    await expect(mode.locator('option[value="active-env"]')).toHaveCount(0);
    await expect(mode.locator('option[value="native-restricted"]')).toHaveCount(0);

    await expect(app.window.getByText('Settings saved on this device.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Close settings' }).click();

    // The saved document, read back through the real boundary after a restart.
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });

    const stored = await app.window.evaluate(() => window.interleafAPI.settings.get());
    expect(stored.library).toEqual({ defaultView: 'list', defaultSort: 'title_asc' });
    expect(stored.privacy.confirmExternalLinks).toBe(true);
    expect(stored.advanced.debugLogging).toBe(true);
    expect(stored.agent.defaultExecutionMode).toBe('isolated-worktree');

    const reopened = await openSection(app, 'Library');
    await expect(reopened.getByTestId('settings-library-default-view')).toHaveAttribute('data-value', 'list');
    await expect(reopened.getByTestId('settings-library-default-sort')).toHaveAttribute('data-value', 'title_asc');
    await reopened.getByRole('button', { name: 'Privacy', exact: true }).click();
    await expect(reopened.getByTestId('settings-privacy-confirm-external-links')).toBeChecked();
    await reopened.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(reopened.getByTestId('settings-advanced-debug-logging')).toBeChecked();
    await reopened.getByRole('button', { name: 'Agent Sandboxing', exact: true }).click();
    await expect(reopened.getByTestId('settings-agent-default-execution-mode')).toHaveAttribute('data-value', 'isolated-worktree');
    await reopened.getByRole('button', { name: 'Close settings' }).click();

    // There is no manual status refresh left to press.
    await expect(app.window.getByTestId('refresh-ai-providers-button')).toHaveCount(0);
  });

  test('shows the in-app privacy policy in Privacy, reachable by ordinary scrolling', async () => {
    app = await launchInterleaf({ userDataDir });

    const privacy = await openSection(app, 'Privacy');
    const policy = privacy.getByTestId('settings-privacy-policy');
    await expect(policy).toBeVisible();
    await expect(policy.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible();
    await expect(policy.getByText('September 12, 2026')).toBeVisible();

    // The policy stays inside the settings panel: it scrolls with the section
    // rather than overflowing the modal or clipping its last paragraph.
    const content = privacy.getByTestId('settings-content');
    const last = policy.getByRole('heading', { name: 'Untrusted content and diagnostics' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    const fits = await content.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.bottom <= window.innerHeight + 1 && node.scrollWidth <= node.clientWidth + 1;
    });
    expect(fits).toBe(true);

    // The existing control above it is still reachable from the keyboard.
    await content.evaluate((node) => { node.scrollTop = 0; });
    await privacy.getByTestId('settings-privacy-confirm-external-links').focus();
    await app.window.keyboard.press('Space');
    await expect(privacy.getByTestId('settings-privacy-confirm-external-links')).toBeChecked();
    await privacy.getByRole('button', { name: 'Close settings' }).click();
  });

  test('confirms an external link before opening it, and opens nothing when declined', async () => {
    app = await launchInterleaf({ userDataDir });
    await stubOpenExternal(app);

    // Preference off: today's one-click behaviour is unchanged.
    await expect
      .poll(async () => app.window.evaluate(() => window.interleafAPI.app.openExternal('https://example.org/one-click')))
      .toEqual({ opened: true });
    expect(await openedLinks(app)).toEqual([{ url: 'https://example.org/one-click' }]);
    expect(await getRecordedMessageBoxCalls(app)).toEqual([]);

    const privacy = await openSection(app, 'Privacy');
    await privacy.getByTestId('settings-privacy-confirm-external-links').check();
    await expect(app.window.getByText('Settings saved on this device.')).toBeVisible();
    await privacy.getByRole('button', { name: 'Close settings' }).click();

    // Declined: nothing leaves the application.
    await stubMessageBox(app, 0);
    expect(
      await app.window.evaluate(() => window.interleafAPI.app.openExternal('https://example.org/declined'))
    ).toEqual({ opened: false });
    const declined = await getRecordedMessageBoxCalls(app);
    expect(declined).toHaveLength(1);
    expect(declined[0]?.buttons).toEqual(['Cancel', 'Open link']);
    expect(await openedLinks(app)).toEqual([{ url: 'https://example.org/one-click' }]);

    // Accepted: the canonical target, and only that, is handed to the desktop.
    await resetRecordedMessageBoxCalls(app);
    await stubMessageBox(app, 1);
    expect(
      await app.window.evaluate(() => window.interleafAPI.app.openExternal('  https://example.org/accepted  '))
    ).toEqual({ opened: true });
    expect(await getRecordedMessageBoxCalls(app)).toHaveLength(1);
    expect(await openedLinks(app)).toEqual([
      { url: 'https://example.org/one-click' },
      { url: 'https://example.org/accepted' },
    ]);

    // A target that is not a plain external link is refused before any dialog.
    await resetRecordedMessageBoxCalls(app);
    const refusal = await app.window.evaluate(async () => {
      try {
        await window.interleafAPI.app.openExternal('javascript:alert(1)');
        return 'opened';
      } catch (error) {
        const details = error as { code?: string; message?: string };
        return `${details.code ?? 'no-code'}: ${details.message ?? String(error)}`;
      }
    });
    expect(refusal).toContain('http');
    expect(await getRecordedMessageBoxCalls(app)).toEqual([]);
  });
});
