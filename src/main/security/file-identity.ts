import type { BigIntStats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isPortableRecord, type PortableMember } from '@shared/models/portable';

/**
 * The one definition of "the same file or directory" for every main-owned
 * replacement check (docs/SECURITY.md, "File and directory identity").
 *
 * `{device, inode}` alone is not an identity. Linux filesystems reuse inode
 * numbers aggressively — on ext4 `rm -r dir && mkdir dir` usually gets the
 * same number back — so a directory replaced in place would pass a
 * device/inode comparison. The birth time, read at nanosecond resolution
 * (`statx` on Linux, `st_birthtimespec` on macOS, the creation time on
 * Windows), is assigned when the inode is allocated and is not changed by
 * writes, renames, or new directory entries, so a reused inode number carries
 * a different birth time. `ctime` is deliberately not used: adding an entry to
 * a directory changes it, which would make every working directory "replaced"
 * the moment an agent wrote a file.
 *
 * Birth time unavailable — policy: some filesystems (NFS, older FUSE drivers,
 * kernels without `statx`) report a birth time of zero. Such an identity is
 * recorded with `birthtimeNs: null` and is *unprovable*: it never compares
 * equal to anything, including another unprovable identity of the same inode.
 * There is no silent fallback to device/inode only. Selection boundaries call
 * `hasProvableIdentity` and refuse the target up front with an explicit
 * message, so the user learns at selection time rather than through a later
 * "replaced" failure. Identities persisted before birth time was recorded are
 * read back with `birthtimeNs: null` and fail closed the same way.
 *
 * Canonical-path and containment checks are separate and unchanged; this only
 * strengthens the identity half of each proof.
 */
export type FileIdentity = {
  readonly device: number;
  readonly inode: number;
  /** Decimal nanoseconds since the epoch; `null` when the filesystem reports none. */
  readonly birthtimeNs: string | null;
};

const BIRTHTIME_NS_PATTERN = /^[1-9][0-9]{0,30}$/u;

export function fileIdentityFromStats(stats: BigIntStats): FileIdentity {
  return {
    device: Number(stats.dev),
    inode: Number(stats.ino),
    birthtimeNs: stats.birthtimeNs > 0n ? stats.birthtimeNs.toString() : null,
  };
}

/** Exactly the identity fields of a record that carries them, for copying and persistence. */
export function pickFileIdentity(record: FileIdentity): FileIdentity {
  return { device: record.device, inode: record.inode, birthtimeNs: record.birthtimeNs };
}

export function hasProvableIdentity(identity: FileIdentity): boolean {
  return identity.birthtimeNs !== null;
}

/** For selection boundaries: the identity, or the caller's explicit refusal when it is unprovable. */
export function requireProvableIdentity(identity: FileIdentity, refusal: () => Error): FileIdentity {
  if (!hasProvableIdentity(identity)) throw refusal();
  return identity;
}

/**
 * True only when both identities are provable and name the same inode on the
 * same device with the same birth time. An unprovable side is a mismatch.
 */
export function sameFileIdentity(expected: FileIdentity, actual: FileIdentity): boolean {
  return hasProvableIdentity(expected)
    && hasProvableIdentity(actual)
    && expected.device === actual.device
    && expected.inode === actual.inode
    && expected.birthtimeNs === actual.birthtimeNs;
}

/** Follows symlinks. The returned stats are the ones the identity was taken from. */
export async function statWithIdentity(path: string): Promise<{ readonly stats: BigIntStats; readonly identity: FileIdentity }> {
  const stats = await stat(path, { bigint: true });
  return { stats, identity: fileIdentityFromStats(stats) };
}

export type DirectoryIdentityProof =
  | { readonly kind: 'same' }
  | { readonly kind: 'replaced' }
  | { readonly kind: 'inaccessible'; readonly cause: Error | null };

/**
 * Whether `canonicalPath` still canonicalizes to itself and is the exact
 * directory `expected` names. Callers turn a non-`same` answer into their own
 * fail-closed error.
 */
export async function proveDirectoryIdentity(canonicalPath: string, expected: FileIdentity): Promise<DirectoryIdentityProof> {
  let resolved: string;
  let current: Awaited<ReturnType<typeof statWithIdentity>>;
  try {
    resolved = await realpath(canonicalPath);
    current = await statWithIdentity(resolved);
  } catch (error) {
    return { kind: 'inaccessible', cause: error instanceof Error ? error : null };
  }
  const same = current.stats.isDirectory() && resolved === canonicalPath && sameFileIdentity(expected, current.identity);
  return same ? { kind: 'same' } : { kind: 'replaced' };
}

/**
 * Reads the identity fields of a persisted record. `null` means malformed.
 * The `birthtimeNs` key must be present: migration 26 wrote an explicit
 * `null` into every row recorded before birth time existed, so a missing key
 * is corruption rather than legacy, while an explicit `null` reads back as an
 * unprovable (fail-closed) identity.
 */
export function parseFileIdentity(value: PortableMember): FileIdentity | null {
  if (!isPortableRecord(value)) return null;
  const { device, inode, birthtimeNs } = value;
  if (typeof device !== 'number' || !Number.isFinite(device) || device < 0) return null;
  if (typeof inode !== 'number' || !Number.isFinite(inode) || inode < 0) return null;
  if (birthtimeNs === null) return { device, inode, birthtimeNs: null };
  if (typeof birthtimeNs !== 'string' || !BIRTHTIME_NS_PATTERN.test(birthtimeNs)) return null;
  return { device, inode, birthtimeNs };
}
