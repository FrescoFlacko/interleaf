import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * Item E: one segment-aware validator for every manifest, recovery, and diff
 * boundary.
 *
 * The earlier checks were substring checks (`!value.includes('..')`), which are
 * wrong in both directions: they reject an ordinary filename such as `foo..bar`
 * or `archive..2024.tar`, and they say nothing about an empty segment, a NUL,
 * a bare `.` segment, a Windows drive-relative prefix, or a separator that is
 * normalized into a traversal later. A relative path recorded in a manifest or
 * a recovery journal is untrusted data that is eventually joined onto a real
 * target directory, so it is validated by decomposition, not by search.
 *
 * The accepted grammar is deliberately narrow and platform-independent, so one
 * manifest means the same thing on POSIX and Windows:
 *
 * - non-empty, at most {@link MAX_RELATIVE_PATH_LENGTH} UTF-16 units;
 * - no NUL or other C0 control character anywhere;
 * - `/` is the only separator; a backslash is rejected rather than normalized,
 *   which is what makes `a\..\..\b` impossible to smuggle past a POSIX split;
 * - no absolute form: a leading `/`, a leading `\`, a `//` or `\\` UNC prefix,
 *   or a `X:` drive prefix (absolute *or* drive-relative);
 * - every segment non-empty, at most {@link MAX_SEGMENT_LENGTH} units, and
 *   neither `.` nor `..`.
 *
 * Note what stays legal: `foo..bar`, `...`, `..hidden`, and `a.b..c/d` are all
 * ordinary names and all accepted. Only a *whole segment* of `.` or `..` is a
 * traversal.
 */
const MAX_RELATIVE_PATH_LENGTH = 1_024;
const MAX_SEGMENT_LENGTH = 255;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const DRIVE_PREFIX = /^[A-Za-z]:/u;

export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_RELATIVE_PATH_LENGTH) return false;
  // NUL truncates a path at the syscall boundary, and other C0 controls are
  // never legitimate manifest content; both are rejected before decomposition.
  if (CONTROL_CHARACTERS.test(value)) return false;
  // A backslash is not normalized into `/`. Accepting it would mean a path that
  // this validator splits one way and the platform splits another.
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (DRIVE_PREFIX.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) =>
    segment.length > 0 &&
    segment.length <= MAX_SEGMENT_LENGTH &&
    segment !== '.' &&
    segment !== '..');
}

/**
 * Canonicalizes a *host-produced* relative path — the result of `path.relative`,
 * which uses the platform separator — into the single `/` form every persisted
 * record uses.
 *
 * Windows returns `packages\app` for a selected Git subdirectory. Persisting
 * that meant persisting something this module's own validator rejects, so the
 * session's manifest was unreadable on the platform that wrote it: a restart
 * refused its own worktree. Only the separator is translated, and only when the
 * host uses one: a backslash inside a POSIX *name* is still rejected rather
 * than reinterpreted as a separator, which is what keeps `a\..\..\b` from
 * meaning one thing here and another to the platform. Persisted values are
 * therefore always separator-free in the `\` sense, and an untrusted manifest
 * carrying backslashes is refused by {@link isSafeRelativePath} as before.
 *
 * `separator` is injectable so the cross-platform behaviour can be proved on
 * either host; production always passes the real one.
 */
export function toManifestRelativePath(hostRelative: string, separator: string, context = 'a persisted relative path'): string {
  if (hostRelative.length === 0) return '';
  const value = separator === '/' ? hostRelative : hostRelative.split(separator).join('/');
  return assertSafeRelativePath(value, context);
}

export function assertSafeRelativePath(value: string, context: string): string {
  if (!isSafeRelativePath(value)) {
    throw new InterleafError('security-violation', `An unsafe relative path was rejected in ${context}.`);
  }
  return value;
}
