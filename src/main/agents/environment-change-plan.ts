import type { ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import type { EnvironmentChangeKind, EnvironmentFileChange } from '@shared/types/agent-environment';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * What changed between an environment's frozen manifest and the workspace now,
 * and whether that change may be applied. Pure: the environment manager takes
 * both snapshots and owns every filesystem step; this only compares them.
 */

/** The most entries one change set may carry, also bounding recovery journals. */
export const MAX_CHANGE_ENTRIES = 10_000;

/**
 * Item L: `symlink` is a metadata-only entry type. `hash` is the SHA-256 of the
 * link's own target *string* read with `readlink`, and `size` is that string's
 * byte length — the link is never opened, so nothing outside the tree is read.
 */
export type SnapshotEntry = {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly hash: string | null;
};

export type ChangePlan = {
  readonly files: readonly EnvironmentFileChange[];
  /** Item L: changes where either side is a symbolic link. These are reported
   * so the user can see them, and are never applied, staged, or diffed. */
  readonly symlinkChanges: readonly EnvironmentFileChange[];
  readonly createdDirectories: readonly string[];
  readonly deletedDirectories: readonly string[];
  readonly before: readonly SnapshotEntry[];
  readonly after: readonly SnapshotEntry[];
};

/** The facts about an environment an Apply refusal depends on. */
type ApplyState = {
  readonly mode: ResolvedAgentExecutionMode;
  readonly primaryWasDirty: boolean;
};

/**
 * Item L: defence in depth behind the review's own refusal. Apply owns the
 * mutation, so it re-states the invariant itself rather than trusting a review
 * computed before it. Throws; it never returns for a changed link.
 */
export function assertNoSymlinkChanges(plan: ChangePlan): void {
  if (plan.symlinkChanges.length > 0) {
    throw new InterleafError('security-violation', 'Apply was blocked because a symbolic link was created, removed, or repointed in the workspace.');
  }
}

export function applyRefusalReason(state: ApplyState, plan: ChangePlan): string | null {
  if (state.mode === 'active-env' || state.mode === 'native-restricted') return 'Direct workspace modes have no sandbox to apply.';
  if (state.primaryWasDirty) return 'Apply is disabled because the primary Git worktree contained uncommitted changes at session start.';
  if (plan.symlinkChanges.length > 0) return 'Apply is disabled because a symbolic link was created, removed, or repointed in the workspace.';
  return null;
}

/** The mutable lists a plan is assembled in, before replaced-directory children are dropped. */
type PlanDraft = {
  readonly changes: EnvironmentFileChange[];
  readonly symlinkChanges: EnvironmentFileChange[];
  readonly createdDirectories: string[];
  readonly deletedDirectories: string[];
  readonly replacedByFile: string[];
};

function changeKind(before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): EnvironmentChangeKind | null {
  if (before === undefined) return after === undefined ? null : 'created';
  if (after === undefined) return 'deleted';
  return before.type !== after.type || before.hash !== after.hash || before.mode !== after.mode ? 'modified' : null;
}

/** A change reported with no content: a link, or a directory whose mode changed. */
function contentFreeChange(path: string, kind: EnvironmentChangeKind): EnvironmentFileChange {
  return { path, kind, additions: 0, deletions: 0, bytes: 0 };
}

/** A rough line count for a size, never zero for a file that exists. */
function lineEstimate(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 80));
}

function fileChange(path: string, kind: EnvironmentChangeKind, before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): EnvironmentFileChange {
  const bytes = after?.size ?? before?.size ?? 0;
  const additions = kind === 'deleted' ? 0 : lineEstimate(bytes);
  const deletions = kind === 'created' ? 0 : lineEstimate(before?.size ?? 0);
  return { path, kind, additions, deletions, bytes };
}

/**
 * Records a change to what was a directory. Returns false only when the
 * directory became a file, which is then also reported as that file's change.
 */
function recordDirectoryChange(draft: PlanDraft, path: string, before: SnapshotEntry, after: SnapshotEntry | undefined): boolean {
  if (after === undefined) {
    draft.deletedDirectories.push(path);
    return true;
  }
  if (after.type === 'directory') {
    if (before.mode !== after.mode) draft.changes.push(contentFreeChange(path, 'modified'));
    return true;
  }
  if (after.type === 'file') draft.replacedByFile.push(path);
  return false;
}

function recordChange(draft: PlanDraft, path: string, kind: EnvironmentChangeKind, before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): void {
  // Item L: a link is only ever supported unchanged. A created, deleted, or
  // repointed link leaves the supported set entirely, so it is diverted here
  // and fails Apply closed instead of being staged or diffed.
  if (before?.type === 'symlink' || after?.type === 'symlink') {
    draft.symlinkChanges.push(contentFreeChange(path, kind));
    return;
  }
  if (before?.type === 'directory' && recordDirectoryChange(draft, path, before, after)) return;
  if (before === undefined && after?.type === 'directory') {
    draft.createdDirectories.push(path);
    return;
  }
  draft.changes.push(fileChange(path, kind, before, after));
}

export function buildChangePlan(before: readonly SnapshotEntry[], after: readonly SnapshotEntry[]): ChangePlan {
  const left = new Map(before.map((entry) => [entry.path, entry]));
  const right = new Map(after.map((entry) => [entry.path, entry]));
  const draft: PlanDraft = { changes: [], symlinkChanges: [], createdDirectories: [], deletedDirectories: [], replacedByFile: [] };
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const kind = changeKind(left.get(path), right.get(path));
    if (kind !== null) recordChange(draft, path, kind, left.get(path), right.get(path));
  }
  const insideReplaced = (path: string): boolean => draft.replacedByFile.some((root) => path.startsWith(`${root}/`));
  const files = draft.changes.filter((change) => !insideReplaced(change.path));
  const deletedDirectories = draft.deletedDirectories.filter((path) => !insideReplaced(path));
  if (files.length + draft.symlinkChanges.length + draft.createdDirectories.length + deletedDirectories.length > MAX_CHANGE_ENTRIES) {
    throw new InterleafError('validation', `The environment change set exceeds the bounded limit of ${String(MAX_CHANGE_ENTRIES)} entries.`);
  }
  return {
    files,
    symlinkChanges: draft.symlinkChanges,
    createdDirectories: draft.createdDirectories,
    deletedDirectories,
    before,
    after,
  };
}
