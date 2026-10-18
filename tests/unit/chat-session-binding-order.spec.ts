import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService, type ChatEventOwner } from '@main/ai/chat-service';
import type { Logger } from '@main/logging/logger';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, AIProviderId, AIProviderStatus, ChatStreamEvent } from '@shared/types/ai';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

/**
 * Which provider a conversation is bound to, decided against the real
 * repository and the real SQLite row.
 *
 * Rebinding is not one step: main probes the chosen provider for readiness and
 * resolves its model — both of which take as long as that provider takes — and
 * only then writes the row. So two rebindings of the same conversation finish in
 * the order their *probes* finish in, which is not the order the reader made the
 * choices in. Nothing here mocks that ordering away: the probes really do resolve
 * out of order, the writes really do go to the database, and the question asked
 * is which binding a later reader — or a later turn — finds there.
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function modelFor(providerId: string): AIModelInfo {
  return {
    id: `${providerId}-default`,
    name: `${providerId} default`,
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    supportsStreaming: true,
  };
}

/**
 * A ready provider whose readiness probe takes exactly as long as the test says.
 *
 * `probeDelayMs` is the whole point: it is the window in which a second choice
 * can arrive, be probed faster, and be written first.
 */
class DelayedProvider implements AIProvider {
  readonly capabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  };
  probeDelayMs = 0;
  refuseWith: string | null = null;
  readonly requests: ProviderChatRequest[] = [];

  constructor(readonly id: AIProviderId, readonly name: string) {}

  async detect(): Promise<AIProviderStatus> {
    if (this.probeDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.probeDelayMs));
    }
    return {
      id: this.id,
      name: this.name,
      available: this.refuseWith === null,
      installed: true,
      authentication: this.refuseWith === null ? 'connected' : 'error',
      version: '1.0',
      errorMessage: this.refuseWith,
      models: [modelFor(this.id)],
      capabilities: this.capabilities,
    };
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([modelFor(this.id)]);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    this.requests.push(request);
    // A real stream hands its first token back on a later turn of the event
    // loop, and so does this one.
    await Promise.resolve();
    yield { type: 'token', token: `answered by ${this.id}` };
    yield { type: 'done', totalTokens: 4, webSources: [] };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

class MultiProviderRegistry extends AIProviderRegistry {
  constructor(private readonly byId: ReadonlyMap<AIProviderId, DelayedProvider>) {
    super(testAIProviderRegistryInput());
  }
  override require(providerId: AIProviderId): AIProvider {
    const provider = this.byId.get(providerId);
    if (!provider) throw new Error(`No such provider in this test: ${providerId}`);
    return provider;
  }
  override getStatus(providerId: AIProviderId): Promise<AIProviderStatus> {
    return this.require(providerId).detect();
  }
  override async resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo> {
    // Resolution is part of the same window the probe opens, and is as slow.
    await this.require(providerId).detect();
    return modelId === null ? modelFor(providerId) : { ...modelFor(providerId), id: modelId };
  }
}

function collectingOwner(events: ChatStreamEvent[]): ChatEventOwner {
  return {
    id: 2,
    send: (_channel, payload) => {
      events.push(payload as ChatStreamEvent);
    },
    isDestroyed: () => false,
    onDestroyed: () => () => undefined,
  };
}

describe('session binding order, against the real repository', () => {
  let db: InterleafDatabase;
  let chatRepo: ChatRepository;
  let service: ChatService;
  let providers: Map<AIProviderId, DelayedProvider>;
  let registry: MultiProviderRegistry;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    const documents = new DocumentRepository(db);
    for (const [id, hash] of [
      ['doc-binding-a', 'hash-binding-a'],
      ['doc-binding-b', 'hash-binding-b'],
    ]) {
      documents.insert({
        id: id!,
        title: `Document ${id!}`,
        author: 'Leslie',
        format: 'pdf',
        filePath: `/${id!}.pdf`,
        storageMode: 'link',
        fileSize: 1024,
        fileMtimeMs: 1,
        fileHash: hash!,
        pageCount: 4,
      });
      db.raw
        .prepare(
          `INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
           VALUES (?, 'ready', 1, 1, ?, ?, 1)`
        )
        .run(id!, hash!, hash!);
      db.raw
        .prepare(
          `INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
           VALUES (?, ?, 0, 'Replication log and leader consensus mechanism.', 6, '{"format":"pdf","pageIndex":0}', 'Replication', '1')`
        )
        .run(`chunk-${id!}`, id!);
    }

    providers = new Map<AIProviderId, DelayedProvider>([
      ['fake', new DelayedProvider('fake', 'Deterministic Test Provider')],
      ['openrouter', new DelayedProvider('openrouter', 'OpenRouter')],
      ['claude', new DelayedProvider('claude', 'Claude Code')],
      ['codex', new DelayedProvider('codex', 'ChatGPT (subscription)')],
    ]);
    registry = new MultiProviderRegistry(providers);
    chatRepo = new ChatRepository(db);
    service = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: chatRepo,
      context: new AIContextRepository(db),
      providers: registry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  function storedBinding(sessionId: string): { providerId: string; modelId: string | null } {
    const row = db.raw
      .prepare('SELECT provider_id AS providerId, model_id AS modelId FROM chat_sessions WHERE id = ?')
      .get(sessionId) as { providerId: string; modelId: string | null };
    return row;
  }

  it('leaves the conversation on the choice that arrived last, however slowly it was probed', async () => {
    const session = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });

    // The first choice is probed slowly; the second is probed at once. Without
    // ordering, the slow one writes last and the reader is left on a provider
    // they had already moved off.
    providers.get('claude')!.probeDelayMs = 60;
    providers.get('openrouter')!.probeDelayMs = 0;

    const first = service.updateSession({ sessionId: session.id, providerId: 'claude' });
    const second = service.updateSession({ sessionId: session.id, providerId: 'openrouter' });
    const [, latest] = await Promise.all([first, second]);

    expect(latest.providerId).toBe('openrouter');
    expect(storedBinding(session.id)).toEqual({ providerId: 'openrouter', modelId: 'openrouter-default' });
  });

  it('keeps three rapid choices in the order the reader made them', async () => {
    const session = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });
    providers.get('claude')!.probeDelayMs = 80;
    providers.get('openrouter')!.probeDelayMs = 40;
    providers.get('codex')!.probeDelayMs = 0;

    const results = await Promise.all([
      service.updateSession({ sessionId: session.id, providerId: 'claude' }),
      service.updateSession({ sessionId: session.id, providerId: 'openrouter' }),
      service.updateSession({ sessionId: session.id, providerId: 'codex' }),
    ]);

    expect(results.map((row) => row.providerId)).toEqual(['claude', 'openrouter', 'codex']);
    expect(storedBinding(session.id).providerId).toBe('codex');
  });

  it('is what a later reader finds when the conversation is reopened', async () => {
    const session = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });
    providers.get('claude')!.probeDelayMs = 60;
    await Promise.all([
      service.updateSession({ sessionId: session.id, providerId: 'claude' }),
      service.updateSession({ sessionId: session.id, providerId: 'openrouter' }),
    ]);

    // A fresh repository and a fresh service over the same database: the reader
    // reopening the document reads rows, not anything this run held in memory.
    const reopened = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: new ChatRepository(db),
      context: new AIContextRepository(db),
      providers: registry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });
    const listed = reopened.listSessions('doc-binding-a');
    expect(listed.map((row) => ({ providerId: row.providerId, modelId: row.modelId }))).toEqual([
      { providerId: 'openrouter', modelId: 'openrouter-default' },
    ]);
  });

  it('spawns the turn from the binding the reader last asked for, not the one it was mid-way through', async () => {
    const session = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });
    providers.get('openrouter')!.probeDelayMs = 50;

    // The reader chooses, and sends before main has finished writing that choice.
    const rebinding = service.updateSession({ sessionId: session.id, providerId: 'openrouter' });
    const events: ChatStreamEvent[] = [];
    const sent = service.sendMessage(
      { sessionId: session.id, content: 'Explain leader replication' },
      collectingOwner(events)
    );
    await rebinding;
    await sent;
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'done')).toBe(true);
    });

    expect(providers.get('fake')!.requests).toHaveLength(0);
    expect(providers.get('openrouter')!.requests).toHaveLength(1);
  });

  it("does not let one conversation's slow rebinding decide another's", async () => {
    const first = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });
    const second = await service.createSession({ documentId: 'doc-binding-b', providerId: 'fake' });
    providers.get('claude')!.probeDelayMs = 80;
    providers.get('openrouter')!.probeDelayMs = 0;

    const slowOnFirst = service.updateSession({ sessionId: first.id, providerId: 'claude' });
    const quickOnSecond = await service.updateSession({ sessionId: second.id, providerId: 'openrouter' });

    // The second conversation was answered without waiting for the first.
    expect(quickOnSecond.providerId).toBe('openrouter');
    expect(storedBinding(second.id).providerId).toBe('openrouter');
    expect(storedBinding(first.id).providerId).toBe('fake');

    await slowOnFirst;
    expect(storedBinding(first.id).providerId).toBe('claude');
    expect(storedBinding(second.id).providerId).toBe('openrouter');
  });

  it('leaves the stored binding alone when the chosen provider is refused', async () => {
    const session = await service.createSession({ documentId: 'doc-binding-a', providerId: 'fake' });
    providers.get('claude')!.refuseWith = 'Claude Code is not signed in.';

    await expect(service.updateSession({ sessionId: session.id, providerId: 'claude' })).rejects.toThrow(
      'Claude Code is not signed in.'
    );
    expect(storedBinding(session.id).providerId).toBe('fake');

    // And the refusal does not wedge the queue: the next choice is still served.
    const next = await service.updateSession({ sessionId: session.id, providerId: 'openrouter' });
    expect(next.providerId).toBe('openrouter');
    expect(storedBinding(session.id).providerId).toBe('openrouter');
  });
});
