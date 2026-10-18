import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { CliAgentAdapter } from '@main/agents/agent-adapter';
import { TestAgentRegistry } from '../helpers/agent-registry';
import { AgentService } from '@main/agents/agent-service';
import { StubNativeSandboxProber, stubVerifiedNativeSandbox } from '../helpers/native-sandbox-prober';
import type { Logger } from '@main/logging/logger';
import type { ProcessLauncher, ProcessRunnerRequest } from '@main/agents/process-runner';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { createTestAgentService } from '../helpers/agent-service';
import { adapterCollaborators, withEnvironmentShell, testAgentRegistryOptions } from '../helpers/agent-collaborators';
import { sameFileIdentity, statWithIdentity } from '@main/security/file-identity';

/**
 * Items B and P end to end.
 *
 * A session records the exact target device/inode identity and the exact
 * main-resolved permission policy it started under. Every later privileged
 * continuation is checked against those recorded values, never against whatever
 * the profile, registry, or filesystem happens to say now.
 */

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NATIVE_START_ARGS = ['exec', '--json', '--sandbox', 'workspace-write'];

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

type Spawn = { readonly args: readonly string[]; readonly cwd: string };

function recordingRunner(spawns: Spawn[]): ProcessLauncher {
  return ({
    run: (options: ProcessRunnerRequest) => {
      spawns.push({ args: [...options.args], cwd: options.cwd });
      return {
        runId: 'fixture-run',
        events: (async function* () {
          await Promise.resolve();
          yield { runId: 'fixture-run', type: 'started' as const, timestamp: new Date().toISOString() };
          yield {
            runId: 'fixture-run', type: 'structured' as const,
            data: { type: 'thread.started', thread_id: 'thread-authority-1' },
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
}

function codexProfile(overrides: Partial<MainAgentProfile> = {}): MainAgentProfile {
  return {
    id: 'codex',
    providerId: 'codex',
    name: 'Codex',
    binaryPath: '/usr/local/bin/codex',
    defaultArgs: [...NATIVE_START_ARGS],
    defaultModel: 'o3-mini',
    configuredModels: ['o3-mini', 'o3-pro'],
    // Item O correction: Codex carries no verified reasoning-effort contract,
    // so a profile that selects one cannot start at all. Effort is not what
    // these authority tests are about; they run at the provider default.
    reasoningEffort: null,
    permissionMode: 'normal',
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', binaryPath: '/usr/local/bin/codex', version: '0.149.1', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

/**
 * The two profile fields hostile drift rewrites after a session started.
 *
 * `MainAgentProfile` declares them readonly for every production holder; the
 * harness owns the object it builds, so it can hand the test a writable view of
 * exactly these two without asserting past the type.
 */
type DriftableProfilePolicy = {
  permissionMode: string;
  defaultArgs: readonly string[];
};

type Harness = {
  readonly service: AgentService;
  readonly db: InterleafDatabase;
  readonly repository: AgentRepository;
  readonly root: string;
  readonly target: string;
  readonly spawns: Spawn[];
  readonly prober: StubNativeSandboxProber;
  readonly profile: MainAgentProfile;
  readonly profilePolicy: DriftableProfilePolicy;
  readonly restart: () => Promise<AgentService>;
  readonly dispose: () => Promise<void>;
};

async function harness(options: {
  readonly profile?: MainAgentProfile;
  readonly nativeProof?: ReturnType<typeof stubVerifiedNativeSandbox> | null;
  /** Runs inside the direct-workspace confirmation, i.e. in the gap between
   * the early capability check and the final pre-spawn proof. */
  readonly duringConfirmation?: () => void;
} = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-session-authority-')));
  const target = join(root, 'workspace');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'README.md'), 'content\n', 'utf8');

  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  db.raw.prepare(`
    INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
    VALUES ('doc-authority', 'Doc', 'pdf', '/tmp/authority.pdf', 'managed', 10, 10, 'hash-authority')
  `).run();

  const spawns: Spawn[] = [];
  const runner = recordingRunner(spawns);
  const profile = options.profile ?? codexProfile();
  const profilePolicy: DriftableProfilePolicy = profile;
  const prober = new StubNativeSandboxProber(
    options.nativeProof === undefined ? stubVerifiedNativeSandbox() : options.nativeProof,
  );
  const repository = new AgentRepository(db);

  const build = async (): Promise<AgentService> => {
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
      nativeSandboxProber: prober,
      chooseDirectory: () => Promise.resolve(target),
      isGitRepository: () => Promise.resolve(false),
      confirmDirectWorkspace: () => { options.duringConfirmation?.(); return Promise.resolve(true); },
      confirmDangerousAgentRun: () => Promise.resolve(true),
      log: logger,
      isPackaged: false,
    });
    await service.initialize();
    // A launch creates main's window through main's own factory, which is
    // what binds recovered sessions to a window that may claim them (item C).
    service.adoptMainWindow(1);
    return service;
  };

  let current = await build();
  return {
    get service() { return current; },
    db, repository, root, target, spawns, prober, profile, profilePolicy,
    restart: async () => {
      await current.shutdown();
      current = await build();
      return current;
    },
    dispose: async () => {
      await current.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  options: Parameters<typeof harness>[0],
  body: (context: Harness) => Promise<void>,
): Promise<void> {
  const context = await harness(options);
  try {
    await body(context);
  } finally {
    await context.dispose();
  }
}

/**
 * After a restart no window owns the session, so the window that reopens takes
 * it through the explicit handoff first (item C).
 */
async function restartAndClaim(context: Harness, sessionId: string): Promise<void> {
  await context.restart();
  await context.service.claimSession(sessionId, 1);
}

/** Replaces the target with a new directory at the same path (Linux may reuse the inode number; the birth time differs), optionally with identical content. */
async function replaceTarget(target: string, withContent = true): Promise<void> {
  await rm(join(target, 'README.md'));
  await rmdir(target);
  await mkdir(target, { recursive: true });
  if (withContent) await writeFile(join(target, 'README.md'), 'content\n', 'utf8');
}

async function startDirect(
  context: Harness,
  mode: 'native-restricted' | 'active-env',
  prompt = 'start direct',
): Promise<string> {
  const selection = await context.service.selectWorkingDirectory();
  if (selection === null) throw new Error('directory selection failed');
  const draftId = `draft-${mode}`;
  const grant = await context.service.issueRiskGrant({
    draftId,
    profileId: 'codex',
    workingDirectoryHandle: selection.handle,
    executionMode: mode,
    prompt,
    model: null,
    contextPacket: null,
  }, 1);
  const started = await context.service.startSession({
    documentId: 'doc-authority',
    profileId: 'codex',
    workingDirectoryHandle: selection.handle,
    executionMode: mode,
    prompt,
    riskConfirmation: { grantId: grant.grantId, draftId: draftId },
  }, 1);
  await settle(context, started.session.id);
  return started.session.id;
}

async function settle(context: Harness, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = context.service.getSession(sessionId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return;
    await delay(5);
  }
  throw new Error('session never settled');
}

describe('persisted target identity and permission authority', () => {
  it('records the exact target identity and policy a native-restricted session started under', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      const { identity } = await statWithIdentity(context.target);
      const stored = context.repository.getSessionAuthority(sessionId);

      expect(identity.birthtimeNs).not.toBeNull();
      expect(stored?.targetIdentity).toMatchObject({ version: 1, canonicalPath: context.target, ...identity });
      expect(stored?.authority).toMatchObject({
        version: 1,
        profileId: 'codex',
        effectivePermissionPolicy: 'normal',
        executionMode: 'native-restricted',
        unsafeProfile: false,
        sandboxArgs: ['-c', 'sandbox_mode="workspace-write"'],
        reasoningEffort: null,
        nativeCapability: { contractId: 'codex-exec-sandbox-workspace-write-v1', executableFingerprint: 'stub-fingerprint' },
      });
      // The start really ran with the sandboxed argv the proof described.
      expect(context.spawns[0]?.args.slice(0, 4)).toEqual(NATIVE_START_ARGS);
    });
  });

  it('preserves the exact native-restricted sandbox argv across a restart and resume', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      await restartAndClaim(context, sessionId);

      await context.service.resumeSession({ sessionId, prompt: 'continue' }, 1);

      const resume = context.spawns.at(-1);
      expect(resume?.args).toEqual([
        'exec', 'resume', '--json',
        '-c', 'sandbox_mode="workspace-write"',
        '--skip-git-repo-check',
        '--model', 'o3-mini',
        'thread-authority-1',
        '-',
      ]);
      expect(resume?.cwd).toBe(context.target);
    });
  });

  it('resumes an active-env session with no sandbox argv at all', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'active-env');
      await restartAndClaim(context, sessionId);

      await context.service.resumeSession({ sessionId, prompt: 'continue' }, 1);

      const resume = context.spawns.at(-1);
      expect(resume?.args).not.toContain('sandbox_mode="workspace-write"');
      expect(resume?.args.filter((token) => token.startsWith('sandbox_mode'))).toEqual([]);
      expect(context.repository.getSessionAuthority(sessionId)?.authority?.sandboxArgs).toEqual([]);
    });
  });

  it('resumes under the persisted policy, not a profile whose defaults changed afterwards', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      const spawnsAfterStart = context.spawns.length;

      // Hostile drift: a widened permission policy and a widened argv preset.
      context.profilePolicy.permissionMode = 'bypassPermissions';
      context.profilePolicy.defaultArgs = ['exec', '--json', '--sandbox', 'danger-full-access'];

      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/changed|no longer|cannot be continued|unavailable/i);
      // Nothing was spawned, and the prior terminal session is untouched.
      expect(context.spawns).toHaveLength(spawnsAfterStart);
      expect(context.service.getSession(sessionId)?.status).toBe('completed');
    });
  });

  it('refuses to resume when the native capability can no longer be proved', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      const spawnsAfterStart = context.spawns.length;

      // The binary at the same path is a different file now.
      context.prober.setAnswer(stubVerifiedNativeSandbox({ executableFingerprint: 'replaced-binary' }));
      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/Native Restricted|unavailable|changed/i);

      // Or cannot be proved at all.
      context.prober.setAnswer(null);
      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/Native Restricted|unavailable|changed/i);

      expect(context.spawns).toHaveLength(spawnsAfterStart);
      expect(context.service.getSession(sessionId)?.status).toBe('completed');
    });
  });

  it('fails closed when the binary drifts while the confirmation dialog is open', async () => {
    // A proof taken before the dialog describes a moment that may be minutes
    // old by the time the user answers, so the authorization is the fresh
    // proof taken after it.
    let drifted = false;
    const context = await harness({
      duringConfirmation: () => {
        if (!drifted) return;
        context.prober.setAnswer(stubVerifiedNativeSandbox({ executableFingerprint: 'swapped-during-confirmation' }));
      },
    });
    try {
      const sessionId = await startDirect(context, 'native-restricted');
      const spawnsAfterStart = context.spawns.length;
      drifted = true;

      const before = context.service.getSession(sessionId);
      const updates = vi.spyOn(context.repository, 'updateSession');

      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/Native Restricted|unavailable|changed/i);
      // The adapter was never entered, so there was no new attempt to record.
      // A rejected resume leaves the completed run exactly as it was: same
      // status, same final report, no `running` transition, no error event.
      expect(context.spawns).toHaveLength(spawnsAfterStart);
      expect(context.service.getSession(sessionId)?.status).toBe('completed');
      expect(context.service.getSession(sessionId)?.finalReport).toBe(before?.finalReport);
      expect(updates).not.toHaveBeenCalled();
      expect(context.service.getSession(sessionId)?.events.some((event) => event.type === 'error')).toBe(false);
      // The rejection came from a proof taken after the dialog, not before it.
      expect(context.prober.freshVerifyCalls).toBeGreaterThan(0);
      updates.mockRestore();
    } finally {
      await context.dispose();
    }
  });

  it('rechecks the target after the final proof, not only before it', async () => {
    // The uncached pre-spawn proof is itself a long await. A target replaced
    // inside that window was still valid at every earlier check, so only a
    // recheck taken after the proof can catch it.
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      const spawnsAfterStart = context.spawns.length;
      const before = context.service.getSession(sessionId);
      const { identity: originalIdentity } = await statWithIdentity(context.target);

      context.prober.duringFreshVerify = async () => {
        context.prober.duringFreshVerify = null;
        await replaceTarget(context.target);
      };
      const updates = vi.spyOn(context.repository, 'updateSession');

      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/changed|replaced|selected again/i);

      // No adapter invocation, and the replacement directory was not touched.
      expect(context.spawns).toHaveLength(spawnsAfterStart);
      const { identity: replacement } = await statWithIdentity(context.target);
      expect(sameFileIdentity(originalIdentity, replacement)).toBe(false);
      expect(await readdir(context.target)).toEqual(['README.md']);
      // The prior terminal session is unchanged.
      expect(context.service.getSession(sessionId)?.status).toBe('completed');
      expect(context.service.getSession(sessionId)?.finalReport).toBe(before?.finalReport);
      expect(updates).not.toHaveBeenCalled();
      updates.mockRestore();
    });
  });

  it('rechecks the target after the final start proof, not only before it', async () => {
    // The same window exists on the start path, after the session row and the
    // prepared environment already exist.
    await withHarness({}, async (context) => {
      const { identity: originalIdentity } = await statWithIdentity(context.target);
      let freshProofs = 0;
      context.prober.duringFreshVerify = async () => {
        freshProofs += 1;
        // The second forced proof is the one taken immediately before the
        // adapter; the first only decides what gets persisted.
        if (freshProofs < 2) return;
        context.prober.duringFreshVerify = null;
        await replaceTarget(context.target, false);
      };

      await expect(startDirect(context, 'native-restricted')).rejects.toThrow(/changed|replaced|selected again/i);

      expect(context.spawns).toHaveLength(0);
      expect(sameFileIdentity(originalIdentity, (await statWithIdentity(context.target)).identity)).toBe(false);
      expect(await readdir(context.target)).toEqual([]);
      // The session that was created before the race is terminal, not live.
      const sessions = context.service.listSessions('doc-authority');
      expect(sessions.every((entry) => entry.status === 'failed')).toBe(true);
    });
  });

  it('preserves the prior terminal session when a resume is stopped before a live handle exists', async () => {
    // A resume claims the session before its final checks, but it has not
    // persisted anything: the record still describes the previous completed
    // attempt. A stop arriving in that window must only raise an in-memory
    // flag, and the resume must honour it without spawning or writing.
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'native-restricted');
      const spawnsAfterStart = context.spawns.length;
      const before = context.service.getSession(sessionId);
      if (before === null) throw new Error('the session was not recorded');
      const eventsBefore = JSON.stringify(before.events);
      const updates = vi.spyOn(context.repository, 'updateSession');

      context.prober.duringFreshVerify = async () => {
        context.prober.duringFreshVerify = null;
        await context.service.stopSession(sessionId, 1);
      };

      const resumed = await context.service.resumeSession({ sessionId, prompt: 'continue' }, 1);

      // No child, no repository write, and byte-for-byte identical history.
      expect(context.spawns).toHaveLength(spawnsAfterStart);
      expect(updates).not.toHaveBeenCalled();
      expect(resumed.session.status).toBe('completed');
      const after = context.service.getSession(sessionId);
      if (after === null) throw new Error('the session disappeared');
      expect(after.status).toBe('completed');
      expect(after.finalReport).toBe(before.finalReport);
      expect(JSON.stringify(after.events)).toBe(eventsBefore);
      updates.mockRestore();
    });
  });

  it('refuses to start Native Restricted for a profile that cannot prove the sandbox', async () => {
    await withHarness({ nativeProof: null }, async (context) => {
      await expect(startDirect(context, 'native-restricted')).rejects.toThrow(/Native Restricted/i);
      expect(context.spawns).toHaveLength(0);
      expect(context.service.listSessions('doc-authority')).toHaveLength(0);

      // The same profile can still run a mode it does not need the proof for.
      const availability = await context.service.listModeAvailability('codex');
      expect(availability.find((entry) => entry.mode === 'native-restricted')?.available).toBe(false);
    });
  });

  it('records an unsafe profile as unsafe and still denies it Native Restricted', async () => {
    // An unsafe profile can never be proved (the real prober gates it out
    // before spawning), so the truthful capability answer here is "none".
    await withHarness({
      profile: codexProfile({ unsafe: true, permissionMode: 'bypassPermissions' }),
      nativeProof: null,
    }, async (context) => {
      const availability = await context.service.listModeAvailability('codex');
      expect(availability.find((entry) => entry.mode === 'native-restricted')?.available).toBe(false);
      await expect(startDirect(context, 'native-restricted')).rejects.toThrow(/Native Restricted/i);

      const sessionId = await startDirect(context, 'active-env');
      expect(context.repository.getSessionAuthority(sessionId)?.authority).toMatchObject({
        unsafeProfile: true,
        effectivePermissionPolicy: 'bypassPermissions',
        executionMode: 'active-env',
        nativeCapability: null,
        sandboxArgs: [],
      });

      // Resume keeps honouring that recorded policy rather than re-deriving it.
      await restartAndClaim(context, sessionId);
      await context.service.resumeSession({ sessionId, prompt: 'continue' }, 1);
      expect(context.spawns.at(-1)?.args).not.toContain('--sandbox');
    });
  });

  it('fails closed when the target directory is recreated with identical content', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'active-env');
      const spawnsAfterStart = context.spawns.length;
      const { identity: before } = await statWithIdentity(context.target);

      // Same path, same contents, new file identity: byte-identical is not the
      // same directory, and the recorded identity is what the session authorised.
      await replaceTarget(context.target);
      const { identity: after } = await statWithIdentity(context.target);
      expect(sameFileIdentity(before, after)).toBe(false);

      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/changed|replaced|selected again/i);
      expect(context.spawns).toHaveLength(spawnsAfterStart);
      expect(context.service.getSession(sessionId)?.status).toBe('completed');

      // A restart must not launder the replacement into a fresh-looking
      // session: rehydration finds the same mismatch and closes the door there.
      await restartAndClaim(context, sessionId);
      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/changed|replaced|selected again|no longer available/i);
      expect(context.spawns).toHaveLength(spawnsAfterStart);
    });
  });

  it('refuses every privileged continuation of a session with no persisted snapshot', async () => {
    await withHarness({}, async (context) => {
      const sessionId = await startDirect(context, 'active-env');
      // A row from before the snapshot existed, or one whose snapshot is
      // unreadable, must not be continued on the strength of current state.
      context.db.raw.prepare('UPDATE agent_sessions SET authority_json = NULL WHERE id = ?').run(sessionId);

      await expect(context.service.resumeSession({ sessionId, prompt: 'continue' }, 1))
        .rejects.toThrow(/cannot be continued/i);
      await expect(context.service.getEnvironmentReview(sessionId, 1)).rejects.toThrow(/cannot be continued/i);
      await expect(context.service.openFolder(sessionId, 1)).rejects.toThrow(/cannot be continued/i);
    });
  });
});
