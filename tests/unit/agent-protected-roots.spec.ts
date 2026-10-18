import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafError } from '@shared/errors/interleaf-error';
import { ProtectedRootPolicy, protectedRootOverlap } from '@main/agents/protected-roots';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/** A registry that reports how many capabilities it has minted. */
class CountingRegistry extends WorkingDirectoryRegistry {
  get mintedHandles(): number {
    return this.capabilityCount;
  }
}

/**
 * Item A: an agent target may never overlap Interleaf's own application data.
 *
 * The tests below assert the rejection itself and, just as importantly, that it
 * happens before any lock, session root, snapshot, copy, or baseline exists.
 */

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-protected-roots-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('protected application-data root policy', () => {
  it('classifies the full symmetric overlap matrix and leaves siblings alone', () => {
    expect(protectedRootOverlap('/data/app', '/data/app')).toBe('same');
    expect(protectedRootOverlap('/data/app/agent-workspaces', '/data/app')).toBe('candidate-is-descendant');
    expect(protectedRootOverlap('/data', '/data/app')).toBe('candidate-is-parent');
    // Sibling roots that merely share a textual prefix are distinct.
    expect(protectedRootOverlap('/data/app-2', '/data/app')).toBeNull();
    expect(protectedRootOverlap('/data/application', '/data/app')).toBeNull();
    expect(protectedRootOverlap('/data/app', '/data/app-2')).toBeNull();
    // Unrelated trees on either side.
    expect(protectedRootOverlap('/elsewhere/project', '/data/app')).toBeNull();
  });

  it('rejects a candidate that is, contains, or lives inside a protected root', async () => {
    await withRoot(async (root) => {
      const userData = join(root, 'app-data');
      const workspaces = join(userData, 'agent-workspaces');
      await mkdir(workspaces, { recursive: true });
      const policy = new ProtectedRootPolicy([userData, workspaces]);

      for (const candidate of [userData, workspaces, root]) {
        await expect(policy.assertSelectable(candidate)).rejects.toThrow(/overlaps Interleaf/u);
      }
    });
  });

  it('accepts a distinct sibling application-data root next to a protected one', async () => {
    await withRoot(async (root) => {
      const protectedRoot = join(root, 'parent', 'agent-workspaces');
      const sibling = join(root, 'parent', 'agent-workspaces-2');
      const alsoSibling = join(root, 'parent', 'agent-workspaces-archive');
      await mkdir(protectedRoot, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await mkdir(alsoSibling, { recursive: true });
      const policy = new ProtectedRootPolicy([protectedRoot]);

      await expect(policy.assertSelectable(sibling)).resolves.toBe(sibling);
      await expect(policy.assertSelectable(alsoSibling)).resolves.toBe(alsoSibling);
    });
  });

  it('sees through a symlink alias of a protected root and of its parent', async () => {
    await withRoot(async (root) => {
      const userData = join(root, 'app-data');
      const inside = join(userData, 'library');
      await mkdir(inside, { recursive: true });
      const aliasOfRoot = join(root, 'alias-root');
      const aliasOfChild = join(root, 'alias-child');
      await symlink(userData, aliasOfRoot, 'dir');
      await symlink(inside, aliasOfChild, 'dir');
      const policy = new ProtectedRootPolicy([userData]);

      await expect(policy.assertSelectable(aliasOfRoot)).rejects.toThrow(/overlaps Interleaf/u);
      await expect(policy.assertSelectable(aliasOfChild)).rejects.toThrow(/overlaps Interleaf/u);
    });
  });

  it('rejects a candidate whose declared protected root is reached through a symlink', async () => {
    await withRoot(async (root) => {
      const realStore = join(root, 'real-store');
      const project = join(realStore, 'project');
      await mkdir(project, { recursive: true });
      const declared = join(root, 'declared-store');
      await symlink(realStore, declared, 'dir');
      // The policy is configured with the alias; the candidate uses the real
      // path. Canonicalizing both sides is what makes these the same tree.
      const policy = new ProtectedRootPolicy([declared]);

      await expect(policy.assertSelectable(project)).rejects.toThrow(/overlaps Interleaf/u);
    });
  });

  it('canonicalizes a protected root that does not exist yet', async () => {
    await withRoot(async (root) => {
      const missing = join(root, 'app-data', 'logs');
      const target = join(root, 'project');
      await mkdir(target, { recursive: true });
      await mkdir(join(root, 'app-data'), { recursive: true });
      const policy = new ProtectedRootPolicy([missing]);

      await expect(policy.assertSelectable(target)).resolves.toBe(target);
      await expect(policy.assertSelectable(join(root, 'app-data'))).rejects.toThrow(/overlaps Interleaf/u);
    });
  });

  it('fails closed when the candidate cannot be canonicalized', async () => {
    await withRoot(async (root) => {
      const policy = new ProtectedRootPolicy([join(root, 'app-data')]);
      await expect(policy.assertSelectable(join(root, 'never-created'))).rejects.toThrow(InterleafError);
    });
  });
});

describe('protected roots at working-directory registration', () => {
  it('refuses to mint a handle for an overlapping folder', async () => {
    await withRoot(async (root) => {
      const userData = join(root, 'app-data');
      await mkdir(userData, { recursive: true });
      const registry = new CountingRegistry({ protectedRoots: new ProtectedRootPolicy([userData]) });

      await expect(registry.register(userData)).rejects.toThrow(/overlaps Interleaf/u);
      // No handle was minted, so nothing can later resolve to that folder.
      expect(registry.mintedHandles).toBe(0);
    });
  });

  it('refuses to resolve a handle whose folder became a protected root', async () => {
    await withRoot(async (root) => {
      const target = join(root, 'project');
      await mkdir(target, { recursive: true });
      const registry = new WorkingDirectoryRegistry({ protectedRoots: new ProtectedRootPolicy([join(root, 'app-data')]) });
      const registered = await registry.register(target);
      const stored = await registry.resolve(registered.handle);

      // A later app layout declares that same folder protected. The durable row
      // survives a restart, so resolve must re-check it rather than trust that
      // registration once said yes.
      const narrowed = new WorkingDirectoryRegistry({ protectedRoots: new ProtectedRootPolicy([target]) });
      narrowed.rehydrate([stored]);
      await expect(narrowed.resolve(registered.handle)).rejects.toThrow(/overlaps Interleaf/u);
    });
  });
});

describe('protected roots at environment preparation', () => {
  it('rejects an overlapping target before any lock, session root, or copy exists', async () => {
    await withRoot(async (root) => {
      const workspaces = join(root, 'agent-workspaces');
      const userData = join(root, 'app-data');
      const overlapping = join(userData, 'library');
      await mkdir(overlapping, { recursive: true });
      await writeFile(join(overlapping, 'catalog.sqlite'), 'db', 'utf8');
      const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: workspaces, protectedRoots: [userData, workspaces] }));

      for (const mode of ['isolated-copy', 'isolated-worktree', 'active-env', 'native-restricted'] as const) {
        await expect(manager.prepare({
          sessionId: `00000000-0000-4000-8000-00000000000${String(mode.length % 10)}`,
          mode,
          canonicalTargetPath: overlapping,
        })).rejects.toThrow(/overlaps Interleaf/u);
      }

      // Nothing was created, copied, or locked on the way to the rejection.
      await expect(readdir(workspaces)).rejects.toThrow();
      expect(await readdir(overlapping)).toEqual(['catalog.sqlite']);

      // The rejection is not a one-time lock: a legitimate target still works.
      const legitimate = join(root, 'project');
      await mkdir(legitimate, { recursive: true });
      const prepared = await manager.prepare({
        sessionId: '00000000-0000-4000-8000-0000000000aa',
        mode: 'isolated-copy',
        canonicalTargetPath: legitimate,
      });
      expect(prepared.canonicalTargetPath).toBe(legitimate);
    });
  });

  it('rejects a symlinked alias of the app-owned workspace root', async () => {
    await withRoot(async (root) => {
      const workspaces = join(root, 'agent-workspaces');
      await mkdir(workspaces, { recursive: true });
      const alias = join(root, 'looks-like-a-project');
      await symlink(workspaces, alias, 'dir');
      const manager = new AgentEnvironmentManager(withEnvironmentShell({ root: workspaces, protectedRoots: [workspaces] }));

      await expect(manager.prepare({
        sessionId: '00000000-0000-4000-8000-0000000000bb',
        mode: 'isolated-copy',
        canonicalTargetPath: alias,
      })).rejects.toThrow(/overlaps Interleaf/u);
      expect(await readdir(workspaces)).toEqual([]);
    });
  });
});
