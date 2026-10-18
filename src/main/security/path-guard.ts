import { isAbsolute, join, relative, resolve, sep, type PlatformPath } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Path canonicalization and boundary enforcement (docs/SECURITY.md §3–4).
 *
 * Every filesystem path that crosses the privilege boundary — custom-protocol
 * requests today, agent workspaces later — MUST pass through here:
 * 1. Reject NUL bytes and undecodable input.
 * 2. Canonicalize with `path.resolve` (defeats `..` traversal textually).
 * 3. Resolve symlinks on the deepest existing ancestor (defeats link escapes).
 * 4. Verify containment inside a permitted root via `path.relative`
 *    (prefix-string checks are banned — `~/lib` must not match `~/library`).
 *
 * This is main's only owner of `path.relative`. The lexical helpers below
 * (`relativePathWithin`, `isPathWithin`, `isStrictlyInside`) do not follow
 * symlinks: callers pass already-canonical (`realpath`) paths or pair them
 * with their own symlink-ancestor checks, exactly as `canonicalizeWithinRoots`
 * does for its root and candidate.
 */

type PathGuardRejection =
  | 'empty-path'
  | 'null-byte'
  | 'malformed-url'
  | 'unsupported-scheme'
  | 'outside-permitted-roots'
  | 'unresolvable';

export type PathGuardResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly rejection: PathGuardRejection };

const MEDIA_PROTOCOL_SCHEME = 'interleaf-media';

/** Canonicalize an absolute-or-relative filesystem path against permitted roots. */
export function canonicalizeWithinRoots(requestedPath: string, roots: readonly string[]): PathGuardResult {
  if (requestedPath.length === 0) {
    return { ok: false, rejection: 'empty-path' };
  }
  if (requestedPath.includes('\0')) {
    return { ok: false, rejection: 'null-byte' };
  }

  let candidate: string;
  try {
    candidate = resolve(requestedPath);
  } catch {
    return { ok: false, rejection: 'unresolvable' };
  }

  const realCandidate = realpathUp(candidate);
  if (realCandidate === null) {
    return { ok: false, rejection: 'unresolvable' };
  }

  for (const root of roots) {
    const canonicalRoot = realpathUp(resolve(root));
    if (canonicalRoot === null) {
      continue;
    }
    if (isInside(canonicalRoot, realCandidate)) {
      return { ok: true, resolvedPath: realCandidate };
    }
  }
  return { ok: false, rejection: 'outside-permitted-roots' };
}

/**
 * Resolve a `interleaf-media://` request URL to a contained filesystem path.
 * The URL path is percent-decoded before canonicalization so encoded
 * traversals (`%2e%2e%2f`) cannot slip past textual checks.
 */
export function resolveMediaUrlTarget(requestUrl: string, roots: readonly string[]): PathGuardResult {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, rejection: 'malformed-url' };
  }
  if (url.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return { ok: false, rejection: 'unsupported-scheme' };
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, rejection: 'malformed-url' };
  }

  // Standard schemes place the absolute path in `pathname` with a leading
  // slash; strip it and anchor resolution at the filesystem root.
  const stripped = decodedPathname.replace(/^[/\\]+/, '');
  const anchored = join(sep, stripped);
  return canonicalizeWithinRoots(anchored, roots);
}

type RelativePathFlavor = Pick<PlatformPath, 'isAbsolute' | 'relative' | 'sep'>;

const HOST_PATH: RelativePathFlavor = { isAbsolute, relative, sep };

/**
 * The segment-aware path from `root` to `candidate` when the candidate is the
 * root itself (`''`) or lies beneath it; `null` when it escapes through `..`
 * or resolves onto another root or drive. Both inputs are resolved first.
 * `flavor` selects the path semantics (for example `win32` on any host).
 */
export function relativePathWithin(root: string, candidate: string, flavor: RelativePathFlavor = HOST_PATH): string | null {
  const rel = flavor.relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(rel)) return null;
  return rel;
}

/** `candidate` is `root` itself or lies beneath it. */
export function isPathWithin(root: string, candidate: string): boolean {
  return relativePathWithin(root, candidate) !== null;
}

/** `candidate` lies beneath `root` and is not `root` itself. */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = relativePathWithin(root, candidate);
  return rel !== null && rel.length > 0;
}

/**
 * The host-form relative path between two paths, for recording or displaying
 * a location already proven contained. This is not a containment check; use
 * `relativePathWithin` when the answer decides access.
 */
export function relativePathBetween(from: string, to: string): string {
  return relative(from, to);
}

function isInside(root: string, candidate: string): boolean {
  // The root itself resolves to a directory; allow the guard to pass so the
  // caller's read attempt surfaces a natural not-found instead of masking
  // misconfiguration as a security event.
  return candidate === root || isStrictlyInside(root, candidate);
}

/**
 * Realpath resolution that tolerates non-existent leaf segments (common for
 * freshly requested files): walks up to the deepest existing ancestor,
 * realpaths it, and re-appends the remainder.
 */
function realpathUp(target: string): string | null {
  const suffixes: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      if (suffixes.length === 0) {
        return real;
      }
      return join(real, ...suffixes.reverse());
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) {
        return null;
      }
      const base = relative(parent, current);
      if (base.length === 0 || base.startsWith('..')) {
        return null;
      }
      suffixes.push(base);
      current = parent;
    }
  }
}
