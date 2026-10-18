import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { readGitTrackedIndex } from '@main/agents/git-tracked-index';
import { isPortableRecord, parsePortableJson, type PortableRecord, type PortableRecordDraft } from '@shared/models/portable';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/** A persisted JSON document, read back as the object it must be. */
async function readJsonRecord(path: string): Promise<PortableRecord> {
  const parsed = parsePortableJson(await readFile(path, 'utf8'));
  if (!isPortableRecord(parsed)) throw new Error(`${path} must hold a JSON object.`);
  return parsed;
}

type Repo = { readonly root: string; readonly target: string; readonly appRoot: string; readonly commitBaseline: () => void };

async function repository(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-git-index-'));
  const target = join(root, 'repo');
  const appRoot = join(root, 'app-workspaces');
  await mkdir(target, { recursive: true });
  const git = (...args: string[]): void => { execFileSync('git', ['-C', target, ...args], { stdio: 'ignore' }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'agent@example.test');
  git('config', 'user.name', 'Agent Fixture');
  const commitBaseline = (): void => {
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
  };
  return { root, target, appRoot, commitBaseline };
}

describe('index-aware Git tracked paths (item K)', () => {
  it('retains tracked dist/ and vendor/ content through baseline, review, apply and patch export', async () => {
    const repo = await repository();
    await mkdir(join(repo.target, 'dist'), { recursive: true });
    await mkdir(join(repo.target, 'vendor', 'lib'), { recursive: true });
    await writeFile(join(repo.target, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repo.target, 'src.txt'), 'source\n');
    await writeFile(join(repo.target, 'dist', 'app.js'), 'built\n');
    await writeFile(join(repo.target, 'dist', 'legacy.js'), 'remove me\n');
    await writeFile(join(repo.target, 'vendor', 'lib', 'pinned.js'), 'pinned\n');
    // A tracked generated path was previously invisible to the whole pipeline:
    // the name-based filter skipped `dist/` and `vendor/` before the index was
    // ever consulted, so the agent's work on them vanished silently.
    repo.commitBaseline();
    // Genuinely untracked generated output stays ignored.
    await mkdir(join(repo.target, 'node_modules', 'left-alone'), { recursive: true });
    await writeFile(join(repo.target, 'node_modules', 'left-alone', 'index.js'), 'dependency\n');

    const sessionId = '5c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf911';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    expect(await readFile(join(prepared.workspacePath, 'dist', 'app.js'), 'utf8')).toBe('built\n');
    expect(await readFile(join(prepared.workspacePath, 'vendor', 'lib', 'pinned.js'), 'utf8')).toBe('pinned\n');

    await writeFile(join(prepared.workspacePath, 'dist', 'app.js'), 'rebuilt\n');
    await writeFile(join(prepared.workspacePath, 'dist', 'added.js'), 'added\n');
    await unlink(join(prepared.workspacePath, 'dist', 'legacy.js'));
    await writeFile(join(prepared.workspacePath, 'vendor', 'lib', 'pinned.js'), 'repinned\n');

    const review = await manager.review(sessionId);
    expect(review.review.changedFiles.map((file) => `${file.kind}:${file.path}`).sort()).toEqual([
      'created:dist/added.js',
      'deleted:dist/legacy.js',
      'modified:dist/app.js',
      'modified:vendor/lib/pinned.js',
    ]);
    expect(review.review.patchAvailable).toBe(true);
    const exported = await manager.exportPatch(sessionId);
    expect(exported.outcome === 'exported' ? exported.bytes : 0).toBeGreaterThan(0);

    await manager.apply(sessionId);
    expect(await readFile(join(repo.target, 'dist', 'app.js'), 'utf8')).toBe('rebuilt\n');
    expect(await readFile(join(repo.target, 'dist', 'added.js'), 'utf8')).toBe('added\n');
    await expect(readFile(join(repo.target, 'dist', 'legacy.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(repo.target, 'vendor', 'lib', 'pinned.js'), 'utf8')).toBe('repinned\n');
    // Unrelated target contents — including the genuinely untracked dependency
    // tree — are preserved exactly.
    expect(await readFile(join(repo.target, 'src.txt'), 'utf8')).toBe('source\n');
    expect(await readFile(join(repo.target, 'node_modules', 'left-alone', 'index.js'), 'utf8')).toBe('dependency\n');
    await manager.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('applies the index answer to a selected subdirectory and survives a restart', async () => {
    const repo = await repository();
    await mkdir(join(repo.target, 'packages', 'app', 'dist'), { recursive: true });
    await mkdir(join(repo.target, 'packages', 'other'), { recursive: true });
    await writeFile(join(repo.target, 'packages', 'app', 'dist', 'bundle.js'), 'bundle\n');
    await writeFile(join(repo.target, 'packages', 'other', 'keep.txt'), 'untouched\n');
    repo.commitBaseline();

    const selected = join(repo.target, 'packages', 'app');
    const sessionId = '6c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf912';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: selected });
    await writeFile(join(prepared.workspacePath, 'dist', 'bundle.js'), 'rebundled\n');

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    await restarted.initialize();
    const review = await restarted.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['dist/bundle.js']);
    await restarted.apply(sessionId);
    expect(await readFile(join(selected, 'dist', 'bundle.js'), 'utf8')).toBe('rebundled\n');
    expect(await readFile(join(repo.target, 'packages', 'other', 'keep.txt'), 'utf8')).toBe('untouched\n');
    await restarted.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('refuses a session whose persisted index record was tampered with', async () => {
    const repo = await repository();
    await writeFile(join(repo.target, 'src.txt'), 'source\n');
    repo.commitBaseline();
    const sessionId = '7c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf913';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    await writeFile(join(repo.appRoot, sessionId, 'tracked-index.json'), JSON.stringify({ version: 1, generatedFiles: ['../escape'], symlinks: [] }));
    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    await restarted.initialize();
    // The environment is left on disk untouched rather than rehydrated against
    // an index answer that is not the one its baseline was built with.
    await expect(restarted.review(sessionId)).rejects.toThrow(/no longer available/iu);
    expect((await lstat(join(repo.appRoot, sessionId))).isDirectory()).toBe(true);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('fails closed when the frozen index record is missing or truncated', async () => {
    // Item K correction (finding 2): the session's metadata records that it
    // froze an index. A record that is then absent or half-written is a lost
    // record, and reading it as "nothing tracked" would silently redefine the
    // baseline as name-only — dropping every tracked dist/ path from review and
    // apply while appearing to work.
    const repo = await repository();
    await mkdir(join(repo.target, 'dist'), { recursive: true });
    await writeFile(join(repo.target, 'dist', 'app.js'), 'built\n');
    repo.commitBaseline();
    const indexPath = (sessionId: string): string => join(repo.appRoot, sessionId, 'tracked-index.json');

    for (const [offset, corrupt] of [
      ['a', async (path: string) => { await unlink(path); }],
      ['b', async (path: string) => { await writeFile(path, '{"version":1,"generatedFil'); }],
      ['c', async (path: string) => { await writeFile(path, ''); }],
    ] as const) {
      const sessionId = `8c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf91${offset}`;
      const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
      await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
      await corrupt(indexPath(sessionId));
      const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
      await restarted.initialize();
      await expect(restarted.review(sessionId), offset).rejects.toThrow(/no longer available/iu);
      // Fail closed means retained for repair, never removed.
      expect((await lstat(join(repo.appRoot, sessionId))).isDirectory()).toBe(true);
    }
    await rm(repo.root, { recursive: true, force: true });
  }, 60_000);

  it('still reads a genuinely legacy environment with no index claim as empty', async () => {
    // The other half of finding 2: an environment that really does predate the
    // record is explicitly identifiable — it carries no `indexVersion` — and
    // must keep working rather than being failed closed with it.
    const repo = await repository();
    await writeFile(join(repo.target, 'src.txt'), 'source\n');
    repo.commitBaseline();
    const sessionId = '9c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf914';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    await writeFile(join(prepared.workspacePath, 'src.txt'), 'edited\n');

    const metadataPath = join(repo.appRoot, sessionId, 'environment.json');
    const metadata: PortableRecordDraft = { ...(await readJsonRecord(metadataPath)) };
    delete metadata.indexVersion;
    await writeFile(metadataPath, JSON.stringify(metadata));
    await unlink(join(repo.appRoot, sessionId, 'tracked-index.json'));

    const restarted = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    await restarted.initialize();
    const review = await restarted.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['src.txt']);
    await restarted.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it.each(['tracked-index-record-temp', 'manifest-record-temp'] as const)('leaves no committed session when the process dies in the %s window', async (faultPhase) => {
    // Each record is written, fsynced and renamed *before* the journal phase
    // that claims it, so a death inside its torn-write window can only leave an
    // uncommitted preparation that startup removes whole.
    const repo = await repository();
    await writeFile(join(repo.target, 'src.txt'), 'source\n');
    repo.commitBaseline();
    const sessionId = 'ac7c9a6e-4e3e-4e87-bd0f-dc5cae0cf915';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({
      root: repo.appRoot,
      prepareFaultInjector: ({ phase }) => phase === faultPhase ? 'process-death' : undefined,
    }));
    await expect(manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target }))
      .rejects.toThrow(/interrupted/iu);

    await new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot })).initialize();
    expect(await readdir(repo.appRoot)).toEqual([]);
    expect(await readFile(join(repo.target, 'src.txt'), 'utf8')).toBe('source\n');
    await rm(repo.root, { recursive: true, force: true });
  }, 60_000);
});

describe('tracked Git symlink metadata (item L)', () => {
  it('carries an unchanged tracked in-tree link as no-follow metadata through review and apply', async () => {
    const repo = await repository();
    await writeFile(join(repo.target, 'real.txt'), 'real\n');
    await writeFile(join(repo.target, 'edit.txt'), 'before\n');
    await symlink('real.txt', join(repo.target, 'link.txt'));
    repo.commitBaseline();

    const sessionId = '8c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf914';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    expect((await lstat(join(prepared.workspacePath, 'link.txt'))).isSymbolicLink()).toBe(true);
    await writeFile(join(prepared.workspacePath, 'edit.txt'), 'after\n');

    const review = await manager.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['edit.txt']);
    expect(review.review.applyAllowed).toBe(true);
    await manager.apply(sessionId);
    expect(await readFile(join(repo.target, 'edit.txt'), 'utf8')).toBe('after\n');
    // The link in the target was never replaced, followed, or rewritten.
    expect((await lstat(join(repo.target, 'link.txt'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(repo.target, 'link.txt'))).toBe('real.txt');
    await manager.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('fails review and apply closed when a tracked link is repointed or removed', async () => {
    const repo = await repository();
    await writeFile(join(repo.target, 'real.txt'), 'real\n');
    await writeFile(join(repo.target, 'other.txt'), 'other\n');
    await symlink('real.txt', join(repo.target, 'link.txt'));
    repo.commitBaseline();

    const sessionId = '9c7c9a6e-4e3e-4e87-bd0f-dc5cae0cf915';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    await unlink(join(prepared.workspacePath, 'link.txt'));
    await symlink('other.txt', join(prepared.workspacePath, 'link.txt'));

    const review = await manager.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toContain('link.txt');
    expect(review.review.applyAllowed).toBe(false);
    expect(review.review.applyDisabledReason).toMatch(/symbolic link/iu);
    expect(review.review.patchAvailable).toBe(false);
    await expect(manager.apply(sessionId)).rejects.toMatchObject({ code: 'security-violation' });
    expect(await readlink(join(repo.target, 'link.txt'))).toBe('real.txt');
    await manager.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('keeps a tracked link under a generated directory in the index and the baseline', async () => {
    // Item L correction (finding 5): a mode-120000 entry used to be recorded as
    // a link and then skipped before its generated ancestors were added, so
    // `dist/` stayed unlisted, the walk never descended into it, and the tracked
    // link disappeared from the baseline, the review and the patch.
    const repo = await repository();
    await mkdir(join(repo.target, 'dist'), { recursive: true });
    await writeFile(join(repo.target, 'dist', 'real.txt'), 'real\n');
    await writeFile(join(repo.target, 'dist', 'app.js'), 'built\n');
    await symlink('real.txt', join(repo.target, 'dist', 'link.txt'));
    repo.commitBaseline();

    const index = await readGitTrackedIndex(repo.target, (cwd, args) => Promise.resolve(execFileSync('git', ['-C', cwd, ...args]).toString('utf8')), (name) => name === 'dist');
    expect([...index.generatedDirectories]).toContain('dist');
    expect([...index.generatedFiles]).toContain('dist/link.txt');
    expect([...index.symlinks]).toContain('dist/link.txt');

    const sessionId = 'cc7c9a6e-4e3e-4e87-bd0f-dc5cae0cf918';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target });
    expect((await lstat(join(prepared.workspacePath, 'dist', 'link.txt'))).isSymbolicLink()).toBe(true);
    await writeFile(join(prepared.workspacePath, 'dist', 'app.js'), 'rebuilt\n');

    const review = await manager.review(sessionId);
    expect(review.review.changedFiles.map((file) => file.path)).toEqual(['dist/app.js']);
    await manager.apply(sessionId);
    expect(await readFile(join(repo.target, 'dist', 'app.js'), 'utf8')).toBe('rebuilt\n');
    // The link is still a link, still pointing where it did, never followed.
    expect((await lstat(join(repo.target, 'dist', 'link.txt'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(repo.target, 'dist', 'link.txt'))).toBe('real.txt');
    await manager.discard(sessionId);
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('refuses a tracked link that escapes the selected tree', async () => {
    const repo = await repository();
    await writeFile(join(repo.root, 'outside-secret.txt'), 'must never be read\n');
    await writeFile(join(repo.target, 'real.txt'), 'real\n');
    await symlink('../outside-secret.txt', join(repo.target, 'escape.txt'));
    repo.commitBaseline();

    const sessionId = 'ac7c9a6e-4e3e-4e87-bd0f-dc5cae0cf916';
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: repo.appRoot }));
    await expect(manager.prepare({ sessionId, mode: 'isolated-worktree', canonicalTargetPath: repo.target }))
      .rejects.toThrow(/escapes|symbolic link/iu);
    expect(await readFile(join(repo.root, 'outside-secret.txt'), 'utf8')).toBe('must never be read\n');
    await rm(repo.root, { recursive: true, force: true });
  }, 30_000);

  it('still refuses symbolic links in a non-Git directory copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-plain-link-'));
    const target = join(root, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'real.txt'), 'real\n');
    await symlink('real.txt', join(target, 'link.txt'));
    const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: join(root, 'app-workspaces') }));
    await expect(manager.prepare({ sessionId: 'bc7c9a6e-4e3e-4e87-bd0f-dc5cae0cf917', mode: 'isolated-copy', canonicalTargetPath: target }))
      .rejects.toThrow(/symlink|symbolic link/iu);
    await rm(root, { recursive: true, force: true });
  });
});
