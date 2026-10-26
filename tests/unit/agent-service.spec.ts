import { InterleafError } from '@shared/errors/interleaf-error';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService, type AgentServiceOptions } from '@main/agents/agent-service';
import { fitAgentContextPacketToByteBudget } from '@shared/agent-context';
import { AgentRegistry, mapProcessEvents, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { ProcessRunner, type ProcessSpawner } from '@main/agents/process-runner';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { ExecutableRegistry } from '@main/agents/executable-registry';
import { RiskConfirmationGrantStore } from '@main/agents/risk-confirmation-grants';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { Logger } from '@main/logging/logger';
import type { AgentContextPacket, AgentEvent, AgentStartResult } from '@shared/types/agent';
import { AGENT_MAX_CONTEXT_PACKET_BYTES, agentContextPacketSchema } from '@shared/schemas/agent';
import { BlockingNativeSandboxProber, StubNativeSandboxProber } from '../helpers/native-sandbox-prober';
import { TestChildProcess } from '../helpers/child-process';
import { isPortableRecord, type PortableMember } from '@shared/models/portable';
import { createTestAgentService } from '../helpers/agent-service';
import { posixShell, testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';
import { eventError } from '../helpers/agent-event';
import { teardownDelayedIntegrityTest, waitForSessionStatus } from '../helpers/session-wait';

const TEST_DOCUMENT_ID = 'test-doc';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const processFixture = join(process.cwd(), 'tests', 'fixtures', 'fake-agent-cli.mjs');
const QUOTED_SECRET = 'quoted provider secret with spaces';
const BEARER_SECRET = 'bearer-service-secret-123456789';
const SPLIT_SERVICE_PREFIX = 'split-service-prefix-7f3a';
const SPLIT_SERVICE_SUFFIX = 'split-service-suffix-91b2';
const MULTILINE_SERVICE_PREFIX = 'multiline-service-prefix-4a2b';
const MULTILINE_SERVICE_SUFFIX = 'multiline-service-suffix-8c1d';
const TEST_CONTEXT_PACKET: AgentContextPacket = {
  version: 1,
  document: { id: 'shutdown-context-doc', hash: 'hash', title: 'Context test', author: null },
  selection: {
    exactQuote: 'selected text',
    anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'selected text', prefix: '', suffix: '' } },
    location: { format: 'pdf', pageIndex: 0 },
    surroundingText: null,
  },
  provenance: { source: 'interleaf-reader-selection', capturedAt: new Date().toISOString(), contentIsUntrustedReference: true, truncated: false },
};
const applyDatabaseMigrations = runMigrations;

/**
 * Waits for a session to reach a terminal status. Workspace scanning happens on
 * a bounded worker thread, so settling is not guaranteed within a fixed tick.
 */
async function waitForTerminalSession(
  service: AgentService,
  sessionId: string,
  timeoutMs = 5_000,
): Promise<ReturnType<AgentService['getSession']>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = service.getSession(sessionId);
    if (detail !== null && detail.status !== 'running') return detail;
    if (Date.now() > deadline) return detail;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

function insertTestDocument(
  db: ReturnType<typeof InterleafDatabase.open>,
  documentId: string,
): void {
  db.raw.prepare(`
    INSERT OR IGNORE INTO documents
      (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES (?, 'Test document', 'pdf', ?, 'managed', 1, 1, ?)
  `).run(documentId, `/tmp/${documentId}.pdf`, `hash-${documentId}`);
}

function runTestMigrations(db: ReturnType<typeof InterleafDatabase.open>): void {
  applyDatabaseMigrations(db);
  insertTestDocument(db, TEST_DOCUMENT_ID);
  insertTestDocument(db, TEST_CONTEXT_PACKET.document.id);
}
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
  shouldThrow = false;
  throwError?: Error;
  startCalls = 0;
  lastStartRequest: Parameters<AgentAdapter['start']>[0] | null = null;
  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(profile.detection); }
  start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun {
    this.lastStartRequest = request;
    this.startCalls += 1;
    if (this.shouldThrow) throw (this.throwError ?? new Error('fixture start failure'));
    return { events: (async function* () {
      await Promise.resolve();
      yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'final', text: 'done', timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
    })(), completion: Promise.resolve(), cancel: () => undefined };
  }
  cancel(): void { /* Each test run owns its cancellation. */ }
}

class ErrorThenSuccessfulExitAdapter extends ControlledAdapter {
  override start(): AgentAdapterRun {
    const timestamp = new Date().toISOString();
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp } as const;
        yield {
          sessionId: '', ordinal: 0, type: 'error', text: 'bounded process diagnostic',
          error: { __interleafError: true, code: 'internal', message: 'bounded process diagnostic' }, timestamp,
        } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }
}

const dangerousProfile: MainAgentProfile = { ...profile, unsafe: true, permissionMode: 'unsafe-yolo' };

class DangerousAdapter implements AgentAdapter {
  readonly profile = dangerousProfile;
  readonly capabilities = dangerousProfile.capabilities;
  private readonly delegate = new ControlledAdapter();
  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(dangerousProfile.detection); }
  start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun { return this.delegate.start(request); }
  cancel(): void { this.delegate.cancel(); }
}

class DangerousRegistry extends AgentRegistry {
  constructor(private readonly adapter: DangerousAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
  override addFakeAdapter(): MainAgentProfile { return dangerousProfile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

class SecretEventAdapter extends ControlledAdapter {
  override start(): AgentAdapterRun {
    const secret = 'service-secret-9a7b6c5d';
    return { events: (async function* () {
      await Promise.resolve();
      yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `password="${QUOTED_SECRET}" authorization: Bearer ${BEARER_SECRET}\npassword="${SPLIT_SERVICE_PREFIX}`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `${SPLIT_SERVICE_SUFFIX}"`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `{"api_key":"${secret}","token":"${secret}"}\n{'password':'${secret}'}\n`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `password="${MULTILINE_SERVICE_PREFIX}\n`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `${MULTILINE_SERVICE_SUFFIX}"\n`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'structured', data: { token: secret, nested: { password: QUOTED_SECRET, authorization: `Bearer ${BEARER_SECRET}` } }, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'tests', data: { status: 'passed', message: `api_key=${secret}` }, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'final', text: `secret=${secret}`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
    })(), completion: Promise.resolve(), cancel: () => undefined };
  }
}


const pathProfile: MainAgentProfile = { ...profile, binaryPath: processFixture };

class PathEventAdapter extends ControlledAdapter {
  override readonly profile = pathProfile;
  override readonly capabilities = pathProfile.capabilities;
  private targetPath: string;
  constructor(targetPath: string) { super(); this.targetPath = targetPath; }
  setTargetPath(targetPath: string): void { this.targetPath = targetPath; }
  override start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun {
    const cwd = request.canonicalWorkingDirectory;
    const executable = processFixture;
    const home = process.env.HOME ?? '';
    const temp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '';
    const pathValue = process.env.PATH ?? '';
    const target = this.targetPath;
    return { events: (async function* () {
      await Promise.resolve();
      yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `cwd=${cwd.slice(0, Math.max(1, Math.floor(cwd.length / 2)))}`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: `${cwd.slice(Math.max(1, Math.floor(cwd.length / 2)))} target=${target} file=${executable} home=${home} temp=${temp} path=${pathValue}\n`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'structured', data: { cwd, target, executable, home, temp, path: pathValue }, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'error', error: { __interleafError: true, code: 'internal', message: `error cwd=${cwd} target=${target} file=${executable} temp=${temp}` }, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'tests', data: { status: 'passed', message: `tested cwd=${cwd}` }, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'final', text: `final cwd=${cwd} target=${target} file=${executable} home=${home} temp=${temp} path=${pathValue}`, timestamp: new Date().toISOString() } as const;
      yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
    })(), completion: Promise.resolve(), cancel: () => undefined };
  }
}

class ControlledRegistry extends AgentRegistry {
  constructor(private readonly adapter: ControlledAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
  /** The adapter's own profile, so a fixture that supports resume is seen to. */
  override addFakeAdapter(): MainAgentProfile { return this.adapter.profile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

class PathRegistry extends AgentRegistry {
  constructor(private readonly adapter: PathEventAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
  override addFakeAdapter(): MainAgentProfile { return pathProfile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

class ProcessRegistry extends AgentRegistry {
  constructor(private readonly adapter: AgentAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
  override addFakeAdapter(): MainAgentProfile { return profile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

const identityRaceProfile: MainAgentProfile = {
  ...profile,
  defaultArgs: ['exec', '--json', '--sandbox', 'workspace-write'],
  permissionMode: 'direct',
  unsafe: true,
  capabilities: { ...profile.capabilities, nativeSandbox: true, sessionResume: true },
};

class IdentityRaceAdapter implements AgentAdapter {
  readonly profile = identityRaceProfile;
  readonly capabilities = identityRaceProfile.capabilities;
  startCalls = 0;
  resumeCalls = 0;

  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(this.profile.detection); }

  start(): AgentAdapterRun {
    this.startCalls += 1;
    return this.run('initial completed');
  }

  resume(): AgentAdapterRun {
    this.resumeCalls += 1;
    return this.run('resume completed');
  }

  cancel(): void { /* Each test run owns its cancellation. */ }

  private run(finalText: string): AgentAdapterRun {
    return {
      events: (async function* () {
        await Promise.resolve();
        const timestamp = new Date().toISOString();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text: finalText, timestamp } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }
}

class IdentityRaceRegistry extends AgentRegistry {
  constructor(private readonly adapter: IdentityRaceAdapter) { super(testAgentRegistryOptions()); }
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([this.adapter.profile]); }
  override addFakeAdapter(): MainAgentProfile { return this.adapter.profile; }
  override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? this.adapter : undefined; }
}

class SlowProcessAdapter implements AgentAdapter {
  readonly profile = profile;
  readonly capabilities = profile.capabilities;
  private readonly runner = new ProcessRunner();
  completion: Promise<void> | null = null;

  detect(): Promise<MainAgentProfile['detection']> { return Promise.resolve(profile.detection); }

  start(request: Parameters<AgentAdapter['start']>[0]): AgentAdapterRun {
    const handle = this.runner.run({
      file: process.execPath,
      args: [processFixture, '--sleep', '--ignore-termination'],
      cwd: request.canonicalWorkingDirectory,
      stdin: request.prompt,
      timeoutMs: 10_000,
    });
    this.completion = handle.completion;
    return {
      events: (async function* () {
        for await (const event of handle.events) {
          const base = { sessionId: '', ordinal: 0, timestamp: event.timestamp };
          if (event.type === 'started') yield { ...base, type: 'started' } as const;
          else if (event.type === 'stdout') yield { ...base, type: 'stdout', stream: 'stdout', text: event.text } as const;
          else if (event.type === 'stderr') yield { ...base, type: 'stderr', stream: 'stderr', text: event.text } as const;
          else if (event.type === 'ended') yield { ...base, type: 'ended', exitCode: event.exitCode, signal: event.signal } as const;
          else if (event.type === 'cancelled') yield { ...base, type: 'cancelled' } as const;
        }
      })(),
      completion: handle.completion,
      cancel: handle.cancel,
    };
  }

  cancel(): void { /* Each run owns its cancellation handle. */ }
}

type LifecycleCase = 'delayed-completion' | 'nonzero-ended' | 'missing-ended' | 'iterator-throws' | 'iterator-throws-delayed-completion';

class LifecycleAdapter extends ControlledAdapter {
  private releaseCompletion: () => void = () => undefined;
  private readonly delayedCompletion: Promise<void>;
  cancelCalls = 0;

  constructor(private readonly lifecycleCase: LifecycleCase) {
    super();
    this.delayedCompletion = new Promise<void>((resolve) => { this.releaseCompletion = resolve; });
  }

  override start(): AgentAdapterRun {
    const lifecycleCase = this.lifecycleCase;
    const completion = lifecycleCase === 'delayed-completion' || lifecycleCase === 'iterator-throws-delayed-completion' ? this.delayedCompletion : Promise.resolve();
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        if (lifecycleCase === 'iterator-throws' || lifecycleCase === 'iterator-throws-delayed-completion') {
          yield { sessionId: '', ordinal: 0, type: 'stdout', stream: 'stdout', text: 'output before iterator failure', timestamp: new Date().toISOString() } as const;
          throw new Error('fixture iterator failure');
        }
        if (lifecycleCase === 'missing-ended') return;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: lifecycleCase === 'nonzero-ended' ? 7 : 0, signal: null, timestamp: new Date().toISOString() } as const;
      })(),
      completion,
      cancel: () => { this.cancelCalls += 1; this.releaseCompletion(); },
    };
  }

  release(): void { this.releaseCompletion(); }
}

class DeferredTestAdapter extends ControlledAdapter {
  override start(): AgentAdapterRun {
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'tests', data: { status: 'passed', message: 'deferred test result' }, timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text: 'deferred final', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }
}

/** Reports far more test results than the bounded inventory admits (item I). */
class TestFloodAdapter extends ControlledAdapter {
  override readonly profile: MainAgentProfile = { ...profile, capabilities: { ...profile.capabilities, sessionResume: true } };
  override readonly capabilities = this.profile.capabilities;

  constructor(private readonly frames: number) { super(); }

  /** A resumed run floods exactly like the first one, which is how the
   * per-run admission window is observed (item I). */
  resume(): AgentAdapterRun { return this.start(); }

  override start(): AgentAdapterRun {
    const frames = this.frames;
    return {
      events: (async function* () {
        await Promise.resolve();
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        for (let index = 0; index < frames; index += 1) {
          yield { sessionId: '', ordinal: 0, type: 'tests', data: { status: 'passed', message: `flood ${String(index)}` }, timestamp: new Date().toISOString() } as const;
        }
        yield { sessionId: '', ordinal: 0, type: 'final', text: 'flood final', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } as const;
      })(),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }
}

async function waitForDiscard(service: AgentService, sessionId: string, ownerId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await service.discardSandbox(sessionId, ownerId);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Session ${sessionId} did not become discardable.`);
}

/** A service over a fresh database and temp root with a selected directory;
 * `close` drains the service before the database goes away. */
async function openFixtureService(overrides: Partial<AgentServiceOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-service-'));
  const db = InterleafDatabase.open(':memory:');
  runTestMigrations(db);
  const repository = new AgentRepository(db);
  const service = createTestAgentService({ database: db,
    repository, registry: new WorkingDirectoryRegistry(), contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(root), log: logger, isPackaged: false, ...overrides,
  });
  await service.initialize();
  const directory = await service.selectWorkingDirectory();
  if (directory === null) throw new Error('directory was not selected');
  const close = async (): Promise<void> => {
    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, db, repository, service, directory, close };
}

function nearLimitPacket(kind: 'direct-selection' | 'section' | 'page-range'): AgentContextPacket {
  const exactQuote = 'Z'.repeat(256_000);
  const isPdf = kind === 'page-range';
  const location = isPdf
    ? { format: 'pdf' as const, pageIndex: 4, pageLabel: 'Page 5' }
    : { format: 'markdown' as const, blockIndex: 4, lineIndex: 12, headingId: 'near-limit' };
  const anchor: AgentContextPacket['selection']['anchor'] = isPdf
    ? { format: 'pdf', pageIndex: 4, pageLabel: 'Page 5', quote: { exact: exactQuote, prefix: '', suffix: '' } }
    : { format: 'markdown', blockIndex: 4, lineIndex: 12, headingId: 'near-limit', quote: { exact: exactQuote, prefix: kind === 'direct-selection' ? 'prefix' : '', suffix: kind === 'direct-selection' ? 'suffix' : '' } };
  const packet: AgentContextPacket = {
    version: 1,
    ...(kind === 'section' ? { scopeLabel: 'Blocks 5–9' } : {}),
    document: { id: `near-limit-${kind}`, hash: `near-limit-${kind}-hash`, title: `Near limit ${kind}`, author: null },
    selection: { exactQuote, anchor, location, surroundingText: kind === 'direct-selection' ? 'prefix … suffix' : null },
    provenance: {
      source: 'interleaf-reader-selection',
      capturedAt: new Date().toISOString(),
      contentIsUntrustedReference: true,
      truncated: false,
    },
  };
  return fitAgentContextPacketToByteBudget(packet, false);
}

async function startAndReadContextPacket(packet: AgentContextPacket, ownerId: number): Promise<AgentContextPacket> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-context-boundary-'));
  const db = InterleafDatabase.open(':memory:');
  runTestMigrations(db);
  const service = createTestAgentService({ database: db,
    repository: new AgentRepository(db),
    registry: new WorkingDirectoryRegistry(),
    agentRegistry: new ControlledRegistry(new ControlledAdapter()),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(root),
    log: logger,
    isPackaged: false,
    isGitRepository: () => Promise.resolve(false),
  });
  try {
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    insertTestDocument(db, packet.document.id);
    const started = await service.startSession({ documentId: packet.document.id, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'isolated-copy', prompt: 'Summarize this context.', contextPacket: packet }, ownerId);
    await waitForSessionStatus(service, started.session.id, 'completed');
    const serialized = await readFile(join(root, 'context', `${started.session.id}.json`), 'utf8');
    const parsed = JSON.parse(serialized) as AgentContextPacket;
    return parsed;
  } finally {
    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('AgentService safety and lifecycle', () => {
  it('starts a near-limit canonical section packet without exceeding the persisted byte budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-context-budget-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ControlledRegistry(new ControlledAdapter()),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      log: logger,
      isPackaged: false,
      isGitRepository: () => Promise.resolve(false),
    });
    const packet: AgentContextPacket = {
      version: 1,
      scopeLabel: 'Blocks 1–4',
      document: { id: 'near-limit', hash: 'near-limit-hash', title: 'Near limit', author: null },
      selection: {
        exactQuote: 'A'.repeat(255_000),
        anchor: { format: 'markdown', blockIndex: 0, quote: { exact: '', prefix: '', suffix: '' } },
        location: { format: 'markdown', blockIndex: 0 },
        surroundingText: null,
      },
      provenance: {
        source: 'interleaf-reader-selection',
        capturedAt: new Date().toISOString(),
        contentIsUntrustedReference: true,
        truncated: true,
      },
    };
    try {
      await service.initialize();
      const directory = await service.selectWorkingDirectory();
      if (directory === null) throw new Error('directory was not selected');
      insertTestDocument(db, packet.document.id);
      const started = await service.startSession({ documentId: packet.document.id, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'isolated-copy', prompt: 'Summarize this section.', contextPacket: packet }, 701);
      await waitForSessionStatus(service, started.session.id, 'completed');
      const serialized = await readFile(join(root, 'context', `${started.session.id}.json`), 'utf8');
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
      const persisted = JSON.parse(serialized) as AgentContextPacket;
      expect(persisted.selection.exactQuote).toHaveLength(255_000);
      expect(persisted.selection.anchor.quote.exact).toBe('');
      expect(service.getSession(started.session.id)?.status).toBe('completed');
    } finally {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    ['direct selection', 'direct-selection' as const],
    ['section attachment', 'section' as const],
    ['PDF page-range attachment', 'page-range' as const],
  ])('starts a near-limit %s packet produced by the renderer normalizer', async (_label, kind) => {
    const packet = nearLimitPacket(kind);
    expect(agentContextPacketSchema.safeParse(packet).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(packet), 'utf8')).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);

    const persisted = await startAndReadContextPacket(packet, 702);
    expect(agentContextPacketSchema.safeParse(persisted).success).toBe(true);
    expect(persisted.selection.exactQuote.length).toBeGreaterThan(250_000);
    expect(Buffer.byteLength(JSON.stringify(persisted), 'utf8')).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
  }, 20_000);

  it('rejects a mismatched anchor/location format at the main start boundary', async () => {
    const valid = nearLimitPacket('section');
    const malformed: AgentContextPacket = {
      ...valid,
      selection: {
        ...valid.selection,
        location: { format: 'pdf', pageIndex: 0 },
      },
    };

    await expect(startAndReadContextPacket(malformed, 703)).rejects.toThrow('formats must match');
  }, 20_000);

  it('requires fresh dangerous confirmation for an unsafe built-in in isolated mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-dangerous-agent-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const adapter = new DangerousAdapter();
    let allow = false;
    let confirmations = 0;
    const service = createTestAgentService({ database: db,
      repository: new AgentRepository(db), registry: new WorkingDirectoryRegistry(), agentRegistry: new DangerousRegistry(adapter),
      contextRoot: join(root, 'context'), chooseDirectory: () => Promise.resolve(root), log: logger, isPackaged: false,
      isGitRepository: () => Promise.resolve(false), confirmDangerousAgentRun: () => { confirmations += 1; return Promise.resolve(allow); },
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    await expect(service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'danger' }, 91)).rejects.toThrow(/cancelled/i);
    expect(service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);
    allow = true;
    const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'danger' }, 91);
    // Wait for the consumer to reach the terminal status rather than for a
    // fixed 20ms: on a loaded machine the run is still 'running' when a fixed
    // sleep expires, and the assertion below is about the status, not the
    // latency.
    await waitForSessionStatus(service, started.session.id, 'completed');
    expect(confirmations).toBe(2);
    expect(service.getSession(started.session.id)?.status).toBe('completed');
    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('counts a run until its process is reaped, and refuses new runs once update admission closes', async () => {
    let reap: () => void = () => undefined;
    let exited = false;
    const adapter = new ControlledAdapter();
    adapter.start = () => {
      adapter.startCalls += 1;
      const timestamp = new Date().toISOString();
      return {
        events: (async function* () {
          await Promise.resolve();
          yield { sessionId: '', ordinal: 0, type: 'started', timestamp } as const;
          yield { sessionId: '', ordinal: 0, type: 'final', text: 'done', timestamp } as const;
          yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: 0, signal: null, timestamp } as const;
          exited = true;
        })(),
        completion: new Promise<void>((resolve) => { reap = resolve; }),
        cancel: () => undefined,
      };
    };
    const { service, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(adapter) });
    expect(service.liveWork()).toBe(0);
    const request = { documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'hold' } as const;
    const started = await service.startSession(request, 5);
    await vi.waitFor(() => { expect(exited).toBe(true); });
    // Every event is consumed, but the process group is not reaped yet.
    expect(service.liveWork()).toBeGreaterThan(0);
    service.closeAdmission();
    await expect(service.startSession(request, 5)).rejects.toThrow('shutting down');
    expect(adapter.startCalls).toBe(1);
    reap();
    await waitForSessionStatus(service, started.session.id, 'completed');
    await vi.waitFor(() => { expect(service.liveWork()).toBe(0); });
    await close();
  });

  it('persists a failed terminal outcome when adapter startup throws', async () => {
    const adapter = new ControlledAdapter();
    adapter.shouldThrow = true;
    const { service, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(adapter) });
    await expect(service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'start' }, 11)).rejects.toThrow('fixture start failure');
    const sessions = service.listSessions(TEST_DOCUMENT_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('failed');
    const detail = service.getSession(sessions[0]?.id ?? '');
    expect(detail?.events.some((event) => event.type === 'error')).toBe(true);
    await close();
  });

  it.each([
    {
      label: 'preserves a safe non-internal InterleafError cause as the typed error payload',
      cause: new InterleafError('validation', 'Model reasoning effort is unsupported for this target'),
      persisted: { __interleafError: true, code: 'validation', message: 'Model reasoning effort is unsupported for this target' },
    },
    {
      label: 'sanitizes an internal InterleafError cause to a generic message without the secret-like raw message',
      cause: new InterleafError('internal', 'Database authentication failed: token=sk-ant-live-super-secret-credential-98765'),
      persisted: { __interleafError: true, code: 'internal', message: 'Agent startup failed.' },
    },
  ])('$label', async ({ cause, persisted }) => {
    const adapter = new ControlledAdapter();
    adapter.shouldThrow = true;
    adapter.throwError = cause;
    const { service, repository, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(adapter) });

    await expect(service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'start' }, 11)).rejects.toThrow(cause.message);

    const sessions = service.listSessions(TEST_DOCUMENT_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('failed');
    const events = repository.listEvents(sessions[0]!.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(eventError(events[0])).toEqual(persisted);
    if (persisted.code === 'internal') {
      expect(JSON.stringify(events)).not.toContain('Database authentication failed');
      expect(JSON.stringify(events)).not.toContain('sk-ant-live-super-secret-credential-98765');
    }
    await close();
  });

  it('streams fake events and rejects unsupported/direct modes before spawning', async () => {
    const { service, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(new ControlledAdapter()) });
    await expect(service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'active-env', prompt: 'unsafe' }, 1)).rejects.toThrow(/unavailable/i);
    const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'safe' }, 1);
    // A run settles once its workspace comparison finishes, and that scan now
    // runs on a worker thread (item H), so poll for the terminal status rather
    // than assuming it lands within a fixed tick.
    const detail = await waitForTerminalSession(service, result.session.id);
    expect(detail?.status).toBe('completed');
    expect(detail?.events.some((event) => event.type === 'final')).toBe(true);
    await service.discardSandbox(result.session.id, 1);
    const explicitProfileOverride = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'isolated-copy', prompt: 'profile override' }, 1);
    expect(explicitProfileOverride.session.executionMode).toBe('isolated-copy');
    await waitForTerminalSession(service, explicitProfileOverride.session.id);
    await service.discardSandbox(explicitProfileOverride.session.id, 1);
    await close();
  });

  it('maps raw classified tests, changed-files, and final frames from split JSON lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-discriminator-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const shortProfile: MainAgentProfile = { ...profile };
    const frames = [
      JSON.stringify({ kind: 'tests', marker: 't', status: 'passed' }),
      JSON.stringify({ type: 'changed-files', marker: 'e', files: ['a.txt'] }),
      JSON.stringify({ kind: 'final', marker: 'a', text: 'a final' }),
    ];
    const fakeSpawn: ProcessSpawner = () => {
      const child = new TestChildProcess({ pid: undefined });
      const { stdout, stderr } = child;
      void (async () => {
        for (const frame of frames) {
          stdout.write(frame.slice(0, 1));
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          stdout.write(`${frame.slice(1)}\n`);
        }
        stdout.end();
        stderr.end();
        child.emit('close', 0, null);
      })();
      return child;
    };
    const runner = new ProcessRunner(fakeSpawn);
    const adapter: AgentAdapter = {
      profile: shortProfile,
      capabilities: shortProfile.capabilities,
      detect: () => Promise.resolve(shortProfile.detection),
      start: (request) => {
        const handle = runner.run({ file: 'fixture', args: [], cwd: request.canonicalWorkingDirectory, timeoutMs: 10_000 });
        return { events: mapProcessEvents(handle.events), completion: handle.completion, cancel: handle.cancel };
      },
      cancel: () => undefined,
    };
    class ShortDiscriminatorRegistry extends AgentRegistry {
      override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([shortProfile]); }
      override addFakeAdapter(): MainAgentProfile { return shortProfile; }
      override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
    }
    const repository = new AgentRepository(db);
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ShortDiscriminatorRegistry(testAgentRegistryOptions()),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      log: logger,
      isPackaged: false,
      isGitRepository: () => Promise.resolve(false),
    });
    try {
      await service.initialize();
      const directory = await service.selectWorkingDirectory();
      if (directory === null) throw new Error('directory was not selected');
      const received: AgentEvent[] = [];
      service.subscribe(812, (event) => { received.push(event); });
      const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'isolated-copy', prompt: 'test' }, 812);
      await waitForSessionStatus(service, result.session.id, 'completed');
      const detail = service.getSession(result.session.id);
      const mapped = received.filter((event) => event.type === 'tests' || event.type === 'changed-files' || event.type === 'final');
      expect(mapped.map((event) => event.type)).toEqual(['tests', 'changed-files', 'final']);
      expect(mapped[0]?.type === 'tests' ? mapped[0].data : undefined).toEqual({ kind: 'tests', marker: 't', status: 'passed' });
      expect(mapped[1]?.type === 'changed-files' ? mapped[1].data : undefined).toEqual({ kind: 'changed-files', files: ['a.txt'] });
      expect(mapped[2]?.type === 'final' ? mapped[2].text : undefined).toBe('a final');
      const persisted = repository.listEvents(result.session.id);
      expect(persisted.filter((event) => event.type === 'tests' || event.type === 'changed-files' || event.type === 'final').map((event) => event.type)).toEqual(['tests', 'changed-files', 'final']);
      const serializedPayload = JSON.stringify([...received, ...persisted]);
      expect(serializedPayload).toContain('"marker":"t"');
      expect(serializedPayload).toContain('a.txt');
      expect(detail?.finalReport).toBe('a final');
      expect(repository.listArtifacts(result.session.id).some((artifact) => artifact.kind === 'changed_files')).toBe(true);
      expect(repository.listArtifacts(result.session.id).some((artifact) => artifact.kind === 'test_result')).toBe(true);
    } finally {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
  it('redacts adapter event data before SQLite persistence and renderer subscriptions', async () => {
    const { service, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(new SecretEventAdapter()) });
    const received: string[] = [];
    const unsubscribe = service.subscribe(17, (event) => { received.push(JSON.stringify(event)); });
    const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'redaction' }, 17);
    expect(result.session.executionMode).toBe('isolated-copy');
    // The final event lands once the run settles, which now includes a
    // worker-thread workspace scan (item H).
    await waitForTerminalSession(service, result.session.id);
    unsubscribe();
    const detail = service.getSession(result.session.id);
    for (const serialized of [JSON.stringify(detail?.events ?? []), received.join('\n')]) {
      for (const secret of ['service-secret-9a7b6c5d', QUOTED_SECRET, BEARER_SECRET, SPLIT_SERVICE_PREFIX, SPLIT_SERVICE_SUFFIX, MULTILINE_SERVICE_PREFIX, MULTILINE_SERVICE_SUFFIX]) {
        expect(serialized).not.toContain(secret);
      }
    }
    expect(detail?.events.find((event) => event.type === 'structured')?.data).toEqual({ token: '[REDACTED]', nested: { password: '[REDACTED]', authorization: '[REDACTED]' } });
    expect(detail?.events.find((event) => event.type === 'final')?.text).toBe('secret=[REDACTED]');
    await close();
  });

  it('records and persists dropped events summary across ProcessRunner queue saturation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-queue-overflow-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);

    const fakeSpawn: ProcessSpawner = () => {
      const child = new TestChildProcess({ pid: undefined });
      const { stdout, stderr } = child;
      void (async () => {
        await Promise.resolve();
        // Emit 300 rapid stdout lines exceeding the 256 queue bound
        for (let i = 0; i < 300; i += 1) {
          stdout.write(`line ${String(i)}\n`);
        }
        stdout.write('{"kind":"final","text":"done overflow"}\n');
        stdout.end();
        stderr.end();
        child.emit('close', 0, null);
      })();
      return child;
    };

    const runner = new ProcessRunner(fakeSpawn);
    const adapter: AgentAdapter = {
      profile: { ...profile, defaultSandboxMode: 'auto-isolated' },
      capabilities: profile.capabilities,
      detect: () => Promise.resolve(profile.detection),
      start: (request) => {
        const handle = runner.run({ file: 'fixture', args: [], cwd: request.canonicalWorkingDirectory, timeoutMs: 10_000 });
        return { events: mapProcessEvents(handle.events), completion: handle.completion, cancel: handle.cancel };
      },
      cancel: () => undefined,
    };

    class OverflowRegistry extends AgentRegistry {
      override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([profile]); }
      override addFakeAdapter(): MainAgentProfile { return profile; }
      override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
    }

    const repository = new AgentRepository(db);
    const service = createTestAgentService({ database: db,
      repository, registry: new WorkingDirectoryRegistry(), agentRegistry: new OverflowRegistry(testAgentRegistryOptions()),
      contextRoot: join(root, 'context'), chooseDirectory: () => Promise.resolve(root), log: logger, isPackaged: false,
    });

    try {
      await service.initialize();
      const received: AgentEvent[] = [];
      const unsubscribe = service.subscribe(31, (event) => { received.push(event); });
      const directory = await service.selectWorkingDirectory();
      if (directory === null) throw new Error('directory was not selected');
      const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'overflow' }, 31);
      await waitForSessionStatus(service, result.session.id, 'completed');
      unsubscribe();

      const persisted = repository.listEvents(result.session.id);
      const summaryField = (event: (typeof persisted)[number], field: string): PortableMember =>
        event.type === 'structured' && isPortableRecord(event.data) ? event.data[field] : undefined;
      const droppedSummaries = persisted.filter((e) => e.type === 'structured' && summaryField(e, 'kind') === 'dropped-events');
      const finalEvents = persisted.filter((e) => e.type === 'final');
      const endedEvents = persisted.filter((e) => e.type === 'ended');

      // Exact accounting: 303 total process events into bounded queue (256)
      // Evicts 47 earliest stdout lines into exactly one dropped-events summary
      expect(droppedSummaries).toHaveLength(1);
      const firstSummary = droppedSummaries[0];
      if (firstSummary === undefined) throw new Error('A dropped-events summary must be persisted.');
      expect(summaryField(firstSummary, 'count')).toBe(47);
      expect(droppedSummaries[0]?.type).toBe('structured');

      // Terminal and final events are strictly retained without misclassification
      expect(finalEvents).toHaveLength(1);
      expect(finalEvents[0]?.text).toBe('done overflow');
      expect(endedEvents).toHaveLength(1);
      expect(endedEvents[0]?.exitCode).toBe(0);
      expect(service.getSession(result.session.id)?.finalReport).toBe('done overflow');

      // Subscription and SQLite persistence match exactly and stay bounded
      expect(persisted).toHaveLength(258);
      expect(received).toHaveLength(258);
      expect(persisted.map((e) => e.type)).toEqual(received.map((e) => e.type));
    } finally {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not misclassify a process error followed by a zero exit as completed', async () => {
    const { service, repository, directory, close } = await openFixtureService({ agentRegistry: new ControlledRegistry(new ErrorThenSuccessfulExitAdapter()) });
    try {
      const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'error terminal' }, 37);
      await waitForSessionStatus(service, result.session.id, 'failed');
      expect(repository.listEvents(result.session.id).some((event) => event.type === 'error')).toBe(true);
    } finally {
      await close();
    }
  });

  it('keeps run-specific paths and environment values visible across persistence, subscriptions, and copy result', async () => {
    const adapter = new PathEventAdapter('');
    let clipboardText = '';
    const { root, service, directory, close } = await openFixtureService({
      agentRegistry: new PathRegistry(adapter),
      clipboard: { writeText: (text) => { clipboardText = text; return Promise.resolve(); } },
    });
    const received: string[] = [];
    const unsubscribe = service.subscribe(19, (event) => { received.push(JSON.stringify(event)); });
    const canonicalTargetPath = await realpath(root);
    adapter.setTargetPath(canonicalTargetPath);
    const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'path redaction' }, 19);
    await waitForSessionStatus(service, result.session.id, 'failed');
    unsubscribe();
    const detail = service.getSession(result.session.id);
    const finalReport = detail?.finalReport ?? '';
    const allPersisted = JSON.stringify(detail?.events ?? []);
    const temp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '';
    const pathComponent = (process.env.PATH ?? '').split(delimiter)[0] ?? '';
    await service.copyResult(result.session.id, 19);
    for (const visible of [root, canonicalTargetPath, processFixture, process.env.HOME ?? '', temp, pathComponent]) {
      if (visible.length === 0) continue;
      expect(allPersisted).toContain(visible);
      expect(received.join('\n')).toContain(visible);
      expect(finalReport).toContain(visible);
      expect(clipboardText).toContain(visible);
    }
    await close();
  });

  it('covers the complete direct-mode identity race matrix with fresh state per case', async () => {
    type RaceMode = 'active-env' | 'native-restricted';
    type RacePhase = 'start' | 'resume';
    type RaceAwait = 'direct' | 'dangerous';
    type SwapKind = 'recreate' | 'symlink';
    type RaceCase = { readonly phase: RacePhase; readonly mode: RaceMode; readonly awaitPoint: RaceAwait };
    const cases: readonly RaceCase[] = [
      { phase: 'start', mode: 'active-env', awaitPoint: 'dangerous' },
      { phase: 'start', mode: 'native-restricted', awaitPoint: 'dangerous' },
      { phase: 'resume', mode: 'active-env', awaitPoint: 'direct' },
      { phase: 'resume', mode: 'active-env', awaitPoint: 'dangerous' },
      { phase: 'resume', mode: 'native-restricted', awaitPoint: 'direct' },
      { phase: 'resume', mode: 'native-restricted', awaitPoint: 'dangerous' },
    ];
    const swapKinds: readonly SwapKind[] = process.platform === 'win32' ? ['recreate'] : ['recreate', 'symlink'];

    for (const [caseIndex, raceCase] of cases.entries()) {
      for (const swapKind of swapKinds) {
        const root = await mkdtemp(join(tmpdir(), `interleaf-agent-identity-race-${raceCase.phase}-${raceCase.mode}-${raceCase.awaitPoint}-${swapKind}-`));
        const targetDir = join(root, 'target-workspace');
        const relocatedTarget = join(root, 'relocated-target');
        const replacementTarget = join(root, 'replacement-target');
        await mkdir(targetDir, { recursive: true });
        const db = InterleafDatabase.open(':memory:');
        runTestMigrations(db);
        const adapter = new IdentityRaceAdapter();
        const registry = new IdentityRaceRegistry(adapter);
        const environmentManager = new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'environments') }));
        const prepareSpy = vi.spyOn(environmentManager, 'prepare');
        let lifecycle: 'baseline' | 'race' = raceCase.phase === 'start' ? 'race' : 'baseline';
        let swapped = false;

        const replaceTarget = async (): Promise<void> => {
          if (swapped) return;
          swapped = true;
          if (swapKind === 'recreate') {
            await rm(targetDir, { recursive: true, force: true });
            await mkdir(targetDir, { recursive: true });
            return;
          }
          await rename(targetDir, relocatedTarget);
          await mkdir(replacementTarget, { recursive: true });
          await symlink(replacementTarget, targetDir, 'dir');
        };
        const maybeReplace = async (point: RaceAwait): Promise<void> => {
          if (lifecycle === 'race' && raceCase.awaitPoint === point) await replaceTarget();
        };
        const service = createTestAgentService({ database: db,
          repository: new AgentRepository(db),
          registry: new WorkingDirectoryRegistry(),
          agentRegistry: registry,
          contextRoot: join(root, 'context'),
          environmentManager,
          // The subject here is target identity, not the capability proof, so
          // Native Restricted is stated as already proven for this profile.
          nativeSandboxProber: new StubNativeSandboxProber(),
          chooseDirectory: () => Promise.resolve(targetDir),
          isGitRepository: () => Promise.resolve(false),
          confirmDirectWorkspace: async () => {
            await maybeReplace('direct');
            return true;
          },
          confirmDangerousAgentRun: async () => {
            await maybeReplace('dangerous');
            return true;
          },
          log: logger,
          isPackaged: false,
        });

        const ownerId = 300 + caseIndex;
        const draftId = `identity-race-${raceCase.phase}-${raceCase.mode}-${raceCase.awaitPoint}-${swapKind}`;
        try {
          await service.initialize();
          const selection = await service.selectWorkingDirectory();
          if (selection === null) throw new Error('directory selection failed');
          const issueGrant = async (prompt: string) => service.issueRiskGrant({
            draftId,
            profileId: 'fake',
            workingDirectoryHandle: selection.handle,
            executionMode: raceCase.mode,
            prompt,
            model: null,
            contextPacket: null,
          }, ownerId);

          if (raceCase.phase === 'start') {
            const grant = await issueGrant('identity start race');
            await expect(service.startSession({
              documentId: TEST_DOCUMENT_ID,
              profileId: 'fake',
              workingDirectoryHandle: selection.handle,
              executionMode: raceCase.mode,
              prompt: 'identity start race',
              riskConfirmation: { grantId: grant.grantId, draftId: draftId },
            }, ownerId)).rejects.toThrow(/changed|replaced|inaccessible|selected again|invalid/i);
            expect(adapter.startCalls).toBe(0);
            expect(adapter.resumeCalls).toBe(0);
            expect(prepareSpy).not.toHaveBeenCalled();
            expect(service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);
            await expect(issueGrant('stale identity grant')).rejects.toThrow(/changed|replaced|inaccessible|invalid|selected again/i);
            await expect(service.startSession({
              documentId: TEST_DOCUMENT_ID,
              profileId: 'fake',
              workingDirectoryHandle: selection.handle,
              executionMode: raceCase.mode,
              prompt: 'stale identity retry',
              riskConfirmation: { grantId: grant.grantId, draftId: draftId },
            }, ownerId)).rejects.toThrow(/changed|replaced|inaccessible|invalid|selected again|grant/i);
            expect(adapter.startCalls).toBe(0);
            expect(service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);
          } else {
            const baselineGrant = await issueGrant('identity resume baseline');
            const baseline = await service.startSession({
              documentId: TEST_DOCUMENT_ID,
              profileId: 'fake',
              workingDirectoryHandle: selection.handle,
              executionMode: raceCase.mode,
              prompt: 'identity resume baseline',
              riskConfirmation: { grantId: baselineGrant.grantId, draftId: draftId },
            }, ownerId);
            await waitForSessionStatus(service, baseline.session.id, 'completed');
            expect(service.getSession(baseline.session.id)?.finalReport).toBe('initial completed');
            const prepareCalls = prepareSpy.mock.calls.length;
            lifecycle = 'race';

            await expect(service.resumeSession({ sessionId: baseline.session.id, prompt: 'identity resume race' }, ownerId))
              .rejects.toThrow(/changed|replaced|inaccessible|selected again|invalid/i);
            expect(adapter.resumeCalls).toBe(0);
            expect(prepareSpy).toHaveBeenCalledTimes(prepareCalls);
            expect(service.getSession(baseline.session.id)?.status).toBe('completed');
            expect(service.getSession(baseline.session.id)?.finalReport).toBe('initial completed');
            await expect(issueGrant('stale resume handle')).rejects.toThrow(/changed|replaced|inaccessible|invalid|selected again/i);
            await expect(service.resumeSession({ sessionId: baseline.session.id, prompt: 'stale resume retry' }, ownerId))
              .rejects.toThrow(/changed|replaced|inaccessible|selected again|invalid/i);
            expect(adapter.resumeCalls).toBe(0);
            expect(service.getSession(baseline.session.id)?.status).toBe('completed');
          }
        } finally {
          await service.shutdown();
          db.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  it('rejects startSession with Copilot profile fail-closed before environment preparation or spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-copilot-start-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);

    const service = createTestAgentService({ database: db,
      repository: new AgentRepository(db),
      registry: new WorkingDirectoryRegistry(),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      log: logger,
      isPackaged: false,
    });

    try {
      await service.initialize();
      const selection = await service.selectWorkingDirectory();
      if (selection === null) throw new Error('directory selection failed');

      await expect(service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'copilot', workingDirectoryHandle: selection.handle, prompt: 'copilot start attempt' }, 15)).rejects.toThrow(/selected agent profile is unavailable|GitHub Copilot CLI is not installed|GitHub Copilot CLI is unavailable for unattended Agent Mode/i);
    } finally {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves actionable ProcessRunner error diagnostics while redacting secrets and keeping paths visible', async () => {
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const secret = 'super-secret-diagnostic-key-9988';
    const diagnosticSecret = secret;
    process.env.TEST_DIAGNOSTIC_SECRET = secret;

    const scenarios: {
      label: 'spawn-failure' | 'timeout' | 'output-cap' | 'windows-helper-failure';
      runnerFactory: (sensitivePath: string) => ProcessRunner;
    }[] = [
      {
        label: 'spawn-failure',
        runnerFactory: (sensitivePath) => {
          const fakeSpawn: ProcessSpawner = () => {
            const child = new TestChildProcess({ pid: undefined });
            queueMicrotask(() => {
              const err = new Error(`spawn ENOENT for binary with secret ${diagnosticSecret} at ${sensitivePath}`);
              Object.assign(err, { code: 'ENOENT', path: sensitivePath });
              child.fail(err);
            });
            return child;
          };
          return new ProcessRunner(fakeSpawn);
        },
      },
      {
        label: 'timeout',
        runnerFactory: () => {
          const fakeSpawn: ProcessSpawner = () => {
            const child = new TestChildProcess({ pid: 1234 });
            queueMicrotask(() => {
              child.stdout.write(`processing token ${diagnosticSecret}\n`);
            });
            return child;
          };
          return new ProcessRunner({ spawnProcess: fakeSpawn, timeoutMs: 20 });
        },
      },
      {
        label: 'output-cap',
        runnerFactory: () => {
          const fakeSpawn: ProcessSpawner = () => {
            const child = new TestChildProcess({ pid: 1235 });
            queueMicrotask(() => {
              const chunk = Buffer.alloc(2.5 * 1024 * 1024, 'a');
              child.stdout.write(`secret ${diagnosticSecret} `);
              child.stdout.write(chunk);
              child.stdout.end();
            });
            return child;
          };
          return new ProcessRunner(fakeSpawn);
        },
      },
      {
        label: 'windows-helper-failure',
        runnerFactory: () => {
          const fakeSpawn: ProcessSpawner = () => {
            const child = new TestChildProcess({ pid: 9999 });
            child.exitOnSignal = 'SIGKILL';
            queueMicrotask(() => {
              child.stdout.write(`secret ${diagnosticSecret}\n`);
            });
            return child;
          };
          return new ProcessRunner({
            platform: 'win32',
            systemRoot: 'C:\\Windows',
            windowsTerminationGraceMs: 0,
            spawnProcess: fakeSpawn,
            windowsTaskkill: () => Promise.resolve(false),
            timeoutMs: 20,
          });
        },
      },
    ];

    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-diagnostics-'));
      const sensitivePath = join(root, 'sensitive-subfolder', 'secret-file.txt');
      const runner = scenario.runnerFactory(sensitivePath);
      const adapter: AgentAdapter = {
        profile,
        capabilities: profile.capabilities,
        detect: () => Promise.resolve(profile.detection),
        start: (request) => {
          const handle = runner.run({
            file: sensitivePath,
            args: [],
            cwd: request.canonicalWorkingDirectory,
            timeoutMs: scenario.label === 'timeout' || scenario.label === 'windows-helper-failure' ? 20 : 10_000,
            // The caller explicitly registers the diagnostic secret; delivering
            // it through the environment alone would not designate it secret.
            redactValues: [secret],
          });
          return { events: mapProcessEvents(handle.events), completion: handle.completion, cancel: handle.cancel };
        },
        cancel: () => undefined,
      };
      class DiagnosticRegistry extends AgentRegistry {
        override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([adapter.profile]); }
        override addFakeAdapter(): MainAgentProfile { return adapter.profile; }
        override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
      }

      const repository = new AgentRepository(db);
      const service = createTestAgentService({ database: db,
        repository,
        registry: new WorkingDirectoryRegistry(),
        agentRegistry: new DiagnosticRegistry(testAgentRegistryOptions()),
        contextRoot: join(root, 'context'),
        chooseDirectory: () => Promise.resolve(root),
        log: logger,
        isPackaged: false,
      });

      try {
        await service.initialize();
        const receivedEvents: AgentEvent[] = [];
        const unsubscribe = service.subscribe(50, (event) => { receivedEvents.push(event); });
        const directory = await service.selectWorkingDirectory();
        if (directory === null) throw new Error('directory selection failed');

        const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: `test diagnostic for ${scenario.label}` }, 50);
        await waitForSessionStatus(service, result.session.id, 'failed');
        unsubscribe();
        const persistedEvents = repository.listEvents(result.session.id);
        const errorEvents = [...receivedEvents, ...persistedEvents].filter((e) => e.type === 'error');
        expect(errorEvents.length).toBeGreaterThan(0);
        for (const errorEvent of errorEvents) {
          const serialized = JSON.stringify(errorEvent);
          expect(serialized).not.toContain(secret);
          // Local filesystem paths stay readable in error diagnostics.
          expect(serialized).toContain(sensitivePath);
          expect(errorEvent.error.__interleafError).toBe(true);
        }
        // The explicitly supplied secret value remains redacted across all
        // persisted and subscribed events.
        expect(JSON.stringify([...receivedEvents, ...persistedEvents])).toContain('[REDACTED]');
        const diagnosticMessages = errorEvents.map((event) => event.error.message);
        const expectedDiagnostic = scenario.label === 'timeout'
          ? 'timed out'
          : scenario.label === 'output-cap'
            ? 'output exceeded'
            : scenario.label === 'spawn-failure'
              ? 'spawn ENOENT'
              : 'Windows process-tree termination helper';
        expect(diagnosticMessages.some((message) => message.includes(expectedDiagnostic))).toBe(true);
      } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    }

    delete process.env.TEST_DIAGNOSTIC_SECRET;
    db.close();
  });

  it('waits for child reaping before shutdown returns', async () => {
    const adapter = new SlowProcessAdapter();
    const { db, root, service, directory } = await openFixtureService({ agentRegistry: new ProcessRegistry(adapter) });
    const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'shutdown' }, 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await service.shutdown();
    expect(adapter.completion).not.toBeNull();
    await adapter.completion;
    expect(service.getSession(result.session.id)?.status).toBe('cancelled');
    db.close();
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it('caps a test-result flood at 128 before artifacts and review work', async () => {
    // Item I: every reported test frame used to create an artifact row and
    // rebuild the whole environment review, so cheap agent stdout amplified
    // into unbounded main-process work.
    const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-test-flood-'));
    const target = join(root, 'workspace');
    await mkdir(target, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') }));
    const reviews = vi.spyOn(manager, 'getReview');
    const writes = vi.spyOn(manager as object as { writeMetadata: (...args: readonly never[]) => Promise<void> }, 'writeMetadata');
    const frames = 400;
    const delivered: { readonly type: string }[] = [];
    const service = createTestAgentService({ database: db,
      repository, registry: new WorkingDirectoryRegistry(), agentRegistry: new ControlledRegistry(new TestFloodAdapter(frames)),
      contextRoot: join(root, 'context'), environmentManager: manager,
      chooseDirectory: () => Promise.resolve(target), log: logger, isPackaged: false,
      isGitRepository: () => Promise.resolve(false),
    });
    try {
      await service.initialize();
      const directory = await service.selectWorkingDirectory();
      if (directory === null) throw new Error('directory was not selected');
      service.subscribe(91, (event) => { delivered.push({ type: event.type }); });
      const result = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, executionMode: 'isolated-copy', prompt: 'flood' }, 91);
      // A flood this large is deliberately slow work; allow it to finish.
      await waitForSessionStatus(service, result.session.id, 'completed', 4_000);

      const artifacts = repository.listArtifacts(result.session.id).filter((artifact) => artifact.kind === 'test_result');
      // 127 admitted results plus the run's one coalesced summary.
      expect(artifacts).toHaveLength(128);
      // 127 accepted results plus the run's single terminal review.
      expect(reviews.mock.calls.length).toBeLessThanOrEqual(128);
      // Refused results never rewrite the environment metadata: one write per
      // admitted result plus the run's single terminal flush.
      expect(writes.mock.calls.length).toBeLessThanOrEqual(129);

      const review = (await manager.review(result.session.id)).review;
      expect(review.tests).toHaveLength(128);
      // The flood is summarised, not silently dropped, in exactly one entry.
      const coalesced = review.tests[127];
      expect(coalesced?.status).toBe('unknown');
      expect(coalesced?.summary).toContain(`${String(frames - 127)} further test results`);

      // Refused frames are never persisted or delivered one by one: the
      // subscriber and the event log both see the admitted results plus the
      // one summary, and the run's real terminal outcome is untouched.
      const events = repository.listEvents(result.session.id);
      const testEvents = events.filter((event) => event.type === 'tests');
      expect(testEvents).toHaveLength(128);
      expect(testEvents.at(-1)?.data.message).toContain(`${String(frames - 127)} further test results`);
      expect(delivered.filter((event) => event.type === 'tests')).toHaveLength(128);
      expect(events.some((event) => event.type === 'final')).toBe(true);
      expect(events.some((event) => event.type === 'ended')).toBe(true);
      const terminalTypes = events.map((event) => event.type).filter((type) => type === 'final' || type === 'ended');
      expect(terminalTypes).toEqual(['final', 'ended']);
      expect(service.getSession(result.session.id)?.finalReport).toBe('flood final');

      // A resumed run is a new run: it gets its own budget rather than
      // inheriting an exhausted one, and durable history keeps both.
      const artifactsBeforeResume = artifacts.length;
      const initialEventCount = service.getSession(result.session.id)?.eventCount;
      await service.resumeSession({ sessionId: result.session.id, prompt: 'flood again' }, 91);
      await waitForSessionStatus(service, result.session.id, 'completed', 4_000, { baselineEventCount: initialEventCount });
      const afterResume = repository.listArtifacts(result.session.id).filter((artifact) => artifact.kind === 'test_result');
      expect(afterResume.length - artifactsBeforeResume).toBe(128);
      const resumedReview = (await manager.review(result.session.id)).review;
      expect(resumedReview.tests).toHaveLength(256);
      expect(resumedReview.tests.at(-1)?.summary).toContain(`${String(frames - 127)} further test results`);
    } finally {
      await service.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('closes the capability prober during shutdown so no probe outlives the drain', async () => {
    // Item R: shutdown used to leave an in-flight probe child to its own
    // bound. The prober is now part of the drain set, so closing it — and the
    // fail-closed `null` its awaiting caller receives — happens before
    // shutdown returns.
    const prober = new BlockingNativeSandboxProber();
    const { db, root, service } = await openFixtureService({ agentRegistry: new ProcessRegistry(new SlowProcessAdapter()), nativeSandboxProber: prober });
    const inFlight = prober.verify();
    await prober.started;

    await service.shutdown();

    expect(prober.closeCalls).toBe(1);
    expect(await inFlight).toBeNull();
    db.close();
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it('keeps environment actions blocked until adapter completion and handles malformed event lifecycles', async () => {
    const adapter = new LifecycleAdapter('delayed-completion');
    const delayedFixture = await openFixtureService({ agentRegistry: new ControlledRegistry(adapter) });
    const service = delayedFixture.service;
    const delayed = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: delayedFixture.directory.handle, executionMode: 'auto-isolated', prompt: 'barrier' }, 23);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getSession(delayed.session.id)?.status).toBe('running');
    await expect(service.discardSandbox(delayed.session.id, 23)).rejects.toThrow(/finished|reaped/i);
    adapter.release();
    await waitForSessionStatus(service, delayed.session.id, 'completed');
    await expect(service.discardSandbox(delayed.session.id, 23)).resolves.toBeUndefined();
    await delayedFixture.close();

    const throwingAdapter = new LifecycleAdapter('iterator-throws-delayed-completion');
    const throwingFixture = await openFixtureService({ agentRegistry: new ControlledRegistry(throwingAdapter) });
    const throwingService = throwingFixture.service;
    const throwingResult = await throwingService.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: throwingFixture.directory.handle, executionMode: 'auto-isolated', prompt: 'iterator throw barrier' }, 25);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(throwingService.getSession(throwingResult.session.id)?.status).toBe('running');
    await expect(throwingService.discardSandbox(throwingResult.session.id, 25)).rejects.toThrow(/finished|reaped/i);
    await throwingService.stopSession(throwingResult.session.id, 25);
    expect(throwingAdapter.cancelCalls).toBe(1);
    expect(throwingService.getSession(throwingResult.session.id)?.status).toBe('cancelled');
    throwingAdapter.release();
    await waitForDiscard(throwingService, throwingResult.session.id, 25);
    const throwingDetail = throwingService.getSession(throwingResult.session.id);
    expect(throwingDetail?.status).toBe('cancelled');
    expect(throwingDetail?.events.some((event) => event.type === 'ended')).toBe(true);
    const endedOrdinal = throwingDetail?.events.findLast((event) => event.type === 'ended')?.ordinal ?? -1;
    const cancelledOrdinal = throwingDetail?.events.findLast((event) => event.type === 'cancelled')?.ordinal ?? -1;
    expect(endedOrdinal).toBeGreaterThan(cancelledOrdinal);
    await throwingFixture.close();

    for (const kind of ['nonzero-ended', 'missing-ended', 'iterator-throws'] as const) {
      const caseFixture = await openFixtureService({ agentRegistry: new ControlledRegistry(new LifecycleAdapter(kind)) });
      const result = await caseFixture.service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: caseFixture.directory.handle, executionMode: 'auto-isolated', prompt: kind }, 24);
      await waitForSessionStatus(caseFixture.service, result.session.id, 'failed');
      await caseFixture.close();
    }
  }, 20_000);

  it('does not persist or spawn after a timed-out deferred environment prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-prepare-'));
    const target = join(root, 'workspace');
    await mkdir(target, { recursive: true });
    const appRoot = join(root, 'agent-workspaces');
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const adapter = new ControlledAdapter();
    const environmentManager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const originalPrepare = environmentManager.prepare.bind(environmentManager);
    vi.spyOn(environmentManager, 'prepare').mockImplementation(async (input) => {
      enteredResolve();
      await prepareGate;
      return originalPrepare(input);
    });
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'),
      environmentManager,
      chooseDirectory: () => Promise.resolve(target),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const updateSpy = vi.spyOn(repository, 'updateSession');
    const deleteSpy = vi.spyOn(repository, 'deleteContextArtifacts');
    const appendSpy = vi.spyOn(repository, 'appendEvent');
    const pending = service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'deferred prepare' }, 101);
    await entered;

    vi.useFakeTimers();
    try {
      const shutdown = service.shutdown();
      await vi.advanceTimersByTimeAsync(10_001);
      await shutdown;
      const callsAtClose = { update: updateSpy.mock.calls.length, remove: deleteSpy.mock.calls.length, append: appendSpy.mock.calls.length };
      releasePrepare();
      await expect(pending).rejects.toThrow();
      expect(adapter.startCalls).toBe(0);
      expect(updateSpy).toHaveBeenCalledTimes(callsAtClose.update);
      expect(deleteSpy).toHaveBeenCalledTimes(callsAtClose.remove);
      expect(appendSpy).toHaveBeenCalledTimes(callsAtClose.append);
      const created = repository.listSessions(TEST_DOCUMENT_ID)[0];
      if (created !== undefined) await expect(realpath(join(appRoot, created.id))).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('removes a late context packet write without repository mutation after shutdown timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-context-'));
    const target = join(root, 'workspace');
    await mkdir(target, { recursive: true });
    const appRoot = join(root, 'agent-workspaces');
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const adapter = new ControlledAdapter();
    let enteredResolve!: (path: string) => void;
    const entered = new Promise<string>((resolve) => { enteredResolve = resolve; });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
      chooseDirectory: () => Promise.resolve(target),
      writeContextPacket: async (path, data) => {
        enteredResolve(path);
        await writeGate;
        await writeFile(path, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      },
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const updateSpy = vi.spyOn(repository, 'updateSession');
    const addSpy = vi.spyOn(repository, 'addArtifact');
    const appendSpy = vi.spyOn(repository, 'appendEvent');
    const pending = service.startSession({ documentId: TEST_CONTEXT_PACKET.document.id, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'deferred context', contextPacket: TEST_CONTEXT_PACKET }, 102);
    const contextPath = await entered;

    vi.useFakeTimers();
    try {
      const shutdown = service.shutdown();
      await vi.advanceTimersByTimeAsync(10_001);
      await shutdown;
      const callsAtClose = { update: updateSpy.mock.calls.length, add: addSpy.mock.calls.length, append: appendSpy.mock.calls.length };
      releaseWrite();
      await expect(pending).rejects.toThrow(/shutting down|cancelled/i);
      expect(adapter.startCalls).toBe(0);
      expect(updateSpy).toHaveBeenCalledTimes(callsAtClose.update);
      expect(addSpy).toHaveBeenCalledTimes(callsAtClose.add);
      expect(appendSpy).toHaveBeenCalledTimes(callsAtClose.append);
      await expect(realpath(contextPath)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not persist an active test/review continuation after shutdown timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-review-'));
    const target = join(root, 'workspace');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve; });
    // The suspension point an admitted test result still has: the inventory
    // flush that precedes its artifact and review work (item I).
    vi.spyOn(manager, 'flushTestInventory').mockImplementation(async () => {
      enteredResolve();
      await recordGate;
    });
    const adapter = new DeferredTestAdapter();
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'),
      environmentManager: manager,
      chooseDirectory: () => Promise.resolve(target),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'deferred review' }, 103);
    await entered;
    const updateSpy = vi.spyOn(repository, 'updateSession');
    const addSpy = vi.spyOn(repository, 'addArtifact');
    const appendSpy = vi.spyOn(repository, 'appendEvent');

    vi.useFakeTimers();
    try {
      const shutdown = service.shutdown();
      await vi.advanceTimersByTimeAsync(10_001);
      await shutdown;
      const callsAtClose = { update: updateSpy.mock.calls.length, add: addSpy.mock.calls.length, append: appendSpy.mock.calls.length };
      releaseRecord();
      await Promise.resolve();
      await Promise.resolve();
      expect(updateSpy).toHaveBeenCalledTimes(callsAtClose.update);
      expect(addSpy).toHaveBeenCalledTimes(callsAtClose.add);
      expect(appendSpy).toHaveBeenCalledTimes(callsAtClose.append);
      expect(service.getSession(started.session.id)?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('waits for a deferred environment lifecycle action and rejects its late repository write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-action-'));
    const target = join(root, 'workspace');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    const adapter = new ControlledAdapter();
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'),
      environmentManager: manager,
      chooseDirectory: () => Promise.resolve(target),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'deferred action' }, 104);
    await waitForSessionStatus(service, started.session.id, 'completed');
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseDiscard!: () => void;
    const discardGate = new Promise<void>((resolve) => { releaseDiscard = resolve; });
    vi.spyOn(manager, 'discard').mockImplementation(async () => {
      enteredResolve();
      await discardGate;
    });
    const updateSpy = vi.spyOn(repository, 'updateSession');
    const pending = service.discardSandbox(started.session.id, 104);
    await entered;

    vi.useFakeTimers();
    try {
      const shutdown = service.shutdown();
      await vi.advanceTimersByTimeAsync(10_001);
      await shutdown;
      const updateCallsAtClose = updateSpy.mock.calls.length;
      releaseDiscard();
      await expect(pending).rejects.toThrow(/persistence|shutting down/i);
      expect(updateSpy).toHaveBeenCalledTimes(updateCallsAtClose);
    } finally {
      vi.useRealTimers();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not write a resume failure after a delayed executable integrity check outlives shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-resume-hash-'));
    const target = join(root, 'workspace');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    const executablePath = join(root, 'agent');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const executableRegistry = new ExecutableRegistry();
    const service = createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry })),
      customProfiles: new CustomAgentProfileRepository(db),
      executableRegistry,
      contextRoot: join(appRoot, 'context'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
      chooseDirectory: () => Promise.resolve(target),
      chooseExecutable: () => Promise.resolve(executablePath),
      confirmDangerousAgentRun: () => Promise.resolve(true),
      log: logger,
      isPackaged: false,
    });

    const { promise: integrityCheckGate, resolve: resolveIntegrityCheck } = Promise.withResolvers<undefined>();
    let integrityCheckReleased = false;
    const releaseIntegrityCheck = () => {
      if (!integrityCheckReleased) {
        integrityCheckReleased = true;
        resolveIntegrityCheck(undefined);
      }
    };
    const { promise: integrityCheckReady, resolve: integrityCheckEntered } = Promise.withResolvers<undefined>();
    const originalResolveForSpawn = executableRegistry.resolveForSpawn.bind(executableRegistry);
    let resolveForSpawnCalls = 0;
    vi.spyOn(executableRegistry, 'resolveForSpawn').mockImplementation(async (handle) => {
      resolveForSpawnCalls += 1;
      if (resolveForSpawnCalls === 2) {
        integrityCheckEntered(undefined);
        await integrityCheckGate;
      }
      return originalResolveForSpawn(handle);
    });
    let dbClosed = false;
    let shutdownPromise: Promise<void> | null = null;
    let pendingResume: Promise<AgentStartResult> | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      await service.initialize();
      const selected = await service.selectExecutable();
      if (selected === null) throw new Error('Executable was not selected');
      const profile = await service.createCustomProfile({
        name: 'Shutdown resume hash',
        executableHandle: selected.handle,
        executionKind: 'normal',
        argvTemplate: [],
        promptDeliveryMode: 'stdin',
        stdoutParsingMode: 'text',
        supportsResume: true,
        resumeCommandTemplate: ['--resume', '{{sessionId}}'],
        workingDirectoryPolicy: 'select-per-run',
        defaultSandboxMode: 'auto-isolated',
        environmentOverrides: [],
        unsafe: false,
      });
      const directory = await service.selectWorkingDirectory();
      if (directory === null) throw new Error('Directory was not selected');
      const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: profile.id, workingDirectoryHandle: directory.handle, executionMode: 'auto-isolated', prompt: 'initial run' }, 1);
      await waitForSessionStatus(service, started.session.id, 'completed', 100, { timeoutMs: 8_000 });

      const updateSpy = vi.spyOn(repository, 'updateSession');
      const appendSpy = vi.spyOn(repository, 'appendEvent');
      const emittedEvents: AgentEvent[] = [];
      unsubscribe = service.subscribe(1, (event) => { emittedEvents.push(event); });
      pendingResume = service.resumeSession({ sessionId: started.session.id, prompt: 'late resume' }, 1);

      // Race readiness against early rejection and an explicit bounded readiness deadline (5s) with a cleared timer
      let readinessTimer: NodeJS.Timeout | undefined;
      const readinessTimeout = new Promise<never>((_, reject) => {
        readinessTimer = setTimeout(() => {
          reject(new Error('Timed out waiting for executable integrity check readiness seam'));
        }, 5_000);
      });
      const pendingResumeEarlyFailure = pendingResume.then(() => {
        throw new Error('pendingResume settled before reaching integrity check seam');
      });
      try {
        await Promise.race([integrityCheckReady, pendingResumeEarlyFailure, readinessTimeout]);
      } finally {
        clearTimeout(readinessTimer);
      }
      vi.useFakeTimers();
      let released = false;
      try {
        shutdownPromise = service.shutdown();
        await vi.advanceTimersByTimeAsync(10_001);
        await shutdownPromise;
        const callsAtClose = { update: updateSpy.mock.calls.length, append: appendSpy.mock.calls.length, emitted: emittedEvents.length };
        db.close();
        dbClosed = true;
        released = true;
        releaseIntegrityCheck();
        await expect(pendingResume).rejects.toThrow(/shutting down|invalid|expired/i);
        expect(updateSpy).toHaveBeenCalledTimes(callsAtClose.update);
        expect(appendSpy).toHaveBeenCalledTimes(callsAtClose.append);
        expect(emittedEvents).toHaveLength(callsAtClose.emitted);
      } finally {
        if (!released) releaseIntegrityCheck();
        vi.useRealTimers();
      }
    } finally {
      releaseIntegrityCheck();
      vi.useRealTimers();
      unsubscribe?.();
      shutdownPromise ??= service.shutdown();
      await teardownDelayedIntegrityTest({
        shutdownPromise,
        pendingResume,
        service,
        db,
        dbClosed,
        root,
      });
    }
  }, 30_000);

  it('fails closed for native picker and risk-grant continuations after shutdown', async () => {
    const pickerRoot = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-picker-'));
    const pickerDb = InterleafDatabase.open(':memory:');
    runTestMigrations(pickerDb);
    const pickerExecutables = new ExecutableRegistry();
    const registerSpy = vi.spyOn(pickerExecutables, 'register');
    let pickerEntered!: () => void;
    const pickerReady = new Promise<void>((resolve) => { pickerEntered = resolve; });
    let releasePicker!: () => void;
    const pickerGate = new Promise<void>((resolve) => { releasePicker = resolve; });
    const pickerService = createTestAgentService({ database: pickerDb,
      repository: new AgentRepository(pickerDb),
      registry: new WorkingDirectoryRegistry(),
      executableRegistry: pickerExecutables,
      contextRoot: join(pickerRoot, 'context'),
      chooseDirectory: () => Promise.resolve(pickerRoot),
      chooseExecutable: async () => { pickerEntered(); await pickerGate; return process.execPath; },
      log: logger,
      isPackaged: false,
    });
    await pickerService.initialize();
    const pickerPending = pickerService.selectExecutable();
    await pickerReady;
    await pickerService.shutdown();
    releasePicker();
    await expect(pickerPending).rejects.toThrow(/shutting down/i);
    expect(registerSpy).not.toHaveBeenCalled();
    pickerDb.close();
    await rm(pickerRoot, { recursive: true, force: true });

    const profileRoot = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-profile-'));
    const profileDb = InterleafDatabase.open(':memory:');
    runTestMigrations(profileDb);
    const profileExecutables = new ExecutableRegistry();
    const customProfiles = new CustomAgentProfileRepository(profileDb);
    const createSpy = vi.spyOn(customProfiles, 'create');
    const selectedShell = await profileExecutables.register(posixShell());
    let profileConfirmEntered!: () => void;
    const profileConfirmReady = new Promise<void>((resolve) => { profileConfirmEntered = resolve; });
    let releaseProfileConfirm!: () => void;
    const profileConfirmGate = new Promise<void>((resolve) => { releaseProfileConfirm = resolve; });
    const profileService = createTestAgentService({ database: profileDb,
      repository: new AgentRepository(profileDb),
      registry: new WorkingDirectoryRegistry(),
      executableRegistry: profileExecutables,
      customProfiles,
      contextRoot: join(profileRoot, 'context'),
      chooseDirectory: () => Promise.resolve(profileRoot),
      confirmExpertShellProfile: async () => { profileConfirmEntered(); await profileConfirmGate; return true; },
      log: logger,
      isPackaged: false,
    });
    await profileService.initialize();
    const profilePending = profileService.createCustomProfile({
      name: 'Deferred Expert Shell', executableHandle: selectedShell.handle, executionKind: 'expert-shell', shellFamily: 'posix',
      shellCommand: 'printf done', stdoutParsingMode: 'text', supportsModelSelection: false, supportsReasoningSelection: false,
      supportsResume: false, workingDirectoryPolicy: 'select-per-run', defaultSandboxMode: 'auto-isolated', environmentOverrides: [], unsafe: true,
    });
    await profileConfirmReady;
    await profileService.shutdown();
    releaseProfileConfirm();
    await expect(profilePending).rejects.toThrow(/shutting down/i);
    expect(createSpy).not.toHaveBeenCalled();
    profileDb.close();
    await rm(profileRoot, { recursive: true, force: true });

    const grantRoot = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-grant-'));
    const grantDb = InterleafDatabase.open(':memory:');
    runTestMigrations(grantDb);
    const grantStore = new RiskConfirmationGrantStore();
    const issueSpy = vi.spyOn(grantStore, 'issue');
    let confirmEntered!: () => void;
    const confirmReady = new Promise<void>((resolve) => { confirmEntered = resolve; });
    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
    const grantService = createTestAgentService({ database: grantDb,
      repository: new AgentRepository(grantDb),
      registry: new WorkingDirectoryRegistry(),
      riskGrantStore: grantStore,
      contextRoot: join(grantRoot, 'context'),
      chooseDirectory: () => Promise.resolve(grantRoot),
      confirmDirectWorkspace: async () => { confirmEntered(); await confirmGate; return true; },
      log: logger,
      isPackaged: false,
    });
    await grantService.initialize();
    const directory = await grantService.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const grantPending = grantService.issueRiskGrant({
      draftId: 'shutdown-grant-draft', profileId: 'fake', workingDirectoryHandle: directory.handle,
      executionMode: 'active-env', prompt: 'grant', model: null, contextPacket: null,
    }, 105);
    await confirmReady;
    await grantService.shutdown();
    releaseConfirm();
    await expect(grantPending).rejects.toThrow(/shutting down/i);
    expect(issueSpy).not.toHaveBeenCalled();
    grantDb.close();
    await rm(grantRoot, { recursive: true, force: true });
  }, 20_000);

  it('revokes new capability and rejects when delayed selectExecutable register finishes after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-delayed-register-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const executables = new ExecutableRegistry();
    let registerEntered!: () => void;
    const registerReady = new Promise<void>((resolve) => { registerEntered = resolve; });
    let releaseRegister!: () => void;
    const registerGate = new Promise<void>((resolve) => { releaseRegister = resolve; });
    const originalRegister = executables.register.bind(executables);
    let registeredHandle: string | undefined;
    vi.spyOn(executables, 'register').mockImplementation(async (filePath) => {
      registerEntered();
      await registerGate;
      const res = await originalRegister(filePath);
      registeredHandle = res.handle;
      return res;
    });
    const revokeSpy = vi.spyOn(executables, 'revoke');
    const service = createTestAgentService({ database: db,
      repository: new AgentRepository(db),
      registry: new WorkingDirectoryRegistry(),
      executableRegistry: executables,
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      chooseExecutable: () => Promise.resolve(process.platform === 'win32' ? process.execPath : posixShell()),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    const pendingSelect = service.selectExecutable();
    await registerReady;
    await service.shutdown();
    releaseRegister();
    await expect(pendingSelect).rejects.toThrow(/shutting down/i);
    expect(registeredHandle).toBeDefined();
    expect(revokeSpy).toHaveBeenCalledWith(registeredHandle);
    if (registeredHandle !== undefined) {
      await expect(executables.resolve(registeredHandle)).rejects.toThrow(/invalid or expired/i);
    }
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('revokes handle, does not install runtime/handles, and avoids unavailable profile when initialize rehydrate finishes after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-delayed-rehydrate-'));
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const customProfiles = new CustomAgentProfileRepository(db);
    const executables = new ExecutableRegistry();
    const initialRegistered = await executables.register(process.platform === 'win32' ? process.execPath : posixShell());
    customProfiles.create({
      id: `custom:${randomUUID()}`,
      name: 'Custom Shell Profile',
      canonicalPath: initialRegistered.canonicalPath,
      identity: initialRegistered.identity,
      config: {
        version: 1,
        executionKind: 'normal',
        argvTemplate: [],
        promptDeliveryMode: 'stdin',
        stdoutParsingMode: 'text',
        defaultModel: null,
        reasoningEffort: null,
        supportsModelSelection: false,
        supportsReasoningSelection: false,
        resumeCommandTemplate: null,
        supportsResume: false,
        workingDirectoryPolicy: 'select-per-run',
        defaultSandboxMode: 'auto-isolated',
        environmentOverrides: [],
        unsafe: false,
      },
    });

    let rehydrateEntered!: () => void;
    const rehydrateReady = new Promise<void>((resolve) => { rehydrateEntered = resolve; });
    let releaseRehydrate!: () => void;
    const rehydrateGate = new Promise<void>((resolve) => { releaseRehydrate = resolve; });
    const originalRehydrate = executables.rehydrate.bind(executables);
    let rehydratedHandle: string | undefined;
    vi.spyOn(executables, 'rehydrate').mockImplementation(async (filePath, identity) => {
      rehydrateEntered();
      await rehydrateGate;
      const res = await originalRehydrate(filePath, identity);
      rehydratedHandle = res.handle;
      return res;
    });
    const revokeSpy = vi.spyOn(executables, 'revoke');

    const agentRegistry = new AgentRegistry(testAgentRegistryOptions({ executableRegistry: executables }));
    const addUnavailableSpy = vi.spyOn(agentRegistry, 'addUnavailableCustomProfile');

    const service = createTestAgentService({ database: db,
      repository: new AgentRepository(db),
      registry: new WorkingDirectoryRegistry(),
      agentRegistry,
      customProfiles,
      executableRegistry: executables,
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(root),
      chooseExecutable: () => Promise.resolve(process.platform === 'win32' ? process.execPath : posixShell()),
      log: logger,
      isPackaged: false,
    });

    const pendingInit = service.initialize();
    await rehydrateReady;
    await service.shutdown();
    releaseRehydrate();
    await expect(pendingInit).rejects.toThrow(/shutting down/i);
    expect(rehydratedHandle).toBeDefined();
    expect(revokeSpy).toHaveBeenCalledWith(rehydratedHandle);
    expect(addUnavailableSpy).not.toHaveBeenCalled();
    expect(service.listCustomProfiles()[0]?.executable).toBeNull();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('allows an ended consumer review to finish during graceful shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-graceful-review-'));
    const target = join(root, 'workspace');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    const originalReview = manager.getReview.bind(manager);
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    vi.spyOn(manager, 'getReview').mockImplementation(async (sessionId) => {
      enteredResolve();
      await reviewGate;
      return originalReview(sessionId);
    });
    const adapter = new ControlledAdapter();
    const service = createTestAgentService({ database: db,
      repository, registry: new WorkingDirectoryRegistry(), agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'), environmentManager: manager, chooseDirectory: () => Promise.resolve(target),
      log: logger, isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'graceful review' }, 106);
    await entered;
    const shutdown = service.shutdown();
    releaseReview();
    await shutdown;
    expect(service.getSession(started.session.id)?.status).toBe('completed');
    db.close();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it('allows a deferred apply to commit its repository state during graceful shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-shutdown-graceful-apply-'));
    const target = join(root, 'workspace');
    const appRoot = join(root, 'agent-workspaces');
    await mkdir(target, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    const originalApply = manager.apply.bind(manager);
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    vi.spyOn(manager, 'apply').mockImplementation(async (sessionId) => {
      enteredResolve();
      await applyGate;
      return originalApply(sessionId);
    });
    const adapter = new ControlledAdapter();
    const service = createTestAgentService({ database: db,
      repository, registry: new WorkingDirectoryRegistry(), agentRegistry: new ControlledRegistry(adapter),
      contextRoot: join(appRoot, 'context'), environmentManager: manager, chooseDirectory: () => Promise.resolve(target),
      log: logger, isPackaged: false,
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory was not selected');
    const started = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'graceful apply' }, 107);
    await waitForSessionStatus(service, started.session.id, 'completed');
    const pendingApply = service.applyChanges(started.session.id, 107);
    await entered;
    const shutdown = service.shutdown();
    releaseApply();
    await expect(pendingApply).resolves.toBeDefined();
    await shutdown;
    expect(service.getSession(started.session.id)?.environmentState).toBe('applied');
    db.close();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it('safely cancels a starting session when stopSession is called during startup before ActiveRun is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-startup-race-'));
    const targetDir = join(root, 'workspace');
    await mkdir(targetDir, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const registry = new WorkingDirectoryRegistry();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let notifyEnteredStartup!: (sessionId: string) => void;
    const enteredStartup = new Promise<string>((resolve) => { notifyEnteredStartup = resolve; });
    let adapterStartCalls = 0;

    const gateAdapter: AgentAdapter = {
      profile,
      capabilities: { ...profile.capabilities, sessionResume: true },
      detect: () => Promise.resolve(profile.detection),
      start: (request) => {
        adapterStartCalls += 1;
        const sid = request.sessionId ?? 'fallback-id';
        return {
          events: (async function* (): AsyncGenerator<AgentEvent, void, void> {
            await Promise.resolve();
            yield { sessionId: sid, ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
            yield { sessionId: sid, ordinal: 1, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() };
          })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      },
      cancel: () => undefined,
    };
    const service = createTestAgentService({ database: db,
      repository,
      registry,
      agentRegistry: new class extends AgentRegistry {
        override detect() { return Promise.resolve([]); }
        override addFakeAdapter() { return profile; }
        override getAdapter() { return gateAdapter; }
      }(testAgentRegistryOptions()),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(targetDir),
      log: logger,
      isPackaged: false,
      allowFakeAgent: true,
      isGitRepository: () => Promise.resolve(false),
      writeContextPacket: async () => {
        const sessions = repository.listSessions(TEST_CONTEXT_PACKET.document.id);
        notifyEnteredStartup(sessions[0]!.id);
        await startGate;
      },
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (!directory) throw new Error('directory missing');

    const received: AgentEvent[] = [];
    service.subscribe(42, (event) => { received.push(event); });

    const pendingStart = service.startSession({ documentId: TEST_CONTEXT_PACKET.document.id, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'startup race test', contextPacket: TEST_CONTEXT_PACKET }, 42);

    const sessionId = await enteredStartup;

    // Stop while startup is paused writing context packet before adapter start / ActiveRun installation
    await service.stopSession(sessionId, 42);
    releaseStart();

    const result = await pendingStart;
    expect(result.session.status).toBe('cancelled');
    expect(service.getSession(sessionId)?.status).toBe('cancelled');
    expect(received.some((e) => e.type === 'cancelled')).toBe(true);
    expect(adapterStartCalls).toBe(0);

    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('safely cancels a resuming session and stops an ongoing resumed run idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-resume-race-'));
    const targetDir = join(root, 'workspace');
    await mkdir(targetDir, { recursive: true });
    const db = InterleafDatabase.open(':memory:');
    runTestMigrations(db);
    const repository = new AgentRepository(db);
    const registry = new WorkingDirectoryRegistry();
    let cancelCalls = 0;
    let resumeRelease!: () => void;
    const resumeGate = new Promise<void>((resolve) => { resumeRelease = resolve; });

    const resumeAdapter: AgentAdapter = {
      profile: { ...profile, capabilities: { ...profile.capabilities, sessionResume: true } },
      capabilities: { ...profile.capabilities, sessionResume: true },
      detect: () => Promise.resolve(profile.detection),
      start: (request) => {
        const sid = request.sessionId ?? 'fallback-id';
        return {
          events: (async function* (): AsyncGenerator<AgentEvent, void, void> {
            await Promise.resolve();
            yield { sessionId: sid, ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
            yield { sessionId: sid, ordinal: 1, type: 'final', text: 'initial turn done', timestamp: new Date().toISOString() };
            yield { sessionId: sid, ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() };
          })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      },
      resume: (_resumeId, options) => {
        const sid = options.sessionId ?? 'fallback-id';
        return {
          events: (async function* (): AsyncGenerator<AgentEvent, void, void> {
            yield { sessionId: sid, ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
            await resumeGate;
            yield { sessionId: sid, ordinal: 1, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() };
          })(),
          completion: resumeGate,
          cancel: () => { cancelCalls += 1; },
        };
      },
      cancel: () => undefined,
    };

    const service = createTestAgentService({ database: db,
      repository,
      registry,
      agentRegistry: new class extends AgentRegistry {
        override detect() { return Promise.resolve([]); }
        override addFakeAdapter() { return resumeAdapter.profile; }
        override getAdapter() { return resumeAdapter; }
      }(testAgentRegistryOptions()),
      contextRoot: join(root, 'context'),
      chooseDirectory: () => Promise.resolve(targetDir),
      log: logger,
      isPackaged: false,
      allowFakeAgent: true,
      isGitRepository: () => Promise.resolve(false),
    });
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (!directory) throw new Error('directory missing');

    const initial = await service.startSession({ documentId: TEST_DOCUMENT_ID, profileId: 'fake', workingDirectoryHandle: directory.handle, prompt: 'initial turn' }, 55);
    await waitForSessionStatus(service, initial.session.id, 'completed');

    // Start resume
    const resumed = await service.resumeSession({
      sessionId: initial.session.id,
      prompt: 'resumed follow-up',
    }, 55);
    expect(resumed.session.status).toBe('running');

    // Stop ongoing resumed run - first call
    await service.stopSession(initial.session.id, 55);
    expect(cancelCalls).toBe(1);
    expect(service.getSession(initial.session.id)?.status).toBe('cancelled');

    // Idempotent second stop call
    await expect(service.stopSession(initial.session.id, 55)).resolves.toBeUndefined();
    resumeRelease();

    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
});
