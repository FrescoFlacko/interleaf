import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessRunner } from '@main/agents/process-runner';
import { AgentRegistry } from '@main/agents/agent-adapter';
import { testAgentRegistryOptions } from '../helpers/agent-collaborators';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-agent-cli.mjs');

/** A fake `--sleep --ignore-termination` child never exits on its own within
 * the test window, so each run proves there is no total runtime deadline and
 * ends through explicit cancellation only. */
describe('Agent run lifetime has no total timeout', () => {
  it('runs a process without a total timeout until it is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const runner = new ProcessRunner();
      const handle = runner.run({ file: process.execPath, args: [fixture, '--sleep', '--ignore-termination'], cwd: process.cwd() });
      const events: string[] = [];
      const consume = (async () => { for await (const event of handle.events) events.push(JSON.stringify(event)); })();
      // Far past the former built-in 15-minute deadline and the former
      // 30-second fixture deadline: neither may fire anymore.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(events.some((text) => text.includes('timed out'))).toBe(false);
      handle.cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      await consume;
      await expect(handle.completion).resolves.toBeUndefined();
      expect(events.some((text) => text.includes('"type":"cancelled"'))).toBe(true);
      expect(events.some((text) => text.includes('timed out'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a user adapter invocation alive past the former total timeout', async () => {
    vi.useFakeTimers();
    try {
      const registry = new AgentRegistry(testAgentRegistryOptions({ fakeFixtureBehavior: { sleep: true } }));
      registry.addFakeAdapter();
      const adapter = registry.getAdapter('fake');
      if (adapter === undefined) throw new Error('fake adapter was not registered');
      const run = adapter.start({ documentId: 'doc-runtime', profileId: 'fake', workingDirectoryHandle: '', executionMode: 'auto-isolated', prompt: 'unbounded run', canonicalWorkingDirectory: tmpdir(), model: null, contextPacket: null, riskConfirmation: null });
      const events: string[] = [];
      const consume = (async () => { for await (const event of run.events) events.push(JSON.stringify(event)); })();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(events.some((text) => text.includes('timed out'))).toBe(false);
      expect(events.some((text) => text.includes('"type":"ended"'))).toBe(false);
      run.cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      await consume;
      expect(events.some((text) => text.includes('"type":"cancelled"'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
