import { constants as fsConstants } from 'node:fs';
import { open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { signPreparationRecord, verifyPreparationRecord, type PreparationOwner } from './preparation-owner';
import { isPortableRecord, parsePortableJson, type PortableMember, type PortableValue } from '@shared/models/portable';

/**
 * Item J: a crash-safe preparation journal for every currently supported
 * execution mode.
 *
 * Before this, only `isolated-worktree` recorded anything about an in-flight
 * preparation, and it recorded it with a plain `writeFile`: no `fsync`, no
 * `rename`, so a crash could leave a truncated record that parses as nothing.
 * Every other mode left no record at all, so a session root abandoned halfway
 * through a bounded copy was indistinguishable from a completed one and was
 * judged afterwards by directory age and whether a manifest happened to be
 * readable.
 *
 * The journal fixes the question startup actually has to answer: *did this
 * installation create this session root and never finish it?* `ownerId` is a
 * UUID minted per preparation attempt and bound to the session root path, but a
 * UUID sitting inside the session root proves nothing on its own — it is
 * exactly as forgeable as the directory it lives in. Ownership is therefore
 * decided by the main-owned installation marker in `preparation-owner.ts`: the
 * record carries that installation's id and an HMAC over its own canonical
 * fields, and a journal that does not verify against the live marker is not
 * ours. Anything without a *verified* owned journal — a foreign directory, a
 * corrupt record, a journal naming a different session root, a hand-written one
 * with a plausible UUID — is left on disk for explicit repair and is never
 * turned into a deletion target.
 *
 * `pending-git-cleanup.json` remains a separate record with a different job:
 * it describes *external* Git state (a registered worktree and branch outside
 * the app-owned root) that must be unwound before the session root may be
 * removed at all.
 */
export const PREPARATION_FILE = 'preparation.json';
const PREPARATION_TEMP_FILE = '.preparation.json.tmp';
const MAX_PREPARATION_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Every durable step of `prepare()`, in order. Each is a point at which the
 * process can die, and each must leave a journal that names the step reached.
 */
export const PREPARATION_PHASES = [
  'session-root',
  'tracked-index',
  'worktree-registered',
  'workspace',
  'baseline',
  'manifest',
  'metadata',
] as const;

export type PreparationPhase = (typeof PREPARATION_PHASES)[number];

export type PreparationJournal = {
  readonly version: 1;
  readonly ownerId: string;
  readonly installationId: string;
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly mode: string;
  readonly phase: PreparationPhase;
  readonly committed: boolean;
};

/**
 * The exact bytes the MAC covers, in a fixed order. Every field that decides
 * what the journal authorizes is inside it, so none of them can be edited
 * without invalidating the record.
 */
function canonicalJournal(journal: PreparationJournal): string {
  return JSON.stringify([
    journal.version,
    journal.ownerId,
    journal.installationId,
    journal.sessionId,
    resolve(journal.sessionRoot),
    journal.mode,
    journal.phase,
    journal.committed,
  ]);
}

function isPreparationPhase(value: PortableMember): value is PreparationPhase {
  return typeof value === 'string' && (PREPARATION_PHASES as readonly string[]).includes(value);
}

/**
 * `O_EXCL` temp, write, `fsync`, `rename`, then `fsync` the directory. The
 * rename is what makes the record all-or-nothing; the two syncs are what make
 * it survive a power loss rather than merely a process death.
 */
export async function writePreparationJournal(sessionRoot: string, journal: PreparationJournal, owner: PreparationOwner, afterTempWrite?: () => Promise<void>): Promise<void> {
  if (journal.installationId !== owner.installationId) throw new InterleafError('security-violation', 'A preparation journal was not bound to this installation.');
  const serialized = JSON.stringify({ ...journal, mac: signPreparationRecord(owner, canonicalJournal(journal)) });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PREPARATION_BYTES) throw new InterleafError('validation', 'The preparation journal exceeds the bounded limit.');
  const temporary = join(sessionRoot, PREPARATION_TEMP_FILE);
  await unlink(temporary).catch(() => undefined);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    await afterTempWrite?.();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(sessionRoot, PREPARATION_FILE));
  await syncDirectory(sessionRoot);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code !== 'EBADF' && code !== 'EISDIR' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  }
}

/**
 * Answers `null` for anything this installation cannot prove it owns: a
 * missing record, unreadable JSON, a malformed shape, a non-UUID owner, a
 * journal whose session identity does not match the directory it sits in, a
 * different installation's id, or a MAC that does not verify against this
 * installation's marker. `null` means "leave it alone", never "safe to delete".
 */
export async function readPreparationJournal(sessionRoot: string, owner: PreparationOwner): Promise<PreparationJournal | null> {
  let raw: string;
  try { raw = await readFile(join(sessionRoot, PREPARATION_FILE), 'utf8'); } catch { return null; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_PREPARATION_BYTES) return null;
  let value: PortableValue;
  try { value = parsePortableJson(raw); } catch { return null; }
  if (!isPortableRecord(value)) return null;
  const record = value;
  if (record.version !== 1) return null;
  if (typeof record.ownerId !== 'string' || !UUID_RE.test(record.ownerId)) return null;
  if (record.installationId !== owner.installationId) return null;
  if (typeof record.sessionId !== 'string' || record.sessionId !== basename(sessionRoot)) return null;
  if (typeof record.sessionRoot !== 'string' || resolve(record.sessionRoot) !== resolve(sessionRoot)) return null;
  if (typeof record.mode !== 'string' || record.mode.length === 0 || record.mode.length > 64) return null;
  if (!isPreparationPhase(record.phase) || typeof record.committed !== 'boolean') return null;
  const journal: PreparationJournal = {
    version: 1,
    ownerId: record.ownerId,
    installationId: owner.installationId,
    sessionId: record.sessionId,
    sessionRoot: resolve(sessionRoot),
    mode: record.mode,
    phase: record.phase,
    committed: record.committed,
  };
  // The decisive check. Shape, UUID form and matching paths are all things a
  // forger can reproduce; the MAC is the only field that requires the
  // main-owned secret held outside this subtree.
  if (!verifyPreparationRecord(owner, canonicalJournal(journal), record.mac)) return null;
  return journal;
}

/**
 * The one window the owner marker cannot cover: between creating the session
 * root and renaming its first journal into place, the directory holds nothing
 * but (at most) this module's own atomic temp file. A session root that is
 * empty apart from that temp is therefore an abandoned preparation of ours —
 * it has no manifest, no metadata, no workspace, and no user data to lose.
 * Anything with other content is not covered here and is left for the journal
 * check, which fails closed.
 */
export async function isAbandonedPreparationRoot(sessionRoot: string): Promise<boolean> {
  let entries: string[];
  try { entries = await readdir(sessionRoot); } catch { return false; }
  return entries.every((entry) => entry === PREPARATION_TEMP_FILE);
}

export async function removePreparationJournal(sessionRoot: string): Promise<void> {
  await unlink(join(sessionRoot, PREPARATION_FILE)).catch(() => undefined);
  await unlink(join(sessionRoot, PREPARATION_TEMP_FILE)).catch(() => undefined);
  await syncDirectory(sessionRoot);
}
