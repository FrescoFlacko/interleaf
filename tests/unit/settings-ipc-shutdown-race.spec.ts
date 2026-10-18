import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkingDirectoryRegistry, type RegisteredWorkingDirectory } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { registerIpcHandlers, type IpcMainLike } from '@main/ipc/dispatcher';
import { makeIpcDeps } from '../helpers/ipc-deps';
import { IPC } from '@shared/constants/ipc';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { createSenderRule } from '@main/ipc/sender-validation';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { fileIdentityFromStats } from '@main/security/file-identity';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const roots: string[] = [];

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class DeferredWorkingDirectoryRegistry extends WorkingDirectoryRegistry {
  readonly resolution = deferred<RegisteredWorkingDirectory>();
  override resolve(): Promise<RegisteredWorkingDirectory> { return this.resolution.promise; }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('settings:update shutdown boundary', () => {
  it('does not call SettingsRepository.update after deferred directory validation and shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-settings-race-'));
    roots.push(root);
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    const repository = new AgentRepository(db);
    const settingsRepository = new SettingsRepository(db, logger);
    const registry = new DeferredWorkingDirectoryRegistry();
    const identity = fileIdentityFromStats(await stat(root, { bigint: true }));
    repository.registerWorkingDirectory({
      handle: 'race-directory',
      canonicalPath: await realpath(root),
      displayName: 'Race Workspace',
      ...identity,
    });
    const service = createTestAgentService({ database: db,
      repository,
      registry,
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(null),
      log: logger,
      isPackaged: false,
    });
    const update = vi.spyOn(settingsRepository, 'update');
    const originalSettingsGuard = service.assertSettingsUpdateAllowed.bind(service);
    let shutdown: Promise<void> | undefined;
    vi.spyOn(service, 'assertSettingsUpdateAllowed').mockImplementation(() => {
      // This is the exact hand-off point after async validation and before
      // SettingsRepository.update. Shutdown begins synchronously here; the
      // guard must reject the write rather than allowing a late persistence.
      shutdown = service.shutdown();
      originalSettingsGuard();
    });
    const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
    const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html', devUrl: 'http://localhost:5173' });
    const deps = makeIpcDeps({
      settings: settingsRepository,
      agent: service,
      senderRule,
      log: logger,
    });
    registerIpcHandlers({
      handle: (channel, listener) => {
        if (channel === IPC.settingsUpdate) handlers.set(channel, listener);
      },
    }, deps);
    const handler = handlers.get(IPC.settingsUpdate);
    if (handler === undefined) throw new Error('settings:update handler was not registered');
    const nextSettings = {
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        workingDirectories: [{ handle: 'race-directory', displayName: 'Race Workspace' }],
      },
    };
    const invoke = handler(
      { senderFrame: { url: senderRule.allowedProductionFileUrl } },
      nextSettings,
    );

    // Validation is suspended at the main-owned resolve seam. Resolving it
    // lets the dispatcher reach its final synchronous settings-write guard.
    await Promise.resolve();
    registry.resolution.resolve({
      handle: 'race-directory',
      canonicalPath: await realpath(root),
      ...identity,
    });
    const result = await invoke;
    if (shutdown === undefined) throw new Error('shutdown did not begin at the final settings guard');
    await shutdown;
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(update).not.toHaveBeenCalled();
    db.close();
  });
});
