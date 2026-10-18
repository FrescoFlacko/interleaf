import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { ExecutableRegistry } from '@main/agents/executable-registry';
import { AgentRegistry } from '@main/agents/agent-adapter';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import type { Logger } from '@main/logging/logger';
import type { AgentService, AgentServiceOptions } from '@main/agents/agent-service';
import { createTestAgentService } from '../helpers/agent-service';
import { posixShell, testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `interleaf-integration-${prefix}-`));
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => { resolve(); }, ms);
  });
}

function writeScript(path: string, lines: readonly string[]): void {
  writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n', { mode: 0o755 });
  chmodSync(path, 0o755);
}

async function waitForTerminal(service: AgentService, sessionId: string, attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const status = service.getSession(sessionId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return;
    await delay(10);
  }
}

/** A real AgentService over an in-memory database with one seeded document and the canonical `/bin/sh` as the chosen executable. */
async function createExpertService(root: string, chooseTarget: () => string, extra: Partial<Pick<AgentServiceOptions, 'clipboard'>> = {}) {
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-expert', 'Doc Expert', 'pdf', '/tmp/expert.pdf', 'managed', 100, 100, 'hash-expert')
  `).run();
  const repository = new AgentRepository(db);
  const executables = new ExecutableRegistry();
  const service = createTestAgentService({
    database: db,
    repository,
    registry: new WorkingDirectoryRegistry(),
    agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry: executables, logger })),
    contextRoot: join(root, 'context'),
    environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
    chooseDirectory: () => Promise.resolve(chooseTarget()),
    chooseExecutable: () => Promise.resolve(posixShell()),
    log: logger,
    isPackaged: false,
    customProfiles: new CustomAgentProfileRepository(db),
    executableRegistry: executables,
    confirmExpertShellProfile: () => Promise.resolve(true),
    confirmDangerousAgentRun: () => Promise.resolve(true),
    ...extra,
  });
  await service.initialize();
  const selectedExec = await service.selectExecutable();
  expect(selectedExec).not.toBeNull();
  return { db, repository, service, executableHandle: selectedExec!.handle };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Expert Shell Real Execution & Environment Integration', () => {
  it('executes real shell script, receives prompt on stdin, passes main-owned and inherited env values visibly, and redacts credential shapes', async () => {
    if (process.platform === 'win32') return; // POSIX shell test on macOS/Linux

    const root = tempRoot('expert-real-exec');
    const target = join(root, 'workspace');
    mkdirSync(target, { recursive: true });

    const scriptPath = join(root, 'agent-runner.sh');
    writeScript(scriptPath, [
      '# Read full prompt from stdin',
      'PROMPT_INPUT=$(cat)',
      'echo "PROMPT_RECEIVED:$PROMPT_INPUT"',
      'echo "SESSION:$INTERLEAF_SESSION_ID"',
      'echo "MODEL:$INTERLEAF_MODEL"',
      'echo "EFFORT:$INTERLEAF_REASONING_EFFORT"',
      'echo "WORKDIR:$INTERLEAF_WORKING_DIR"',
      'echo "HOME:$HOME"',
      'echo "PATH_HEAD:$PATH"',
      'echo "SHELL:$SHELL"',
      'echo "TMPDIR_OVERRIDE:$TMPDIR"',
      'echo "token=super-credential-shape-42f8"',
      'exit 0',
    ]);

    // The inherited value comes from this test, not the host: a CI runner may
    // set no TMPDIR at all, and inheriting an unset name correctly passes
    // nothing. The runner reads the environment at spawn time.
    const inheritedTmpdir = join(root, 'inherited-tmp');
    mkdirSync(inheritedTmpdir);
    vi.stubEnv('TMPDIR', inheritedTmpdir);

    // Shell binary is the canonical /bin/sh (allowed POSIX shell)
    const { db, repository, service, executableHandle } = await createExpertService(root, () => target);

    const profile = await service.createCustomProfile({
      name: 'Real POSIX Shell Agent',
      executableHandle,
      executionKind: 'expert-shell',
      shellFamily: 'posix',
      shellCommand: `"${scriptPath}"`,
      resumeShellCommand: `"${scriptPath}" --resume`,
      supportsResume: true,
      supportsModelSelection: true,
      supportsReasoningSelection: true,
      defaultModel: 'test-model-42',
      reasoningEffort: 'high',
      environmentOverrides: [{ name: 'TMPDIR', action: 'inherit-allowlisted' }],
    });

    const dir = await service.selectWorkingDirectory();
    expect(dir).not.toBeNull();

    // Start Session
    const secretSessionPrompt = 'super-secret-user-instructions';
    const started = await service.startSession({
      documentId: 'doc-expert',
      profileId: profile.id,
      workingDirectoryHandle: dir!.handle,
      executionMode: 'auto-isolated',
      prompt: secretSessionPrompt,
      model: 'custom-model-alpha',
    }, 1);

    await waitForTerminal(service, started.session.id, 100);

    const completed = service.getSession(started.session.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.effectiveModel).toBe('custom-model-alpha');
    expect(completed?.effectiveReasoningEffort).toBe('high');

    // Inspect events:
    const events = repository.listEvents(started.session.id);
    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    const fullStdout = stdoutEvents.map((e) => e.text).join('');

    // Verify prompt was received via stdin
    expect(fullStdout).toContain('PROMPT_RECEIVED:');
    expect(fullStdout).toContain(secretSessionPrompt);
    // Runtime metadata, working directory, and inherited non-secret
    // environment values (ambient HOME/PATH/SHELL and the inherited TMPDIR
    // override) are ordinary local diagnostics and stay visible.
    expect(fullStdout).toContain(`SESSION:${started.session.id}`);
    expect(fullStdout).toMatch(/WORKDIR:[^\n]*agent-workspaces/);
    expect(fullStdout).toContain('EFFORT:high');
    expect(fullStdout).toContain('HOME:');
    expect(fullStdout).toContain('PATH_HEAD:');
    expect(fullStdout).toContain(`TMPDIR_OVERRIDE:${inheritedTmpdir}\n`);
    expect(fullStdout).not.toContain('TMPDIR_OVERRIDE:[REDACTED]');
    // Credential-shaped assignments still redact.
    expect(fullStdout).toContain('token=[REDACTED]');
    expect(fullStdout).not.toContain('super-credential-shape-42f8');

    // Resume Session with the static resume command
    const resumed = await service.resumeSession({
      sessionId: started.session.id,
      prompt: 'follow-up on resume',
    }, 1);

    await waitForTerminal(service, resumed.session.id, 100);

    const resumedDetail = service.getSession(started.session.id);
    expect(resumedDetail?.status).toBe('completed');

    await service.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists a synthesized text-mode final report on clean success and leaves a failed run with nothing to copy', async () => {
    if (process.platform === 'win32') return; // POSIX shell test on macOS/Linux

    // Item M: an Expert Shell run emits no JSON final frame, so its bounded
    // redacted stdout is what Copy has to work from. This walks the whole
    // path: real child process, ProcessRunner redaction, SQLite persistence,
    // the session detail the UI renders, and copyResult.
    const root = tempRoot('expert-final-synthesis');
    // Each run takes its own target: an environment holds its target lock
    // until it is applied or discarded, which is unrelated to what this test
    // is about.
    let target = join(root, 'workspace-ok');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(root, 'workspace-fail'), { recursive: true });

    const okScript = join(root, 'report.sh');
    writeScript(okScript, [
      'cat > /dev/null',
      'echo "Summary: refactored the loader."',
      'echo "token=super-credential-shape-42f8"',
      'exit 0',
    ]);

    const failScript = join(root, 'fail.sh');
    writeScript(failScript, ['cat > /dev/null', 'echo "partial work"', 'exit 3']);

    const clipboardTexts: string[] = [];
    const { db, repository, service, executableHandle } = await createExpertService(root, () => target, {
      clipboard: { writeText: (text) => { clipboardTexts.push(text); return Promise.resolve(); } },
    });

    const runToTerminal = async (shellCommand: string, name: string): Promise<string> => {
      const dir = await service.selectWorkingDirectory();
      expect(dir).not.toBeNull();
      const profile = await service.createCustomProfile({
        name, executableHandle, executionKind: 'expert-shell',
        shellFamily: 'posix', shellCommand,
      });
      const started = await service.startSession({
        documentId: 'doc-expert', profileId: profile.id, workingDirectoryHandle: dir!.handle,
        executionMode: 'auto-isolated', prompt: 'summarize the work',
      }, 1);
      await waitForTerminal(service, started.session.id, 200);
      return started.session.id;
    };

    const okId = await runToTerminal(`"${okScript}"`, 'Synthesis Success Agent');
    const okSession = service.getSession(okId);
    expect(okSession?.status).toBe('completed');
    expect(okSession?.finalReport).toBe('Summary: refactored the loader.\ntoken=[REDACTED]');
    expect(okSession?.finalReport).not.toContain('super-credential-shape-42f8');

    // The synthesized report is the last thing said before the run ends.
    const okTypes = repository.listEvents(okId).map((event) => event.type);
    expect(okTypes.at(-1)).toBe('ended');
    expect(okTypes.at(-2)).toBe('final');
    expect(okTypes.filter((type) => type === 'final')).toHaveLength(1);

    expect(await service.copyResult(okId, 1)).toEqual({ copied: true, characterCount: okSession!.finalReport!.length });
    expect(clipboardTexts).toEqual([okSession?.finalReport]);

    // A flood the bounded runner cannot deliver in full: one read hands the
    // runner more lines than its 256-event queue holds, so frames are dropped.
    // The run still exits zero, and there is still nothing to copy — a report
    // synthesized from what survived would present a hole as the agent's
    // answer. The 400 lines (under 4 KiB) leave the child in a single `cat`
    // write, which the runner reads and splits into frames synchronously: the
    // overflow is not a race with the reader, as one `echo` per line was. Few
    // enough events persist that the drop marker stays in the listed window.
    target = join(root, 'workspace-flood');
    mkdirSync(target, { recursive: true });
    const floodPayload = join(root, 'flood.txt');
    writeFileSync(floodPayload, Array.from({ length: 400 }, (_, line) => `line ${String(line)}\n`).join(''));
    const floodScript = join(root, 'flood.sh');
    writeScript(floodScript, ['cat > /dev/null', `cat '${floodPayload}'`, 'exit 0']);

    const floodId = await runToTerminal(`"${floodScript}"`, 'Synthesis Flood Agent');
    expect(service.getSession(floodId)?.status).toBe('completed');
    const floodTypes = repository.listEvents(floodId).map((event) => event.type);
    expect(floodTypes).toContain('structured');
    expect(floodTypes).not.toContain('final');
    expect(service.getSession(floodId)?.finalReport ?? '').toBe('');
    await expect(service.copyResult(floodId, 1)).rejects.toThrow(/no report/i);
    expect(clipboardTexts).toHaveLength(1);

    target = join(root, 'workspace-fail');
    const failId = await runToTerminal(`"${failScript}"`, 'Synthesis Failure Agent');
    expect(service.getSession(failId)?.status).toBe('failed');
    expect(service.getSession(failId)?.finalReport ?? '').toBe('');
    expect(repository.listEvents(failId).map((event) => event.type)).not.toContain('final');
    await expect(service.copyResult(failId, 1)).rejects.toThrow(/no report/i);
    expect(clipboardTexts).toHaveLength(1);

    await service.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
