import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { isSafeRelativePath, toManifestRelativePath } from '@main/agents/relative-path';
import { isPortableRecord, parsePortableJson, type PortableRecord } from '@shared/models/portable';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/** A persisted JSON document, read back as the object it must be. */
async function readJsonRecord(path: string): Promise<PortableRecord> {
  const parsed = parsePortableJson(await readFile(path, 'utf8'));
  if (!isPortableRecord(parsed)) throw new Error(`${path} must hold a JSON object.`);
  return parsed;
}


/**
 * Item E: segment-aware relative-path validation at every manifest, recovery,
 * and diff boundary.
 *
 * The replaced implementation searched for the substring `..`, so it rejected
 * an ordinary filename such as `foo..bar` and said nothing about empty
 * segments, NUL, `.`, drive-relative prefixes, or mixed separators. These cases
 * pin the grammar in both directions and exercise it through the real copy and
 * Git restart/rehydrate boundaries rather than through the predicate alone.
 */
describe('agent manifest relative-path validation (item E)', () => {
  it('accepts ordinary names that merely contain a dot-dot substring', () => {
    for (const value of [
      'foo..bar',
      'archive..2024.tar',
      '..hidden',
      'trailing..',
      '...',
      'a/b..c/d',
      'dir./file',
      '.hidden/file.txt',
      'a'.repeat(255),
    ]) {
      expect(isSafeRelativePath(value), value).toBe(true);
    }
  });

  it('rejects empty, overlong, NUL, absolute, drive, UNC, dot and dot-dot segment forms', () => {
    for (const value of [
      '',
      'a'.repeat(1_025),
      `${'a'.repeat(256)}/b`,
      'a\u0000b',
      'a/\u0000/b',
      'a\u001fb',
      '/etc/passwd',
      '//server/share/file',
      '\\\\server\\share',
      '\\etc\\passwd',
      'C:/Windows/System32',
      'c:relative/file',
      'a\\..\\..\\b',
      'a\\b',
      '..',
      '../escape',
      'a/../../escape',
      'a/..',
      '.',
      './a',
      'a/./b',
      'a//b',
      'a/',
      '/a',
    ]) {
      expect(isSafeRelativePath(value), value).toBe(false);
    }
  });

  it('retains a dot-dot-containing filename through copy preparation, restart rehydrate, review and apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-manifest-path-'));
    const target = join(root, 'target');
    const appRoot = join(root, 'app-workspaces');
    await mkdir(join(target, 'nested'), { recursive: true });
    // The substring check filtered this entry out of the manifest, which made
    // the whole manifest unreadable and the environment unreviewable.
    await writeFile(join(target, 'foo..bar'), 'before\n');
    await writeFile(join(target, 'nested', 'release..2024.txt'), 'nested\n');

    const sessionId = '2b7c9a6e-4e3e-4e87-bd0f-dc5cae0cf901';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: target });
    expect(await readFile(join(prepared.workspacePath, 'foo..bar'), 'utf8')).toBe('before\n');
    await writeFile(join(prepared.workspacePath, 'foo..bar'), 'after\n');

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await restarted.initialize();
    const review = await restarted.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['foo..bar']);
    expect(review.review.diff).toContain('foo..bar');

    await restarted.apply(sessionId);
    expect(await readFile(join(target, 'foo..bar'), 'utf8')).toBe('after\n');
    expect(await readFile(join(target, 'nested', 'release..2024.txt'), 'utf8')).toBe('nested\n');
    await restarted.discard(sessionId);
    await rm(root, { recursive: true, force: true });
  });

  it('retains a dot-dot-containing filename across a Git worktree restart and rehydrate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-manifest-git-'));
    const target = join(root, 'repo');
    const appRoot = join(root, 'app-workspaces');
    await mkdir(target, { recursive: true });
    const git = (...args: string[]): void => { execFileSync('git', ['-C', target, ...args], { stdio: 'ignore' }); };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'agent@example.test');
    git('config', 'user.name', 'Agent Fixture');
    await writeFile(join(target, 'foo..bar'), 'before\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    const sessionId = '3b7c9a6e-4e3e-4e87-bd0f-dc5cae0cf902';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: target });
    await writeFile(join(prepared.workspacePath, 'foo..bar'), 'after\n');

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await restarted.initialize();
    const review = await restarted.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['foo..bar']);
    await restarted.apply(sessionId);
    expect(await readFile(join(target, 'foo..bar'), 'utf8')).toBe('after\n');
    await restarted.discard(sessionId);
    await rm(root, { recursive: true, force: true });
  });

  it('persists a Windows host subdirectory in canonical slash form', () => {
    // Item E correction (finding 4): `path.relative` answers `packages\app` on
    // Windows. Persisting the host answer verbatim persisted something this
    // module's own validator rejects, so a Windows session could not rehydrate
    // its own worktree after a restart. The separator is translated at the one
    // point the host produces it, and nowhere else.
    expect(toManifestRelativePath('packages\\app', '\\')).toBe('packages/app');
    expect(toManifestRelativePath('packages\\app\\dist', '\\')).toBe('packages/app/dist');
    expect(toManifestRelativePath('packages/app', '/')).toBe('packages/app');
    expect(toManifestRelativePath('', '\\')).toBe('');
    // Translating a separator is not the same as accepting traversal: the
    // canonical result is still validated by segment.
    expect(() => toManifestRelativePath('packages\\..\\..\\etc', '\\')).toThrow(/unsafe relative path/iu);
    expect(() => toManifestRelativePath('C:\\Windows', '\\')).toThrow(/unsafe relative path/iu);
    // On a POSIX host a backslash is an ordinary name character, not a
    // separator, so it is refused rather than reinterpreted.
    expect(() => toManifestRelativePath('packages\\app', '/')).toThrow(/unsafe relative path/iu);
  });

  it('accepts the canonical subdirectory after a restart and refuses a backslash one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-manifest-subdir-'));
    const target = join(root, 'repo');
    const appRoot = join(root, 'app-workspaces');
    await mkdir(join(target, 'packages', 'app'), { recursive: true });
    const git = (...args: string[]): void => { execFileSync('git', ['-C', target, ...args], { stdio: 'ignore' }); };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'agent@example.test');
    git('config', 'user.name', 'Agent Fixture');
    await writeFile(join(target, 'packages', 'app', 'main.txt'), 'before\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    const sessionId = '5b7c9a6e-4e3e-4e87-bd0f-dc5cae0cf904';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: join(target, 'packages', 'app') });
    const metadataPath = join(appRoot, sessionId, 'environment.json');
    const metadata = await readJsonRecord(metadataPath);
    // Whatever the host separator was, the persisted form is the canonical one.
    expect(metadata.selectedRelativePath).toBe('packages/app');

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await restarted.initialize();
    expect((await restarted.review(sessionId)).sessionId).toBe(sessionId);
    await restarted.discard(sessionId);

    // The persisted record stays untrusted on the way back in: a manifest that
    // carries backslashes is refused, not normalized into a second meaning.
    const sessionId2 = '6b7c9a6e-4e3e-4e87-bd0f-dc5cae0cf905';
    const second = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await second.prepare({ sessionId: sessionId2, mode: 'isolated-worktree', canonicalTargetPath: join(target, 'packages', 'app') });
    const secondPath = join(appRoot, sessionId2, 'environment.json');
    const secondMetadata = await readJsonRecord(secondPath);
    await writeFile(secondPath, JSON.stringify({ ...secondMetadata, selectedRelativePath: 'packages\\app' }));
    const tampered = new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot }));
    await tampered.initialize();
    await expect(tampered.review(sessionId2)).rejects.toThrow(/no longer available/iu);
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('refuses a recovery journal whose backup record carries a dot segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-manifest-journal-'));
    const target = join(root, 'target');
    const appRoot = join(root, 'app-workspaces');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'hello.txt'), 'before\n');
    let interrupted = false;
    const manager = new AgentEnvironmentManager(withEnvironmentShell({
      root: appRoot,
      applyFaultInjector: ({ phase }) => phase === 'after-target-mutation' && !interrupted ? (interrupted = true, 'process-death') : undefined,
    }));
    const sessionId = '4b7c9a6e-4e3e-4e87-bd0f-dc5cae0cf903';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: target });
    await writeFile(join(prepared.workspacePath, 'hello.txt'), 'after\n');
    await expect(manager.apply(sessionId)).rejects.toThrow(/interrupted|recovery/i);

    const sessionRoot = join(appRoot, sessionId);
    const recoveryName = (await readdir(sessionRoot)).find((entry) => entry.startsWith('recovery-'));
    if (recoveryName === undefined) throw new Error('Apply recovery journal was not retained after interruption.');
    const transactionPath = join(sessionRoot, recoveryName, 'transaction.json');
    const journal = await readJsonRecord(transactionPath);
    const backups = journal.backups as { relativePath: string; backupRelativePath: string | null; existed: boolean }[];
    const first = backups[0];
    if (first === undefined) throw new Error('The interrupted apply journaled no backup.');
    await writeFile(transactionPath, JSON.stringify({
      ...journal,
      backups: [{ ...first, relativePath: `./${first.relativePath}` }],
    }));
    await expect(new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })).initialize()).rejects.toThrow(/unsafe|backup|path/i);
    expect(await readFile(join(target, 'hello.txt'), 'utf8')).toBe('after\n');
    await rm(root, { recursive: true, force: true });
  });
});
