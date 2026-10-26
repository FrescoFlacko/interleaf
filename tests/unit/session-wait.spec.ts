import { describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { AgentRepository } from '../../src/main/db/repositories/agent-repository';
import { WorkingDirectoryRegistry } from '../../src/main/agents/working-directory-registry';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '../../src/main/agents/agent-adapter';
import type { MainAgentProfile } from '../../src/main/agents/profile-types';
import type { Logger } from '../../src/main/logging/logger';
import type { AgentService } from '../../src/main/agents/agent-service';
import { createTestAgentService } from '../helpers/agent-service';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { cleanupServiceFixture, observeBoundedSettlement, teardownDelayedIntegrityTest, waitForAuthoritativeSession, waitForSessionStatus, waitForTerminal } from '../helpers/session-wait';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const testProfile: MainAgentProfile = {
  id: 'fake',
  providerId: 'fake',
  name: 'Fake Agent',
  binaryPath: '/fake/bin',
  defaultArgs: [],
  defaultModel: null,
  configuredModels: [],
  reasoningEffort: null,
  permissionMode: 'normal',
  defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true,
    sessionResume: true,
    nativeSandbox: false,
    workingDirectory: true,
    modelSelection: false,
    reasoningSelection: false,
    fileChangeEvents: false,
    toolEvents: false,
    subagents: false,
    interactiveAuthentication: false,
    nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: '/fake/bin', version: '1.0.0', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false,
  unsafe: false,
};

class MockAdapter implements AgentAdapter {
  readonly profile = testProfile;
  readonly capabilities = testProfile.capabilities;
  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(testProfile.detection); }
  cancel(): void { /* no-op */ }
  start(): AgentAdapterRun {
    throw new Error('start not implemented');
  }
}

async function openControlledService(adapter: AgentAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-session-wait-'));
  const db = InterleafDatabase.open(':memory:');
  try {
    runMigrations(db);
    db.raw.prepare(`
      INSERT OR IGNORE INTO documents
        (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
      VALUES ('doc-wait', 'Test document', 'pdf', '/tmp/doc-wait.pdf', 'managed', 1, 1, 'hash-doc-wait')
    `).run();
    const repository = new AgentRepository(db);

    class MockRegistry extends AgentRegistry {
      constructor() { super(testAgentRegistryOptions()); }
      override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
      override addFakeAdapter(): MainAgentProfile { return testProfile; }
      override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
    }

    const service = createTestAgentService({
      database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new MockRegistry(),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      log: silentLogger,
      isPackaged: false,
    });

    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('Directory selection failed');

    const cleanup = async (onTeardown?: () => Promise<void> | void) => {
      await cleanupServiceFixture({ service, db, root }, onTeardown);
    };

    return { root, db, repository, service, directory, cleanup };
  } catch (setupError) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw setupError;
  }
}

/** Releases what a preserving teardown left behind; nothing remains when a broken guard already released it. */
async function releasePreserved(fixture: { readonly service: AgentService; readonly db: InterleafDatabase; readonly root: string }): Promise<void> {
  if (!existsSync(fixture.root)) return;
  await fixture.service.shutdown();
  fixture.db.close();
  await rm(fixture.root, { recursive: true, force: true });
}

describe('Session wait synchronization and lifecycle cleanup', () => {
  it('awaits a delayed session completing beyond the old 500ms budget', async () => {
    const { promise: delayedPromise, resolve: resolveDelayed } = Promise.withResolvers<undefined>();
    const delayedAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'final', text: 'delayed report', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
          })(),
          completion: (async () => { await delayedPromise; })(),
          cancel: () => { resolveDelayed(undefined); },
        };
      }
    }();

    const fixture = await openControlledService(delayedAdapter);
    try {
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'delayed completion test',
      }, 101);

      // Release completion after 650ms (well past the old 500ms limit)
      const timer = setTimeout(() => { resolveDelayed(undefined); }, 650);
      try {
        await waitForSessionStatus(fixture.service, started.session.id, 'completed', 100, { timeoutMs: 3_000 });
        const detail = fixture.service.getSession(started.session.id);
        expect(detail?.status).toBe('completed');
        expect(detail?.finalReport).toBe('delayed report');
      } finally {
        clearTimeout(timer);
        resolveDelayed(undefined);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 10_000);

  it('awaits a terminal session completing beyond the old 1000ms budget', async () => {
    const { promise: delayedPromise, resolve: resolveDelayed } = Promise.withResolvers<undefined>();
    const delayedAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'final', text: 'terminal report', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
          })(),
          completion: (async () => { await delayedPromise; })(),
          cancel: () => { resolveDelayed(undefined); },
        };
      }
    }();

    const fixture = await openControlledService(delayedAdapter);
    try {
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'terminal wait test',
      }, 102);

      // Release completion after 1100ms (past the old 1000ms limit)
      const timer = setTimeout(() => { resolveDelayed(undefined); }, 1100);
      try {
        const result = await waitForTerminal(fixture.service, started.session.id, 100, { timeoutMs: 4_000 });
        expect(result.status).toBe('completed');
        expect(result.finalReport).toBe('terminal report');
      } finally {
        clearTimeout(timer);
        resolveDelayed(undefined);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 10_000);

  it('explicitly rejects unexpected terminal failure immediately instead of waiting for timeout', async () => {
    const failingAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 2, signal: null, timestamp: new Date().toISOString() } as const;
          })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      }
    }();

    const fixture = await openControlledService(failingAdapter);
    try {
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'failing session test',
      }, 103);

      await expect(waitForSessionStatus(fixture.service, started.session.id, 'completed', 100, { timeoutMs: 3_000 }))
        .rejects.toThrow(/reached unexpected terminal status "failed"/);
    } finally {
      await fixture.cleanup();
    }
  }, 5_000);

  it('rejects with timeout diagnostics when a session is stuck', async () => {
    const { promise: hangPromise, resolve: releaseHang } = Promise.withResolvers<undefined>();
    const hangingAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            await hangPromise;
          })(),
          completion: (async () => { await hangPromise; })(),
          cancel: () => { releaseHang(undefined); },
        };
      }
    }();

    const fixture = await openControlledService(hangingAdapter);
    try {
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'stuck session test',
      }, 104);

      await expect(waitForSessionStatus(fixture.service, started.session.id, 'completed', 100, { timeoutMs: 60 }))
        .rejects.toThrow(/timed out waiting for "completed" after 60ms.*status: "running"/);
    } finally {
      releaseHang(undefined);
      await fixture.cleanup();
    }
  }, 5_000);

  it('deterministically ignores previous completed generation during resume when baselineEventCount is set', async () => {
    let turn = 0;
    const { promise: turn1Gate, resolve: releaseTurn1 } = Promise.withResolvers<undefined>();
    const resumableAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            turn = 1;
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'final', text: 'turn 1 complete', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
          })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      }
      resume(): AgentAdapterRun {
        return {
          events: (async function* () {
            turn = 2;
            await turn1Gate;
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'final', text: 'turn 2 complete', timestamp: new Date().toISOString() } as const;
            yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
          })(),
          completion: (async () => { await turn1Gate; })(),
          cancel: () => { releaseTurn1(undefined); },
        };
      }
    }();

    const fixture = await openControlledService(resumableAdapter);
    try {
      // Turn 1 runs to completion
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'initial turn',
      }, 105);
      await waitForSessionStatus(fixture.service, started.session.id, 'completed');
      const turn1Detail = fixture.service.getSession(started.session.id);
      expect(turn1Detail?.status).toBe('completed');
      const turn1EventCount = turn1Detail?.eventCount ?? 0;
      expect(turn1EventCount).toBeGreaterThan(0);

      // 1. Force the stale completed row to be sampled by waiter BEFORE resume is launched.
      // If the baselineEventCount guard is disabled, this immediately returns completed and fails rejects.toThrow.
      await expect(
        waitForAuthoritativeSession(fixture.service, started.session.id, {
          timeoutMs: 50,
          expectedStatus: 'completed',
          baselineEventCount: turn1EventCount,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(/timed out waiting for "completed"/);

      // 2. Start waiter concurrently with the stale completed row still in SQLite,
      // then launch resumeSession and release Turn 2.
      const turn2Promise = waitForAuthoritativeSession(fixture.service, started.session.id, {
        timeoutMs: 4_000,
        expectedStatus: 'completed',
        baselineEventCount: turn1EventCount,
        pollIntervalMs: 5,
      });

      const resumePromise = fixture.service.resumeSession({
        sessionId: started.session.id,
        prompt: 'second turn',
      }, 105);

      releaseTurn1(undefined);
      await resumePromise;
      const turn2Detail = await turn2Promise;

      expect(turn).toBe(2);
      expect(turn2Detail.status).toBe('completed');
      expect(turn2Detail.eventCount).toBeGreaterThan(turn1EventCount);
      expect(turn2Detail.finalReport).toBe('turn 2 complete');
    } finally {
      releaseTurn1(undefined);
      await fixture.cleanup();
    }
  }, 10_000);

  it('orders cancellation and drain-before-close on wait rejection with active controlled work', async () => {
    let cancelCalls = 0;
    const { promise: activeGate, resolve: releaseActive } = Promise.withResolvers<undefined>();
    const activeAdapter = new class extends MockAdapter {
      override start(): AgentAdapterRun {
        return {
          events: (async function* () {
            await Promise.resolve();
            yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
            await activeGate;
          })(),
          completion: (async () => { await activeGate; })(),
          cancel: () => {
            cancelCalls += 1;
            releaseActive(undefined);
          },
        };
      }
    }();

    const fixture = await openControlledService(activeAdapter);
    try {
      const started = await fixture.service.startSession({
        documentId: 'doc-wait',
        profileId: 'fake',
        workingDirectoryHandle: fixture.directory.handle,
        prompt: 'active work test',
      }, 106);

      // Verify work is actively registered before timeout
      expect(fixture.service.liveWork()).toBeGreaterThan(0);

      // Explicit rejection assertion: MUST reject, and if wait unexpectedly succeeds, fail the test
      await expect(
        waitForSessionStatus(fixture.service, started.session.id, 'completed', 100, { timeoutMs: 50 }),
      ).rejects.toThrow(/timed out waiting for "completed"/);
    } finally {
      // Exercise the same lifecycle cleanup helper as affected cases
      await fixture.cleanup(() => {
        releaseActive(undefined);
      });
    }

    expect(cancelCalls).toBeGreaterThan(0);
    expect(fixture.service.liveWork()).toBe(0);
  }, 10_000);

  it('preserves database and root directory when cleanupServiceFixture is called with undrained live work', async () => {
    const fixture = await openControlledService(new MockAdapter());
    try {
      // Simulate unproven drain after shutdown by stubbing liveWork to return 1
      vi.spyOn(fixture.service, 'liveWork').mockReturnValue(1);

      // Cleanup MUST fail and surface the live work drain error
      await expect(cleanupServiceFixture(fixture))
        .rejects.toThrow(/Cannot tear down fixture: service still has 1 live work items/);

      // Root and database MUST survive while work may still be running
      expect(existsSync(fixture.root)).toBe(true);
      expect(fixture.db.raw.prepare('SELECT 1').get()).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      await releasePreserved(fixture);
    }
  }, 10_000);

  it('clears timer on settlement and surfaces timeout as failure while preserving resources', async () => {
    // 1. Immediate settlement clears its timer without throwing
    await expect(observeBoundedSettlement(Promise.resolve('done'), 1_000)).resolves.toBeUndefined();

    // 2. Unresolved operation rejects with timeout error (does NOT resolve as success)
    const { promise: hungPromise, resolve: releaseHung } = Promise.withResolvers<undefined>();
    await expect(observeBoundedSettlement(hungPromise, 50)).rejects.toThrow(
      /Timed out waiting for operation to settle after 50ms/,
    );
    releaseHung(undefined);

    // 3. teardownDelayedIntegrityTest rejects and preserves resources when operation times out
    const failureFixture = await openControlledService(new MockAdapter());
    const { promise: unresolvingOp, resolve: releaseUnresolving } = Promise.withResolvers<undefined>();
    try {
      // Must reject with timeout error, not pretend teardown succeeded
      await expect(
        teardownDelayedIntegrityTest({
          shutdownPromise: failureFixture.service.shutdown(),
          pendingResume: unresolvingOp,
          service: failureFixture.service,
          db: failureFixture.db,
          dbClosed: false,
          root: failureFixture.root,
        }),
      ).rejects.toThrow(/Timed out waiting for operation to settle/);

      // Resources MUST be preserved when drain is not proven
      expect(existsSync(failureFixture.root)).toBe(true);
      expect(failureFixture.db.raw.prepare('SELECT 1').get()).toBeDefined();
    } finally {
      releaseUnresolving(undefined);
      await releasePreserved(failureFixture);
    }

    // 4. teardownDelayedIntegrityTest cleans up resources when drain is proven
    const successFixture = await openControlledService(new MockAdapter());
    await teardownDelayedIntegrityTest({
      shutdownPromise: successFixture.service.shutdown(),
      pendingResume: Promise.resolve(undefined),
      service: successFixture.service,
      db: successFixture.db,
      dbClosed: false,
      root: successFixture.root,
    });
    // Resources MUST be cleaned up on success
    expect(existsSync(successFixture.root)).toBe(false);
    expect(() => successFixture.db.raw.prepare('SELECT 1').get()).toThrow();
  }, 10_000);
});
