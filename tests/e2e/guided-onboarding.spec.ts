import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Guided onboarding in the real desktop application.
 *
 * Only what the renderer suite cannot settle is asserted here: the launch
 * classification depends on a real SQLite file that main reads before it
 * migrates anything, so "does a genuinely new user see this, and does an
 * existing one stop seeing it" is only answerable across actual process
 * launches against a persisted user-data directory.
 *
 * These are the tests the flow itself is the subject of, so every launch here
 * opts out of the shared helper's dismissal with `preserveOnboarding: true` and
 * meets the wizard exactly as a first-time user does. The opt-out is explicit
 * per launch rather than suite-wide: a launch that forgets it would silently
 * stop covering first-run behaviour.
 *
 * No provider is contacted. The app runs with `NODE_ENV=test` and the machine
 * running the suite is not logged into anything, so discovery settles on real
 * negative results — which is exactly the mixed, partly-unavailable state the
 * §4 rows have to render truthfully.
 */

/** A directory that survives one app close so the next launch reads it back. */
function persistentUserData(tag: string): string {
  return mkdtempSync(join(tmpdir(), `interleaf-onboarding-${tag}-`));
}

async function setZoom(app: AppHandle, factor: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value);
  }, factor);
  await app.window.waitForTimeout(400);
}

async function setWindowSize(app: AppHandle, width: number, height: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await app.window.waitForTimeout(400);
}

test.describe('guided onboarding', () => {
  // Undefined until a test assigns it, because `afterEach` also runs for a test
  // that failed before it got that far.
  let userDataDir: string | undefined;
  let app: AppHandle | null = null;

  test.afterEach(async () => {
    await app?.close({ preserveUserData: true });
    app = null;
    if (userDataDir !== undefined) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('opens itself on a genuinely first launch and stays away afterwards', async () => {
    userDataDir = persistentUserData('first-launch');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    const wizard = app.window.getByTestId('onboarding-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard).toHaveAttribute('data-stage', 'welcome');

    // Discovery reaches every row without a single one blocking the others.
    await app.window.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'discover');
    const page = app.window;
    const rows = page.getByTestId('onboarding-rows').getByRole('listitem');
    await expect(rows.first()).toBeVisible();
    await expect
      .poll(async () => page.getByTestId('onboarding-rows').locator('[data-state="checking"]').count(), {
        timeout: 30_000,
      })
      .toBe(0);

    // Grouped, counted, and one row per provider: the count a group states is
    // the number of rows it actually contains.
    const groups = page.getByTestId('onboarding-rows').locator('section[data-testid^="onboarding-group-"]');
    expect(await groups.count()).toBeGreaterThan(0);
    for (const group of await groups.all()) {
      const stated = await group.getAttribute('data-count');
      expect(stated).toBe(String(await group.getByRole('listitem').count()));
    }
    expect(await rows.count()).toBe(
      new Set(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')))).size
    );
    await expect(page.getByTestId('onboarding-footer-note')).toContainText('two modes a tool can serve');

    // Leaving is always allowed, and it is what suppresses reopening.
    await app.window.getByTestId('onboarding-skip-ai').click();
    await expect(wizard).toBeHidden();

    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });
    await expect(app.window.getByTestId('onboarding-wizard')).toHaveCount(0);
    await expect(app.window.getByTestId('onboarding-entry-banner')).toHaveCount(0);
  });

  test('a dismissal in this process survives a renderer reload', async () => {
    userDataDir = persistentUserData('reload');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    // No helper is involved here: this launch keeps production behaviour, so
    // what the reload does is what a reader would get.
    await expect(app.window.getByTestId('onboarding-wizard')).toBeVisible();
    await app.window.getByTestId('onboarding-start-reading').click();
    await expect(app.window.getByTestId('onboarding-wizard')).toBeHidden();

    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');

    // The launch verdict main latched is still "new install", but the reader
    // has since left the flow, and a reload is not a new launch.
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('onboarding-wizard')).toHaveCount(0);
    await expect(app.window.getByTestId('open-settings')).toBeEnabled();
    await app.window.getByTestId('open-settings').click();
    await expect(app.window.getByTestId('ai-providers-settings-modal')).toBeVisible();
  });

  test('reading works with no provider, no account and the wizard dismissed', async () => {
    userDataDir = persistentUserData('reading');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    await app.window.getByTestId('onboarding-start-reading').click();
    await expect(app.window.getByTestId('onboarding-wizard')).toBeHidden();

    // The shell underneath is live, not inert, the moment the wizard is gone.
    await expect(app.window.getByTestId('open-settings')).toBeEnabled();
    await app.window.getByTestId('open-settings').click();
    await expect(app.window.getByTestId('ai-providers-settings-modal')).toBeVisible();
  });

  test('is operable from the keyboard and returns focus on Escape', async () => {
    userDataDir = persistentUserData('keyboard');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    const page = app.window;
    const wizard = page.getByTestId('onboarding-wizard');
    await expect(wizard).toBeVisible();

    // Focus starts inside the dialog rather than behind it.
    await expect
      .poll(async () =>
        page.evaluate(() => document.querySelector('[data-testid="onboarding-wizard"]')?.contains(document.activeElement) ?? false)
      )
      .toBe(true);

    await page.keyboard.press('Tab');
    await expect
      .poll(async () =>
        page.evaluate(() => document.querySelector('[data-testid="onboarding-wizard"]')?.contains(document.activeElement) ?? false)
      )
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(wizard).toBeHidden();
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.id ?? ''))
      .toBe('main-content');
  });

  test('reflows at 200% zoom and in a small window', async () => {
    userDataDir = persistentUserData('reflow');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    const wizard = app.window.getByTestId('onboarding-wizard');
    await expect(wizard).toBeVisible();
    await app.window.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'discover');

    await setZoom(app, 2);
    await expect(wizard).toBeVisible();
    // Nothing is clipped away: the primary exit is still reachable.
    await expect(app.window.getByTestId('onboarding-continue')).toBeVisible();
    await setZoom(app, 1);

    await setWindowSize(app, 720, 620);
    await expect(wizard).toBeVisible();
    await expect(app.window.getByTestId('onboarding-continue')).toBeVisible();

    // Step 3 reflows too: the card's two columns collapse rather than clip.
    await app.window.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'connect');
    await expect(app.window.getByTestId('onboarding-defaults-card')).toBeVisible();
  });

  test('offers defaults as one card and commits them with a single Continue', async () => {
    userDataDir = persistentUserData('defaults');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });
    const page = app.window;
    const wizard = page.getByTestId('onboarding-wizard');

    await expect(wizard).toBeVisible();
    await page.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'discover');
    await expect
      .poll(async () => page.getByTestId('onboarding-rows').locator('[data-state="checking"]').count(), {
        timeout: 30_000,
      })
      .toBe(0);

    await page.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'connect');
    await expect(page.getByRole('heading', { name: 'Choose your defaults' })).toBeVisible();
    await expect(page.getByTestId('onboarding-defaults-card')).toBeVisible();
    await expect(page.getByTestId('onboarding-default-chat')).toBeVisible();
    await expect(page.getByTestId('onboarding-default-agent')).toBeVisible();
    // Detection lives on Step 2 only; this step repeats no provider list.
    await expect(page.getByTestId('onboarding-rows')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-skip-defaults')).toBeVisible();

    // Whatever this machine detected, the step is never a trap.
    await page.getByTestId('onboarding-continue').click();
    await expect(wizard).toHaveAttribute('data-stage', 'import');
  });

  test('offers the first-action tip beside a live document, and it is dismissible', async () => {
    userDataDir = persistentUserData('tip');
    const fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-onboarding-fixture-'));
    const pdfPath = join(fixtureDir, 'Reading_Sample.pdf');
    writeFileSync(
      pdfPath,
      makePdfFixture({ title: 'Reading Sample', author: 'Fixture', pages: ['A page to read and annotate.'] })
    );
    try {
      app = await launchInterleaf({ userDataDir, preserveOnboarding: true });
      const wizard = app.window.getByTestId('onboarding-wizard');
      await expect(wizard).toBeVisible();

      // The tip is deferred while nothing is open: completion never depends on
      // having a document.
      for (let step = 0; step < 4; step += 1) await app.window.getByTestId('onboarding-continue').click();
      await expect(wizard).toBeHidden();
      await expect(app.window.getByTestId('onboarding-first-action-tip')).toHaveCount(0);

      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
      expect(documents).toHaveLength(1);
      await app.window.getByTestId(`read-doc-${documents[0]!.id}`).click();

      const tip = app.window.getByTestId('onboarding-first-action-tip');
      await expect(tip).toBeVisible();
      // Non-modal: the document underneath stays live rather than inert.
      await expect(app.window.locator('[data-app-shell]')).not.toHaveAttribute('inert', '');

      await app.window.getByTestId('onboarding-tip-got-it').click();
      await expect(tip).toHaveCount(0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('finishing the flow persists and does not run again', async () => {
    userDataDir = persistentUserData('complete');
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });

    const wizard = app.window.getByTestId('onboarding-wizard');
    await expect(wizard).toBeVisible();
    for (const stage of ['welcome', 'discover', 'connect', 'import']) {
      await expect(wizard).toHaveAttribute('data-stage', stage);
      await app.window.getByTestId('onboarding-continue').click();
    }
    await expect(wizard).toBeHidden();

    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir, preserveOnboarding: true });
    await expect(app.window.getByTestId('onboarding-wizard')).toHaveCount(0);

    // And it stays reachable on purpose, from Settings.
    await app.window.getByTestId('open-settings').click();
    const settings = app.window.getByTestId('ai-providers-settings-modal');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'General' }).click();
    await expect(app.window.getByTestId('settings-rerun-onboarding')).toBeVisible();
    await app.window.getByTestId('settings-rerun-onboarding').click();
    await expect(app.window.getByTestId('onboarding-wizard')).toBeVisible();
    await expect(app.window.getByTestId('ai-providers-settings-modal')).toHaveCount(0);
  });
});
