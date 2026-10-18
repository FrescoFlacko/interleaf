import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchInterleaf, pointLocalProviderAtTheTrap, type AppHandle } from './helpers';
import { localServerRequestsSince, standInForHostDefault } from './offline-local-server';

/**
 * The suite's own offline guarantee, asserted rather than assumed.
 *
 * `launchInterleaf` moves every launch onto this run's deny-all server and
 * reads the endpoint back, so these assertions already stand in front of every
 * application spec. What is left to prove is what that read-back cannot say by
 * itself: that the `local` provider really resolves against a server this
 * process owns and is refused by it, and that neither a renderer settings write
 * nor a reload nor a relaunch can put the host's inference port back.
 *
 * Nothing here makes a live CLI or inference call; the only server involved is
 * the one this process is listening on.
 */
test.describe('E2E offline guarantee', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
  });

  function storedEndpoint(userDataDir: string): string | undefined {
    const db = new DatabaseSync(join(userDataDir, 'database', 'interleaf.sqlite'));
    try {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as
        | { value_json: string }
        | undefined;
      if (row === undefined) return undefined;
      return (JSON.parse(row.value_json) as { ai?: { local?: { endpoint?: string } } }).ai?.local?.endpoint;
    } finally {
      db.close();
    }
  }

  test("resolves the local provider against this run's server, which refuses it", async () => {
    const before = app.localServer.requests.length;

    const status = await app.window.evaluate(async () =>
      window.interleafAPI.ai.getProviderStatus('local', { forceRefresh: true })
    );

    expect(status.available).toBe(false);
    // The probe is the evidence: it arrived here, on a port the operating
    // system handed this process, and was answered with a refusal. A request
    // recorded here is a request that reached nobody's real inference server.
    const probes = localServerRequestsSince(before);
    expect(probes.length).toBeGreaterThan(0);
  });

  test('cannot be pointed back at the host by a renderer settings write', async () => {
    // The shape every renderer writer uses: the hydrated document, one
    // unrelated preference changed, submitted whole. This is what used to put
    // the host default back when the endpoint was written mid-hydration.
    const afterWrite = await app.window.evaluate(async () => {
      const api = window.interleafAPI;
      const current = await api.settings.get();
      await api.settings.update({ ...current, companion: { ...current.companion, textSize: 1.1 } });
      return (await api.settings.get()).ai.local.endpoint;
    });

    expect(afterWrite).toBe(app.localServer.endpoint);
    expect(storedEndpoint(app.userDataDir)).toBe(app.localServer.endpoint);

    await app.window.reload();
    const afterReload = await app.window.evaluate(async () =>
      (await window.interleafAPI.settings.get()).ai.local.endpoint
    );
    expect(afterReload).toBe(app.localServer.endpoint);
  });

  test('survives a real UI settings writer that hydrated before the endpoint moved', async () => {
    // The state the launch helper has to survive: the renderer holding a
    // settings document from before the endpoint moved. It is reproduced with a
    // second server this process owns, never the host's real inference port —
    // reproducing "pointed at the host" by pointing at the host is exactly what
    // this fixture exists to prevent.
    const standIn = await standInForHostDefault();
    await app.window.evaluate(async (target) => {
      const api = window.interleafAPI;
      const current = await api.settings.get();
      await api.settings.update({
        ...current,
        ai: { ...current.ai, local: { ...current.ai.local, endpoint: target } },
      });
    }, standIn.endpoint);
    await app.window.reload();
    expect(
      await app.window.evaluate(async () => (await window.interleafAPI.settings.get()).ai.local.endpoint)
    ).toBe(standIn.endpoint);

    await pointLocalProviderAtTheTrap(app.window, app.localServer.endpoint, { rehydrate: true });

    // A real click on a real control: collapsing the Library sidebar makes
    // App.tsx persist the whole settings document it is holding. A stale one
    // would carry the stand-in endpoint straight back into main.
    const before = await app.window.evaluate(async () =>
      (await window.interleafAPI.settings.get()).layout.leftOpen
    );
    await app.window.getByTestId('toggle-left-panel').click();
    await expect
      .poll(async () =>
        app.window.evaluate(async () => (await window.interleafAPI.settings.get()).layout.leftOpen)
      )
      .toBe(!before);

    const endpoint = await app.window.evaluate(async () =>
      (await window.interleafAPI.settings.get()).ai.local.endpoint
    );
    expect(endpoint).toBe(app.localServer.endpoint);
    expect(storedEndpoint(app.userDataDir)).toBe(app.localServer.endpoint);

    // And the provider still resolves here, against the server this run owns.
    const trapBefore = app.localServer.requests.length;
    const status = await app.window.evaluate(async () =>
      window.interleafAPI.ai.getProviderStatus('local', { forceRefresh: true })
    );
    expect(status.available).toBe(false);
    expect(localServerRequestsSince(trapBefore).length).toBeGreaterThan(0);
    // The stand-in may have been probed while it held the address — a catalog
    // read is harmless and is what a status refresh does. What must never reach
    // it, or any server but this run's, is a turn.
    expect(standIn.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  test('survives a relaunch of the same profile', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-offline-guarantee-'));
    let relaunched: AppHandle | null = null;
    try {
      const first = await launchInterleaf({ userDataDir });
      await first.close({ preserveUserData: true });

      // A second launch reads the profile the first one left behind, so a
      // persisted endpoint is what it starts from — the host default cannot
      // come back through a profile this suite already moved.
      relaunched = await launchInterleaf({ userDataDir });
      const endpoint = await relaunched.window.evaluate(async () =>
        (await window.interleafAPI.settings.get()).ai.local.endpoint
      );
      expect(endpoint).toBe(relaunched.localServer.endpoint);
      expect(storedEndpoint(userDataDir)).toBe(relaunched.localServer.endpoint);
    } finally {
      await relaunched?.close({ preserveUserData: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
