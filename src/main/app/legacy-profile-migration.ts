import { join } from 'node:path';
import { lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { abortStartup, CONTINUE_STARTUP, type StartupDecision } from './startup-decision';
import type { PortableRecord } from '@shared/models/portable';

/**
 * One-time adoption of the pre-rebrand user profile.
 *
 * Renaming the application changed Electron's default `userData` directory
 * from `<appData>/MarginLab` to `<appData>/Interleaf`, which would strand an
 * existing user's library, annotations, chats, settings, credentials, and
 * agent sessions. This module moves the whole legacy directory into place
 * before `app.whenReady()`, i.e. before anything opens the database or the
 * credential vault.
 *
 * Safety rules, all fail-closed:
 *
 * - Never merge two populated profiles. If the Interleaf directory already
 *   holds anything, the legacy directory is left untouched.
 * - Never follow a symlink on either side, and never overwrite a file. An
 *   unsafe current path is reported separately from a safely populated one,
 *   because only the second is a state startup may continue on.
 * - Only fixed brand directory names directly under Electron's appData root
 *   are considered; no caller-supplied or renderer-supplied path reaches here.
 * - The move is a single `rename`, so it is atomic and idempotent: a repeat
 *   run finds no legacy directory and reports `no-legacy-profile`.
 */

export const BRAND_PROFILE_DIRECTORY_NAME = 'Interleaf' as const;
export const LEGACY_BRAND_PROFILE_DIRECTORY_NAME = 'MarginLab' as const;

/**
 * Finder writes this into any directory a user browses, including one Electron
 * created and never populated. It is disposable metadata, not user data, so it
 * must not permanently block adoption of a real profile.
 */
const DISPOSABLE_METADATA_FILE = '.DS_Store' as const;

type LegacyProfileMigrationOutcome =
  /** Nothing to adopt: no legacy profile directory exists. */
  | 'no-legacy-profile'
  /** The legacy path exists but is not a plain directory (symlink, file). */
  | 'legacy-profile-unsafe'
  /** The current path exists but is a symlink or not a directory. */
  | 'current-profile-unsafe'
  /** The Interleaf profile already holds data; both profiles are preserved. */
  | 'current-profile-populated'
  /** The legacy profile was moved to the Interleaf profile directory. */
  | 'migrated'
  /** The move failed; the legacy profile is intact. */
  | 'failed';

export type LegacyProfileMigrationResult = {
  readonly outcome: LegacyProfileMigrationOutcome;
  readonly legacyPath: string;
  readonly currentPath: string;
  readonly reason?: string;
};

type LegacyProfileMigrationLog = {
  readonly info: (message: string, context?: PortableRecord) => void;
  readonly warn: (message: string, context?: PortableRecord) => void;
};

/**
 * Filesystem seam. Production always uses the real one; tests inject failing
 * operations to cover the paths a real directory cannot be coaxed into.
 */
export type LegacyProfileFileSystem = {
  readonly lstat: (path: string) => Stats | null;
  readonly readdir: (path: string) => readonly string[] | null;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (path: string) => void;
  readonly rmdir: (path: string) => void;
};

export const realProfileFileSystem: LegacyProfileFileSystem = {
  lstat: (path) => {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  },
  readdir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
  rmdir: (path) => {
    rmdirSync(path);
  },
};

export type LegacyProfileMigrationOptions = {
  /** Electron's `appData` root. Both brand directories are direct children. */
  readonly appDataRoot: string;
  readonly log: LegacyProfileMigrationLog;
  readonly fileSystem?: LegacyProfileFileSystem | undefined;
};

export function migrateLegacyUserDataProfile(
  options: LegacyProfileMigrationOptions,
): LegacyProfileMigrationResult {
  const fs = options.fileSystem ?? realProfileFileSystem;
  const legacyPath = join(options.appDataRoot, LEGACY_BRAND_PROFILE_DIRECTORY_NAME);
  const currentPath = join(options.appDataRoot, BRAND_PROFILE_DIRECTORY_NAME);
  const finish = (
    outcome: LegacyProfileMigrationOutcome,
    reason?: string,
  ): LegacyProfileMigrationResult => ({
    outcome,
    legacyPath,
    currentPath,
    ...(reason !== undefined ? { reason } : {}),
  });

  // A case-insensitive filesystem (the macOS default) resolves both brand
  // names to the same directory, so there is nothing to move and a rename
  // would be a self-rename.
  if (samePathTarget(fs, legacyPath, currentPath)) {
    return finish('no-legacy-profile', 'legacy and current paths resolve to the same directory');
  }

  const legacy = fs.lstat(legacyPath);
  if (legacy === null) return finish('no-legacy-profile');
  if (!isPlainDirectory(legacy)) {
    options.log.warn('legacy profile path is not a plain directory; leaving it untouched', {
      legacyPath,
    });
    return finish('legacy-profile-unsafe', 'legacy profile path is not a plain directory');
  }

  const cleared = clearCurrentPath(fs, currentPath, options.log);
  if (cleared.kind === 'stop') return finish(cleared.outcome, cleared.reason);

  const renameFailure = failureOf(() => { fs.rename(legacyPath, currentPath); });
  if (renameFailure !== null) {
    options.log.warn('legacy profile migration failed', { legacyPath, currentPath, reason: renameFailure });
    return finish('failed', renameFailure);
  }
  options.log.info('adopted the legacy profile directory', { legacyPath, currentPath });
  return finish('migrated');
}

/**
 * Startup gate for the adoption result. Continuing is allowed only when the
 * profile directory that will be used is known-good: nothing to adopt, an
 * already-populated plain directory, or a completed move.
 */
export function legacyProfileAdoptionDecision(
  result: LegacyProfileMigrationResult,
): StartupDecision {
  if (
    result.outcome === 'no-legacy-profile' ||
    result.outcome === 'current-profile-populated' ||
    result.outcome === 'migrated'
  ) {
    return CONTINUE_STARTUP;
  }
  return abortStartup(
    `legacy profile adoption reported ${result.outcome}${result.reason === undefined ? '' : `: ${result.reason}`}`,
  );
}

type ClearOutcome =
  | { readonly kind: 'clear' }
  | { readonly kind: 'stop'; readonly outcome: LegacyProfileMigrationOutcome; readonly reason?: string };

/**
 * Makes the current path free for a rename, or explains why it must not be.
 * Only an empty directory, or one holding nothing but a regular `.DS_Store`,
 * is removed; anything else is preserved untouched.
 */
function clearCurrentPath(
  fs: LegacyProfileFileSystem,
  currentPath: string,
  log: LegacyProfileMigrationLog,
): ClearOutcome {
  const current = fs.lstat(currentPath);
  if (current === null) return { kind: 'clear' };
  if (!isPlainDirectory(current)) {
    log.warn('current profile path is not a plain directory; refusing to continue', { currentPath });
    return {
      kind: 'stop',
      outcome: 'current-profile-unsafe',
      reason: 'current profile path is not a plain directory',
    };
  }

  const entries = fs.readdir(currentPath);
  if (entries === null) {
    return { kind: 'stop', outcome: 'failed', reason: 'could not read the current profile directory' };
  }
  const disposable = entries.length === 1 && entries[0] === DISPOSABLE_METADATA_FILE;
  if (entries.length > 0 && !disposable) {
    log.info('current profile already has data; legacy profile left in place', { currentPath });
    return { kind: 'stop', outcome: 'current-profile-populated' };
  }

  // Removing an empty placeholder cannot destroy data: `rmdir` fails if
  // anything raced in between, which leaves both profiles untouched.
  const clearFailure = failureOf(() => {
    if (disposable) removeDisposableMetadata(fs, currentPath);
    fs.rmdir(currentPath);
  });
  if (clearFailure !== null) {
    log.warn('could not clear the empty current profile directory', { currentPath, reason: clearFailure });
    return { kind: 'stop', outcome: 'failed', reason: clearFailure };
  }
  return { kind: 'clear' };
}

/**
 * Deletes the one fixed metadata file, after confirming that exact child is a
 * regular non-symlink file. Without the check a planted symlink named
 * `.DS_Store` would make the unlink act somewhere else entirely.
 */
function removeDisposableMetadata(fs: LegacyProfileFileSystem, currentPath: string): void {
  const metadataPath = join(currentPath, DISPOSABLE_METADATA_FILE);
  const metadata = fs.lstat(metadataPath);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${DISPOSABLE_METADATA_FILE} in the current profile is not a plain file`);
  }
  fs.unlink(metadataPath);
}

function isPlainDirectory(stats: Stats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

/**
 * True when both names refer to the same existing directory, which is what a
 * case-insensitive filesystem reports for `MarginLab` and `Interleaf` only if
 * one is a link or alias of the other.
 */
function samePathTarget(fs: LegacyProfileFileSystem, a: string, b: string): boolean {
  const left = fs.lstat(a);
  const right = fs.lstat(b);
  if (left === null || right === null) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Runs one filesystem step of the adoption and reports how it failed.
 *
 * Every step here is best-effort in the same way: the profile is left exactly
 * as it was and the reason is carried into both the log and the result, so the
 * failure is described once, here, rather than in each caller's catch block.
 */
function failureOf(step: () => void): string | null {
  try {
    step();
    return null;
  } catch (error) {
    return describeError(error instanceof Error ? error : null);
  }
}

function describeError(error: Error | null): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
