import { expect, test } from '@playwright/test';
import { launchInterleaf, type AppHandle } from './helpers';

/**
 * The shared launch helper's own contract.
 *
 * Every other Electron spec starts from an empty user-data directory, which the
 * application correctly reads as a first run and answers with a modal wizard
 * over the shell. The helper is what gets past it, so the behaviour those specs
 * silently depend on is asserted here rather than assumed: a default launch
 * reaches a live shell, and the way out is the application's own control rather
 * than a test-only switch. The opt-out's real first-run flow and the dismissal
 * surviving a reload are covered in `guided-onboarding.spec.ts`.
 */

let app: AppHandle | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

test('a default launch reaches a live shell with no wizard in front of it', async () => {
  app = await launchInterleaf();

  await expect(app.window.getByTestId('onboarding-wizard')).toHaveCount(0);
  // Nothing non-modal is left covering the shell either.
  await expect(app.window.getByTestId('onboarding-entry-banner')).toHaveCount(0);
  await expect(app.window.locator('[data-app-shell]')).not.toHaveAttribute('inert', '');

  // The first click a spec makes is the real test of F1: it must reach the
  // control rather than an overlay.
  await app.window.getByTestId('open-settings').click();
  await expect(app.window.getByTestId('ai-providers-settings-modal')).toBeVisible();
});

test('the helper leaves through the application flow, not a bypass', async () => {
  app = await launchInterleaf();

  // The wizard is gone because its own control recorded that exit, and the
  // channel answers with that decision rather than replaying the verdict
  // latched at startup — which is what used to put the wizard back on reload.
  const launchState = await app.window.evaluate(
    async () => window.interleafAPI.onboarding.getLaunchState()
  );
  expect(launchState.verdict).toBe('suppressed');
  expect(launchState.shouldAutoOpen).toBe(false);
  // The launch was still a genuine first run, and that is the one thing no
  // later page load can recompute, so it survives the reconciliation.
  expect(launchState.priorInstallEvidence).toBe(false);
  expect(launchState.settingsRowPresent).toBe(false);

  const onboarding = await app.window.evaluate(async () => (await window.interleafAPI.settings.get()).onboarding);
  expect(onboarding.status).toBe('finish-later');
});
