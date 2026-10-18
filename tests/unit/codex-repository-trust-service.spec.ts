import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafError } from '@shared/errors/interleaf-error';
import { invokeChannel } from '@main/ipc/dispatcher';
import { IPC } from '@shared/constants/ipc';
import { createSenderRule } from '@main/ipc/sender-validation';
import type { AgentService, AgentServiceOptions } from '@main/agents/agent-service';
import { AgentRegistry, CliAgentAdapter } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { ProcessRunner, type ProcessRunnerEvent } from '@main/agents/process-runner';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { silentLogger as logger } from '../helpers/silent-logger';
import type { AgentContextPacket } from '@shared/types/agent';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';
import { eventError } from '../helpers/agent-event';

const codexProfile: MainAgentProfile = {
  id: 'codex', providerId: 'codex', name: 'Codex', binaryPath: '/usr/local/bin/codex',
  defaultArgs: ['exec', '--json', '--sandbox', 'workspace-write'], defaultModel: null, reasoningEffort: null,
  permissionMode: 'workspace-write', defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', binaryPath: '/usr/local/bin/codex', version: 'fixture', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};
const TEST_CONTEXT_PACKET: AgentContextPacket = {
  version: 1,
  document: { id: 'context-doc', hash: 'hash', title: 'Context test', author: null },
  selection: {
    exactQuote: 'selected text',
    anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'selected text', prefix: '', suffix: '' } },
    location: { format: 'pdf', pageIndex: 0 },
    surroundingText: null,
  },
  provenance: { source: 'interleaf-reader-selection', capturedAt: new Date().toISOString(), contentIsUntrustedReference: true, truncated: false },
};
class CapturingCodexRegistry extends AgentRegistry {
  constructor(adapter: CliAgentAdapter) { super(testAgentRegistryOptions()); this.adapter = adapter; }
  private readonly adapter: CliAgentAdapter;
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([this.adapter.profile]); }
  override getAdapter(profileId: string) { return profileId === 'codex' ? this.adapter : undefined; }
}

async function waitForStatus(service: AgentService, sessionId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.getSession(sessionId)?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session ${sessionId} did not reach ${expected}.`);
}

function initGitRepository(target: string): void {
  execFileSync('git', ['init', '--quiet', target], { stdio: 'ignore' });
  execFileSync('git', ['-C', target, 'config', 'user.email', 'interleaf@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', target, 'config', 'user.name', 'Interleaf Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', target, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', target, 'commit', '--quiet', '-m', 'fixture'], { stdio: 'ignore' });
}

/**
 * Runs `body` against an initialized AgentService whose only agent is a Codex
 * adapter over `runner`, with a selected temp target and one seeded document.
 */
async function withCodexService(
  options: {
    readonly prefix: string;
    readonly runner: ConstructorParameters<typeof CliAgentAdapter>[1];
    readonly profile?: MainAgentProfile;
    readonly documentId?: string;
    readonly prepareTarget?: (target: string) => Promise<void>;
    readonly service?: Partial<Pick<AgentServiceOptions, 'confirmDirectWorkspace' | 'writeContextPacket'>>;
  },
  body: (context: { service: AgentService; repository: AgentRepository; directoryHandle: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  const target = join(root, 'target');
  await mkdir(target, { recursive: true });
  await options.prepareTarget?.(target);
  const documentId = options.documentId ?? 'doc-trust';
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES (?, 'Doc Trust', 'pdf', '/tmp/trust.pdf', 'managed', 100, 100, 'hash-trust')
  `).run(documentId);
  const repository = new AgentRepository(db);
  const service = createTestAgentService({
    database: db,
    repository,
    registry: new WorkingDirectoryRegistry(),
    agentRegistry: new CapturingCodexRegistry(new CliAgentAdapter(options.profile ?? codexProfile, options.runner, ...adapterCollaborators())),
    contextRoot: join(root, 'context'),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'environments') })),
    chooseDirectory: () => Promise.resolve(target),
    log: logger,
    isPackaged: false,
    ...options.service,
  });
  try {
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('directory selection failed');
    await body({ service, repository, directoryHandle: directory.handle });
  } finally {
    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('Codex repository-check decision at the AgentService boundary', () => {
  it.each([
    ['isolated-copy', true],
    ['isolated-worktree', false],
    ['active-env Git target', false],
    ['active-env non-Git target', true],
  ] as const)('passes the main-owned decision to fresh start and persisted resume for %s', async (label, shouldSkip) => {
    const captured: string[][] = [];
    const processRunner = ({
      run: (request: { readonly args: readonly string[] }) => {
        captured.push([...request.args]);
        const runId = `run-${String(captured.length)}`;
        const timestamp = new Date().toISOString();
        const events: ProcessRunnerEvent[] = [
          { type: 'started', runId, timestamp },
          { type: 'structured', runId, timestamp, data: { type: 'thread.started', thread_id: 'fixture-thread' }, structuredKind: 'structured' },
          { type: 'structured', runId, timestamp, data: { type: 'final', text: 'fixture final' }, structuredKind: 'final', structuredFinalText: 'fixture final' },
          { type: 'ended', runId, timestamp, exitCode: 0, signal: null },
        ];
        return {
          runId,
          events: (async function* () { await Promise.resolve(); yield* events; })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      },
    });
    const prepareTarget = async (target: string) => {
      await writeFile(join(target, 'fixture.txt'), 'fixture\n');
      if (label !== 'active-env non-Git target') initGitRepository(target);
    };

    await withCodexService({
      prefix: 'interleaf-codex-trust-', runner: processRunner, prepareTarget,
      service: { confirmDirectWorkspace: () => Promise.resolve(true) },
    }, async ({ service, directoryHandle }) => {
      const mode = label === 'isolated-copy' ? 'isolated-copy' : label === 'isolated-worktree' ? 'isolated-worktree' : 'active-env';
      let grantId: string | undefined;
      if (mode === 'active-env') {
        const grant = await service.issueRiskGrant({
          draftId: `draft-${label}`, profileId: 'codex', workingDirectoryHandle: directoryHandle,
          executionMode: 'active-env', prompt: 'fixture prompt', model: null, contextPacket: null,
        }, 7);
        grantId = grant.grantId;
      }
      const started = await service.startSession({
        documentId: 'doc-trust',
        profileId: 'codex', workingDirectoryHandle: directoryHandle, executionMode: mode,
        prompt: 'fixture prompt', riskConfirmation: grantId === undefined ? null : { grantId, draftId: `draft-${label}` },
      }, 7);
      await waitForStatus(service, started.session.id, 'completed');
      expect(captured[0]).toEqual(['exec', '--json', '--sandbox', 'workspace-write', ...(shouldSkip ? ['--skip-git-repo-check'] : []), '-']);

      const resumed = await service.resumeSession({ sessionId: started.session.id, prompt: 'fixture resume' }, 7);
      await waitForStatus(service, resumed.session.id, 'completed');
      expect(captured[1]).toEqual(['exec', 'resume', '--json', ...(shouldSkip ? ['--skip-git-repo-check'] : []), 'fixture-thread', '-']);

      await service.discardSandbox(started.session.id, 7);
    });
  });

  it('records typed InterleafError cause in session events and preserves error payload across IPC on startup failure', async () => {
    const failingRunner = ({
      run: () => {
        throw new InterleafError('mode-resolution-failed', 'Simulated synchronous startup failure');
      },
    });
    await withCodexService({
      prefix: 'interleaf-codex-fail-', runner: failingRunner,
      prepareTarget: (target) => writeFile(join(target, 'fixture.txt'), 'fixture\n'),
    }, async ({ service, repository, directoryHandle }) => {
      const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html', devUrl: 'http://localhost:5173' });
      const event = {
        senderFrame: { url: 'http://localhost:5173' },
        sender: {
          id: 42,
          send: () => undefined,
          isDestroyed: () => false,
          once: () => undefined,
          removeListener: () => undefined,
        },
      };

      const envelope = await invokeChannel(
        IPC.agentStartSession,
        (req, ev) => {
          const ownerId = ev.sender?.id ?? 42;
          return service.startSession(req, ownerId);
        },
        {
          documentId: 'doc-trust',
          profileId: 'codex',
          workingDirectoryHandle: directoryHandle,
          executionMode: 'isolated-copy',
          prompt: 'test prompt',
        },
        event,
        { senderRule, log: logger }
      );

      const typedError = {
        __interleafError: true,
        code: 'mode-resolution-failed',
        message: 'Simulated synchronous startup failure',
      };
      expect(envelope).toEqual({ ok: false, error: typedError });

      const sessions = repository.listSessions('doc-trust');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('failed');

      const events = repository.listEvents(sessions[0]!.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('error');
      expect(eventError(events[0])).toEqual(typedError);
    });
  });

  it('spawns real ProcessLauncher with Node fixture for Codex profile against empty non-Git target in isolated-copy mode', async () => {
    // The target stays an intentionally empty directory - non-Git, no files.
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'fake-agent-cli.mjs');
    const codexSpawningProfile: MainAgentProfile = {
      ...codexProfile,
      binaryPath: process.execPath,
      defaultArgs: [fixturePath],
      detection: { ...codexProfile.detection, binaryPath: process.execPath, version: 'fake-node-codex' },
    };

    await withCodexService({
      prefix: 'interleaf-codex-real-runner-', runner: new ProcessRunner(), profile: codexSpawningProfile,
    }, async ({ service, repository, directoryHandle }) => {
      const started = await service.startSession({
        documentId: 'doc-trust',
        profileId: 'codex',
        workingDirectoryHandle: directoryHandle,
        executionMode: 'isolated-copy',
        prompt: 'test prompt for real process runner',
      }, 7);

      await waitForStatus(service, started.session.id, 'completed');

      const session = repository.getSession(started.session.id);
      expect(session?.status).toBe('completed');
      expect(session?.executionMode).toBe('isolated-copy');

      const events = repository.listEvents(started.session.id);
      expect(events.some((e) => e.type === 'started')).toBe(true);
      expect(events.some((e) => e.type === 'ended' && e.exitCode === 0)).toBe(true);

      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const allStdout = stdoutEvents.map((e) => e.text).join('\n');
      expect(allStdout).toContain('--skip-git-repo-check');
    });
  });

  it('cleans environment and records typed error cause when context packet persistence fails during startup', async () => {
    const mockRunner = ({
      run: () => ({
        runId: 'mock-run',
        events: (async function* () { await Promise.resolve(); yield* []; })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      }),
    });
    await withCodexService({
      prefix: 'interleaf-codex-ctx-fail-', runner: mockRunner, documentId: 'context-doc',
      service: { writeContextPacket: () => Promise.reject(new InterleafError('internal', 'Context packet disk failure')) },
    }, async ({ service, repository, directoryHandle }) => {
      await expect(service.startSession({
        documentId: 'context-doc',
        profileId: 'codex',
        workingDirectoryHandle: directoryHandle,
        executionMode: 'isolated-copy',
        prompt: 'test prompt with context packet',
        contextPacket: TEST_CONTEXT_PACKET,
      }, 7)).rejects.toThrow('Context packet disk failure');

      const sessions = repository.listSessions('context-doc');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('failed');
      expect(sessions[0]?.environmentState).toBe('discarded');
      expect(sessions[0]?.environment).toBeNull();

      const events = repository.listEvents(sessions[0]!.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('error');
      expect(eventError(events[0])).toEqual({
        __interleafError: true,
        code: 'internal',
        message: 'Agent startup failed.',
      });
      expect(JSON.stringify(events)).not.toContain('Context packet disk failure');
    });
  });
});
