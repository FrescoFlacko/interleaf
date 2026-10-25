import { describe, expect, it, vi } from 'vitest';
import type { AIProviderStatus } from '@shared/types/ai';
import { CliAIProvider, createCliProviderDefinitions, type CliProcessSpawner } from '@main/ai/providers/cli-ai-provider';
import { DiagnosticsService } from '../../src/main/diagnostics/diagnostics-service';
import { silentLogger } from '../helpers/silent-logger';

/**
 * Diagnostics cancellation against the real CLI adapter: the adapter's own
 * workspace and binary preparation are held open through its injected seams,
 * the user cancels, and no process may ever be spawned. Nothing here reaches
 * a real binary, filesystem or network.
 */

const OWNER = 1;

function claudeDefinition() {
  const definition = createCliProviderDefinitions().find((entry) => entry.id === 'claude');
  if (definition === undefined) throw new Error('claude definition missing');
  return definition;
}

function setup(hold: 'workspace' | 'binary') {
  const workspaceGate = Promise.withResolvers<{ readonly path: string; readonly cleanup: () => Promise<void> }>();
  const binaryGate = Promise.withResolvers<string>();
  const cleanup = vi.fn(() => Promise.resolve());
  const spawnProcess = vi.fn<CliProcessSpawner>(() => { throw new Error('spawn must not be reached'); });
  const prepareChatDirectory = vi.fn(() =>
    hold === 'workspace' ? workspaceGate.promise : Promise.resolve({ path: '/safe/diagnostics-chat', cleanup }));
  const resolveBinary = vi.fn(() => (hold === 'binary' ? binaryGate.promise : Promise.resolve('/fixture/bin/claude')));
  const definition = claudeDefinition();
  const provider = new CliAIProvider(definition, '/safe/chat-root', { logger: silentLogger, spawnProcess, prepareChatDirectory, resolveBinary });
  const ready: AIProviderStatus = {
    id: 'claude', name: definition.name, available: true, installed: true, authentication: 'connected', version: '2.1.0', errorMessage: null,
    models: [definition.model], capabilities: definition.capabilities,
  };
  const service = new DiagnosticsService({
    environment: { appVersion: '0.13.0', versions: { electron: '40.1.0', chrome: '140.0.7339.41', node: '22.20.0' }, packaged: false, platform: 'darwin', arch: 'arm64' },
    logs: null,
    now: () => new Date('2026-10-25T12:00:00.000Z'),
    providers: {
      listStatuses: () => Promise.resolve([ready]),
      getStatus: () => Promise.resolve(ready),
      require: () => provider,
      resolveModel: () => Promise.resolve(definition.model),
    },
    showSaveDialog: () => Promise.resolve({ canceled: true }),
    writeFile: () => Promise.resolve(),
    log: silentLogger,
  });
  return { service, provider, cleanup, spawnProcess, prepareChatDirectory, resolveBinary, workspaceGate, binaryGate, model: definition.model.id };
}

describe('diagnostics cancellation through the real CLI adapter', () => {
  it('registers the request before preparing the workspace, so a cancel during that wait never spawns', async () => {
    const { service, cleanup, spawnProcess, prepareChatDirectory, workspaceGate, model } = setup('workspace');
    const { handle } = await service.collect(OWNER);
    service.preview(OWNER, handle, '');
    const pending = service.analyze(OWNER, handle, 'claude', model);
    await vi.waitFor(() => { expect(prepareChatDirectory).toHaveBeenCalledTimes(1); });
    service.cancel(OWNER, handle);
    workspaceGate.resolve({ path: '/safe/diagnostics-chat', cleanup });
    expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(service.activeCount()).toBe(0); });
  });

  it('cancels during binary resolution without spawning and removes the workspace', async () => {
    const { service, cleanup, spawnProcess, resolveBinary, binaryGate, model } = setup('binary');
    const { handle } = await service.collect(OWNER);
    service.preview(OWNER, handle, '');
    const pending = service.analyze(OWNER, handle, 'claude', model);
    await vi.waitFor(() => { expect(resolveBinary).toHaveBeenCalledTimes(1); });
    service.cancel(OWNER, handle);
    binaryGate.resolve('/fixture/bin/claude');
    expect(await pending).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(service.activeCount()).toBe(0); });
  });

  it('stops the adapter directly during workspace preparation', async () => {
    const { provider, cleanup, spawnProcess, prepareChatDirectory, workspaceGate } = setup('workspace');
    const request = {
      requestId: 'diag-direct', modelId: null, systemPrompt: 'x', contextXml: '', history: [], userMessage: 'y', sources: [], webSearch: false,
    };
    const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => { expect(prepareChatDirectory).toHaveBeenCalledTimes(1); });
    await provider.cancel('diag-direct');
    workspaceGate.resolve({ path: '/safe/diagnostics-chat', cleanup });
    await expect(next).rejects.toMatchObject({ code: 'validation', message: 'AI response was cancelled.' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
