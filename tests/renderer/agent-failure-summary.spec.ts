import { describe, expect, it } from 'vitest';
import type { NormalizedAgentActivity } from '../../src/renderer/features/agent/agent-activity';
import { agentFailureSummary } from '../../src/renderer/features/agent/agent-failure-summary';

const started = (id: string): NormalizedAgentActivity => ({ kind: 'lifecycle', id, eventType: 'started' });

describe('agent failure summary', () => {
  it('prefers the run error over the exit code and bounds it', () => {
    const summary = agentFailureSummary([
      started('s'),
      { kind: 'error', id: 'e', message: `  ${'x'.repeat(500)}  ` },
      { kind: 'lifecycle', id: 'end', eventType: 'ended', exitCode: 1 },
    ]);
    expect(summary.reason).toHaveLength(200);
    expect(summary.reason.endsWith('…')).toBe(true);
    expect(summary.exitCode).toBe(1);
  });

  it('names a signal, then falls back to a plain sentence', () => {
    expect(agentFailureSummary([started('s'), { kind: 'lifecycle', id: 'end', eventType: 'ended', exitCode: null, signal: 'SIGKILL' }]).reason)
      .toBe('The agent was stopped by SIGKILL.');
    expect(agentFailureSummary([]).reason).toBe('The agent stopped before it finished.');
  });

  it('does not repeat a stderr line that is already the reason', () => {
    const summary = agentFailureSummary([
      started('s'),
      { kind: 'log', id: 'l', stream: 'stderr', text: 'auth failed\n' },
      { kind: 'error', id: 'e', message: 'auth failed' },
    ]);
    expect(summary.reason).toBe('auth failed');
    expect(summary.lastStderr).toBeNull();
  });

  it('ignores stdout and earlier runs', () => {
    const summary = agentFailureSummary([
      started('a'),
      { kind: 'log', id: 'l1', stream: 'stderr', text: 'first run' },
      started('b'),
      { kind: 'log', id: 'l2', stream: 'stdout', text: 'not an error' },
    ]);
    expect(summary.lastStderr).toBeNull();
  });
});
