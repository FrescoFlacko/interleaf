import { describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProcessCleanupUnknownError, ProcessRunner, parseStructuredAgentLine, buildMinimalChildEnvironment, buildProcessRedactionValues, buildWindowsTaskkillArgs, resolveWindowsTaskkillExecutable, type ProcessRunnerOptions, type ProcessRunnerRequest, type ProcessSpawner } from '@main/agents/process-runner';
import { AsyncEventQueue } from '@main/agents/async-event-queue';
import { StreamRedactor } from '@main/agents/stream-redactor';
import { AgentRegistry, CliAgentAdapter } from '@main/agents/agent-adapter';
import { parseArgumentTemplate } from '@main/agents/custom-argv-template';
import type { MainAgentProfile } from '@main/agents/profile-types';
import { redactText } from '@main/agents/event-redaction';
import { buildCliSearchPath } from '@main/app/cli-search-path';
import type { AppSettings } from '@shared/schemas/settings';
import { TestChildProcess } from '../helpers/child-process';
import { adapterCollaborators, testAgentRegistryOptions } from '../helpers/agent-collaborators';

type ProfilePreference = NonNullable<AppSettings['agent']['profiles'][string]>;

const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-agent-cli.mjs');

async function collect(handle: ReturnType<ProcessRunner['run']>) {
  const events = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

async function collectUntilEnded(handle: ReturnType<ProcessRunner['run']>) {
  const events = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  while (events.length < 64) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === 'ended') break;
  }
  return events;
}

async function completionSettled(handle: ReturnType<ProcessRunner['run']>, waitMs = 20): Promise<boolean> {
  return Promise.race([
    handle.completion.then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, waitMs); }),
  ]);
}

/**
 * A child that records kill signals without acting on them, so a test can
 * observe the runner's escalation sequence instead of the child's reaction.
 */
function fakeChild(pid: number): { readonly child: TestChildProcess; readonly killSignals: (NodeJS.Signals | number)[] } {
  const child = new TestChildProcess({ pid });
  child.killFails = true;
  return { child, killSignals: child.killSignals };
}

function spawningChild(child: TestChildProcess): ProcessSpawner {
  return () => child;
}

/** Runs a fixture as a simulated Windows child whose tree helper is scripted by `options`. */
function runOnWindows(child: TestChildProcess, options: Omit<ProcessRunnerOptions, 'platform' | 'spawnProcess'>, strictCleanup = false) {
  return new ProcessRunner({ platform: 'win32', windowsTerminationGraceMs: 0, spawnProcess: spawningChild(child), ...options })
    .run({ file: 'fixture', args: [], cwd: 'C:\\workspace', timeoutMs: 10_000, strictCleanup });
}

/** A spawner whose pid-less child runs `script` against its pipes, then ends them and closes cleanly. */
function scriptedSpawner(script: (child: TestChildProcess) => void | Promise<void>, onSpawn?: (file: string, args: readonly string[], options: SpawnOptions) => void): ProcessSpawner {
  return (file, args, options) => {
    onSpawn?.(file, args, options);
    const child = new TestChildProcess({ pid: undefined });
    void (async () => {
      await Promise.resolve();
      await script(child);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
    })();
    return child;
  };
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

type QueueItem = { id?: number; type?: string; priority?: boolean; summary?: boolean; count?: number };

function priorityQueue(maxSize: number): AsyncEventQueue<QueueItem> {
  return new AsyncEventQueue<QueueItem>(maxSize, (count) => ({ summary: true, count }), (item) => item.priority === true);
}

async function drain(queue: AsyncEventQueue<QueueItem>): Promise<QueueItem[]> {
  queue.close();
  const drained: QueueItem[] = [];
  for await (const item of queue) drained.push(item);
  return drained;
}

describe('Phase 8 process runner foundation', () => {
  it('keeps shell metacharacters inert argv data and parses fixture streams', async () => {
    const runner = new ProcessRunner();
    const uniquePath = `/tmp/interleaf-shell-inert-${randomUUID()}`;
    expect(existsSync(uniquePath)).toBe(false);
    const events = await collect(runner.run({ file: process.execPath, args: [fixture, `$(touch ${uniquePath})`, ';', 'echo', 'safe'], cwd: process.cwd(), timeoutMs: 10_000 }));
    expect(events.some((event) => event.type === 'stdout' && event.text.includes(`$(touch ${uniquePath})`))).toBe(true);
    expect(existsSync(uniquePath)).toBe(false);
    expect(events.some((event) => event.type === 'stderr')).toBe(true);
    expect(events.some((event) => event.type === 'structured')).toBe(true);
    const ended = events.findLast((event) => event.type === 'ended');
    expect(ended?.type).toBe('ended');
    expect(ended?.type === 'ended' ? ended.exitCode : null).toBe(0);
  });

  it('reports non-zero fixture exits and cancellation explicitly', async () => {
    const runner = new ProcessRunner();
    const failed = await collect(runner.run({ file: process.execPath, args: [fixture, '--fail'], cwd: process.cwd(), timeoutMs: 10_000 }));
    const failedEnd = failed.findLast((event) => event.type === 'ended');
    expect(failedEnd?.type === 'ended' ? failedEnd.exitCode : null).toBe(7);

    const cancelledHandle = runner.run({ file: process.execPath, args: [fixture, '--sleep', '--ignore-termination'], cwd: process.cwd(), timeoutMs: 10_000 });
    setTimeout(() => { cancelledHandle.cancel(); }, 40);
    const cancelled = await collect(cancelledHandle);
    expect(cancelled.some((event) => event.type === 'cancelled')).toBe(true);
  });

  it('uses an absolute taskkill path and exact tree-termination argv on Windows, with idempotent cancellation', async () => {
    expect(resolveWindowsTaskkillExecutable(undefined)).toBeNull();
    expect(resolveWindowsTaskkillExecutable('Windows')).toBeNull();
    expect(buildWindowsTaskkillArgs(88, false)).toEqual(['/PID', '88', '/T']);
    expect(buildWindowsTaskkillArgs(88, true)).toEqual(['/PID', '88', '/T', '/F']);
    expect(() => buildWindowsTaskkillArgs(0, false)).toThrow();
    const spawned = fakeChild(4242);
    const commands: { readonly executable: string; readonly args: readonly string[] }[] = [];
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows',
      windowsTaskkill: (executable, args) => {
        commands.push({ executable, args });
        if (args.includes('/F')) queueMicrotask(() => { spawned.child.emit('close', 0, null); });
        return Promise.resolve(true);
      },
    });
    const eventsPromise = collect(handle);
    handle.cancel();
    handle.cancel();
    const events = await eventsPromise;
    await handle.completion;
    expect(commands).toEqual([
      { executable: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4242', '/T'] },
      { executable: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'] },
    ]);
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'ended')).toBe(true);
  });

  it('accepts graceful tree termination when the child closes during the grace window', async () => {
    const spawned = fakeChild(4747);
    const commands: string[][] = [];
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows', windowsTerminationGraceMs: 20,
      windowsTaskkill: (_executable, args) => {
        commands.push([...args]);
        if (!args.includes('/F')) setTimeout(() => { spawned.child.emit('close', 0, null); }, 5);
        return Promise.resolve(true);
      },
    });
    handle.cancel();
    const events = await collect(handle);
    await handle.completion;
    expect(commands).toEqual([['/PID', '4747', '/T']]);
    expect(events.some((event) => event.type === 'ended')).toBe(true);
  });

  it('escalates after graceful helper failure without rejected termination promises', async () => {
    const spawned = fakeChild(5151);
    const stages: string[][] = [];
    spawned.child.exitOnSignal = 'SIGKILL';
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows',
      windowsTaskkill: (_executable, args) => { stages.push([...args]); return Promise.resolve(false); },
    });
    handle.cancel();
    await collectUntilEnded(handle);
    expect(await completionSettled(handle)).toBe(false);
    expect(stages).toEqual([['/PID', '5151', '/T'], ['/PID', '5151', '/T', '/F']]);
    expect(spawned.killSignals).toContain('SIGKILL');
  });

  it('fails closed when SystemRoot is missing and waits for fallback child close', async () => {
    const spawned = fakeChild(6262);
    spawned.child.exitOnSignal = 'SIGKILL';
    let helperCalls = 0;
    const handle = runOnWindows(spawned.child, { windowsTaskkill: () => { helperCalls += 1; return Promise.resolve(true); } });
    handle.cancel();
    const events = await collectUntilEnded(handle);
    const completed = await completionSettled(handle);
    expect(helperCalls).toBe(0);
    expect(spawned.killSignals).toContain('SIGTERM');
    expect(spawned.killSignals).toContain('SIGKILL');
    expect(events.some((event) => event.type === 'error' && event.message.includes('helper is unavailable'))).toBe(true);
    expect(completed).toBe(false);
  });

  it('forces tree termination when the child remains open through the grace window', async () => {
    const spawned = fakeChild(7373);
    let forceStarted = false;
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows', windowsTerminationGraceMs: 20,
      windowsTaskkill: (_executable, args) => {
        if (args.includes('/F')) {
          forceStarted = true;
          queueMicrotask(() => { spawned.child.emit('close', 0, null); });
        }
        return Promise.resolve(true);
      },
    });
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    const eventsPromise = collect(handle);
    handle.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(forceStarted).toBe(false);
    await eventsPromise;
    await handle.completion;
    expect(forceStarted).toBe(true);
  });

  it('bounds hung Windows helpers and remains fail-closed when tree state is unknown', async () => {
    const spawned = fakeChild(9595);
    spawned.child.exitOnSignal = 'SIGKILL';
    const stages: string[][] = [];
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows', windowsTaskkillTimeoutMs: 5,
      windowsTaskkill: (_executable, args) => {
        stages.push([...args]);
        return new Promise<boolean>(() => undefined);
      },
    });
    handle.cancel();
    const events = await collectUntilEnded(handle);
    const completed = await completionSettled(handle);
    expect(events.some((event) => event.type === 'ended')).toBe(true);
    expect(stages).toEqual([['/PID', '9595', '/T'], ['/PID', '9595', '/T', '/F']]);
    expect(spawned.killSignals).toContain('SIGKILL');
    expect(completed).toBe(false);
  });

  it.each([
    { label: 'unavailable', pid: 6363, options: { windowsTaskkill: () => Promise.resolve(true) }, messages: ['could not be verified'] },
    { label: 'failed', pid: 6464, options: { systemRoot: 'C:\\Windows', windowsTaskkill: () => Promise.resolve(false) }, messages: ['helper failed', 'could not be verified'] },
  ])('rejects a strict run when the Windows tree helper is $label and stays unverified', async ({ pid, options, messages }) => {
    const spawned = fakeChild(pid);
    spawned.child.exitOnSignal = 'SIGKILL';
    const handle = runOnWindows(spawned.child, options, true);
    handle.cancel();
    const eventsPromise = collect(handle);
    await expect(handle.completion).rejects.toBeInstanceOf(ProcessCleanupUnknownError);
    const events = await eventsPromise;
    for (const message of messages) expect(events.some((event) => event.type === 'error' && event.message.includes(message))).toBe(true);
  });

  it('resolves a strict run once tree termination is genuinely verified', async () => {
    const spawned = fakeChild(6565);
    const handle = runOnWindows(spawned.child, {
      systemRoot: 'C:\\Windows', windowsTerminationGraceMs: 20,
      windowsTaskkill: (_executable, args) => {
        if (!args.includes('/F')) setTimeout(() => { spawned.child.emit('close', 0, null); }, 5);
        return Promise.resolve(true);
      },
    }, true);
    handle.cancel();
    const eventsPromise = collect(handle);
    await handle.completion;
    const events = await eventsPromise;
    expect(events.some((event) => event.type === 'error' && event.message.includes('could not be verified'))).toBe(false);
  });

  it('records an unknown tree at the reap deadline instead of claiming the group was reaped, only under the strict policy', async () => {
    const realKill = process.kill;
    // A never-exiting fake group: `process.kill(-pid, 0)` keeps reporting the
    // group present for the whole run, so the bounded reap window really does
    // close with the group still alive. Escalation signals are accepted as
    // delivered; real pids go to the real kill.
    process.kill = (pid: number, signal?: string | number): true => {
      if (pid < 0) return true;
      return realKill(pid, signal);
    };
    try {
      const spawnedStrict = fakeChild(77_001);
      const strictHandle = new ProcessRunner({ spawnProcess: spawningChild(spawnedStrict.child), timeoutMs: 10_000 })
        .run({ file: 'fixture', args: [], cwd: process.cwd(), strictCleanup: true });
      const spawnedOrdinary = fakeChild(77_002);
      const ordinaryHandle = new ProcessRunner({ spawnProcess: spawningChild(spawnedOrdinary.child), timeoutMs: 10_000 })
        .run({ file: 'fixture', args: [], cwd: process.cwd() });
      strictHandle.cancel();
      ordinaryHandle.cancel();
      const strictEvents = collect(strictHandle);
      const ordinaryEvents = collect(ordinaryHandle);
      await expect(strictHandle.completion).rejects.toBeInstanceOf(ProcessCleanupUnknownError);
      const strict = await strictEvents;
      expect(strict.some((event) => event.type === 'error' && event.message.includes('termination could not be proven'))).toBe(true);
      // The ordinary path is unchanged: the same unknown state still settles
      // the run after its bounded window instead of hanging or rejecting.
      await ordinaryHandle.completion;
      const ordinary = await ordinaryEvents;
      expect(ordinary.some((event) => event.type === 'error' && event.message.includes('termination could not be proven'))).toBe(false);
    } finally {
      process.kill = realKill;
    }
  }, 15_000);

  it('does not resolve completion until a stubborn child is reaped after escalation', async () => {
    const runner = new ProcessRunner();
    const handle = runner.run({ file: process.execPath, args: [fixture, '--sleep', '--ignore-termination'], cwd: process.cwd(), timeoutMs: 10_000 });
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    const iterator = handle.events[Symbol.asyncIterator]();
    const events = [];
    // Cancel only once the child has proven its SIGTERM handler is installed.
    // A fixed startup delay raced with Node's own boot time: cancelling too
    // early let the default disposition terminate the child, so completion
    // settled immediately and the escalation path below was never exercised.
    let stderrText = '';
    while (!stderrText.includes('fixture ready: ignoring termination')) {
      const next = await iterator.next();
      if (next.done === true) throw new Error('fixture exited before reporting termination readiness');
      events.push(next.value);
      if (next.value.type === 'stderr') stderrText += next.value.text;
    }
    expect(completed).toBe(false);
    handle.cancel();
    // SIGTERM is ignored, so the run must stay unsettled across the runner's
    // 2s escalation window rather than completing on the termination request.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      events.push(next.value);
    }
    await handle.completion;
    expect(completed).toBe(true);
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.findLast((event) => event.type === 'ended')).toBeDefined();
  }, 10_000);

  it('escalates the whole process group after the direct parent exits', async () => {
    const runner = new ProcessRunner();
    const pidRoot = await mkdtemp(join(tmpdir(), 'interleaf-stubborn-pid-'));
    const pidFile = join(pidRoot, 'descendant.pid');
    const handle = runner.run({ file: process.execPath, args: [fixture, '--fork-stubborn'], cwd: process.cwd(), env: { STUBBORN_PID_FILE: pidFile }, timeoutMs: 10_000 });
    const eventsPromise = collect(handle);
    const pidDeadline = Date.now() + 1_000;
    while (!existsSync(pidFile) && Date.now() < pidDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = Number(await readFile(pidFile, 'utf8'));
    handle.cancel();
    const events = await eventsPromise;
    expect(events.findLast((event) => event.type === 'ended')).toBeDefined();
    await handle.completion;
    let alive = true;
    const deadline = Date.now() + 2_000;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw error;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive).toBe(false);
    await rm(pidRoot, { recursive: true, force: true });
  }, 10_000);

  it('does not derive trusted fake fixture flags from prompt text', async () => {
    const capture: { args?: readonly string[] } = {};
    const registry = new AgentRegistry(testAgentRegistryOptions({ processRunner: new ProcessRunner(scriptedSpawner(() => undefined, (_file, args) => { capture.args = args; })) }));
    registry.addFakeAdapter();
    const adapter = registry.getAdapter('fake');
    if (adapter === undefined) throw new Error('fake adapter was not installed');
    const run = adapter.start({ documentId: 'doc-runtime', profileId: 'fake', workingDirectoryHandle: 'fixture-handle', executionMode: 'isolated-copy', prompt: '[fixture:sleep] must remain inert', canonicalWorkingDirectory: process.cwd(), model: null, contextPacket: null, riskConfirmation: null });
    await run.completion;
    expect(capture.args).toEqual([fixture, '--read-stdin', '--mutate-workspace']);
  });

  it('keeps partial JSON and split UTF-8 valid, closes stdin, and never inherits secrets', async () => {
    const runner = new ProcessRunner();
    const previous = process.env.INTERLEAF_SECRET;
    process.env.INTERLEAF_SECRET = 'must-not-cross-process-boundary';
    try {
      const events = await collect(runner.run({
        file: process.execPath,
        args: [fixture, '--partial-json', '--unicode', '--read-stdin', 'prompt-data'],
        cwd: process.cwd(),
        stdin: 'stdin-delivery',
        timeoutMs: 10_000,
      }));
      expect(events.some((event) => event.type === 'structured' && event.data.type === 'partial')).toBe(true);
      expect(events.some((event) => event.type === 'structured' && event.data.type === 'second')).toBe(true);
      expect(events.some((event) => event.type === 'stdout' && event.text.includes('😀'))).toBe(true);
      expect(events.some((event) => event.type === 'stdout' && event.text.includes('stdin-delivery'))).toBe(true);

      const envEvents = await collect(runner.run({ file: process.execPath, args: [fixture, '--env-check'], cwd: process.cwd(), timeoutMs: 10_000 }));
      expect(envEvents.some((event) => event.type === 'stdout' && event.text.includes('env:unset'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.INTERLEAF_SECRET;
      else process.env.INTERLEAF_SECRET = previous;
    }
  });

  it('keeps workspace, executable, HOME, and PATH values visible in child output', async () => {
    const runner = new ProcessRunner();
    const events = await collect(runner.run({ file: process.execPath, args: [fixture, '--echo-path-context'], cwd: process.cwd(), timeoutMs: 10_000 }));
    const serialized = JSON.stringify(events);
    const pathComponent = (process.env.PATH ?? '').split(delimiter)[0] ?? '';
    for (const visible of [process.cwd(), process.execPath, process.env.HOME ?? '', process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '', pathComponent]) {
      if (visible.length > 0) expect(serialized).toContain(visible);
    }
    expect(events.some((event) => event.type === 'structured' && event.data.cwd === process.cwd())).toBe(true);
    expect(serialized).not.toContain('[REDACTED]');
  });

  it('quarantines short path values and redacts short generic values', () => {
    const redacted = redactText('cwd=/ file=/a home=C:\\ temp=/ path=/a lang=C', [
      { value: '/', kind: 'path' },
      { value: '/a', kind: 'path' },
      { value: 'C:\\', kind: 'path' },
      { value: 'C', kind: 'generic' },
    ]);
    expect(redacted).toBe('[REDACTED]');
    expect(redactText('spawn failed: /a', [{ value: '/a', kind: 'path' }])).toBe('[REDACTED]');
    expect(redactText('ordinary letter C and lang=C', [{ value: 'C', kind: 'generic' }])).toBe('ordinary letter [REDACTED] and lang=[REDACTED]');
  });

  it('matches Windows path provenance case-insensitively without changing POSIX case semantics', () => {
    expect(redactText('cwd=c:\\users/name', [{ value: 'C:\\Users\\Name', kind: 'path' }])).toBe('cwd=[REDACTED]');
    expect(redactText('unc=//SERVER/share/Folder', [{ value: '\\\\server\\Share\\folder', kind: 'path' }])).toBe('unc=[REDACTED]');
    expect(redactText('cwd=c:/', [{ value: 'C:\\', kind: 'path' }])).toBe('[REDACTED]');
    expect(redactText('cwd=/case', [{ value: '/Case', kind: 'path' }])).toBe('cwd=/case');
    expect(redactText('cwd=/Case', [{ value: '/case', kind: 'path' }])).toBe('cwd=/Case');
  });

  it('registers only explicitly supplied secret values for a run', () => {
    const values = buildProcessRedactionValues({ redactValues: ['registered-secret'] });
    expect(redactText('echo registered-secret override-secret-value cwd=/workspace', values)).toBe('echo [REDACTED] override-secret-value cwd=/workspace');
  });

  it('holds quoted secret assignments across multiline stream chunks', () => {
    expect(redactText('password="alpha\nbeta"\r\nvisible')).toBe('password="[REDACTED]"\r\nvisible');
    expect(redactText("secret='alpha\nbeta\\'s'\nvisible")).toBe("secret='[REDACTED]'\nvisible");
    const directUnterminated = redactText(`password="alpha\n${'x'.repeat(70_000)}`);
    expect(directUnterminated).not.toContain('alpha');
    expect(directUnterminated).not.toContain('x'.repeat(100));

    const doubleQuoted = new StreamRedactor([]);
    const doubleOutput = [
      ...doubleQuoted.push('password="alpha\n'),
      ...doubleQuoted.push('beta"\r\nvisible\n'),
      ...doubleQuoted.finish(),
    ].join('');
    expect(doubleOutput).toBe('password="[REDACTED]"\r\nvisible\n');
    expect(doubleOutput).not.toContain('alpha');
    expect(doubleOutput).not.toContain('beta');

    const singleQuoted = new StreamRedactor([]);
    const singleOutput = [
      ...singleQuoted.push("secret='one\nits\\"),
      ...singleQuoted.push("' two'\nordinary\n"),
      ...singleQuoted.finish(),
    ].join('');
    expect(singleOutput).toBe("secret='[REDACTED]'\nordinary\n");
    expect(singleOutput).not.toContain('its');

    const ordinary = new StreamRedactor([]);
    expect(ordinary.push('first\nsecond\n')).toEqual(['first\n', 'second\n']);
  });

  it('quarantines an oversized unterminated multiline quoted assignment', () => {
    const redactor = new StreamRedactor([]);
    const output = redactor.push(`password="alpha\n${'x'.repeat(140_000)}`);
    expect(output.join('')).toContain('[REDACTED');
    expect(output.join('')).not.toContain('alpha');
    expect(redactor.finish()).toEqual([]);
  });

  it('keeps ambient child-environment values visible across chunk boundaries', async () => {
    const fakeSpawn = scriptedSpawner(({ stdout }) => {
      // Two writes in one tick still reach the redactor as two chunks.
      stdout.write('cwd=/ file=/a home=/');
      stdout.write(' temp=/ path=/a lang=C\n');
    });
    const events = await collect(new ProcessRunner(fakeSpawn).run({
      file: 'sh', args: [], cwd: '/a', timeoutMs: 10_000,
    }));
    const stdout = events.find((event) => event.type === 'stdout');
    expect(stdout?.type === 'stdout' ? stdout.text : '').toBe('cwd=/ file=/a home=/ temp=/ path=/a lang=C\n');
  });

  it('delivers the full bounded Unicode stdin and rejects oversized input before spawn', async () => {
    const runner = new ProcessRunner();
    const input = `${'λ😀'.repeat(4_000)}\nfull-input-marker`;
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThan(256 * 1024);
    const events = await collect(runner.run({ file: process.execPath, args: [fixture, '--read-stdin'], cwd: process.cwd(), stdin: input, timeoutMs: 10_000 }));
    expect(events.some((event) => event.type === 'stdout' && event.text.includes('full-input-marker'))).toBe(true);
    const oversized = collect(runner.run({ file: process.execPath, args: [fixture], cwd: process.cwd(), stdin: 'x'.repeat(256 * 1024 + 1), timeoutMs: 10_000 }));
    const rejected = await oversized;
    expect(rejected.some((event) => event.type === 'error' && event.message.includes('input exceeds'))).toBe(true);
  });

  it('bounds output, reports malformed/oversized lines as inert data, and times out', async () => {
    const runner = new ProcessRunner();
    const large = await collect(runner.run({ file: process.execPath, args: [fixture, '--large'], cwd: process.cwd(), timeoutMs: 10_000 }));
    expect(large.filter((event) => event.type === 'error' && event.message.includes('bounded runtime limit')).length).toBe(1);
    for (const event of large) if (event.type === 'stdout') expect(event.text.length).toBeLessThanOrEqual(65_536);
    expect(parseStructuredAgentLine(`{"too":"${'x'.repeat(70_000)}"}`)).toBeNull();

    const timed = await collect(runner.run({ file: process.execPath, args: [fixture, '--sleep'], cwd: process.cwd(), timeoutMs: 1_000 }));
    expect(timed.some((event) => event.type === 'error' && event.message.includes('timed out'))).toBe(true);
    expect(timed.findLast((event) => event.type === 'ended')).toBeDefined();
  }, 15_000);

  it('passes exact argv, cwd, shell:false, and an allowlisted environment to spawn', async () => {
    const capture: { value?: { file: string; args: readonly string[]; options: SpawnOptions } } = {};
    const fakeSpawn = scriptedSpawner(({ stdout }) => { stdout.write('ok\n'); }, (file, args, options) => { capture.value = { file, args, options }; });
    const events = await collect(new ProcessRunner(fakeSpawn).run({ file: 'safe-cli', args: ['$(touch', 'inert)', ';'], cwd: '/safe/workspace' }));
    const captured = capture.value;
    expect(captured).toBeDefined();
    if (captured === undefined) throw new Error('spawn was not called');
    expect(captured.file).toBe('safe-cli');
    expect(captured.args).toEqual(['$(touch', 'inert)', ';']);
    expect(captured.options).toMatchObject({ cwd: '/safe/workspace', shell: false });
    expect(captured.options.env?.INTERLEAF_SECRET).toBeUndefined();
    expect(events.some((event) => event.type === 'ended' && event.exitCode === 0)).toBe(true);
  });

  it('redacts explicitly registered values and credential-shaped nested event data before the event queue', async () => {
    const secret = 'registered-run-secret-8f3d2a1c';
    const fakeSpawn = scriptedSpawner(({ stdout, stderr }) => {
      stdout.write(`child says ${secret}\n`);
      stdout.write(`${JSON.stringify({ type: 'progress', token: secret, nested: { authorization: 'Bearer abc.def.ghi' } })}\n`);
      stderr.write(`api_key=${secret}\n`);
    });
    const events = await collect(new ProcessRunner(fakeSpawn).run({ file: 'fixture', args: [], cwd: process.cwd(), redactValues: [secret] }));
    expect(JSON.stringify(events)).not.toContain(secret);
    const structured = events.find((event) => event.type === 'structured');
    expect(structured?.type === 'structured' ? structured.data : null).toEqual({ type: 'progress', token: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
  });

  it('parses bounded raw JSON frames across chunk splits and bounds oversized lines', async () => {
    const frames = [
      JSON.stringify({ kind: 'changed-files', files: ['1.txt'], label: '1', count: 1, safeCount: 2 }),
      JSON.stringify({ kind: 'tests', status: 'passed', label: '1', count: 1, safeCount: 2 }),
      JSON.stringify({ kind: 'final', text: '1 final' }),
    ];
    const fakeSpawn = scriptedSpawner(async ({ stdout }) => {
      for (const frame of frames) {
        const split = Math.max(1, Math.floor(frame.length / 2));
        stdout.write(frame.slice(0, split));
        await nextTurn();
        stdout.write(`${frame.slice(split)}\n`);
      }
      stdout.write('{malformed-json}\n');
      stdout.write(`{"kind":"tests","payload":"${'x'.repeat(70_000)}"}\n`);
    });

    const events = await collect(new ProcessRunner(fakeSpawn).run({
      file: 'fixture', args: [], cwd: process.cwd(), timeoutMs: 10_000,
    }));
    const structured = events.filter((event): event is Extract<typeof event, { type: 'structured' }> => event.type === 'structured');
    expect(structured.map((event) => event.data.kind)).toEqual(['changed-files', 'tests', 'final']);
    expect(structured[0]?.data.files).toEqual(['1.txt']);
    expect(structured[0]?.data.count).toBe(1);
    expect(structured[0]?.data.safeCount).toBe(2);
    expect(structured[2]?.data.text).toBe('1 final');

    const visibleOutput = events
      .filter((event) => event.type === 'stdout' || event.type === 'stderr')
      .map((event) => event.type === 'stdout' || event.type === 'stderr' ? event.text : '')
      .join('');
    expect(visibleOutput).toContain('{malformed-json}');
    expect(visibleOutput).toContain('[REDACTED OVERSIZED LINE]');
    expect(events.some((event) => event.type === 'structured' && event.data.payload !== undefined)).toBe(false);
  });

  it('classifies raw discriminator fields into structured kinds on split frames', async () => {
    const frames = [
      JSON.stringify({ kind: 'tests', marker: 't', status: 'passed' }),
      JSON.stringify({ type: 'changed-files', marker: 'e', files: ['a.txt'] }),
      JSON.stringify({ kind: 'final', marker: 'a', text: 'a final' }),
    ];
    const fakeSpawn = scriptedSpawner(async ({ stdout }) => {
      for (const frame of frames) {
        stdout.write(frame.slice(0, 2));
        await nextTurn();
        stdout.write(`${frame.slice(2)}\n`);
      }
    });

    const events = await collect(new ProcessRunner(fakeSpawn).run({ file: 'fixture', args: [], cwd: process.cwd(), timeoutMs: 10_000 }));
    const structured = events.filter((event): event is Extract<typeof event, { type: 'structured' }> => event.type === 'structured');
    expect(structured.map((event) => event.structuredKind)).toEqual(['tests', 'changed-files', 'final']);
    expect(structured[0]?.data.marker).toBe('t');
    expect(structured[1]?.data.marker).toBe('e');
    expect(structured[2]?.data.text).toBe('a final');
  });


  it.each([
    ['path at offset 1', '/Users/alice/private-workspace', 1, 'path'],
    ['path at offset 2', '/Users/alice/private-workspace', 2, 'path'],
    ['path at the final cut', '/Users/alice/private-workspace', '/Users/alice/private-workspace'.length - 1, 'path'],
    ['environment at offset 1', 'INHERITED_ENV_SECRET_LONG_42f8', 1, 'generic'],
    ['environment at offset 2', 'INHERITED_ENV_SECRET_LONG_42f8', 2, 'generic'],
    ['environment at the final cut', 'INHERITED_ENV_SECRET_LONG_42f8', 'INHERITED_ENV_SECRET_LONG_42f8'.length - 1, 'generic'],
  ] as const)('fails closed for an unresolved %s at StreamRedactor EOF', (_label, secret, cut, kind) => {
    const redactor = new StreamRedactor([{ value: secret, kind }]);
    expect(redactor.pushFrames(secret.slice(0, cut))).toHaveLength(0);
    const terminal = redactor.finishFrames();
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.rawText).toBeNull();
    expect(terminal[0]?.redactedText).toBe('[REDACTED OVERSIZED LINE]\n');
  });

  it('keeps safe bounded StreamRedactor EOF text and parses no quarantined raw frame', () => {
    const redactor = new StreamRedactor([{ value: '/Users/alice/private-workspace', kind: 'path' }]);
    expect(redactor.pushFrames('safe EOF output')).toHaveLength(0);
    const terminal = redactor.finishFrames();
    expect(terminal).toEqual([{ rawText: 'safe EOF output', redactedText: 'safe EOF output' }]);
  });

  it('quarantines an explicitly registered secret prefix at ProcessRunner EOF', async () => {
    const secret = 'INHERITED_ENV_SECRET_LONG_42f8';
    const prefix = secret.slice(0, -1);
    const fakeSpawn = scriptedSpawner(async ({ stdout }) => {
      stdout.write(prefix);
      await nextTurn();
    });

    const events = await collect(new ProcessRunner(fakeSpawn).run({
      file: 'fixture', args: [], cwd: process.cwd(), redactValues: [secret], timeoutMs: 10_000,
    }));
    const stdout: string[] = [];
    for (const event of events) if (event.type === 'stdout') stdout.push(event.text);
    expect(stdout.some((text) => text === '[REDACTED OVERSIZED LINE]\n')).toBe(true);
    expect(stdout.join('')).not.toContain(prefix);
    expect(events.some((event) => event.type === 'structured')).toBe(false);
    expect(events.some((event) => event.type === 'ended')).toBe(true);
  });

  it('redacts bounded quoted values with spaces and authorization bearer credentials', () => {
    const text = 'password="hello world from a provider" secret=single-value authorization: Bearer bearer-value-123456789';
    const redacted = redactText(text);
    expect(redacted).toBe('password="[REDACTED]" secret=[REDACTED] authorization: [REDACTED]');
    expect(redacted).not.toContain('hello world from a provider');
    expect(redacted).not.toContain('bearer-value-123456789');
    const singleQuoted = redactText("client_secret='single quoted provider value'");
    expect(singleQuoted).toBe("client_secret='[REDACTED]'");
  });

  it('never emits split secrets, escaped assignments, multiline keys, or oversized no-newline output', async () => {
    const splitPrefix = 'split-secret-prefix-7f3a';
    const splitSuffix = 'split-secret-suffix-91b2';
    const escapedSecret = 'escaped\\"quote-secret-2c4d';
    const privateBody = 'PRIVATE-KEY-MATERIAL-8e6f';
    const oversizedFragment = 'oversized-no-newline-secret-a1b2';
    const fakeSpawn = scriptedSpawner(async ({ stdout }) => {
      stdout.write(`password="${splitPrefix}`);
      await nextTurn();
      stdout.write(`${splitSuffix}" suffix=visible\n`);
      stdout.write(`password="${escapedSecret}" auth=raw-auth-secret authentication: auth-secret\n`);
      stdout.write('-----BEGIN PRIVATE KEY-----\n');
      await nextTurn();
      stdout.write(`${privateBody}\n-----END PRIVATE KEY-----\n`);
      stdout.write(oversizedFragment.repeat(3_000));
    });
    const events = await collect(new ProcessRunner(fakeSpawn).run({ file: 'fixture', args: [], cwd: process.cwd() }));
    const serialized = JSON.stringify(events);
    for (const secret of [splitPrefix, splitSuffix, escapedSecret, privateBody, 'raw-auth-secret', 'auth-secret', oversizedFragment]) {
      expect(serialized).not.toContain(secret);
    }
    expect(events.some((event) => event.type === 'stdout' && event.text.includes('[REDACTED]'))).toBe(true);
    expect(events.some((event) => event.type === 'stdout' && event.text.includes('[REDACTED OVERSIZED LINE]'))).toBe(true);
  });

  it('emits exactly one started event during the lifecycle of a process run', async () => {
    const runner = new ProcessRunner();
    // Normal exit
    const normalEvents = await collect(runner.run({ file: process.execPath, args: [fixture], cwd: process.cwd(), timeoutMs: 10_000 }));
    const normalStarted = normalEvents.filter((event) => event.type === 'started');
    expect(normalStarted).toHaveLength(1);

    // Multi-chunk output
    const multiChunkEvents = await collect(runner.run({ file: process.execPath, args: [fixture, '--chunks'], cwd: process.cwd(), timeoutMs: 10_000 }));
    const multiStarted = multiChunkEvents.filter((event) => event.type === 'started');
    expect(multiStarted).toHaveLength(1);

    // Cancellation
    const cancelledHandle = runner.run({ file: process.execPath, args: [fixture, '--sleep'], cwd: process.cwd(), timeoutMs: 10_000 });
    setTimeout(() => { cancelledHandle.cancel(); }, 20);
    const cancelledEvents = await collect(cancelledHandle);
    const cancelledStarted = cancelledEvents.filter((event) => event.type === 'started');
    expect(cancelledStarted).toHaveLength(1);
  });
  it('maps persisted reasoning effort to strictly allowlisted provider CLI args', async () => {
    let capturedArgs: readonly string[] = [];
    const fakeRunner = ({
      run: (request: ProcessRunnerRequest) => {
        capturedArgs = request.args;
        return {
          runId: 'test-run',
          events: (async function* () { await Promise.resolve(); yield* []; })(),
          completion: Promise.resolve(),
          cancel: () => undefined,
        };
      },
    });
    const preference = (binary: ProfilePreference['binary'], args: string[], reasoningEffort: ProfilePreference['reasoningEffort'], defaultModel: string | null = null): ProfilePreference => ({
      binary, arguments: args, defaultModel, models: [], reasoningEffort, permissionMode: 'normal',
      sandboxMode: 'auto-isolated', workingDirectoryPolicy: 'select-per-run', environmentOverrides: [],
    });

    const registry = new AgentRegistry(testAgentRegistryOptions({ processRunner: fakeRunner }));
    await registry.detect();
    // The legacy Copilot preference is covered by copilot-not-offered.spec.ts.
    registry.applyProfileSettings({
      codex: { ...preference('codex', ['exec', '--json', '--sandbox', 'workspace-write'], 'low'), permissionMode: 'workspace-write' },
      'claude-code': preference('claude', ['--print', '--output-format', 'stream-json', '--verbose'], 'xhigh'),
      antigravity: preference('agy', ['--print', '--output-format', 'stream-json'], 'medium'),
      opencode: preference('opencode', ['run', '--format', 'json'], 'max'),
      cursor: preference('cursor-agent', ['--print', '--output-format', 'stream-json'], null, 'cursor-fixture-model'),
    });
    const start = (profileId: string) => registry.getAdapter(profileId)?.start({ documentId: 'doc-runtime', profileId, executionMode: 'auto-isolated', prompt: 'test task', workingDirectoryHandle: 'handle', canonicalWorkingDirectory: '/tmp', model: null, contextPacket: null, riskConfirmation: null });

    // Codex: the `model_reasoning_effort` key is not empirically evidenced, so
    // a persisted effort refuses the run instead of being sent as a guess that
    // the CLI would accept and ignore (item O correction). `capturedArgs` is
    // still its initial empty value here, and stays empty: the refusal happens
    // before the runner is ever reached.
    expect(() => start('codex')).toThrow(/reasoning-effort contract/iu);
    expect(capturedArgs).toEqual([]);

    start('claude-code');
    expect(capturedArgs).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--effort', 'xhigh']);
    start('antigravity');
    expect(capturedArgs).toEqual(['--print', '--output-format', 'stream-json', '--effort', 'medium', 'test task']);
    start('opencode');
    expect(capturedArgs).toEqual(['run', '--format', 'json', '--variant', 'max', 'test task']);

    // Cursor: model selection appends one --model pair; reasoningSelection is
    // false so no effort flag is ever produced, and the prompt is one opaque
    // argv value. The argv preset itself is documentation-derived, unverified.
    start('cursor');
    expect(capturedArgs).toEqual(['--print', '--output-format', 'stream-json', '--model', 'cursor-fixture-model', 'test task']);
    expect(capturedArgs).not.toContain('--force');
  });

  it('turns an asynchronous ENOENT spawn error into a bounded error stream', async () => {
    const runner = new ProcessRunner();
    const events = await collect(runner.run({ file: join(process.cwd(), 'missing-agent-binary'), args: [], cwd: process.cwd(), timeoutMs: 10_000 }));
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('rejects malformed structured lines and only replaces whole custom placeholders', () => {
    expect(parseStructuredAgentLine('{"ok":true}')).toEqual({ ok: true });
    expect(parseStructuredAgentLine('{malformed')).toBeNull();
    expect(parseStructuredAgentLine('not json')).toBeNull();
    expect(parseArgumentTemplate(['--dir', '{{workingDir}}', 'literal$(echo nope)'], {
      workingDir: '/tmp/work', promptFile: '/tmp/prompt', sessionId: 'session', model: 'model',
    })).toEqual(['--dir', '/tmp/work', 'literal$(echo nope)']);
    expect(() => parseArgumentTemplate(['{{unknown}}'], {
      workingDir: '/tmp/work', promptFile: '/tmp/prompt', sessionId: 'session', model: 'model',
    })).toThrow();
  });

  it('redacts quoted sensitive assignment keys in raw stdout frames', async () => {
    const secret = 'raw-stdout-secret-8877';
    const jsonFrame = JSON.stringify({ api_key: secret, safe: 'ok' });
    const shellFrame = `export api_key='${secret}'`;
    const fakeSpawn = scriptedSpawner(({ stdout }) => {
      stdout.write(`${jsonFrame}\n`);
      stdout.write(`${shellFrame}\n`);
    });
    const events = await collect(new ProcessRunner(fakeSpawn).run({ file: 'fixture', args: [], cwd: process.cwd(), timeoutMs: 10_000 }));
    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    const combinedStdout = stdoutEvents.map((e) => ('text' in e ? e.text : '')).join('');
    expect(combinedStdout).not.toContain(secret);
    expect(combinedStdout).toContain('{"api_key":"[REDACTED]"');
    expect(combinedStdout).toContain("export api_key='[REDACTED]'");
  });

  it('handles first overflow when incoming event is priority (a)', async () => {
    const queue = priorityQueue(3);
    // Fill capacity 3 with started (pri), stdout A, stdout B
    queue.push({ type: 'started', priority: true });
    queue.push({ id: 1, type: 'stdout' });
    queue.push({ id: 2, type: 'stdout' });
    // Queue is full at 3. Push priority ended event.
    // Must evict oldest non-priority item (stdout 1) and record gap.
    queue.push({ type: 'ended', priority: true });
    expect(await drain(queue)).toEqual([
      { type: 'started', priority: true },
      { summary: true, count: 1 },
      { id: 2, type: 'stdout' },
      { type: 'ended', priority: true },
    ]);
  });

  it('handles exactly one normal overflow then immediate close without underreporting (b)', async () => {
    const queue = new AsyncEventQueue<QueueItem>(3, (count) => ({ summary: true, count }), () => false);
    for (let i = 1; i <= 4; i += 1) queue.push({ id: i });
    expect(await drain(queue)).toEqual([{ summary: true, count: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it('handles repeated mixed normal and priority overflow with exact gap accounting (c)', async () => {
    const queue = priorityQueue(3);
    for (let i = 1; i <= 7; i += 1) queue.push({ id: i });
    queue.push({ id: 99, priority: true });
    // Evicted: 1, 2, 3, 4, 5 (5 items). Retained: 6, 7, 99 (3 items).
    expect(await drain(queue)).toEqual([{ summary: true, count: 5 }, { id: 6 }, { id: 7 }, { id: 99, priority: true }]);
  });

  it('drops incoming normal event when queue is full of priority items and bounds entries', async () => {
    const queue = priorityQueue(2);
    queue.push({ id: 1, type: 'started', priority: true });
    queue.push({ id: 2, type: 'status', priority: true });
    expect(queue.diagnosticItemCount).toBe(2);
    expect(queue.diagnosticEntryCount).toBe(2);
    // Push 3 normal items while full of priority items -> all dropped, single gap appended at end
    for (let i = 3; i <= 5; i += 1) queue.push({ id: i, type: 'stdout', priority: false });
    expect(queue.diagnosticItemCount).toBe(2);
    expect(queue.diagnosticEntryCount).toBe(3); // [item1, item2, gap(3)]
    expect(await drain(queue)).toEqual([
      { id: 1, type: 'started', priority: true },
      { id: 2, type: 'status', priority: true },
      { summary: true, count: 3 },
    ]);
  });

  it('handles priority flood while strictly bounding internal entries to <= 2*maxSize+1', async () => {
    const maxSize = 4;
    const queue = priorityQueue(maxSize);
    for (let i = 1; i <= 50; i += 1) {
      queue.push({ id: i, priority: true });
      expect(queue.diagnosticItemCount).toBeLessThanOrEqual(maxSize);
      expect(queue.diagnosticEntryCount).toBeLessThanOrEqual(2 * maxSize + 1);
    }
    // Out of 50 items, 46 evicted into 1 gap at the beginning, and 4 most recent priority items retained (47, 48, 49, 50)
    expect(await drain(queue)).toEqual([
      { summary: true, count: 46 },
      { id: 47, priority: true },
      { id: 48, priority: true },
      { id: 49, priority: true },
      { id: 50, priority: true },
    ]);
  });

  it('accurately maintains gaps around priorities in alternating priority/normal patterns', async () => {
    const queue = priorityQueue(3);
    // Alternating pattern: [norm1, prio2, norm3]
    queue.push({ id: 1, priority: false });
    queue.push({ id: 2, priority: true });
    queue.push({ id: 3, priority: false });
    // Push prio 4: evicts norm1 -> [gap(1), prio2, norm3, prio4]
    queue.push({ id: 4, priority: true });
    // Push norm 5: evicts norm3 -> [gap(1), prio2, gap(1), prio4, norm5]
    queue.push({ id: 5, priority: false });
    // Push prio 6: evicts norm5 -> [gap(1), prio2, gap(1), prio4, gap(1), prio6]
    queue.push({ id: 6, priority: true });
    // Push norm 7: queue full of prio -> dropped -> [gap(1), prio2, gap(1), prio4, gap(1), prio6, gap(1)]
    queue.push({ id: 7, priority: false });
    expect(await drain(queue)).toEqual([
      { summary: true, count: 1 },
      { id: 2, priority: true },
      { summary: true, count: 1 },
      { id: 4, priority: true },
      { summary: true, count: 1 },
      { id: 6, priority: true },
      { summary: true, count: 1 },
    ]);
  });

  it('exposes Cursor as a built-in profile with conservative unverified capabilities', async () => {
    const registry = new AgentRegistry(testAgentRegistryOptions());
    const detected = await registry.detect();
    const cursor = detected.find((p) => p.id === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor?.providerId).toBe('cursor');
    expect(cursor?.binaryPath).toContain('cursor-agent');
    // Documentation-derived preset; the approval bypass is never part of it.
    expect(cursor?.defaultArgs).toEqual(['--print', '--output-format', 'stream-json']);
    expect(cursor?.defaultArgs).not.toContain('--force');
    // Nothing was observed against a real binary, so every capability that
    // would need an observation stays false.
    expect(cursor?.capabilities).toMatchObject({
      structuredOutput: true,
      sessionResume: false,
      nativeSandbox: false,
      workingDirectory: true,
      modelSelection: true,
      reasoningSelection: false,
      fileChangeEvents: false,
      toolEvents: false,
      subagents: false,
      interactiveAuthentication: true,
      nonInteractiveMode: true,
    });
    expect(registry.getAdapter('cursor')).toBeDefined();
  });

  it('rejects start with provider-generic message when nonInteractiveMode is false for non-Copilot provider', () => {
    const mockRunner = ({ run: () => ({ runId: 'fixture-run', events: (async function* () { await Promise.resolve(); })(), completion: Promise.resolve(), cancel: () => undefined }) });
    const disabledProfile: MainAgentProfile = {
      id: 'claude-code',
      providerId: 'claude-code',
      name: 'Claude Code',
      binaryPath: 'claude',
      defaultArgs: [],
      defaultModel: null,
      reasoningEffort: null,
      permissionMode: 'normal',
      defaultSandboxMode: 'auto-isolated',
      capabilities: {
        structuredOutput: true,
        sessionResume: false,
        nativeSandbox: false,
        workingDirectory: true,
        modelSelection: true,
        reasoningSelection: true,
        fileChangeEvents: true,
        toolEvents: true,
        subagents: true,
        interactiveAuthentication: true,
        nonInteractiveMode: false,
      },
      detection: { availability: 'installed', binaryPath: 'claude', version: '1.0', checkedAt: new Date().toISOString(), errorMessage: null },
      isCustom: false,
      unsafe: false,
    };
    const adapter = new CliAgentAdapter(disabledProfile, mockRunner, ...adapterCollaborators());
    expect(() => {
      adapter.start({
        documentId: 'doc-runtime',
        profileId: 'claude-code',
        workingDirectoryHandle: 'handle',
        canonicalWorkingDirectory: '/tmp',
        prompt: 'test',
        executionMode: 'auto-isolated',
        model: null,
        contextPacket: null,
        riskConfirmation: null,
      });
    }).toThrow(/Claude Code is unavailable for unattended Agent Mode/i);
  });

  it('buildMinimalChildEnvironment restricts inherited keys to allowlist and scrubs secret names', () => {
    // Set a secret in parent process.env temporarily
    const originalSecret = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = 'sk-or-super-secret-parent-token';
      const childEnv = buildMinimalChildEnvironment({
        SAFE_CUSTOM_FLAG: '1',
        INJECTED_API_KEY: 'secret-val',
        INJECTED_TOKEN: 'secret-token',
      });

      // 1. Must never inherit parent process secrets
      expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();

      // 2. Must allow safe custom variables
      expect(childEnv.SAFE_CUSTOM_FLAG).toBe('1');

      // 3. Must reject extra variables containing forbidden secret patterns
      expect(childEnv.INJECTED_API_KEY).toBeUndefined();
      expect(childEnv.INJECTED_TOKEN).toBeUndefined();

      // 4. Must include essential allowlisted platform variables if defined
      if (process.env.PATH) {
        expect(childEnv.PATH).toBe(buildCliSearchPath());
      }
    } finally {
      if (originalSecret !== undefined) {
        process.env.OPENROUTER_API_KEY = originalSecret;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });
});
