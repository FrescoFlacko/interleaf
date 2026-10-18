import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry, mapProcessEvents, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { translatePiProcessEvents } from '@main/agents/pi-stream';
import type { ProcessRunnerEvent } from '@main/agents/process-runner';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { Logger } from '@main/logging/logger';
import type { PortableRecord } from '@shared/models/portable';
import { createTestAgentService } from '../helpers/agent-service';
import { withEnvironmentShell, testAgentRegistryOptions } from '../helpers/agent-collaborators';

/**
 * What a Pi run is recorded as, end to end.
 *
 * Pi's `--print --mode json` exits 0 whatever the turn did — its print mode
 * inspects the assistant `stopReason` only in text mode — so the persisted
 * status rests entirely on whether main understood the assistant message.
 * Untranslated, an errored turn was stored as `completed`, which is how a run
 * that never did the work could offer its workspace for review as a success.
 *
 * These tests drive the exact stream composition `CliAgentAdapter.start` builds
 * for Pi over scripted runner frames, through the real `AgentService`
 * consumer, and assert the row the database ends up holding. No process is
 * spawned and no model is invoked.
 */

const STAMP = 1730000000000;
const ANSWER = 'Renamed the helper and updated its callers.';

function assistantMessage(stopReason: string, extra: PortableRecord = {}): PortableRecord {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The helper is only referenced twice.' },
      { type: 'text', text: ANSWER },
    ],
    model: 'fixture-model',
    stopReason,
    timestamp: STAMP,
    ...extra,
  };
}

/** The frames one Pi turn emits, in the order Pi 0.84.4 documents. */
function piFrames(message: PortableRecord): readonly ProcessRunnerEvent[] {
  const timestamp = new Date(STAMP).toISOString();
  const frame = (data: PortableRecord): ProcessRunnerEvent =>
    ({ type: 'structured', runId: 'pi-run', data, timestamp, structuredKind: 'structured' });
  return [
    { type: 'started', runId: 'pi-run', timestamp },
    frame({ type: 'agent_start' }),
    frame({ type: 'turn_start' }),
    frame({ type: 'message_end', message }),
    frame({ type: 'turn_end', message, toolResults: [] }),
    frame({ type: 'agent_end', messages: [message] }),
    // Pi's JSON mode exits 0 here whatever `stopReason` says.
    { type: 'ended', runId: 'pi-run', exitCode: 0, signal: null, timestamp },
  ];
}

const piProfile: MainAgentProfile = {
  id: 'fake',
  name: 'Pi (stream fixture)',
  providerId: 'fake',
  binaryPath: '/fake/bin/pi',
  defaultArgs: [],
  defaultModel: 'fixture-model',
  reasoningEffort: null,
  permissionMode: 'normal',
  defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true,
    sessionResume: false,
    nativeSandbox: false,
    workingDirectory: true,
    modelSelection: true,
    reasoningSelection: true,
    fileChangeEvents: false,
    toolEvents: true,
    subagents: false,
    interactiveAuthentication: false,
    nonInteractiveMode: true,
  },
  detection: {
    availability: 'installed',
    binaryPath: '/fake/bin/pi',
    version: '0.84.4',
    checkedAt: new Date().toISOString(),
    errorMessage: null,
  },
  isCustom: false,
  unsafe: false,
};

class PiStreamAdapter implements AgentAdapter {
  readonly profile = piProfile;
  readonly capabilities = piProfile.capabilities;
  constructor(private readonly frames: readonly ProcessRunnerEvent[]) {}

  detect() { return Promise.resolve(this.profile.detection); }

  start(): AgentAdapterRun {
    const frames = this.frames;
    const source = (async function* (): AsyncGenerator<ProcessRunnerEvent> {
      await Promise.resolve();
      for (const frame of frames) yield frame;
    })();
    return {
      // Exactly the composition `CliAgentAdapter.start` applies for Pi.
      events: mapProcessEvents(translatePiProcessEvents(source)),
      completion: Promise.resolve(),
      cancel: () => undefined,
    };
  }

  cancel() { /* the scripted stream ends on its own */ }
}

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const roots: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type Outcome = { readonly status: string; readonly finalReport: string | null };

async function runPiSession(frames: readonly ProcessRunnerEvent[]): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'ml-pi-outcome-'));
  roots.push(root);
  const workDir = join(root, 'workspace');
  await mkdir(workDir, { recursive: true });

  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents
      (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('test-doc-id', 'Test document', 'pdf', '/tmp/test-doc.pdf', 'managed', 1, 1, 'test-doc-hash')
  `).run();
  const repository = new AgentRepository(db);

  const adapter = new PiStreamAdapter(frames);
  class PiScriptedRegistry extends AgentRegistry {
    override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([piProfile]); }
    override addFakeAdapter(): MainAgentProfile { return piProfile; }
    override getAdapter(id: string): AgentAdapter | undefined { return id === 'fake' ? adapter : undefined; }
  }

  const dirRegistry = new WorkingDirectoryRegistry();
  const selection = await dirRegistry.register(workDir);
  const service = createTestAgentService({ database: db,
    repository,
    registry: dirRegistry,
    agentRegistry: new PiScriptedRegistry(testAgentRegistryOptions()),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(workDir),
    isPackaged: false,
    log: silentLog,
    isGitRepository: () => Promise.resolve(false),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'env') })),
  });

  try {
    await service.initialize();
    const started = await service.startSession({
      documentId: 'test-doc-id',
      profileId: 'fake',
      workingDirectoryHandle: selection.handle,
      prompt: 'rename the helper',
      executionMode: 'isolated-copy',
    }, 1);

    // Wait for the consumer's own terminal write rather than for shutdown's,
    // so the status under test is the one the run produced.
    let persisted = repository.getSession(started.session.id);
    for (let attempt = 0; attempt < 100 && (persisted === null || persisted.status === 'running'); attempt += 1) {
      await delay(20);
      persisted = repository.getSession(started.session.id);
    }
    return { status: persisted?.status ?? 'missing', finalReport: persisted?.finalReport ?? null };
  } finally {
    await service.shutdown();
    db.close();
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Pi session outcomes', () => {
  it('records a successful turn as completed, with its authoritative answer as the report', async () => {
    const outcome = await runPiSession(piFrames(assistantMessage('stop')));
    expect(outcome.status).toBe('completed');
    // The reply, not the thinking that preceded it.
    expect(outcome.finalReport).toBe(ANSWER);
  }, 30_000);

  it('records an errored turn as failed despite the exit code of 0', async () => {
    const outcome = await runPiSession(piFrames(assistantMessage('error', {
      errorMessage: 'Provider request failed: 402 insufficient credits',
    })));
    expect(outcome.status).toBe('failed');
    // Nothing may present a failed run as having answered.
    expect(outcome.finalReport).toBeNull();
  }, 30_000);

  it('records an aborted turn as cancelled rather than completed', async () => {
    const outcome = await runPiSession(piFrames(assistantMessage('aborted')));
    expect(outcome.status).toBe('cancelled');
    expect(outcome.finalReport).toBeNull();
  }, 30_000);
});
