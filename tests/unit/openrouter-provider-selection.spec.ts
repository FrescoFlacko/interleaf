import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { ChatService, type ChatEventOwner, type ChatProviderGateway } from '@main/ai/chat-service';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, AIProviderCapabilities, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { Logger } from '@main/logging/logger';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const owner: ChatEventOwner = {
  id: 1,
  send: () => undefined,
  isDestroyed: () => false,
  onDestroyed: () => () => undefined,
};

class SpyProvider implements AIProvider {
  readonly name: string;
  readonly capabilities: AIProviderCapabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: true,
    persistentSessions: false,
    toolFreeMode: true,
    hostedWebSearch: false,
  };
  readonly model: AIModelInfo;
  available = true;
  dispatchCount = 0;
  lastRequest: ProviderChatRequest | null = null;

  constructor(readonly id: AIProviderId, name: string, modelId: string) {
    this.name = name;
    this.model = {
      id: modelId,
      name: modelId,
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
      supportsStreaming: true,
    };
  }

  detect(): Promise<AIProviderStatus> {
    return Promise.resolve({
      id: this.id,
      name: this.name,
      available: this.available,
      installed: false,
      authentication: this.available ? 'connected' : 'disconnected',
      version: 'test',
      errorMessage: this.available ? null : `${this.name} is unavailable in this test.`,
      models: [this.model],
      capabilities: this.capabilities,
    });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([this.model]);
  }

  resolveModel(modelId: string | null): AIModelInfo {
    return modelId === null ? this.model : { ...this.model, id: modelId };
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    this.dispatchCount += 1;
    this.lastRequest = request;
    await Promise.resolve();
    yield { type: 'token', token: `${this.name} response` };
    yield { type: 'done', totalTokens: 2 };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

describe('OpenRouter provider selection and session binding', () => {
  let db: InterleafDatabase;
  let chat: ChatRepository;
  let context: AIContextRepository;
  let openRouter: SpyProvider;
  let fake: SpyProvider;
  let providers: Map<AIProviderId, SpyProvider>;
  let service: ChatService;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-provider-selection',
      title: 'Provider Selection Fixture',
      author: 'Test',
      format: 'pdf',
      filePath: '/provider-selection.pdf',
      storageMode: 'link',
      fileSize: 1,
      fileMtimeMs: 1,
      fileHash: 'provider-selection-hash',
      pageCount: 1,
    });
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES ('provider-chunk', 'doc-provider-selection', 0, 'A deterministic provider selection passage.', 6, '{"format":"pdf","pageIndex":0}', 'Fixture', '1')
    `).run();
    db.raw.prepare(`
      INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES ('doc-provider-selection', 'ready', 1, 1, 'provider-selection-hash', 'provider-selection-hash', 1)
    `).run();

    chat = new ChatRepository(db);
    context = new AIContextRepository(db);
    openRouter = new SpyProvider('openrouter', 'OpenRouter', 'openrouter/auto');
    fake = new SpyProvider('fake', 'Deterministic Test Provider', 'fake-grounded');
    providers = new Map([
      ['openrouter', openRouter],
      ['fake', fake],
    ]);
    service = createService();
  });

  afterEach(async () => {
    await service.shutdown();
    db.close();
  });

  it('dispatches an OpenRouter-bound session once and never dispatches fake, including after restore', async () => {
    const session = await service.createSession({
      documentId: 'doc-provider-selection',
      title: 'OpenRouter chat',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    });
    expect(session).toMatchObject({ providerId: 'openrouter', modelId: 'openrouter/auto' });

    await service.sendMessage({ sessionId: session.id, content: 'Use OpenRouter' }, owner);
    await waitForTurnSettled(service, session.id);
    expect(openRouter.dispatchCount).toBe(1);
    expect(fake.dispatchCount).toBe(0);

    const restoredChat = new ChatRepository(db);
    const restored = restoredChat.listSessions('doc-provider-selection')[0];
    expect(restored).toMatchObject({ providerId: 'openrouter', modelId: 'openrouter/auto' });

    const restoredService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: restoredChat,
      context: new AIContextRepository(db),
      providers: createGateway(),
      requireDocumentOpen: () => undefined,
      log: logger,
    });
    await restoredService.sendMessage({ sessionId: session.id, content: 'Use the restored binding' }, owner);
    await waitForTurnSettled(restoredService, session.id, 2_000, 2);
    await restoredService.shutdown();

    expect(openRouter.dispatchCount).toBe(2);
    expect(fake.dispatchCount).toBe(0);
  });

  it('rejects unavailable OpenRouter before creating a persisted session', async () => {
    openRouter.available = false;

    await expect(service.createSession({
      documentId: 'doc-provider-selection',
      title: 'Unavailable OpenRouter',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    })).rejects.toThrow(/unavailable/i);

    expect(chat.listSessions('doc-provider-selection')).toHaveLength(0);
    expect(fake.dispatchCount).toBe(0);
  });

  it('rejects a provider identity mismatch instead of routing OpenRouter sessions through fake', async () => {
    const mismatchedGateway: ChatProviderGateway = {
      listStatuses: () => Promise.resolve([]),
      getStatus: () => openRouter.detect(),
      resolveModel: (_providerId, modelId) => Promise.resolve(openRouter.resolveModel(modelId)),
      require: () => fake,
      testConnection: () => Promise.resolve({ success: true }),
    };
    const mismatchedService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat,
      context,
      providers: mismatchedGateway,
      requireDocumentOpen: () => undefined,
      log: logger,
    });

    await expect(mismatchedService.createSession({
      documentId: 'doc-provider-selection',
      title: 'Mismatched binding',
      providerId: 'openrouter',
    })).rejects.toThrow(/could not be verified/i);
    await mismatchedService.shutdown();
  });

  function createService(): ChatService {
    return new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat,
      context,
      providers: createGateway(),
      requireDocumentOpen: () => undefined,
      log: logger,
    });
  }

  function createGateway(): ChatProviderGateway {
    return {
      listStatuses: async () => Promise.all([...providers.values()].map((provider) => provider.detect())),
      getStatus: (providerId) => {
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown provider ${providerId}`);
        return provider.detect();
      },
      resolveModel: (providerId, modelId) => {
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown provider ${providerId}`);
        return Promise.resolve(provider.resolveModel(modelId));
      },
      require: (providerId) => {
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown provider ${providerId}`);
        return provider;
      },
      testConnection: () => Promise.resolve({ success: true }),
    };
  }
});

async function waitForTurnSettled(
  chatService: ChatService,
  sessionId: string,
  timeoutMs = 2_000,
  minAssistantCount = 1,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const assistants = chatService.listMessages(sessionId).filter((message) => message.role === 'assistant');
    const newest = assistants.at(-1);
    if (assistants.length >= minAssistantCount && newest && newest.status !== 'streaming') return;
    if (Date.now() > deadline) throw new Error('chat turn did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
