import { InterleafError } from '@shared/errors/interleaf-error';
import { isSafeRelativePath } from './relative-path';
import { isPortableArray, isPortableRecord, type PortableMember } from '@shared/models/portable';

/**
 * Items K and L: bounded, index-aware Git metadata for one selected subtree.
 *
 * Two of this runtime's traversal rules are name-based and therefore wrong for
 * a repository that tracks the names they skip:
 *
 * - Item K: `dist`, `vendor`, `build`, `out` and friends are skipped as
 *   generated output. A repository that *tracks* `dist/app.js` would then see
 *   that file missing from its baseline, its review, its Apply and its patch
 *   export — the agent's work on it would silently disappear. Ignored status is
 *   not tracked status, and only the index can tell them apart.
 * - Item L: every symbolic link is refused outright, so a repository that
 *   tracks an ordinary in-tree link cannot be used at all. A *tracked* link is
 *   recorded here so it can be carried as no-follow metadata; its destination
 *   is never opened, and a link that escapes the subtree is still refused.
 *
 * The answer is read once, at preparation, from `git ls-files --stage -z`,
 * bounded in entry count, and then persisted with the session so review, Apply
 * and a restart all judge the same tree against the same index. Recomputing it
 * later would let the primary repository's index drift silently redefine what
 * the session's baseline meant.
 */
const MAX_TRACKED_INDEX_ENTRIES = 20_000;

/** `git ls-files --stage` records a symbolic link as blob mode 120000. */
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';
const STAGE_LINE = /^(\d{6}) [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/u;

export type GitTrackedIndex = {
  /** Tracked files whose path crosses a generated-looking name (item K). */
  readonly generatedFiles: ReadonlySet<string>;
  /** Ancestor directories of `generatedFiles`, so traversal descends into
   * `dist/` far enough to reach the tracked entries and no further. */
  readonly generatedDirectories: ReadonlySet<string>;
  /** Tracked symbolic links permitted as no-follow metadata (item L). */
  readonly symlinks: ReadonlySet<string>;
};

export const EMPTY_TRACKED_INDEX: GitTrackedIndex = {
  generatedFiles: new Set<string>(),
  generatedDirectories: new Set<string>(),
  symlinks: new Set<string>(),
};

export type GitTrackedIndexRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/**
 * Reads the index for the selected subtree. `selectedPath` is the canonical
 * directory the session was authorized against, so every returned path is
 * relative to it and directly comparable with a manifest entry.
 */
export async function readGitTrackedIndex(
  selectedPath: string,
  runGit: GitTrackedIndexRunner,
  isGeneratedSegment: (name: string) => boolean,
): Promise<GitTrackedIndex> {
  const raw = await runGit(selectedPath, ['ls-files', '--stage', '-z', '--', '.']);
  const records = raw.split('\u0000').filter((line) => line.length > 0);
  if (records.length > MAX_TRACKED_INDEX_ENTRIES) {
    throw new InterleafError('mode-resolution-failed', 'The selected Git subtree exceeds the bounded tracked-index limit.');
  }
  const generatedFiles = new Set<string>();
  const generatedDirectories = new Set<string>();
  const symlinks = new Set<string>();
  for (const record of records) {
    const match = STAGE_LINE.exec(record);
    // An unparseable index record is uncertainty about what is tracked, and
    // this answer decides what the baseline contains. Fail closed.
    if (match === null) throw new InterleafError('mode-resolution-failed', 'A bounded Git index record could not be parsed.');
    const [, mode, path] = match;
    if (mode === undefined || path === undefined) throw new InterleafError('mode-resolution-failed', 'A bounded Git index record could not be parsed.');
    // A submodule is another repository's working tree, not content of this
    // one. It stays outside the manifest exactly as it is today.
    if (mode === GITLINK_MODE) continue;
    if (!isSafeRelativePath(path)) throw new InterleafError('security-violation', 'The Git index records a path outside the selected subtree.');
    if (mode === SYMLINK_MODE) symlinks.add(path);
    // Item K/L: a tracked link under a generated directory needs the same
    // ancestor chain a tracked file does. Returning early for links left
    // `dist/` unlisted, so the walk never descended into it and the tracked
    // link vanished from the baseline, the review and the patch — exactly the
    // disappearance item K exists to prevent, one entry type later.
    if (!addGeneratedPath(path, isGeneratedSegment, generatedDirectories)) continue;
    generatedFiles.add(path);
  }
  return { generatedFiles, generatedDirectories, symlinks };
}

/**
 * Records every ancestor of a tracked path that crosses a generated-looking
 * name, so traversal descends far enough to reach it and no further. Answers
 * whether the path is one of those paths at all.
 */
function addGeneratedPath(path: string, isGeneratedSegment: (name: string) => boolean, directories: Set<string>): boolean {
  const segments = path.split('/');
  if (!segments.some((segment) => isGeneratedSegment(segment))) return false;
  for (let index = 1; index < segments.length; index += 1) {
    directories.add(segments.slice(0, index).join('/'));
  }
  return true;
}

type SerializedTrackedIndex = {
  readonly version: 1;
  readonly generatedFiles: readonly string[];
  readonly symlinks: readonly string[];
};

export function serializeTrackedIndex(index: GitTrackedIndex): string {
  const payload: SerializedTrackedIndex = {
    version: 1,
    generatedFiles: [...index.generatedFiles].sort(),
    symlinks: [...index.symlinks].sort(),
  };
  return JSON.stringify(payload);
}

/**
 * Rehydrates a persisted index. Anything malformed answers `null` so the
 * caller can leave the environment untouched rather than reinterpret it
 * against a different set of tracked paths than the one it was built with.
 */
export function parseTrackedIndex(value: PortableMember): GitTrackedIndex | null {
  if (!isPortableRecord(value)) return null;
  const record = value;
  if (record.version !== 1 || !isPortableArray(record.generatedFiles) || !isPortableArray(record.symlinks)) return null;
  if (record.generatedFiles.length + record.symlinks.length > MAX_TRACKED_INDEX_ENTRIES) return null;
  const generatedFiles = new Set<string>();
  const generatedDirectories = new Set<string>();
  const symlinks = new Set<string>();
  for (const entry of record.generatedFiles) {
    if (typeof entry !== 'string' || !isSafeRelativePath(entry)) return null;
    generatedFiles.add(entry);
    const segments = entry.split('/');
    for (let index = 1; index < segments.length; index += 1) generatedDirectories.add(segments.slice(0, index).join('/'));
  }
  for (const entry of record.symlinks) {
    if (typeof entry !== 'string' || !isSafeRelativePath(entry)) return null;
    symlinks.add(entry);
    // Ancestors of a tracked link are admitted unconditionally here: a
    // non-generated ancestor is inert (the retention rule only consults this
    // set for generated-looking names), and an index persisted before the fix
    // above carries its links only in this list.
    const segments = entry.split('/');
    for (let index = 1; index < segments.length; index += 1) generatedDirectories.add(segments.slice(0, index).join('/'));
  }
  return { generatedFiles, generatedDirectories, symlinks };
}
