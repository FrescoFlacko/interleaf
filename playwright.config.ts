import { defineConfig } from '@playwright/test';
import { platformProjects } from './tests/e2e/platform/projects';

export default defineConfig({
  testDir: 'tests/e2e',
  // Verifies the offline guarantee (no real provider CLI reachable on the
  // sanitized PATH) before the first Electron launch. See
  // tests/e2e/offline-environment.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // shared (macOS and Linux), plus this host's native project, all behind the
  // platform preflight. See tests/e2e/platform/projects.ts and
  // docs/TEST_STRATEGY.md ("Platform projects").
  projects: platformProjects(process.platform, process.env),
});
