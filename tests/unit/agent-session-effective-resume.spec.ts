import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { CliAgentAdapter } from '@main/agents/agent-adapter';
import { expandCustomArgvTemplate } from '@main/agents/custom-argv-template';
import { TestAgentRegistry } from '../helpers/agent-registry';
import type { Logger } from '@main/logging/logger';
import type { ProcessRunnerRequest } from '@main/agents/process-runner';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { AgentService } from '@main/agents/agent-service';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, withEnvironmentShell, testAgentRegistryOptions } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const CAPABILITIES = {
  structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
  modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
  subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
};

const DETECTION = { availability: 'installed' as const, binaryPath: '/usr/local/bin/codex', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null };

function codexProfile(defaultModel: string, configuredModels: string[]) {
  return {
    id: 'codex',
    providerId: 'codex' as const,
    name: 'Codex',
    binaryPath: '/usr/local/bin/codex',
    defaultArgs: ['exec', '--json'],
    defaultModel,
    // Main only accepts a per-run model that this profile resolves to.
    configuredModels,
    // Item O correction: Codex has no verified reasoning-effort contract, so
    // a profile that selects one is refused before any spawn (proved in
    // agent-provider-contracts.spec.ts). What these tests fix is the *model*
    // snapshot, which must survive edits and restarts either way.
    reasoningEffort: null,
    permissionMode: 'normal' as const,
    defaultSandboxMode: 'auto-isolated' as const,
    capabilities: CAPABILITIES,
    detection: DETECTION,
    isCustom: false,
    unsafe: false,
  };
}

/** A runner that records resume argv and replays a completed Codex thread for every run. */
function scriptedCodexRunner(threadId: string, finalText: string) {
  let resumeArgs: readonly string[] = [];
  const runner = {
    run: (options: ProcessRunnerRequest) => {
      if (options.args.includes('resume')) resumeArgs = options.args;
      return {
        runId: 'fixture-run',
        events: (async function* () {
          await Promise.resolve();
          yield { runId: 'fixture-run', type: 'started' as const, timestamp: new Date().toISOString() };
          yield {
            runId: 'fixture-run',
            type: 'structured' as const,
            data: { type: 'thread.started', thread_id: threadId },
            timestamp: new Date().toISOString(),
          };
          yield { runId: 'fixture-run', type: 'structured' as const, data: { text: finalText }, structuredKind: 'final' as const, structuredFinalText: finalText, timestamp: new Date().toISOString() };
          yield { runId: 'fixture-run', type: 'ended' as const, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      };
    },
  };
  return { runner, resumeArgs: () => resumeArgs };
}

async function setupFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, 'workspace');
  await mkdir(target, { recursive: true });
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-resume', 'Doc Resume', 'pdf', '/tmp/resume.pdf', 'managed', 100, 100, 'hash-resume')
  `).run();
  const createService = (
    repository: AgentRepository,
    profile: MainAgentProfile,
    runner: ReturnType<typeof scriptedCodexRunner>['runner'],
  ) => {
    class TestCodexRegistry extends TestAgentRegistry {
      override detect(): Promise<readonly MainAgentProfile[]> {
        return Promise.resolve([profile]);
      }
    }
    const agentRegistry = new TestCodexRegistry(testAgentRegistryOptions());
    agentRegistry.installAdapter(new CliAgentAdapter(profile, runner, ...adapterCollaborators()));
    return createTestAgentService({ database: db,
      repository,
      registry: new WorkingDirectoryRegistry(),
      agentRegistry,
      contextRoot: join(root, 'context'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
      chooseDirectory: () => Promise.resolve(target),
      log: logger,
      isPackaged: false,
    });
  };
  const cleanup = async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  };
  return { db, createService, cleanup };
}

async function startCompleted(service: AgentService, prompt: string, model: string) {
  const dir = await service.selectWorkingDirectory();
  if (dir === null) throw new Error('Directory selection failed');
  const started = await service.startSession({
    documentId: 'doc-resume',
    profileId: 'codex',
    workingDirectoryHandle: dir.handle,
    executionMode: 'auto-isolated',
    prompt,
    model,
  }, 1);
  await vi.waitFor(() => { expect(service.getSession(started.session.id)?.status).toBe('completed'); });
  return started.session.id;
}

function expectResumedModel(args: readonly string[], model: string): void {
  expect(args).toContain('--model');
  expect(args[args.indexOf('--model') + 1]).toBe(model);
  expect(args.some((arg) => arg.includes('model_reasoning_effort'))).toBe(false);
}

describe('Effective resume configuration and session snapshot persistence', () => {
  it('persists effectiveModel and effectiveReasoningEffort on session start and uses them during resume', async () => {
    const { db, createService, cleanup } = await setupFixture('interleaf-resume-config-');
    const repository = new AgentRepository(db);
    const { runner, resumeArgs } = scriptedCodexRunner('codex-thread-snap-1', 'done');
    const profile = codexProfile('o3-mini', ['o3-mini', 'o3-pro']);
    const service = createService(repository, profile, runner);
    await service.initialize();

    // Start with model override "o3-pro"
    const sessionId = await startCompleted(service, 'solve difficult problem', 'o3-pro');

    const sessionRow = repository.getSession(sessionId);
    expect(sessionRow?.effectiveModel).toBe('o3-pro');
    expect(sessionRow?.effectiveReasoningEffort).toBeNull();

    // Mutate the active profile's defaultModel and reasoningEffort to simulate profile edits after start
    profile.defaultModel = 'gpt-4o-mini';
    (profile as { reasoningEffort: string | null }).reasoningEffort = 'max';

    // Resume session - must use session snapshot ("o3-pro"), NOT current profile defaults ("gpt-4o-mini" / "max")
    await service.resumeSession({ sessionId, prompt: 'continue with same model' }, 1);

    // The profile was edited to "max" above; no effort token is emitted at all,
    // so the edit cannot leak into a resumed session either.
    expectResumedModel(resumeArgs(), 'o3-pro');

    await service.shutdown();
    await cleanup();
  });

  it('omits --model and reasoning flags on resume for historical rows with null snapshots in built-in Codex', () => {
    let executedArgs: readonly string[] = [];
    const adapter = new CliAgentAdapter(
      {
        ...codexProfile('default-fallback-model', []),
        defaultArgs: [],
        reasoningEffort: 'high',
        capabilities: { ...CAPABILITIES, reasoningSelection: true },
      },
      {
        run: (options: ProcessRunnerRequest) => {
          executedArgs = options.args;
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

    // Pass null model and null reasoningEffort (as would come from a migrated historical session)
    adapter.resume('provider-thread-legacy', {
      sessionId: 'sess-legacy',
      prompt: 'resume legacy without overrides',
      canonicalWorkingDirectory: '/tmp/workspace',
      model: null,
      reasoningEffort: null,
    });

    expect(executedArgs).toEqual([
      'exec',
      'resume',
      '--json',
      'provider-thread-legacy',
      '-',
    ]);
  });

  it('fails closed with a typed explanation when custom resume template requires missing model or reasoning snapshot', () => {
    const missing = { workingDir: '/workspace', promptFile: '', sessionId: 'sess-1', model: null, reasoningEffort: null };
    expect(() => expandCustomArgvTemplate(['resume', '--model', '{{model}}'], missing, { isResume: true })).toThrow(/requires a model snapshot/i);
    expect(() => expandCustomArgvTemplate(['resume', '--effort', '{{reasoningEffort}}'], missing, { isResume: true })).toThrow(/requires a reasoning effort snapshot/i);

    // When values are present, expansion succeeds
    const expanded = expandCustomArgvTemplate(
      ['resume', '--session', '{{sessionId}}', '--model', '{{model}}', '--effort', '{{reasoningEffort}}'],
      { sessionId: 'sess-123', promptFile: '', workingDir: '/workspace', model: 'gpt-4o', reasoningEffort: 'medium' },
      { isResume: true },
    );
    expect(expanded).toEqual(['resume', '--session', 'sess-123', '--model', 'gpt-4o', '--effort', 'medium']);
  });

  it('rehydrates persisted session effective configuration across app restart and resumes faithfully', async () => {
    const { db, createService, cleanup } = await setupFixture('interleaf-restart-resume-');
    const { runner, resumeArgs } = scriptedCodexRunner('rehydrate-thread-1', 'report');
    const profile = codexProfile('default-model', ['default-model', 'custom-model-v1']);

    const service1 = createService(new AgentRepository(db), profile, runner);
    await service1.initialize();
    const sessionId = await startCompleted(service1, 'first run with custom model', 'custom-model-v1');
    expect(service1.getSession(sessionId)?.status).toBe('completed');
    await service1.shutdown();

    const service2 = createService(new AgentRepository(db), profile, runner);
    await service2.initialize();

    // Rehydrated session must retain effectiveModel and effectiveReasoningEffort
    const rehydrated = service2.getSession(sessionId);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated?.effectiveModel).toBe('custom-model-v1');
    expect(rehydrated?.effectiveReasoningEffort).toBeNull();

    // No window owns a rehydrated session until main's factory has created
    // the window it binds recovery to, and that window claims it (item C).
    service2.adoptMainWindow(1);
    await service2.claimSession(sessionId, 1);

    await service2.resumeSession({ sessionId, prompt: 'follow up after restart' }, 1);
    expectResumedModel(resumeArgs(), 'custom-model-v1');

    await service2.shutdown();
    await cleanup();
  });
});
