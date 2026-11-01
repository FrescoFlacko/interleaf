import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { launchInterleaf } from '../helpers';
import { evaluatePreflight, preflightRequirements, probeHost } from './preflight';

/**
 * Runs before every project. It fails the run, with the reason, when this host
 * cannot provide what the selected job needs; see `preflight.ts`. The report
 * names each requirement and probe result, never environment values.
 */
test('platform preflight', ({}, testInfo) => {
  const host = process.platform;
  const probes = probeHost(host, process.env);
  const failures = evaluatePreflight(host, process.env, probes);
  const report = {
    host,
    declaredPlatform: process.env.INTERLEAF_E2E_PLATFORM ?? null,
    requirements: preflightRequirements(host, process.env),
    probes,
    failures,
  };
  writeFileSync(testInfo.outputPath('platform-preflight.json'), `${JSON.stringify(report, null, 2)}\n`);
  expect(failures, failures.join('\n')).toEqual([]);
});

/** Each credential operation must answer within this; a service that never replies fails the job here. */
const CREDENTIAL_STEP_MS = 20_000;
/**
 * Dummy data for this disposable profile only; it is stored, read back masked
 * and deleted, never printed. The store accepts only OpenRouter's key syntax
 * (`sk-or-v1-`, then letters, digits, `_` or `-`), so it keeps that prefix;
 * the rest is plain words, not a real key's 64-character form.
 */
const PREFLIGHT_KEY = 'sk-or-v1-interleaf-preflight-dummy-not-a-real-key';

/**
 * A secret service that merely owns its bus name is not a credential store.
 * When the job declares one, the app itself stores, reads back (masked) and
 * deletes a synthetic key through its real main-owned vault, in a fresh
 * profile under this run's disposable keyring, before any dependent project
 * starts. Every step is bounded, so an unresponsive service fails the job
 * instead of hanging it.
 */
test('credential store round trip through the app', async ({}, testInfo) => {
  test.skip(process.env.INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE !== '1', 'This job does not declare a credential store (INTERLEAF_E2E_REQUIRE_CREDENTIAL_STORE=1).');
  test.setTimeout(90_000);
  const app = await launchInterleaf();
  try {
    const steps = await app.window.evaluate(async ({ key, limit }) => {
      const bounded = <T,>(name: string, work: Promise<T>): Promise<T> => Promise.race([
        work,
        new Promise<T>((_resolve, reject) => { setTimeout(() => { reject(new Error(`${name} did not answer within ${String(limit)}ms`)); }, limit); }),
      ]);
      const api = window.interleafAPI;
      await bounded('store', api.ai.configureOpenRouter({ apiKey: key, model: 'openrouter/auto' }));
      const stored = await bounded('read', api.credentials.getOpenRouterStatus());
      const cleared = await bounded('delete', api.credentials.clearOpenRouterKey());
      const after = await bounded('read after delete', api.credentials.getOpenRouterStatus());
      return {
        stored: { configured: stored.configured, lastFour: stored.keyPreview?.lastFour ?? null, storage: stored.storageBackend },
        cleared: cleared.configured,
        after: after.configured,
      };
    }, { key: PREFLIGHT_KEY, limit: CREDENTIAL_STEP_MS });
    writeFileSync(testInfo.outputPath('credential-round-trip.json'), `${JSON.stringify(steps, null, 2)}\n`);
    expect(steps.stored).toMatchObject({ configured: true, lastFour: PREFLIGHT_KEY.slice(-4), storage: { available: true } });
    expect(steps.cleared).toBe(false);
    expect(steps.after).toBe(false);
  } finally {
    await app.close();
  }
});
