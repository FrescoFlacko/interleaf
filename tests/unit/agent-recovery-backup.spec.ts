import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertRestorableBackup,
  copyBackupEntry,
  createBackupBudget,
  preflightRestore,
  removeCreatedEntry,
  setBackupLimitsForTests,
  MAX_BACKUP_DEPTH,
  MAX_BACKUP_TOTAL_BYTES,
} from '@main/agents/recovery-backup';
import { AgentEnvironmentManager } from '@main/agents/environment-manager';
import { withEnvironmentShell } from '../helpers/agent-collaborators';

/**
 * Item G: cumulative budgets, no-follow identity/ownership proof, and — the
 * defect with real consequences — validating the backup tree *before* the
 * target it replaces is removed.
 */
describe('recovery backup budgets and identity (item G)', () => {
  afterEach(() => { setBackupLimitsForTests(null); });

  it('rejects a backup tree deeper than the bounded depth limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-depth-'));
    let deep = join(root, 'source');
    await mkdir(deep, { recursive: true });
    for (let level = 0; level <= MAX_BACKUP_DEPTH + 2; level += 1) {
      deep = join(deep, 'd');
      await mkdir(deep);
    }
    await writeFile(join(deep, 'leaf.txt'), 'leaf\n');
    const source = join(root, 'source');
    await expect(copyBackupEntry(source, join(root, 'backup'), await lstat(source, { bigint: true }), createBackupBudget()))
      .rejects.toThrow(/bounded depth limit/iu);
    await rm(root, { recursive: true, force: true });
  });

  it('charges one cumulative budget across separate backup entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-budget-'));
    await writeFile(join(root, 'small.txt'), 'x');
    const budget = createBackupBudget();
    // A thousand individually reasonable backups must not collectively pass.
    budget.bytes = MAX_BACKUP_TOTAL_BYTES;
    const source = join(root, 'small.txt');
    await expect(copyBackupEntry(source, join(root, 'backup.txt'), await lstat(source, { bigint: true }), budget))
      .rejects.toThrow(/bounded byte limit/iu);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects post-snapshot growth, truncation, and replacement of a backup source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-identity-'));
    const source = join(root, 'source.txt');

    await writeFile(source, 'original\n');
    const grown = await lstat(source, { bigint: true });
    await writeFile(source, 'original and then some more\n');
    await expect(copyBackupEntry(source, join(root, 'grown'), grown, createBackupBudget()))
      .rejects.toThrow(/changed size/iu);

    await writeFile(source, 'original\n');
    const shrunk = await lstat(source, { bigint: true });
    await truncate(source, 2);
    await expect(copyBackupEntry(source, join(root, 'shrunk'), shrunk, createBackupBudget()))
      .rejects.toThrow(/changed size/iu);

    await writeFile(source, 'original\n');
    const replacedDetails = await lstat(source, { bigint: true });
    await unlink(source);
    // Same bytes, same size, a new file (Linux may even reuse the inode
    // number; the birth time still differs): identity is not content.
    await writeFile(source, 'original\n');
    await expect(copyBackupEntry(source, join(root, 'replaced'), replacedDetails, createBackupBudget()))
      .rejects.toThrow(/was replaced/iu);

    await rm(root, { recursive: true, force: true });
  });

  it('refuses to copy or restore a symbolic link or a non-regular entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-nofollow-'));
    await writeFile(join(root, 'real.txt'), 'real\n');
    await symlink('real.txt', join(root, 'link.txt'));
    const link = join(root, 'link.txt');
    await expect(copyBackupEntry(link, join(root, 'copy'), await lstat(link, { bigint: true }), createBackupBudget()))
      .rejects.toThrow(/symbolic link/iu);

    const backup = join(root, 'backup');
    await mkdir(join(backup, 'nested'), { recursive: true });
    await writeFile(join(backup, 'nested', 'ok.txt'), 'ok\n');
    await symlink('../../real.txt', join(backup, 'nested', 'sneaky'));
    await expect(assertRestorableBackup(root, backup, await lstat(backup, { bigint: true }), createBackupBudget()))
      .rejects.toThrow(/symbolic link/iu);

    await rm(root, { recursive: true, force: true });
  });

  it.each([171, 256, 400])('gives each pass over %i/512 of the allowance its own budget', async (ratio) => {
    // Item G correction (finding 1): backing a tree up, proving it restorable,
    // and restoring it are three passes over the same bytes. Charging them to
    // one consumptive allowance makes a legitimate restore of anything past a
    // third of the limit fail — and the old ordering discovered that only after
    // the target had been removed. The real thresholds are hundreds of
    // megabytes; these are the same ratios against a scaled-down limit, so the
    // arithmetic is exercised without allocating half a gigabyte.
    setBackupLimitsForTests({ totalBytes: 512 * 1024, fileBytes: 512 * 1024 });
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-ratio-'));
    const source = join(root, 'source.bin');
    await writeFile(source, Buffer.alloc(ratio * 1024, 0x61));
    const backup = join(root, 'recovery', 'source.bin');
    await mkdir(join(root, 'recovery'), { recursive: true });

    await copyBackupEntry(source, backup, await lstat(source, { bigint: true }), createBackupBudget());
    const proven = await preflightRestore(join(root, 'recovery'), [{ backup }]);
    const details = proven.get(backup);
    expect(details).toBeDefined();
    await copyBackupEntry(backup, join(root, 'restored.bin'), details!, createBackupBudget());
    expect((await lstat(join(root, 'restored.bin'))).size).toBe(ratio * 1024);

    // The same three passes on one shared allowance is the defect: it refuses a
    // restore the disk can comfortably hold.
    const shared = createBackupBudget();
    await copyBackupEntry(source, join(root, 'recovery', 'again.bin'), await lstat(source, { bigint: true }), shared);
    await expect((async () => {
      await assertRestorableBackup(join(root, 'recovery'), backup, await lstat(backup, { bigint: true }), shared);
      await copyBackupEntry(backup, join(root, 'twice.bin'), await lstat(backup, { bigint: true }), shared);
    })()).rejects.toThrow(/bounded byte limit/iu);

    await rm(root, { recursive: true, force: true });
  });

  it('reads every byte of a backup before it may be called restorable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-readable-'));
    const recovery = join(root, 'recovery');
    await mkdir(recovery, { recursive: true });
    const backup = join(recovery, 'data.bin');
    await writeFile(backup, Buffer.alloc(4096, 0x62));
    // Metadata and permission say nothing about readability. Validation that
    // stops at `lstat` would call this restorable and remove the target.
    await chmod(backup, 0o000);
    if (process.getuid?.() !== 0) {
      await expect(preflightRestore(recovery, [{ backup }])).rejects.toThrow();
    }
    await chmod(backup, 0o600);
    await expect(preflightRestore(recovery, [{ backup }])).resolves.toBeInstanceOf(Map);
    await rm(root, { recursive: true, force: true });
  });

  it('copies a multi-chunk file byte for byte', async () => {
    // The copy and validation loops both run over 1 MiB chunks and both have to
    // survive a short read or a short `write`. A file spanning several chunks
    // with a non-chunk-aligned tail is what proves the loops reassemble it.
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-chunks-'));
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 4097);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const source = join(root, 'big.bin');
    await writeFile(source, bytes);
    const backup = join(root, 'big.backup.bin');
    await copyBackupEntry(source, backup, await lstat(source, { bigint: true }), createBackupBudget());
    const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
    expect(digest(await readFile(backup))).toBe(digest(bytes));
    await expect(preflightRestore(root, [{ backup }])).resolves.toBeInstanceOf(Map);
    await rm(root, { recursive: true, force: true });
  });

  it('removes a transaction-created tree but refuses a link or foreign entry inside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleaf-backup-created-'));
    const created = join(root, 'created');
    await mkdir(join(created, 'nested'), { recursive: true });
    await writeFile(join(created, 'nested', 'file.txt'), 'made by the transaction\n');
    await symlink('/etc/passwd', join(created, 'nested', 'escape'));
    await expect(removeCreatedEntry(created, createBackupBudget())).rejects.toThrow(/symbolic link/iu);
    // The refusal is not a partial delete-then-fail: the tree is still there.
    expect(await readFile(join(created, 'nested', 'file.txt'), 'utf8')).toBe('made by the transaction\n');

    await unlink(join(created, 'nested', 'escape'));
    await removeCreatedEntry(created, createBackupBudget());
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});

/**
 * Applies one edited file under a fault that kills the process right after the
 * target was mutated, leaving the apply's recovery journal behind for startup.
 */
async function interruptedApply(prefix: string, sessionId: string, fileName: string, before: string | Buffer, after: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, 'target');
  const appRoot = join(root, 'app-workspaces');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, fileName), before);

  let interrupted = false;
  const manager = new AgentEnvironmentManager(withEnvironmentShell({
    root: appRoot,
    applyFaultInjector: ({ phase }) => phase === 'after-target-mutation' && !interrupted ? (interrupted = true, 'process-death') : undefined,
  }));
  const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: target });
  await writeFile(join(prepared.workspacePath, fileName), after);
  const apply = () => manager.apply(sessionId);
  const recoveryDirectory = async (): Promise<string> => {
    const sessionRoot = join(appRoot, sessionId);
    const recoveryName = (await readdir(sessionRoot)).find((entry) => entry.startsWith('recovery-'));
    if (recoveryName === undefined) throw new Error('Apply recovery journal was not retained after interruption.');
    return join(sessionRoot, recoveryName);
  };
  return { root, target, appRoot, apply, recoveryDirectory };
}

describe('startup rollback ordering (item G)', () => {
  afterEach(() => { setBackupLimitsForTests(null); });

  it('restores in process when the backup set is past a third of the allowance', async () => {
    // Two 171/512 backups: under one shared budget the backup copies, the
    // validation pass and the restore pass together overrun the limit, and the
    // overrun used to be discovered with targets already removed.
    setBackupLimitsForTests({ totalBytes: 512 * 1024, fileBytes: 512 * 1024 });
    const root = await mkdtemp(join(tmpdir(), 'interleaf-rollback-inprocess-'));
    const target = join(root, 'target');
    await mkdir(target, { recursive: true });
    const original = Buffer.alloc(171 * 1024, 0x63);
    await writeFile(join(target, 'a.bin'), original);
    await writeFile(join(target, 'b.bin'), original);

    let tampered = false;
    const appRoot = join(root, 'app-workspaces');
    const manager = new AgentEnvironmentManager(withEnvironmentShell({
      root: appRoot,
      // A seam, not a simulated crash: once the first target file has really
      // been replaced, the second one stops matching what apply proved, so the
      // transaction fails for an ordinary reason and must roll both back.
      applyFaultInjector: async ({ phase, relativePath }) => {
        if (phase === 'after-target-mutation' && relativePath === 'a.bin' && !tampered) {
          tampered = true;
          await writeFile(join(target, 'b.bin'), Buffer.alloc(171 * 1024, 0x78));
        }
        return undefined;
      },
    }));
    const sessionId = 'd2e2f3a4-4e3e-4e87-bd0f-dc5cae0cf921';
    const prepared = await manager.prepare({ sessionId, mode: 'isolated-copy', canonicalTargetPath: target });
    await writeFile(join(prepared.workspacePath, 'a.bin'), Buffer.alloc(171 * 1024, 0x64));
    await writeFile(join(prepared.workspacePath, 'b.bin'), Buffer.alloc(171 * 1024, 0x64));
    // The transaction fails with the drift it detected, *after* a rollback that
    // had to validate and restore both backups on their own allowances.
    await expect(manager.apply(sessionId)).rejects.toThrow(/content drift/iu);

    expect(await readFile(join(target, 'a.bin'))).toEqual(original);
    expect(await readFile(join(target, 'b.bin'))).toEqual(original);
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('restores at startup when the backup is half the allowance', async () => {
    setBackupLimitsForTests({ totalBytes: 512 * 1024, fileBytes: 512 * 1024 });
    const original = Buffer.alloc(256 * 1024, 0x65);
    const { root, target, appRoot, apply } = await interruptedApply(
      'interleaf-rollback-startup-', 'd3e2f3a4-4e3e-4e87-bd0f-dc5cae0cf922', 'data.bin', original, Buffer.alloc(256 * 1024, 0x66),
    );
    await expect(apply()).rejects.toThrow(/interrupted/iu);

    // Startup pays for validation and restoration on their own budgets, so the
    // backup that is exactly half the allowance is restorable rather than a
    // budget failure with the target already gone.
    await new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })).initialize();
    expect(await readFile(join(target, 'data.bin'))).toEqual(original);
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('keeps the target when a startup backup cannot be read at all', async () => {
    if (process.getuid?.() === 0) return;
    const { root, target, appRoot, apply, recoveryDirectory } = await interruptedApply(
      'interleaf-rollback-unreadable-', 'd4e2f3a4-4e3e-4e87-bd0f-dc5cae0cf923', 'hello.txt', 'before\n', 'after\n',
    );
    await expect(apply()).rejects.toThrow(/interrupted/iu);

    const backup = join(await recoveryDirectory(), 'hello.txt');
    // Openable metadata, unreadable bytes: only a validation pass that actually
    // reads the file catches this, and it has to catch it before the target is
    // removed.
    await chmod(backup, 0o000);
    await expect(new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })).initialize()).rejects.toThrow();
    expect(await readFile(join(target, 'hello.txt'), 'utf8')).toBe('after\n');

    await chmod(backup, 0o600);
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('preserves the target when the recovery backup cannot be proved restorable', async () => {
    const { root, target, appRoot, apply, recoveryDirectory } = await interruptedApply(
      'interleaf-rollback-order-', 'd1e2f3a4-4e3e-4e87-bd0f-dc5cae0cf920', 'hello.txt', 'before\n', 'after\n',
    );
    await expect(apply()).rejects.toThrow(/interrupted|recovery/iu);
    expect(await readFile(join(target, 'hello.txt'), 'utf8')).toBe('after\n');

    // Corruption that is only visible once the backup tree is walked. The
    // previous rollback removed the target first and discovered this second,
    // which destroyed the only remaining copy of the data.
    const backup = join(await recoveryDirectory(), 'hello.txt');
    await unlink(backup);
    await mkdir(backup);
    await symlink('/etc/passwd', join(backup, 'sneaky'));

    await expect(new AgentEnvironmentManager(withEnvironmentShell({ root: appRoot })).initialize()).rejects.toThrow(/symbolic link|restor/iu);
    expect(await readFile(join(target, 'hello.txt'), 'utf8')).toBe('after\n');
    await rm(root, { recursive: true, force: true });
  });
});
