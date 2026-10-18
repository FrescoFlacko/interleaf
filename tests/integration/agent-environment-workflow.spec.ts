import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { AgentService } from '@main/agents/agent-service';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

class FixtureRegistry extends AgentRegistry {
  constructor(options: Partial<ConstructorParameters<typeof AgentRegistry>[0]> = {}) { super(testAgentRegistryOptions(options)); }
  override detect(): Promise<readonly never[]> { return Promise.resolve([]); }
}

async function waitForCompleted(service: AgentService, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const session = service.getSession(sessionId);
    if (session?.status === 'completed' || session?.status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('fixture agent did not complete');
}

describe('Workflow H/I environment decisions through AgentService', () => {
  it('streams a fake isolated change, applies it, then meaningfully discards a later sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-workflow-hi-'));
    const target = join(root, 'project');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), 'fixture project\n');
    execFileSync('git', ['init', '--quiet', target]);
    execFileSync('git', ['-C', target, 'config', 'user.email', 'interleaf@example.invalid']);
    execFileSync('git', ['-C', target, 'config', 'user.name', 'Interleaf Test']);
    execFileSync('git', ['-C', target, 'add', '.']);
    execFileSync('git', ['-C', target, 'commit', '--quiet', '-m', 'fixture']);
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-workflow', 'Doc Workflow', 'pdf', '/tmp/workflow.pdf', 'managed', 100, 100, 'hash-workflow')
    `).run();
    const service = createTestAgentService({ database: database,
      repository: new AgentRepository(database),
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new FixtureRegistry(),
      contextRoot: join(appRoot, 'context'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
      confirmDirectWorkspace: () => Promise.resolve(true),
      chooseDirectory: () => Promise.resolve(target),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const first = await service.startSession({ documentId: 'doc-workflow', profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'change the fixture' }, 41);
    expect(first.session.executionMode).toBe('isolated-worktree');
    await waitForCompleted(service, first.session.id);
    const firstReview = await service.getEnvironmentReview(first.session.id, 41);
    expect(firstReview?.review.changedFiles.map((file) => file.path)).toContain('interleaf-fixture-change.txt');
    expect(await readFile(join(target, 'interleaf-fixture-change.txt'), 'utf8').catch(() => null)).toBeNull();
    const worktreeListing = execFileSync('git', ['-C', target, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(worktreeListing).toContain(join(appRoot, first.session.id, 'worktree'));
    await service.applyChanges(first.session.id, 41);
    expect(await readFile(join(target, 'interleaf-fixture-change.txt'), 'utf8')).toContain('Deterministic fake agent change');
    await service.discardSandbox(first.session.id, 41);
    expect(execFileSync('git', ['-C', target, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).not.toContain(join(appRoot, first.session.id, 'worktree'));

    await unlink(join(target, 'interleaf-fixture-change.txt'));
    const second = await service.startSession({ documentId: 'doc-workflow', profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'discard the fixture' }, 41);
    expect(second.session.executionMode).toBe('isolated-worktree');
    await waitForCompleted(service, second.session.id);
    expect((await service.getEnvironmentReview(second.session.id, 41))?.review.changedFiles.length).toBeGreaterThan(0);
    await service.discardSandbox(second.session.id, 41);
    expect(execFileSync('git', ['-C', target, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).not.toContain(join(appRoot, second.session.id, 'worktree'));
    await expect(readFile(join(target, 'interleaf-fixture-change.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const draftId = 'workflow-i-draft';
    const grant = await service.issueRiskGrant({ draftId, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'active-env', prompt: 'modify active workspace', model: null, contextPacket: null }, 41);
    const activeSession = await service.startSession({ documentId: 'doc-workflow', profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'active-env', prompt: 'modify active workspace', riskConfirmation: { grantId: grant.grantId, draftId: draftId } }, 41);
    await waitForCompleted(service, activeSession.session.id);
    const activeReview = await service.getEnvironmentReview(activeSession.session.id, 41);
    expect(activeReview?.review.activeWorkspaceModified).toBe(true);
    expect(activeReview?.review.applyAllowed).toBe(false);
    await service.discardSandbox(activeSession.session.id, 41);
    await unlink(join(target, 'interleaf-fixture-change.txt'));
    await service.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it('keeps environment actions behind terminal process reaping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-action-barrier-'));
    const target = join(root, 'project');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), 'fixture project\n');
    const database = InterleafDatabase.open(':memory:');
    runMigrations(database);
    database.raw.prepare(`
      INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-workflow', 'Doc Workflow', 'pdf', '/tmp/workflow.pdf', 'managed', 100, 100, 'hash-workflow')
    `).run();
    const service = createTestAgentService({ database: database,
      repository: new AgentRepository(database), registry: new WorkingDirectoryRegistry(), agentRegistry: new FixtureRegistry({ fakeFixtureBehavior: { sleep: true } }),
      contextRoot: join(appRoot, 'context'), environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
      chooseDirectory: () => Promise.resolve(target), log: logger, isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const started = await service.startSession({ documentId: 'doc-workflow', profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'hold process' }, 73);
    await expect(service.applyChanges(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    await expect(service.exportPatch(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    await expect(service.discardSandbox(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    await service.stopSession(started.session.id, 73);
    await expect(service.applyChanges(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    await expect(service.exportPatch(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    await expect(service.discardSandbox(started.session.id, 73)).rejects.toThrow(/finished and been reaped/i);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        await service.discardSandbox(started.session.id, 73);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(service.getSession(started.session.id)?.environment).toBeNull();
    await service.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
  }, 20_000);
});
