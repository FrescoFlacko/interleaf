import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types/agent';
import type { PortableRecord } from '@shared/models/portable';
import {
  isRawJsonStdout,
  normalizeAgentEvents,
  parseDiffLineCounts,
} from '../../src/renderer/features/agent/agent-activity';

const timestamp = '2026-08-26T18:00:00.000Z';

/** A structured `item.started`/`item.completed` envelope for session `s1`. */
function item(
  ordinal: number,
  phase: 'started' | 'completed',
  payload: PortableRecord,
  at = timestamp,
): AgentEvent {
  return { sessionId: 's1', ordinal, type: 'structured', data: { type: `item.${phase}`, item: payload }, timestamp: at };
}

function structured(ordinal: number, data: PortableRecord, at = timestamp): AgentEvent {
  return { sessionId: 's1', ordinal, type: 'structured', data, timestamp: at };
}

function started(ordinal: number, at = timestamp): AgentEvent {
  return { sessionId: 's1', ordinal, type: 'started', timestamp: at };
}

function ended(ordinal: number, at = timestamp): AgentEvent {
  return { sessionId: 's1', ordinal, type: 'ended', exitCode: 0, signal: null, timestamp: at };
}

describe('agent-activity normalizer and parsers', () => {
  describe('isRawJsonStdout', () => {
    it('detects valid JSON envelopes', () => {
      expect(isRawJsonStdout('{"type":"thread.started","thread_id":"123"}')).toBe(true);
      expect(isRawJsonStdout('  { "item": { "type": "agent_message" } }  ')).toBe(true);
      expect(isRawJsonStdout('{"files":["a.txt","b.txt"]}')).toBe(true);
    });

    it('rejects plain text and non-JSON stdout', () => {
      expect(isRawJsonStdout('Compiling TypeScript...')).toBe(false);
      expect(isRawJsonStdout('Done in 1.42s')).toBe(false);
      expect(isRawJsonStdout('{ unclosed json')).toBe(false);
      expect(isRawJsonStdout('')).toBe(false);
    });
  });

  describe('parseDiffLineCounts', () => {
    it('computes additions and deletions from unified diff chunks, ignoring +++/--- headers', () => {
      const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,6 @@
 unchanged line
-old line 1
-old line 2
+new line 1
+new line 2
+new line 3
 unchanged line`;

      expect(parseDiffLineCounts(diff)).toEqual({ additions: 3, deletions: 2 });
      expect(parseDiffLineCounts(`--- a/test.py\n+++ b/test.py\n@@ -10,2 +10,3 @@\n-x = 1\n+x = 2\n+y = 3`))
        .toEqual({ additions: 2, deletions: 1 });
    });

    it('returns null for empty or non-diff text', () => {
      expect(parseDiffLineCounts('')).toBeNull();
      expect(parseDiffLineCounts('Just some plain text without diff markers')).toBeNull();
    });
  });

  describe('normalizeAgentEvents', () => {
    it('hides protocol plumbing events such as thread.started, turn.started, and turn.completed', () => {
      expect(normalizeAgentEvents([
        started(0),
        structured(1, { type: 'thread.started', thread_id: 'thr_1' }),
        structured(2, { type: 'turn.started', turn_id: 'turn_1' }),
        structured(3, { type: 'turn.completed', turn_id: 'turn_1' }),
        ended(4),
      ])).toEqual([
        { kind: 'lifecycle', id: 'started-0', eventType: 'started', timestamp },
        { kind: 'lifecycle', id: 'ended-4', eventType: 'ended', exitCode: 0, signal: null, timestamp },
      ]);
    });

    it('suppresses raw JSON stdout lines while preserving plain text logs', () => {
      expect(normalizeAgentEvents([
        { sessionId: 's1', ordinal: 0, type: 'stdout', stream: 'stdout', text: '{"type":"thread.started"}', timestamp },
        { sessionId: 's1', ordinal: 1, type: 'stdout', stream: 'stdout', text: 'Running build verification step...', timestamp },
        { sessionId: 's1', ordinal: 2, type: 'stderr', stream: 'stderr', text: 'Warning: experimental flag used', timestamp },
      ])).toEqual([
        { kind: 'log', id: 'log-1', stream: 'stdout', text: 'Running build verification step...', timestamp },
        { kind: 'log', id: 'log-2', stream: 'stderr', text: 'Warning: experimental flag used', timestamp },
      ]);
    });

    it('extracts agent_message events as assistant progress messages', () => {
      expect(normalizeAgentEvents([
        item(1, 'started', { id: 'msg_1', type: 'agent_message', text: 'Analyzing repository structure...' }),
      ])).toEqual([{ kind: 'message', id: 'msg_1', text: 'Analyzing repository structure...', timestamp }]);
    });

    it('coalesces item.started and item.completed for command executions without duplicating steps', () => {
      expect(normalizeAgentEvents([
        item(1, 'started', { id: 'cmd_1', type: 'command_execution', command: 'npm test' }),
        item(2, 'completed', { id: 'cmd_1', type: 'command_execution', command: 'npm test', exit_code: 0, output: '10 tests passed' }),
      ])).toEqual([
        { kind: 'command', id: 'cmd_1', command: 'npm test', status: 'completed', exitCode: 0, output: '10 tests passed', timestamp },
      ]);
    });

    it('correctly flags failed command execution with non-zero exit code', () => {
      expect(normalizeAgentEvents([
        item(1, 'completed', { id: 'cmd_fail', type: 'command_execution', command: 'git status', exit_code: 128, output: 'fatal: not a git repo' }),
      ])).toEqual([
        { kind: 'command', id: 'cmd_fail', command: 'git status', status: 'failed', exitCode: 128, output: 'fatal: not a git repo', timestamp },
      ]);
    });

    it('renders file changes with truthful line counts or truthful status labels', () => {
      expect(normalizeAgentEvents([
        // Explicit additions and deletions, a unified diff, and no counts at all.
        item(1, 'completed', { id: 'fc_1', type: 'file_change', path: 'src/app.ts', status: 'modified', additions: 4, deletions: 5 }),
        item(2, 'completed', { id: 'fc_2', type: 'file_change', path: 'README.md', status: 'modified', diff: '@@ -1,2 +1,3 @@\n-old\n+new 1\n+new 2' }),
        item(3, 'completed', { id: 'fc_3', type: 'file_change', path: 'docs/guide.md', status: 'added' }),
      ])).toEqual([
        { kind: 'file_change', id: 'fc_1:src/app.ts', path: 'src/app.ts', status: 'modified', additions: 4, deletions: 5, timestamp },
        { kind: 'file_change', id: 'fc_2:README.md', path: 'README.md', status: 'modified', additions: 2, deletions: 1, timestamp },
        { kind: 'file_change', id: 'fc_3:docs/guide.md', path: 'docs/guide.md', status: 'added', additions: null, deletions: null, timestamp },
      ]);
    });

    it('renders todo changes into a structured checklist with progress states', () => {
      const todos = [
        { task: 'Inspect repository architecture', status: 'completed' },
        { task: 'Implement features', status: 'in_progress' },
        { task: 'Run full verification', status: 'pending' },
      ];
      expect(normalizeAgentEvents([item(1, 'completed', { id: 'todo_list_1', type: 'todo_list', todos })]))
        .toEqual([{ kind: 'todo_list', id: 'todo_list_1', todos, timestamp }]);
    });

    it('renders errors and final result reports clearly', () => {
      expect(normalizeAgentEvents([
        {
          sessionId: 's1',
          ordinal: 1,
          type: 'error',
          error: { __interleafError: true, code: 'internal', message: 'Process exited unexpectedly with code 1' },
          timestamp,
        },
        { sessionId: 's1', ordinal: 2, type: 'final', text: 'Successfully completed the task: all tests pass.', timestamp },
      ])).toEqual([
        { kind: 'error', id: 'error-1', message: 'Process exited unexpectedly with code 1', code: 'internal', timestamp },
        { kind: 'final', id: 'final-2', text: 'Successfully completed the task: all tests pass.', timestamp },
      ]);
    });

    it('handles exact Codex item.started/completed envelope with changes[] array and coalesces by parent id and child path', () => {
      expect(normalizeAgentEvents([
        item(1, 'started', {
          id: 'item_fc_99',
          type: 'file_change',
          changes: [{ path: '/workspace/README.md', kind: 'add' }, { path: '/workspace/src/app.ts', kind: 'update' }],
        }),
        item(2, 'completed', {
          id: 'item_fc_99',
          type: 'file_change',
          changes: [
            { path: '/workspace/README.md', kind: 'add' },
            { path: '/workspace/src/app.ts', kind: 'update', additions: 12, deletions: 3 },
          ],
        }),
      ])).toEqual([
        {
          kind: 'file_change', id: 'item_fc_99:/workspace/README.md', path: '/workspace/README.md',
          status: 'added', additions: null, deletions: null, timestamp,
        },
        {
          kind: 'file_change', id: 'item_fc_99:/workspace/src/app.ts', path: '/workspace/src/app.ts',
          status: 'modified', additions: 12, deletions: 3, timestamp,
        },
      ]);
    });

    it('handles exact Codex command_execution envelope with aggregated_output fallback and bounds', () => {
      const output = 'running 4 tests\ntest test_ok ... ok\ntest result: ok. 4 passed; 0 failed';
      expect(normalizeAgentEvents([
        item(1, 'started', { id: 'cmd_codex_1', type: 'command_execution', command: 'cargo test' }),
        item(2, 'completed', { id: 'cmd_codex_1', type: 'command_execution', command: 'cargo test', exit_code: 0, aggregated_output: output }),
      ])).toEqual([
        { kind: 'command', id: 'cmd_codex_1', command: 'cargo test', status: 'completed', exitCode: 0, output, timestamp },
      ]);
    });

    it('preserves both runs when a session is resumed and provider item IDs restart', () => {
      const ts1 = '2026-08-26T18:00:00.000Z';
      const ts2 = '2026-08-26T18:05:00.000Z';

      const run1Events: AgentEvent[] = [
        started(0, ts1),
        item(1, 'started', { id: 'item_0', type: 'agent_message', text: 'Run 1: Inspecting files' }, ts1),
        item(2, 'started', { id: 'item_1', type: 'command_execution', command: 'git status' }, ts1),
        item(3, 'completed', { id: 'item_1', type: 'command_execution', command: 'git status', exit_code: 0, output: 'On branch main' }, ts1),
        item(4, 'completed', { id: 'item_2', type: 'file_change', path: 'src/config.ts', additions: 5, deletions: 1 }, ts1),
        item(5, 'completed', { id: 'item_3', type: 'todo_list', todos: [{ task: 'Initial setup', status: 'completed' }] }, ts1),
        ended(6, ts1),
      ];

      // Run 2 (resumed turn) restarts provider IDs: item_0, item_1, item_2, item_3
      const run2Events: AgentEvent[] = [
        started(7, ts2),
        item(8, 'started', { id: 'item_0', type: 'agent_message', text: 'Run 2: Running tests' }, ts2),
        item(9, 'started', { id: 'item_1', type: 'command_execution', command: 'npm test' }, ts2),
        item(10, 'completed', { id: 'item_1', type: 'command_execution', command: 'npm test', exit_code: 0, output: '15 passed' }, ts2),
        item(11, 'completed', { id: 'item_2', type: 'file_change', path: 'src/config.ts', additions: 2, deletions: 0 }, ts2),
        item(12, 'completed', {
          id: 'item_3',
          type: 'todo_list',
          todos: [{ task: 'Initial setup', status: 'completed' }, { task: 'Verification', status: 'completed' }],
        }, ts2),
        ended(13, ts2),
      ];

      const activities = normalizeAgentEvents([...run1Events, ...run2Events]);

      // All items from Run 1 AND Run 2 must be present in the visible transcript,
      // with Run 2's restarted provider IDs prefixed by their run.
      expect(activities).toEqual([
        { kind: 'lifecycle', id: 'started-0', eventType: 'started', timestamp: ts1 },
        { kind: 'message', id: 'item_0', text: 'Run 1: Inspecting files', timestamp: ts1 },
        { kind: 'command', id: 'item_1', command: 'git status', status: 'completed', exitCode: 0, output: 'On branch main', timestamp: ts1 },
        { kind: 'file_change', id: 'item_2:src/config.ts', path: 'src/config.ts', status: 'modified', additions: 5, deletions: 1, timestamp: ts1 },
        { kind: 'todo_list', id: 'item_3', todos: [{ task: 'Initial setup', status: 'completed' }], timestamp: ts1 },
        { kind: 'lifecycle', id: 'ended-6', eventType: 'ended', exitCode: 0, signal: null, timestamp: ts1 },
        { kind: 'lifecycle', id: 'started-7', eventType: 'started', timestamp: ts2 },
        { kind: 'message', id: 'r1:item_0', text: 'Run 2: Running tests', timestamp: ts2 },
        { kind: 'command', id: 'r1:item_1', command: 'npm test', status: 'completed', exitCode: 0, output: '15 passed', timestamp: ts2 },
        { kind: 'file_change', id: 'r1:item_2:src/config.ts', path: 'src/config.ts', status: 'modified', additions: 2, deletions: 0, timestamp: ts2 },
        { kind: 'todo_list', id: 'r1:item_3', todos: [{ task: 'Initial setup', status: 'completed' }, { task: 'Verification', status: 'completed' }], timestamp: ts2 },
        { kind: 'lifecycle', id: 'ended-13', eventType: 'ended', exitCode: 0, signal: null, timestamp: ts2 },
      ]);

      // Verify all activity IDs are unique for stable React keys
      expect(new Set(activities.map((a) => a.id)).size).toBe(activities.length);
    });

    it('correctly isolates structured turn.started boundaries within a single run', () => {
      expect(normalizeAgentEvents([
        started(0),
        structured(1, { type: 'turn.started', turn_id: 't1' }),
        item(2, 'completed', { id: 'item_0', type: 'agent_message', text: 'Turn 1 thought' }),
        structured(3, { type: 'turn.completed', turn_id: 't1' }),
        structured(4, { type: 'turn.started', turn_id: 't2' }),
        item(5, 'completed', { id: 'item_0', type: 'agent_message', text: 'Turn 2 thought' }),
        ended(6),
      ])).toEqual([
        { kind: 'lifecycle', id: 'started-0', eventType: 'started', timestamp },
        { kind: 'message', id: 'r0_t1:item_0', text: 'Turn 1 thought', timestamp },
        { kind: 'message', id: 'r0_t2:item_0', text: 'Turn 2 thought', timestamp },
        { kind: 'lifecycle', id: 'ended-6', eventType: 'ended', exitCode: 0, signal: null, timestamp },
      ]);
    });
  });
});
