import { opendirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { appendsWellKnownDirectories } from './cli-search-path-isolation';

/**
 * The PATH handed to provider/agent CLI lookups and children.
 *
 * A macOS app launched from Finder/LaunchServices inherits only the OS GUI
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), never the PATH a login shell builds,
 * so CLIs installed in the usual per-user and Homebrew locations would be
 * invisible. On macOS the inherited PATH is kept, in order, and a fixed set of
 * well-known install directories that exist is appended after it. Nothing is
 * read from shell startup files, no shell is run, the user's or a workspace's
 * configuration cannot add a location, and `process.env` is never mutated.
 * Every other platform receives its inherited PATH unchanged.
 */

/** Newest-first nvm Node versions considered, and directory entries read. */
const MAX_NVM_VERSIONS = 16;
const MAX_NVM_DIRECTORY_ENTRIES = 256;
const NVM_VERSION = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/u;
const SYSTEM_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

export type CliSearchPathFs = {
  readonly isDirectory: (path: string) => boolean;
  /** At most `limit` entry names of a directory; empty when it is unreadable. */
  readonly listDirectory: (path: string, limit: number) => readonly string[];
};

export type CliSearchPathOptions = {
  readonly platform?: NodeJS.Platform;
  readonly inheritedPath?: string | undefined;
  readonly homeDirectory?: string;
  readonly fileSystem?: CliSearchPathFs;
};

const defaultFileSystem: CliSearchPathFs = {
  isDirectory: (path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  },
  listDirectory: (path, limit) => {
    const names: string[] = [];
    try {
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry !== null && names.length < limit; entry = directory.readSync()) {
          names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
    } catch {
      return names;
    }
    return names;
  },
};

export function buildCliSearchPath(options: CliSearchPathOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const inherited = 'inheritedPath' in options ? options.inheritedPath : process.env.PATH;
  if (!appendsWellKnownDirectories(platform)) return inherited;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const entries = (inherited ?? '').split(':').filter((entry) => entry.length > 0);
  const present = new Set(entries);
  const additions = wellKnownDirectories(options.homeDirectory ?? homedir(), fileSystem)
    .filter((directory) => !present.has(directory) && fileSystem.isDirectory(directory));
  if (additions.length === 0) return inherited;
  return [...entries, ...additions].join(':');
}

function wellKnownDirectories(home: string, fileSystem: CliSearchPathFs): readonly string[] {
  // A relative or root "home" is not a user profile; skip per-user locations.
  const userDirectories = posix.isAbsolute(home) && posix.normalize(home) !== '/'
    ? [
        posix.join(home, '.local', 'bin'),
        posix.join(home, '.bun', 'bin'),
        ...nvmDirectories(posix.join(home, '.nvm', 'versions', 'node'), fileSystem),
      ]
    : [];
  return [...userDirectories, ...SYSTEM_DIRECTORIES];
}

/** `~/.nvm/versions/node/v*\/bin`, one directory level, newest version first. */
function nvmDirectories(versionsRoot: string, fileSystem: CliSearchPathFs): readonly string[] {
  return fileSystem.listDirectory(versionsRoot, MAX_NVM_DIRECTORY_ENTRIES)
    .flatMap((name) => {
      const match = NVM_VERSION.exec(name);
      return match === null ? [] : [{ name, version: match.slice(1, 4).map(Number) }];
    })
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, MAX_NVM_VERSIONS)
    .map(({ name }) => posix.join(versionsRoot, name, 'bin'));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
