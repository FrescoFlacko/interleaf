import { testSessionAuthority, testTargetIdentity } from '../helpers/agent-session-records';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentService } from '@main/agents/agent-service';
import { AgentRegistry, CliAgentAdapter } from '@main/agents/agent-adapter';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { cleanupStalePromptFiles } from '@main/agents/custom-prompt-storage';
import type { Logger } from '@main/logging/logger';
import { ProcessRunner, type ProcessRunnerEvent, type ProcessRunnerRequest } from '@main/agents/process-runner';
import type { AgentEvent } from '@shared/types/agent';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Waits for a session to reach a status instead of sleeping a fixed interval:
 * on a loaded machine the consumer has not finished by the time a fixed sleep
 * expires, and these tests are about the status a run leaves behind rather than
 * how quickly it gets there.
 */
async function waitForSessionStatus(service: AgentService, sessionId: string, expected: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (service.getSession(sessionId)?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session ${sessionId} did not reach ${expected}.`);
}

const CAPABILITIES = {
  structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
  modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
  subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
};

function detection(binaryPath: string) {
  return { availability: 'installed' as const, binaryPath, version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null };
}

/** A Codex adapter over a runner that records the last request instead of spawning. */
function recordingCodexAdapter(profile: { defaultArgs: string[]; defaultModel: string | null; reasoningSelection: boolean }) {
  let executed: ProcessRunnerRequest | undefined;
  const adapter = new CliAgentAdapter(
    {
      id: 'codex', providerId: 'codex', name: 'Codex', binaryPath: '/usr/local/bin/codex',
      defaultArgs: profile.defaultArgs, defaultModel: profile.defaultModel, reasoningEffort: null,
      permissionMode: 'normal', defaultSandboxMode: 'auto-isolated',
      capabilities: { ...CAPABILITIES, reasoningSelection: profile.reasoningSelection },
      detection: detection('/usr/local/bin/codex'),
      isCustom: false, unsafe: false,
    },
    {
      run: (options: ProcessRunnerRequest) => {
        executed = options;
        return {
          runId: 'fixture-run',
          events: (async function* () { await Promise.resolve(); })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      },
    },
    ...adapterCollaborators(),
  );
  return { adapter, executed: () => executed };
}

/** A temp workspace plus an in-memory database seeded with the fixture document. */
async function setupFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, 'workspace');
  const appRoot = join(root, 'agent-workspaces');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'test.txt'), 'hello');
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-rehydrate', 'Doc Rehydrate', 'pdf', '/tmp/rehydrate.pdf', 'managed', 100, 100, 'hash-rehydrate')
  `).run();
  const createService = (repository: AgentRepository, agentRegistry: AgentRegistry = new AgentRegistry(testAgentRegistryOptions())) => createTestAgentService({
    database: db,
    repository,
    registry: new WorkingDirectoryRegistry(),
    agentRegistry,
    contextRoot: join(appRoot, 'context'),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })),
    chooseDirectory: () => Promise.resolve(target),
    log: logger,
    isPackaged: false,
  });
  const cleanup = async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  };
  return { target, db, createService, cleanup };
}

describe('Codex resume argv, startup rehydration, and prompt path redaction', () => {
  it('constructs correct tokenized argv for Codex exec resume with model and reasoning', () => {
    // Item O correction: no verified Codex effort key, so the profile
    // carries none and the resume argv cannot contain one.
    const { adapter, executed } = recordingCodexAdapter({ defaultArgs: [], defaultModel: 'o3-mini', reasoningSelection: false });

    adapter.resume('provider-thread-12345', {
      sessionId: 'sess-abc',
      prompt: 'follow-up prompt on stdin',
      canonicalWorkingDirectory: '/tmp/workspace',
      model: 'o3-mini',
    });

    expect(executed()?.file).toBe('/usr/local/bin/codex');
    expect(executed()?.args).toEqual([
      'exec',
      'resume',
      '--json',
      '--model',
      'o3-mini',
      'provider-thread-12345',
      '-',
    ]);
    expect(executed()?.stdin).toBe('follow-up prompt on stdin');
  });

  it.each([
    ['isolated-copy', 'untrusted', true],
    ['isolated-worktree', 'trusted', false],
    ['active-env Git target', 'trusted', false],
    ['active-env non-Git target', 'untrusted', true],
  ] as const)('constructs fresh-start argv for %s from the main-owned repository decision', (_label, codexRepositoryTrust, shouldSkip) => {
    const { adapter, executed } = recordingCodexAdapter({ defaultArgs: ['exec', '--json', '--sandbox', 'workspace-write'], defaultModel: null, reasoningSelection: true });
    adapter.start({
      documentId: 'doc-rehydrate',
      profileId: 'codex', workingDirectoryHandle: 'handle', executionMode: _label === 'isolated-copy' ? 'isolated-copy' : _label === 'isolated-worktree' ? 'isolated-worktree' : 'active-env',
      prompt: 'fresh prompt', canonicalWorkingDirectory: '/tmp/prepared', codexRepositoryTrust,
      model: null,
      contextPacket: null,
      riskConfirmation: null,
    });
    expect(executed()?.args).toEqual([
      'exec', '--json', '--sandbox', 'workspace-write',
      ...(shouldSkip ? ['--skip-git-repo-check'] : []),
      '-',
    ]);
  });

  it.each([
    ['isolated-copy', 'untrusted', true],
    ['isolated-worktree', 'trusted', false],
    ['direct Git target', 'trusted', false],
    ['direct non-Git target', 'untrusted', true],
  ] as const)('constructs resume argv for %s from the persisted main-owned repository decision', (_label, codexRepositoryTrust, shouldSkip) => {
    const { adapter, executed } = recordingCodexAdapter({ defaultArgs: [], defaultModel: null, reasoningSelection: true });
    adapter.resume('provider-thread', {
      sessionId: 'session', prompt: 'resume prompt', canonicalWorkingDirectory: '/tmp/prepared',
      codexRepositoryTrust,
    });
    expect(executed()?.args).toEqual([
      'exec', 'resume', '--json',
      ...(shouldSkip ? ['--skip-git-repo-check'] : []),
      'provider-thread', '-',
    ]);
  });

  it('safely rehydrates unclosed sessions on startup as interrupted and fails closed if environment was discarded', async () => {
    const { target, db, createService, cleanup } = await setupFixture('interleaf-rehydrate-test-');
    // Insert directory and profile
    db.raw.prepare(`
      INSERT INTO allowed_working_directories (handle, canonical_path, display_name, identity_json)
      VALUES ('dir-1', ?, 'Workspace', '{"device":1,"inode":1,"birthtimeNs":"1"}')
    `).run(target);

    db.raw.prepare(`
      INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, default_sandbox_mode)
      VALUES ('codex', 'Codex', 'codex', '[]', 'normal', 'auto-isolated')
    `).run();

    // Insert an unclosed session in DB
    const initialRepo = new AgentRepository(db);
    const session = initialRepo.createSession({
      documentId: 'doc-rehydrate',
      profileId: 'codex',
      providerId: 'codex',
      targetDirectory: { handle: 'dir-1', displayName: 'Workspace' },
      canonicalTargetPath: target,
      sandboxMode: 'isolated-copy',
      userPrompt: 'crash before finish',
      baselineFingerprint: 'fp-1', targetIdentity: testTargetIdentity(), authority: testSessionAuthority(),
    });

    initialRepo.updateSession(session.id, {
      status: 'running',
      providerSessionId: 'provider-thread-123',
    });

    // Create a new AgentRepository as happens on app startup. Codex is stated
    // as installed so the resume reaches the environment check this test is
    // about, rather than depending on a real `codex` on the host's PATH.
    const { adapter: codex } = recordingCodexAdapter({ defaultArgs: [], defaultModel: null, reasoningSelection: true });
    class InstalledCodexRegistry extends AgentRegistry {
      override detect() { return Promise.resolve([codex.profile]); }
      override getAdapter(id: string) { return id === 'codex' ? codex : undefined; }
    }
    const startupRepo = new AgentRepository(db);
    const service = createService(startupRepo, new InstalledCodexRegistry(testAgentRegistryOptions()));

    await service.initialize();

    // Startup rehydration must transition running -> interrupted
    const loaded = service.getSession(session.id);
    expect(loaded?.status).toBe('interrupted');

    // Register directory for test resume
    const dir = await service.selectWorkingDirectory();
    if (dir === null) throw new Error('Directory not selected');

    // Main's factory creates the window this launch binds recovery to, and
    // the reopened window claims the rehydrated session explicitly (item C);
    // ownership is what the resume then fails closed on the environment for.
    service.adoptMainWindow(1);
    await service.claimSession(session.id, 1);

    // Resuming an interrupted session whose isolated workspace is gone must fail closed
    await expect(service.resumeSession({ sessionId: session.id, prompt: 'resume after crash' }, 1)).rejects.toThrow(/environment is no longer available/i);

    await service.shutdown();
    await cleanup();
  });

  it('redacts temp custom prompt file paths in child process output and logs cleanup errors without paths (P2 review fix)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-prompt-cleanup-'));
    const testLog = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    // 1. Stale prompt file cleanup runs safely and cleans files matching pattern older than maxAgeMs
    const promptDir = join(root, 'custom-prompts');
    await mkdir(promptDir, { recursive: true });
    const staleFile = join(promptDir, `${randomUUID()}.prompt`);
    await writeFile(staleFile, 'secret prompt content');

    const removed = cleanupStalePromptFiles(promptDir, testLog, Date.now() + 1_000, 0);
    expect(removed).toBe(1);

    // 2. Injected unlink error logs redacted warning without exposing canonical path
    const secondFile = join(promptDir, `${randomUUID()}.prompt`);
    await writeFile(secondFile, 'another secret prompt');

    const failedCount = cleanupStalePromptFiles(
      promptDir,
      testLog,
      Date.now() + 1_000,
      0,
      (filePath) => {
        throw new Error(`EACCES: permission denied on ${filePath}`);
      },
    );
    expect(failedCount).toBe(0);
    expect(testLog.warn).toHaveBeenCalledTimes(1);
    const loggedWarning = testLog.warn.mock.calls[0]?.[0];
    expect(typeof loggedWarning).toBe('string');
    expect(loggedWarning).toContain('stale prompt file cleanup failed');
    // The canonical path must NOT be in the log warning message!
    expect(loggedWarning).not.toContain(secondFile);
    expect(loggedWarning).not.toContain(promptDir);

    // 3. Child process stdout echoing canonical prompt path is redacted by ProcessLauncher
    const runner = new ProcessRunner();
    const canonicalPromptPath = join(promptDir, 'test-secret.prompt');
    const echoScript = join(root, 'echo-script.sh');
    await writeFile(echoScript, `#!/bin/sh\necho "reading prompt from ${canonicalPromptPath} done"\n`, { mode: 0o755 });

    const runnerHandle = runner.run({
      file: '/bin/sh',
      args: [echoScript],
      cwd: root,
      redactValues: [canonicalPromptPath],
    });

    const receivedEvents: ProcessRunnerEvent[] = [];
    for await (const event of runnerHandle.events) {
      receivedEvents.push(event);
    }
    await runnerHandle.completion;
    const stdouts = receivedEvents.filter((e): e is Extract<ProcessRunnerEvent, { text: string }> => e.type === 'stdout');
    expect(stdouts.length).toBeGreaterThan(0);
    for (const event of stdouts) {
      expect(event.text).not.toContain(canonicalPromptPath);
      expect(event.text).toContain('[REDACTED]');
    }

    await rm(root, { recursive: true, force: true });
  });

  it('preserves the prior completed session when resume startup fails before a live handle', async () => {
    const { db, createService, cleanup } = await setupFixture('interleaf-resume-fail-');
    const repo = new AgentRepository(db);

    const failingAdapter = {
      profile: {
        id: 'failing-agent',
        providerId: 'codex' as const,
        name: 'Failing Agent',
        binaryPath: 'codex',
        defaultArgs: [],
        defaultModel: 'o3-mini',
        reasoningEffort: 'high' as const,
        permissionMode: 'normal' as const,
        defaultSandboxMode: 'auto-isolated' as const,
        capabilities: CAPABILITIES,
        detection: detection('codex'),
        isCustom: false,
        unsafe: false,
      },
      capabilities: CAPABILITIES,
      detect: () => Promise.resolve(failingAdapter.profile.detection),
      start: () => ({
        events: (async function* () {
          await Promise.resolve();
          yield { sessionId: '', ordinal: 0, type: 'started' as const, timestamp: new Date().toISOString() };
          yield {
            sessionId: '',
            ordinal: 0,
            type: 'structured' as const,
            data: { type: 'thread.started', thread_id: 'provider-thread-fail-123' },
            timestamp: new Date().toISOString(),
          };
          yield { sessionId: '', ordinal: 0, type: 'final' as const, text: 'initial report', timestamp: new Date().toISOString() };
          yield { sessionId: '', ordinal: 0, type: 'ended' as const, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      }),
      resume: () => {
        throw new Error('Immediate resume spawn failure');
      },
      cancel: () => undefined,
    };

    class FailingRegistry extends AgentRegistry {
      override detect() { return Promise.resolve([failingAdapter.profile]); }
      override getAdapter(id: string) { return id === 'failing-agent' ? failingAdapter : undefined; }
    }

    const emittedEvents: AgentEvent[] = [];
    const service = createService(repo, new FailingRegistry(testAgentRegistryOptions()));
    await service.initialize();

    const unsub = service.subscribe(1, (event) => {
      emittedEvents.push(event);
    });

    const dir = await service.selectWorkingDirectory();
    if (dir === null) throw new Error('Directory not selected');

    const started = await service.startSession({
      documentId: 'doc-rehydrate',
      profileId: 'failing-agent',
      workingDirectoryHandle: dir.handle,
      executionMode: 'auto-isolated',
      prompt: 'initial step',
    }, 1);

    await waitForSessionStatus(service, started.session.id, 'completed');
    expect(service.getSession(started.session.id)?.status).toBe('completed');

    const sessionBeforeResume = service.getSession(started.session.id);
    if (sessionBeforeResume === null) throw new Error('Session was not persisted');
    const eventsBeforeResume = sessionBeforeResume.events.length;

    // Resume fails immediately at adapter.resume()
    await expect(service.resumeSession({
      sessionId: started.session.id,
      prompt: 'will fail immediately',
    }, 1)).rejects.toThrow(/Immediate resume spawn failure/i);

    // The adapter threw before returning a run handle, so no attempt ever
    // became live. The completed run keeps its exact terminal status and final
    // report, and gains neither a `running` transition nor an error event that
    // would misattribute this rejection to it.
    const sessionAfterFail = service.getSession(started.session.id);
    if (sessionAfterFail === null) throw new Error('Session disappeared');
    expect(sessionAfterFail.status).toBe('completed');
    expect(sessionAfterFail.finalReport).toBe(sessionBeforeResume.finalReport);

    const events = sessionAfterFail.events;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toHaveLength(eventsBeforeResume);

    // Ordinals must be strictly monotonic
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.ordinal).toBe((events[i - 1]?.ordinal ?? 0) + 1);
    }

    expect(emittedEvents.some((e) => e.type === 'error')).toBe(false);

    unsub();
    await service.shutdown();
    await cleanup();
  });
});
