import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { ChatService, type ChatProviderGateway } from '@main/ai/chat-service';
import { createActiveWork, type ActiveWork } from '@main/app/active-work';
import { ShutdownBarrier, type BarrierWindow } from '@main/app/shutdown-barrier';
import { restartToUpdate } from '@main/updates/update-runtime';
import type { Logger } from '@main/logging/logger';
import type { AIProvider } from '@main/ai/providers/types';
import { IPC_EVENTS } from '@shared/constants/ipc';
import type { CloneableValue } from '@shared/models/portable';
import type { AIModelInfo, AIProviderId, AIProviderStatus } from '@shared/types/ai';

/**
 * Chat sessions are created and rebound through provider probes that take as
 * long as the provider takes, and only then write the database. An update
 * restart closes chat admission before it asks the window to flush and drains
 * the database right after, so neither path may start once admission has
 * closed, and a creation already probing must hold the restart until it ends.
 * Real ChatService, real SQLite repository, fake providers: no paid calls.
 */

const DOCUMENT_ID = 'doc-admission';
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const model = (providerId: AIProviderId, id: string | null = null): AIModelInfo => ({
  id: id ?? `${providerId}-default`,
  name: `${providerId} model`,
  contextWindow: 32_000,
  maxOutputTokens: 2_048,
  supportsStreaming: true,
});

const capabilities = { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false };

function status(providerId: AIProviderId, ready: boolean): AIProviderStatus {
  return {
    id: providerId,
    name: `${providerId} provider`,
    available: ready,
    installed: true,
    authentication: ready ? 'connected' : 'error',
    version: '1.0',
    errorMessage: ready ? null : 'Not signed in.',
    models: [model(providerId)],
    capabilities,
  };
}

function provider(id: AIProviderId): AIProvider {
  return {
    id,
    name: `${id} provider`,
    capabilities,
    detect: () => Promise.resolve(status(id, true)),
    listModels: () => Promise.resolve([model(id)]),
    streamChat: () => { throw new Error('No turn is sent in these tests.'); },
    cancel: () => Promise.resolve(),
  };
}

/** Provider probes that count every call and, when gated, wait until the test releases them. */
class GatedProviders implements ChatProviderGateway {
  statusCalls = 0;
  modelCalls = 0;
  ready = true;
  failStatus = false;
  failModel = false;
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
  }

  open(): void {
    this.release();
    this.gate = Promise.resolve();
  }

  listStatuses(): Promise<readonly AIProviderStatus[]> {
    return Promise.resolve([status('fake', this.ready)]);
  }

  async getStatus(providerId: AIProviderId): Promise<AIProviderStatus> {
    this.statusCalls += 1;
    await this.gate;
    if (this.failStatus) throw new Error('probe failed');
    return status(providerId, this.ready);
  }

  async resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo> {
    this.modelCalls += 1;
    await this.gate;
    if (this.failModel) throw new Error('model unavailable');
    return model(providerId, modelId);
  }

  require(providerId: AIProviderId): AIProvider {
    return provider(providerId);
  }

  testConnection(): Promise<{ readonly success: boolean }> {
    return Promise.resolve({ success: true });
  }
}

describe('chat session admission during an update restart', () => {
  let db: InterleafDatabase;
  let repository: ChatRepository;
  let providers: GatedProviders;
  let service: ChatService;
  let documentOpen: boolean;
  let activeWork: ActiveWork;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: DOCUMENT_ID,
      title: 'Admission',
      author: 'Leslie',
      format: 'pdf',
      filePath: '/admission.pdf',
      storageMode: 'link',
      fileSize: 1024,
      fileMtimeMs: 1,
      fileHash: 'hash-admission',
      pageCount: 2,
    });
    repository = new ChatRepository(db);
    providers = new GatedProviders();
    documentOpen = true;
    service = new ChatService({
      chat: repository,
      context: new AIContextRepository(db),
      providers,
      requireDocumentOpen: () => {
        if (!documentOpen) throw new Error('Document is not open.');
      },
      log,
      resolveOpenRouterModelId: () => Promise.resolve(null),
    });
    activeWork = createActiveWork({
      agentSessions: [],
      chatStreams: [() => service.liveWork()],
      imports: [],
      closeAdmission: [() => { service.closeAdmission(); }],
    });
  });

  afterEach(async () => {
    providers.open();
    await service.shutdown();
    db.close();
  });

  function updateRestart() {
    const install = vi.fn();
    const prepared = { prepareInstall: vi.fn(() => Promise.resolve({ version: '0.5.1', install })), cancelPreparedInstall: vi.fn() };
    const sent: { channel: string; payload: CloneableValue }[] = [];
    const window: BarrierWindow = { isDestroyed: () => false, close: vi.fn(), webContents: { send: (channel, payload) => { sent.push({ channel, payload }); } } };
    const drain = vi.fn(() => service.shutdown());
    const barrier = new ShutdownBarrier({ mainWindow: () => window, drain, hasLiveServices: () => true, quit: vi.fn(), log, handshakeTimeoutMs: 60_000 });
    const deps = { activeWork, requestQuitForUpdate: (run: () => void, close: () => void) => barrier.requestQuitForUpdate(run, close) };
    return {
      install,
      prepared,
      sent,
      drain,
      restart: () => restartToUpdate(prepared, deps),
      closeReady: () => { barrier.handleCloseReady(window.webContents, sent[0]?.payload ?? null); },
    };
  }

  it('refuses creation and rebinding at once while the renderer flushes, with no provider call or write', async () => {
    const existing = await service.createSession({ documentId: DOCUMENT_ID, title: 'Existing', providerId: 'fake' });
    const calls = { status: providers.statusCalls, model: providers.modelCalls };
    const creates = vi.spyOn(repository, 'createSession');
    const updates = vi.spyOn(repository, 'updateSession');
    const restart = updateRestart();

    await expect(restart.restart()).resolves.toEqual({ outcome: 'restarting', version: '0.5.1' });
    expect(restart.sent.map((message) => message.channel)).toEqual([IPC_EVENTS.appBeforeClose]);

    // The handshake is still pending: the database is open, but nothing new may start.
    const creation = service.createSession({ documentId: DOCUMENT_ID, title: 'Late', providerId: 'fake' });
    const rebinding = service.updateSession({ sessionId: existing.id, providerId: 'fake', modelId: 'fake-other' });
    expect({ status: providers.statusCalls, model: providers.modelCalls }).toEqual(calls);
    expect(service.liveWork()).toBe(0);
    await expect(creation).rejects.toThrow('shutting down');
    await expect(rebinding).rejects.toThrow('shutting down');

    restart.closeReady();
    await vi.waitFor(() => { expect(restart.install).toHaveBeenCalledOnce(); });
    expect(restart.drain).toHaveBeenCalledOnce();
    expect({ status: providers.statusCalls, model: providers.modelCalls }).toEqual(calls);
    expect(creates).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
    expect(repository.listSessions(DOCUMENT_ID).map((session) => session.title)).toEqual(['Existing']);
  });

  it('holds the restart while a creation started before it is still probing, then lets it finish', async () => {
    providers.hold();
    const creation = service.createSession({ documentId: DOCUMENT_ID, title: 'Probing', providerId: 'fake' });
    expect(service.liveWork()).toBe(1);
    const restart = updateRestart();

    await expect(restart.restart()).resolves.toEqual({ outcome: 'blocked', activeWork: { agentSessions: 0, chatStreams: 1, imports: 0 } });
    expect(restart.prepared.prepareInstall).not.toHaveBeenCalled();
    expect(restart.sent).toEqual([]);

    providers.open();
    expect((await creation).title).toBe('Probing');
    expect(service.liveWork()).toBe(0);
    await expect(restart.restart()).resolves.toEqual({ outcome: 'restarting', version: '0.5.1' });
    restart.closeReady();
    await vi.waitFor(() => { expect(restart.install).toHaveBeenCalledOnce(); });
    expect(repository.listSessions(DOCUMENT_ID).map((session) => session.title)).toEqual(['Probing']);
  });

  it('stops counting a creation or rebinding that fails, wherever it fails', async () => {
    documentOpen = false;
    await expect(service.createSession({ documentId: DOCUMENT_ID, providerId: 'fake' })).rejects.toThrow('not open');
    expect(service.liveWork()).toBe(0);
    documentOpen = true;

    providers.ready = false;
    await expect(service.createSession({ documentId: DOCUMENT_ID, providerId: 'fake' })).rejects.toThrow('Not signed in.');
    expect(service.liveWork()).toBe(0);
    providers.ready = true;

    providers.hold();
    providers.failStatus = true;
    const failing = service.createSession({ documentId: DOCUMENT_ID, providerId: 'fake' });
    expect(service.liveWork()).toBe(1);
    providers.open();
    await expect(failing).rejects.toThrow('probe failed');
    expect(service.liveWork()).toBe(0);
    providers.failStatus = false;

    const session = await service.createSession({ documentId: DOCUMENT_ID, providerId: 'fake' });
    providers.hold();
    providers.failModel = true;
    const rebinding = service.updateSession({ sessionId: session.id, providerId: 'fake', modelId: 'fake-other' });
    expect(service.liveWork()).toBe(1);
    providers.open();
    await expect(rebinding).rejects.toThrow('model unavailable');
    expect(service.liveWork()).toBe(0);
    expect(repository.getSessionForDocument(session.id, DOCUMENT_ID)?.modelId).toBe('fake-default');

    await expect(updateRestart().restart()).resolves.toEqual({ outcome: 'restarting', version: '0.5.1' });
  });
});
