import { describe, expect, it } from 'vitest';
import type { NormalizedAgentActivity } from '../../src/renderer/features/agent/agent-activity';
import { groupRepeatedErrors } from '../../src/renderer/features/agent/agent-activity-groups';

/**
 * Folding repeated failures is only safe while the folded rows really are the
 * same failure. These cases fix that line: a retry that differs solely in its
 * log timestamp or spacing is one failure, while anything that differs in a
 * status code, an exit code, an offset or a path stays visible on its own row.
 */
function error(id: string, message: string, code?: string): NormalizedAgentActivity {
  return { kind: 'error', id, message, ...(code === undefined ? {} : { code }) };
}

function shapes(activities: readonly NormalizedAgentActivity[]): readonly string[] {
  return groupRepeatedErrors(activities).map((entry) =>
    entry.kind === 'single' ? 'single' : `group:${String(entry.errors.length)}`
  );
}

describe('groupRepeatedErrors', () => {
  it('groups retries that differ only in a leading ISO timestamp', () => {
    const entries = groupRepeatedErrors([
      error('e1', '2026-09-08T10:00:01.000Z connection reset by peer'),
      error('e2', '2026-09-08T10:00:07.512Z connection reset by peer'),
      error('e3', '[2026-09-08 10:00:19] connection reset by peer'),
    ]);

    expect(entries).toHaveLength(1);
    const [group] = entries;
    expect(group?.kind).toBe('error_group');
    if (group?.kind !== 'error_group') throw new Error('expected a group');
    expect(group.errors).toHaveLength(3);
    // The row shows a real message, never the normalized signature.
    expect(group.message).toBe('2026-09-08T10:00:01.000Z connection reset by peer');
  });

  it('groups retries that differ only in whitespace', () => {
    expect(shapes([
      error('e1', 'transport error:  connection reset'),
      error('e2', 'transport error: connection reset'),
    ])).toEqual(['group:2']);
  });

  it('keeps different HTTP status codes apart', () => {
    expect(shapes([
      error('e1', 'request failed with HTTP 401'),
      error('e2', 'request failed with HTTP 503'),
    ])).toEqual(['single', 'single']);
  });

  it('keeps different exit codes, offsets and numbered paths apart', () => {
    expect(shapes([
      error('e1', 'command failed with exit code 1'),
      error('e2', 'command failed with exit code 137'),
    ])).toEqual(['single', 'single']);
    expect(shapes([
      error('e1', 'unexpected token at byte offset 128'),
      error('e2', 'unexpected token at byte offset 4096'),
    ])).toEqual(['single', 'single']);
    expect(shapes([
      error('e1', 'cannot read src/chunk-01.ts'),
      error('e2', 'cannot read src/chunk-02.ts'),
    ])).toEqual(['single', 'single']);
  });

  it('keeps a retry counter visible because it is not equivalent text', () => {
    expect(shapes([
      error('e1', 'connection reset (attempt 1)'),
      error('e2', 'connection reset (attempt 2)'),
    ])).toEqual(['single', 'single']);
  });

  it('separates identical messages carrying different error codes', () => {
    expect(shapes([
      error('e1', 'provider rejected the request', 'validation'),
      error('e2', 'provider rejected the request', 'internal'),
    ])).toEqual(['single', 'single']);
  });

  it('only folds consecutive runs and leaves other activities in place', () => {
    expect(shapes([
      error('e1', 'connection reset'),
      error('e2', 'connection reset'),
      { kind: 'message', id: 'm1', text: 'retrying' },
      error('e3', 'connection reset'),
    ])).toEqual(['group:2', 'single', 'single']);
  });
});
