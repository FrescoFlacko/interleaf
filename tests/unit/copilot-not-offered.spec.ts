import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { AgentRegistry } from '@main/agents/agent-adapter';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { AgentProfileStatus } from '@shared/types/agent';
import { PROFILE_EDITOR_DEFINITIONS } from '../../src/renderer/features/agent/profile-preferences';
import { deriveProviderRows } from '../../src/renderer/features/chat/provider-rows';
import { deriveOnboardingRows } from '../../src/renderer/features/onboarding/onboarding-rows';
import {
  agentDefaultOptions,
  persistedAgentChoice,
  resolveDefaultChoice,
} from '../../src/renderer/features/onboarding/onboarding-defaults';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { silentLogger } from '../helpers/silent-logger';

// Detection resolves CLIs through this search path. Pointing it at a fixture
// directory keeps the real registration path while never probing a host CLI.
const searchPath = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock('@main/app/cli-search-path', () => ({ buildCliSearchPath: () => searchPath.current }));

/**
 * GitHub Copilot CLI is refused for unattended Agent Mode, so it is not a
 * built-in integration at all: no registered profile, no Settings row, no
 * onboarding row or default. Older installs may still hold Copilot preferences,
 * and those must keep parsing without becoming runnable.
 */

const legacyCopilotPreference: NonNullable<AppSettings['agent']['profiles'][string]> = {
  binary: 'copilot',
  arguments: ['--stream', 'on'],
  defaultModel: null,
  models: [],
  reasoningEffort: null,
  permissionMode: 'normal',
  sandboxMode: 'auto-isolated',
  workingDirectoryPolicy: 'select-per-run',
  environmentOverrides: [],
};

const staleCopilotStatus: AgentProfileStatus = {
  profileId: 'copilot',
  providerId: 'copilot',
  name: 'GitHub Copilot CLI',
  availability: 'not-installed',
  unavailability: 'unsupported',
  version: null,
  errorMessage: 'GitHub Copilot CLI is unavailable for unattended Agent Mode.',
  checkedAt: '2026-01-01T00:00:00.000Z',
  defaultModel: null,
  availableModels: [],
  supportsModelSelection: true,
  isCustom: false,
};

// Every built-in binary plus a `copilot` that records any attempt to run it.
const FIXTURE_BINARIES = ['codex', 'claude', 'agy', 'opencode', 'pi', 'cursor-agent'] as const;
let fixtureDir = '';
let copilotMarker = '';

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-copilot-fixture-'));
  copilotMarker = join(fixtureDir, 'copilot-was-run');
  for (const binary of FIXTURE_BINARIES) {
    writeFileSync(join(fixtureDir, binary), `#!/bin/sh\necho "${binary} fixture 1.0.0"\n`);
    chmodSync(join(fixtureDir, binary), 0o755);
  }
  writeFileSync(join(fixtureDir, 'copilot'), `#!/bin/sh\ntouch '${copilotMarker}'\necho "copilot fixture"\n`);
  chmodSync(join(fixtureDir, 'copilot'), 0o755);
  // Lookup itself runs `which` from the search path, so the path holds nothing else.
  const which = ['/usr/bin/which', '/bin/which'].find((candidate) => existsSync(candidate));
  if (which === undefined) throw new Error('No system `which` for the detection fixture.');
  symlinkSync(which, join(fixtureDir, 'which'));
  searchPath.current = fixtureDir;
});

afterAll(() => {
  searchPath.current = undefined;
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('GitHub Copilot is not a built-in integration', () => {
  // Detection sequentially resolves each built-in CLI candidate ('codex', 'claude',
  // 'agy', 'opencode', 'pi', 'cursor-agent') by invoking which and spawning real
  // child processes to probe version strings. Under high-concurrency worker load
  // (356 test suites), 6 sequential subprocess spawns need an aggregate budget of
  // 15s to avoid false timeouts while preserving real detection and the copilotMarker check.
  it('is neither detected nor registered by the main agent registry', async () => {
    const registry = new AgentRegistry(testAgentRegistryOptions());
    const detected = await registry.detect();

    // The fixture CLIs were really detected, so this is the real registration path.
    expect(detected.find((profile) => profile.id === 'codex')?.detection.version).toBe('codex fixture 1.0.0');
    expect(detected.map((profile) => profile.id)).not.toContain('copilot');
    expect(detected.map((profile) => profile.providerId)).not.toContain('copilot');
    expect(registry.getAdapter('copilot')).toBeUndefined();
    // A `copilot` on the search path is never probed.
    expect(existsSync(copilotMarker)).toBe(false);
  }, 15_000);

  it('does not let a legacy Copilot preference recreate a runnable profile', async () => {
    const registry = new AgentRegistry(testAgentRegistryOptions());
    await registry.detect();

    registry.applyProfileSettings({ copilot: legacyCopilotPreference });

    expect(registry.getAdapter('copilot')).toBeUndefined();
    expect(registry.listMainProfiles().map((profile) => profile.id)).not.toContain('copilot');
  }, 15_000);

  it('is absent from the shared built-in editor table and the Settings provider rows', () => {
    expect(PROFILE_EDITOR_DEFINITIONS.map((definition) => definition.id)).not.toContain('copilot');

    const rows = deriveProviderRows({
      providers: [],
      // A stale detection record for Copilot must not bring its row back.
      profiles: [{ id: 'copilot', detection: { availability: 'not-installed', version: null, checkedAt: '2026-01-01T00:00:00.000Z', errorMessage: null } }],
      openRouterCredential: 'absent',
    });
    expect(rows.map((row) => row.id)).not.toContain('copilot');
    for (const row of rows) expect(`${row.name} ${row.description}`).not.toMatch(/copilot/iu);
  });

  it('is not an onboarding row or Agent Mode default, even from stale statuses or a legacy default', () => {
    const rows = deriveOnboardingRows({
      chatProbes: {},
      agentProfiles: [staleCopilotStatus],
      agentDiscoveryPending: false,
      agentDetectionPending: false,
      openRouterCredential: 'absent',
    });
    expect(rows.map((row) => row.id)).not.toContain('copilot');

    const options = agentDefaultOptions(rows);
    expect(options.map((option) => option.id)).not.toContain('copilot');

    const legacySettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultProfileId: 'copilot', profiles: { copilot: legacyCopilotPreference } },
    };
    const persisted = persistedAgentChoice(legacySettings);
    expect(resolveDefaultChoice(options, persisted, null)?.id).not.toBe('copilot');
  });

  it('keeps parsing legacy persisted Copilot preferences instead of discarding the settings document', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      const repo = new SettingsRepository(db, silentLogger);
      const legacy = {
        ...repo.get(),
        agent: { ...repo.get().agent, defaultProfileId: 'copilot', profiles: { copilot: legacyCopilotPreference } },
        // A sentinel unrelated preference: falling back to defaults would lose it.
        privacy: { ...repo.get().privacy, confirmExternalLinks: true },
      };
      db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(legacy), 'app');

      const loaded = repo.get();
      expect(loaded.privacy.confirmExternalLinks).toBe(true);
      expect(loaded.agent.defaultProfileId).toBe('copilot');
      expect(loaded.agent.profiles.copilot?.binary).toBe('copilot');
    } finally {
      db.close();
    }
  });
});
