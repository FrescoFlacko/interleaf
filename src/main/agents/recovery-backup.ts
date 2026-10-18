import { type BigIntStats, constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isStrictlyInside } from '../security/path-guard';
import { fileIdentityFromStats, sameFileIdentity } from '../security/file-identity';

/**
 * Item G: the recovery backup is the only copy of the user's pre-apply data,
 * so every traversal of it is bounded and every restore is proved *before* the
 * target it replaces is removed.
 *
 * Three defects this replaces:
 *
 * - The backup copy was recursive with no cumulative byte, entry, or depth
 *   budget. Only a single file's size was checked, so a large or deep target
 *   subtree could exhaust the disk or the call stack inside the apply
 *   transaction, at the exact moment the target is half-mutated.
 * - A file was backed up with `copyFile` after an `lstat`, so the thing copied
 *   was not provably the thing measured. A file replaced, grown, or
 *   re-owned in that window was silently recorded as the backup.
 * - Rollback removed the target and *then* walked the backup. A backup that
 *   turned out to be unreadable, oversized, or symbolic-linked therefore
 *   destroyed the target before failing — the one outcome rollback exists to
 *   prevent.
 */
const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 100_000;
export const MAX_BACKUP_DEPTH = 64;
const MAX_BACKUP_DIRECTORY_CHILDREN = 20_000;

const COPY_CHUNK_BYTES = 1024 * 1024;

type Details = BigIntStats;

export type BackupLimits = {
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly entries: number;
};

const DEFAULT_BACKUP_LIMITS: BackupLimits = {
  fileBytes: MAX_BACKUP_FILE_BYTES,
  totalBytes: MAX_BACKUP_TOTAL_BYTES,
  entries: MAX_BACKUP_ENTRIES,
};

let activeLimits: BackupLimits = DEFAULT_BACKUP_LIMITS;

/**
 * Test-only seam. The thresholds this module defends are hundreds of megabytes;
 * proving behaviour *at* them by writing hundreds of megabytes would be slower
 * and less deterministic than scaling the limits down and writing kilobytes at
 * the same ratios. Never called from IPC, renderer input, or production code.
 */
export function setBackupLimitsForTests(limits: Partial<BackupLimits> | null): void {
  activeLimits = limits === null ? DEFAULT_BACKUP_LIMITS : { ...DEFAULT_BACKUP_LIMITS, ...limits };
}

/**
 * One budget spans one *pass* over a set of entries, so a thousand small
 * backups cannot each pass an individually reasonable limit and collectively
 * exhaust the disk.
 *
 * A budget is consumptive, so it must not be reused across passes that walk the
 * same bytes twice. Backing a tree up, proving it restorable, and restoring it
 * are three passes over one set of bytes; charging all three to one allowance
 * made a rollback of a backup larger than a third of `MAX_BACKUP_TOTAL_BYTES`
 * fail on the budget — *after* the target had already been removed. Each pass
 * therefore gets its own budget, and the preflight below proves the complete
 * restore fits before anything is mutated.
 */
export type BackupBudget = { bytes: number; entries: number; readonly limits: BackupLimits };

export function createBackupBudget(limits: BackupLimits = activeLimits): BackupBudget {
  return { bytes: 0, entries: 0, limits };
}

function chargeBackupBudget(budget: BackupBudget, bytes: number): void {
  budget.entries += 1;
  budget.bytes += bytes;
  if (budget.entries > budget.limits.entries) throw new InterleafError('validation', 'The apply recovery backup exceeds the bounded entry-count limit.');
  if (budget.bytes > budget.limits.totalBytes) throw new InterleafError('validation', 'The apply recovery backup exceeds the bounded byte limit.');
}

const charge = chargeBackupBudget;

function assertDepth(depth: number, path: string): void {
  if (depth > MAX_BACKUP_DEPTH) throw new InterleafError('validation', `The apply recovery backup exceeds the bounded depth limit at ${path}.`);
}

/**
 * Ownership is part of identity here. A backup source owned by another user is
 * something this process did not create and cannot prove the provenance of, so
 * it is refused rather than copied into an app-owned recovery directory.
 */
function assertOwnedByProcess(details: Details, path: string): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && Number(details.uid) !== uid) {
    throw new InterleafError('security-violation', `Refusing to back up an entry owned by another user: ${path}`);
  }
}

/**
 * Exact identity: same file identity (device, inode, birth time), same
 * ownership, same mode, same size. Comparing this before and after the bytes are read is what makes
 * post-snapshot growth, truncation, replacement, and a `chown` fail closed
 * instead of producing a backup that does not match what was measured.
 */
function assertSameIdentity(expected: Details, actual: Details, path: string): void {
  if (!sameFileIdentity(fileIdentityFromStats(expected), fileIdentityFromStats(actual))) {
    throw new InterleafError('security-violation', `A recovery backup source was replaced while it was being copied: ${path}`);
  }
  if (Number(expected.uid) !== Number(actual.uid) || Number(expected.gid) !== Number(actual.gid)) {
    throw new InterleafError('security-violation', `A recovery backup source changed ownership while it was being copied: ${path}`);
  }
  if ((Number(expected.mode) & 0o7777) !== (Number(actual.mode) & 0o7777)) {
    throw new InterleafError('security-violation', `A recovery backup source changed mode while it was being copied: ${path}`);
  }
  if (Number(expected.size) !== Number(actual.size)) {
    throw new InterleafError('security-violation', `A recovery backup source changed size while it was being copied: ${path}`);
  }
}

async function boundedChildren(directory: string): Promise<readonly string[]> {
  const children = await readdir(directory);
  if (children.length > MAX_BACKUP_DIRECTORY_CHILDREN) {
    throw new InterleafError('validation', `A recovery backup directory exceeds the bounded child limit: ${directory}`);
  }
  return children.sort();
}

/**
 * A short `write` is legal: the kernel may accept fewer bytes than offered.
 * Ignoring `bytesWritten` therefore silently truncates the only copy of the
 * user's data, which is the one outcome a backup may never produce. This loops
 * until the chunk is fully written, or fails.
 */
async function writeFully(out: FileHandle, buffer: Buffer, length: number, position: number, destination: string): Promise<void> {
  let written = 0;
  while (written < length) {
    const { bytesWritten } = await out.write(buffer, written, length - written, position + written);
    if (bytesWritten <= 0) throw new InterleafError('internal', `A recovery copy could not be completed and would have been truncated: ${destination}`);
    written += bytesWritten;
  }
}

/**
 * Reads every byte of a backup file. An `lstat` and a successful `open` prove
 * metadata and permission, not readability: a truncated file, an I/O error in
 * the middle of an extent, or a stalled network volume all surface only when
 * the bytes are actually read. Since the caller removes the target this backup
 * replaces immediately afterwards, "restorable" has to mean readable in full.
 */
async function readEveryByte(handle: FileHandle, size: number, path: string): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(size, 1)));
  let read = 0;
  while (read < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - read), read);
    if (bytesRead <= 0) throw new InterleafError('security-violation', `A recovery backup is shorter than its recorded size and cannot be restored: ${path}`);
    read += bytesRead;
  }
}

async function copyBackupFile(source: string, destination: string, details: Details): Promise<void> {
  const size = Number(details.size);
  // O_NOFOLLOW makes the open itself refuse a link that appeared between the
  // caller's lstat and this call, rather than trusting the earlier answer.
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertSameIdentity(details, await handle.stat({ bigint: true }), source);
    const out = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, Number(details.mode) & 0o777);
    try {
      const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(size, 1)));
      let copied = 0;
      while (copied < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - copied), copied);
        if (bytesRead === 0) throw new InterleafError('security-violation', `A recovery backup source was truncated while it was being copied: ${source}`);
        await writeFully(out, buffer, bytesRead, copied, destination);
        copied += bytesRead;
      }
      // Re-proved against the same expectation, so growth after the measured
      // size — the classic way to make a bounded copy silently partial — is a
      // failure rather than a short backup.
      assertSameIdentity(details, await handle.stat({ bigint: true }), source);
      await out.sync();
    } finally {
      await out.close();
    }
  } finally {
    await handle.close();
  }
  await chmod(destination, Number(details.mode) & 0o777);
}

/**
 * Copies one entry into (or out of) a recovery directory under a cumulative
 * budget. `details` must come from the caller's own no-follow `lstat`.
 */
export async function copyBackupEntry(source: string, destination: string, details: Details, budget: BackupBudget, depth = 0): Promise<void> {
  assertDepth(depth, source);
  if (details.isSymbolicLink()) throw new InterleafError('security-violation', `Refusing to copy a symbolic link into recovery: ${source}`);
  assertOwnedByProcess(details, source);
  if (details.isDirectory()) {
    charge(budget, 0);
    await mkdir(destination, { recursive: true, mode: Number(details.mode) & 0o777 });
    for (const child of await boundedChildren(source)) {
      const childPath = join(source, child);
      await copyBackupEntry(childPath, join(destination, child), await lstat(childPath, { bigint: true }), budget, depth + 1);
    }
    await chmod(destination, Number(details.mode) & 0o777);
    return;
  }
  if (!details.isFile()) throw new InterleafError('security-violation', `Refusing to copy a non-regular entry into recovery: ${source}`);
  if (Number(details.size) > budget.limits.fileBytes) throw new InterleafError('validation', 'A recovery entry exceeds the bounded file-size limit.');
  charge(budget, Number(details.size));
  await copyBackupFile(source, destination, details);
}

/**
 * Proves a whole backup tree is restorable *before* the caller removes the
 * target it will replace. Walking it here costs one extra traversal and is the
 * difference between a failed rollback and a destroyed target.
 */
export async function assertRestorableBackup(recoveryRoot: string, backup: string, details: Details, budget: BackupBudget, depth = 0): Promise<void> {
  assertDepth(depth, backup);
  if (!isStrictlyInside(recoveryRoot, backup)) {
    throw new InterleafError('security-violation', 'A recovery backup path escapes its app-owned recovery directory.');
  }
  if (details.isSymbolicLink()) throw new InterleafError('security-violation', `A recovery backup contains a symbolic link and cannot be restored: ${backup}`);
  assertOwnedByProcess(details, backup);
  if (details.isDirectory()) {
    charge(budget, 0);
    for (const child of await boundedChildren(backup)) {
      const childPath = join(backup, child);
      await assertRestorableBackup(recoveryRoot, childPath, await lstat(childPath, { bigint: true }), budget, depth + 1);
    }
    return;
  }
  if (!details.isFile()) throw new InterleafError('security-violation', `A recovery backup contains a non-regular entry and cannot be restored: ${backup}`);
  if (Number(details.size) > budget.limits.fileBytes) throw new InterleafError('validation', 'A recovery backup entry exceeds the bounded file-size limit.');
  charge(budget, Number(details.size));
  // Readability is part of restorability: a backup that cannot be opened
  // no-follow, or cannot be read to its recorded end, must fail here — while
  // the target it replaces is still intact.
  const handle = await open(backup, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertSameIdentity(details, await handle.stat({ bigint: true }), backup);
    await readEveryByte(handle, Number(details.size), backup);
    assertSameIdentity(details, await handle.stat({ bigint: true }), backup);
  } finally { await handle.close(); }
}

/**
 * Proves the *complete* restore set before the first mutation of the first
 * target. Per-item validation interleaved with per-item removal is not enough:
 * item three's unreadable backup is then discovered after items one and two
 * have already been removed and rewritten.
 *
 * Returns the `lstat` result each backup was proved with, so the restore pass
 * charges its own fresh budget and re-proves identity against the same
 * expectation rather than re-measuring a tree that may have changed.
 */
export async function preflightRestore(
  recoveryRoot: string,
  items: readonly { readonly backup: string | null }[],
): Promise<ReadonlyMap<string, Details>> {
  const budget = createBackupBudget();
  const proven = new Map<string, Details>();
  for (const item of items) {
    if (item.backup === null || proven.has(item.backup)) continue;
    const details = await lstat(item.backup, { bigint: true });
    await assertRestorableBackup(recoveryRoot, item.backup, details, budget);
    proven.set(item.backup, details);
  }
  return proven;
}

/**
 * Undoes a path the transaction *created* — a path the journal records as
 * having held nothing before the apply began.
 *
 * This is deliberately not `rm -rf`. It descends itself so that a symbolic
 * link, a device node, a socket, or an entry owned by another user stops the
 * rollback with the journal intact rather than being deleted on the assumption
 * that everything under a created path must be ours. Unlinking proceeds only
 * through entries this process could have written, under the same depth and
 * entry budget as every other traversal here.
 */
export async function removeCreatedEntry(target: string, budget: BackupBudget, depth = 0): Promise<void> {
  assertDepth(depth, target);
  let details: Details;
  try { details = await lstat(target, { bigint: true }); } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  charge(budget, 0);
  if (details.isSymbolicLink()) throw new InterleafError('security-violation', `Recovery encountered a symbolic link at a transaction-created path: ${target}`);
  assertOwnedByProcess(details, target);
  if (details.isFile()) {
    await unlink(target);
    return;
  }
  if (!details.isDirectory()) throw new InterleafError('security-violation', `Recovery encountered a non-regular entry at a transaction-created path: ${target}`);
  for (const child of await boundedChildren(target)) {
    await removeCreatedEntry(join(target, child), budget, depth + 1);
  }
  await rmdir(target);
}
