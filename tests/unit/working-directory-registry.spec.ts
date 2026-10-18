import { mkdtemp, rm, stat, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkingDirectoryRegistry, type RegisteredWorkingDirectory } from '@main/agents/working-directory-registry';
import { InterleafError } from '@shared/errors/interleaf-error';
import { fileIdentityFromStats } from '@main/security/file-identity';

const roots: string[] = [];

async function makeTempDir(prefix = 'ml-workdir-reg-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('WorkingDirectoryRegistry unit tests', () => {
  it('registers a new directory, generates a durable handle, and returns a safe display name', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-safe-');
    const result = await registry.register(dir);

    expect(result.handle).toBeTypeOf('string');
    expect(result.handle.length).toBeGreaterThan(0);
    expect(result.displayName).toBe(dir.split(/[\\/]/u).filter(Boolean).at(-1));
    expect(result.displayName).not.toContain(tmpdir());

    const resolved = await registry.resolve(result.handle);
    const canonical = await realpath(dir);
    const identity = fileIdentityFromStats(await stat(canonical, { bigint: true }));
    expect(resolved).toEqual({
      handle: result.handle,
      canonicalPath: canonical,
      ...identity,
    });
  });

  it('rehydrates entries and builds a reverse canonical identity lookup', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-rehydrate-');
    const canonical = await realpath(dir);
    const identity = fileIdentityFromStats(await stat(canonical, { bigint: true }));

    const rehydratedEntry: RegisteredWorkingDirectory = {
      handle: 'rehydrated-handle-123',
      canonicalPath: canonical,
      ...identity,
    };

    registry.rehydrate([rehydratedEntry]);

    // Resolving existing handle succeeds
    const resolved = await registry.resolve('rehydrated-handle-123');
    expect(resolved).toEqual(rehydratedEntry);

    // Registering the same canonical path returns the existing durable handle
    const registered = await registry.register(dir);
    expect(registered.handle).toBe('rehydrated-handle-123');
  });

  it('returns the same durable handle when the same canonical path is registered repeatedly', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-dedup-');

    const first = await registry.register(dir);
    const second = await registry.register(dir);
    const third = await registry.register(dir + '/.');

    expect(first.handle).toBe(second.handle);
    expect(second.handle).toBe(third.handle);
    expect(first.displayName).toBe(second.displayName);
  });

  it('fails closed when directory device/inode changes on disk without silent revival', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-drift-');
    await registry.register(dir);

    // Simulate disk identity change by recreating the directory
    await rm(dir, { recursive: true, force: true });
    const newDir = await makeTempDir('ml-workdir-drift-');
    // Rename newDir to dir so path matches but inode is different
    // Since cross-device or same filesystem mkdtemp gives different inode:
    const canonicalOriginal = await realpath(newDir);
    const fakeEntry: RegisteredWorkingDirectory = {
      handle: 'stale-handle-456',
      canonicalPath: canonicalOriginal,
      device: 999999, // wrong device
      inode: 888888, // wrong inode
      birthtimeNs: '1', // wrong birth time
    };
    registry.rehydrate([fakeEntry]);

    // Unselected stale handle must fail closed on resolve
    await expect(registry.resolve('stale-handle-456')).rejects.toThrow(InterleafError);
    await expect(registry.resolve('stale-handle-456')).rejects.toMatchObject({
      code: 'mode-resolution-failed',
    });

    // Handle was evicted and cannot silently revive
    await expect(registry.resolve('stale-handle-456')).rejects.toMatchObject({
      code: 'mode-resolution-failed',
      message: 'The working-directory handle is invalid or expired.',
    });
  });

  it('revokes handle and cleans up reverse canonical index', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-revoke-');
    const registered = await registry.register(dir);

    expect(registry.revoke(registered.handle)).toBe(true);
    expect(registry.revoke(registered.handle)).toBe(false);

    // Resolve fails because handle was revoked
    await expect(registry.resolve(registered.handle)).rejects.toMatchObject({
      code: 'mode-resolution-failed',
    });

    // Registering again generates a new handle because reverse index was cleaned up
    const newlyRegistered = await registry.register(dir);
    expect(newlyRegistered.handle).not.toBe(registered.handle);
  });

  it('clears all entries and reverse canonical index', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir1 = await makeTempDir('ml-workdir-clear-1-');
    const dir2 = await makeTempDir('ml-workdir-clear-2-');

    const reg1 = await registry.register(dir1);
    const reg2 = await registry.register(dir2);

    registry.clear();

    await expect(registry.resolve(reg1.handle)).rejects.toMatchObject({ code: 'mode-resolution-failed' });
    await expect(registry.resolve(reg2.handle)).rejects.toMatchObject({ code: 'mode-resolution-failed' });

    const newReg1 = await registry.register(dir1);
    expect(newReg1.handle).not.toBe(reg1.handle);
  });

  it('rejects non-directory file paths', async () => {
    const registry = new WorkingDirectoryRegistry();
    const dir = await makeTempDir('ml-workdir-file-');
    const filePath = join(dir, 'not-a-dir.txt');
    await writeFile(filePath, 'hello');

    await expect(registry.register(filePath)).rejects.toMatchObject({
      code: 'mode-resolution-failed',
      message: 'The selected target is not a directory.',
    });
  });

  it('rejects nonexistent paths', async () => {
    const registry = new WorkingDirectoryRegistry();
    const nonexistent = join(tmpdir(), `ml-nonexistent-${String(Date.now())}`);

    await expect(registry.register(nonexistent)).rejects.toMatchObject({
      code: 'mode-resolution-failed',
      message: 'The selected target directory is inaccessible.',
    });
  });
});
