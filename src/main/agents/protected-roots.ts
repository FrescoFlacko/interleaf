import { describeError } from '@shared/models/caught-error';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isStrictlyInside } from '../security/path-guard';

/**
 * Main-owned protected application-data root policy (docs/SECURITY.md §3–4,
 * ADR 0008).
 *
 * An agent target that overlaps Interleaf's own storage would let an isolated
 * worktree, directory copy, immutable baseline, or apply/rollback journal read
 * or rewrite the database, library, credentials, logs, or another session's
 * workspace. Overlap is symmetric and must be rejected in all three directions:
 *
 * - `same`: the candidate *is* a protected root.
 * - `candidate-is-parent`: a protected root lives inside the candidate.
 * - `candidate-is-descendant`: the candidate lives inside a protected root.
 *
 * Both sides are canonicalized with realpath semantics first, so a symlink
 * alias of a protected root is rejected exactly like the root itself, while
 * distinct sibling roots (`…/agent-workspaces` next to `…/agent-workspaces-2`)
 * are compared segment-wise and never treated as overlapping.
 *
 * Every rejection happens before any lock, snapshot, copy, baseline, or
 * workspace mutation, and any uncertainty (an unreadable ancestor, a
 * non-ENOENT canonicalization failure) fails closed.
 */
export type ProtectedRootOverlap = 'same' | 'candidate-is-parent' | 'candidate-is-descendant';

const REJECTION_MESSAGE =
  'The selected folder overlaps Interleaf’s own application data and cannot be used as an agent target.';

/**
 * Segment-aware symmetric overlap test for two already-canonical paths, built
 * on the canonical containment helper in `src/main/security/path-guard.ts`.
 */
export function protectedRootOverlap(candidate: string, root: string): ProtectedRootOverlap | null {
  if (candidate === root) return 'same';
  if (isStrictlyInside(root, candidate)) return 'candidate-is-descendant';
  if (isStrictlyInside(candidate, root)) return 'candidate-is-parent';
  return null;
}

export class ProtectedRootPolicy {
  private readonly roots: readonly string[];

  /**
   * `roots` are ordinary configured paths. They are canonicalized on every
   * check rather than once at construction, because a protected root can be
   * created, recreated, or re-pointed while the application is running.
   */
  constructor(roots: readonly string[] = []) {
    this.roots = roots.map((root) => resolve(root));
  }

  get declaredRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Canonicalizes the candidate and rejects the full overlap matrix against
   * every protected root. Returns the canonical candidate path so callers can
   * use exactly the value that was checked.
   */
  async assertSelectable(candidatePath: string): Promise<string> {
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(resolve(candidatePath));
    } catch (error) {
      throw new InterleafError(
        'mode-resolution-failed',
        'The selected target directory could not be canonicalized.',
        { cause: error instanceof Error ? error : null },
      );
    }
    for (const root of this.roots) {
      const canonicalRoot = await canonicalizeExistingAncestor(root);
      if (protectedRootOverlap(canonicalCandidate, canonicalRoot) !== null) {
        throw new InterleafError('security-violation', REJECTION_MESSAGE);
      }
    }
    return canonicalCandidate;
  }
}

/**
 * Canonicalizes a protected root that may not exist yet: walks up to the
 * deepest existing ancestor, realpaths it, and re-appends the remainder. Only
 * a missing entry is tolerated; any other failure is uncertainty and fails
 * closed, because an unresolvable root cannot be proven distinct from the
 * candidate.
 */
async function canonicalizeExistingAncestor(target: string): Promise<string> {
  const suffixes: string[] = [];
  let current = resolve(target);
  for (;;) {
    const real = await realpathIfPresent(current);
    if (real !== null) return suffixes.length === 0 ? real : resolve(real, ...suffixes.reverse());
    const parent = resolve(current, '..');
    if (parent === current) {
      throw new InterleafError(
        'security-violation',
        'A protected application-data root has no resolvable ancestor.',
      );
    }
    suffixes.push(basename(current));
    current = parent;
  }
}

/**
 * The canonical path of one component, or `null` when it does not exist yet.
 * Any other failure is uncertainty and fails closed.
 */
async function realpathIfPresent(current: string): Promise<string | null> {
  try {
    return await realpath(current);
  } catch (error) {
    const caught = error instanceof Error ? error : null;
    if (isMissingEntry(caught)) return null;
    throw new InterleafError(
      'security-violation',
      'A protected application-data root could not be canonicalized; agent targets cannot be proven safe.',
      { cause: caught },
    );
  }
}

/** A path component that does not exist yet, or is not a directory. */
function isMissingEntry(caught: Error | null): boolean {
  const { code } = describeError(caught);
  return code === 'ENOENT' || code === 'ENOTDIR';
}
