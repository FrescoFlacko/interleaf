import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { InterleafDatabase } from './database';
import { isStrictlyInside, relativePathWithin } from '../security/path-guard';
import type { PortableRecord } from '@shared/models/portable';

/**
 * Rebases app-owned absolute paths that were written while the profile still
 * lived at `<appData>/MarginLab`.
 *
 * Moving the profile directory and renaming the database file preserves every
 * row, but the rows themselves store absolute paths into the profile. After
 * adoption those paths point at a directory that no longer exists, so every
 * managed blob in the new library looks unreferenced — and the managed-orphan
 * sweep deletes exactly what it cannot see a reference to. This repair runs
 * between opening/migrating the adopted database and the first reconciliation,
 * which is the only window where the mismatch is visible and still harmless.
 *
 * Scope rules, deliberately narrow:
 *
 * - Only fixed, app-owned columns are considered: managed document files,
 *   generated cover snapshots, and archived article assets. Linked documents,
 *   user working directories, agent executables and caller-supplied paths are
 *   never rewritten.
 * - A value is rebased only when path containment says it is inside the legacy
 *   profile root. A prefix such as `<appData>/MarginLabNotes` or an unrelated
 *   `~/Documents/MarginLab/x.pdf` is not contained and stays untouched, so the
 *   brand string alone can never move a user's external file reference.
 * - The rewritten value must land inside the current profile root, or the row
 *   is left alone.
 * - Everything happens in one `BEGIN IMMEDIATE` transaction, so a failure
 *   leaves the database exactly as it was rather than half-rebased.
 * - Re-running is a no-op: a path already under the current root is not
 *   contained in the legacy root, so nothing matches a second time.
 */

export type LegacyProfilePathRepairResult = {
  readonly outcome: 'not-applicable' | 'no-legacy-paths' | 'repaired';
  readonly documentFiles: number;
  readonly coverSnapshots: number;
  readonly documentAssets: number;
};

type LegacyProfilePathRepairLog = {
  readonly info: (message: string, context?: PortableRecord) => void;
};

export type LegacyProfilePathRepairOptions = {
  readonly db: InterleafDatabase;
  /** Absolute pre-rebrand profile root (`<appData>/MarginLab`). */
  readonly legacyUserDataRoot: string;
  /** Absolute current profile root (`AppPaths.userData`). */
  readonly currentUserDataRoot: string;
  readonly log: LegacyProfilePathRepairLog;
};

/** One pending rewrite: the new value plus the key columns identifying the row. */
type PendingRewrite = {
  readonly nextPath: string;
  readonly keys: readonly string[];
};

type RepairTarget = {
  readonly select: string;
  readonly update: string;
  readonly keyColumns: readonly string[];
  readonly pathColumn: string;
};

/**
 * `documents.file_path` is rewritten for managed rows only: a linked row points
 * at a file the user owns somewhere else, and a linked file inside the profile
 * is not a layout this application creates.
 */
const REPAIR_TARGETS: readonly RepairTarget[] = [
  {
    select: `SELECT id, file_path AS path FROM documents WHERE storage_mode = 'managed'`,
    update: 'UPDATE documents SET file_path = ? WHERE id = ?',
    keyColumns: ['id'],
    pathColumn: 'file_path',
  },
  {
    select: 'SELECT id, cover_path AS path FROM documents WHERE cover_path IS NOT NULL',
    update: 'UPDATE documents SET cover_path = ? WHERE id = ?',
    keyColumns: ['id'],
    pathColumn: 'cover_path',
  },
  {
    select: 'SELECT document_id, reference, file_path AS path FROM document_assets',
    update: 'UPDATE document_assets SET file_path = ? WHERE document_id = ? AND reference = ?',
    keyColumns: ['document_id', 'reference'],
    pathColumn: 'file_path',
  },
];

export function repairLegacyProfilePaths(
  options: LegacyProfilePathRepairOptions,
): LegacyProfilePathRepairResult {
  const empty = { outcome: 'not-applicable', documentFiles: 0, coverSnapshots: 0, documentAssets: 0 } as const;
  if (!isAbsolute(options.legacyUserDataRoot) || !isAbsolute(options.currentUserDataRoot)) return empty;
  const legacyRoots = profileRootForms(options.legacyUserDataRoot);
  const currentRoot = profileRootForms(options.currentUserDataRoot)[0];
  if (currentRoot === undefined || legacyRoots.includes(currentRoot)) return empty;

  const raw = options.db.raw;
  const planned = REPAIR_TARGETS.map((target) =>
    planRewrites(raw.prepare(target.select).all() as readonly PortableRecord[], target, legacyRoots, currentRoot),
  );
  const counts = {
    documentFiles: planned[0]?.length ?? 0,
    coverSnapshots: planned[1]?.length ?? 0,
    documentAssets: planned[2]?.length ?? 0,
  };
  const total = counts.documentFiles + counts.coverSnapshots + counts.documentAssets;
  if (total === 0) return { outcome: 'no-legacy-paths', ...counts };

  raw.exec('BEGIN IMMEDIATE');
  try {
    REPAIR_TARGETS.forEach((target, index) => {
      const statement = raw.prepare(target.update);
      for (const rewrite of planned[index] ?? []) {
        statement.run(rewrite.nextPath, ...rewrite.keys);
      }
    });
    raw.exec('COMMIT');
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }
  // Counts only: a profile path embeds the account name.
  options.log.info('rebased pre-rebrand profile paths', { ...counts });
  return { outcome: 'repaired', ...counts };
}

function planRewrites(
  rows: readonly PortableRecord[],
  target: RepairTarget,
  legacyRoots: readonly string[],
  currentRoot: string,
): readonly PendingRewrite[] {
  const rewrites: PendingRewrite[] = [];
  for (const row of rows) {
    const stored = row.path;
    if (typeof stored !== 'string') continue;
    const nextPath = rebaseIntoCurrentProfile(stored, legacyRoots, currentRoot);
    if (nextPath === null) continue;
    const keys = target.keyColumns.map((column) => row[column]);
    if (!keys.every((key): key is string => typeof key === 'string')) continue;
    rewrites.push({ nextPath, keys });
  }
  return rewrites;
}

/**
 * Returns the path this value should have inside the current profile, or null
 * when the value is not an app-owned path inside the legacy profile.
 */
function rebaseIntoCurrentProfile(
  storedPath: string,
  legacyRoots: readonly string[],
  currentRoot: string,
): string | null {
  if (!isAbsolute(storedPath)) return null;
  const resolved = resolve(storedPath);
  for (const legacyRoot of legacyRoots) {
    const relativeToLegacy = relativePathWithin(legacyRoot, resolved);
    if (relativeToLegacy === null || relativeToLegacy.length === 0) continue;
    const candidate = join(currentRoot, relativeToLegacy);
    // Fail closed if the rewrite would ever leave the current profile.
    if (isStrictlyInside(currentRoot, candidate)) return candidate;
  }
  return null;
}

/**
 * The forms a profile root can appear in inside stored paths, canonical first.
 *
 * Managed paths are recorded after `realpath`, so on a system where the profile
 * sits under a symlinked parent (`/var` → `/private/var` on macOS) the stored
 * value uses the resolved parent while `app.getPath` reports the symlinked one.
 * The legacy root itself no longer exists once the profile has been adopted, so
 * its canonical form is reconstructed from its parent.
 */
function profileRootForms(root: string): readonly string[] {
  const literal = resolve(root);
  const forms = new Set<string>();
  try {
    forms.add(realpathSync(literal));
  } catch {
    try {
      forms.add(join(realpathSync(dirname(literal)), basename(literal)));
    } catch {
      // Neither the root nor its parent can be resolved; the literal form is
      // all this repair can honestly match against.
    }
  }
  forms.add(literal);
  return [...forms];
}
