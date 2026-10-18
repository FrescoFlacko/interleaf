import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '@main/agents/agent-service';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { fileIdentityFromStats } from '@main/security/file-identity';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const roots: string[] = [];

async function makeService(): Promise<{
  readonly db: InterleafDatabase;
  readonly repository: AgentRepository;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-working-directory-'));
  roots.push(root);
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  const repository = new AgentRepository(db);
  return { db, repository, root };
}

/** Persists `root` under `handle` with its current on-disk identity. */
async function registerRoot(repository: AgentRepository, handle: string, root: string, displayName = 'Workspace'): Promise<void> {
  const identity = fileIdentityFromStats(await stat(root, { bigint: true }));
  repository.registerWorkingDirectory({ handle, canonicalPath: await realpath(root), displayName, ...identity });
}

const countRows = (db: InterleafDatabase) => db.raw.prepare('SELECT COUNT(*) as cnt FROM allowed_working_directories').get();

function createService(db: InterleafDatabase, repository: AgentRepository, root: string): AgentService {
  return createTestAgentService({ database: db,
    repository,
    registry: new WorkingDirectoryRegistry(),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(root),
    log: logger,
    isPackaged: false,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('working-directory capability rehydration and validation', () => {
  it('rehydrates a persisted directory and returns only its public projection', async () => {
    const { db, repository, root } = await makeService();
    try {
      await registerRoot(repository, 'persisted-directory', root);
      const service = createService(db, repository, root);

      await expect(service.listWorkingDirectories()).resolves.toEqual([
        { handle: 'persisted-directory', displayName: 'Workspace' },
      ]);
    } finally {
      db.close();
    }
  });

  it('omits stale and path-like durable identities without leaking canonical paths', async () => {
    const { db, repository, root } = await makeService();
    try {
      await registerRoot(repository, 'stale-directory', root);
      const service = createService(db, repository, root);
      await rm(root, { recursive: true, force: true });
      await expect(service.listWorkingDirectories()).resolves.toEqual([]);

      const freshRoot = await mkdtemp(join(tmpdir(), 'interleaf-working-directory-forged-'));
      roots.push(freshRoot);
      await registerRoot(repository, 'forged-display', freshRoot, freshRoot);
      const freshService = createService(db, repository, freshRoot);
      await expect(freshService.listWorkingDirectories()).resolves.toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects forged settings labels for a valid handle before persistence', async () => {
    const { db, repository, root } = await makeService();
    try {
      await registerRoot(repository, 'trusted-directory', root);
      const service = createService(db, repository, root);
      const forged: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        agent: {
          ...DEFAULT_APP_SETTINGS.agent,
          workingDirectories: [{ handle: 'trusted-directory', displayName: 'Forged' }],
        },
      };
      await expect(service.validateSavedWorkingDirectorySettings(forged)).rejects.toMatchObject({ code: 'security-violation' });
      expect(repository.getWorkingDirectory('trusted-directory')?.displayName).toBe('Workspace');
    } finally {
      db.close();
    }
  });

  it('reuses the durable handle when selecting the same directory twice and preserves canonical_path uniqueness', async () => {
    const { db, repository, root } = await makeService();
    try {
      const service = createService(db, repository, root);

      const first = await service.selectWorkingDirectory();
      const second = await service.selectWorkingDirectory();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.handle).toBe(second?.handle);
      expect(first?.displayName).toBe(second?.displayName);

      const rows = repository.listWorkingDirectories();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.handle).toBe(first?.handle);
      expect(rows[0]?.canonicalPath).toBe(await realpath(root));

      expect(countRows(db)).toEqual({ cnt: 1 });
    } finally {
      db.close();
    }
  });

  it('preserves durable handle across service restarts and rehydrates reverse lookup', async () => {
    const { db, repository, root } = await makeService();
    try {
      const service1 = createService(db, repository, root);
      const first = await service1.selectWorkingDirectory();
      expect(first).not.toBeNull();

      // Simulate service restart: create a new service with a fresh WorkingDirectoryRegistry
      // initialized against the same persisted database repository
      const service2 = createService(db, repository, root);
      const second = await service2.selectWorkingDirectory();
      expect(second).not.toBeNull();

      expect(second?.handle).toBe(first?.handle);

      const rows = repository.listWorkingDirectories();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.handle).toBe(first?.handle);
    } finally {
      db.close();
    }
  });

  it('explicit native re-selection safely updates durable handle when identity changed on disk without constraint errors', async () => {
    const { db, repository, root } = await makeService();
    try {
      const canonicalRoot = await realpath(root);
      // Seed DB with an old/stale identity
      repository.registerWorkingDirectory({
        handle: 'durable-resumed-handle',
        canonicalPath: canonicalRoot,
        displayName: 'Old Name',
        device: 99999,
        inode: 88888,
        birthtimeNs: '1',
      });

      const service = createService(db, repository, root);

      // Stale capability fails closed in listWorkingDirectories
      const listBefore = await service.listWorkingDirectories();
      expect(listBefore).toEqual([]);

      // User explicitly reselects the directory via native dialog
      const reselected = await service.selectWorkingDirectory();
      expect(reselected).not.toBeNull();
      expect(reselected?.handle).toBe('durable-resumed-handle');

      // DB row was updated ON CONFLICT(handle) with fresh identity
      const stored = repository.getWorkingDirectory('durable-resumed-handle');
      const realIdentity = fileIdentityFromStats(await stat(canonicalRoot, { bigint: true }));
      expect(stored).toMatchObject(realIdentity);
      expect(realIdentity.birthtimeNs).not.toBeNull();

      // Now listWorkingDirectories returns the refreshed capability
      const listAfter = await service.listWorkingDirectories();
      expect(listAfter).toEqual([
        { handle: 'durable-resumed-handle', displayName: reselected?.displayName ?? 'Selected folder' },
      ]);

      // Table still has exactly 1 row
      expect(countRows(db)).toEqual({ cnt: 1 });
    } finally {
      db.close();
    }
  });

  it('converges concurrent selectWorkingDirectory calls to one handle and one DB row', async () => {
    const { db, repository, root } = await makeService();
    try {
      const service = createService(db, repository, root);

      const [res1, res2, res3] = await Promise.all([1, 2, 3].map(() => service.selectWorkingDirectory()));
      for (const result of [res1, res2, res3]) expect(result).not.toBeNull();
      expect(res1?.handle).toBe(res2?.handle);
      expect(res2?.handle).toBe(res3?.handle);

      const rows = repository.listWorkingDirectories();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.handle).toBe(res1?.handle);
    } finally {
      db.close();
    }
  });
});
