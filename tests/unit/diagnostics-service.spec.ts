import { describe, expect, it, vi } from 'vitest';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import { DIAGNOSTICS_LIMITS, diagnosticsPacketSchema } from '@shared/schemas/diagnostics';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '../../src/main/ai/providers/types';
import { DiagnosticsService, type DiagnosticsServiceDeps } from '../../src/main/diagnostics/diagnostics-service';
import { DIAGNOSTICS_SYSTEM_PROMPT } from '../../src/main/diagnostics/report';
import { silentLogger } from '../helpers/silent-logger';

/**
 * The main-owned diagnostics service, driven only through injected fakes: no
 * real provider, dialog, file or log is touched. Canary strings stand in for
 * private data the packet must never carry, whether collected, sent or saved.
 */

const CANARIES = [
  'CANARY-PROVIDER-NAME',
  'CANARY-PROVIDER-VERSION',
  'CANARY-PROVIDER-ERROR',
  'CANARY-LOG-MESSAGE',
  'alice',
  'secret-project',
  'sk-ant-CANARYSECRET0123456789',
  'alice@example.com',
  'CANARY-METADATA',
];

const OWNER = 1;
const OTHER_OWNER = 2;
const FORGED_HANDLE = '550e8400-e29b-41d4-a716-446655440000';

function status(id: AIProviderId, overrides: Partial<AIProviderStatus> = {}): AIProviderStatus {
  return {
    id,
    name: `${id} CANARY-PROVIDER-NAME`,
    available: true,
    installed: true,
    authentication: 'connected',
    version: 'CANARY-PROVIDER-VERSION',
    errorMessage: 'CANARY-PROVIDER-ERROR at /Users/alice/secret-project',
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true }],
    capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
    ...overrides,
  };
}

type Stream = AsyncIterable<ProviderChatEvent>;

/** A stream that yields the given events, then ends. */
function streamOf(events: readonly ProviderChatEvent[]): Stream {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: () => {
          const value = events[index];
          index += 1;
          return Promise.resolve(value === undefined ? { done: true, value: undefined } : { done: false, value });
        },
      };
    },
  };
}

const answer = (...tokens: string[]): Stream =>
  streamOf([...tokens.map((token) => ({ type: 'token' as const, token })), { type: 'done' }]);

/** A stream whose first step waits until the test releases it, then answers. */
function heldStream(): { readonly stream: Stream; readonly release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = answer('late answer')[Symbol.asyncIterator]();
  return {
    release: () => { release(); },
    stream: { [Symbol.asyncIterator]: () => ({ next: async () => { await gate; return tail.next(); } }) },
  };
}

function fakeProvider(id: AIProviderId, respond: (request: ProviderChatRequest) => Stream, cancelDelayMs?: number) {
  const requests: ProviderChatRequest[] = [];
  const cancels: string[] = [];
  const provider: AIProvider = {
    id,
    name: id,
    capabilities: status(id).capabilities,
    detect: () => Promise.resolve(status(id)),
    listModels: () => Promise.resolve([]),
    streamChat: (request) => {
      requests.push(request);
      return respond(request);
    },
    cancel: async (requestId) => {
      cancels.push(requestId);
      if (cancelDelayMs !== undefined) {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        setTimeout(() => { resolve(undefined); }, cancelDelayMs);
        await promise;
      }
    },
  };
  return { provider, requests, cancels };
}

type Harness = {
  readonly service: DiagnosticsService;
  readonly requests: ProviderChatRequest[];
  readonly cancels: string[];
  readonly writes: { readonly path: string; readonly contents: string }[];
  readonly warnings: string[];
  /** Every registry access (require, getStatus, resolveModel), in order. */
  readonly providerCalls: string[];
  readonly dialog: ReturnType<typeof vi.fn<DiagnosticsServiceDeps['showSaveDialog']>>;
};

function harness(options: {
  readonly statuses?: readonly AIProviderStatus[];
  readonly respond?: (request: ProviderChatRequest) => Stream;
  readonly limits?: DiagnosticsServiceDeps['limits'];
  readonly logs?: DiagnosticsServiceDeps['logs'];
  readonly writeFile?: DiagnosticsServiceDeps['writeFile'];
  readonly filePath?: string;
  readonly resolveModelId?: string;
  readonly getStatus?: (id: AIProviderId) => Promise<AIProviderStatus>;
  readonly listStatuses?: () => Promise<readonly AIProviderStatus[]>;
  readonly cancelDelayMs?: number;
  readonly resolveModel?: DiagnosticsServiceDeps['providers']['resolveModel'];
} = {}): Harness {
  const statuses = options.statuses ?? [status('claude'), status('codex', { capabilities: { ...status('codex').capabilities, toolFreeMode: false } })];
  const fake = fakeProvider('claude', options.respond ?? (() => answer('Observations: none.')), options.cancelDelayMs);
  const providers = new Map<AIProviderId, AIProvider>([['claude', fake.provider], ['codex', fakeProvider('codex', () => answer('x')).provider]]);
  const writes: { path: string; contents: string }[] = [];
  const warnings: string[] = [];
  const providerCalls: string[] = [];
  const dialog = vi.fn<DiagnosticsServiceDeps['showSaveDialog']>(() =>
    Promise.resolve(options.filePath === undefined ? { canceled: true } : { canceled: false, filePath: options.filePath }));
  const service = new DiagnosticsService({
    environment: {
      appVersion: '0.13.0',
      versions: { electron: '40.1.0', chrome: '140.0.7339.41', node: '22.20.0' },
      packaged: false,
      platform: 'darwin',
      arch: 'arm64',
    },
    logs: options.logs === undefined ? {
      scanRecords: (visit) => {
        visit('ai', 'error', 'AI provider chat process could not start');
        visit('library', 'warn', 'Failed to import document');
        visit('library', 'warn', 'CANARY-LOG-MESSAGE /Users/alice/secret-project/book.pdf');
        visit('app', 'info', 'sk-ant-CANARYSECRET0123456789 alice@example.com CANARY-METADATA');
        return Promise.resolve({ scanned: 4, truncated: false });
      },
    } : options.logs,
    now: () => new Date('2026-10-25T12:00:00.000Z'),
    providers: {
      listStatuses: options.listStatuses ?? (() => Promise.resolve(statuses)),
      getStatus: (id) => {
        providerCalls.push(`getStatus:${id}`);
        if (options.getStatus !== undefined) return options.getStatus(id);
        const found = statuses.find((entry) => entry.id === id);
        return found === undefined ? Promise.reject(new Error('unknown provider')) : Promise.resolve(found);
      },
      require: (id) => {
        providerCalls.push(`require:${id}`);
        const found = providers.get(id);
        if (found === undefined) throw new Error('unknown provider');
        return found;
      },
      resolveModel: (id, modelId) => {
        providerCalls.push(`resolveModel:${id}`);
        if (options.resolveModel !== undefined) return options.resolveModel(id, modelId);
        const model = statuses.find((entry) => entry.id === id)?.models.find((entry) => entry.id === (options.resolveModelId ?? modelId ?? 'model-a'));
        return model === undefined ? Promise.reject(new Error('unknown model')) : Promise.resolve(model);
      },
    },
    showSaveDialog: dialog,
    writeFile: options.writeFile ?? ((path, contents) => { writes.push({ path, contents }); return Promise.resolve(); }),
    log: { ...silentLogger, warn: (message, metadata) => { warnings.push(`${message} ${JSON.stringify(metadata)}`); } },
    limits: { analysisTimeoutMs: 5_000, ...options.limits },
  });
  return { service, requests: fake.requests, cancels: fake.cancels, writes, warnings, providerCalls, dialog };
}

function expectNoCanaries(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
  expect(text).not.toMatch(/\/Users\//u);
}

async function expectExpired(work: () => Promise<object | undefined> | object | undefined): Promise<void> {
  await expect(Promise.resolve().then(work)).rejects.toMatchObject({
    code: 'validation',
    message: 'This diagnostics report has expired. Run diagnostics again.',
  });
}

const PRIVATE_ISSUE = 'Import of /Users/alice/secret-project/book.pdf failed; mail alice@example.com, key sk-ant-CANARYSECRET0123456789';

describe('DiagnosticsService', () => {
  describe('collection', () => {
    it('builds an allowlisted packet with no private canaries and offers only tool-free connected providers', async () => {
      const statuses = [
        status('claude'),
        status('codex', { capabilities: { ...status('codex').capabilities, toolFreeMode: false } }),
        status('pi', { authentication: 'disconnected' }),
        status('cursor', { available: false }),
        status('openrouter', { models: [] }),
      ];
      const { service, requests } = harness({ statuses });
      const collected = await service.collect(OWNER);

      expect(diagnosticsPacketSchema.parse(collected.packet)).toEqual(collected.packet);
      expect(collected.packetText).toBe(JSON.stringify(collected.packet, null, 2));
      expectNoCanaries(collected.packetText);
      expect(collected.packet.app).toEqual({ version: '0.13.0', electron: '40.1.0', chrome: '140.0.7339.41', node: '22.20.0', packaging: 'development' });
      expect(collected.packet.os).toEqual({ family: 'darwin', arch: 'arm64' });
      expect(collected.packet.providers.map((provider) => provider.id)).toEqual(['codex', 'claude', 'cursor', 'pi', 'openrouter']);
      expect(collected.packet.logs).toEqual({
        available: true,
        scannedRecords: 4,
        truncated: false,
        counts: [
          { category: 'ai', level: 'error', count: 1 },
          { category: 'app', level: 'info', count: 1 },
          { category: 'library', level: 'warn', count: 2 },
        ],
        signals: [
          { code: 'import-failed', count: 1 },
          { code: 'provider-process-start-failed', count: 1 },
        ],
      });
      expect(collected.providers).toEqual([{ id: 'claude', models: [{ id: 'model-a', name: 'Model A' }] }]);
      expect(requests).toHaveLength(0);
    });

    it('reports logs as unavailable when there is no sink or it cannot be read', async () => {
      const none = await harness({ logs: null }).service.collect(OWNER);
      expect(none.packet.logs).toEqual({ available: false, scannedRecords: 0, truncated: false, counts: [], signals: [] });
      const broken = await harness({ logs: { scanRecords: () => Promise.reject(new Error('CANARY-LOG-MESSAGE /Users/alice')) } }).service.collect(OWNER);
      expect(broken.packet.logs.available).toBe(false);
      expectNoCanaries(broken.packetText);
    });

    it('replaces a window\'s earlier handle and bounds the number of open handles', async () => {
      const { service } = harness({ limits: { maxHandles: 2 } });
      const first = await service.collect(OWNER);
      const second = await service.collect(OWNER);
      await expectExpired(() => service.preview(OWNER, first.handle, ''));
      expect(service.preview(OWNER, second.handle, '').report).toContain('# Interleaf diagnostics report');
      await service.collect(OTHER_OWNER);
      await expect(service.collect(3)).rejects.toMatchObject({ code: 'validation' });
    });
  });

  describe('handles', () => {
    it('rejects forged, cross-owner, discarded and expired handles on every step', async () => {
      const { service, dialog } = harness({ limits: { handleTtlMs: 30 } });
      const { handle } = await service.collect(OWNER);
      for (const [owner, target] of [[OWNER, FORGED_HANDLE], [OTHER_OWNER, handle]] as const) {
        await expectExpired(() => service.preview(owner, target, ''));
        await expectExpired(() => service.analyze(owner, target, 'claude', 'model-a'));
        await expectExpired(() => service.exportReport(owner, target));
        await expectExpired(() => { service.cancel(owner, target); return undefined; });
      }
      // A foreign discard is ignored rather than dropping another window's handle.
      service.discard(OTHER_OWNER, handle);
      expect(service.preview(OWNER, handle, '').issue).toBe('');

      service.discard(OWNER, handle);
      await expectExpired(() => service.preview(OWNER, handle, ''));

      const expiring = await service.collect(OWNER);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expectExpired(() => service.preview(OWNER, expiring.handle, ''));
      expect(dialog).not.toHaveBeenCalled();
    });

    it('drops a window\'s handles when it is disposed and refuses new work at shutdown', async () => {
      const { service } = harness();
      const { handle } = await service.collect(OWNER);
      service.disposeOwner(OWNER);
      await expectExpired(() => service.preview(OWNER, handle, ''));

      const kept = await service.collect(OWNER);
      await service.shutdown();
      await expectExpired(() => service.preview(OWNER, kept.handle, ''));
      await expect(service.collect(OWNER)).rejects.toBeInstanceOf(InterleafError);
    });
  });

  describe('review and analysis', () => {
    it('sanitizes the issue before preview, sends nothing until analyze, and sends only the reviewed packet and issue', async () => {
      const { service, requests } = harness({
        respond: () => answer('Observations: import failed for /Users/alice/secret-project/x.pdf; contact alice@example.com.\n```sh\nrm -rf ~\n```'),
      });
      const collected = await service.collect(OWNER);
      const preview = service.preview(OWNER, collected.handle, PRIVATE_ISSUE);
      expectNoCanaries(preview.issue);
      expectNoCanaries(preview.report);
      expect(preview.issue).toContain('[email]');
      expect(preview.report).toContain(collected.packetText);
      expect(preview.report).toContain('(Not requested.)');
      expect(requests).toHaveLength(0);

      const result = await service.analyze(OWNER, collected.handle, 'claude', 'model-a');
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request).toMatchObject({
        modelId: 'model-a',
        systemPrompt: DIAGNOSTICS_SYSTEM_PROMPT,
        contextXml: '',
        history: [],
        sources: [],
        webSearch: false,
      });
      expect(request?.userMessage).toContain('<diagnostics-packet>');
      expect(request?.userMessage).toContain(preview.issue);
      expectNoCanaries(request?.userMessage ?? 'missing');

      if (result.status !== 'complete') throw new Error(`analysis failed: ${result.reason}`);
      expect(result.issue).toBe(preview.issue);
      expectNoCanaries(result.report);
      expect(result.report).toContain('Generated by Claude');
      expect(result.report).not.toContain('```sh');
    });

    it('requires a review before analysis or export', async () => {
      const { service, requests, dialog } = harness();
      const { handle } = await service.collect(OWNER);
      await expect(service.analyze(OWNER, handle, 'claude', 'model-a')).rejects.toMatchObject({ code: 'validation' });
      await expect(service.exportReport(OWNER, handle)).rejects.toMatchObject({ code: 'validation' });
      expect(requests).toHaveLength(0);
      expect(dialog).not.toHaveBeenCalled();
    });

    it.each([
      ['a provider that always runs with tools', [status('claude', { capabilities: { ...status('claude').capabilities, toolFreeMode: false } })], 'provider-unavailable'],
      ['a disconnected provider', [status('claude', { authentication: 'disconnected' })], 'provider-unavailable'],
      ['an unavailable provider', [status('claude', { available: false })], 'provider-unavailable'],
      ['a provider main does not know', [], 'provider-unavailable'],
    ] as const)('fails closed for %s without calling it', async (_label, statuses, reason) => {
      const { service, requests } = harness({ statuses });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      expect(await service.analyze(OWNER, handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason });
      expect(requests).toHaveLength(0);
    });

    it('rejects Codex, which cannot run without tools', async () => {
      const { service, requests } = harness();
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      expect(await service.analyze(OWNER, handle, 'codex', 'model-a')).toEqual({ status: 'failed', reason: 'provider-unavailable' });
      expect(requests).toHaveLength(0);
    });

    it('rejects a model the provider does not publish, including a substituted one', async () => {
      const unlisted = harness();
      const first = await unlisted.service.collect(OWNER);
      unlisted.service.preview(OWNER, first.handle, '');
      expect(await unlisted.service.analyze(OWNER, first.handle, 'claude', 'model-b')).toEqual({ status: 'failed', reason: 'model-unavailable' });

      const substituted = harness({
        statuses: [status('claude', { models: [...status('claude').models, { id: 'model-b', name: 'Model B', contextWindow: 1_000, maxOutputTokens: 100, supportsStreaming: true }] })],
        resolveModelId: 'model-b',
      });
      const second = await substituted.service.collect(OWNER);
      substituted.service.preview(OWNER, second.handle, '');
      expect(await substituted.service.analyze(OWNER, second.handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason: 'model-unavailable' });
      expect([...unlisted.requests, ...substituted.requests]).toHaveLength(0);
    });

    it.each([
      ['an answer longer than the limit', () => answer('x'.repeat(DIAGNOSTICS_LIMITS.analysisMaxLength + 1)), 'too-long'],
      ['too many stream events', () => answer('a', 'b', 'c', 'd', 'e'), 'too-long'],
      ['an empty answer', () => answer('   '), 'empty'],
      ['a stream that ends without finishing', () => streamOf([{ type: 'token', token: 'partial' }]), 'provider-failed'],
      ['a stream that throws', () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('CANARY-PROVIDER-ERROR /Users/alice')) }) }), 'provider-failed'],
    ] as const)('fails on %s and keeps the reviewed report', async (_label, respond, reason) => {
      const { service, warnings, writes } = harness({ respond, limits: { maxStreamEvents: 3 }, filePath: '/tmp/out/report.md' });
      const { handle } = await service.collect(OWNER);
      const preview = service.preview(OWNER, handle, 'issue');
      expect(await service.analyze(OWNER, handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason });
      expect(warnings.join('\n')).not.toContain('CANARY');
      expect(warnings.join('\n')).not.toContain('partial');
      await service.exportReport(OWNER, handle);
      expect(writes[0]?.contents).toBe(preview.report);
      expect(service.activeCount()).toBe(0);
    });

    it('times out a provider that does not answer and stops it', async () => {
      const held = heldStream();
      const { service, cancels } = harness({ respond: () => held.stream, limits: { analysisTimeoutMs: 20 } });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      expect(await service.analyze(OWNER, handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason: 'timeout' });
      await vi.waitFor(() => { expect(cancels).toHaveLength(1); });
      held.release();
      expect(service.activeCount()).toBe(0);
    });

    it.each([
      ['an explicit cancel', (service: DiagnosticsService, handle: string) => { service.cancel(OWNER, handle); }],
      ['the window closing', (service: DiagnosticsService) => { service.disposeOwner(OWNER); }],
      ['the panel discarding', (service: DiagnosticsService, handle: string) => { service.discard(OWNER, handle); }],
      ['shutdown', (service: DiagnosticsService) => { void service.shutdown(); }],
    ] as const)('cancels a running analysis on %s and drops the late answer', async (_label, stop) => {
      const held = heldStream();
      const { service, requests, cancels } = harness({ respond: () => held.stream });
      const { handle } = await service.collect(OWNER);
      const preview = service.preview(OWNER, handle, '');
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
      expect(service.activeCount()).toBe(1);
      await vi.waitFor(() => { expect(requests).toHaveLength(1); });
      stop(service, handle);
      held.release();
      expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
      await vi.waitFor(() => { expect(cancels).toHaveLength(1); });
      expect(service.activeCount()).toBe(0);
      // Where the handle survives, the report is still the reviewed one.
      try {
        expect(service.preview(OWNER, handle, '').report).toBe(preview.report);
      } catch (caught) {
        expect(caught).toMatchObject({ code: 'validation' });
      }
    });

    it('is busy while a run is active, per handle and across windows, and blocks preview and export meanwhile', async () => {
      const held = heldStream();
      const { service, requests } = harness({ respond: () => held.stream, limits: { maxConcurrentAnalyses: 1 }, filePath: '/tmp/out/report.md' });
      const mine = await service.collect(OWNER);
      const theirs = await service.collect(OTHER_OWNER);
      service.preview(OWNER, mine.handle, '');
      service.preview(OTHER_OWNER, theirs.handle, '');
      const pending = service.analyze(OWNER, mine.handle, 'claude', 'model-a');
      expect(service.activeCount()).toBe(1);
      await vi.waitFor(() => { expect(requests).toHaveLength(1); });
      expect(await service.analyze(OWNER, mine.handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason: 'busy' });
      expect(await service.analyze(OTHER_OWNER, theirs.handle, 'claude', 'model-a')).toEqual({ status: 'failed', reason: 'busy' });
      expect(() => service.preview(OWNER, mine.handle, '')).toThrow(InterleafError);
      await expect(service.exportReport(OWNER, mine.handle)).rejects.toMatchObject({ code: 'validation' });
      held.release();
      expect((await pending).status).toBe('complete');
      expect(service.activeCount()).toBe(0);
    });

    it('refuses to start an analysis once admission is closed for an update or quit', async () => {
      const { service, requests } = harness();
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      service.closeAdmission();
      await expect(service.analyze(OWNER, handle, 'claude', 'model-a')).rejects.toBeInstanceOf(InterleafError);
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['direct cancel', (service: DiagnosticsService, handle: string) => { service.cancel(OWNER, handle); }],
      ['window disposal', (service: DiagnosticsService) => { service.disposeOwner(OWNER); }],
      ['panel discard', (service: DiagnosticsService, handle: string) => { service.discard(OWNER, handle); }],
      ['shutdown', (service: DiagnosticsService) => { void service.shutdown(); }],
    ] as const)('aborts pending verification immediately on %s with no later streamChat', async (_label, stop) => {
      const { promise: statusPromise, resolve: releaseStatus } = Promise.withResolvers<AIProviderStatus>();
      const { service, requests } = harness({ getStatus: () => statusPromise });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
      expect(service.activeCount()).toBe(1);
      stop(service, handle);
      releaseStatus(status('claude'));
      expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
      expect(requests).toHaveLength(0);
      expect(service.activeCount()).toBe(0);
    });

    it('races verification against the analysis deadline and starts no inference after timeout', async () => {
      const { promise: statusPromise, resolve: releaseStatus } = Promise.withResolvers<AIProviderStatus>();
      const { service, requests } = harness({
        getStatus: () => statusPromise,
        limits: { analysisTimeoutMs: 20 },
      });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      let settled = false;
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a').then((res) => {
        settled = true;
        return res;
      });
      const { promise: delayPromise, resolve: resolveDelay } = Promise.withResolvers<undefined>();
      setTimeout(() => { resolveDelay(undefined); }, 50);
      await delayPromise;
      expect(settled).toBe(true);
      releaseStatus(status('claude'));
      expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
      expect(requests).toHaveLength(0);
      expect(service.activeCount()).toBe(0);
    });

    it('synchronously limits concurrent analyses across windows before verification completes', async () => {
      const { promise: statusPromise, resolve: releaseStatus } = Promise.withResolvers<AIProviderStatus>();
      const { service } = harness({
        getStatus: () => statusPromise,
        limits: { maxConcurrentAnalyses: 2 },
      });
      const c1 = await service.collect(1);
      const c2 = await service.collect(2);
      const c3 = await service.collect(3);
      service.preview(1, c1.handle, '');
      service.preview(2, c2.handle, '');
      service.preview(3, c3.handle, '');

      const p1 = service.analyze(1, c1.handle, 'claude', 'model-a');
      const p2 = service.analyze(2, c2.handle, 'claude', 'model-a');
      expect(service.activeCount()).toBe(2);

      const p3 = await service.analyze(3, c3.handle, 'claude', 'model-a');
      expect(p3).toEqual({ status: 'failed', reason: 'busy' });
      expect(service.activeCount()).toBe(2);

      releaseStatus(status('claude'));
      await Promise.all([p1, p2]);
      expect(service.activeCount()).toBe(0);
    });

    it('retains activeCount through asynchronous provider cancellation cleanup', async () => {
      const held = heldStream();
      const { service } = harness({
        respond: () => held.stream,
        cancelDelayMs: 40,
      });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
      expect(service.activeCount()).toBe(1);
      service.cancel(OWNER, handle);
      expect(service.activeCount()).toBe(1);
      held.release();
      expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
      expect(service.activeCount()).toBe(0);
    });

    it.each(['openrouter', 'local'] as const)('excludes the %s HTTP transport from eligible providers even if status advertises toolFreeMode true', async (id) => {
      const forged = status(id, { capabilities: { ...status(id).capabilities, toolFreeMode: true } });
      const { service, providerCalls } = harness({ statuses: [status('claude'), forged] });
      const collected = await service.collect(OWNER);
      expect(collected.providers.map((p) => p.id)).toEqual(['claude']);
      expect(collected.packet.providers.find((p) => p.id === id)?.available).toBe(true);
      expect(providerCalls).toEqual([]);
    });

    it.each(['openrouter', 'local'] as const)('rejects a forged diagnostics %s analyze request before any registry or adapter access', async (id) => {
      const forged = status(id, { capabilities: { ...status(id).capabilities, toolFreeMode: true } });
      const { service, requests, cancels, providerCalls } = harness({ statuses: [status('claude'), forged] });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const result = await service.analyze(OWNER, handle, id, 'model-a');
      expect(result).toEqual({ status: 'failed', reason: 'provider-unavailable' });
      expect(providerCalls).toEqual([]);
      expect(requests).toHaveLength(0);
      expect(cancels).toHaveLength(0);
      expect(service.activeCount()).toBe(0);
      // The handle is not consumed: a supported provider can still analyze it.
      expect(await service.analyze(OWNER, handle, 'claude', 'model-a')).toMatchObject({ status: 'complete' });
    });

    it('keeps Codex excluded through its real toolFreeMode false', async () => {
      const { service, requests } = harness();
      const collected = await service.collect(OWNER);
      expect(collected.providers.map((p) => p.id)).toEqual(['claude']);
      service.preview(OWNER, collected.handle, '');
      expect(await service.analyze(OWNER, collected.handle, 'codex', 'model-a')).toEqual({ status: 'failed', reason: 'provider-unavailable' });
      expect(requests).toHaveLength(0);
    });

    it.each(['pi', 'omp'] as const)('keeps the tool-free %s CLI eligible when ready', async (id) => {
      const { service } = harness({ statuses: [status('claude'), status(id)] });
      const collected = await service.collect(OWNER);
      expect(collected.providers.map((p) => p.id).sort()).toEqual(['claude', id].sort());
    });

    it('aborts pending collection when owner is disposed during status query, leaving no live handle', async () => {
      const { promise: statusGate, resolve: releaseStatus } = Promise.withResolvers<readonly AIProviderStatus[]>();
      const { service } = harness({ listStatuses: () => statusGate });
      const pending = service.collect(OWNER);
      service.disposeOwner(OWNER);
      releaseStatus([status('claude')]);
      await expect(pending).rejects.toMatchObject({ code: 'validation' });
      expect(() => service.preview(OWNER, FORGED_HANDLE, '')).toThrow(InterleafError);
    });

    it('cancels during a pending model resolution with no later streamChat', async () => {
      const { promise: modelGate, resolve: releaseModel } = Promise.withResolvers<AIProviderStatus['models'][number]>();
      const { service, requests } = harness({ resolveModel: () => modelGate });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
      await Promise.resolve();
      service.cancel(OWNER, handle);
      const model = status('claude').models[0];
      if (model === undefined) throw new Error('fixture model missing');
      releaseModel(model);
      expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
      expect(requests).toHaveLength(0);
      expect(service.activeCount()).toBe(0);
    });

    it('keeps a timed-out run counted until its provider stop settles', async () => {
      const held = heldStream();
      const { service, cancels } = harness({ respond: () => held.stream, limits: { analysisTimeoutMs: 20 }, cancelDelayMs: 40 });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
      await vi.waitFor(() => { expect(cancels).toHaveLength(1); });
      expect(service.activeCount()).toBe(1);
      expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
      expect(service.activeCount()).toBe(0);
      held.release();
    });

    describe('provider cancellation held beyond the user wait', () => {
      const HELD_MS = 700;

      it('keeps a timed-out run counted after analyze returns until the held cancel settles', async () => {
        vi.useFakeTimers();
        try {
          const held = heldStream();
          const { service, cancels } = harness({ respond: () => held.stream, limits: { analysisTimeoutMs: 20 }, cancelDelayMs: HELD_MS });
          const { handle } = await service.collect(OWNER);
          service.preview(OWNER, handle, '');
          const baselineTimers = vi.getTimerCount();
          const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
          await vi.advanceTimersByTimeAsync(20);
          expect(cancels).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(500);
          expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
          expect(service.activeCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(HELD_MS - 500 - 1);
          expect(service.activeCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(1);
          expect(service.activeCount()).toBe(0);
          // Only the handle's own expiry timer remains: no wait or deadline timer leaks.
          expect(vi.getTimerCount()).toBe(baselineTimers);
          held.release();
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps a directly cancelled run counted after analyze returns until the held cancel settles', async () => {
        vi.useFakeTimers();
        try {
          const held = heldStream();
          const { service, cancels } = harness({ respond: () => held.stream, cancelDelayMs: HELD_MS });
          const { handle } = await service.collect(OWNER);
          service.preview(OWNER, handle, '');
          const baselineTimers = vi.getTimerCount();
          const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
          await vi.advanceTimersByTimeAsync(0);
          service.cancel(OWNER, handle);
          held.release();
          await vi.advanceTimersByTimeAsync(500);
          expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
          expect(cancels).toHaveLength(1);
          expect(service.activeCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(HELD_MS - 500 - 1);
          expect(service.activeCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(1);
          expect(service.activeCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(baselineTimers);
        } finally {
          vi.useRealTimers();
        }
      });

      it('bounds the shutdown wait on a held cancel and leaves no timers once it settles', async () => {
        vi.useFakeTimers();
        try {
          const held = heldStream();
          const { service } = harness({ respond: () => held.stream, cancelDelayMs: 5_000, limits: { shutdownWaitMs: 2_000 } });
          const { handle } = await service.collect(OWNER);
          service.preview(OWNER, handle, '');
          const pending = service.analyze(OWNER, handle, 'claude', 'model-a');
          await vi.advanceTimersByTimeAsync(0);
          let shutDown = false;
          void service.shutdown().then(() => { shutDown = true; });
          held.release();
          await vi.advanceTimersByTimeAsync(1_999);
          expect(shutDown).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(shutDown).toBe(true);
          expect(service.activeCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(3_000);
          expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
          expect(service.activeCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('does not resurrect a handle when the owner is disposed during the log scan', async () => {
      const { promise: scanGate, resolve: releaseScan } = Promise.withResolvers<{ scanned: number; truncated: boolean }>();
      let scanStarted = false;
      const { service } = harness({ logs: { scanRecords: () => { scanStarted = true; return scanGate; } } });
      const pending = service.collect(OWNER);
      await vi.waitFor(() => { expect(scanStarted).toBe(true); });
      service.disposeOwner(OWNER);
      releaseScan({ scanned: 0, truncated: false });
      await expect(pending).rejects.toMatchObject({ code: 'validation' });
      // The handle cap is untouched: four fresh collections still fit.
      for (const owner of [1, 2, 3, 4]) await expect(service.collect(owner)).resolves.toBeTruthy();
    });

    it('supersedes older in-flight collect and does not overwrite newer handle when older finishes late', async () => {
      const { promise: gate1, resolve: release1 } = Promise.withResolvers<readonly AIProviderStatus[]>();
      const { promise: gate2, resolve: release2 } = Promise.withResolvers<readonly AIProviderStatus[]>();
      let callCount = 0;
      const { service } = harness({
        listStatuses: () => {
          callCount += 1;
          return callCount === 1 ? gate1 : gate2;
        },
      });
      const p1 = service.collect(OWNER);
      const p2 = service.collect(OWNER);
      release2([status('claude')]);
      const c2 = await p2;
      release1([status('claude')]);
      await expect(p1).rejects.toMatchObject({ code: 'validation' });
      expect(service.preview(OWNER, c2.handle, '').report).toBeTruthy();
    });
  });

  describe('export', () => {
    it('writes exactly the previewed report through the native dialog and never runs inference', async () => {
      const { service, requests, writes, dialog } = harness({ filePath: '/tmp/out/Interleaf-diagnostics-report.md' });
      const { handle } = await service.collect(OWNER);
      const preview = service.preview(OWNER, handle, PRIVATE_ISSUE);
      const result = await service.exportReport(OWNER, handle);
      expect(result).toEqual({ status: 'success', bytes: Buffer.byteLength(preview.report, 'utf8'), fileName: 'Interleaf-diagnostics-report.md' });
      expect(writes).toEqual([{ path: '/tmp/out/Interleaf-diagnostics-report.md', contents: preview.report }]);
      expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'Interleaf-diagnostics-report.md' }));
      expectNoCanaries(writes[0]?.contents ?? 'missing');
      expect(requests).toHaveLength(0);
    });

    it('writes the analyzed report exactly as returned to the renderer', async () => {
      const { service, writes } = harness({ filePath: '/tmp/out/report.md' });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, 'issue');
      const result = await service.analyze(OWNER, handle, 'claude', 'model-a');
      if (result.status !== 'complete') throw new Error(`analysis failed: ${result.reason}`);
      await service.exportReport(OWNER, handle);
      expect(writes[0]?.contents).toBe(result.report);
    });

    it('saves nothing when the dialog is cancelled', async () => {
      const { service, writes } = harness();
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      expect(await service.exportReport(OWNER, handle)).toEqual({ status: 'cancelled' });
      expect(writes).toHaveLength(0);
    });

    it('reports a failed write without the chosen path or error text', async () => {
      const { service, warnings } = harness({
        filePath: '/Users/alice/secret-project/report.md',
        writeFile: () => Promise.reject(new Error('EACCES /Users/alice/secret-project/report.md')),
      });
      const { handle } = await service.collect(OWNER);
      service.preview(OWNER, handle, '');
      const failure = service.exportReport(OWNER, handle);
      await expect(failure).rejects.toMatchObject({
        code: 'validation',
        message: 'The diagnostics report could not be saved there. Choose another location.',
      });
      expectNoCanaries(warnings.join('\n'));
    });
  });
});
