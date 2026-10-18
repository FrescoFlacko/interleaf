import type { BigIntStats, PathLike, StatOptions } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import {
  type FileIdentity,
  fileIdentityFromStats,
  parseFileIdentity,
  proveDirectoryIdentity,
  sameFileIdentity,
  statWithIdentity,
} from '@main/security/file-identity';

/**
 * Linux reuses inode numbers, so a directory deleted and recreated at the same
 * path can come back with the same device and inode. Whether a given
 * filesystem actually does so is not deterministic, so these tests inject the
 * stat result instead: every bigint `stat` is passed through `rewrite`.
 */
const injected = vi.hoisted(() => ({ rewrite: null as ((stats: BigIntStats) => BigIntStats) | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (path: PathLike, options?: StatOptions) => {
      const stats = await actual.stat(path, options);
      if (injected.rewrite === null || options?.bigint !== true) return stats;
      return injected.rewrite(stats as BigIntStats);
    },
  };
});

/** The same stats object (same device and inode) with a different birth time. */
function withBirthtime(stats: BigIntStats, birthtimeNs: bigint): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as BigIntStats, stats, { birthtimeNs });
}

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'interleaf-file-identity-'));
  roots.push(root);
  return realpath(root);
}

afterEach(async () => {
  injected.rewrite = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('file identity', () => {
  const original: FileIdentity = { device: 16777230, inode: 4242, birthtimeNs: '1759600000123456789' };

  it('treats a reused device and inode with a different birth time as a different file', () => {
    expect(sameFileIdentity(original, { ...original })).toBe(true);
    expect(sameFileIdentity(original, { ...original, birthtimeNs: '1759600000123456790' })).toBe(false);
    expect(sameFileIdentity(original, { ...original, inode: 4243 })).toBe(false);
    expect(sameFileIdentity(original, { ...original, device: 1 })).toBe(false);
  });

  it('never proves an identity whose birth time is unavailable, with no inode-only fallback', () => {
    const unprovable: FileIdentity = { ...original, birthtimeNs: null };
    expect(sameFileIdentity(original, unprovable)).toBe(false);
    expect(sameFileIdentity(unprovable, original)).toBe(false);
    expect(sameFileIdentity(unprovable, { ...unprovable })).toBe(false);
  });

  it('records a zero birth time as unavailable and a real one in nanoseconds', async () => {
    const { stats, identity } = await statWithIdentity(await tempDir());
    expect(identity).toEqual({ device: Number(stats.dev), inode: Number(stats.ino), birthtimeNs: stats.birthtimeNs.toString() });
    expect(fileIdentityFromStats(withBirthtime(stats, 0n)).birthtimeNs).toBeNull();
  });

  it('reads persisted identities strictly, and legacy rows as unprovable', () => {
    expect(parseFileIdentity({ ...original })).toEqual(original);
    expect(parseFileIdentity({ device: 1, inode: 2, birthtimeNs: null })).toEqual({ device: 1, inode: 2, birthtimeNs: null });
    // Migration 26 writes an explicit null; a missing key is corruption.
    expect(parseFileIdentity({ device: 1, inode: 2 })).toBeNull();
    for (const birthtimeNs of ['0', '-1', '01', '1.5', 'abc', '', 5]) {
      expect(parseFileIdentity({ device: 1, inode: 2, birthtimeNs })).toBeNull();
    }
    expect(parseFileIdentity({ device: -1, inode: 2, birthtimeNs: '1' })).toBeNull();
    expect(parseFileIdentity('{"device":1}')).toBeNull();
  });

  it('reports a directory recreated with the same device and inode as replaced', async () => {
    const dir = await tempDir();
    const { identity } = await statWithIdentity(dir);
    await expect(proveDirectoryIdentity(dir, identity)).resolves.toEqual({ kind: 'same' });

    injected.rewrite = (stats) => withBirthtime(stats, stats.birthtimeNs + 1n);
    await expect(proveDirectoryIdentity(dir, identity)).resolves.toEqual({ kind: 'replaced' });
  });
});

describe('WorkingDirectoryRegistry with an injected inode reuse', () => {
  it('fails closed and evicts the handle when only the birth time changed', async () => {
    const registry = new WorkingDirectoryRegistry();
    const { handle } = await registry.register(await tempDir());
    const registered = await registry.resolve(handle);

    injected.rewrite = (stats) => withBirthtime(stats, stats.birthtimeNs + 1n);
    const reused = (await statWithIdentity(registered.canonicalPath)).identity;
    expect(reused).toMatchObject({ device: registered.device, inode: registered.inode });
    expect(reused.birthtimeNs).not.toBe(registered.birthtimeNs);

    await expect(registry.resolve(handle)).rejects.toMatchObject({
      code: 'mode-resolution-failed',
      message: 'The registered working directory changed and must be selected again.',
    });
    injected.rewrite = null;
    await expect(registry.resolve(handle)).rejects.toThrow(/invalid or expired/iu);
  });

  it('refuses to register a folder whose filesystem reports no birth time', async () => {
    const registry = new WorkingDirectoryRegistry();
    injected.rewrite = (stats) => withBirthtime(stats, 0n);
    await expect(registry.register(await tempDir())).rejects.toMatchObject({
      code: 'mode-resolution-failed',
      message: expect.stringMatching(/does not report creation times/u) as string,
    });
  });
});
