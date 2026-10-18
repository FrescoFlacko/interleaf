/**
 * Main-owned provider readiness: the bounded cache Reader Chat reads before a
 * document's chat is usable.
 *
 * Every probe here is a controlled double. No CLI is spawned, no network is
 * reached and nothing is asked to answer a turn.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AIModelInfo, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import { ProviderReadiness, type ProviderProbe } from '@main/ai/provider-readiness';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import type { CliAIProvider } from '@main/ai/providers/cli-ai-provider';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

function status(id: AIProviderId, authentication: AIProviderStatus['authentication'] = 'connected'): AIProviderStatus {
  return {
    id,
    name: id,
    available: authentication === 'connected',
    installed: true,
    authentication,
    version: '1.0.0',
    errorMessage: null,
    models: [{ id: `${id}-default`, name: id, contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true }],
    capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
  };
}

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A probe whose every call is held open until the test settles it. */
function heldProbe() {
  const calls: { readonly providerId: AIProviderId; readonly forceRefresh: boolean; readonly answer: Deferred<AIProviderStatus> }[] = [];
  const probe = vi.fn((providerId: AIProviderId, options: { readonly forceRefresh?: boolean } | undefined) => {
    const answer = deferred<AIProviderStatus>();
    calls.push({ providerId, forceRefresh: options?.forceRefresh === true, answer });
    return answer.promise;
  });
  return { probe, calls };
}

function readiness(input: { probe: ReturnType<typeof heldProbe>['probe']; clock?: { now: number } }) {
  const clock = input.clock ?? { now: 0 };
  return new ProviderReadiness({
    probe: input.probe,
    cachedProviderIds: ['codex', 'claude'],
    freshMs: 1_000,
    maxAgeMs: 10_000,
    now: () => clock.now,
  });
}

describe('ProviderReadiness', () => {
  it('claims nothing before a probe answers, then reuses the answer while it is fresh', async () => {
    const { probe, calls } = heldProbe();
    const clock = { now: 0 };
    const cache = readiness({ probe, clock });

    let settled = false;
    const first = cache.status('codex').then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    calls[0]!.answer.resolve(status('codex'));
    expect((await first).authentication).toBe('connected');

    clock.now = 999;
    expect((await cache.status('codex')).authentication).toBe('connected');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping reads, including a background prewarm, into one probe', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });

    cache.prewarm();
    const reads = [cache.status('codex'), cache.status('codex'), cache.status('claude')];
    expect(calls.map((call) => call.providerId)).toEqual(['codex', 'claude']);
    calls[0]!.answer.resolve(status('codex'));
    calls[1]!.answer.resolve(status('claude', 'disconnected'));
    const [codexA, codexB, claude] = await Promise.all(reads);
    expect(codexA).toBe(codexB);
    expect(claude?.authentication).toBe('disconnected');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('answers a stale status at once and revalidates it exactly once in the background', async () => {
    const { probe, calls } = heldProbe();
    const clock = { now: 0 };
    const cache = readiness({ probe, clock });
    const first = cache.status('codex');
    calls[0]!.answer.resolve(status('codex'));
    await first;

    clock.now = 5_000;
    expect((await cache.status('codex')).authentication).toBe('connected');
    expect((await cache.status('codex')).authentication).toBe('connected');
    expect(calls).toHaveLength(2);

    // The revalidation's answer replaces the cached one for the next read.
    calls[1]!.answer.resolve(status('codex', 'disconnected'));
    await vi.waitFor(async () => {
      expect((await cache.status('codex')).authentication).toBe('disconnected');
    });
    expect(calls).toHaveLength(2);
  });

  it('waits for a new probe once a status has expired', async () => {
    const { probe, calls } = heldProbe();
    const clock = { now: 0 };
    const cache = readiness({ probe, clock });
    const first = cache.status('codex');
    calls[0]!.answer.resolve(status('codex'));
    await first;

    clock.now = 10_000;
    let settled = false;
    const expired = cache.status('codex').then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    calls[1]!.answer.resolve(status('codex', 'disconnected'));
    expect((await expired).authentication).toBe('disconnected');
  });

  it('treats a clock that moved backwards as expired rather than fresh', async () => {
    const { probe, calls } = heldProbe();
    const clock = { now: 5_000 };
    const cache = readiness({ probe, clock });
    const first = cache.status('codex');
    calls[0]!.answer.resolve(status('codex'));
    await first;

    clock.now = 1_000;
    const read = cache.status('codex');
    expect(calls).toHaveLength(2);
    calls[1]!.answer.resolve(status('codex'));
    await read;
  });

  it('probes again on a forced read and never lets an older probe overwrite it', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });

    const plain = cache.status('codex');
    const forced = cache.status('codex', { forceRefresh: true });
    expect(calls.map((call) => call.forceRefresh)).toEqual([false, true]);

    // The forced answer lands first; the older plain probe resolves later
    // with what was true before.
    calls[1]!.answer.resolve(status('codex', 'disconnected'));
    expect((await forced).authentication).toBe('disconnected');
    calls[0]!.answer.resolve(status('codex', 'connected'));
    expect((await plain).authentication).toBe('connected');

    expect((await cache.status('codex')).authentication).toBe('disconnected');
    expect(calls).toHaveLength(2);
  });

  it('forces a probe even while a fresh answer is cached, and later reads join it', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });
    const first = cache.status('codex');
    calls[0]!.answer.resolve(status('codex'));
    await first;

    const forced = cache.status('codex', { forceRefresh: true });
    const joined = cache.status('codex');
    expect(calls).toHaveLength(2);
    calls[1]!.answer.resolve(status('codex', 'disconnected'));
    expect((await forced).authentication).toBe('disconnected');
    // A plain read during the forced probe still answers from the cache it had.
    expect((await joined).authentication).toBe('connected');
    expect((await cache.status('codex')).authentication).toBe('disconnected');
  });

  it('discards an in-flight answer after an invalidation, and the next read probes again', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });
    const inFlight = cache.status('codex');
    cache.invalidate('codex');
    const next = cache.status('codex');
    expect(calls).toHaveLength(2);

    calls[0]!.answer.resolve(status('codex', 'connected'));
    await inFlight;
    calls[1]!.answer.resolve(status('codex', 'disconnected'));
    expect((await next).authentication).toBe('disconnected');
    expect((await cache.status('codex')).authentication).toBe('disconnected');
    expect(calls).toHaveLength(2);
  });

  it('adopts a recorded status and ignores the probe it superseded', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });
    const inFlight = cache.status('codex');
    cache.record(status('codex', 'connected'));
    calls[0]!.answer.resolve(status('codex', 'disconnected'));
    await inFlight;

    expect((await cache.status('codex')).authentication).toBe('connected');
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failed probe', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });
    const failed = cache.status('codex');
    calls[0]!.answer.reject(new Error('probe failed'));
    await expect(failed).rejects.toThrow('probe failed');

    const retried = cache.status('codex');
    expect(calls).toHaveLength(2);
    calls[1]!.answer.resolve(status('codex'));
    expect((await retried).authentication).toBe('connected');
  });

  it('passes every read of an uncached provider straight through, with its options', async () => {
    const probe = vi.fn((providerId: AIProviderId) => Promise.resolve(status(providerId)));
    const cache = new ProviderReadiness({ probe, cachedProviderIds: ['codex'] });
    await cache.status('local');
    await cache.status('local', { forceRefresh: true });
    cache.record(status('openrouter'));
    await cache.status('openrouter');
    expect(probe.mock.calls).toEqual([['local', undefined], ['local', { forceRefresh: true }], ['openrouter', undefined]]);
  });

  it('stops caching at shutdown and ignores answers that land afterwards', async () => {
    const { probe, calls } = heldProbe();
    const cache = readiness({ probe });
    const first = cache.status('codex');
    calls[0]!.answer.resolve(status('codex'));
    await first;
    const inFlight = cache.status('codex', { forceRefresh: true });

    cache.shutdown();
    calls[1]!.answer.resolve(status('codex', 'connected'));
    await inFlight;
    cache.record(status('codex'));
    const after = cache.status('codex');
    expect(calls).toHaveLength(3);
    calls[2]!.answer.resolve(status('codex', 'unknown'));
    expect((await after).authentication).toBe('unknown');
  });
});

describe('AIProviderRegistry readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registryWithStubbedCodex() {
    const registry = new AIProviderRegistry(testAIProviderRegistryInput());
    const detects = new Map<AIProviderId, Mock<(options?: Parameters<ProviderProbe>[1]) => Promise<AIProviderStatus>>>();
    for (const id of ['codex', 'claude', 'antigravity', 'cursor', 'pi', 'omp', 'local', 'openrouter'] as const) {
      const provider = registry.require(id);
      const detect = vi.fn<(options?: Parameters<ProviderProbe>[1]) => Promise<AIProviderStatus>>(() => Promise.resolve(status(id, id === 'codex' ? 'connected' : 'disconnected')));
      provider.detect = detect;
      detects.set(id, detect);
    }
    return { registry, detects };
  }

  it('prewarms only the CLI providers and serves later reads from that answer', async () => {
    const { registry, detects } = registryWithStubbedCodex();
    registry.prewarm();
    for (const id of ['codex', 'claude', 'antigravity', 'cursor', 'pi', 'omp'] as const) expect(detects.get(id)).toHaveBeenCalledTimes(1);
    expect(detects.get('local')).not.toHaveBeenCalled();
    expect(detects.get('openrouter')).not.toHaveBeenCalled();

    const listed = await registry.listStatuses();
    expect(listed.map((entry) => entry.id)).toEqual(['codex', 'claude', 'antigravity', 'cursor', 'pi', 'omp', 'local', 'openrouter']);
    expect((await registry.getStatus('codex')).authentication).toBe('connected');
    expect(detects.get('codex')).toHaveBeenCalledTimes(1);
    // The local server and the vault-backed provider always answer for what
    // they hold now, so an endpoint or credential change is never cached over.
    expect(detects.get('local')).toHaveBeenCalledTimes(1);
    expect(detects.get('openrouter')).toHaveBeenCalledTimes(1);
  });

  it('probes every provider again when a list is forced', async () => {
    const { registry, detects } = registryWithStubbedCodex();
    await registry.listStatuses();
    await registry.listStatuses({ forceRefresh: true });
    expect(detects.get('codex')).toHaveBeenCalledTimes(2);
    expect(detects.get('codex')).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(detects.get('local')).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it('keeps a slow unrelated CLI from holding up a provider that is already known', async () => {
    const { registry, detects } = registryWithStubbedCodex();
    await registry.listStatuses();
    const slow = deferred<AIProviderStatus>();
    detects.get('antigravity')!.mockImplementation(() => slow.promise);
    const forced = registry.getStatus('antigravity', { forceRefresh: true });

    // Only the forced read waits; a document's list and a new session's status
    // check answer from the cache while that probe is still out.
    expect((await registry.listStatuses()).find((entry) => entry.id === 'codex')?.authentication).toBe('connected');
    expect((await registry.getStatus('codex')).authentication).toBe('connected');
    slow.resolve(status('antigravity', 'error'));
    expect((await forced).authentication).toBe('error');
    expect((await registry.getStatus('antigravity')).authentication).toBe('error');
  });

  it('adopts the status a finished ChatGPT sign-in reports', async () => {
    const { registry, detects } = registryWithStubbedCodex();
    detects.get('codex')!.mockImplementation(() => Promise.resolve(status('codex', 'disconnected')));
    expect((await registry.getStatus('codex')).authentication).toBe('disconnected');

    const codex = registry.require('codex') as CliAIProvider;
    vi.spyOn(codex, 'signInWithChatGPT').mockResolvedValue(status('codex', 'connected'));
    expect((await registry.signInWithChatGPT()).authentication).toBe('connected');
    expect((await registry.getStatus('codex')).authentication).toBe('connected');
    expect(detects.get('codex')).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown provider before reading any cache', async () => {
    const { registry } = registryWithStubbedCodex();
    await expect(registry.getStatus('nope' as AIProviderId)).rejects.toThrow('AI provider is unavailable.');
  });

  it('answers from the providers themselves once shut down', async () => {
    const { registry, detects } = registryWithStubbedCodex();
    await registry.getStatus('codex');
    await registry.shutdown();
    await registry.getStatus('codex');
    expect(detects.get('codex')).toHaveBeenCalledTimes(2);
  });

  it('keeps per-model reasoning through the cache and closes the model listing at shutdown', async () => {
    const closing = deferred<undefined>();
    const close = vi.fn(() => closing.promise);
    const registry = new AIProviderRegistry(testAIProviderRegistryInput({
      modelListing: { list: vi.fn(() => Promise.resolve(null)), close },
    }));
    const base = status('codex');
    const reasoned: AIModelInfo = { ...base.models[0]!, reasoning: { levels: ['low', 'high'] } };
    const detect = vi.fn((): Promise<AIProviderStatus> => Promise.resolve({ ...base, models: [reasoned] }));
    registry.require('codex').detect = detect;

    await registry.getStatus('codex');
    const cached = await registry.getStatus('codex');
    expect(detect).toHaveBeenCalledTimes(1);
    expect(cached.models[0]?.reasoning).toEqual({ levels: ['low', 'high'] });
    expect(await registry.modelReasoning('codex', cached.models[0]!)).toEqual({ levels: ['low', 'high'] });

    let shutDown = false;
    const shutdown = registry.shutdown().then(() => { shutDown = true; });
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(shutDown).toBe(false);
    closing.resolve(undefined);
    await shutdown;
    await registry.getStatus('codex');
    expect(detect).toHaveBeenCalledTimes(2);
  });
});
