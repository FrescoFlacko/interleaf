import { describe, expect, it } from 'vitest';
import {
  applyRefusalReason,
  assertNoSymlinkChanges,
  buildChangePlan,
  MAX_CHANGE_ENTRIES,
  type SnapshotEntry,
} from '@main/agents/environment-change-plan';
import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * The pure comparison behind environment review and Apply: what changed between
 * the frozen manifest and the workspace, and when Apply must refuse.
 */

const file = (path: string, hash: string, size = 160, mode = 0o644): SnapshotEntry => ({ path, type: 'file', mode, size, hash });
const directory = (path: string, mode = 0o755): SnapshotEntry => ({ path, type: 'directory', mode, size: 0, hash: null });
const link = (path: string, hash: string): SnapshotEntry => ({ path, type: 'symlink', mode: 0o777, size: 4, hash });

describe('buildChangePlan', () => {
  it('reports created, deleted and modified files in path order with bounded line estimates', () => {
    const plan = buildChangePlan(
      [file('b.txt', 'old', 800), file('gone.txt', 'x', 80), file('same.txt', 's')],
      [file('a.txt', 'new', 81), file('b.txt', 'changed', 160), file('same.txt', 's')],
    );
    expect(plan.files).toEqual([
      { path: 'a.txt', kind: 'created', additions: 2, deletions: 0, bytes: 81 },
      { path: 'b.txt', kind: 'modified', additions: 2, deletions: 10, bytes: 160 },
      { path: 'gone.txt', kind: 'deleted', additions: 0, deletions: 1, bytes: 80 },
    ]);
    expect(plan.symlinkChanges).toEqual([]);
  });

  it('diverts every link change and never treats it as a file change', () => {
    const plan = buildChangePlan([link('l', 'a'), link('kept', 'k')], [link('l', 'b'), link('kept', 'k'), link('new', 'n')]);
    expect(plan.files).toEqual([]);
    expect(plan.symlinkChanges.map((change) => [change.path, change.kind])).toEqual([['l', 'modified'], ['new', 'created']]);
    expect(() => { assertNoSymlinkChanges(plan); }).toThrow(InterleafError);
  });

  it('tracks directories separately and drops children of a directory replaced by a file', () => {
    const plan = buildChangePlan(
      [directory('src'), file('src/a.ts', '1'), directory('old'), directory('mode')],
      [file('src', 'now-a-file'), directory('fresh'), directory('mode', 0o700)],
    );
    expect(plan.files).toEqual([
      { path: 'mode', kind: 'modified', additions: 0, deletions: 0, bytes: 0 },
      { path: 'src', kind: 'modified', additions: 2, deletions: 1, bytes: 160 },
    ]);
    expect(plan.createdDirectories).toEqual(['fresh']);
    expect(plan.deletedDirectories).toEqual(['old']);
  });

  it('refuses a change set beyond the bound', () => {
    const after = Array.from({ length: MAX_CHANGE_ENTRIES + 1 }, (_, index) => file(`f${String(index)}`, 'h'));
    expect(() => buildChangePlan([], after)).toThrow(/bounded limit/u);
  });
});

describe('applyRefusalReason', () => {
  const clean = buildChangePlan([file('a', '1')], [file('a', '2')]);
  const linked = buildChangePlan([], [link('l', 'x')]);

  it('allows only an isolated, clean environment without link changes', () => {
    expect(applyRefusalReason({ mode: 'isolated-worktree', primaryWasDirty: false }, clean)).toBeNull();
    expect(applyRefusalReason({ mode: 'active-env', primaryWasDirty: false }, clean)).toMatch(/Direct workspace/u);
    expect(applyRefusalReason({ mode: 'native-restricted', primaryWasDirty: false }, clean)).toMatch(/Direct workspace/u);
    expect(applyRefusalReason({ mode: 'isolated-worktree', primaryWasDirty: true }, clean)).toMatch(/uncommitted/u);
    expect(applyRefusalReason({ mode: 'isolated-copy', primaryWasDirty: false }, linked)).toMatch(/symbolic link/u);
  });
});
