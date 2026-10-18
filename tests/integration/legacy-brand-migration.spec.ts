import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  BRAND_PROFILE_DIRECTORY_NAME,
  LEGACY_BRAND_PROFILE_DIRECTORY_NAME,
  legacyProfileAdoptionDecision,
  migrateLegacyUserDataProfile,
  realProfileFileSystem,
  type LegacyProfileFileSystem,
} from '@main/app/legacy-profile-migration';
import { assertStartupContinues } from '@main/app/startup-decision';
import {
  adoptLegacyDatabase,
  LEGACY_DATABASE_FILE_NAME,
  legacyDatabaseAdoptionDecision,
  migrateLegacyDatabaseFile,
  realMigrationFileSystem,
  type LegacyMigrationFileSystem,
} from '@main/db/legacy-database-migration';
import { InterleafDatabase, DATABASE_FILE_NAME } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { FolderRepository } from '@main/db/repositories/folder-repository';
import { silentLogger } from '../helpers/silent-logger';

/**
 * Real-filesystem coverage for adopting a profile and a database created
 * before the MarginLab → Interleaf rename. These migrations decide whether an
 * existing user keeps or loses their data, so every case runs against actual
 * directories, files, and symlinks rather than a mocked `fs`.
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'interleaf-legacy-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function legacyProfile(root: string): string {
  return path.join(root, LEGACY_BRAND_PROFILE_DIRECTORY_NAME);
}

function currentProfile(root: string): string {
  return path.join(root, BRAND_PROFILE_DIRECTORY_NAME);
}

function seedProfile(directory: string, marker: string): void {
  mkdirSync(path.join(directory, 'database'), { recursive: true });
  writeFileSync(path.join(directory, 'credentials.v1.json'), marker, 'utf8');
}

describe('legacy user-data profile adoption', () => {
  it('moves a pre-rebrand profile when no Interleaf profile exists', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('migrated');
    expect(readFileSync(path.join(currentProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
    expect(readdirSync(root)).toEqual([BRAND_PROFILE_DIRECTORY_NAME]);
  });

  it('is idempotent: a second run finds nothing to adopt and changes nothing', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');

    expect(migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root }).outcome).toBe('migrated');
    const second = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(second.outcome).toBe('no-legacy-profile');
    expect(readFileSync(path.join(currentProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
  });

  it('never merges two populated profiles', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    seedProfile(currentProfile(root), 'current-secrets');

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('current-profile-populated');
    expect(readFileSync(path.join(currentProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'current-secrets',
    );
    expect(readFileSync(path.join(legacyProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
  });

  it('adopts through an empty placeholder directory', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    mkdirSync(currentProfile(root));

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('migrated');
    expect(readFileSync(path.join(currentProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
  });

  it('refuses to follow a symlinked legacy profile', () => {
    const root = makeRoot();
    const elsewhere = path.join(root, 'elsewhere');
    seedProfile(elsewhere, 'not-ours');
    symlinkSync(elsewhere, legacyProfile(root));

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('legacy-profile-unsafe');
    expect(readFileSync(path.join(elsewhere, 'credentials.v1.json'), 'utf8')).toBe('not-ours');
  });

  it('refuses to write through a symlinked Interleaf profile and stops startup', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, currentProfile(root));

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('current-profile-unsafe');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(path.join(legacyProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
    // An unsafe current path is never a state the app may start on.
    expect(() => {
      assertStartupContinues(legacyProfileAdoptionDecision(result));
    }).toThrow(/current-profile-unsafe/u);
  });

  it('adopts through a placeholder that holds only Finder metadata', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    mkdirSync(currentProfile(root));
    writeFileSync(path.join(currentProfile(root), '.DS_Store'), 'finder', 'utf8');

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('migrated');
    expect(readFileSync(path.join(currentProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
    expect(readdirSync(currentProfile(root))).not.toContain('.DS_Store');
    expect(legacyProfileAdoptionDecision(result).kind).toBe('continue');
  });

  it('refuses a placeholder whose .DS_Store is a symlink', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    const bait = path.join(root, 'bait');
    writeFileSync(bait, 'do-not-delete', 'utf8');
    mkdirSync(currentProfile(root));
    symlinkSync(bait, path.join(currentProfile(root), '.DS_Store'));

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root });

    expect(result.outcome).toBe('failed');
    expect(readFileSync(bait, 'utf8')).toBe('do-not-delete');
    expect(readFileSync(path.join(legacyProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );
    expect(legacyProfileAdoptionDecision(result).kind).toBe('abort');
  });

  it('stops startup when the rename fails after the placeholder was cleared', () => {
    const root = makeRoot();
    seedProfile(legacyProfile(root), 'legacy-secrets');
    mkdirSync(currentProfile(root));
    writeFileSync(path.join(currentProfile(root), '.DS_Store'), 'finder', 'utf8');
    const fileSystem: LegacyProfileFileSystem = {
      ...realProfileFileSystem,
      rename: () => {
        throw new Error('injected rename failure');
      },
    };

    const result = migrateLegacyUserDataProfile({ log: silentLogger, appDataRoot: root, fileSystem });

    expect(result.outcome).toBe('failed');
    // The legacy profile is untouched, so a later run can still adopt it.
    expect(readFileSync(path.join(legacyProfile(root), 'credentials.v1.json'), 'utf8')).toBe(
      'legacy-secrets',
    );

    // Bootstrap boundary: nothing that creates application state may run.
    const initializeApplicationState = vi.fn();
    expect(() => {
      assertStartupContinues(legacyProfileAdoptionDecision(result));
      initializeApplicationState();
    }).toThrow(/Startup stopped/u);
    expect(initializeApplicationState).not.toHaveBeenCalled();
  });
});

describe('legacy database file adoption', () => {
  function migrate(directory: string) {
    return migrateLegacyDatabaseFile({
      log: silentLogger,
      databaseDirectory: directory,
      currentFileName: DATABASE_FILE_NAME,
    });
  }

  it('moves the database together with its WAL and SHM sidecars', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'main', 'utf8');
    writeFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}-wal`), 'wal', 'utf8');
    writeFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}-shm`), 'shm', 'utf8');

    const result = migrate(root);

    expect(result.outcome).toBe('migrated');
    expect(result.movedSidecars).toEqual(['-wal', '-shm']);
    expect(readFileSync(path.join(root, DATABASE_FILE_NAME), 'utf8')).toBe('main');
    expect(readFileSync(path.join(root, `${DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('wal');
    expect(readFileSync(path.join(root, `${DATABASE_FILE_NAME}-shm`), 'utf8')).toBe('shm');
    expect(readdirSync(root).some((entry) => entry.startsWith(LEGACY_DATABASE_FILE_NAME))).toBe(false);
  });

  it('moves a database that has no sidecars', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'main', 'utf8');

    const result = migrate(root);

    expect(result.outcome).toBe('migrated');
    expect(result.movedSidecars).toEqual([]);
    expect(readFileSync(path.join(root, DATABASE_FILE_NAME), 'utf8')).toBe('main');
  });

  it('leaves both files alone when an Interleaf database already exists', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'legacy', 'utf8');
    writeFileSync(path.join(root, DATABASE_FILE_NAME), 'current', 'utf8');

    const result = migrate(root);

    expect(result.outcome).toBe('current-database-present');
    expect(readFileSync(path.join(root, DATABASE_FILE_NAME), 'utf8')).toBe('current');
    expect(readFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'utf8')).toBe('legacy');
  });

  /** Real filesystem, with one rename direction made to fail. */
  function failingRenameFileSystem(failWhenTargetEndsWith: string): LegacyMigrationFileSystem {
    return {
      lstat: realMigrationFileSystem.lstat,
      rename: (from, to) => {
        if (to.endsWith(failWhenTargetEndsWith)) throw new Error('injected rename failure');
        realMigrationFileSystem.rename(from, to);
      },
    };
  }

  function seedLegacySet(root: string, suffixes: readonly string[]): void {
    writeFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'main', 'utf8');
    for (const suffix of suffixes) {
      writeFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}${suffix}`), suffix, 'utf8');
    }
  }

  it('rolls every moved sidecar back when a later sidecar fails', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal', '-shm']);

    const result = migrateLegacyDatabaseFile({
      log: silentLogger,
      databaseDirectory: root,
      currentFileName: DATABASE_FILE_NAME,
      fileSystem: failingRenameFileSystem(`${DATABASE_FILE_NAME}-shm`),
    });

    expect(result.outcome).toBe('failed');
    expect(result.movedSidecars).toEqual([]);
    expect(result.reason).toContain('rolled back');
    // The legacy set is whole again and nothing Interleaf-named exists.
    expect(readdirSync(root).sort()).toEqual(
      [
        LEGACY_DATABASE_FILE_NAME,
        `${LEGACY_DATABASE_FILE_NAME}-shm`,
        `${LEGACY_DATABASE_FILE_NAME}-wal`,
      ].sort(),
    );
    expect(readFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('-wal');
  });

  it('rolls sidecars back when the main database rename fails', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal', '-shm']);

    const result = migrateLegacyDatabaseFile({
      log: silentLogger,
      databaseDirectory: root,
      currentFileName: DATABASE_FILE_NAME,
      fileSystem: failingRenameFileSystem(DATABASE_FILE_NAME),
    });

    expect(result.outcome).toBe('failed');
    expect(result.movedSidecars).toEqual([]);
    expect(readdirSync(root).some((entry) => entry.startsWith(DATABASE_FILE_NAME))).toBe(false);
    expect(readFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'utf8')).toBe('main');
  });

  it('completes an interrupted run on the next start', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal', '-shm']);

    // Interrupt: the WAL move lands on disk, then the process dies before the
    // rest of the run — so no rollback happens at all.
    renameSync(
      path.join(root, `${LEGACY_DATABASE_FILE_NAME}-wal`),
      path.join(root, `${DATABASE_FILE_NAME}-wal`),
    );

    const retry = migrate(root);

    expect(retry.outcome).toBe('migrated');
    expect(retry.movedSidecars).toEqual(['-wal', '-shm']);
    expect(readFileSync(path.join(root, DATABASE_FILE_NAME), 'utf8')).toBe('main');
    expect(readFileSync(path.join(root, `${DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('-wal');
    expect(readFileSync(path.join(root, `${DATABASE_FILE_NAME}-shm`), 'utf8')).toBe('-shm');
    expect(readdirSync(root).some((entry) => entry.startsWith(LEGACY_DATABASE_FILE_NAME))).toBe(false);
  });

  it('refuses a symlinked current database path', () => {
    const root = makeRoot();
    const elsewhere = path.join(root, 'elsewhere.sqlite');
    writeFileSync(elsewhere, 'elsewhere', 'utf8');
    writeFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'main', 'utf8');
    symlinkSync(elsewhere, path.join(root, DATABASE_FILE_NAME));

    const result = migrate(root);

    expect(result.outcome).toBe('current-database-unsafe');
    expect(readFileSync(elsewhere, 'utf8')).toBe('elsewhere');
    expect(readFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'utf8')).toBe('main');
  });

  it('refuses a symlinked current sidecar', () => {
    const root = makeRoot();
    const bait = path.join(root, 'bait');
    writeFileSync(bait, 'bait', 'utf8');
    seedLegacySet(root, ['-wal']);
    symlinkSync(bait, path.join(root, `${DATABASE_FILE_NAME}-wal`));

    const result = migrate(root);

    expect(result.outcome).toBe('current-database-unsafe');
    expect(result.movedSidecars).toEqual([]);
    expect(readFileSync(bait, 'utf8')).toBe('bait');
    expect(readFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'utf8')).toBe('main');
  });

  it('refuses a current sidecar that is not a regular file', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal']);
    mkdirSync(path.join(root, `${DATABASE_FILE_NAME}-wal`));

    const result = migrate(root);

    expect(result.outcome).toBe('current-database-unsafe');
    expect(readFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('-wal');
  });

  it('refuses when both the legacy and current sidecar hold data', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal']);
    writeFileSync(path.join(root, `${DATABASE_FILE_NAME}-wal`), 'stale', 'utf8');

    const result = migrate(root);

    expect(result.outcome).toBe('current-database-unsafe');
    expect(readFileSync(path.join(root, `${DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('stale');
    expect(readFileSync(path.join(root, `${LEGACY_DATABASE_FILE_NAME}-wal`), 'utf8')).toBe('-wal');
  });

  it('never reaches database open after an unsafe or failed adoption', () => {
    const root = makeRoot();
    seedLegacySet(root, ['-wal']);
    symlinkSync(path.join(root, 'elsewhere.sqlite'), path.join(root, DATABASE_FILE_NAME));
    const openDatabase = vi.fn();

    expect(() => {
      // Same call order bootstrap uses: adopt, then open.
      adoptLegacyDatabase({ log: silentLogger, databaseDirectory: root, currentFileName: DATABASE_FILE_NAME });
      openDatabase();
    }).toThrow(/current-database-unsafe/u);

    expect(openDatabase).not.toHaveBeenCalled();
    // No fresh Interleaf database was created in place of the legacy data.
    expect(readFileSync(path.join(root, LEGACY_DATABASE_FILE_NAME), 'utf8')).toBe('main');
    expect(readdirSync(root)).not.toContain('elsewhere.sqlite');
  });

  it('allows startup for the safe outcomes only', () => {
    const decision = (outcome: string) =>
      legacyDatabaseAdoptionDecision({
        outcome: outcome as never,
        legacyPath: '/legacy',
        currentPath: '/current',
        movedSidecars: [],
      }).kind;

    expect(decision('no-legacy-database')).toBe('continue');
    expect(decision('current-database-present')).toBe('continue');
    expect(decision('migrated')).toBe('continue');
    expect(decision('legacy-database-unsafe')).toBe('abort');
    expect(decision('current-database-unsafe')).toBe('abort');
    expect(decision('failed')).toBe('abort');
  });

  it('refuses a symlinked legacy database', () => {
    const root = makeRoot();
    const target = path.join(root, 'other.sqlite');
    writeFileSync(target, 'other', 'utf8');
    symlinkSync(target, path.join(root, LEGACY_DATABASE_FILE_NAME));

    const result = migrate(root);

    expect(result.outcome).toBe('legacy-database-unsafe');
    expect(readdirSync(root).includes(DATABASE_FILE_NAME)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('other');
  });

  it('is idempotent and safe to call when nothing legacy exists', () => {
    const root = makeRoot();
    expect(migrate(root).outcome).toBe('no-legacy-database');
    expect(readdirSync(root)).toEqual([]);
  });

  it('opens a real pre-rebrand database after adoption, keeping its rows', () => {
    const root = makeRoot();
    const legacyPath = path.join(root, LEGACY_DATABASE_FILE_NAME);
    const seeded = InterleafDatabase.open(legacyPath);
    try {
      runMigrations(seeded);
      new FolderRepository(seeded).create('folder-carried-over', 'Carried Over', null);
    } finally {
      seeded.close();
    }

    expect(migrate(root).outcome).toBe('migrated');

    const adopted = InterleafDatabase.open(path.join(root, DATABASE_FILE_NAME));
    try {
      // Re-running migrations proves the checksummed history still validates,
      // which is what keeps the pre-rebrand SQL identifiers frozen.
      expect(runMigrations(adopted)).toBe(0);
      const names = new FolderRepository(adopted).list().map((folder) => folder.name);
      expect(names).toContain('Carried Over');
      // The persisted trigger calls the pre-rebrand SQL function by name, so a
      // write must still succeed against the adopted database.
      new FolderRepository(adopted).create('folder-after-rename', 'Added After Rename', null);
      expect(new FolderRepository(adopted).list().map((folder) => folder.name)).toContain(
        'Added After Rename',
      );
    } finally {
      adopted.close();
    }
  });
});
