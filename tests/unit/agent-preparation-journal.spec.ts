import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEnvironmentManager, type PreparationFaultPhase } from '@main/agents/environment-manager';
import { PREPARATION_FILE, PREPARATION_PHASES, readPreparationJournal } from '@main/agents/preparation-journal';
import { loadPreparationOwner, signPreparationRecord, type PreparationOwner } from '@main/agents/preparation-owner';
import type { PortableRecord } from '@shared/models/portable';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/**
 * Item J: a crash-safe preparation journal with a UUID owner marker across
 * every currently supported mode, and startup cleanup of exactly the
 * owned-uncommitted environments it identifies.
 *
 * Before this, only `isolated-worktree` journaled anything, it journaled with
 * a bare `writeFile`, and a half-prepared session root in any other mode was
 * judged afterwards by directory age.
 */
type Fixture = { readonly root: string; readonly target: string; readonly appRoot: string };

/**
 * The installation marker the manager mints by default: outside the agent
 * environment root, so nothing an agent can write reaches it.
 */
function ownerMarker(fixture: Fixture): string {
  return join(fixture.root, '.app-workspaces-preparation-owner.json');
}

async function owner(fixture: Fixture): Promise<PreparationOwner> {
  return loadPreparationOwner(ownerMarker(fixture));
}

async function plainTarget(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-prepare-'));
  const target = join(root, 'target');
  await mkdir(join(target, 'nested'), { recursive: true });
  await writeFile(join(target, 'hello.txt'), 'hello\n');
  await writeFile(join(target, 'nested', 'deep.txt'), 'deep\n');
  return { root, target, appRoot: join(root, 'app-workspaces') };
}

async function gitTarget(): Promise<Fixture> {
  const fixture = await plainTarget();
  const git = (...args: string[]): void => { execFileSync('git', ['-C', fixture.target, ...args], { stdio: 'ignore' }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'agent@example.test');
  git('config', 'user.name', 'Agent Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return fixture;
}

/** Starts a preparation that dies at `phase`, returning the left-behind session root. */
async function interruptedAt(fixture: Fixture, sessionId: string, mode: 'isolated-copy' | 'isolated-worktree', phase: PreparationFaultPhase): Promise<string> {
  const manager = new AgentEnvironmentManager(withEnvironmentShell({
    root: fixture.appRoot,
    prepareFaultInjector: (context) => context.phase === phase ? 'process-death' : undefined,
  }));
  await expect(manager.prepare({ sessionId, mode, canonicalTargetPath: fixture.target })).rejects.toThrow(/interrupted/iu);
  return join(fixture.appRoot, sessionId);
}

const worktrees = (fixture: Fixture): string => execFileSync('git', ['-C', fixture.target, 'worktree', 'list'], { encoding: 'utf8' });

const MODES = [
  { mode: 'isolated-copy' as const, fixture: plainTarget },
  { mode: 'active-env' as const, fixture: plainTarget },
  { mode: 'native-restricted' as const, fixture: plainTarget },
  { mode: 'isolated-worktree' as const, fixture: gitTarget },
];

describe('crash-safe preparation journal (item J)', () => {
  it.each(MODES)('cleans up exactly the owned uncommitted environment after a crash at any phase in $mode', async ({ mode, fixture: makeFixture }) => {
    // Every durable step, plus the window in which the journal's atomic temp
    // file exists but has not been renamed yet.
    const phases: PreparationFaultPhase[] = [
      ...PREPARATION_PHASES,
      ...PREPARATION_PHASES.map((phase): PreparationFaultPhase => `${phase}-temp`),
    ];
    for (const [index, faultPhase] of phases.entries()) {
      const fixture = await makeFixture();
      const sessionId = `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const manager = new AgentEnvironmentManager(withEnvironmentShell({
        root: fixture.appRoot,
        prepareFaultInjector: ({ phase }) => phase === faultPhase ? 'process-death' : undefined,
      }));
      const prepared = manager.prepare({ sessionId, mode, canonicalTargetPath: fixture.target });
      let reached = true;
      try { await prepared; reached = false; } catch (error) {
        // A phase this mode never reaches simply completes normally.
        if (!(error instanceof Error) || !/interrupted/iu.test(error.message)) throw error;
      }

      if (reached) {
        const sessionRoot = join(fixture.appRoot, sessionId);
        const journal = await readPreparationJournal(sessionRoot, await owner(fixture));
        if (!faultPhase.endsWith('-temp')) {
          // A death after a durable step leaves an owned, uncommitted record.
          expect(journal, faultPhase).not.toBeNull();
          expect(journal?.committed, faultPhase).toBe(false);
          expect(journal?.ownerId, faultPhase).toMatch(/^[0-9a-f-]{36}$/iu);
        }
        // Startup removes exactly that environment and nothing else.
        await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
        expect(await readdir(fixture.appRoot), faultPhase).toEqual([]);
      }
      // The external target is untouched by any interrupted preparation.
      expect(await readFile(join(fixture.target, 'hello.txt'), 'utf8'), faultPhase).toBe('hello\n');
      expect(await readFile(join(fixture.target, 'nested', 'deep.txt'), 'utf8'), faultPhase).toBe('deep\n');
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 180_000);

  it('removes the journal once preparation commits, and leaves the session alone', async () => {
    const fixture = await plainTarget();
    const sessionId = 'e1000000-0000-4000-8000-000000000001';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot }));
    await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: fixture.target });
    const sessionRoot = join(fixture.appRoot, sessionId);
    expect(await readdir(sessionRoot)).not.toContain(PREPARATION_FILE);

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot }));
    await restarted.initialize();
    const review = await restarted.review(sessionId);
    expect(review.sessionId).toBe(sessionId);
    await restarted.discard(sessionId);
    await rm(fixture.root, { recursive: true, force: true });
  }, 30_000);

  it('never deletes an environment whose journal it cannot prove it owns', async () => {
    const fixture = await plainTarget();
    const sessionId = 'e2000000-0000-4000-8000-000000000002';
    const sessionRoot = await interruptedAt(fixture, sessionId, 'isolated-copy', 'baseline');

    for (const tampered of [
      '{ not json',
      JSON.stringify({ version: 1, ownerId: 'not-a-uuid', sessionId, sessionRoot, mode: 'isolated-copy', phase: 'baseline', committed: false }),
      JSON.stringify({ version: 1, ownerId: '11111111-1111-4111-8111-111111111111', sessionId, sessionRoot: '/somewhere/else', mode: 'isolated-copy', phase: 'baseline', committed: false }),
      JSON.stringify({ version: 2, ownerId: '11111111-1111-4111-8111-111111111111', sessionId, sessionRoot, mode: 'isolated-copy', phase: 'baseline', committed: false }),
    ]) {
      await writeFile(join(sessionRoot, PREPARATION_FILE), tampered);
      await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
      expect(await readdir(fixture.appRoot), tampered).toEqual([sessionId]);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }, 30_000);

  it('treats a plausible but unsigned journal as somebody else\'s, whatever UUIDs it carries', async () => {
    // Item J correction (finding 3): the forgeries a session-root writer can
    // actually mint. Each one is shape-perfect — right session id, right
    // resolved root, right phase, UUID-shaped owner — and differs only in the
    // half of the record that requires the main-owned marker held outside the
    // subtree. None of them may authorize a removal.
    const fixture = await plainTarget();
    const sessionId = 'e4000000-0000-4000-8000-000000000004';
    const sessionRoot = await interruptedAt(fixture, sessionId, 'isolated-copy', 'baseline');

    const real = await owner(fixture);
    // A marker the "attacker" mints for itself: same user, same code path, its
    // own installation id and its own secret.
    const foreign = await loadPreparationOwner(join(fixture.root, 'attacker-owner.json'));
    const base = {
      version: 1 as const,
      ownerId: '22222222-2222-4222-8222-222222222222',
      installationId: real.installationId,
      sessionId,
      sessionRoot,
      mode: 'isolated-copy',
      phase: 'baseline' as const,
      committed: false,
    };
    const canonical = (fields: typeof base): string => JSON.stringify([
      fields.version, fields.ownerId, fields.installationId, fields.sessionId,
      fields.sessionRoot, fields.mode, fields.phase, fields.committed,
    ]);
    const forgeries: readonly (readonly [string, PortableRecord])[] = [
      // A wholly foreign installation, signed correctly for itself.
      ['foreign installation', { ...base, installationId: foreign.installationId, mac: signPreparationRecord(foreign, canonical({ ...base, installationId: foreign.installationId })) }],
      // Our installation id copied verbatim, signed with the attacker's secret.
      ['borrowed installation id', { ...base, mac: signPreparationRecord(foreign, canonical(base)) }],
      // A MAC this installation really did produce — for a different session root.
      ['replayed signature', { ...base, mac: signPreparationRecord(real, canonical({ ...base, sessionRoot: join(fixture.appRoot, 'e4000000-0000-4000-8000-000000000099') })) }],
      // No MAC at all: the pre-correction record shape.
      ['unsigned', { ...base }],
      ['malformed mac', { ...base, mac: 'not-a-mac' }],
    ];
    for (const [label, forged] of forgeries) {
      await writeFile(join(sessionRoot, PREPARATION_FILE), JSON.stringify(forged));
      expect(await readPreparationJournal(sessionRoot, real), label).toBeNull();
      await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
      expect(await readdir(fixture.appRoot), label).toEqual([sessionId]);
    }

    // Control: the same record, signed by the real owner, is removed. Without
    // this the test could pass because nothing is ever cleaned up.
    await writeFile(join(sessionRoot, PREPARATION_FILE), JSON.stringify({ ...base, mac: signPreparationRecord(real, canonical(base)) }));
    await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
    expect(await readdir(fixture.appRoot)).toEqual([]);
    await rm(fixture.root, { recursive: true, force: true });
  }, 30_000);

  it.each([
    ['malformed json', '{ not json'],
    ['wrong shape', JSON.stringify({ version: 1, sessionId: 'e5000000-0000-4000-8000-000000000005' })],
    ['empty', ''],
  ])('retains the root and the external Git registration when the pending record is %s', async (_label, corrupt) => {
    // Item J correction (finding 8): a cleanup record that cannot be read says
    // nothing about whether an external worktree is still registered. Reading
    // "unreadable" as "absent" would authorize a recursive removal of the
    // session root while the repository still points into it.
    const fixture = await gitTarget();
    const sessionId = 'e5000000-0000-4000-8000-000000000005';
    const sessionRoot = await interruptedAt(fixture, sessionId, 'isolated-worktree', 'worktree-registered');
    expect(worktrees(fixture)).toContain(sessionId);

    await writeFile(join(sessionRoot, 'pending-git-cleanup.json'), corrupt);
    await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
    // Retained for explicit repair, registration untouched.
    expect(await readdir(fixture.appRoot)).toEqual([sessionId]);
    expect(worktrees(fixture)).toContain(sessionId);

    await rm(fixture.root, { recursive: true, force: true });
  }, 60_000);

  it('unwinds the registration and removes the root when the pending record is readable', async () => {
    // The control the case above needs: a *readable* uncommitted record really
    // does authorize the unwind, so retention is a response to corruption and
    // not simply the behaviour in every case.
    const fixture = await gitTarget();
    const sessionId = 'e6000000-0000-4000-8000-000000000006';
    await interruptedAt(fixture, sessionId, 'isolated-worktree', 'worktree-registered');

    await new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot })).initialize();
    expect(await readdir(fixture.appRoot)).toEqual([]);
    expect(worktrees(fixture)).not.toContain(sessionId);
    await rm(fixture.root, { recursive: true, force: true });
  }, 60_000);

  it('keeps Container Sandbox fail-closed and journals nothing for it', async () => {
    const fixture = await plainTarget();
    const sessionId = 'e3000000-0000-4000-8000-000000000003';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: fixture.appRoot, detectRuntime: () => Promise.resolve('docker' as const) }));
    await expect(manager.prepare({ sessionId, mode: 'container-sandbox', canonicalTargetPath: fixture.target }))
      .rejects.toThrow(/no verified Interleaf container executor/iu);
    // Fail-closed means no residue: no session root, no journal, no lock.
    expect(await readdir(fixture.appRoot)).toEqual([]);
    await rm(fixture.root, { recursive: true, force: true });
  }, 30_000);
});
