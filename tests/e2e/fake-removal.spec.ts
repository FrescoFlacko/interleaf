import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PALETTE_IDS } from '../../src/shared/constants/palettes';
import { launchInterleaf, revealNotInstalledProviders, type AppHandle } from './helpers';

test.describe('Defect 16: fake provider and agent removal', () => {
  let app: AppHandle | undefined;
  let userDataDir: string;

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-defect16-'));
  });

  test.afterEach(async () => {
    await app?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('normal startup exposes no fake choices, rejects stale IPC IDs, migrates settings, and stays contained at native 200%', async () => {
    app = await launchInterleaf({ userDataDir });
    const currentApp = app;
    const providers = await currentApp.window.evaluate(() => window.interleafAPI.ai.listProviders());
    const profiles = await currentApp.window.evaluate(() => window.interleafAPI.agent.listProfiles());
    expect(providers.some((provider) => provider.id === 'fake')).toBe(false);
    expect(profiles.some((profile) => profile.id === 'fake' || profile.providerId === 'fake')).toBe(false);
    await expect(currentApp.window.evaluate(() => window.interleafAPI.ai.getProviderStatus('fake'))).rejects.toThrow();

    await currentApp.window.getByTestId('open-settings').click();
    const settings = currentApp.window.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    // Built-in profiles live inside their provider row; verify the supported
    // Codex row instead of ambiguous duplicate display strings.
    await revealNotInstalledProviders(settings);
    await expect(settings.getByTestId('provider-summary-codex')).toBeVisible();
    await expect(settings.getByTestId('provider-summary-codex')).toContainText('Codex');
    await expect(settings.getByTestId('provider-summary-fake')).toHaveCount(0);
    await expect(settings.getByText(/Fake Agent|Deterministic Test Provider/i)).toHaveCount(0);

    // Exercise every supported palette through the real settings surface.
    await settings.getByTestId('settings-rail-theme').click();
    for (const id of PALETTE_IDS) {
      await settings.getByTestId(`theme-option-${id}`).click();
      await expect(settings.getByTestId(`theme-option-${id}`)).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => currentApp.window.evaluate(() => document.documentElement.dataset.theme)).toBe(id);
    }
    await settings.getByRole('button', { name: 'Close settings' }).click();

    // Seed the old JSON shape behind the app, then prove migration preserves
    // unrelated preferences while dropping only fake profile state.
    const dbPath = join(currentApp.userDataDir, 'database', 'interleaf.sqlite');
    const legacy = await currentApp.window.evaluate(async () => {
      const current = await window.interleafAPI.settings.get();
      return {
        ...current,
        appearance: { palette: 'sepia' as const },
        agent: {
          ...current.agent,
          defaultWorkingDirectoryByProfile: { fake: 'legacy-handle' },
          profiles: {
            fake: {
              binary: 'interleaf-fake', arguments: [], defaultModel: null,
              reasoningEffort: null, permissionMode: 'fixture', sandboxMode: 'auto-isolated',
              workingDirectoryPolicy: 'select-per-run', environmentOverrides: [],
            },
          },
        },
      };
    });
    await currentApp.close({ preserveUserData: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`UPDATE settings SET value_json = ?, updated_at = datetime('now', 'utc') WHERE key = 'app'`).run(JSON.stringify(legacy));
    } finally {
      db.close();
    }

    app = await launchInterleaf({ userDataDir });
    const restartedApp = app;
    const migrated = await restartedApp.window.evaluate(() => window.interleafAPI.settings.get());
    expect(migrated.appearance.palette).toBe('sepia');
    expect(migrated.agent.profiles).toEqual({});
    expect(migrated.agent.defaultWorkingDirectoryByProfile).toEqual({});
    expect((await restartedApp.window.evaluate(() => window.interleafAPI.agent.listProfiles())).some((profile) => profile.id === 'fake')).toBe(false);

    await restartedApp.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(1_200, 800);
      window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => restartedApp.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    await restartedApp.window.getByTestId('open-settings').click();
    const zoomedSettings = restartedApp.window.getByRole('dialog', { name: 'Settings' });
    await expect(zoomedSettings).toBeVisible();
    await revealNotInstalledProviders(zoomedSettings);
    await zoomedSettings.getByTestId('provider-summary-codex').click();
    await expect(zoomedSettings.getByText(/Fake Agent|Deterministic Test Provider/i)).toHaveCount(0);
    const containment = await restartedApp.window.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="ai-providers-settings-modal"]');
      const rect = dialog?.getBoundingClientRect();
      return {
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        bodyOverflowY: document.body.scrollHeight - window.innerHeight,
        dialogRight: rect?.right ?? Number.POSITIVE_INFINITY,
        dialogBottom: rect?.bottom ?? Number.POSITIVE_INFINITY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    expect(containment.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(containment.bodyOverflowY).toBeLessThanOrEqual(1);
    expect(containment.dialogRight).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.dialogBottom).toBeLessThanOrEqual(containment.innerHeight + 1);

    await restartedApp.window.emulateMedia({ forcedColors: 'active' });
    expect(await restartedApp.window.evaluate(() => document.body.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await restartedApp.window.emulateMedia({ forcedColors: 'none' });
  });
});
