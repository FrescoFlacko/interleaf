import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { InterleafDatabase } from '@main/db/database';
import { MIGRATIONS, applyMigrations, runMigrations } from '@main/db/migrations';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { ExecutableRegistry } from '@main/agents/executable-registry';
import { cleanupStalePromptFiles } from '@main/agents/custom-prompt-storage';
import { AgentRegistry, CliAgentAdapter, mapProcessEvents } from '@main/agents/agent-adapter';
import { expandCustomArgvTemplate } from '@main/agents/custom-argv-template';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { ProcessRunner, type ProcessRunnerEvent } from '@main/agents/process-runner';
import { OVERSIZED_LINE } from '@main/agents/stream-redactor';
import type { MainAgentProfile } from '@main/agents/profile-types';
import type { CustomAgentProfileConfig } from '@shared/schemas/custom-agent-profile';
import {
  createCustomAgentProfileRequestSchema,
  customAgentProfileSchema,
  customAgentEnvironmentOverrideSchema,
} from '@shared/schemas/custom-agent-profile';
import { agentSettingsSchema } from '@shared/schemas/settings';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { silentLogger } from '../helpers/silent-logger';

/** The value an earlier step must have produced; fails the test when it did not. */
function present<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} was not produced`);
  return value;
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `interleaf-${prefix}-`));
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
}

type NormalConfig = Extract<CustomAgentProfileConfig, { executionKind: 'normal' }>;

function customConfig(overrides: Partial<NormalConfig> = {}): NormalConfig {
  return {
    version: 1, executionKind: 'normal', argvTemplate: [], promptDeliveryMode: 'stdin', stdoutParsingMode: 'text',
    defaultModel: null, reasoningEffort: null, supportsModelSelection: false, supportsReasoningSelection: false,
    resumeCommandTemplate: null, supportsResume: false, workingDirectoryPolicy: 'select-per-run',
    defaultSandboxMode: 'auto-isolated', environmentOverrides: [], unsafe: false, ...overrides,
  };
}

/** A main-side custom profile bound to a registered executable. */
function customProfile(
  executable: Awaited<ReturnType<ExecutableRegistry['register']>>,
  name: string,
  config: NormalConfig,
): MainAgentProfile {
  return {
    id: `custom:${randomUUID()}`, providerId: 'custom', name, binaryPath: executable.canonicalPath, defaultArgs: [],
    defaultModel: null, reasoningEffort: null, permissionMode: 'custom', defaultSandboxMode: 'auto-isolated',
    workingDirectoryPolicy: 'select-per-run', environmentOverrides: config.environmentOverrides,
    capabilities: { structuredOutput: false, sessionResume: false, nativeSandbox: false, workingDirectory: true, modelSelection: false, reasoningSelection: false, fileChangeEvents: false, toolEvents: false, subagents: false, interactiveAuthentication: false, nonInteractiveMode: true },
    detection: { availability: 'installed', binaryPath: null, version: null, checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: true, unsafe: false, executableHandle: executable.handle, executableIdentity: executable.identity, customConfig: config,
  };
}

async function stdoutOf(run: ReturnType<CliAgentAdapter['start']>): Promise<string> {
  await run.completion;
  const output: string[] = [];
  for await (const event of run.events) if (event.type === 'stdout' && typeof event.text === 'string') output.push(event.text);
  return output.join('');
}

function leftoverPrompts(promptRoot: string): string[] {
  return existsSync(promptRoot) ? readdirSync(promptRoot).filter((name) => name.endsWith('.prompt')) : [];
}

type ParsingMode = 'text' | 'json-lines' | 'none';

async function collectEvents(events: readonly ProcessRunnerEvent[], mode: ParsingMode = 'text') {
  const source = async function* (): AsyncGenerator<ProcessRunnerEvent> {
    await Promise.resolve();
    for (const event of events) yield event;
  };
  const out = [];
  for await (const event of mapProcessEvents(source(), undefined, mode)) out.push(event);
  return out;
}

async function collectTypes(events: readonly ProcessRunnerEvent[], mode: ParsingMode = 'text'): Promise<string[]> {
  return (await collectEvents(events, mode)).map((event) => event.type);
}

const quietLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('custom agent profile security boundaries', () => {
  it('accepts only whole-token placeholders and rejects traversal-shaped or oversized input', () => {
    const parse = (argvTemplate: string[], promptDeliveryMode: 'temp-file' | 'stdin', stdoutParsingMode: 'text' | 'none') => () =>
      createCustomAgentProfileRequestSchema.parse({ name: 'safe', executableHandle: randomUUID(), argvTemplate, promptDeliveryMode, stdoutParsingMode });
    expect(parse(['--prompt={{promptFile}}'], 'temp-file', 'text')).toThrow();
    expect(parse(['{{unknown}}'], 'temp-file', 'text')).toThrow();
    expect(parse(['x'.repeat(513)], 'stdin', 'none')).toThrow();
    expect(parse(['--skip-git-repo-check'], 'stdin', 'none')).toThrow(/repository-check bypass/u);
    expect(expandCustomArgvTemplate(['--literal', '$(touch hacked)', '{{model}}'], {
      workingDir: '/safe/workspace', promptFile: '/safe/prompt', sessionId: 'session', model: 'model',
    })).toEqual(['--literal', '$(touch hacked)', 'model']);
  });

  it('rejects custom IDs in built-in settings and leaves a custom adapter untouched by crafted preferences', () => {
    const customId = `custom:${randomUUID()}`;
    const settingsProfile = {
      binary: 'codex' as const,
      arguments: ['exec', '--json', '--sandbox', 'workspace-write'],
      defaultModel: null,
      models: [],
      reasoningEffort: null,
      permissionMode: 'workspace-write' as const,
      sandboxMode: 'auto-isolated' as const,
      workingDirectoryPolicy: 'select-per-run' as const,
      environmentOverrides: [],
    };
    expect(agentSettingsSchema.safeParse({ defaultExecutionMode: 'auto-isolated', profiles: { [customId]: settingsProfile } }).success).toBe(false);

    const executableRegistry = new ExecutableRegistry();
    const registry = new AgentRegistry(testAgentRegistryOptions({ executableRegistry }));
    const config = customConfig({ argvTemplate: ['{{promptFile}}'], promptDeliveryMode: 'temp-file' });
    const runtime = registry.addCustomProfile({ id: customId, name: 'Protected custom', binaryPath: '/main-owned/custom-agent', executableHandle: randomUUID(), executableIdentity: { device: 1, inode: 2, birthtimeNs: '3', size: 1, mtimeMs: 1, sha256: 'a'.repeat(64) }, config });
    const before = registry.getAdapter(customId);
    registry.applyProfileSettings({ [customId]: settingsProfile });
    expect(registry.getAdapter(customId)).toBe(before);
    expect(registry.getAdapter(customId)?.profile).toMatchObject({ id: customId, name: runtime.name, providerId: 'custom', executableHandle: runtime.executableHandle, customConfig: config });
  });

  it('drops stale custom settings keys during legacy reload instead of routing them into built-in adapters', () => {
    const database = InterleafDatabase.open(':memory:');
    try {
      runMigrations(database);
      const repository = new SettingsRepository(database, silentLogger);
      const initial = repository.get();
      const customId = `custom:${randomUUID()}`;
      const stale = { ...initial, agent: { ...initial.agent, profiles: { ...initial.agent.profiles, [customId]: { binary: 'codex', arguments: ['exec', '--json', '--sandbox', 'workspace-write'], defaultModel: null, reasoningEffort: null, permissionMode: 'workspace-write', sandboxMode: 'auto-isolated', workingDirectoryPolicy: 'select-per-run', environmentOverrides: [] } } } };
      database.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(stale), 'app');
      expect(repository.get().agent.profiles).not.toHaveProperty(customId);
    } finally {
      database.close();
    }
  });

  it('rejects secret-bearing environment names and raw credential-shaped overrides', () => {
    expect(() => customAgentEnvironmentOverrideSchema.parse({ name: 'OPENROUTER_API_KEY', action: 'inherit-allowlisted' })).toThrow();
    expect(() => customAgentEnvironmentOverrideSchema.parse({ name: 'PATH', action: 'inherit-allowlisted' })).not.toThrow();
    expect(() => customAgentEnvironmentOverrideSchema.parse({ name: 'NODE_OPTIONS', action: 'inherit-allowlisted' })).toThrow();
  });

  it('uses opaque executable capabilities and fails closed after a swap or symlink selection', async () => {
    const root = tempRoot('executable');
    try {
      const executablePath = join(root, 'agent');
      writeExecutable(executablePath, '#!/bin/sh\nprintf safe\n');
      const registry = new ExecutableRegistry();
      const registered = await registry.register(executablePath);
      expect(registered.canonicalPath).toBe(realpathSync(executablePath));
      expect(registry.toPublic(registered)).not.toHaveProperty('canonicalPath');
      const symlinkPath = join(root, 'link-agent');
      symlinkSync(executablePath, symlinkPath);
      await expect(registry.register(symlinkPath)).rejects.toThrow(/symlink/i);
      writeExecutable(executablePath, '#!/bin/sh\nprintf swapped\n');
      expect(() => registry.resolveSync(registered.handle)).toThrow(/changed|stopped/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes the selected wrapper from its original location so relative sidecars remain available', async () => {
    const root = tempRoot('wrapper');
    try {
      const executablePath = join(root, 'wrapper');
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      writeFileSync(join(root, 'sidecar.txt'), 'sidecar-content\n', { mode: 0o600 });
      writeExecutable(executablePath, '#!/bin/sh\ncat "$(dirname "$0")/sidecar.txt"\n');
      const registry = new ExecutableRegistry();
      const profile = customProfile(await registry.register(executablePath), 'Wrapper', customConfig());
      const run = new CliAgentAdapter(profile, new ProcessRunner(), ...adapterCollaborators(registry, join(root, 'prompts'))).start({ documentId: 'test-doc', profileId: profile.id, workingDirectoryHandle: 'dir', executionMode: 'isolated-copy', prompt: 'ignored', canonicalWorkingDirectory: workspace, model: null, contextPacket: null, riskConfirmation: null });
      expect(await stdoutOf(run)).toContain('sidecar-content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans bounded stale prompt files at startup without following symlinks', () => {
    const root = tempRoot('prompts');
    try {
      const stale = join(root, `${randomUUID()}.prompt`);
      const fresh = join(root, `${randomUUID()}.prompt`);
      const outside = join(root, 'outside-target.prompt');
      const linked = join(root, `${randomUUID()}.prompt`);
      writeFileSync(stale, 'confidential', { mode: 0o600 });
      writeFileSync(fresh, 'retain briefly', { mode: 0o600 });
      writeFileSync(outside, 'outside', { mode: 0o600 });
      symlinkSync(outside, linked);
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
      utimesSync(stale, old, old);
      expect(cleanupStalePromptFiles(root, silentLogger)).toBe(1);
      expect(() => lstatSync(stale)).toThrow();
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes only validated inherit/clear environment overrides and never stores values in custom output', async () => {
    const root = tempRoot('environment');
    try {
      const executablePath = join(root, 'agent');
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      writeExecutable(executablePath, '#!/bin/sh\nprintf "%s:%s\\n" "${PATH:+inherited}" "${HOME:-cleared}"\n');
      const registry = new ExecutableRegistry();
      const profile = customProfile(await registry.register(executablePath), 'Environment test', customConfig({
        environmentOverrides: [{ name: 'PATH', action: 'inherit-allowlisted' }, { name: 'HOME', action: 'clear' }],
      }));
      const adapter = new CliAgentAdapter(profile, new ProcessRunner(), ...adapterCollaborators(registry, join(root, 'prompts')));
      const output = await stdoutOf(adapter.start({ documentId: 'test-doc', profileId: profile.id, workingDirectoryHandle: 'test-dir', executionMode: 'isolated-copy', prompt: 'prompt', canonicalWorkingDirectory: workspace, model: null, contextPacket: null, riskConfirmation: null }));
      expect(output).toContain('inherited');
      expect(output).toContain('cleared');
      expect(output).not.toContain('value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes stdout parsing labels observable: text is raw, json-lines is structured, none suppresses stdout', async () => {
    const events: ProcessRunnerEvent[] = [
      { type: 'stdout', runId: 'run', text: 'raw\n', timestamp: new Date().toISOString() },
      { type: 'structured', runId: 'run', data: { kind: 'final', text: 'parsed' }, timestamp: new Date().toISOString() },
    ];
    expect(await collectTypes(events, 'text')).toEqual(['stdout']);
    expect(await collectTypes(events, 'json-lines')).toEqual(['stdout', 'final']);
    expect(await collectTypes(events, 'none')).toEqual([]);
  });

  it('synthesizes one text-mode final report on clean success only', async () => {
    // Item M: a text-mode agent emits no JSON final frame, so without this the
    // run has nothing to copy. Synthesis is a success-only convenience: it must
    // never invent a report out of cancelled, failed, capped, or quarantined
    // output, and it must arrive immediately before `ended`.
    const stamp = new Date().toISOString();
    const stdout = (text: string): ProcessRunnerEvent => ({ type: 'stdout', runId: 'run', text, timestamp: stamp });
    const ended = (exitCode: number | null, signal: string | null = null): ProcessRunnerEvent => ({ type: 'ended', runId: 'run', exitCode, signal, timestamp: stamp });

    const clean = await collectEvents([stdout('summary line\n'), stdout('second line\n'), ended(0)]);
    expect(clean.map((event) => event.type)).toEqual(['stdout', 'stdout', 'final', 'ended']);
    expect(clean[2]).toMatchObject({ type: 'final', text: 'summary line\nsecond line' });

    // Failure, cancellation, and a signalled exit are not successes.
    expect(await collectTypes([stdout('partial\n'), ended(1)])).toEqual(['stdout', 'ended']);
    expect(await collectTypes([stdout('partial\n'), ended(null, 'SIGKILL')])).toEqual(['stdout', 'ended']);
    expect(await collectTypes([
      stdout('partial\n'), { type: 'cancelled', runId: 'run', timestamp: stamp }, ended(0),
    ])).toEqual(['stdout', 'cancelled', 'ended']);

    // A runtime error, including the output cap, disqualifies the run even if
    // the child still exits zero.
    expect(await collectTypes([
      stdout('partial\n'),
      { type: 'error', runId: 'run', message: 'Agent output exceeded the bounded runtime limit.', timestamp: stamp },
      ended(0),
    ])).toEqual(['stdout', 'error', 'ended']);

    // Quarantined output has no trustworthy source text.
    expect(await collectTypes([stdout('fine\n'), stdout(OVERSIZED_LINE), ended(0)])).toEqual(['stdout', 'stdout', 'ended']);

    // Oversized output is withheld rather than truncated into a report.
    expect(await collectTypes([stdout(`${'x'.repeat(64 * 1024 + 1)}\n`), ended(0)])).toEqual(['stdout', 'ended']);

    // The runner dropped frames to stay inside its queue bound: the text this
    // run collected has a hole in it, so no report is synthesized from it.
    expect(await collectTypes([
      stdout('partial\n'),
      { type: 'structured', runId: 'run', data: { kind: 'dropped-events', count: 12 }, timestamp: stamp },
      ended(0),
    ])).toEqual(['stdout', 'structured', 'ended']);
    // The marker withholds even when it arrives before the retained output.
    expect(await collectTypes([
      { type: 'structured', runId: 'run', data: { kind: 'dropped-events', count: 3 }, timestamp: stamp },
      stdout('partial\n'),
      ended(0),
    ])).toEqual(['structured', 'stdout', 'ended']);

    // Nothing to report, and modes that do not own stdout, stay untouched.
    expect(await collectTypes([stdout('   \n'), ended(0)])).toEqual(['stdout', 'ended']);
    expect(await collectTypes([stdout('raw\n'), ended(0)], 'none')).toEqual(['ended']);
    expect(await collectTypes([
      stdout('raw\n'), { type: 'structured', runId: 'run', data: { kind: 'final', text: 'parsed' }, timestamp: stamp }, ended(0),
    ], 'json-lines')).toEqual(['stdout', 'final', 'ended']);
  });

  it('removes a temp prompt when the main-owned runner fails synchronously', async () => {
    const root = tempRoot('prompt-runner-failure');
    try {
      const executablePath = join(root, 'agent');
      const promptRoot = join(root, 'prompts');
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      writeExecutable(executablePath, '#!/bin/sh\nexit 0\n');
      const registry = new ExecutableRegistry();
      const profile = customProfile(await registry.register(executablePath), 'Runner failure', customConfig({
        argvTemplate: ['{{promptFile}}'], promptDeliveryMode: 'temp-file',
      }));
      const throwingRunner = ({ run: () => { throw new Error('runner seam failure'); } });
      const adapter = new CliAgentAdapter(profile, throwingRunner, ...adapterCollaborators(registry, promptRoot));
      expect(() => adapter.start({ documentId: 'test-doc', profileId: profile.id, workingDirectoryHandle: 'dir', executionMode: 'isolated-copy', prompt: 'confidential', canonicalWorkingDirectory: workspace, model: null, contextPacket: null, riskConfirmation: null })).toThrow('runner seam failure');
      expect(leftoverPrompts(promptRoot)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores and reloads custom profiles through the versioned migration and protects built-ins', async () => {
    const database = InterleafDatabase.open(':memory:');
    const root = tempRoot('persist');
    try {
      // Apply the exact historical v1-v10 definitions first. v10 is
      // checksum-protected and must not contain custom-profile columns.
      applyMigrations(database, MIGRATIONS.slice(0, 10));
      const oldColumns = (database.raw.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[]).map((row) => row.name);
      expect(oldColumns).not.toContain('custom_config_json');
      expect((database.raw.prepare('SELECT version, checksum FROM schema_migrations WHERE version = 10').get() as { version: number; checksum: string }).version).toBe(10);
      expect(runMigrations(database)).toBe(MIGRATIONS.length - 10);
      const columns = (database.raw.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[]).map((row) => row.name);
      expect(columns).toContain('custom_config_json');
      expect(columns).toContain('executable_identity_json');
      expect(columns).toContain('deleted_at');
      const executablePath = join(root, 'agent');
      writeExecutable(executablePath, '#!/bin/sh\nprintf profile\n');
      const executable = await new ExecutableRegistry().register(executablePath);
      const repository = new CustomAgentProfileRepository(database);
      const id = `custom:${randomUUID()}`;
      const created = repository.create({
        id, name: 'Persisted profile', canonicalPath: executable.canonicalPath, identity: executable.identity,
        config: customConfig({
          argvTemplate: ['{{promptFile}}'], promptDeliveryMode: 'temp-file', stdoutParsingMode: 'json-lines',
          environmentOverrides: [{ name: 'PATH', action: 'inherit-allowlisted' }],
        }),
      });
      expect(new CustomAgentProfileRepository(database).get(id)?.name).toBe(created.name);
      expect(repository.toPublic(created, { handle: executable.handle, displayName: executable.displayName, fingerprint: executable.identity.sha256 })).toMatchObject({ id, executable: { handle: executable.handle }, environmentOverrides: [{ name: 'PATH' }] });
      expect(() => { repository.delete('codex'); }).toThrow(/cannot be deleted/i);
      repository.update(id, { name: 'Updated profile', canonicalPath: executable.canonicalPath, identity: executable.identity, config: created.config });
      expect(repository.get(id)?.name).toBe('Updated profile');
      database.raw.prepare(`INSERT INTO allowed_working_directories (handle, canonical_path, display_name, identity_json) VALUES (?, ?, ?, ?)`)
        .run('history-dir', root, 'History directory', JSON.stringify({ device: 1, inode: 1, birthtimeNs: '1' }));
      database.raw.prepare(`INSERT INTO agent_sessions (id, profile_id, target_directory_handle, canonical_target_path, sandbox_mode, status, user_prompt, baseline_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('history-session', id, 'history-dir', root, 'isolated-copy', 'completed', 'historic prompt', 'history-fingerprint');
      repository.delete(id);
      expect(repository.get(id)).toBeNull();
      expect((database.raw.prepare('SELECT deleted_at FROM agent_profiles WHERE id = ?').get(id) as { deleted_at: string | null }).deleted_at).not.toBeNull();
      expect(() => customAgentProfileSchema.parse({ id: `custom:${randomUUID()}`, name: 'x', executable: null, executionKind: 'normal', argvTemplate: [], promptDeliveryMode: 'stdin', stdoutParsingMode: 'none', defaultModel: null, reasoningEffort: null, supportsModelSelection: false, supportsReasoningSelection: false, resumeCommandTemplate: null, supportsResume: false, workingDirectoryPolicy: 'select-per-run', defaultSandboxMode: 'auto-isolated', environmentOverrides: [], unsafe: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).not.toThrow();
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed with a typed repository error instead of silently dropping malformed rows', () => {
    const database = InterleafDatabase.open(':memory:');
    try {
      runMigrations(database);
      database.raw.prepare(`INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, is_custom, custom_config_json, executable_identity_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(`custom:${randomUUID()}`, 'Malformed JSON', '/tmp/agent', '[]', 'custom', '{not-json', '{}');
      expect(() => new CustomAgentProfileRepository(database).list()).toThrow(/malformed|valid JSON/i);

      database.raw.prepare(`DELETE FROM agent_profiles WHERE is_custom = 1`).run();
      // Schema-invalid JSON row
      database.raw.prepare(`INSERT INTO agent_profiles (id, name, binary_path, default_args_json, permission_mode, is_custom, custom_config_json, executable_identity_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(`custom:${randomUUID()}`, 'Invalid Schema', '/tmp/agent', '[]', 'custom', JSON.stringify({ version: 99 }), '{}');
      expect(() => new CustomAgentProfileRepository(database).list()).toThrow(/malformed|valid JSON/i);
    } finally {
      database.close();
    }
  });

  it('enforces merged cross-field validation on partial updates', async () => {
    const root = tempRoot('partial-update');
    const database = InterleafDatabase.open(':memory:');
    try {
      runMigrations(database);
      const executablePath = join(root, 'agent');
      writeExecutable(executablePath, '#!/bin/sh\nexit 0\n');
      const executableRegistry = new ExecutableRegistry();
      const service = createTestAgentService({ database: database,
        repository: new AgentRepository(database),
        registry: new WorkingDirectoryRegistry(),
        agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry })),
        contextRoot: join(root, 'context'),
        chooseDirectory: () => Promise.resolve(root),
        chooseExecutable: () => Promise.resolve(executablePath),
        log: quietLog,
        isPackaged: false,
        customProfiles: new CustomAgentProfileRepository(database),
        executableRegistry,
      });
      await service.initialize();
      const selection = await service.selectExecutable();
      expect(selection).not.toBeNull();

      // Create fully configured profile
      const created = await service.createCustomProfile({
        name: 'Full Profile',
        executableHandle: selection?.handle ?? '',
        executionKind: 'normal',
        argvTemplate: ['run', '{{model}}', '{{reasoningEffort}}', '{{promptFile}}'],
        promptDeliveryMode: 'temp-file',
        stdoutParsingMode: 'text',
        defaultModel: 'gpt-4o',
        reasoningEffort: 'high',
        supportsModelSelection: true,
        supportsReasoningSelection: true,
        resumeCommandTemplate: ['resume', '{{sessionId}}', '{{model}}', '{{reasoningEffort}}', '{{promptFile}}'],
        supportsResume: true,
        workingDirectoryPolicy: 'select-per-run',
        defaultSandboxMode: 'auto-isolated',
        environmentOverrides: [],
        unsafe: false,
      });

      // Disabling resume without clearing resumeCommandTemplate must fail
      await expect(service.updateCustomProfile({ id: created.id, supportsResume: false })).rejects.toThrow(/resume command template/i);

      // Disabling model selection without clearing defaultModel must fail
      await expect(service.updateCustomProfile({ id: created.id, supportsModelSelection: false })).rejects.toThrow(/model/i);

      // Disabling reasoning selection without clearing reasoningEffort must fail
      await expect(service.updateCustomProfile({ id: created.id, supportsReasoningSelection: false })).rejects.toThrow(/reasoning/i);

      // Updating argvTemplate to omit {{reasoningEffort}} while reasoning selection is enabled must fail
      await expect(service.updateCustomProfile({ id: created.id, argvTemplate: ['run', '{{model}}', '{{promptFile}}'] })).rejects.toThrow(/reasoning/i);

      // Valid partial update clearing both works
      const updated = await service.updateCustomProfile({ id: created.id, supportsResume: false, resumeCommandTemplate: null });
      expect(updated.supportsResume).toBe(false);
      expect(updated).toMatchObject({ executionKind: 'normal', resumeCommandTemplate: null });
      await service.shutdown();
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('crosses CRUD, persistence, confirmation, isolated execution, and prompt-file cleanup at the service boundary', async () => {
    const root = tempRoot('service');
    const database = InterleafDatabase.open(':memory:');
    try {
      runMigrations(database);
      database.raw.prepare(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('test-doc', 'Test Doc', 'pdf', '/tmp/test-doc.pdf', 'managed', 100, 100, 'hash')
      `).run();
      const executablePath = join(root, 'agent');
      const executablePath2 = join(root, 'agent2');
      mkdirSync(join(root, 'workspace'));
      writeExecutable(executablePath, '#!/bin/sh\ncat "$1"\n');
      writeExecutable(executablePath2, '#!/bin/sh\ncat "$1"\n');
      const executableRegistry = new ExecutableRegistry();
      class TestRegistry extends AgentRegistry {
        override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
      }
      let allowRun = false;
      let chosenExecutable = executablePath;
      const service = createTestAgentService({ database: database,
        repository: new AgentRepository(database),
        registry: new WorkingDirectoryRegistry(),
        agentRegistry: new TestRegistry(testAgentRegistryOptions({ executableRegistry, promptRoot: join(root, 'prompts') })),
        contextRoot: join(root, 'context'),
        chooseDirectory: () => Promise.resolve(root),
        chooseExecutable: () => Promise.resolve(chosenExecutable),
        log: quietLog,
        isPackaged: false,
        isGitRepository: () => Promise.resolve(false),
        customProfiles: new CustomAgentProfileRepository(database),
        executableRegistry,
        confirmDangerousAgentRun: () => Promise.resolve(allowRun),
      });
      await service.initialize();
      const selection = await service.selectExecutable();
      expect(selection?.handle).toMatch(/^[0-9a-f-]{36}$/iu);
      const request = (name: string) => ({
        name, executableHandle: selection?.handle ?? '', executionKind: 'normal' as const, argvTemplate: ['{{promptFile}}'],
        promptDeliveryMode: 'temp-file' as const, stdoutParsingMode: 'text' as const, defaultModel: null, reasoningEffort: null,
        supportsModelSelection: false, supportsReasoningSelection: false, resumeCommandTemplate: null,
        supportsResume: false, workingDirectoryPolicy: 'select-per-run' as const, defaultSandboxMode: 'auto-isolated' as const,
        environmentOverrides: [], unsafe: false,
      });
      const created = await service.createCustomProfile(request('Service custom'));
      const sibling = await service.createCustomProfile(request('Sibling custom'));
      service.deleteCustomProfile(created.id);
      expect(service.listCustomProfiles().find((profile) => profile.id === sibling.id)?.executable?.handle).toBe(selection?.handle);
      chosenExecutable = executablePath2;
      const replacement = present(await service.selectExecutable(), 'replacement executable');
      await service.updateCustomProfile({ id: sibling.id, executableHandle: replacement.handle });
      await expect(executableRegistry.resolve(selection?.handle ?? '')).rejects.toThrow(/invalid|expired/i);
      const directory = await service.selectWorkingDirectory();
      expect(directory).not.toBeNull();
      await expect(service.startSession({ profileId: sibling.id, workingDirectoryHandle: directory?.handle ?? '', executionMode: 'auto-isolated', prompt: 'secret prompt', documentId: 'test-doc' }, 77)).rejects.toThrow(/cancelled/i);
      expect(service.listSessions('test-doc')).toHaveLength(0);
      allowRun = true;
      const started = await service.startSession({ profileId: sibling.id, workingDirectoryHandle: directory?.handle ?? '', executionMode: 'auto-isolated', prompt: 'secret prompt', documentId: 'test-doc' }, 77);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = service.getSession(started.session.id)?.status;
        if (status === 'completed') break;
        await delay(10);
      }
      expect(service.getSession(started.session.id)?.status).toBe('completed');
      expect(service.getSession(started.session.id)?.events.some((event) => event.type === 'stdout' && typeof event.text === 'string' && event.text.includes('secret prompt'))).toBe(true);
      expect(leftoverPrompts(join(root, 'prompts'))).toHaveLength(0);
      await expect(service.startSession({ profileId: sibling.id, workingDirectoryHandle: directory?.handle ?? '', executionMode: 'active-env', prompt: 'direct requires grant', documentId: 'test-doc' }, 77)).rejects.toThrow(/grant/i);
      expect(service.listSessions('test-doc')).toHaveLength(1);
      await service.shutdown();
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
