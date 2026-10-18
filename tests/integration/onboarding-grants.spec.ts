import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { InterleafDatabase, DATABASE_FILE_NAME } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { resolveExecutionMode } from '@main/agents/mode-resolver';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { silentLogger } from '../helpers/silent-logger';

/**
 * What finishing onboarding is **not** allowed to do.
 *
 * Choosing an agent default is a composer preference. It is not consent to run
 * anything, and it must not leave a workspace grant, a trusted directory or a
 * relaxed sandbox behind it. These assertions run against a real settings
 * store and the real mode resolver, because the claim is about persisted
 * authority rather than about what the wizard rendered.
 */

function makeStore(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'interleaf-onboarding-grants-'));
  return { directory, databasePath: path.join(directory, DATABASE_FILE_NAME) };
}

describe('onboarding grants nothing', () => {
  it('records defaults without touching sandboxing, working directories or permissions', () => {
    const store = makeStore();
    const database = InterleafDatabase.open(store.databasePath);
    try {
      runMigrations(database);
      const settings = new SettingsRepository(database, silentLogger);
      const before = settings.get();

      // Exactly the two writes the wizard performs when a user confirms both
      // defaults and then finishes.
      settings.update({
        ...before,
        ai: { ...before.ai, defaultChat: { providerId: 'openrouter', modelId: 'openrouter/auto' } },
        agent: { ...before.agent, defaultProfileId: 'claude-code' },
        onboarding: {
          ...before.onboarding,
          status: 'completed',
          lastStageAcknowledged: 'import',
          completedAt: '2026-09-15T00:00:00.000Z',
        },
      });

      const after = settings.get();
      expect(after.ai.defaultChat).toEqual({ providerId: 'openrouter', modelId: 'openrouter/auto' });
      expect(after.agent.defaultProfileId).toBe('claude-code');
      expect(after.onboarding.status).toBe('completed');

      // Everything that authorizes execution is byte-identical to a store that
      // never saw the wizard. `defaultProfileId` is deliberately excluded: it
      // is the composer preference the wizard is allowed to set, and it grants
      // nothing on its own.
      expect(after.agent.defaultExecutionMode).toBe(DEFAULT_APP_SETTINGS.agent.defaultExecutionMode);
      expect(after.agent.workingDirectories).toEqual([]);
      expect(after.agent.defaultWorkingDirectory).toBeNull();
      expect(after.agent.defaultWorkingDirectoryByProfile).toEqual({});
      expect(after.privacy).toEqual(before.privacy);

      // No grant, trusted path or permission row was created anywhere.
      const tables = database.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { readonly name: string }[];
      for (const { name } of tables) {
        if (!/grant|permission|trusted/i.test(name)) continue;
        const row = database.raw.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get();
        expect(row, `${name} is empty after onboarding`).toBeUndefined();
      }
    } finally {
      database.close();
      rmSync(store.directory, { recursive: true, force: true });
    }
  });

  it('still refuses a direct-workspace run that has no fresh confirmation grant', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'interleaf-onboarding-workspace-'));
    try {
      const registry = new WorkingDirectoryRegistry();
      const registered = await registry.register(workspace);

      await expect(
        resolveExecutionMode('active-env', {
          directoryHandle: registered.handle,
          directoryRegistry: registry,
          isGitRepo: () => Promise.resolve(false),
        })
      ).rejects.toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
