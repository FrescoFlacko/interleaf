import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TEST_DOCUMENT_ID = 'test-doc';

function setupTestDatabase() {
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES (?, 'Test Doc', 'pdf', '/tmp/test.pdf', 'managed', 100, 100, 'hash-test')
  `).run(TEST_DOCUMENT_ID);
  return db;
}

const handoffProfile: MainAgentProfile = {
  id: 'handoff-agent', providerId: 'codex', name: 'Handoff Codex', binaryPath: 'codex', defaultArgs: [],
  defaultModel: 'o3-mini', reasoningEffort: 'high', permissionMode: 'normal', defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: 'codex', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};

const stamp = (): string => new Date().toISOString();

/**
 * One run that completes immediately, and one that stays live until it is
 * cancelled. The second is how a window is destroyed mid-run.
 */
class HandoffAdapter implements AgentAdapter {
  readonly profile = handoffProfile;
  readonly capabilities = this.profile.capabilities;
  stall = false;
  cancelCalls = 0;
  lastResumeRequest: (Parameters<NonNullable<AgentAdapter['resume']>>[1] & { readonly providerSessionId: string }) | null = null;
  private releaseStall: () => void = () => undefined;
  private announceStarted: () => void = () => undefined;
  started: Promise<void> = Promise.resolve();

  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(this.profile.detection); }

  cancel(): void { this.cancelCalls += 1; this.releaseStall(); }

  start(): AgentAdapterRun {
    if (!this.stall) return this.completedRun('initial report');
    this.started = new Promise<void>((resolve) => { this.announceStarted = resolve; });
    const stalled = new Promise<void>((resolve) => { this.releaseStall = resolve; });
    const announceStarted = this.announceStarted;
    return {
      events: (async function* () {
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: stamp() } as const;
        announceStarted();
        await stalled;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: null, signal: 'SIGKILL', timestamp: stamp() } as const;
      })(),
      completion: stalled,
      cancel: () => { this.cancelCalls += 1; this.releaseStall(); },
    };
  }

  resume(sessionId: string, request: Parameters<NonNullable<AgentAdapter['resume']>>[1]): AgentAdapterRun {
    this.lastResumeRequest = { providerSessionId: sessionId, ...request };
    return this.completedRun('resumed report');
  }

  private completedRun(text: string): AgentAdapterRun {
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: stamp() } as const;
        yield { sessionId: '', ordinal: 0, type: 'structured', data: { type: 'thread.started', thread_id: 'provider-thread-handoff' }, timestamp: stamp() } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text, timestamp: stamp() } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: stamp() } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => { this.cancelCalls += 1; },
    };
  }
}

class TestRegistry extends AgentRegistry {
  constructor(private readonly adapter: HandoffAdapter) { super(testAgentRegistryOptions({ logger })); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([this.adapter.profile]); }
  override getAdapter(id: string): AgentAdapter | undefined {
    return id === 'handoff-agent' || id === 'codex' ? this.adapter : undefined;
  }
}

async function makeFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, 'workspace');
  const appRoot = join(root, 'agent-workspaces');
  await mkdir(target, { recursive: true });
  const db = setupTestDatabase();
  const adapter = new HandoffAdapter();
  const clipboardTexts: string[] = [];
  const service = createTestAgentService({ database: db,
    repository: new AgentRepository(db), registry: new WorkingDirectoryRegistry(), agentRegistry: new TestRegistry(adapter),
    contextRoot: join(appRoot, 'context'), environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
    chooseDirectory: () => Promise.resolve(target), log: logger, isPackaged: false,
    clipboard: { writeText: (text) => { clipboardTexts.push(text); return Promise.resolve(); } },
  });
  await service.initialize();
  // Main's own window factory is what tells the service which webContents is
  // the one main window; nothing a renderer says can stand in for it.
  service.adoptMainWindow(1);
  const directory = await service.selectWorkingDirectory();
  if (directory === null) throw new Error('Directory not selected');
  return {
    root, db, service, adapter, clipboardTexts, directoryHandle: directory.handle,
    async close(): Promise<void> {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

/** What main does on macOS reopen: destroy the old window, then create the
 * replacement through its own factory, which adopts it as the main window. */
async function reopenWindow(fixture: Fixture, deadOwnerId: number, newOwnerId: number): Promise<void> {
  await fixture.service.cancelOwner(deadOwnerId);
  fixture.service.adoptMainWindow(newOwnerId);
}

async function startRun(fixture: Fixture, ownerId: number): Promise<string> {
  const result = await fixture.service.startSession({
    documentId: TEST_DOCUMENT_ID, profileId: 'handoff-agent', workingDirectoryHandle: fixture.directoryHandle,
    executionMode: 'auto-isolated', prompt: 'do the work', model: 'o3-mini',
  }, ownerId);
  return result.session.id;
}

/** Runs `body` against a fresh fixture and always closes it. */
async function withFixture(prefix: string, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await makeFixture(prefix);
  try {
    await body(fixture);
  } finally {
    await fixture.close();
  }
}

async function startCompletedRun(fixture: Fixture, ownerId: number): Promise<string> {
  const sessionId = await startRun(fixture, ownerId);
  await vi.waitFor(() => { expect(fixture.service.getSession(sessionId)?.status).toBe('completed'); });
  return sessionId;
}

describe('Agent session owner handoff after window destruction (item C)', () => {
  it('bars a replacement window until it claims a destroyed owner\'s session, then allows resume, copy and review', async () => {
    await withFixture('interleaf-handoff-claim-', async (fixture) => {
    const sessionId = await startCompletedRun(fixture, 1);

    // A second window may not act on the session merely by naming its ID.
    await expect(fixture.service.copyResult(sessionId, 2)).rejects.toThrow(/not owned/i);
    await expect(fixture.service.getEnvironmentReview(sessionId, 2)).rejects.toThrow(/not owned/i);
    await expect(fixture.service.claimSession(sessionId, 2)).rejects.toThrow(/live window/i);

    // The owning window is destroyed and main creates its replacement.
    await reopenWindow(fixture, 1, 2);

    // Still no implicit adoption; the replacement must claim explicitly.
    await expect(fixture.service.copyResult(sessionId, 2)).rejects.toThrow(/not owned/i);

    expect(await fixture.service.claimSession(sessionId, 2)).toEqual({ claimed: true, ownerChanged: true });
    expect(await fixture.service.copyResult(sessionId, 2)).toEqual({ copied: true, characterCount: 'initial report'.length });
    expect(fixture.clipboardTexts).toEqual(['initial report']);
    expect(await fixture.service.getEnvironmentReview(sessionId, 2)).not.toBeNull();
    const resumed = await fixture.service.resumeSession({ sessionId, prompt: 'keep going' }, 2);
    expect(resumed.session.id).toBe(sessionId);
    await vi.waitFor(() => { expect(fixture.service.getSession(sessionId)?.finalReport).toBe('resumed report'); });

    // The old owner is gone for good; its ID cannot act on the session again.
    await expect(fixture.service.copyResult(sessionId, 1)).rejects.toThrow(/not owned/i);
    });
  });

  it('never lets a live owner\'s session be stolen, and cancels a destroyed owner\'s live run before any claim', async () => {
    await withFixture('interleaf-handoff-live-', async (fixture) => {
    fixture.adapter.stall = true;
    const sessionId = await startRun(fixture, 1);
    await fixture.adapter.started;
    expect(fixture.service.getSession(sessionId)?.status).toBe('running');

    await expect(fixture.service.claimSession(sessionId, 2)).rejects.toThrow(/live window/i);
    await expect(fixture.service.stopSession(sessionId, 2)).rejects.toThrow(/not owned/i);
    expect(fixture.adapter.cancelCalls).toBe(0);

    await reopenWindow(fixture, 1, 2);
    expect(fixture.adapter.cancelCalls).toBeGreaterThan(0);

    // The claim only succeeds because cancellation and the consumer drain
    // finished first: the replacement never observes a live run.
    expect(await fixture.service.claimSession(sessionId, 2)).toEqual({ claimed: true, ownerChanged: true });
    expect(fixture.service.getSession(sessionId)?.status).toBe('cancelled');
    });
  });

  it('rejects claims for unknown sessions and treats a re-claim by the same owner as a no-op', async () => {
    await withFixture('interleaf-handoff-unknown-', async (fixture) => {
    fixture.service.adoptMainWindow(2);
    await expect(fixture.service.claimSession('missing-session', 2)).rejects.toThrow(/no longer exists/i);
    fixture.service.adoptMainWindow(1);
    const sessionId = await startCompletedRun(fixture, 1);
    expect(await fixture.service.claimSession(sessionId, 1)).toEqual({ claimed: true, ownerChanged: false });
    expect(await fixture.service.copyResult(sessionId, 1)).toEqual({ copied: true, characterCount: 'initial report'.length });
    });
  });

  it('refuses an unrelated live window that only knows the session ID after the owner dies', async () => {
    // The authority to take over a session is minted by main for the window
    // main itself created. A second live `webContents` in the same process —
    // knowing the ID, calling the same IPC — is not that window and never
    // becomes the successor by asking.
    await withFixture('interleaf-handoff-unrelated-', async (fixture) => {
    const sessionId = await startCompletedRun(fixture, 1);
    await reopenWindow(fixture, 1, 2);

    await expect(fixture.service.claimSession(sessionId, 3)).rejects.toThrow(/not authorized/i);
    await expect(fixture.service.copyResult(sessionId, 3)).rejects.toThrow(/not owned/i);
    expect(fixture.clipboardTexts).toEqual([]);

    // The window main actually created still takes it over.
    expect(await fixture.service.claimSession(sessionId, 2)).toEqual({ claimed: true, ownerChanged: true });
    await expect(fixture.service.claimSession(sessionId, 3)).rejects.toThrow(/live window/i);
    });
  });

  it('authorizes a session persisted by an earlier app run only through main\'s recovery binding', async () => {
    await withFixture('interleaf-handoff-restart-', async (fixture) => {
    const sessionId = await startCompletedRun(fixture, 1);
    await fixture.service.shutdown();

    // A new process: nothing in memory owns the persisted session.
    const restarted = createTestAgentService({
      database: fixture.db,
      repository: new AgentRepository(fixture.db), registry: new WorkingDirectoryRegistry(),
      agentRegistry: new TestRegistry(fixture.adapter), contextRoot: join(fixture.root, 'context-2'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(fixture.root, 'agent-workspaces') })),
      chooseDirectory: () => Promise.resolve(join(fixture.root, 'workspace')), log: logger,
      isPackaged: false,
      clipboard: { writeText: (text) => { fixture.clipboardTexts.push(text); return Promise.resolve(); } },
    });
    await restarted.initialize();
    try {
      // No window has been adopted yet: an arbitrary renderer cannot adopt
      // the recovered session by naming it.
      await expect(restarted.claimSession(sessionId, 7)).rejects.toThrow(/not authorized/i);

      restarted.adoptMainWindow(7);
      expect(await restarted.claimSession(sessionId, 7)).toEqual({ claimed: true, ownerChanged: true });
      // Recovery bound the session to that window alone.
      await expect(restarted.claimSession(sessionId, 8)).rejects.toThrow(/live window/i);
    } finally {
      await restarted.shutdown();
    }
    });
  });

  it('invalidates a claim whose claimant window is destroyed mid-drain, and lets the next window claim', async () => {
    await withFixture('interleaf-handoff-claimant-dies-', async (fixture) => {
    fixture.adapter.stall = true;
    const sessionId = await startRun(fixture, 1);
    await fixture.adapter.started;

    // Owner 1 dies; main creates window 2, which starts claiming while
    // owner 1's cancellation and consumer drain are still running.
    const dying = fixture.service.cancelOwner(1);
    fixture.service.adoptMainWindow(2);
    const claim = fixture.service.claimSession(sessionId, 2);
    // Window 2 is itself destroyed before the drain completes.
    const secondDeath = fixture.service.cancelOwner(2);

    await expect(claim).rejects.toThrow(/cancelled|not authorized|no longer/i);
    await dying;
    await secondDeath;

    // The dead claimant must not have been installed as the owner.
    await expect(fixture.service.copyResult(sessionId, 2)).rejects.toThrow(/not owned/i);
    await expect(fixture.service.claimSession(sessionId, 2)).rejects.toThrow(/not authorized/i);

    // A subsequent real replacement window still works.
    fixture.service.adoptMainWindow(3);
    expect(await fixture.service.claimSession(sessionId, 3)).toEqual({ claimed: true, ownerChanged: true });
    expect(fixture.service.getSession(sessionId)?.status).toBe('cancelled');
    });
  });

  it('settles concurrent claims from the authorized window on one owner', async () => {
    await withFixture('interleaf-handoff-concurrent-', async (fixture) => {
    const sessionId = await startCompletedRun(fixture, 1);
    await reopenWindow(fixture, 1, 2);

    const [first, second] = await Promise.all([
      fixture.service.claimSession(sessionId, 2),
      fixture.service.claimSession(sessionId, 2),
    ]);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
    // Exactly one of them performed the transfer.
    expect([first.ownerChanged, second.ownerChanged].filter(Boolean)).toHaveLength(1);
    expect(await fixture.service.copyResult(sessionId, 2)).toEqual({ copied: true, characterCount: 'initial report'.length });
    });
  });

  it('does not write the clipboard for a copy whose owner is destroyed while it reads the report', async () => {
    await withFixture('interleaf-handoff-copy-invalidated-', async (fixture) => {
    const sessionId = await startCompletedRun(fixture, 1);

    // The copy has passed its synchronous checks and is suspended reading
    // the report when its window is destroyed.
    const copying = fixture.service.copyResult(sessionId, 1);
    const destroyed = fixture.service.cancelOwner(1);

    await expect(copying).rejects.toThrow(/not owned/i);
    await destroyed;
    expect(fixture.clipboardTexts).toEqual([]);
    });
  });
});
