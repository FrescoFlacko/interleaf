import { expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentService, AgentServiceOptions } from '@main/agents/agent-service';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from './agent-service';
import { testAgentRegistryOptions, withEnvironmentShell } from './agent-collaborators';

/** Fixtures shared by the agent resume and owner-liveness specs. */

export const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
export const TEST_DOCUMENT_ID = 'test-doc';

export function setupTestDatabase() {
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES (?, 'Test Doc', 'pdf', '/tmp/test.pdf', 'managed', 100, 100, 'hash-test')
  `).run(TEST_DOCUMENT_ID);
  return db;
}

/**
 * Waits until the session's current generation has persisted a completed
 * terminal row. The run consumer writes that row and retires the active run in
 * one synchronous step, after its asynchronous final review, so this is also
 * the moment environment actions, copy and resume become available. A resumed
 * generation leaves the previous `completed` row in place until it settles, so
 * pass the report the awaited generation writes to tell the two apart.
 */
export async function untilCompleted(service: AgentService, sessionId: string, generation: { readonly finalReport?: string } = {}): Promise<void> {
  await vi.waitFor(() => {
    expect(service.getSession(sessionId)).toMatchObject({ status: 'completed', ...generation });
  });
}

/**
 * Resolves once `action` has reached its injected gate. If the action settles
 * first — an early rejection, say — this fails at once with that outcome
 * instead of leaving the test waiting on a gate that will never be reached.
 */
export function untilGateReached<TResult>(entered: Promise<void>, action: Promise<TResult>): Promise<void> {
  return Promise.race([entered, action.then(() => {
    throw new Error('The gated action settled before reaching its gate.');
  })]);
}

const resumableProfile: MainAgentProfile = {
    id: 'resumable-agent', providerId: 'codex', name: 'Resumable Codex', binaryPath: 'codex', defaultArgs: [],
    defaultModel: 'o3-mini', reasoningEffort: 'high', permissionMode: 'normal', defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', binaryPath: 'codex', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false, unsafe: false,
};

export class ResumableAdapter implements AgentAdapter {
  readonly profile = resumableProfile;
  readonly capabilities = this.profile.capabilities;
  lastStartRequest: Parameters<AgentAdapter['start']>[0] | null = null;
  /** The resume request, recorded with the provider session id it was resumed under. */
  lastResumeRequest: (Parameters<NonNullable<AgentAdapter['resume']>>[1] & { readonly providerSessionId: string }) | null = null;

  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(this.profile.detection); }

  start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun {
    this.lastStartRequest = request;
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        yield {
          sessionId: '',
          ordinal: 0,
          type: 'structured',
          data: { type: 'thread.started', thread_id: 'provider-thread-xyz987' },
          timestamp: new Date().toISOString(),
        } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text: 'initial report with prompt-path /tmp/prompt-secret.txt', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }

  resume(sessionId: string, request: Parameters<NonNullable<AgentAdapter['resume']>>[1]): AgentAdapterRun {
    this.lastResumeRequest = { providerSessionId: sessionId, ...request };
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text: 'resumed report', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }

  cancel(): void { /* no-op */ }
}

export class ReservedResumableAdapter extends ResumableAdapter {
  override readonly profile: MainAgentProfile = { ...resumableProfile, unsafe: true };
  override readonly capabilities = this.profile.capabilities;
  resumeCalls = 0;
  startCalls = 0;
  override start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun {
    this.startCalls += 1;
    return super.start(request);
  }
  override resume(sessionId: string, request: Parameters<NonNullable<AgentAdapter['resume']>>[1]): AgentAdapterRun {
    this.resumeCalls += 1;
    return super.resume(sessionId, request);
  }
}

class TestRegistry extends AgentRegistry {
  constructor(private readonly adapter: ResumableAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([this.adapter.profile]); }
  override getAdapter(id: string): AgentAdapter | undefined {
    return id === 'resumable-agent' || id === 'codex' ? this.adapter : undefined;
  }
}

type StartInput = Parameters<AgentService['startSession']>[0];

/** A service over `adapter` with a selected workspace; `overrides` sees the app-owned workspace root. */
export async function openResumeService<TAdapter extends ResumableAdapter>(
  prefix: string,
  adapter: TAdapter,
  overrides: (appRoot: string) => Partial<AgentServiceOptions> = () => ({}),
) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, 'workspace');
  const appRoot = join(root, 'agent-workspaces');
  await mkdir(target, { recursive: true });
  const db = setupTestDatabase();
  const service = createTestAgentService({ database: db,
    repository: new AgentRepository(db), registry: new WorkingDirectoryRegistry(), agentRegistry: new TestRegistry(adapter),
    contextRoot: join(appRoot, 'context'), environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
    chooseDirectory: () => Promise.resolve(target), log: logger, isPackaged: false,
    ...overrides(appRoot),
  });
  await service.initialize();
  const directory = await service.selectWorkingDirectory();
  if (directory === null) throw new Error('Directory not selected');
  return {
    db,
    service,
    adapter,
    directoryHandle: directory.handle,
    start: (prompt: string, ownerId = 1, extra: Partial<StartInput> = {}) => service.startSession({
      documentId: TEST_DOCUMENT_ID, profileId: 'resumable-agent', workingDirectoryHandle: directory.handle, prompt, ...extra,
    }, ownerId),
    /** Pass `false` when the test already shut the service down. */
    close: async (shutdown = true) => {
      if (shutdown) await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A confirmation that approves at once until `defer` is set, then waits for `release`. */
export function deferrableConfirmation() {
  let defer = false;
  let release!: (approved: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const confirm = vi.fn(() => defer ? gate : Promise.resolve(true));
  return { confirm, release, deferNext: () => { defer = true; } };
}

/**
 * Runs a hook in the microtask queued just after the Nth armed `resolve()`
 * fulfills — behind the awaiting caller's continuation, so the caller's
 * synchronous code after that await (and the turn that returns from it) runs
 * first, while whatever awaits the caller's own promise runs after the hook.
 */
export class GapDirectoryRegistry extends WorkingDirectoryRegistry {
  private remaining = 0;
  private hook: (() => void) | null = null;

  afterResolve(call: number, hook: () => void): void {
    this.remaining = call;
    this.hook = hook;
  }

  override resolve(handle: string): Promise<Awaited<ReturnType<WorkingDirectoryRegistry['resolve']>>> {
    const hook = this.hook;
    if (hook === null || --this.remaining > 0) return super.resolve(handle);
    this.hook = null;
    return new Promise((resolve, reject) => {
      super.resolve(handle).then((directory) => {
        resolve(directory);
        queueMicrotask(hook);
      }, reject);
    });
  }
}
