import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_MODEL_ID_PATTERN,
  MAX_AGENT_PROFILE_MODELS,
  MAX_AGENT_PROFILE_MODEL_OPTIONS,
  MAX_DISCOVERED_AGENT_MODELS,
  isAgentModelIdentifier,
  resolveAgentModelOptions,
  seededAgentModels,
} from '@shared/constants/agent-models';
import { agentProfileSchema } from '@shared/schemas/agent';
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { validateAgentProfileSettings } from '@main/db/repositories/settings-repository';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { CliAgentAdapter } from '@main/agents/agent-adapter';
import { TestAgentRegistry } from '../helpers/agent-registry';
import { AgentService } from '@main/agents/agent-service';
import { resolveMainProfileModels, toRendererAgentProfile } from '@main/agents/profile-types';
import { fingerprintExecutionAuthority } from '@main/agents/execution-authority';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { ProcessRunnerRequest } from '@main/agents/process-runner';
import type { Logger } from '@main/logging/logger';
import type { PortableRecord, PortableValue } from '@shared/models/portable';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, withEnvironmentShell, testAgentRegistryOptions } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type MutableProfile = {
  -readonly [K in keyof MainAgentProfile]: MainAgentProfile[K];
};


function codexProfile(overrides: Partial<MainAgentProfile> = {}): MainAgentProfile {
  return {
    id: 'codex',
    providerId: 'codex',
    name: 'Codex',
    binaryPath: '/usr/local/bin/codex',
    defaultArgs: ['exec', '--json'],
    defaultModel: 'gpt-5-codex',
    configuredModels: ['gpt-5-codex', 'gpt-5.1-codex'],
    reasoningEffort: null,
    permissionMode: 'normal',
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true,
      sessionResume: true,
      nativeSandbox: true,
      workingDirectory: true,
      modelSelection: true,
      reasoningSelection: false,
      fileChangeEvents: true,
      toolEvents: true,
      subagents: false,
      interactiveAuthentication: false,
      nonInteractiveMode: true,
    },
    detection: { availability: 'installed', binaryPath: '/usr/local/bin/codex', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

describe('agent model availability resolution', () => {
  it('orders the configured default first, then the user list, then repo-evidenced seeds', () => {
    expect(resolveAgentModelOptions({
      providerId: 'claude-code',
      modelSelection: true,
      defaultModel: 'claude-sonnet-5',
      configuredModels: ['claude-haiku-4-5'],
    })).toEqual(['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']);
  });

  it('de-duplicates without reordering the first occurrence', () => {
    expect(resolveAgentModelOptions({
      providerId: 'claude-code',
      modelSelection: true,
      defaultModel: 'claude-opus-5',
      configuredModels: ['claude-opus-5', 'claude-sonnet-5'],
    })).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('is empty when the CLI has no model-selection surface', () => {
    expect(resolveAgentModelOptions({
      providerId: 'codex',
      modelSelection: false,
      defaultModel: 'gpt-5-codex',
      configuredModels: ['gpt-5.1-codex'],
    })).toEqual([]);
  });

  it('drops values that could be mistaken for an additional CLI flag or shell input', () => {
    expect(resolveAgentModelOptions({
      providerId: 'codex',
      modelSelection: true,
      defaultModel: null,
      configuredModels: ['--dangerously-skip-permissions', 'a model', '"quoted"', '$(whoami)', '', 'gpt-5-codex'],
    })).toEqual(['gpt-5-codex']);
  });

  it('rejects non-conforming identifiers through the shared guard', () => {
    expect(isAgentModelIdentifier('gpt-5.1-codex')).toBe(true);
    expect(isAgentModelIdentifier('anthropic/claude-opus-5')).toBe(true);
    expect(isAgentModelIdentifier('-m')).toBe(false);
    expect(isAgentModelIdentifier('has space')).toBe(false);
    expect(isAgentModelIdentifier('a'.repeat(129))).toBe(false);
    expect(isAgentModelIdentifier(42)).toBe(false);
    expect(AGENT_MODEL_ID_PATTERN.test('gpt-5-codex')).toBe(true);
  });

  it('keeps the seed table free of unevidenced provider catalogs', () => {
    for (const providerId of ['codex', 'antigravity', 'copilot', 'opencode', 'pi', 'custom'] as const) {
      expect(seededAgentModels(providerId)).toEqual([]);
    }
    expect(seededAgentModels('claude-code')).toEqual(['claude-opus-5']);
  });
});

describe('renderer projection of available models', () => {
  it('publishes exactly the set the main-side guard resolves', () => {
    const profile = codexProfile();
    const projected = toRendererAgentProfile(profile);
    expect(projected.availableModels).toEqual(resolveMainProfileModels(profile));
    expect(projected.availableModels).toEqual(['gpt-5-codex', 'gpt-5.1-codex']);
  });

  it('never leaks main-only launch internals across the boundary', () => {
    const projected = toRendererAgentProfile(codexProfile());
    for (const mainOnly of ['binaryPath', 'defaultArgs', 'configuredModels']) {
      expect(Object.keys(projected)).not.toContain(mainOnly);
    }
  });
  it('fingerprints an empty model list like a preference saved before the list existed', () => {
    const legacy: MutableProfile = { ...codexProfile() };
    delete legacy.configuredModels;
    expect(fingerprintExecutionAuthority(codexProfile({ configuredModels: [] }))).toBe(fingerprintExecutionAuthority(legacy));
    expect(fingerprintExecutionAuthority(codexProfile())).not.toBe(fingerprintExecutionAuthority(legacy));
  });
  it('sanitizes an invalid flag-like defaultModel to null in the projected profile', () => {
    const profile = codexProfile({ defaultModel: '--yolo-flag' });
    const projected = toRendererAgentProfile(profile);
    expect(projected.defaultModel).toBeNull();
    expect(projected.availableModels).not.toContain('--yolo-flag');
  });

  it('carries a largest-possible projection across the IPC contract', () => {
    // The three layers have to agree on one bound: a profile whose every source
    // contributes its own maximum is legitimate, so a schema bound below that
    // would reject a valid projection at the boundary instead of bounding it.
    const profile = codexProfile({
      defaultModel: 'default-model',
      configuredModels: Array.from({ length: MAX_AGENT_PROFILE_MODELS }, (_, index) => `configured-${String(index)}`),
      discoveredModels: Array.from({ length: MAX_DISCOVERED_AGENT_MODELS }, (_, index) => `discovered-${String(index)}`),
    });
    const projected = toRendererAgentProfile(profile);
    expect(projected.availableModels).toHaveLength(1 + MAX_AGENT_PROFILE_MODELS + MAX_DISCOVERED_AGENT_MODELS);
    expect(projected.availableModels.length).toBeLessThanOrEqual(MAX_AGENT_PROFILE_MODEL_OPTIONS);
    expect(agentProfileSchema.safeParse(projected).success).toBe(true);
  });

  it('bounds the projection at the sum of every source the resolver merges', () => {
    // `fake` is the provider with the largest seed list, so it is the only one
    // that can reach the declared maximum exactly.
    const options = resolveAgentModelOptions({
      providerId: 'fake',
      modelSelection: true,
      defaultModel: 'default-model',
      configuredModels: Array.from({ length: MAX_AGENT_PROFILE_MODELS }, (_, index) => `configured-${String(index)}`),
      discoveredModels: Array.from({ length: MAX_DISCOVERED_AGENT_MODELS }, (_, index) => `discovered-${String(index)}`),
    });
    expect(options).toHaveLength(MAX_AGENT_PROFILE_MODEL_OPTIONS);
    const oversized = { ...toRendererAgentProfile(codexProfile()), availableModels: [...options, 'one-too-many'] };
    expect(agentProfileSchema.safeParse(oversized).success).toBe(false);
  });
});

describe('persisted per-profile model list', () => {
  /**
   * A stored settings document whose Codex profile carries `models` — or, when
   * the argument is omitted, one written before that field existed.
   */
  function settingsWithCodexModels(models?: PortableValue): PortableRecord {
    return {
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        profiles: {
          codex: {
            binary: 'codex',
            arguments: ['exec', '--json', '--sandbox', 'workspace-write'],
            defaultModel: null,
            ...(models === undefined ? {} : { models }),
            reasoningEffort: null,
            permissionMode: 'workspace-write',
            sandboxMode: 'auto-isolated',
            workingDirectoryPolicy: 'select-per-run',
            environmentOverrides: [],
          },
        },
      },
    };
  }

  it('loads an already-persisted document that predates the model list with an empty list', () => {
    const legacy = settingsWithCodexModels();
    const parsed = appSettingsSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.agent.profiles.codex?.models).toEqual([]);
  });

  it('accepts a bounded list of well-formed identifiers', () => {
    const parsed = appSettingsSchema.safeParse(settingsWithCodexModels(['gpt-5-codex', 'gpt-5.1-codex']));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.agent.profiles.codex?.models).toEqual(['gpt-5-codex', 'gpt-5.1-codex']);
  });

  it('rejects duplicates, argv-shaped values, and lists beyond the persisted bound', () => {
    expect(appSettingsSchema.safeParse(settingsWithCodexModels(['gpt-5-codex', 'gpt-5-codex'])).success).toBe(false);
    expect(appSettingsSchema.safeParse(settingsWithCodexModels(['--yolo'])).success).toBe(false);
    expect(appSettingsSchema.safeParse(settingsWithCodexModels(['model with spaces'])).success).toBe(false);
    const tooMany = Array.from({ length: MAX_AGENT_PROFILE_MODELS + 1 }, (_, index) => `model-${String(index)}`);
    expect(appSettingsSchema.safeParse(settingsWithCodexModels(tooMany)).success).toBe(false);
  });
  it('rejects an invalid flag-like defaultModel during settings update', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        profiles: {
          codex: {
            binary: 'codex' as const,
            arguments: ['exec', '--json', '--sandbox', 'workspace-write'],
            defaultModel: '--yolo-flag',
            models: ['gpt-5-codex'],
            reasoningEffort: null,
            permissionMode: 'workspace-write' as const,
            sandboxMode: 'auto-isolated' as const,
            workingDirectoryPolicy: 'select-per-run' as const,
            environmentOverrides: [],
          },
        },
      },
    };
    expect(() => { validateAgentProfileSettings(settings); }).toThrow(/Default model for agent profile 'codex' must be a valid identifier/iu);
  });
});

type StartedRun = { readonly args: readonly string[] };

type CodexServiceContext = {
  readonly service: AgentService;
  readonly repository: AgentRepository;
  readonly db: InterleafDatabase;
  readonly runs: readonly StartedRun[];
  /** Starts a run on `profileId`; an `undefined` model omits the field entirely. */
  readonly start: (model?: string | null, profileId?: string) => ReturnType<AgentService['startSession']>;
  readonly settle: (sessionId: string) => Promise<void>;
  readonly awaitRuns: (count: number) => Promise<void>;
};

async function withCodexService(
  profile: MainAgentProfile,
  body: (context: CodexServiceContext) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-agent-model-'));
  const target = join(root, 'workspace');
  await mkdir(target, { recursive: true });
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-model', 'Doc Model', 'pdf', '/tmp/model.pdf', 'managed', 100, 100, 'hash-model')
  `).run();
  const repository = new AgentRepository(db);
  const runs: StartedRun[] = [];
  const runner = ({
    run: (options: ProcessRunnerRequest) => {
      runs.push({ args: [...options.args] });
      return {
        runId: 'fixture-run',
        events: (async function* () {
          await Promise.resolve();
          yield { runId: 'fixture-run', type: 'started' as const, timestamp: new Date().toISOString() };
          yield {
            runId: 'fixture-run', type: 'structured' as const,
            data: { type: 'thread.started', thread_id: 'codex-thread-model-1' },
            timestamp: new Date().toISOString(),
          };
          yield { runId: 'fixture-run', type: 'structured' as const, data: { text: 'done' }, structuredKind: 'final' as const, structuredFinalText: 'done', timestamp: new Date().toISOString() };
          yield { runId: 'fixture-run', type: 'ended' as const, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      };
    },
  });

  class TestRegistry extends TestAgentRegistry {
    override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([profile]); }
  }
  const agentRegistry = new TestRegistry(testAgentRegistryOptions());
  agentRegistry.installAdapter(new CliAgentAdapter(profile, runner, ...adapterCollaborators()));

  const service = createTestAgentService({ database: db,
    repository,
    registry: new WorkingDirectoryRegistry(),
    agentRegistry,
    contextRoot: join(root, 'context'),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
    chooseDirectory: () => Promise.resolve(target),
    log: logger,
    isPackaged: false,
  });
  try {
    await service.initialize();
    const directory = await service.selectWorkingDirectory();
    if (directory === null) throw new Error('Directory selection failed');
    await body({
      service, repository, db, runs,
      start: (model, profileId = 'codex') => service.startSession({
        documentId: 'doc-model',
        profileId,
        workingDirectoryHandle: directory.handle,
        executionMode: 'auto-isolated',
        prompt: 'model selection prompt',
        ...(model === undefined ? {} : { model }),
      }, 1),
      settle: async (sessionId) => {
        await vi.waitFor(() => { expect(service.getSession(sessionId)?.status).toBe('completed'); });
      },
      awaitRuns: async (count) => {
        await vi.waitFor(() => { expect(runs.length).toBeGreaterThanOrEqual(count); });
      },
    });
  } finally {
    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function modelArg(args: readonly string[]): string | undefined {
  const modelIndex = args.indexOf('--model');
  expect(modelIndex).toBeGreaterThanOrEqual(0);
  return args[modelIndex + 1];
}

function customProfileWithDefault(defaultModel: string): MainAgentProfile {
  return codexProfile({
    id: 'custom-tool',
    providerId: 'custom',
    isCustom: true,
    defaultModel,
    customConfig: {
      version: 1,
      executionKind: 'normal',
      argvTemplate: ['--model', '{{model}}', '{{workingDir}}'],
      promptDeliveryMode: 'stdin',
      stdoutParsingMode: 'text',
      defaultModel,
      reasoningEffort: null,
      supportsModelSelection: true,
      supportsReasoningSelection: false,
      resumeCommandTemplate: null,
      supportsResume: false,
      workingDirectoryPolicy: 'select-per-run',
      defaultSandboxMode: 'auto-isolated',
      environmentOverrides: [],
      unsafe: false,
    },
  });
}

describe('AgentService per-run model validation and launch', () => {
  it.each<{ name: string; profile: MainAgentProfile; model: string | undefined; expected: string }>([
    { name: 'passes an allowlisted model into the tokenized argv', profile: codexProfile(), model: 'gpt-5.1-codex', expected: 'gpt-5.1-codex' },
    {
      name: 'launches a model the installed CLI reported even though the user never typed it',
      profile: codexProfile({ discoveredModels: ['gpt-5.2-codex'] }), model: 'gpt-5.2-codex', expected: 'gpt-5.2-codex',
    },
    { name: 'falls back to the profile default when no model is selected', profile: codexProfile(), model: undefined, expected: 'gpt-5-codex' },
    { name: 'treats an empty selection as "use the profile default"', profile: codexProfile(), model: '', expected: 'gpt-5-codex' },
  ])('$name and persists it as the session snapshot', async ({ profile, model, expected }) => {
    await withCodexService(profile, async ({ repository, runs, start, settle }) => {
      const started = await start(model);
      await settle(started.session.id);
      expect(modelArg(runs[0]?.args ?? [])).toBe(expected);
      expect(repository.getSession(started.session.id)?.effectiveModel).toBe(expected);
    });
  });

  it.each<{ name: string; profile: MainAgentProfile; model: string | null; profileId?: string; error: RegExp; noSession: boolean }>([
    {
      name: 'a model no source resolved, so discovery only ever widens the allowlist deliberately',
      profile: codexProfile({ discoveredModels: ['gpt-5.2-codex'] }), model: 'gpt-5.3-codex', error: /model/iu, noSession: false,
    },
    { name: 'a model the profile does not resolve to', profile: codexProfile(), model: 'gpt-9-unlisted', error: /not available for this agent profile/iu, noSession: true },
    {
      name: 'an argv-shaped model value',
      profile: codexProfile(), model: '--dangerously-bypass-approvals-and-sandbox', error: /not available for this agent profile/iu, noSession: false,
    },
    {
      name: 'an invalid flag-like configured default under Provider default/Auto',
      profile: codexProfile({ defaultModel: '--dangerously-bypass-approvals' }), model: null, error: /not available for this agent profile/iu, noSession: true,
    },
    {
      name: 'an invalid configured default when the selection is an empty string',
      profile: codexProfile({ defaultModel: '--yolo-flag' }), model: '', error: /not available for this agent profile/iu, noSession: true,
    },
    {
      name: 'a custom profile with a flag-like defaultModel under Provider default',
      profile: customProfileWithDefault('--danger-flag'), model: null, profileId: 'custom-tool', error: /not available for this agent profile/iu, noSession: true,
    },
    {
      name: 'any model for a profile without a model-selection surface',
      profile: codexProfile({ capabilities: { ...codexProfile().capabilities, modelSelection: false } }),
      model: 'gpt-5-codex', error: /does not support model selection/iu, noSession: false,
    },
  ])('rejects $name without spawning a process', async ({ profile, model, profileId, error, noSession }) => {
    await withCodexService(profile, async ({ service, runs, start }) => {
      await expect(start(model, profileId)).rejects.toThrow(error);
      expect(runs).toHaveLength(0);
      if (noSession) expect(service.listSessions('doc-model')).toHaveLength(0);
    });
  });

  it.each<{ name: string; changeSettings: (profile: MutableProfile) => void }>([
    {
      // The composer/settings default moves on after the run started.
      name: 'even after the profile default changes',
      changeSettings: (profile) => { profile.defaultModel = 'gpt-5-codex'; },
    },
    {
      // Settings remove B from configuredModels and switch the default to A.
      name: 'B after B is removed from configuredModels and defaults',
      changeSettings: (profile) => { profile.defaultModel = 'gpt-5-codex'; profile.configuredModels = ['gpt-5-codex']; },
    },
  ])('resumes with the recorded session model $name', async ({ changeSettings }) => {
    const profile: MutableProfile = codexProfile();
    await withCodexService(profile, async ({ service, runs, start, settle, awaitRuns }) => {
      const started = await start('gpt-5.1-codex');
      await settle(started.session.id);

      changeSettings(profile);

      await service.resumeSession({ sessionId: started.session.id, prompt: 'continue' }, 1);
      await awaitRuns(2);
      const resumeArgs = runs.find((run) => run.args.includes('resume'))?.args ?? [];
      expect(resumeArgs[resumeArgs.indexOf('--model') + 1]).toBe('gpt-5.1-codex');
    });
  });

  it('fails closed on an invalid or flag-like persisted snapshot before spawn or status mutation', async () => {
    await withCodexService(codexProfile(), async ({ service, repository, db, runs, start, settle }) => {
      const started = await start('gpt-5.1-codex');
      await settle(started.session.id);

      db.raw.prepare('UPDATE agent_sessions SET effective_model = ? WHERE id = ?').run(
        '--dangerously-bypass-permissions',
        started.session.id,
      );

      const initialRunCount = runs.length;
      await expect(
        service.resumeSession({ sessionId: started.session.id, prompt: 'continue' }, 1)
      ).rejects.toThrow(/not a valid identifier/iu);

      expect(runs).toHaveLength(initialRunCount);
      expect(repository.getSession(started.session.id)?.status).toBe('completed');
    });
  });
});
