import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '@main/agents/agent-service';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { sameFileIdentity, statWithIdentity } from '@main/security/file-identity';

/**
 * Regression coverage for the reported Active Environment failure: selecting a
 * still-valid working directory reported "The working-directory handle is
 * invalid or expired."
 *
 * The durable `allowed_working_directories` row and the directory's device/inode
 * still agreed, so the capability had not actually expired. Only the registry's
 * process-local cache had dropped it after an earlier `resolve()` failure, and
 * nothing re-read the durable row for the rest of the process lifetime.
 *
 * These tests drive the real AgentService, AgentRepository, SQLite schema, and
 * filesystem so the boundary being asserted is the production one.
 */

const TEST_DOCUMENT_ID = 'test-doc';
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const roots: string[] = [];

const profile: MainAgentProfile = {
  id: 'fake', providerId: 'fake', name: 'Fixture', binaryPath: 'fixture', defaultArgs: [],
  defaultModel: null, reasoningEffort: null, permissionMode: 'fixture', defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: false, nativeSandbox: true, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: 'fixture', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};

class ControlledAdapter implements AgentAdapter {
  readonly profile = profile;
  readonly capabilities = profile.capabilities;
  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(profile.detection); }
  start(): AgentAdapterRun {
    const timestamp = new Date().toISOString();
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }
  cancel(): void { /* Each run owns its cancellation. */ }
}

class ControlledRegistry extends AgentRegistry {
  constructor(private readonly adapter: ControlledAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
  override addFakeAdapter(): MainAgentProfile { return profile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

type Harness = {
  readonly service: AgentService;
  readonly repository: AgentRepository;
  readonly registry: WorkingDirectoryRegistry;
  readonly db: ReturnType<typeof InterleafDatabase.open>;
  readonly root: string;
  readonly target: string;
};

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-directory-recovery-'));
  roots.push(root);
  const target = join(root, 'test-directory');
  await mkdir(target, { recursive: true });
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT OR IGNORE INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES (?, 'Test document', 'pdf', ?, 'managed', 1, 1, ?)
  `).run(TEST_DOCUMENT_ID, `/tmp/${TEST_DOCUMENT_ID}.pdf`, `hash-${TEST_DOCUMENT_ID}`);
  const repository = new AgentRepository(db);
  const registry = new WorkingDirectoryRegistry();
  const service = createTestAgentService({ database: db,
    repository,
    registry,
    agentRegistry: new ControlledRegistry(new ControlledAdapter()),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(target),
    log: logger,
    isPackaged: false,
    isGitRepository: () => Promise.resolve(false),
    confirmDirectWorkspace: () => Promise.resolve(true),
  });
  await service.initialize();
  return { service, repository, registry, db, root, target };
}

/** Drives the full renderer-visible Active Environment launch sequence. */
async function startInActiveEnvironment(service: AgentService, handle: string, ownerId: number): Promise<string> {
  const draftId = crypto.randomUUID();
  const grant = await service.issueRiskGrant({
    draftId,
    profileId: 'fake',
    workingDirectoryHandle: handle,
    executionMode: 'active-env',
    prompt: 'Work directly in the selected directory.',
    model: null,
    contextPacket: null,
  }, ownerId);
  const started = await service.startSession({
    documentId: TEST_DOCUMENT_ID,
    profileId: 'fake',
    workingDirectoryHandle: handle,
    executionMode: 'active-env',
    prompt: 'Work directly in the selected directory.',
    contextPacket: null,
    model: null,
    riskConfirmation: { grantId: grant.grantId, draftId: draftId },
  }, ownerId);
  return started.session.id;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('working-directory capability recovery', () => {
  it('recovers a still-valid capability after a transient filesystem failure instead of reporting it as expired', async () => {
    const { service, repository, db, root, target } = await createHarness();
    try {
      const selected = await service.selectWorkingDirectory();
      expect(selected).not.toBeNull();
      const handle = selected!.handle;
      const { identity: identityBefore } = await statWithIdentity(target);

      // A transient unavailability: the directory is briefly moved aside. The
      // registry's fail-closed eviction is correct; permanently forgetting the
      // durable row is what produced the reported failure.
      const parked = join(root, 'parked');
      await rename(target, parked);
      expect(await service.listWorkingDirectories()).toEqual([]);
      await rename(parked, target);

      // The durable record and the directory identity still agree exactly.
      const { identity: identityAfter } = await statWithIdentity(target);
      expect(sameFileIdentity(identityBefore, identityAfter)).toBe(true);
      const stored = repository.getWorkingDirectory(handle);
      expect(stored?.canonicalPath).toBe(await realpath(target));
      expect(stored).toMatchObject(identityAfter);

      // The capability must come back without forcing another native selection.
      await expect(service.listWorkingDirectories()).resolves.toEqual([
        { handle, displayName: selected!.displayName },
      ]);
      const sessionId = await startInActiveEnvironment(service, handle, 9101);
      expect(sessionId).toBeTruthy();
    } finally {
      await service.shutdown();
      db.close();
    }
  });

  it('still fails closed when the directory identity actually changed', async () => {
    const { service, db, target } = await createHarness();
    try {
      const selected = await service.selectWorkingDirectory();
      const handle = selected!.handle;

      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });

      await expect(service.listWorkingDirectories()).resolves.toEqual([]);
      await expect(startInActiveEnvironment(service, handle, 9102)).rejects.toMatchObject({
        message: 'The registered working directory changed and must be selected again.',
      });

      // Explicit native re-selection remains the only way to re-admit it.
      const reselected = await service.selectWorkingDirectory();
      expect(reselected?.handle).toBe(handle);
      await expect(service.listWorkingDirectories()).resolves.toEqual([
        { handle, displayName: reselected!.displayName },
      ]);
      expect(await startInActiveEnvironment(service, handle, 9103)).toBeTruthy();
    } finally {
      await service.shutdown();
      db.close();
    }
  });

  it('rejects a handle that has no durable capability row', async () => {
    const { service, db } = await createHarness();
    try {
      await service.selectWorkingDirectory();
      await expect(startInActiveEnvironment(service, 'not-a-registered-handle', 9104)).rejects.toMatchObject({
        message: 'The working-directory handle is invalid or expired.',
      });
    } finally {
      await service.shutdown();
      db.close();
    }
  });

  it('keeps a revoked handle rejected even though its durable row still exists', async () => {
    const { service, repository, registry, db } = await createHarness();
    try {
      const selected = await service.selectWorkingDirectory();
      const handle = selected!.handle;
      expect(registry.revoke(handle)).toBe(true);
      expect(repository.getWorkingDirectory(handle)).not.toBeNull();

      await expect(registry.resolve(handle)).rejects.toMatchObject({
        message: 'The working-directory handle is invalid or expired.',
      });
      await expect(service.listWorkingDirectories()).resolves.toEqual([]);
      await expect(startInActiveEnvironment(service, handle, 9105)).rejects.toMatchObject({
        message: 'The working-directory handle is invalid or expired.',
      });
    } finally {
      await service.shutdown();
      db.close();
    }
  });
});
