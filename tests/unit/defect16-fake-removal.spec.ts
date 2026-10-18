import { afterEach, describe, expect, it } from 'vitest';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { AgentRegistry } from '@main/agents/agent-adapter';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { aiProviderIdSchema } from '@shared/schemas/ai';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { silentLogger } from '../helpers/silent-logger';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

describe('Defect 16 fake runtime removal', () => {
  let database: InterleafDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('keeps fake provider outside the production registry and IPC identifier schema', () => {
    // A packaged build ignores the test-double flag even when it is set.
    const production = new AIProviderRegistry(testAIProviderRegistryInput({ isPackaged: true, allowFakeProvider: true }));
    expect(() => production.require('fake')).toThrow(/unavailable/u);
    expect(aiProviderIdSchema.safeParse('fake').success).toBe(false);

    const injected = new AIProviderRegistry(testAIProviderRegistryInput({ allowFakeProvider: true }));
    expect(injected.require('fake').id).toBe('fake');
  });

  it('does not detect a fake agent unless a test explicitly injects the fixture adapter', async () => {
    const registry = new AgentRegistry(testAgentRegistryOptions());
    const detected = await registry.detect();
    expect(detected.some((profile) => profile.id === 'fake')).toBe(false);
    expect(registry.addFakeAdapter().id).toBe('fake');
  });

  it('drops stale fake settings while preserving unrelated user preferences', () => {
    database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    const settings = new SettingsRepository(database, silentLogger);
    const legacy = {
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: 'sepia' as const },
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        defaultWorkingDirectoryByProfile: { fake: 'legacy-handle' },
        profiles: {
          fake: {
            binary: 'interleaf-fake',
            arguments: [],
            defaultModel: null,
            reasoningEffort: null,
            permissionMode: 'fixture',
            sandboxMode: 'auto-isolated',
            workingDirectoryPolicy: 'select-per-run',
            environmentOverrides: [],
          },
        },
      },
    };
    database.raw.prepare(
      `UPDATE settings SET value_json = ?, updated_at = datetime('now', 'utc') WHERE key = 'app'`
    ).run(JSON.stringify(legacy));

    const migrated = settings.get();
    expect(migrated.appearance.palette).toBe('sepia');
    expect(migrated.agent.profiles).toEqual({});
    expect(migrated.agent.defaultWorkingDirectoryByProfile).toEqual({});
  });
});
