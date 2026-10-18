import { expect, test } from '@playwright/test';
import { launchInterleaf, type AppHandle } from './helpers';
import type { AppSettings } from '@shared/schemas/settings';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let app: AppHandle;

test.beforeEach(async () => {
  app = await launchInterleaf();
});

test.afterEach(async () => {
  await app.close();
});

test('launches with the Interleaf title and a narrow typed bridge', async () => {
  await expect(app.window).toHaveTitle(/Interleaf/);

  const windowSummary = await app.electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return {
      totalCount: windows.length,
      liveCount: windows.filter((win) => !win.isDestroyed()).length,
      titles: windows.filter((win) => !win.isDestroyed()).map((win) => win.getTitle()),
    };
  });

  expect(windowSummary.totalCount).toBe(1);
  expect(windowSummary.liveCount).toBe(1);
  expect(windowSummary.titles).toEqual(['Interleaf']);

  const probe = await app.window.evaluate(() => {
    // The bridge is the only member the renderer may see; everything else is
    // probed by name so its *absence* is what the assertions read.
    const hasBridge = 'interleafAPI' in window;
    const bridge = window.interleafAPI;
    return {
      hasBridge,
      hasRawIpcRenderer: 'ipcRenderer' in window,
      hasRequire: 'require' in window,
      hasNodeProcess: 'process' in window,
      bridgeKeys: hasBridge ? Object.keys(bridge).sort() : [],
      libraryKeys: hasBridge ? Object.keys(bridge.library).sort() : [],
      searchKeys: hasBridge ? Object.keys(bridge.search).sort() : [],
    };
  });

  expect(probe.hasBridge).toBe(true);
  expect(probe.hasRawIpcRenderer).toBe(false);
  expect(probe.hasRequire).toBe(false);
  expect(probe.hasNodeProcess).toBe(false);
  expect(probe.bridgeKeys).toEqual([
    'agent',
    'ai',
    'annotations',
    'app',
    'chat',
    'clipboard',
    'credentials',
    // Opening a file without importing it: a dialog request, the pending
    // launch files, and a menu-command subscription, each over a fixed channel.
    'files',
    'library',
    // Guided onboarding reads one latched launch verdict — booleans and one
    // enum member — over a schema-validated call. It is listed here because the
    // exhaustive list is the point: a namespace appears only by being reviewed.
    'onboarding',
    // The reader namespace carries exactly one reviewed call: the fenced
    // `mermaid` render request (`docs/ARCHITECTURE.md` §7, `docs/SECURITY.md`).
    // Its reply is re-parsed against the shared schema at the bridge, so the
    // renderer still receives a contract value rather than main's raw output.
    'reader',
    'search',
    'settings',
    // Stable-channel updates: payload-free calls whose replies are re-parsed at
    // the bridge (`docs/ARCHITECTURE.md` §9, `docs/SECURITY.md`).
    'updates',
  ]);
  const onboardingKeys = await app.window.evaluate(() =>
    Object.keys((window as { interleafAPI: { onboarding: object } }).interleafAPI.onboarding).sort()
  );
  expect(onboardingKeys).toEqual(['getLaunchState']);
  const updatesKeys = await app.window.evaluate(() =>
    Object.keys((window as { interleafAPI: { updates: object } }).interleafAPI.updates).sort()
  );
  expect(updatesKeys).toEqual(['check', 'download', 'getState', 'onState', 'openReleasePage', 'restart']);
  expect(probe.libraryKeys).not.toContain('importFiles');
  expect(probe.searchKeys).toEqual([
    'appendIndex',
    'beginIndex',
    'completeIndex',
    'failIndex',
    'getIndexState',
    'resolveHit',
    'searchDocument',
  ]);
});

test('app:get-info returns validated runtime info over the typed IPC', async () => {
  const info = await app.window.evaluate(async () => {
    const result = await window.interleafAPI.app.getInfo();
    return result;
  });
  expect(info.name).toBe('Interleaf');
  expect(info.tagline).toBe('Read. Think. Build.');
  expect(info.platform).toBe('darwin');
  expect(parseFloat(info.versions.electron)).toBeGreaterThanOrEqual(43);
});

test('built sandboxed preload exposes the bridge and reaches settings and library IPC', async () => {
  const builtPreload = readFileSync(join(process.cwd(), 'out/preload/index.js'), 'utf8');
  expect(builtPreload).toMatch(/require\(["']electron["']\)/u);
  expect(builtPreload).not.toMatch(/require\(\s*["']zod["']\s*\)/u);

  const boundaryResult = await app.window.evaluate(async () => {
    const api = (window as { readonly interleafAPI?: typeof window.interleafAPI }).interleafAPI;
    if (api === undefined) {
      return { hasBridge: false as const };
    }

    const [settings, documents] = await Promise.all([
      api.settings.get(),
      api.library.listDocuments(),
    ]);
    return {
      hasBridge: true as const,
      settingsVersion: settings.version,
      hasLibraryDocuments: Array.isArray(documents),
      documentCount: documents.length,
    };
  });

  expect(boundaryResult).toEqual({
    hasBridge: true,
    settingsVersion: 1,
    hasLibraryDocuments: true,
    documentCount: 0,
  });
});

test('settings round-trip through the SQLite store', async () => {
  const updated = await app.window.evaluate(async () => {
    const current = await window.interleafAPI.settings.get();
    return window.interleafAPI.settings.update({
      ...current,
      agent: { ...current.agent, defaultExecutionMode: 'isolated-copy' },
    });
  });
  expect(updated.agent.defaultExecutionMode).toBe('isolated-copy');

  const reread = await app.window.evaluate(async () => window.interleafAPI.settings.get());
  expect(reread.agent.defaultExecutionMode).toBe('isolated-copy');
});

test('rejects malformed settings payloads with a validation error', async () => {
  const outcome = await app.window.evaluate(async () => {
    try {
      // Bypass the typed surface: simulate a tampered renderer passing a raw
      // string where the settings document belongs.
      const bridge = window.interleafAPI;
      // Viewing the real bridge through a signature its contract forbids is the
      // point: only main-side validation can reject this call.
      type RawStringSettingsUpdate = {
        readonly settings: { update(next: string): Promise<AppSettings> };
      };
      const acceptsRawString = (
        value: typeof bridge
      ): value is typeof bridge & RawStringSettingsUpdate => 'settings' in value;
      if (!acceptsRawString(bridge)) return 'rejected: no settings bridge';
      await bridge.settings.update('{ "sql": "DROP TABLE documents" }');
      return 'accepted';
    } catch (error) {
      return error instanceof Error ? `rejected: ${error.message}` : 'rejected';
    }
  });
  expect(outcome.startsWith('rejected')).toBe(true);
});
