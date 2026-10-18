import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEnvironmentManager, type EnvironmentState } from '@main/agents/environment-manager';
import type { AgentEnvironmentReview } from '@shared/types/agent-environment';
import { isPortableArray, isPortableRecord, parsePortableJson, type PortableRecord, type PortableValue } from '@shared/models/portable';
import { ProtectedRootPolicy } from '@main/agents/protected-roots';
import { withEnvironmentShell } from '../helpers/agent-collaborators';
import { sameFileIdentity, statWithIdentity } from '@main/security/file-identity';

/**
 * A manager whose pre-mutation await windows a test can act inside.
 *
 * Apply's ordering guarantees are about what may change *during* its own
 * awaits, so a test has to run at a precise point inside them. Both windows are
 * reached the way the class itself reaches them: by overriding the review step
 * and by reading the protected-root policy, both of which the manager keeps
 * `protected` rather than public.
 */
class WindowedEnvironmentManager extends AgentEnvironmentManager {
  /** Runs once, inside the await the review step opens. */
  onReview: (() => Promise<void>) | null = null;

  /** The policy whose root canonicalization is the last pre-mutation await. */
  protected override async buildReview(state: EnvironmentState): Promise<AgentEnvironmentReview> {
    const review = await super.buildReview(state);
    const act = this.onReview;
    this.onReview = null;
    if (act !== null) await act();
    return review;
  }
}

/** An apply recovery journal, read back as the JSON object it must be. */
async function readJournal(path: string): Promise<PortableRecord> {
  const journal = parsePortableJson(await readFile(path, 'utf8'));
  if (!isPortableRecord(journal)) throw new Error('The apply journal must be a JSON object.');
  return journal;
}

/** A journal member that must be recorded as an array. */
function journalArray(journal: PortableRecord, member: string): readonly PortableValue[] {
  const value = journal[member];
  if (!isPortableArray(value)) throw new Error(`The apply journal must record ${member} as an array.`);
  return value;
}

/** A journal member that must be recorded as an object. */
function journalRecord(journal: PortableRecord, member: string): PortableRecord {
  const value = journal[member];
  if (!isPortableRecord(value)) throw new Error(`The apply journal must record ${member} as an object.`);
  return value;
}

/** A committed Git repository over whatever `dir` already holds. */
function commitAll(dir: string, message = 'fixture'): void {
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'interleaf@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Interleaf Test']);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', message]);
}

/** A fault injector that simulates process death the first time apply reaches `phase`. */
function dieOnceAt(phase: string) {
  let interrupted = false;
  return ({ phase: reached }: { readonly phase: string }) => {
    if (reached !== phase || interrupted) return undefined;
    interrupted = true;
    return 'process-death' as const;
  };
}

/** The retained recovery directory name under a session root. */
async function recoveryName(sessionRoot: string): Promise<string> {
  const name = (await readdir(sessionRoot)).find((entry) => entry.startsWith('recovery-'));
  if (name === undefined) throw new Error('Apply recovery journal was not retained after interruption.');
  return name;
}

/** Whether the session's persisted environment metadata records an apply. */
async function metadataApplied(sessionRoot: string): Promise<boolean> {
  return (JSON.parse(await readFile(join(sessionRoot, 'environment.json'), 'utf8')) as { applied: boolean }).applied;
}

/** Git output inside `dir`. */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; target: string; appRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-env-'));
  fixtureRoots.push(root);
  const target = join(root, 'target');
  const appRoot = join(root, 'app-workspaces');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'hello.txt'), 'before\n');
  return { root, target, appRoot };
}

describe('Phase 9 main-owned environments', () => {
  it('copies, reviews, applies atomically, and discards without exposing paths', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const sessionId = '6f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'new\n');
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    await expect(restarted.review(sessionId)).resolves.toMatchObject({ review: { diffAvailable: true } });
    const review = await manager.review(sessionId);
    expect(review.review.applyAllowed).toBe(true);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['created.txt', 'hello.txt']);
    await manager.apply(sessionId);
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(paths.target, 'created.txt'), 'utf8')).toBe('new\n');
    await manager.discard(sessionId);
    await manager.discard(sessionId);
  });

  it('admits 127 test results per run, coalesces the rest, and reopens the budget for the next run', async () => {
    // Item I: the caller may only create artifacts or review work for an
    // accepted result, so the admission answer has to be explicit. The budget
    // bounds one *run*: a session that floods once is not left permanently
    // unable to report anything, and the durable history of what it already
    // reported is kept rather than reset.
    const paths = await fixture();
    const sessionId = '1a9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });

    const outcomes = [];
    for (let index = 0; index < 200; index += 1) {
      outcomes.push(await manager.recordTestResult(sessionId, {
        status: 'passed', summary: `result ${String(index)}`, exitCode: 0, durationMs: 1,
      }));
    }

    expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(127);
    expect(outcomes.slice(0, 127).every((outcome) => outcome.accepted)).toBe(true);
    expect(outcomes.slice(127).every((outcome) => !outcome.accepted)).toBe(true);
    expect(outcomes.at(-1)?.recorded).toBe(128);
    expect(outcomes.at(-1)?.suppressed).toBe(73);

    const before = (await manager.review(sessionId)).review.tests;
    expect(before).toHaveLength(128);
    expect(before[126]?.summary).toBe('result 126');
    expect(before[127]?.summary).toContain('73 further test results');

    // A second run of the same session: a fresh admission window, the earlier
    // run's results still on record, and the cumulative suppressed count
    // carried forward rather than restated as new.
    manager.beginTestRun(sessionId);
    const second = await manager.recordTestResult(sessionId, {
      status: 'failed', summary: 'second run', exitCode: 1, durationMs: 1,
    });
    expect(second.accepted).toBe(true);
    expect(second.suppressed).toBe(73);
    const afterSecond = (await manager.review(sessionId)).review.tests;
    expect(afterSecond).toHaveLength(129);
    expect(afterSecond[127]?.summary).toContain('73 further test results');
    expect(afterSecond[128]?.summary).toBe('second run');

    // A restart also opens a fresh window, and rehydrates the history and the
    // cumulative count from disk.
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    const next = await restarted.recordTestResult(sessionId, {
      status: 'failed', summary: 'after restart', exitCode: 1, durationMs: 1,
    });
    expect(next.accepted).toBe(true);
    expect(next.suppressed).toBe(73);
    const after = (await restarted.review(sessionId)).review.tests;
    expect(after).toHaveLength(130);
    expect(after[127]?.summary).toContain('73 further test results');
    expect(after.at(-1)?.summary).toBe('after restart');

    // Refused results cost one bounded write for the whole run, not one per
    // frame: admission is in memory and the flush is the caller's.
    restarted.beginTestRun(sessionId);
    for (let index = 0; index < 127; index += 1) {
      restarted.admitTestResult(sessionId, { status: 'passed', summary: `run3 ${String(index)}`, exitCode: 0, durationMs: 1 });
    }
    const refused = Array.from({ length: 500 }, () => restarted.admitTestResult(sessionId, {
      status: 'failed', summary: 'refused', exitCode: 1, durationMs: 1,
    }));
    expect(refused.every((outcome) => !outcome.accepted)).toBe(true);
    expect(restarted.suppressedTestSummary(sessionId)?.suppressed).toBe(500);
    await restarted.flushTestInventory(sessionId);
    const third = (await restarted.review(sessionId)).review.tests;
    // 130 + 127 admitted + one summary, inside the durable retention ceiling.
    expect(third).toHaveLength(258);
    expect(third.at(-1)?.summary).toContain('500 further test results');

    await manager.discard(sessionId);
  }, 30_000);

  it('serializes apply and discard lifecycle mutations per session', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const applyId = '7f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId: applyId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'concurrent.txt'), 'one\n');
    const firstApply = manager.apply(applyId);
    const secondApply = manager.apply(applyId);
    const applyResults = await Promise.allSettled([firstApply, secondApply]);
    expect(applyResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(applyResults.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'validation' });
    expect(await readFile(join(paths.target, 'concurrent.txt'), 'utf8')).toBe('one\n');
    await manager.discard(applyId);

    const mixedId = '8f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const mixed = await manager.prepare({ sessionId: mixedId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(mixed.workspacePath, 'mixed.txt'), 'two\n');
    const apply = manager.apply(mixedId);
    const discard = manager.discard(mixedId);
    const mixedResults = await Promise.allSettled([apply, discard]);
    expect(mixedResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mixedResults.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'validation' });
    await manager.discard(mixedId);
  });

  it('restores the primary tree from a bounded journal after a simulated process death', async () => {
    const paths = await fixture();
    const outside = join(paths.root, 'outside-preserved.txt');
    await writeFile(outside, 'must remain\n');
    await writeFile(join(paths.target, 'remove.txt'), 'restore this file\n');
    let mutations = 0;
    const manager = new AgentEnvironmentManager(withEnvironmentShell({
      root: paths.appRoot,
      applyFaultInjector: () => mutations++ === 0 ? 'process-death' : undefined,
    }));
    const sessionId = '3f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'created\n');
    await rm(join(prepared.workspacePath, 'remove.txt'));
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);
    expect(await readFile(join(paths.target, 'created.txt'), 'utf8')).toBe('created\n');
    const journal = await readJournal(join(paths.appRoot, sessionId, await recoveryName(join(paths.appRoot, sessionId)), 'transaction.json'));
    expect(journal).toMatchObject({ version: 2, state: 'prepared' });
    expect(journalArray(journal, 'backups').length).toBeGreaterThan(0);
    expect(journalArray(journal, 'createdDirectories').every((item) => typeof item === 'string' && !item.includes('..'))).toBe(true);

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(paths.target, 'remove.txt'), 'utf8')).toBe('restore this file\n');
    await expect(readFile(join(paths.target, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(outside, 'utf8')).toBe('must remain\n');
    await expect(restarted.review(sessionId)).resolves.toMatchObject({ review: { diffAvailable: true } });
    await restarted.discard(sessionId);
  });

  it('binds recovery journals to current metadata before touching a forged outside target', async () => {
    const paths = await fixture();
    const outside = join(paths.root, 'outside-target');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'created.txt'), 'must remain byte-identical\n');
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, applyFaultInjector: dieOnceAt('after-target-mutation') }));
    const sessionId = '8f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'agent-created\n');
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);
    const sessionRoot = join(paths.appRoot, sessionId);
    const transactionPath = join(sessionRoot, await recoveryName(sessionRoot), 'transaction.json');
    const journal = await readJournal(transactionPath);
    const previousMetadata = journalRecord(journal, 'previousMetadata');
    await writeFile(transactionPath, JSON.stringify({ ...journal, targetPath: outside, previousMetadata: { ...previousMetadata, targetPath: outside } }));
    await expect(new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot })).initialize()).rejects.toThrow(/session metadata|match|target/i);
    expect(await readFile(join(outside, 'created.txt'), 'utf8')).toBe('must remain byte-identical\n');

    await writeFile(transactionPath, JSON.stringify({ ...journal, previousMetadata: { ...previousMetadata, sessionId: '00000000-0000-4000-8000-000000000000' } }));
    await expect(new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot })).initialize()).rejects.toThrow(/metadata|identity|match/i);
    expect(await readFile(join(outside, 'created.txt'), 'utf8')).toBe('must remain byte-identical\n');
  });

  it('restores metadata after interruption between metadata persistence and journal commit', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, applyFaultInjector: dieOnceAt('before-journal-commit') }));
    const sessionId = '9f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after-metadata-boundary\n');
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);
    const sessionRoot = join(paths.appRoot, sessionId);
    expect(await metadataApplied(sessionRoot)).toBe(true);
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(await metadataApplied(sessionRoot)).toBe(false);
    await restarted.discard(sessionId);
  });

  it('recovers when an interrupted atomic metadata write leaves a torn temporary', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, applyFaultInjector: dieOnceAt('after-metadata-temp-write') }));
    const sessionId = 'bf9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after-torn-metadata\n');
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);
    const sessionRoot = join(paths.appRoot, sessionId);
    // Simulate a process dying while the metadata temp file itself is only
    // partially written. The old canonical environment.json remains intact.
    await writeFile(join(sessionRoot, '.environment.json.tmp'), '{"version":', { encoding: 'utf8', mode: 0o600 });
    expect(await metadataApplied(sessionRoot)).toBe(false);
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    await expect(readdir(sessionRoot)).resolves.not.toContain('.environment.json.tmp');
    await restarted.discard(sessionId);
  });

  it('cleans a durably committed journal after restart without rolling back the applied target', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, applyFaultInjector: dieOnceAt('after-journal-commit') }));
    const sessionId = 'af9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'committed-before-restart\n');
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);
    const sessionRoot = join(paths.appRoot, sessionId);
    expect(await readJournal(join(sessionRoot, await recoveryName(sessionRoot), 'transaction.json'))).toMatchObject({ state: 'committed' });
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('committed-before-restart\n');
    expect((await readdir(sessionRoot)).some((entry) => entry.startsWith('recovery-'))).toBe(false);
    expect((await restarted.review(sessionId)).review.applyAllowed).toBe(false);
    await restarted.discard(sessionId);
  });

  it('cleans only empty or lone bounded pre-journal recovery shapes and preserves target data', async () => {
    const emptyPaths = await fixture();
    const emptyId = '4f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const emptyManager = new AgentEnvironmentManager(withEnvironmentShell({ root: emptyPaths.appRoot }));
    await emptyManager.prepare({ sessionId: emptyId, mode: 'isolated-copy', canonicalTargetPath: emptyPaths.target });
    const emptyRecovery = join(emptyPaths.appRoot, emptyId, 'recovery-4f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await mkdir(emptyRecovery, { recursive: true });
    const emptyRestart = new AgentEnvironmentManager(withEnvironmentShell({ root: emptyPaths.appRoot }));
    await emptyRestart.initialize();
    await expect(readFile(join(emptyPaths.target, 'hello.txt'), 'utf8')).resolves.toBe('before\n');
    await expect(readdir(join(emptyPaths.appRoot, emptyId))).resolves.not.toContain('recovery-4f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await emptyRestart.discard(emptyId);

    const tempPaths = await fixture();
    const tempId = '5f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const tempManager = new AgentEnvironmentManager(withEnvironmentShell({ root: tempPaths.appRoot }));
    await tempManager.prepare({ sessionId: tempId, mode: 'isolated-copy', canonicalTargetPath: tempPaths.target });
    const tempRecovery = join(tempPaths.appRoot, tempId, 'recovery-5f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await mkdir(tempRecovery, { recursive: true });
    await writeFile(join(tempRecovery, '.transaction.json.tmp'), '{"partial":true}', { mode: 0o600 });
    const stage = join(tempPaths.root, '.interleaf-stage-5f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'partial-stage.txt'), 'must be removed');
    const tempRestart = new AgentEnvironmentManager(withEnvironmentShell({ root: tempPaths.appRoot }));
    await tempRestart.initialize();
    await expect(readFile(join(tempPaths.target, 'hello.txt'), 'utf8')).resolves.toBe('before\n');
    await expect(readFile(join(stage, 'partial-stage.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(tempPaths.appRoot, tempId))).resolves.not.toContain('recovery-5f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await tempRestart.discard(tempId);
  });

  it('fails closed on an unexpected pre-journal recovery entry', async () => {
    const paths = await fixture();
    const sessionId = '6f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    const recovery = join(paths.appRoot, sessionId, 'recovery-6f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958');
    await mkdir(recovery, { recursive: true });
    await writeFile(join(recovery, 'unexpected-entry'), 'reject');
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await expect(restarted.initialize()).rejects.toThrow(/unexpected entry|recovery/i);
    await expect(readFile(join(paths.target, 'hello.txt'), 'utf8')).resolves.toBe('before\n');
  });

  it('blocks drift and symlink escapes, and serializes same-target sessions', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const first = await manager.prepare({ sessionId: '5c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await expect(manager.prepare({ sessionId: '6c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: paths.target })).rejects.toThrow(/already using/i);
    await writeFile(join(paths.target, 'hello.txt'), 'drift\n');
    await writeFile(join(first.workspacePath, 'hello.txt'), 'agent\n');
    await expect(manager.apply('5c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1')).rejects.toThrow(/changed|drift/i);
    await manager.discard('5c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1');
    await writeFile(join(paths.root, 'outside.txt'), 'outside\n');
    await symlink(join(paths.root, 'outside.txt'), join(paths.target, 'escape')); 
    await expect(manager.prepare({ sessionId: '7c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: paths.target })).rejects.toThrow(/symlink/i);
  });

  it('locks overlapping directory scopes and releases direct-mode state across restart', async () => {
    const paths = await fixture();
    const nested = join(paths.target, 'nested');
    await mkdir(nested, { recursive: true });
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const first = await manager.prepare({ sessionId: 'cf0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await expect(manager.prepare({ sessionId: 'df0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: nested })).rejects.toThrow(/already using/i);
    await manager.discard(first.review.mode === 'isolated-copy' ? 'cf0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1' : '');
    const directId = 'ef0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1';
    await manager.prepare({ sessionId: directId, mode: 'active-env', canonicalTargetPath: paths.target });
    await writeFile(join(paths.target, 'direct.txt'), 'direct');
    expect((await manager.review(directId)).review.activeWorkspaceModified).toBe(true);
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect((await restarted.review(directId)).review.activeWorkspaceModified).toBe(true);
    await restarted.discard(directId);
    await expect(restarted.prepare({ sessionId: 'ff0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-copy', canonicalTargetPath: paths.target })).resolves.toBeDefined();
    await restarted.discard('ff0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1');
  });

  it('retains valid prepared unapplied copy and worktree environments past the abandonment age, and still reaps applied ones', async () => {
    // Item F: age is not abandonment. Until the user applies or discards, an
    // isolated workspace is the only copy of the agent's work, so startup must
    // keep it and keep it reviewable.
    const eightDaysOn = (): Date => new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000);

    const copyPaths = await fixture();
    const copyManager = new AgentEnvironmentManager(withEnvironmentShell({ root: copyPaths.appRoot }));
    const unappliedId = '3b0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1';
    const appliedId = '4b0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1';
    const unapplied = await copyManager.prepare({ sessionId: unappliedId, mode: 'isolated-copy', canonicalTargetPath: copyPaths.target });
    await writeFile(join(unapplied.workspacePath, 'hello.txt'), 'unapplied work\n');
    await writeFile(join(unapplied.workspacePath, 'created.txt'), 'new\n');

    const agedCopy = new AgentEnvironmentManager(withEnvironmentShell({ root: copyPaths.appRoot, now: eightDaysOn }));
    await agedCopy.initialize();
    const copyReview = await agedCopy.review(unappliedId);
    expect(copyReview.review.applyAllowed).toBe(true);
    expect(copyReview.review.changedFiles.map((file) => file.path)).toEqual(['created.txt', 'hello.txt']);
    expect(await readFile(join(agedCopy.getWorkspacePath(unappliedId), 'hello.txt'), 'utf8')).toBe('unapplied work\n');
    // The retained environment is still a real lifecycle participant.
    await agedCopy.apply(unappliedId);
    expect(await readFile(join(copyPaths.target, 'hello.txt'), 'utf8')).toBe('unapplied work\n');

    await agedCopy.discard(unappliedId);

    // An environment whose work has already been delivered is not the only
    // copy of anything, so it still ages out.
    const applied = await agedCopy.prepare({ sessionId: appliedId, mode: 'isolated-copy', canonicalTargetPath: copyPaths.target });
    await writeFile(join(applied.workspacePath, 'hello.txt'), 'delivered\n');
    await agedCopy.apply(appliedId);
    const reaping = new AgentEnvironmentManager(withEnvironmentShell({ root: copyPaths.appRoot, now: () => new Date(Date.now() + 16 * 24 * 60 * 60 * 1_000) }));
    await reaping.initialize();
    expect(await readdir(copyPaths.appRoot)).not.toContain(appliedId);

    const gitPaths = await fixture();
    commitAll(gitPaths.target);
    const worktreeId = '5b0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1';
    const gitManager = new AgentEnvironmentManager(withEnvironmentShell({ root: gitPaths.appRoot }));
    const worktree = await gitManager.prepare({ sessionId: worktreeId, mode: 'isolated-worktree', canonicalTargetPath: gitPaths.target });
    await writeFile(join(worktree.workspacePath, 'hello.txt'), 'worktree work\n');

    const agedGit = new AgentEnvironmentManager(withEnvironmentShell({ root: gitPaths.appRoot, now: eightDaysOn }));
    await agedGit.initialize();
    expect((await agedGit.review(worktreeId)).review.changedFiles.map((file) => file.path)).toEqual(['hello.txt']);
    // Neither the registered worktree nor its branch was reclaimed for age.
    expect(git(gitPaths.target, 'worktree', 'list', '--porcelain')).toContain(join(gitPaths.appRoot, worktreeId, 'worktree'));
    expect(git(gitPaths.target, 'branch', '--list', `interleaf/${worktreeId}`).trim()).toContain(`interleaf/${worktreeId}`);
    await agedGit.apply(worktreeId);
    expect(await readFile(join(gitPaths.target, 'hello.txt'), 'utf8')).toBe('worktree work\n');
    await agedGit.discard(worktreeId);
  });

  it('prepares a Git worktree and excludes a dirty primary from apply', async () => {
    const paths = await fixture();
    commitAll(paths.target);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const sessionId = '8c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'worktree\n');
    await expect(manager.review(sessionId)).resolves.toMatchObject({ review: { applyAllowed: true } });
    await manager.discard(sessionId);
    await writeFile(join(paths.target, 'dirty.txt'), 'dirty\n');
    const dirty = await manager.prepare({ sessionId: '9c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1', mode: 'isolated-worktree', canonicalTargetPath: paths.target });
    expect(dirty.review.primaryWasDirty).toBe(true);
    expect(dirty.review.applyAllowed).toBe(false);
    await manager.discard('9c0d0f34-8ef5-4fc7-9c20-ae1d4eec6bc1');
  });

  it('rehydrates an isolated Git worktree across restart, then applies and cleans its branch', async () => {
    const paths = await fixture();
    commitAll(paths.target);
    const sessionId = '7f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'restart-applied\n');
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await restarted.initialize();
    expect((await restarted.review(sessionId)).review.changedFiles.map((file) => file.path)).toEqual(['hello.txt']);
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(git(paths.target, 'worktree', 'list', '--porcelain')).toContain(join(paths.appRoot, sessionId, 'worktree'));
    expect(git(paths.target, 'branch', '--list', `interleaf/${sessionId}`).trim()).toContain(`interleaf/${sessionId}`);
    await restarted.apply(sessionId);
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('restart-applied\n');
    await restarted.discard(sessionId);
    expect(git(paths.target, 'worktree', 'list', '--porcelain')).not.toContain(join(paths.appRoot, sessionId, 'worktree'));
    expect(git(paths.target, 'branch', '--list', `interleaf/${sessionId}`).trim()).toBe('');
  });

  it('applies structural directory changes, replacements, modes, and binary files without duplicate operations', async () => {
    const paths = await fixture();
    await mkdir(join(paths.target, 'remove', 'nested'), { recursive: true });
    await writeFile(join(paths.target, 'remove', 'nested', 'gone.txt'), 'gone');
    await writeFile(join(paths.target, 'replace'), 'file-to-directory');
    await mkdir(join(paths.target, 'directory-to-file', 'child'), { recursive: true });
    await writeFile(join(paths.target, 'directory-to-file', 'child', 'old.txt'), 'old');
    await writeFile(join(paths.target, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const sessionId = 'af9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await rm(join(prepared.workspacePath, 'remove'), { recursive: true, force: true });
    await rm(join(prepared.workspacePath, 'replace'), { force: true });
    await mkdir(join(prepared.workspacePath, 'replace', 'child'), { recursive: true });
    await writeFile(join(prepared.workspacePath, 'replace', 'child', 'created.txt'), 'created');
    await writeFile(join(prepared.workspacePath, 'binary.bin'), Buffer.from([0, 4, 5, 6]));
    await rm(join(prepared.workspacePath, 'directory-to-file'), { recursive: true, force: true });
    await writeFile(join(prepared.workspacePath, 'directory-to-file'), 'replacement-file');
    await mkdir(join(prepared.workspacePath, 'new-parent', 'nested'), { recursive: true, mode: 0o711 });
    await chmod(join(prepared.workspacePath, 'new-parent'), 0o711);
    await chmod(join(prepared.workspacePath, 'new-parent', 'nested'), 0o750);
    await writeFile(join(prepared.workspacePath, 'new-parent', 'nested', 'created.txt'), 'nested-created');
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'mode-change\n', { mode: 0o700 });
    await chmod(join(prepared.workspacePath, 'replace'), 0o700);
    expect((await manager.review(sessionId)).review.patchAvailable).toBe(false);
    await expect(manager.exportPatch(sessionId)).rejects.toThrow(/binary|applicable/i);
    await manager.apply(sessionId);
    await expect(readFile(join(paths.target, 'remove', 'nested', 'gone.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(paths.target, 'replace', 'child', 'created.txt'), 'utf8')).toBe('created');
    expect(await readFile(join(paths.target, 'directory-to-file'), 'utf8')).toBe('replacement-file');
    expect(await readFile(join(paths.target, 'new-parent', 'nested', 'created.txt'), 'utf8')).toBe('nested-created');
    expect((await stat(join(paths.target, 'new-parent'))).mode & 0o777).toBe(0o711);
    expect((await stat(join(paths.target, 'new-parent', 'nested'))).mode & 0o777).toBe(0o750);
    expect([...await readFile(join(paths.target, 'binary.bin'))]).toEqual([0, 4, 5, 6]);
    expect((await stat(join(paths.target, 'replace'))).mode & 0o777).toBe(0o700);
    await manager.discard(sessionId);
  });

  it('isolates a selected Git subdirectory while retaining repository-root worktree lifecycle', async () => {
    const paths = await fixture();
    const selected = join(paths.target, 'packages', 'app');
    await mkdir(selected, { recursive: true });
    await writeFile(join(selected, 'nested.txt'), 'before');
    commitAll(paths.target);
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const sessionId = 'bf9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: selected });
    expect(prepared.workspacePath).toContain(join('worktree', 'packages', 'app'));
    await writeFile(join(prepared.workspacePath, 'nested.txt'), 'after');
    await manager.apply(sessionId);
    expect(await readFile(join(selected, 'nested.txt'), 'utf8')).toBe('after');
    await manager.discard(sessionId);
    expect(git(paths.target, 'worktree', 'list', '--porcelain')).not.toContain(join(paths.appRoot, sessionId));
  });

  it('does not delete corrupted metadata or paths outside the app-owned cleanup root', async () => {
    const paths = await fixture();
    const sessionId = '0f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const sessionRoot = join(paths.appRoot, sessionId);
    const outside = join(paths.root, 'outside-preserved');
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(outside, 'preserve');
    await writeFile(join(sessionRoot, 'environment.json'), JSON.stringify({ sessionId, mode: 'isolated-copy', targetPath: outside, workspacePath: outside, sessionRoot, baselinePath: outside, workspaceRoot: outside }));
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    await manager.initialize();
    expect(await readFile(outside, 'utf8')).toBe('preserve');
    expect(await readFile(join(sessionRoot, 'environment.json'), 'utf8')).toContain(sessionId);
  });

  it('persists a bounded Git cleanup record across post-registration failure and retries removal', async () => {
    const paths = await fixture();
    const outside = join(paths.root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(paths.target, 'unsafe-link'));
    commitAll(paths.target);
    let failRemoval = true;
    const runGit = (cwd: string, args: readonly string[]): Promise<string> => {
      if (failRemoval && args[0] === 'worktree' && args[1] === 'remove') {
        failRemoval = false;
        return Promise.reject(new Error('injected worktree removal failure'));
      }
      return Promise.resolve(git(cwd, ...args).trim());
    };
    const sessionId = '1f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, runGit }));
    await expect(manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: paths.target })).rejects.toThrow(/recovery is required/i);
    const pending = await readFile(join(paths.appRoot, sessionId, 'pending-git-cleanup.json'), 'utf8');
    expect(pending).toContain(sessionId);
    await expect(manager.discard(sessionId)).rejects.toThrow(/cleanup is still pending/i);
    await expect(manager.prepare({ sessionId: '2f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958', mode: 'isolated-worktree', canonicalTargetPath: paths.target })).rejects.toThrow(/already using/i);
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, runGit }));
    await restarted.initialize();
    expect(git(paths.target, 'worktree', 'list', '--porcelain')).not.toContain(join(paths.appRoot, sessionId));
    expect(git(paths.target, 'branch', '--list', `interleaf/${sessionId}`).trim()).toBe('');
  });

  it('exports an applicable standard copy-mode patch for text create/modify/delete changes', async () => {
    const paths = await fixture();
    await writeFile(join(paths.target, 'remove.txt'), 'remove me\n');
    let capturedPatch = '';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, savePatch: (_fileName, contents) => { capturedPatch = contents; return Promise.resolve(true); } }));
    const sessionId = '2f9c9a6e-4e3e-4e87-bd0f-dc5cae0cf958';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await rm(join(prepared.workspacePath, 'remove.txt'));
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'created\n');
    await manager.exportPatch(sessionId);
    expect(capturedPatch).toMatch(/diff --git a\/created\.txt b\/created\.txt/);
    expect(capturedPatch).toMatch(/--- \/dev\/null/);
    expect(capturedPatch).toMatch(/\+\+\+ b\/created\.txt/);
    expect(capturedPatch).toMatch(/@@ /);
    expect(capturedPatch).toMatch(/diff --git a\/remove\.txt b\/remove\.txt/);
    const pristine = join(paths.root, 'pristine');
    await mkdir(pristine, { recursive: true });
    await writeFile(join(pristine, 'hello.txt'), 'before\n');
    await writeFile(join(pristine, 'remove.txt'), 'remove me\n');
    commitAll(pristine, 'pristine');
    execFileSync('git', ['-C', pristine, 'apply', '--index'], { input: capturedPatch });
    expect(await readFile(join(pristine, 'hello.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(pristine, 'created.txt'), 'utf8')).toBe('created\n');
    await expect(readFile(join(pristine, 'remove.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await manager.discard(sessionId);
  });
  it('reports a closed save dialog as a typed cancellation, not an error', async () => {
    const paths = await fixture();
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, savePatch: () => Promise.resolve(false) }));
    const sessionId = '6a0f3c1e-2d4b-4c8a-9e7f-1b2c3d4e5f60';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await expect(manager.exportPatch(sessionId)).resolves.toEqual({ outcome: 'cancelled' });
    await manager.discard(sessionId);
  });
  it('refuses to apply when the target is replaced after the early identity check', async () => {
    // Apply's entry check is followed by the review, the Git inspections, and
    // two directory snapshots. That window is long enough to swap the target
    // for a byte-identical replacement, which every content comparison accepts
    // and only a second identity check can catch.
    const paths = await fixture();
    const manager = new WindowedEnvironmentManager(withEnvironmentShell({ root: paths.appRoot }));
    const sessionId = 'c1d4f0a2-6b52-4a71-9f1a-8d0f9e2b7c31';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'new\n');
    const before = (await statWithIdentity(paths.target)).identity;

    // The review step stands in for that whole await window: the replacement
    // happens strictly after apply's early identity check.
    manager.onReview = async () => {
      await rm(paths.target, { recursive: true, force: true });
      await mkdir(paths.target, { recursive: true });
      await writeFile(join(paths.target, 'hello.txt'), 'before\n');
    };

    await expect(manager.apply(sessionId)).rejects.toThrow(/replaced|cannot continue|changed/iu);

    // A new directory, and apply touched none of it: no staged content, no
    // created file, no staging or recovery sibling.
    const after = (await statWithIdentity(paths.target)).identity;
    expect(sameFileIdentity(before, after)).toBe(false);
    expect(await readdir(paths.target)).toEqual(['hello.txt']);
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(await readdir(paths.root)).not.toContain(`.interleaf-stage-${sessionId}`);
    // The isolated workspace still holds the agent's work, unchanged.
    expect(await readFile(join(prepared.workspacePath, 'created.txt'), 'utf8')).toBe('new\n');
    vi.restoreAllMocks();
  });

  it('refuses to apply when the target is replaced during the final protected-root check', async () => {
    // The protected-root policy canonicalizes the candidate and then awaits
    // canonicalization of every configured root, so it is itself a window in
    // which the target can be swapped after its own lookup. The persisted
    // file-identity proof must therefore be the last asynchronous check before
    // any mutation state exists, not the one that runs before the policy.
    const paths = await fixture();
    const policy = new ProtectedRootPolicy([paths.appRoot]);
    const manager = new WindowedEnvironmentManager(withEnvironmentShell({ root: paths.appRoot, rootPolicy: policy }));
    const sessionId = 'f8a1b7c3-2d4e-4f60-9a11-5c7e3b9d0a42';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: paths.target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await writeFile(join(prepared.workspacePath, 'created.txt'), 'new\n');
    const sessionRoot = dirname(prepared.workspacePath);
    const metadataBefore = await readFile(join(sessionRoot, 'environment.json'), 'utf8');
    const before = (await statWithIdentity(paths.target)).identity;

    let calls = 0;
    vi.spyOn(policy, 'assertSelectable').mockImplementation(async (candidatePath: string) => {
      const canonical = await realpath(candidatePath);
      calls += 1;
      // Only the final pre-mutation call, so this isolates the last window.
      if (calls === 2) {
        await rm(paths.target, { recursive: true, force: true });
        await mkdir(paths.target, { recursive: true });
        await writeFile(join(paths.target, 'hello.txt'), 'before\n');
      }
      // Stands in for the remaining asynchronous root canonicalization.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      return canonical;
    });

    await expect(manager.apply(sessionId)).rejects.toThrow(/replaced|cannot continue|changed/iu);
    expect(calls).toBe(2);

    // No recovery journal, no staging sibling, no write into the replacement,
    // and the session's own recorded state is byte-for-byte unchanged.
    const after = (await statWithIdentity(paths.target)).identity;
    expect(sameFileIdentity(before, after)).toBe(false);
    expect(await readdir(sessionRoot)).not.toContainEqual(expect.stringMatching(/^recovery-/u));
    expect(await readdir(paths.root)).not.toContain(`.interleaf-stage-${sessionId}`);
    expect(await readdir(paths.target)).toEqual(['hello.txt']);
    expect(await readFile(join(paths.target, 'hello.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(sessionRoot, 'environment.json'), 'utf8')).toBe(metadataBefore);
    expect(await readFile(join(prepared.workspacePath, 'created.txt'), 'utf8')).toBe('new\n');
    vi.restoreAllMocks();
  });
});
