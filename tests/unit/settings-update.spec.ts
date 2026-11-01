import { describe, expect, it, vi } from 'vitest';
import { applySettingsUpdate, type SettingsUpdateDeps } from '@main/app/settings-update';
import { appSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * The rules of a settings write: main revalidates working directories first, a
 * profile newly switched to `unsafe-yolo` needs the native confirmation, and
 * every accepted document goes through one persist path with its runtime
 * effects.
 */

const UNSAFE_PROFILE: AppSettings['agent']['profiles'][string] = {
  binary: 'codex',
  arguments: [],
  defaultModel: null,
  models: [],
  reasoningEffort: null,
  permissionMode: 'unsafe-yolo',
  sandboxMode: 'auto-isolated',
  workingDirectoryPolicy: 'select-per-run',
  environmentOverrides: [],
};

function withProfiles(profiles: AppSettings['agent']['profiles']): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, agent: { ...DEFAULT_APP_SETTINGS.agent, profiles } };
}

function harness(stored: AppSettings, confirm: boolean) {
  const order: string[] = [];
  const deps: SettingsUpdateDeps = {
    settings: {
      get: () => stored,
      update: (next) => { order.push('persist'); return appSettingsSchema.parse(next); },
    },
    agent: {
      assertSettingsUpdateAllowed: () => { order.push('allowed'); },
      applyProfileSettings: () => { order.push('profiles'); },
      validateSavedWorkingDirectorySettings: () => { order.push('directories'); return Promise.resolve(); },
    },
    updates: { setAutomaticChecks: () => { order.push('updates'); } },
    applyDiagnosticLogging: () => { order.push('logging'); },
    confirmUnsafeProfile: vi.fn((profileId: string) => { order.push(`confirm:${profileId}`); return Promise.resolve(confirm); }),
  };
  return { deps, order };
}

describe('applySettingsUpdate', () => {
  it('persists an ordinary document once and applies every runtime effect after it', async () => {
    const { deps, order } = harness(DEFAULT_APP_SETTINGS, false);
    await expect(applySettingsUpdate(DEFAULT_APP_SETTINGS, deps)).resolves.toStrictEqual(DEFAULT_APP_SETTINGS);
    expect(order).toEqual(['directories', 'allowed', 'persist', 'profiles', 'logging', 'updates']);
    expect(deps.confirmUnsafeProfile).not.toHaveBeenCalled();
  });

  it('asks before a profile becomes unsafe and persists only when confirmed', async () => {
    const next = withProfiles({ codex: UNSAFE_PROFILE });
    const confirmed = harness(DEFAULT_APP_SETTINGS, true);
    await applySettingsUpdate(next, confirmed.deps);
    expect(confirmed.order).toEqual(['directories', 'confirm:codex', 'allowed', 'persist', 'profiles', 'logging', 'updates']);

    const declined = harness(DEFAULT_APP_SETTINGS, false);
    const refusal = applySettingsUpdate(next, declined.deps);
    await expect(refusal).rejects.toBeInstanceOf(InterleafError);
    await expect(refusal).rejects.toMatchObject({ code: 'validation', message: 'Unsafe profile changes were cancelled.' });
    expect(declined.order).toEqual(['directories', 'confirm:codex']);
  });

  it('does not ask again for a profile already stored as unsafe', async () => {
    const stored = withProfiles({ codex: UNSAFE_PROFILE });
    const { deps, order } = harness(stored, false);
    await applySettingsUpdate(stored, deps);
    expect(deps.confirmUnsafeProfile).not.toHaveBeenCalled();
    expect(order).toContain('persist');
  });

  it('revalidates working directories before any confirmation, and a refusal there stops the write', async () => {
    const { deps, order } = harness(DEFAULT_APP_SETTINGS, true);
    const failing: SettingsUpdateDeps = {
      ...deps,
      agent: { ...deps.agent, validateSavedWorkingDirectorySettings: () => Promise.reject(new InterleafError('validation', 'stale handle')) },
    };
    await expect(applySettingsUpdate(withProfiles({ codex: UNSAFE_PROFILE }), failing)).rejects.toMatchObject({ message: 'stale handle' });
    expect(order).toEqual([]);
  });
});
