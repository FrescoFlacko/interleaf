import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentService } from '@main/agents/agent-service';
import { AgentRegistry, type AgentAdapter, type AgentAdapterRun } from '@main/agents/agent-adapter';
import { expandCustomArgvTemplate } from '@main/agents/custom-argv-template';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { CustomAgentProfileRepository } from '@main/db/repositories/custom-agent-profile-repository';
import { ExecutableRegistry } from '@main/agents/executable-registry';
import { createTestAgentService } from '../helpers/agent-service';
import { testAgentRegistryOptions, withEnvironmentShell } from '../helpers/agent-collaborators';
import {
  GapDirectoryRegistry,
  ReservedResumableAdapter,
  ResumableAdapter,
  TEST_DOCUMENT_ID,
  deferrableConfirmation,
  logger,
  openResumeService,
  setupTestDatabase,
  untilCompleted,
  untilGateReached,
} from '../helpers/agent-resume-fixtures';

/**
 * A resume whose child keeps running after cancellation, standing in for the
 * window between `stopSession` recording `cancelled` and the adapter run being
 * drained and reaped (docs/REMAINING_WORK.md item D).
 */
class StallingResumeAdapter extends ResumableAdapter {
  cancelCalls = 0;
  private announceStarted: () => void = () => undefined;
  private releaseRun: () => void = () => undefined;
  /** Resolves once the resume's child is genuinely producing events. */
  readonly resumeStarted: Promise<void> = new Promise<void>((resolve) => { this.announceStarted = resolve; });
  private readonly stalled: Promise<void> = new Promise<void>((resolve) => { this.releaseRun = resolve; });

  override resume(sessionId: string, request: Parameters<NonNullable<AgentAdapter['resume']>>[1]): AgentAdapterRun {
    this.lastResumeRequest = { providerSessionId: sessionId, ...request };
    const announceStarted = this.announceStarted;
    const stalled = this.stalled;
    return {
      events: (async function* () {
        yield { sessionId: '', ordinal: 0, type: 'started', timestamp: new Date().toISOString() } as const;
        yield { sessionId: '', ordinal: 0, type: 'final', text: 'stalled generation report', timestamp: new Date().toISOString() } as const;
        announceStarted();
        // The child is neither producing nor exiting: cancellation has been
        // requested but nothing has been reaped yet.
        await stalled;
        yield { sessionId: '', ordinal: 0, type: 'ended', exitCode: null, signal: 'SIGKILL', timestamp: new Date().toISOString() } as const;
      })(),
      completion: stalled,
      cancel: () => { this.cancelCalls += 1; },
    };
  }

  /** Stands in for the child finally exiting and being reaped. */
  reap(): void { this.releaseRun(); }
}


function clipboardSink() {
  const texts: string[] = [];
  return { texts, clipboard: { writeText: (text: string) => { texts.push(text); return Promise.resolve(); } } };
}

describe('Agent Resume, Copy Result, and Custom Profile controls', () => {
  it('captures provider thread ID, reuses prepared environment, and appends monotonic events on resume', async () => {
    const sink = clipboardSink();
    const fixture = await openResumeService('interleaf-resume-test-', new ResumableAdapter(), () => ({ clipboard: sink.clipboard }));
    const { service, adapter, db } = fixture;

    // 1. Initial run
    const startResult = await fixture.start('do initial work', 1, { executionMode: 'auto-isolated', model: 'o3-mini' });

    await untilCompleted(service, startResult.session.id);
    const sessionAfterStart = service.getSession(startResult.session.id);
    expect(sessionAfterStart?.status).toBe('completed');
    expect(sessionAfterStart?.providerSessionId).toBe('provider-thread-xyz987');
    expect(sessionAfterStart?.events.length).toBeGreaterThan(0);

    // 2. Test Copy Result
    const copyRes = await service.copyResult(startResult.session.id, 1);
    expect(copyRes).toEqual({ copied: true, characterCount: sessionAfterStart?.finalReport?.length });
    expect(sink.texts).toHaveLength(1);
    expect(sink.texts[0]).toBe(sessionAfterStart?.finalReport);

    // 3. Resume session with follow-up
    const resumeResult = await service.resumeSession({
      sessionId: startResult.session.id,
      prompt: 'continue with step 2',
    }, 1);

    expect(resumeResult.session.id).toBe(startResult.session.id);
    expect(adapter.lastResumeRequest).toMatchObject({
      sessionId: startResult.session.id,
      providerSessionId: 'provider-thread-xyz987',
      prompt: 'continue with step 2',
    });

    await untilCompleted(service, startResult.session.id, { finalReport: 'resumed report' });
    const sessionAfterResume = service.getSession(startResult.session.id);
    expect(sessionAfterResume?.status).toBe('completed');
    expect(sessionAfterResume?.finalReport).toBe('resumed report');

    // Event ordinals must be strictly monotonic
    const ordinals = sessionAfterResume?.events.map((e) => e.ordinal) ?? [];
    expect(ordinals.length).toBeGreaterThan(4);
    for (let i = 1; i < ordinals.length; i++) {
      expect(ordinals[i]).toBe(ordinals[i - 1]! + 1);
    }

    // 4. Reject resume on non-owner
    await expect(service.resumeSession({ sessionId: startResult.session.id, prompt: 'fail' }, 999)).rejects.toThrow(/not owned/i);

    // 5. Reject resume on session older than 24 hours (measured from createdAt even if updatedAt is fresh)
    const pastTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    db.raw.prepare('UPDATE agent_sessions SET created_at = ?, updated_at = ? WHERE id = ?').run(pastTime, new Date().toISOString(), startResult.session.id);
    await expect(service.resumeSession({ sessionId: startResult.session.id, prompt: 'too old' }, 1)).rejects.toThrow(/24 hours/i);

    // 6. Reject future timestamp
    const futureTime = new Date(Date.now() + 120_000).toISOString();
    db.raw.prepare('UPDATE agent_sessions SET created_at = ? WHERE id = ?').run(futureTime, startResult.session.id);
    await expect(service.resumeSession({ sessionId: startResult.session.id, prompt: 'future' }, 1)).rejects.toThrow(/24 hours/i);

    await fixture.close();
  });

  it('reserves resume synchronously across deferred confirmation and starts exactly one live run', async () => {
    const confirmation = deferrableConfirmation();
    const fixture = await openResumeService('interleaf-resume-reservation-', new ReservedResumableAdapter(), () => ({ confirmDangerousAgentRun: confirmation.confirm }));
    const { service, adapter } = fixture;
    const start = await fixture.start('prepare');
    await untilCompleted(service, start.session.id);
    confirmation.deferNext();
    const first = service.resumeSession({ sessionId: start.session.id, prompt: 'resume once' }, 1);
    await vi.waitFor(() => { expect(confirmation.confirm).toHaveBeenCalledTimes(2); });
    await expect(service.discardSandbox(start.session.id, 1)).rejects.toMatchObject({ code: 'validation' });
    const second = service.resumeSession({ sessionId: start.session.id, prompt: 'resume twice' }, 1);
    confirmation.release(true);
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')?.reason).toMatchObject({ code: 'validation' });
    expect(adapter.resumeCalls).toBe(1);
    await untilCompleted(service, start.session.id, { finalReport: 'resumed report' });
    await service.discardSandbox(start.session.id, 1);
    expect(service.getSession(start.session.id)?.environmentState).toBe('discarded');
    await fixture.close();
  });

  it('rejects resume while a deferred apply owns the session lifecycle reservation', async () => {
    let releaseApply!: () => void;
    let applyReached!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    const applyEntered = new Promise<void>((resolve) => { applyReached = resolve; });
    let environmentManager!: AgentEnvironmentManager;
    const fixture = await openResumeService('interleaf-resume-apply-reservation-', new ReservedResumableAdapter(), (appRoot) => {
      environmentManager = new AgentEnvironmentManager(withEnvironmentShell({
        root: appRoot,
        applyFaultInjector: async ({ phase }) => {
          if (phase === 'after-target-mutation') {
            applyReached();
            await applyGate;
          }
          return undefined;
        },
      }));
      return { environmentManager, confirmDangerousAgentRun: () => Promise.resolve(true) };
    });
    const { service, adapter } = fixture;
    const started = await fixture.start('prepare apply race', 3);
    await untilCompleted(service, started.session.id);
    await writeFile(join(environmentManager.getWorkspacePath(started.session.id), 'apply-race.txt'), 'apply\n');
    const apply = service.applyChanges(started.session.id, 3);
    await untilGateReached(applyEntered, apply);
    const resumeCalls = adapter.resumeCalls;
    await expect(service.resumeSession({ sessionId: started.session.id, prompt: 'must wait for apply' }, 3)).rejects.toMatchObject({ code: 'validation' });
    expect(adapter.resumeCalls).toBe(resumeCalls);
    releaseApply();
    await apply;
    expect(service.getSession(started.session.id)?.environmentState).toBe('applied');
    await expect(service.resumeSession({ sessionId: started.session.id, prompt: 'applied stays closed' }, 3)).rejects.toThrow(/already applied/i);
    await fixture.close();
  });

  it('rejects resume while a deferred discard owns the session lifecycle reservation', async () => {
    let releaseDiscard!: () => void;
    let discardReached!: () => void;
    const discardGate = new Promise<void>((resolve) => { releaseDiscard = resolve; });
    const discardEntered = new Promise<void>((resolve) => { discardReached = resolve; });
    const fixture = await openResumeService('interleaf-resume-discard-reservation-', new ReservedResumableAdapter(), (appRoot) => {
      const environmentManager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
      const originalDiscard = environmentManager.discard.bind(environmentManager);
      vi.spyOn(environmentManager, 'discard').mockImplementation(async (sessionId) => {
        discardReached();
        await discardGate;
        await originalDiscard(sessionId);
      });
      return { environmentManager, confirmDangerousAgentRun: () => Promise.resolve(true) };
    });
    const { service, adapter } = fixture;
    const started = await fixture.start('prepare discard race', 4);
    await untilCompleted(service, started.session.id);
    const discard = service.discardSandbox(started.session.id, 4);
    await untilGateReached(discardEntered, discard);
    const resumeCalls = adapter.resumeCalls;
    await expect(service.resumeSession({ sessionId: started.session.id, prompt: 'must wait for discard' }, 4)).rejects.toMatchObject({ code: 'validation' });
    expect(adapter.resumeCalls).toBe(resumeCalls);
    releaseDiscard();
    await discard;
    expect(service.getSession(started.session.id)?.environmentState).toBe('discarded');
    await expect(service.resumeSession({ sessionId: started.session.id, prompt: 'discarded stays closed' }, 4)).rejects.toThrow(/no longer available|start a new session/i);
    await fixture.close();
  });

  // cancelOwner leaves the service open for close(); shutdown already closed it.
  const invalidations = {
    cancelOwner: { invalidate: (service: AgentService, ownerId: number) => service.cancelOwner(ownerId), shutdownOnClose: true },
    shutdown: { invalidate: (service: AgentService) => service.shutdown(), shutdownOnClose: false },
  } as const;

  it.each([
    ['cancelOwner', 51],
    ['shutdown', 52],
  ] as const)('invalidates a deferred start on %s before the adapter spawns', async (invalidation, ownerId) => {
    const confirmation = deferrableConfirmation();
    const fixture = await openResumeService(`interleaf-start-${invalidation}-`, new ReservedResumableAdapter(), () => ({ confirmDangerousAgentRun: confirmation.confirm }));
    const { service, adapter } = fixture;
    const { invalidate, shutdownOnClose } = invalidations[invalidation];

    confirmation.deferNext();
    const pending = fixture.start('deferred start', ownerId);
    await vi.waitFor(() => { expect(confirmation.confirm).toHaveBeenCalledTimes(1); });
    const invalidated = invalidate(service, ownerId);
    confirmation.release(true);
    await invalidated;
    await expect(pending).rejects.toThrow(/cancelled before execution|shutting down/i);
    expect(adapter.startCalls).toBe(0);
    expect(service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);
    await fixture.close(shutdownOnClose);
  });

  it('cancels a start whose owner dies after authorization\'s last liveness proof, before the session row exists', async () => {
    const directories = new GapDirectoryRegistry();
    let cancelled: Promise<void> = Promise.resolve();
    // After an approved confirmation, authorization resolves the handle twice:
    // once in the confirmation step and once as its final await. The owner is
    // cancelled after that final resolve's own liveness proof has passed.
    const confirmDangerousAgentRun = vi.fn(() => {
      directories.afterResolve(2, () => { cancelled = fixture.service.cancelOwner(55); });
      return Promise.resolve(true);
    });
    const fixture = await openResumeService('interleaf-start-gap-', new ReservedResumableAdapter(), () => ({ registry: directories, confirmDangerousAgentRun }));

    await expect(fixture.start('owner dies in the gap', 55)).rejects.toThrow(/cancelled before execution/i);
    await cancelled;
    expect(confirmDangerousAgentRun).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.startCalls).toBe(0);
    expect(fixture.service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);
    await fixture.close();
  });

  it.each([
    ['cancelOwner', 53, ['completed']],
    ['shutdown', 54, []],
  ] as const)('invalidates a deferred resume on %s before adapter resume', async (invalidation, ownerId, expectedStatus) => {
    const confirmation = deferrableConfirmation();
    const fixture = await openResumeService(`interleaf-resume-${invalidation}-`, new ReservedResumableAdapter(), () => ({ confirmDangerousAgentRun: confirmation.confirm }));
    const { service, adapter } = fixture;
    const { invalidate, shutdownOnClose } = invalidations[invalidation];

    const started = await fixture.start('before invalidation', ownerId);
    await untilCompleted(service, started.session.id);
    confirmation.deferNext();
    const pending = service.resumeSession({ sessionId: started.session.id, prompt: 'deferred resume' }, ownerId);
    await vi.waitFor(() => { expect(confirmation.confirm).toHaveBeenCalledTimes(2); });
    const invalidated = invalidate(service, ownerId);
    confirmation.release(true);
    await invalidated;
    await expect(pending).rejects.toThrow(/cancelled before execution|shutting down/i);
    expect(adapter.resumeCalls).toBe(0);
    // A cancelled owner's earlier completed run stays completed.
    expectedStatus.forEach((status) => { expect(service.getSession(started.session.id)?.status).toBe(status); });
    await fixture.close(shutdownOnClose);
  });

  it('fails resume closed after applying the prepared environment without confirmation or spawn', async () => {
    const confirmDangerousAgentRun = vi.fn(() => Promise.resolve(true));
    let environmentManager!: AgentEnvironmentManager;
    const fixture = await openResumeService('interleaf-resume-applied-', new ReservedResumableAdapter(), (appRoot) => {
      environmentManager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
      return { environmentManager, confirmDangerousAgentRun };
    });
    const { service, adapter } = fixture;
    const started = await fixture.start('prepare apply', 2);
    await untilCompleted(service, started.session.id);
    await writeFile(join(environmentManager.getWorkspacePath(started.session.id), 'applied.txt'), 'applied\n');
    await service.applyChanges(started.session.id, 2);
    expect(service.getSession(started.session.id)?.environmentState).toBe('applied');
    const resumeCalls = adapter.resumeCalls;
    const confirmationsBefore = confirmDangerousAgentRun.mock.calls.length;
    await expect(service.resumeSession({ sessionId: started.session.id, prompt: 'must fail closed' }, 2)).rejects.toThrow(/already applied/i);
    expect(adapter.resumeCalls).toBe(resumeCalls);
    expect(confirmDangerousAgentRun).toHaveBeenCalledTimes(confirmationsBefore);
    await fixture.close();
  });

  it('handles custom profile resume, model/reasoning controls, {{reasoningEffort}} expansion, and fresh confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-custom-resume-'));
    const target = join(root, 'workspace');
    const fakeExec = join(root, 'fake-cli.sh');
    await mkdir(target, { recursive: true });
    await writeFile(fakeExec, '#!/bin/sh\n');
    await chmod(fakeExec, 0o755);
    const db = setupTestDatabase();
    const customRepo = new CustomAgentProfileRepository(db);
    const executables = new ExecutableRegistry();

    let confirmationCount = 0;
    let allowConfirmation = true;

    const service = createTestAgentService({ database: db,
      repository: new AgentRepository(db),
      registry: new WorkingDirectoryRegistry(),
      agentRegistry: new AgentRegistry(testAgentRegistryOptions({ executableRegistry: executables })),
      customProfiles: customRepo,
      executableRegistry: executables,
      contextRoot: join(root, 'context'),
      environmentManager: new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'agent-workspaces') })),
      chooseDirectory: () => Promise.resolve(target),
      chooseExecutable: () => Promise.resolve(fakeExec),
      log: logger,
      isPackaged: false,
      confirmUnsafeCustomProfile: () => Promise.resolve(true),
      confirmDangerousAgentRun: () => {
        confirmationCount += 1;
        return Promise.resolve(allowConfirmation);
      },
    });
    await service.initialize();

    const selectedExecutable = await service.selectExecutable();
    if (selectedExecutable === null) throw new Error('Executable not selected');

    // Create custom profile supporting resume, model, and reasoning with {{reasoningEffort}}
    const profile = await service.createCustomProfile({
      name: 'Custom Resumable',
      executableHandle: selectedExecutable.handle,
      executionKind: 'normal',
      argvTemplate: ['run', '--prompt-file', '{{promptFile}}', '--model', '{{model}}', '--effort', '{{reasoningEffort}}'],
      promptDeliveryMode: 'temp-file',
      stdoutParsingMode: 'text',
      defaultModel: 'custom-gpt4',
      reasoningEffort: 'medium',
      supportsModelSelection: true,
      supportsReasoningSelection: true,
      resumeCommandTemplate: ['resume', '--session-id', '{{sessionId}}', '--model', '{{model}}', '--prompt-file', '{{promptFile}}', '--effort', '{{reasoningEffort}}'],
      supportsResume: true,
      workingDirectoryPolicy: 'select-per-run',
      defaultSandboxMode: 'auto-isolated',
      environmentOverrides: [],
      unsafe: true,
    });

    expect(profile.executionKind).toBe('normal');
    if (profile.executionKind !== 'normal') throw new Error('Expected normal profile');
    expect(profile.supportsResume).toBe(true);
    expect(profile.defaultModel).toBe('custom-gpt4');
    expect(profile.reasoningEffort).toBe('medium');
    expect(profile.supportsModelSelection).toBe(true);
    expect(profile.supportsReasoningSelection).toBe(true);

    // Verify argv placeholder expansion includes reasoningEffort
    const expanded = expandCustomArgvTemplate(profile.argvTemplate, {
      workingDir: '/workspace',
      promptFile: '/tmp/p.txt',
      sessionId: 'sess-1',
      model: 'custom-gpt4',
      reasoningEffort: 'medium',
    });
    expect(expanded).toEqual(['run', '--prompt-file', '/tmp/p.txt', '--model', 'custom-gpt4', '--effort', 'medium']);

    // Declined confirmation causes cancellation and no spawn/events
    allowConfirmation = false;
    const dir = await service.selectWorkingDirectory();
    if (dir === null) throw new Error('Directory not selected');

    await expect(service.startSession({
      documentId: TEST_DOCUMENT_ID,
      profileId: profile.id,
      workingDirectoryHandle: dir.handle,
      executionMode: 'auto-isolated',
      prompt: 'start custom',
    }, 1)).rejects.toThrow(/cancelled/i);
    expect(confirmationCount).toBe(1);
    expect(service.listSessions(TEST_DOCUMENT_ID)).toHaveLength(0);

    await service.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('enforces direct-workspace confirmation, single-use grant issuance and consumption on resume', async () => {
    let directConfirmations = 0;
    let allowDirect = true;
    const fixture = await openResumeService('interleaf-direct-resume-', new ResumableAdapter(), () => ({
      confirmDirectWorkspace: () => {
        directConfirmations += 1;
        return Promise.resolve(allowDirect);
      },
      confirmDangerousAgentRun: () => Promise.resolve(true),
    }));
    const { service } = fixture;

    // 1. Start active-env session with grant
    const grant = await service.issueRiskGrant({
      draftId: 'draft-1',
      profileId: 'resumable-agent',
      workingDirectoryHandle: fixture.directoryHandle,
      executionMode: 'active-env',
      prompt: 'direct work',
      model: null,
      contextPacket: null,
    }, 1);
    expect(directConfirmations).toBe(1);

    const startResult = await fixture.start('direct work', 1, {
      executionMode: 'active-env',
      riskConfirmation: { grantId: grant.grantId, draftId: 'draft-1' },
    });

    await untilCompleted(service, startResult.session.id);

    // 2. Resume active-env session: requires fresh direct confirmation & single-use grant
    allowDirect = false;
    await expect(service.resumeSession({
      sessionId: startResult.session.id,
      prompt: 'resume direct',
    }, 1)).rejects.toThrow(/cancelled/i);
    expect(directConfirmations).toBe(2);

    // 3. Approved direct resume succeeds and updates session
    allowDirect = true;
    const resumeRes = await service.resumeSession({
      sessionId: startResult.session.id,
      prompt: 'resume direct approved',
    }, 1);
    expect(directConfirmations).toBe(3);
    expect(resumeRes.session.id).toBe(startResult.session.id);

    await fixture.close();
  });

  it('rejects copy result for non-terminal, empty, or unowned sessions', async () => {
    const sink = clipboardSink();
    const fixture = await openResumeService('interleaf-copy-test-', new ResumableAdapter(), () => ({ clipboard: sink.clipboard }));
    const { service } = fixture;
    const repository = new AgentRepository(fixture.db);

    const startResult = await fixture.start('copyable task', 1, { executionMode: 'auto-isolated' });

    await untilCompleted(service, startResult.session.id);

    // Unowned session check (owner 2 tries to copy owner 1's session)
    await expect(service.copyResult(startResult.session.id, 2)).rejects.toThrow(/not owned/i);

    // Non-terminal check
    repository.updateSession(startResult.session.id, { status: 'running' });
    await expect(service.copyResult(startResult.session.id, 1)).rejects.toThrow(/terminal/i);

    // Completed but no final report -> rejected
    repository.updateSession(startResult.session.id, { status: 'completed', finalReport: null });
    await expect(service.copyResult(startResult.session.id, 1)).rejects.toThrow(/no report/i);

    // Completed with final report -> succeeds
    repository.updateSession(startResult.session.id, { finalReport: 'Task completed successfully.' });
    const res = await service.copyResult(startResult.session.id, 1);
    expect(res).toEqual({ copied: true, characterCount: 'Task completed successfully.'.length });
    expect(sink.texts).toEqual(['Task completed successfully.']);

    await fixture.close();
  });

  it('bars copy while a stopped run is still being reaped, then copies one stable terminal generation', async () => {
    const sink = clipboardSink();
    const fixture = await openResumeService('interleaf-copy-reaping-', new StallingResumeAdapter(), () => ({ clipboard: sink.clipboard }));
    const { service, adapter } = fixture;

    const start = await fixture.start('first generation', 1, { executionMode: 'auto-isolated' });
    // Settling includes a worker-thread workspace scan (item H), so wait for
    // the status rather than for a fixed interval.
    await vi.waitFor(() => { expect(service.getSession(start.session.id)?.status).toBe('completed'); });

    await service.resumeSession({ sessionId: start.session.id, prompt: 'second generation' }, 1);
    await adapter.resumeStarted;

    await service.stopSession(start.session.id, 1);
    // stopSession records cancellation before the child has exited, so the
    // persisted status is already terminal while the previous generation's
    // report is still the one on record.
    expect(service.getSession(start.session.id)?.status).toBe('cancelled');
    expect(adapter.cancelCalls).toBe(1);

    await expect(service.copyResult(start.session.id, 1)).rejects.toThrow(/reaped/i);
    expect(sink.texts).toEqual([]);

    adapter.reap();
    // Once the child is reaped the record has settled on exactly one terminal
    // generation, and that is what reaches the clipboard.
    await vi.waitFor(async () => { await service.copyResult(start.session.id, 1); });
    expect(sink.texts).toEqual(['stalled generation report']);

    await fixture.close();
  });

  it('bars copy while a resume is claimed but not yet spawned', async () => {
    const sink = clipboardSink();
    const confirmation = deferrableConfirmation();
    const fixture = await openResumeService('interleaf-copy-pending-resume-', new ReservedResumableAdapter(), () => ({
      confirmDangerousAgentRun: confirmation.confirm, clipboard: sink.clipboard,
    }));
    const { service } = fixture;

    const start = await fixture.start('first generation');
    await untilCompleted(service, start.session.id);

    confirmation.deferNext();
    const resume = service.resumeSession({ sessionId: start.session.id, prompt: 'second generation' }, 1);
    await vi.waitFor(() => { expect(confirmation.confirm).toHaveBeenCalledTimes(2); });

    // The claim exists and no new run has been persisted, so the record still
    // shows the previous generation as completed. Copying it here would hand
    // back a report the session is already leaving behind.
    expect(service.getSession(start.session.id)?.status).toBe('completed');
    await expect(service.copyResult(start.session.id, 1)).rejects.toThrow(/reaped/i);
    expect(sink.texts).toEqual([]);

    confirmation.release(true);
    await resume;
    await untilCompleted(service, start.session.id, { finalReport: 'resumed report' });
    await service.copyResult(start.session.id, 1);
    expect(sink.texts).toEqual(['resumed report']);

    await fixture.close();
  });
});
