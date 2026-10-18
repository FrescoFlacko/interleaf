import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { ExecutableRegistry, validateShellExecutable, isKnownShellBinary } from '@main/agents/executable-registry';
import { AgentRegistry, CliAgentAdapter, type AgentAdapter } from '@main/agents/agent-adapter';
import { TestAgentRegistry } from '../helpers/agent-registry';
import type { AgentServiceOptions } from '@main/agents/agent-service';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { createDangerousAgentRunConfirmationOptions, createExpertShellProfileConfirmationOptions } from '@main/agents/native-confirmations';
import { ProcessRunner, type ProcessRunnerRequest } from '@main/agents/process-runner';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { createCustomAgentProfileRequestSchema } from '@shared/schemas/custom-agent-profile';
import { RESOLVED_AGENT_EXECUTION_MODES, resolveAgentRiskLevel } from '@shared/constants/agent-modes';
import type { Logger } from '@main/logging/logger';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type RegisteredExecutable = Awaited<ReturnType<ExecutableRegistry['register']>>;

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `interleaf-${prefix}-`));
}

function writeShell(path: string, body = 'exit 0'): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** The adapter the registry built for a profile it has already registered. */
function registeredAdapter(registry: AgentRegistry, profileId: string): AgentAdapter {
  const adapter = registry.getAdapter(profileId);
  if (adapter === undefined) throw new Error('The custom profile was not registered.');
  return adapter;
}

/** A service over an in-memory database whose executable picker returns `shellPath`. */
async function openShellService(root: string, shellPath: string, overrides: Partial<AgentServiceOptions> = {}) {
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  const executables = new ExecutableRegistry();
  const service = createTestAgentService({
    database: db,
    repository: new AgentRepository(db),
    registry: new WorkingDirectoryRegistry(),
    agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry: executables })),
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(root),
    chooseExecutable: () => Promise.resolve(shellPath),
    log: logger,
    isPackaged: false,
    customProfiles: new CustomAgentProfileRepository(db),
    executableRegistry: executables,
    ...overrides,
  });
  await service.initialize();
  return { db, service, executables };
}

type Tuning = { readonly tunable: boolean; readonly resumeShellCommand: string | null; readonly defaultModel: string | null; readonly reasoningEffort: 'high' | null };
const UNTUNED: Tuning = { tunable: false, resumeShellCommand: null, defaultModel: null, reasoningEffort: null };

/** A registered POSIX Expert Shell profile; a tunable `tuning` turns on resume, model and reasoning selection. */
function expertProfile(
  executable: RegisteredExecutable,
  name: string,
  shellCommand: string,
  { tunable, resumeShellCommand, defaultModel, reasoningEffort }: Tuning = UNTUNED,
): MainAgentProfile {
  return {
    id: `custom:${randomUUID()}`,
    providerId: 'custom',
    name,
    binaryPath: executable.canonicalPath,
    defaultArgs: [],
    defaultModel,
    reasoningEffort,
    permissionMode: 'custom',
    defaultSandboxMode: 'auto-isolated',
    workingDirectoryPolicy: 'select-per-run',
    capabilities: { structuredOutput: false, sessionResume: tunable, nativeSandbox: false, workingDirectory: true, modelSelection: tunable, reasoningSelection: tunable, fileChangeEvents: false, toolEvents: false, subagents: false, interactiveAuthentication: false, nonInteractiveMode: true },
    detection: { availability: 'installed', binaryPath: null, version: null, checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: true,
    unsafe: false,
    executableHandle: executable.handle,
    executableIdentity: executable.identity,
    customConfig: {
      version: 1,
      executionKind: 'expert-shell',
      shellFamily: 'posix',
      shellCommand,
      resumeShellCommand,
      promptDeliveryMode: 'stdin',
      stdoutParsingMode: 'text',
      defaultModel,
      reasoningEffort,
      supportsModelSelection: tunable,
      supportsReasoningSelection: tunable,
      supportsResume: tunable,
      workingDirectoryPolicy: 'select-per-run',
      defaultSandboxMode: 'auto-isolated',
      environmentOverrides: [],
      unsafe: false,
    },
  };
}

function startExpertRun(adapter: CliAgentAdapter, profile: MainAgentProfile, canonicalWorkingDirectory: string) {
  return adapter.start({
    documentId: 'test-doc',
    profileId: profile.id,
    workingDirectoryHandle: 'handle-1',
    executionMode: 'isolated-copy',
    prompt: 'test prompt',
    canonicalWorkingDirectory,
    model: null,
    contextPacket: null,
    riskConfirmation: null,
  });
}

/** A runner that records each request and replays `started`, one middle event, then a clean `ended`. */
function scriptedRunner(
  onRun: (request: ProcessRunnerRequest) => void,
  middle: 'stdout' | 'final',
) {
  return {
    run: (request: ProcessRunnerRequest) => {
      onRun(request);
      return {
        runId: 'fixture-run',
        events: (async function* () {
          await Promise.resolve();
          yield { runId: 'fixture-run', type: 'started' as const, timestamp: new Date().toISOString() };
          if (middle === 'stdout') {
            yield { runId: 'fixture-run', type: 'stdout' as const, stream: 'stdout' as const, text: 'shell output\n', timestamp: new Date().toISOString() };
          } else {
            yield { runId: 'fixture-run', type: 'structured' as const, data: { text: 'completed task' }, structuredKind: 'final' as const, structuredFinalText: 'completed task', timestamp: new Date().toISOString() };
          }
          yield { runId: 'fixture-run', type: 'ended' as const, exitCode: 0, signal: null, timestamp: new Date().toISOString() };
        })(),
        completion: Promise.resolve(),
        cancel: () => undefined,
      };
    },
  };
}

describe('Expert Shell Mode Core & Security Boundaries', () => {
  it('rates Expert Shell and unsafe profiles CRITICAL in every available execution mode', () => {
    // Item N: one main-owned predicate answers for mode resolution,
    // confirmation, persistence, and the UI label. Isolation limits the blast
    // radius of writes; it does not limit the authority the process holds.
    for (const mode of RESOLVED_AGENT_EXECUTION_MODES) {
      expect(resolveAgentRiskLevel({ mode, dangerousProfile: true })).toBe('critical');
      expect(resolveAgentRiskLevel({ mode, dangerousProfile: true, unverifiedProfile: true })).toBe('critical');
    }

    // Ordinary profiles keep the existing mode taxonomy.
    expect(resolveAgentRiskLevel({ mode: 'isolated-worktree', dangerousProfile: false })).toBe('medium');
    expect(resolveAgentRiskLevel({ mode: 'isolated-copy', dangerousProfile: false })).toBe('medium');
    expect(resolveAgentRiskLevel({ mode: 'native-restricted', dangerousProfile: false })).toBe('medium');
    expect(resolveAgentRiskLevel({ mode: 'container-sandbox', dangerousProfile: false })).toBe('low');
    expect(resolveAgentRiskLevel({ mode: 'active-env', dangerousProfile: false })).toBe('high');
    // A renderer-configured but not unsafe profile is still unverified.
    expect(resolveAgentRiskLevel({ mode: 'isolated-copy', dangerousProfile: false, unverifiedProfile: true })).toBe('high');
  });

  it('keeps the dedicated Expert Shell profile warning distinct from each-run warnings', () => {
    const profileWarning = createExpertShellProfileConfirmationOptions('Configured Shell');
    expect(profileWarning.buttons).toEqual(['Cancel', 'Enable Expert Shell']);
    expect(profileWarning.defaultId).toBe(0);
    expect(profileWarning.cancelId).toBe(0);
    expect(profileWarning.message).toMatch(/configured shell command.*full OS user authority/i);
    expect(profileWarning.message).toMatch(/before every start and resume/i);

    const runWarning = createDangerousAgentRunConfirmationOptions({
      profileName: 'Configured Shell',
      canonicalTargetPath: '/tmp/workspace',
      riskLevel: 'critical',
      expertShell: true,
    });
    expect(runWarning.title).toBe('Confirm Expert Shell run');
    expect(runWarning.message).toMatch(/CRITICAL: Expert Shell/);
    expect(runWarning.message).toMatch(/full OS user authority/i);
    expect(runWarning.message).toMatch(/exact Expert Shell start or resume/i);
    expect(runWarning.message).not.toMatch(/Renderer-configured executables\/argv are not trusted/i);

    const genericWarning = createDangerousAgentRunConfirmationOptions({
      profileName: 'Normal Custom',
      canonicalTargetPath: '/tmp/workspace',
      riskLevel: 'high',
    });
    expect(genericWarning.title).toBe('Confirm dangerous agent run');
    expect(genericWarning.message).toMatch(/Renderer-configured executables\/argv are not trusted/i);
    expect(genericWarning.message).not.toMatch(/full OS user authority/i);
  });

  describe('Schema and Discriminated Union Rules', () => {
    const normal = { name: 'Normal invalid', executionKind: 'normal' } as const;
    const expert = { name: 'Expert invalid', executionKind: 'expert-shell', shellFamily: 'posix' } as const;
    it.each([
      ['normal mode rejects a shell family', { ...normal, argvTemplate: ['--prompt', '{{promptFile}}'], promptDeliveryMode: 'temp-file', shellFamily: 'posix' }, /shell family is only allowed on expert shell profiles/i],
      ['normal mode rejects a shell command', { ...normal, argvTemplate: ['--prompt', '{{promptFile}}'], promptDeliveryMode: 'temp-file', shellCommand: 'echo hello' }, /shell command is only allowed on expert shell profiles/i],
      ['expert mode rejects an argument template', { ...expert, shellCommand: 'echo hello', argvTemplate: ['--prompt', '{{promptFile}}'] }, /do not accept an argument template/i],
      ['expert mode rejects non-stdin prompt delivery', { ...expert, shellCommand: 'echo hello', promptDeliveryMode: 'temp-file' }, /require stdin prompt delivery/i],
      ['normal mode rejects a POSIX -c eval flag', { ...normal, argvTemplate: ['-c', 'echo hello'], promptDeliveryMode: 'stdin' }, /direct shell evaluation flags are not allowed in normal mode/i],
      ['normal mode rejects a PowerShell -Command eval flag', { ...normal, argvTemplate: ['-Command', 'Write-Host hello'], promptDeliveryMode: 'stdin' }, /direct shell evaluation flags are not allowed in normal mode/i],
      ['expert resume requires a resume command', { ...expert, shellCommand: 'echo run', supportsResume: true }, /resume capability requires a resume shell command/i],
      ['an expert resume command requires resume enabled', { ...expert, shellCommand: 'echo run', supportsResume: false, resumeShellCommand: 'echo resume' }, /resume shell command requires session resume to be enabled/i],
    ])('%s', (_label, fields, error) => {
      expect(() => {
        createCustomAgentProfileRequestSchema.parse({ executableHandle: randomUUID(), ...fields });
      }).toThrow(error);
    });
  });

  describe('Shell Family & Binary Allowlist Validation', () => {
    it.each([
      ['/bin/bash', 'posix', 'darwin'],
      ['/usr/local/bin/fish', 'posix', 'darwin'],
      ['/usr/local/bin/pwsh', 'powershell', 'darwin'],
      ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell', 'win32'],
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell', 'win32'],
      ['C:\\Windows\\System32\\cmd.exe', 'cmd', 'win32'],
    ] as const)('accepts %s as a %s shell on %s', (path, family, platform) => {
      expect(() => { validateShellExecutable(path, family, platform); }).not.toThrow();
    });

    it.each([
      ['/bin/bash', 'posix', 'win32', /not supported on windows/i],
      ['/usr/bin/node', 'posix', 'darwin', /not an allowed posix shell/i],
      ['/usr/bin/python3', 'posix', 'linux', /not an allowed posix shell/i],
      ['/bin/bash', 'powershell', 'darwin', /not an allowed powershell binary/i],
      ['/bin/cmd', 'cmd', 'darwin', /only supported on windows/i],
      ['C:\\Windows\\System32\\notepad.exe', 'cmd', 'win32', /not an allowed cmd shell/i],
    ] as const)('rejects %s as a %s shell on %s', (path, family, platform, error) => {
      expect(() => { validateShellExecutable(path, family, platform); }).toThrow(error);
    });

    it('identifies common shell binaries for rejection in normal mode', () => {
      expect(isKnownShellBinary('/bin/bash')).toBe(true);
      expect(isKnownShellBinary('/bin/sh')).toBe(true);
      expect(isKnownShellBinary('/usr/bin/zsh')).toBe(true);
      expect(isKnownShellBinary('C:\\Windows\\System32\\cmd.exe')).toBe(true);
      expect(isKnownShellBinary('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
      expect(isKnownShellBinary('/usr/local/bin/my-agent-cli')).toBe(false);
    });
  });

  describe('Service Creation & Normal Mode Rejection of Shell Binaries', () => {
    it('normal mode rejects direct shell binary selection and requires expert mode', async () => {
      const root = tempRoot('normal-shell-reject');
      const { db, service } = await openShellService(root, writeShell(join(root, 'bash'), 'echo "shell"'));
      try {
        const selected = await service.selectExecutable();
        expect(selected).not.toBeNull();

        await expect(service.createCustomProfile({
          name: 'Normal disguised shell',
          executableHandle: selected!.handle,
          executionKind: 'normal',
          argvTemplate: ['--version'],
          promptDeliveryMode: 'stdin',
        })).rejects.toThrow(/direct shell executables must be configured using expert shell mode/i);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('requires dedicated native warning dialog on expert shell profile creation and edit', async () => {
      const root = tempRoot('expert-create-confirm');
      let expertConfirmCount = 0;
      let allowExpertConfirm = false;
      const expertProfileNames: string[] = [];
      const { db, service } = await openShellService(root, writeShell(join(root, 'bash'), 'echo "shell"'), {
        confirmExpertShellProfile: (profileName) => {
          expertProfileNames.push(profileName);
          expertConfirmCount += 1;
          return Promise.resolve(allowExpertConfirm);
        },
      });
      try {
        const selected = await service.selectExecutable();
        expect(selected).not.toBeNull();

        // Declined confirmation -> must fail closed
        await expect(service.createCustomProfile({
          name: 'Expert shell agent',
          executableHandle: selected!.handle,
          executionKind: 'expert-shell',
          shellFamily: 'posix',
          shellCommand: 'echo "running"',
        })).rejects.toThrow(/expert custom shell profile creation was cancelled/i);
        expect(expertConfirmCount).toBe(1);
        expect(expertProfileNames).toEqual(['Expert shell agent']);
        expect(service.listCustomProfiles()).toHaveLength(0);

        // Allowed confirmation -> succeeds
        allowExpertConfirm = true;
        const created = await service.createCustomProfile({
          name: 'Expert shell agent',
          executableHandle: selected!.handle,
          executionKind: 'expert-shell',
          shellFamily: 'posix',
          shellCommand: 'echo "running"',
          supportsResume: true,
          resumeShellCommand: 'echo "resuming"',
        });

        expect(created.executionKind).toBe('expert-shell');
        if (created.executionKind !== 'expert-shell') throw new Error('Expected expert shell profile');
        expect(created.shellFamily).toBe('posix');
        expect(created.shellCommand).toBe('echo "running"');
        expect(created.resumeShellCommand).toBe('echo "resuming"');
        expect(created.promptDeliveryMode).toBe('stdin');

        await service.shutdown();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);

    it('confirms every Expert Shell authority change once while allowing metadata-only edits', async () => {
      const root = tempRoot('expert-update-authority');
      const firstShell = writeShell(join(root, 'bash'));
      // The shell-family allowlist uses the basename, so both selected
      // executables need the POSIX shell name while remaining separate files.
      mkdirSync(join(root, 'second'));
      const secondShellPath = writeShell(join(root, 'second', 'bash'));

      let selectedPath = firstShell;
      let allow = true;
      let confirmationCount = 0;
      const { db, service } = await openShellService(root, firstShell, {
        chooseExecutable: () => Promise.resolve(selectedPath),
        confirmExpertShellProfile: () => {
          confirmationCount += 1;
          return Promise.resolve(allow);
        },
      });
      try {
        const firstSelection = await service.selectExecutable();
        expect(firstSelection).not.toBeNull();
        const created = await service.createCustomProfile({
          name: 'Authority-gated shell',
          executableHandle: firstSelection!.handle,
          executionKind: 'expert-shell',
          shellFamily: 'posix',
          shellCommand: 'echo first',
          supportsResume: true,
          resumeShellCommand: 'echo resume-first',
        });
        expect(confirmationCount).toBe(1);

        await service.updateCustomProfile({ id: created.id, name: 'Renamed shell' });
        expect(confirmationCount).toBe(1);

        allow = false;
        await expect(service.updateCustomProfile({ id: created.id, shellCommand: 'echo declined' })).rejects.toThrow(/cancelled/i);
        expect(confirmationCount).toBe(2);
        expect(service.listCustomProfiles().find((profile) => profile.id === created.id)).toMatchObject({ name: 'Renamed shell', shellCommand: 'echo first' });

        allow = true;
        await service.updateCustomProfile({ id: created.id, shellCommand: 'echo second' });
        expect(confirmationCount).toBe(3);
        await service.updateCustomProfile({ id: created.id, resumeShellCommand: 'echo resume-second' });
        expect(confirmationCount).toBe(4);

        const sameAuthoritySelection = await service.selectExecutable();
        await service.updateCustomProfile({ id: created.id, executableHandle: sameAuthoritySelection!.handle });
        expect(confirmationCount).toBe(4);

        selectedPath = secondShellPath;
        const secondSelection = await service.selectExecutable();
        await service.updateCustomProfile({ id: created.id, executableHandle: secondSelection!.handle });
        expect(confirmationCount).toBe(5);
        expect(service.listCustomProfiles().find((profile) => profile.id === created.id)?.executable?.handle).toBe(secondSelection!.handle);
        await service.shutdown();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);
  });

  describe('Expert Shell Process Execution, Fixed Argv, Stdin Delivery, and Redaction', () => {
    it('executes POSIX family with -lc COMMAND, shell false, stdin prompt, and minimal environment with full redaction', async () => {
      let runnerRequest: ProcessRunnerRequest | undefined;
      const executables = new ExecutableRegistry();
      const root = tempRoot('exec-posix');
      try {
        const executable = await executables.register(writeShell(join(root, 'bash')));
        const profile = expertProfile(executable, 'Posix Shell', './run-agent.sh; rm -rf / ; $(whoami)', {
          tunable: true,
          resumeShellCommand: './resume-agent.sh',
          defaultModel: 'gpt-4o',
          reasoningEffort: 'high',
        });

        const adapter = new CliAgentAdapter(profile, scriptedRunner((request) => { runnerRequest = request; }, 'stdout'), ...adapterCollaborators(executables));
        const run = adapter.start({
          documentId: 'test-doc',
          profileId: profile.id,
          workingDirectoryHandle: 'handle-1',
          executionMode: 'isolated-copy',
          prompt: 'This is the user prompt with untrusted data <document>test</document>',
          canonicalWorkingDirectory: join(root, 'workspace'),
          sessionId: 'sess-expert-123',
          model: 'gpt-4o-2026',
          contextPacket: null,
          riskConfirmation: null,
        });

        await run.completion;

        expect(runnerRequest).toBeDefined();
        // Exact child file is executed
        expect(runnerRequest!.file).toBe(executable.canonicalPath);
        // Fixed tokenized family arguments: ['-lc', COMMAND]
        expect(runnerRequest!.args).toEqual(['-lc', './run-agent.sh; rm -rf / ; $(whoami)']);
        // Prompt is delivered strictly on stdin, not in command string or argv
        expect(runnerRequest!.stdin).toBe('This is the user prompt with untrusted data <document>test</document>');
        // Cwd is the prepared workspace
        expect(runnerRequest!.cwd).toBe(join(root, 'workspace'));

        // Minimal child environment contains main-owned bounded values
        const env = runnerRequest!.env!;
        expect(env.INTERLEAF_SESSION_ID).toBe('sess-expert-123');
        expect(env.INTERLEAF_RUN_ID).toMatch(/^[0-9a-f-]{36}$/iu);
        expect(env.INTERLEAF_MODEL).toBe('gpt-4o-2026');
        expect(env.INTERLEAF_REASONING_EFFORT).toBe('high');
        expect(env.INTERLEAF_WORKING_DIR).toBe(join(root, 'workspace'));

      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects shell executable stored inside the prepared workspace', async () => {
      const executables = new ExecutableRegistry();
      const root = tempRoot('inside-workspace');
      try {
        const workspace = join(root, 'workspace');
        mkdirSync(workspace);
        const executable = await executables.register(writeShell(join(workspace, 'bash')));
        const profile = expertProfile(executable, 'Inside workspace shell', 'echo inside');

        const adapter = new CliAgentAdapter(profile, new ProcessRunner(), ...adapterCollaborators(executables));
        expect(() => {
          startExpertRun(adapter, profile, realpathSync(workspace));
        }).toThrow(/cannot be stored inside the prepared agent workspace/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('fails closed when shell executable identity changes between registration and execution', async () => {
      const executables = new ExecutableRegistry();
      const root = tempRoot('swapped-shell');
      try {
        const shellPath = writeShell(join(root, 'bash'));
        const executable = await executables.register(shellPath);
        const profile = expertProfile(executable, 'Swapped shell', 'echo run');

        // Modify executable on disk (simulating Trojan swap after selection)
        writeShell(shellPath, 'echo "swapped payload"');

        const adapter = new CliAgentAdapter(profile, new ProcessRunner(), ...adapterCollaborators(executables));
        expect(() => {
          startExpertRun(adapter, profile, join(root, 'workspace'));
        }).toThrow(/changed and execution was stopped/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('End-to-End Native Confirmation, Double-Gating, Decline, and Resume', () => {
    it('requires fresh native confirmation on start & resume, critical risk level, and decline creates no session or process', async () => {
      const root = tempRoot('e2e-expert-service');
      const target = join(root, 'workspace');
      mkdirSync(target);

      const dangerousConfirmationCalls: { riskLevel: string; expertShell?: boolean | undefined }[] = [];
      let allowDangerousRun = false;

      let spawnCalls = 0;
      let lastSpawnArgs: readonly string[] = [];
      const mockRunner = scriptedRunner((request) => {
        spawnCalls += 1;
        lastSpawnArgs = request.args;
      }, 'final');

      class TestRegistry extends TestAgentRegistry {
        override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
      }

      const executables = new ExecutableRegistry();
      const agentRegistry = new TestRegistry(testAgentRegistryOptions({ executableRegistry: executables, logger }));
      const { db, service } = await openShellService(root, writeShell(join(root, 'bash')), {
        agentRegistry,
        executableRegistry: executables,
        environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
        chooseDirectory: () => Promise.resolve(target),
        confirmExpertShellProfile: () => Promise.resolve(true),
        confirmDangerousAgentRun: (input) => {
          dangerousConfirmationCalls.push({ riskLevel: input.riskLevel, expertShell: input.expertShell });
          return Promise.resolve(allowDangerousRun);
        },
      });
      db.raw.prepare(`
        INSERT INTO documents
          (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('test-doc', 'Test Doc', 'pdf', '/tmp/test-doc.pdf', 'managed', 100, 100, 'hash')
      `).run();

      try {
        const selectedExec = await service.selectExecutable();
        const profile = await service.createCustomProfile({
          name: 'Dangerous Shell Agent',
          executableHandle: selectedExec!.handle,
          executionKind: 'expert-shell',
          shellFamily: 'posix',
          shellCommand: './run-test.sh',
          resumeShellCommand: './resume-test.sh',
          supportsResume: true,
          supportsModelSelection: true,
          supportsReasoningSelection: true,
          defaultModel: 'gpt-4o-mini',
          reasoningEffort: 'medium',
        });

        // Patch adapter with mock runner
        const registered = registeredAdapter(agentRegistry, profile.id);
        agentRegistry.installAdapter(new CliAgentAdapter(registered.profile, mockRunner, ...adapterCollaborators(executables)));

        const dir = await service.selectWorkingDirectory();
        expect(dir).not.toBeNull();

        // 1. Start Session with Declined Confirmation
        allowDangerousRun = false;
        await expect(service.startSession({
          profileId: profile.id,
          workingDirectoryHandle: dir!.handle,
          executionMode: 'auto-isolated',
          prompt: 'test prompt',
          documentId: 'test-doc',
        }, 1)).rejects.toThrow(/expert custom shell execution was cancelled/i);

        // Verification: No session, no spawn, no environment created
        expect(dangerousConfirmationCalls).toHaveLength(1);
        expect(dangerousConfirmationCalls[0]?.riskLevel).toBe('critical');
        expect(dangerousConfirmationCalls[0]?.expertShell).toBe(true);
        expect(service.listSessions('test-doc')).toHaveLength(0);
        expect(spawnCalls).toBe(0);

        // 2. Start Session with Allowed Confirmation
        allowDangerousRun = true;
        const started = await service.startSession({
          profileId: profile.id,
          workingDirectoryHandle: dir!.handle,
          executionMode: 'auto-isolated',
          prompt: 'start expert shell',
          model: 'o3-mini',
          documentId: 'test-doc',
        }, 1);

        await vi.waitFor(() => { expect(service.getSession(started.session.id)?.status).toBe('completed'); });
        expect(spawnCalls).toBe(1);
        expect(lastSpawnArgs).toEqual(['-lc', './run-test.sh']);
        expect(dangerousConfirmationCalls).toHaveLength(2);
        expect(dangerousConfirmationCalls[1]?.riskLevel).toBe('critical');
        expect(dangerousConfirmationCalls[1]?.expertShell).toBe(true);

        // Item N: workspace isolation bounds what the shell writes, not what
        // authority it holds, so the persisted level the UI renders is the
        // same CRITICAL the confirmation stated.
        expect(service.getSession(started.session.id)?.environment?.riskLevel).toBe('critical');

        // Verify session persisted snapshot
        const sessionRecord = service.getSession(started.session.id);
        expect(sessionRecord?.effectiveModel).toBe('o3-mini');
        expect(sessionRecord?.effectiveReasoningEffort).toBe('medium');

        // 3. Resume with Declined Confirmation
        allowDangerousRun = false;
        await expect(service.resumeSession({
          sessionId: started.session.id,
          prompt: 'resume follow-up',
        }, 1)).rejects.toThrow(/expert custom shell execution was cancelled/i);

        expect(dangerousConfirmationCalls).toHaveLength(3);
        expect(dangerousConfirmationCalls[2]?.riskLevel).toBe('critical');
        expect(dangerousConfirmationCalls[2]?.expertShell).toBe(true);
        expect(spawnCalls).toBe(1); // No new spawn

        // 4. Resume with Allowed Confirmation -> Uses static resume command
        allowDangerousRun = true;
        await service.resumeSession({
          sessionId: started.session.id,
          prompt: 'resume follow-up success',
        }, 1);

        await vi.waitFor(() => { expect(service.getSession(started.session.id)?.status).toBe('completed'); });
        expect(spawnCalls).toBe(2);
        expect(lastSpawnArgs).toEqual(['-lc', './resume-test.sh']);
        expect(dangerousConfirmationCalls).toHaveLength(4);
        expect(dangerousConfirmationCalls[3]?.riskLevel).toBe('critical');

        await service.shutdown();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('enforces double gating when expert shell is executed in direct workspace mode (active-env)', async () => {
      const root = tempRoot('double-gate-expert');
      const target = join(root, 'workspace');
      mkdirSync(target);

      let directConfirmCount = 0;
      let dangerousConfirmCount = 0;
      const { db, service } = await openShellService(root, writeShell(join(root, 'bash')), {
        environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
        chooseDirectory: () => Promise.resolve(target),
        confirmExpertShellProfile: () => Promise.resolve(true),
        confirmDirectWorkspace: () => {
          directConfirmCount += 1;
          return Promise.resolve(true);
        },
        confirmDangerousAgentRun: () => {
          dangerousConfirmCount += 1;
          return Promise.resolve(false);
        },
      });

      try {
        const selectedExec = await service.selectExecutable();
        const profile = await service.createCustomProfile({
          name: 'Direct Expert Shell',
          executableHandle: selectedExec!.handle,
          executionKind: 'expert-shell',
          shellFamily: 'posix',
          shellCommand: 'echo direct',
        });

        const dir = await service.selectWorkingDirectory();

        // Declining dangerous run confirmation aborts start even if direct grant is present
        const draftId = randomUUID();
        const grant = await service.issueRiskGrant({
          draftId,
          profileId: profile.id,
          workingDirectoryHandle: dir!.handle,
          executionMode: 'active-env',
          prompt: 'test direct',
          model: null,
          contextPacket: null,
        }, 1);
        expect(directConfirmCount).toBe(1);

        await expect(service.startSession({
          profileId: profile.id,
          workingDirectoryHandle: dir!.handle,
          executionMode: 'active-env',
          prompt: 'test direct',
          riskConfirmation: { grantId: grant.grantId, draftId: draftId },
          documentId: 'test-doc',
        }, 1)).rejects.toThrow(/expert custom shell execution was cancelled/i);
        expect(dangerousConfirmCount).toBe(1);
        expect(service.listSessions('test-doc')).toHaveLength(0);

        await service.shutdown();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
