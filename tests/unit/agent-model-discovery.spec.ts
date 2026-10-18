import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRepository } from '@main/db/repositories/agent-repository';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { WorkingDirectoryRegistry } from '@main/agents/working-directory-registry';
import type { Logger } from '@main/logging/logger';
import {
  AgentModelDiscovery,
  runBoundedProbe,
  type ProbeAnswer,
  type ProbeRequest,
} from '@main/agents/model-discovery';
import { MAX_DISCOVERED_AGENT_MODELS } from '@shared/constants/agent-models';
import { PROBES, type ProbeDefinition } from '@main/agents/model-discovery-probes';
import { CliAgentAdapter } from '@main/agents/agent-adapter';
import { TestAgentRegistry } from '../helpers/agent-registry';
import { resolveMainProfileModels, toRendererAgentProfile, type MainAgentProfile } from '@main/agents/profile-types';
import { ProcessCleanupUnknownError } from '@main/agents/process-runner';
import type { PortableValue } from '@shared/models/portable';
import { createTestAgentService } from '../helpers/agent-service';
import type { AgentService } from '@main/agents/agent-service';
import { adapterCollaborators, testAgentRegistryOptions } from '../helpers/agent-collaborators';

const log = { warn: vi.fn(), debug: vi.fn() };

function probe(providerId: 'codex' | 'claude-code' | 'pi' | 'antigravity' | 'opencode'): ProbeDefinition {
  const definition = PROBES[providerId];
  if (definition === undefined) throw new Error(`No probe is declared for ${providerId}`);
  return definition;
}

/** Runs the real bounded probe against Node itself, never a provider CLI. */
async function runScript(script: string, definition: ProbeDefinition, signal?: AbortSignal): Promise<ProbeAnswer> {
  return await runBoundedProbe({
    file: process.execPath,
    cwd: tmpdir(),
    definition: { ...definition, args: ['-e', script], stdin: [], keepStdinOpen: false },
    signal: signal ?? new AbortController().signal,
  });
}

const CODEX_FRAME = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: { data: [{ id: 'gpt-5.1-codex', model: 'gpt-5.1-codex' }, { id: 'gpt-5.1', model: 'gpt-5.1' }] },
});

describe('probe collectors', () => {
  it('reads Codex identifiers from the reply to this probe only', () => {
    const collector = probe('codex').createCollector();
    expect(collector.accept(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } }))).toBeNull();
    expect(collector.accept('thinking…')).toBeNull();
    expect(collector.accept(CODEX_FRAME)).toEqual(['gpt-5.1-codex', 'gpt-5.1']);
  });

  it('prefers the Codex `model` value and falls back to `id`', () => {
    const collector = probe('codex').createCollector();
    const frame = JSON.stringify({ id: 2, result: { data: [{ id: 'a-id', model: 'a-model' }, { id: 'b-id' }, { name: 'no-identifier' }] } });
    expect(collector.accept(frame)).toEqual(['a-model', 'b-id']);
  });

  it('answers a Claude control response only when it matches this request and succeeded', () => {
    const success = (models: readonly PortableValue[]): string => JSON.stringify({
      type: 'control_response',
      response: { request_id: 'interleaf-model-discovery', subtype: 'success', response: { models } },
    });
    expect(probe('claude-code').createCollector().accept(success([
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5-20260101' },
      { value: 'claude-sonnet-5' },
    ]))).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(probe('claude-code').createCollector().accept(JSON.stringify({
      type: 'control_response',
      response: { request_id: 'someone-else', subtype: 'success', response: { models: [{ value: 'claude-opus-5' }] } },
    }))).toBeNull();
    expect(probe('claude-code').createCollector().accept(JSON.stringify({
      type: 'control_response',
      response: { request_id: 'interleaf-model-discovery', subtype: 'error', error: 'unsupported' },
    }))).toBeNull();
  });

  it('never answers from a partial JSON line', () => {
    const collector = probe('codex').createCollector();
    const half = Math.floor(CODEX_FRAME.length / 2);
    expect(collector.accept(CODEX_FRAME.slice(0, half))).toBeNull();
    expect(collector.accept(CODEX_FRAME.slice(half))).toBeNull();
    expect(collector.finish()).toBeNull();
  });

  it('reads the pi table without its header row and the antigravity id column', () => {
    const pi = probe('pi').createCollector();
    expect(pi.accept('provider  model                context')).toBeNull();
    expect(pi.accept('anthropic  claude-opus-5        200000')).toBeNull();
    expect(pi.finish()).toEqual(['anthropic/claude-opus-5']);
    const antigravity = probe('antigravity').createCollector();
    expect(antigravity.accept('Available models:')).toBeNull();
    expect(antigravity.accept('gemini-3-pro\tGemini 3 Pro')).toBeNull();
    expect(antigravity.finish()).toEqual(['gemini-3-pro']);
  });

  it('declares a probe only for providers with an observed listing mechanism', () => {
    const discovery = new AgentModelDiscovery({ log, probeCwd: tmpdir() });
    for (const providerId of ['codex', 'claude-code', 'antigravity', 'opencode', 'pi'] as const) {
      expect(discovery.supports(providerId)).toBe(true);
    }
    for (const providerId of ['copilot', 'custom', 'fake'] as const) {
      expect(discovery.supports(providerId)).toBe(false);
    }
  });
});

describe('bounded probe process handling', () => {
  it('accepts a JSON frame delivered across chunk boundaries', async () => {
    const script = `const line = ${JSON.stringify(CODEX_FRAME)};
      process.stdout.write(line.slice(0, 12));
      setTimeout(() => { process.stdout.write(line.slice(12) + '\\n'); }, 30);
      setTimeout(() => { process.exit(0); }, 5000);`;
    await expect(runScript(script, probe('codex'))).resolves.toEqual(['gpt-5.1-codex', 'gpt-5.1']);
  });

  it('waits for the child to close instead of resolving when it is signalled', async () => {
    const script = `process.on('SIGTERM', () => {});
      process.stdout.write(${JSON.stringify(CODEX_FRAME)} + '\\n');
      setInterval(() => {}, 1000);`;
    const startedAt = Date.now();
    await expect(runScript(script, probe('codex'))).resolves.toEqual(['gpt-5.1-codex', 'gpt-5.1']);
    // The child ignores SIGTERM, so the answer can only arrive after the
    // escalation to SIGKILL and the real close event.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
  }, 20_000);

  it('discards a listing when the CLI exits non-zero', async () => {
    const script = `process.stdout.write('anthropic  claude-opus-5  200000\\n');
      process.exit(3);`;
    await expect(runScript(script, probe('pi'))).resolves.toBeNull();
  });

  it('discards a listing that exceeds the output bound', async () => {
    const script = `for (let index = 0; index < 40000; index += 1) {
        process.stdout.write('anthropic  model-' + index + '  200000\\n');
      }`;
    await expect(runScript(script, probe('pi'))).resolves.toBeNull();
  }, 20_000);

  it('keeps a clean trailing line that was never newline-terminated', async () => {
    const script = `process.stdout.write('anthropic  claude-opus-5  200000');`;
    await expect(runScript(script, probe('pi'))).resolves.toEqual(['anthropic/claude-opus-5']);
  });

  it('answers only after a stubborn descendant of an exited parent is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleaf-probe-descendant-'));
    const pidFile = join(directory, 'descendant.pid');
    // The parent replies and exits at once, so its own close arrives promptly
    // and proves nothing: the grandchild holds no pipe of its own, is known to
    // be ignoring SIGTERM by then, and only the escalation to the whole process
    // group ends it.
    const script = stubbornTreeScript(directory, `writeSync(1, ${JSON.stringify(CODEX_FRAME)} + '\\n');
      process.exit(0);`);
    let descendantPid = 0;
    try {
      await expect(runScript(script, probe('codex'))).resolves.toEqual(['gpt-5.1-codex', 'gpt-5.1']);
      descendantPid = Number(await readFile(pidFile, 'utf8'));
      expect(descendantPid).toBeGreaterThan(0);
      // The listing is only allowed to be reported once the tree is reaped.
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && isProcessAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('abandons the listing and cleans the tree up when the probe is aborted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleaf-probe-abort-'));
    const pidFile = join(directory, 'descendant.pid');
    const script = stubbornTreeScript(directory, `process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    let descendantPid = 0;
    try {
      const probing = runScript(script, probe('codex'), controller.signal);
      await waitForFile(pidFile);
      controller.abort();
      // A cancelled probe never produces a catalog, however much it had read.
      await expect(probing).resolves.toBeNull();
      descendantPid = Number(await readFile(pidFile, 'utf8'));
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && isProcessAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('answers nothing when the probe is aborted after the listing was collected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleaf-probe-abort-after-answer-'));
    const stoppedFile = join(directory, 'probe.stopped');
    // The CLI replies and is stopped on purpose by the probe; its SIGTERM
    // handler publishes the marker only after the reply has been collected.
    // An external cancellation after that point must still discard it.
    const script = `process.on('SIGTERM', () => {
        require('node:fs').writeFileSync(${JSON.stringify(stoppedFile)}, 'ok');
        setInterval(() => {}, 1000);
      });
      process.stdout.write(${JSON.stringify(CODEX_FRAME)} + '\\n');
      setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    try {
      const probing = runScript(script, probe('codex'), controller.signal);
      await waitForFile(stoppedFile);
      controller.abort();
      await expect(probing).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('answers nothing when the run reports a failure after the listing was collected', async () => {
    // The reply arrives first, then the CLI floods past the runner's output
    // bound. The runner-reported failure overrides the already-collected reply
    // instead of the reply overriding the failure.
    const script = `process.on('SIGTERM', () => {});
      process.stdout.write(${JSON.stringify(CODEX_FRAME)} + '\\n');
      const chunk = 'x'.repeat(65536);
      const flood = setInterval(() => { for (let index = 0; index < 16; index += 1) process.stdout.write(chunk); }, 1);`;
    await expect(runScript(script, probe('codex'))).resolves.toBeNull();
  }, 20_000);
});

/**
 * A fake CLI that leaves one inherited grandchild behind, then runs `epilogue`.
 *
 * The readiness marker is what makes these regressions discriminating: the
 * grandchild installs its SIGTERM handler asynchronously, so without waiting
 * for it the first termination signal could simply kill the descendant and a
 * runner that never escalated would look correct. The parent publishes the
 * descendant pid only once that handler is in place.
 */
function stubbornTreeScript(directory: string, epilogue: string): string {
  const pidFile = JSON.stringify(join(directory, 'descendant.pid'));
  const readyFile = join(directory, 'descendant.ready');
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ok'); setInterval(() => {}, 1000);`;
  return `const { spawn } = require('node:child_process');
      const { existsSync, writeFileSync, writeSync } = require('node:fs');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore'] });
      const waiting = setInterval(() => {
        if (!existsSync(${JSON.stringify(readyFile)})) return;
        clearInterval(waiting);
        writeFileSync(${pidFile}, String(descendant.pid));
        ${epilogue}
      }, 10);`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents.length > 0) return;
    } catch { /* the child has not written it yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${path} was never written.`);
}

describe('AgentModelDiscovery', () => {
  function withAnswers(answers: readonly ProbeAnswer[]): { discovery: AgentModelDiscovery; requests: ProbeRequest[]; clock: { value: number } } {
    const requests: ProbeRequest[] = [];
    const clock = { value: Date.UTC(2026, 8, 8) };
    let call = 0;
    const discovery = new AgentModelDiscovery({
      log,
      probeCwd: tmpdir(),
      now: () => new Date(clock.value),
      runProbe: (request) => {
        requests.push(request);
        const answer = answers[Math.min(call, answers.length - 1)] ?? null;
        call += 1;
        return Promise.resolve(answer);
      },
    });
    return { discovery, requests, clock };
  }

  it('keeps only identifiers the launch allowlist would also accept', async () => {
    const { discovery } = withAnswers([[
      'claude-opus-5',
      'claude-fable-5-1[1m]',
      '--not-a-model',
      'claude opus 5',
      'claude-opus-5',
      'claude-sonnet-5',
    ]]);
    const catalog = await discovery.discover('claude-code', '/opt/interleaf-test/claude');
    expect(catalog?.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(catalog?.source).toBe('control-protocol');
    expect(catalog?.providerId).toBe('claude-code');
  });

  it('bounds a very long catalog', async () => {
    const { discovery } = withAnswers([Array.from({ length: 500 }, (_, index) => `model-${String(index)}`)]);
    const catalog = await discovery.discover('codex', '/opt/interleaf-test/codex');
    expect(catalog?.models).toHaveLength(MAX_DISCOVERED_AGENT_MODELS);
  });

  it('produces no catalog when the probe fails, is truncated, or lists nothing usable', async () => {
    const { discovery: failed } = withAnswers([null]);
    await expect(failed.discover('codex', '/opt/interleaf-test/codex')).resolves.toBeNull();
    const { discovery: unusable } = withAnswers([['--flag', 'has space']]);
    await expect(unusable.discover('codex', '/opt/interleaf-test/codex')).resolves.toBeNull();
  });

  it('never probes a provider without a declared listing mechanism', async () => {
    const { discovery, requests } = withAnswers([['anything']]);
    await expect(discovery.discover('copilot', '/opt/interleaf-test/copilot')).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('reuses a cached catalog, and re-probes on force, on expiry, and after a cleared cache', async () => {
    const { discovery, requests, clock } = withAnswers([['gpt-5.1-codex'], ['gpt-5.2-codex']]);
    const first = await discovery.discover('codex', '/opt/interleaf-test/codex');
    expect(first?.models).toEqual(['gpt-5.1-codex']);
    expect(await discovery.discover('codex', '/opt/interleaf-test/codex')).toEqual(first);
    expect(requests).toHaveLength(1);
    const forced = await discovery.discover('codex', '/opt/interleaf-test/codex', true);
    expect(forced?.models).toEqual(['gpt-5.2-codex']);
    expect(requests).toHaveLength(2);
    clock.value += 31 * 60 * 1000;
    await discovery.discover('codex', '/opt/interleaf-test/codex');
    expect(requests).toHaveLength(3);
    discovery.clear();
    await discovery.discover('codex', '/opt/interleaf-test/codex');
    expect(requests).toHaveLength(4);
  });

  it('reports no catalog when the executable cannot be spawned', async () => {
    const discovery = new AgentModelDiscovery({ log, probeCwd: tmpdir() });
    await expect(discovery.discover('codex', '/opt/interleaf-test/absent-codex-binary')).resolves.toBeNull();
  });

  it('produces no catalog when the probe ends with its cleanup unverified', async () => {
    // A strict run whose child-tree termination the runner could not prove
    // rejects completion; discovery must treat that as no answer at all.
    const discovery = new AgentModelDiscovery({
      log,
      probeCwd: tmpdir(),
      runProbe: () => Promise.reject(new ProcessCleanupUnknownError('Agent process tree termination could not be verified.')),
    });
    await expect(discovery.discover('codex', '/opt/interleaf-test/codex')).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith('agent model discovery probe failed', expect.objectContaining({ providerId: 'codex' }));
  });

  it('runs one probe per provider, so a repeated refresh joins the live one', async () => {
    const gate = deferred<ProbeAnswer>();
    let calls = 0;
    const discovery = new AgentModelDiscovery({
      log,
      probeCwd: tmpdir(),
      runProbe: () => { calls += 1; return gate.promise; },
    });
    const first = discovery.discover('codex', '/opt/interleaf-test/codex', true);
    const second = discovery.discover('codex', '/opt/interleaf-test/codex', true);
    const third = discovery.discover('claude-code', '/opt/interleaf-test/claude', true);
    gate.resolve(['gpt-5.1-codex']);
    expect((await first)?.models).toEqual(['gpt-5.1-codex']);
    // The second caller gets the live answer instead of starting a second CLI.
    expect(await second).toEqual(await first);
    expect((await third)?.providerId).toBe('claude-code');
    expect(calls).toBe(2);
  });

  it('cancels and awaits its in-flight probes on close, and lists nothing afterwards', async () => {
    const gate = deferred<ProbeAnswer>();
    let aborted = false;
    const discovery = new AgentModelDiscovery({
      log,
      probeCwd: tmpdir(),
      runProbe: (request) => {
        request.signal.addEventListener('abort', () => { aborted = true; gate.resolve(null); }, { once: true });
        return gate.promise;
      },
    });
    const probing = discovery.discover('codex', '/opt/interleaf-test/codex');
    let closed = false;
    const closing = discovery.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(aborted).toBe(true);
    await closing;
    expect(closed).toBe(true);
    await expect(probing).resolves.toBeNull();
    // A closed discoverer owns no children and never starts another.
    await expect(discovery.discover('codex', '/opt/interleaf-test/codex')).resolves.toBeNull();
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const runner = ({ run: () => { throw new Error('A discovery test must never launch a session.'); } });

function profile(overrides: Partial<MainAgentProfile> = {}): MainAgentProfile {
  return {
    id: 'codex',
    providerId: 'codex',
    name: 'Codex',
    binaryPath: '/opt/interleaf-test/codex',
    defaultArgs: ['exec', '--json'],
    defaultModel: null,
    configuredModels: ['gpt-5.1-codex'],
    reasoningEffort: null,
    permissionMode: 'normal',
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', binaryPath: '/opt/interleaf-test/codex', version: '0.153.4', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

function registryWith(profiles: readonly MainAgentProfile[], models: readonly string[]): { registry: TestAgentRegistry; probed: string[] } {
  const probed: string[] = [];
  const registry = new TestAgentRegistry(testAgentRegistryOptions({
    processRunner: runner,
    modelDiscovery: {
      supports: (providerId) => providerId === 'codex' || providerId === 'claude-code',
      discover: (providerId) => {
        probed.push(providerId);
        return Promise.resolve({ providerId, models, source: 'app-server-rpc' as const, discoveredAt: new Date().toISOString() });
      },
      close: () => Promise.resolve(),
    },
  }));
  for (const entry of profiles) registry.installAdapter(new CliAgentAdapter(entry, runner, ...adapterCollaborators()));
  return { registry, probed };
}

describe('discovered models reach the single allowlist', () => {
  it('attaches the CLI catalog behind the user list and offers it to the renderer', async () => {
    const { registry } = registryWith([profile()], ['gpt-5.2-codex', 'gpt-5.1-codex']);
    expect(await registry.refreshDiscoveredModels()).toBe(true);
    const [updated] = registry.listMainProfiles();
    if (updated === undefined) throw new Error('The profile disappeared from the registry.');
    expect(updated.discoveredModels).toEqual(['gpt-5.2-codex', 'gpt-5.1-codex']);
    // The user's own entry stays first; the CLI catalog only extends it.
    expect(resolveMainProfileModels(updated)).toEqual(['gpt-5.1-codex', 'gpt-5.2-codex']);
    expect(toRendererAgentProfile(updated).availableModels).toEqual(['gpt-5.1-codex', 'gpt-5.2-codex']);
  });

  it('reports no change when the catalog is identical, so nothing is re-projected', async () => {
    const { registry } = registryWith([profile({ discoveredModels: ['gpt-5.2-codex'] })], ['gpt-5.2-codex']);
    expect(await registry.refreshDiscoveredModels()).toBe(false);
  });

  it('never probes an uninstalled CLI, a custom profile, or the fixture', async () => {
    const { registry, probed } = registryWith([
      profile({ id: 'absent', detection: { availability: 'not-installed', binaryPath: null, version: null, checkedAt: new Date().toISOString(), errorMessage: null } }),
      profile({ id: 'custom:one', providerId: 'custom', isCustom: true }),
      profile({ id: 'fake', providerId: 'fake' }),
    ], ['gpt-5.2-codex']);
    expect(await registry.refreshDiscoveredModels()).toBe(false);
    expect(probed).toEqual([]);
  });

  it('keeps the profile untouched when the provider does not answer', async () => {
    const registry = new TestAgentRegistry(testAgentRegistryOptions({
      processRunner: runner,
      modelDiscovery: { supports: () => true, discover: () => Promise.resolve(null), close: () => Promise.resolve() },
    }));
    registry.installAdapter(new CliAgentAdapter(profile(), runner, ...adapterCollaborators()));
    expect(await registry.refreshDiscoveredModels()).toBe(false);
    const [unchanged] = registry.listMainProfiles();
    if (unchanged === undefined) throw new Error('The profile disappeared from the registry.');
    expect(unchanged.discoveredModels).toBeUndefined();
    expect(resolveMainProfileModels(unchanged)).toEqual(['gpt-5.1-codex']);
  });

  it('is inert when no discoverer is configured at all', async () => {
    const registry = new TestAgentRegistry(testAgentRegistryOptions({ processRunner: runner }));
    registry.installAdapter(new CliAgentAdapter(profile(), runner, ...adapterCollaborators()));
    expect(await registry.refreshDiscoveredModels()).toBe(false);
    await expect(registry.closeModelDiscovery()).resolves.toBeUndefined();
  });
});

class DiscoveryRegistry extends TestAgentRegistry {
  override detect(): Promise<readonly MainAgentProfile[]> { return Promise.resolve([]); }
}

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type ModelDiscoveryDouble = NonNullable<ConstructorParameters<typeof TestAgentRegistry>[0]>['modelDiscovery'];

async function openDiscoveryService(
  prefix: string,
  modelDiscovery: ModelDiscoveryDouble,
): Promise<{ readonly service: AgentService; readonly dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  const registry = new DiscoveryRegistry(testAgentRegistryOptions({ processRunner: runner, modelDiscovery }));
  registry.installAdapter(new CliAgentAdapter(profile(), runner, ...adapterCollaborators()));
  const service = createTestAgentService({ database: db,
    repository: new AgentRepository(db),
    registry: new WorkingDirectoryRegistry(),
    agentRegistry: registry,
    contextRoot: join(root, 'context'),
    chooseDirectory: () => Promise.resolve(root),
    log: logger,
    isPackaged: false,
    isGitRepository: () => Promise.resolve(false),
  });
  return {
    service,
    dispose: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('AgentService owns the background listing', () => {
  it('cancels model discovery during shutdown and waits for the probe to settle', async () => {
    const order: string[] = [];
    const gate = deferred<null>();
    const { service, dispose } = await openDiscoveryService('interleaf-agent-discovery-shutdown-', {
      supports: () => true,
      discover: () => gate.promise,
      close: () => {
        order.push('close-called');
        // A real probe needs a moment to terminate its child; shutdown has
        // to still be waiting when that finishes.
        setTimeout(() => { order.push('probe-settled'); gate.resolve(null); }, 50);
        return Promise.resolve();
      },
    });
    try {
      await service.initialize();
      await service.shutdown();
      order.push('shutdown-returned');
      expect(order).toEqual(['close-called', 'probe-settled', 'shutdown-returned']);
    } finally {
      await dispose();
    }
  });

  it('coalesces concurrent refreshes into one listing', async () => {
    const gate = deferred<null>();
    let calls = 0;
    const { service, dispose } = await openDiscoveryService('interleaf-agent-discovery-refresh-', {
      supports: () => true,
      discover: () => { calls += 1; return gate.promise; },
      close: () => Promise.resolve(),
    });
    try {
      await service.initialize();
      gate.resolve(null);
      await service.listDiscoveredProfiles();
      const before = calls;
      const first = service.refreshDiscoveredModels();
      const second = service.refreshDiscoveredModels();
      await Promise.all([first, second]);
      // Two overlapping refreshes are one listing, so neither can finish last
      // with the older answer.
      expect(calls).toBe(before + 1);
    } finally {
      await service.shutdown();
      await dispose();
    }
  });
});
