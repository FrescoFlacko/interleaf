import { join } from 'node:path';
import { lstatSync, renameSync, type Stats } from 'node:fs';
import {
  abortStartup,
  assertStartupContinues,
  CONTINUE_STARTUP,
  type StartupDecision,
} from '../app/startup-decision';
import type { PortableRecord } from '@shared/models/portable';

/**
 * One-time rename of the pre-rebrand database file.
 *
 * The database now lives at `<userData>/database/interleaf.sqlite`. A profile
 * created before the Interleaf rename has `marginlab.sqlite` in the same
 * directory, together with whatever SQLite sidecars the last session left
 * behind. This runs immediately before `InterleafDatabase.open`, so no
 * connection is held while the files move, and it never touches schema
 * contents — only file names change.
 *
 * Safety rules, all fail-closed:
 *
 * - Every path on both sides is `lstat`ed in a preflight pass before anything
 *   moves. Symlinks and non-regular files are refused, on either side.
 * - Only runs when the Interleaf database does not already exist. Two
 *   populated databases are never merged and an existing file is never
 *   overwritten.
 * - The move is transactional: if any sidecar rename or the main rename fails,
 *   every sidecar already moved is renamed back, so the legacy set stays whole
 *   and a later attempt starts from the same state it would have started from.
 * - Sidecars move before the main database, so a process killed mid-run leaves
 *   the legacy main file without its adopted `-wal`. The next start sees no
 *   Interleaf database, recognizes the already-adopted sidecars, and reunites
 *   the pair. Moving the main file first would instead orphan un-checkpointed
 *   transactions.
 *
 * Anything other than a clean outcome stops startup (`adoptLegacyDatabase`),
 * so a partially adopted or unsafe layout can never be masked by a freshly
 * created empty database.
 */

export const LEGACY_DATABASE_FILE_NAME = 'marginlab.sqlite' as const;

/** SQLite sidecars, ordered so the write-ahead log moves before the index. */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

type LegacyDatabaseMigrationOutcome =
  /** Nothing to adopt: no legacy database file exists. */
  | 'no-legacy-database'
  /** A legacy path exists but is a symlink or not a regular file. */
  | 'legacy-database-unsafe'
  /** A current path is a symlink, a non-regular file, or a stale collision. */
  | 'current-database-unsafe'
  /** A validated Interleaf database already exists; both sets are preserved. */
  | 'current-database-present'
  /** The legacy database and its sidecars were adopted. */
  | 'migrated'
  /** A rename failed; moved sidecars were rolled back where possible. */
  | 'failed';

export type LegacyDatabaseMigrationResult = {
  readonly outcome: LegacyDatabaseMigrationOutcome;
  readonly legacyPath: string;
  readonly currentPath: string;
  /**
   * Sidecar suffixes that sit at the current path because of this run. After a
   * complete rollback this is empty; a non-empty list on a `failed` outcome
   * names the sidecars that could not be moved back.
   */
  readonly movedSidecars: readonly string[];
  readonly reason?: string;
};

type LegacyDatabaseMigrationLog = {
  readonly info: (message: string, context?: PortableRecord) => void;
  readonly warn: (message: string, context?: PortableRecord) => void;
};

/**
 * Filesystem seam. Production always uses the real one; tests inject failing
 * renames to exercise rollback without depending on platform-specific ways to
 * make a single rename fail.
 */
export type LegacyMigrationFileSystem = {
  readonly lstat: (path: string) => Stats | null;
  readonly rename: (from: string, to: string) => void;
};

export const realMigrationFileSystem: LegacyMigrationFileSystem = {
  lstat: (path) => {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

export type LegacyDatabaseMigrationOptions = {
  /** Main-owned database directory (`AppPaths.database`). */
  readonly databaseDirectory: string;
  /** Current database file name (`DATABASE_FILE_NAME`). */
  readonly currentFileName: string;
  readonly legacyFileName?: string;
  readonly log: LegacyDatabaseMigrationLog;
  readonly fileSystem?: LegacyMigrationFileSystem | undefined;
};

/** One sidecar the plan intends to move, or one already adopted by an earlier run. */
type SidecarStep = {
  readonly suffix: string;
  readonly from: string;
  readonly to: string;
  readonly action: 'move' | 'already-adopted';
};

type MigrationPlan =
  | { readonly kind: 'move'; readonly steps: readonly SidecarStep[] }
  | { readonly kind: 'stop'; readonly outcome: LegacyDatabaseMigrationOutcome; readonly reason?: string };

export function migrateLegacyDatabaseFile(
  options: LegacyDatabaseMigrationOptions,
): LegacyDatabaseMigrationResult {
  const fs = options.fileSystem ?? realMigrationFileSystem;
  const legacyFileName = options.legacyFileName ?? LEGACY_DATABASE_FILE_NAME;
  const legacyPath = join(options.databaseDirectory, legacyFileName);
  const currentPath = join(options.databaseDirectory, options.currentFileName);
  const finish = (
    outcome: LegacyDatabaseMigrationOutcome,
    movedSidecars: readonly string[],
    reason?: string,
  ): LegacyDatabaseMigrationResult => ({
    outcome,
    legacyPath,
    currentPath,
    movedSidecars,
    ...(reason !== undefined ? { reason } : {}),
  });

  if (legacyPath === currentPath) return finish('no-legacy-database', []);

  const plan = planMigration(fs, legacyPath, currentPath);
  if (plan.kind === 'stop') {
    logPlanStop(options.log, plan, legacyPath, currentPath);
    return finish(plan.outcome, [], plan.reason);
  }

  const moved: string[] = [];
  const failure = applyPlan(fs, plan.steps, legacyPath, currentPath, moved);
  if (failure !== null) {
    const stranded = rollback(fs, plan.steps, moved);
    options.log.warn('legacy database migration failed; rolled back', {
      legacyPath,
      currentPath,
      reason: failure,
      strandedSidecars: [...stranded],
    });
    return finish('failed', stranded, rollbackReason(failure, stranded));
  }

  const adopted = plan.steps.map((step) => step.suffix);
  options.log.info('adopted the legacy database file', { currentPath, movedSidecars: adopted });
  return finish('migrated', adopted);
}

/**
 * Startup gate for the adoption result. Only a clean, validated layout may
 * reach `InterleafDatabase.open`; anything unsafe or partially applied stops
 * the process instead of silently starting on a new empty database.
 */
export function legacyDatabaseAdoptionDecision(
  result: LegacyDatabaseMigrationResult,
): StartupDecision {
  if (
    result.outcome === 'no-legacy-database' ||
    result.outcome === 'current-database-present' ||
    result.outcome === 'migrated'
  ) {
    return CONTINUE_STARTUP;
  }
  return abortStartup(
    `legacy database adoption reported ${result.outcome}${result.reason === undefined ? '' : `: ${result.reason}`}`,
  );
}

/**
 * Runs the adoption and throws unless the database is safe to open. Bootstrap
 * calls this in place of the raw migration so the entry module stays a flat
 * sequence of calls.
 */
export function adoptLegacyDatabase(
  options: LegacyDatabaseMigrationOptions,
): LegacyDatabaseMigrationResult {
  const result = migrateLegacyDatabaseFile(options);
  assertStartupContinues(legacyDatabaseAdoptionDecision(result));
  return result;
}

/**
 * Validates every path involved before a single rename happens, so an unsafe
 * or ambiguous layout is rejected while the directory is still untouched.
 */
function planMigration(
  fs: LegacyMigrationFileSystem,
  legacyPath: string,
  currentPath: string,
): MigrationPlan {
  const legacy = fs.lstat(legacyPath);
  if (legacy === null) return { kind: 'stop', outcome: 'no-legacy-database' };
  if (!isPlainFile(legacy)) {
    return { kind: 'stop', outcome: 'legacy-database-unsafe', reason: 'legacy database path is not a plain file' };
  }

  const current = fs.lstat(currentPath);
  if (current !== null) {
    if (!isPlainFile(current)) {
      return { kind: 'stop', outcome: 'current-database-unsafe', reason: 'current database path is not a plain file' };
    }
    return { kind: 'stop', outcome: 'current-database-present' };
  }

  const steps: SidecarStep[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const step = planSidecar(fs, suffix, `${legacyPath}${suffix}`, `${currentPath}${suffix}`);
    if (step.kind === 'stop') return step;
    if (step.kind === 'step') steps.push(step.step);
  }
  return { kind: 'move', steps };
}

type SidecarPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'step'; readonly step: SidecarStep }
  | { readonly kind: 'stop'; readonly outcome: LegacyDatabaseMigrationOutcome; readonly reason: string };

function planSidecar(
  fs: LegacyMigrationFileSystem,
  suffix: string,
  from: string,
  to: string,
): SidecarPlan {
  const source = fs.lstat(from);
  const destination = fs.lstat(to);
  if (destination !== null && !isPlainFile(destination)) {
    return { kind: 'stop', outcome: 'current-database-unsafe', reason: `current ${suffix} sidecar is not a plain file` };
  }
  if (source === null) {
    // A destination sidecar with no legacy counterpart, and no current main
    // file, is exactly what an interrupted earlier run leaves behind: the
    // sidecar is already adopted, so the retry simply completes the move.
    return destination === null ? { kind: 'skip' } : { kind: 'step', step: { suffix, from, to, action: 'already-adopted' } };
  }
  if (!isPlainFile(source)) {
    return { kind: 'stop', outcome: 'legacy-database-unsafe', reason: `legacy ${suffix} sidecar is not a plain file` };
  }
  if (destination !== null) {
    // Both sides hold real data. Choosing one would discard the other, so stop.
    return { kind: 'stop', outcome: 'current-database-unsafe', reason: `both the legacy and current ${suffix} sidecars exist` };
  }
  return { kind: 'step', step: { suffix, from, to, action: 'move' } };
}

/** Returns a failure description, or null when every rename succeeded. */
function applyPlan(
  fs: LegacyMigrationFileSystem,
  steps: readonly SidecarStep[],
  legacyPath: string,
  currentPath: string,
  moved: string[],
): string | null {
  for (const step of steps) {
    if (step.action === 'already-adopted') continue;
    const sidecarFailure = renameFailure(fs, step.from, step.to);
    if (sidecarFailure !== null) return `could not move the ${step.suffix} sidecar: ${sidecarFailure}`;
    moved.push(step.suffix);
  }
  const databaseFailure = renameFailure(fs, legacyPath, currentPath);
  if (databaseFailure !== null) return `could not move the database file: ${databaseFailure}`;
  return null;
}

/** Moves one file, describing the failure, or `null` when the move succeeded. */
function renameFailure(fs: LegacyMigrationFileSystem, from: string, to: string): string | null {
  try {
    fs.rename(from, to);
    return null;
  } catch (error) {
    return describeError(error instanceof Error ? error : null);
  }
}

/** Moves every already-adopted sidecar back; returns the ones left stranded. */
function rollback(
  fs: LegacyMigrationFileSystem,
  steps: readonly SidecarStep[],
  moved: readonly string[],
): readonly string[] {
  const stranded: string[] = [];
  for (const step of steps) {
    if (!moved.includes(step.suffix)) continue;
    try {
      fs.rename(step.to, step.from);
    } catch {
      stranded.push(step.suffix);
    }
  }
  return stranded;
}

function rollbackReason(failure: string, stranded: readonly string[]): string {
  return stranded.length === 0
    ? `${failure}; rolled back`
    : `${failure}; rollback incomplete for ${stranded.join(', ')}`;
}

function logPlanStop(
  log: LegacyDatabaseMigrationLog,
  plan: { readonly outcome: LegacyDatabaseMigrationOutcome; readonly reason?: string },
  legacyPath: string,
  currentPath: string,
): void {
  const context = { legacyPath, currentPath, ...(plan.reason === undefined ? {} : { reason: plan.reason }) };
  if (plan.outcome === 'no-legacy-database' || plan.outcome === 'current-database-present') {
    log.info('no legacy database adoption needed', context);
    return;
  }
  log.warn('legacy database adoption refused', context);
}

function isPlainFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function describeError(error: Error | null): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
