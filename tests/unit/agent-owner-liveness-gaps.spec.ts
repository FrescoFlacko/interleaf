import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import {
  GapDirectoryRegistry,
  ReservedResumableAdapter,
  TEST_DOCUMENT_ID,
  openResumeService,
} from '../helpers/agent-resume-fixtures';

type AgentSessionUpdate = Parameters<AgentRepository['updateSession']>[1];

/**
 * The final awaited step before every spawn is the persisted-target proof.
 * Arming it runs a hook in the microtask queued just after its Nth call
 * fulfills: behind the awaiting caller's continuation (and its own liveness
 * proof), but ahead of whatever awaits that caller in turn.
 */
const targetProofGap = vi.hoisted(() => ({ remaining: 0, hook: null as (() => void) | null }));

vi.mock('@main/agents/session-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agents/session-authority')>();
  return {
    ...actual,
    assertPersistedTargetUnchanged: (identity: Parameters<typeof actual.assertPersistedTargetUnchanged>[0]) => {
      const proof = actual.assertPersistedTargetUnchanged(identity);
      const hook = targetProofGap.hook;
      if (hook === null || --targetProofGap.remaining > 0) return proof;
      targetProofGap.hook = null;
      return new Promise<Awaited<typeof proof>>((resolve, reject) => {
        proof.then((proved) => {
          resolve(proved);
          queueMicrotask(hook);
        }, reject);
      });
    },
  };
});

function afterTargetProof(call: number, hook: () => void): void {
  targetProofGap.remaining = call;
  targetProofGap.hook = hook;
}

/** Every session patch written through any repository, in order. */
function recordSessionUpdates(): AgentSessionUpdate[] {
  const patches: AgentSessionUpdate[] = [];
  const original = AgentRepository.prototype.updateSession;
  vi.spyOn(AgentRepository.prototype, 'updateSession').mockImplementation(function (this: AgentRepository, sessionId, patch) {
    patches.push(patch);
    original.call(this, sessionId, patch);
  });
  return patches;
}

afterEach(() => {
  targetProofGap.hook = null;
  vi.restoreAllMocks();
});

describe('Owner liveness across the last await before each startup write and spawn', () => {
  // After an approved confirmation a start resolves the handle in the
  // confirmation step, as authorization's final await, and then once at the
  // end of each startup step: environment preparation (3), context (4).
  it.each([
    ['environment preparation', 3, (patch: AgentSessionUpdate) => patch.environmentState === 'prepared'],
    ['context persistence', 4, (patch: AgentSessionUpdate) => patch.status === 'running'],
  ] as const)('writes nothing for %s once the owner dies after its last liveness proof', async (_step, resolveCall, isStepWrite) => {
    const ownerId = 61;
    const directories = new GapDirectoryRegistry();
    let cancelled: Promise<void> = Promise.resolve();
    const confirmDangerousAgentRun = vi.fn(() => {
      directories.afterResolve(resolveCall, () => { cancelled = fixture.service.cancelOwner(ownerId); });
      return Promise.resolve(true);
    });
    const fixture = await openResumeService('interleaf-step-gap-', new ReservedResumableAdapter(), () => ({ registry: directories, confirmDangerousAgentRun }));
    const patches = recordSessionUpdates();

    await expect(fixture.start('owner dies before the step write', ownerId)).rejects.toThrow(/cancelled before execution/i);
    await cancelled;
    expect(patches.some(isStepWrite)).toBe(false);
    expect(fixture.adapter.startCalls).toBe(0);
    const [session] = fixture.service.listSessions(TEST_DOCUMENT_ID);
    expect(session?.environmentState).toBe('discarded');
    await fixture.close();
  });

  it('settles a start as cancelled without spawning when the owner dies after the final target proof', async () => {
    const ownerId = 62;
    const fixture = await openResumeService('interleaf-spawn-gap-', new ReservedResumableAdapter(), () => ({ confirmDangerousAgentRun: () => Promise.resolve(true) }));
    let cancelled: Promise<void> = Promise.resolve();
    // A fresh start proves the persisted target once, as its last await.
    afterTargetProof(1, () => { cancelled = fixture.service.cancelOwner(ownerId); });

    const result = await fixture.start('owner dies before spawn', ownerId);
    await cancelled;
    expect(fixture.adapter.startCalls).toBe(0);
    expect(fixture.service.getSession(result.session.id)).toMatchObject({ status: 'cancelled', environmentState: 'discarded' });
    await fixture.close();
  });

  it('does not resume when the runtime shuts down after the final target proof', async () => {
    const ownerId = 63;
    const fixture = await openResumeService('interleaf-resume-spawn-gap-', new ReservedResumableAdapter(), () => ({ confirmDangerousAgentRun: () => Promise.resolve(true) }));
    const started = await fixture.start('before shutdown', ownerId);
    await vi.waitFor(() => { expect(fixture.service.getSession(started.session.id)?.status).toBe('completed'); });
    let shutdown: Promise<void> = Promise.resolve();
    // A resume proves the persisted target while loading its authority, in
    // its final proofs, and last of all immediately before spawning.
    afterTargetProof(3, () => { shutdown = fixture.service.shutdown(); });

    const resumed = await fixture.service.resumeSession({ sessionId: started.session.id, prompt: 'resume into shutdown' }, ownerId);
    await shutdown;
    expect(fixture.adapter.resumeCalls).toBe(0);
    expect(resumed.session.status).toBe('completed');
    await fixture.close(false);
  });
});
