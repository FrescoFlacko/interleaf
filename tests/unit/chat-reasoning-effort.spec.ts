import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { MIGRATIONS, applyMigrations, runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService, type ChatEventOwner } from '@main/ai/chat-service';
import { effortForTurn, requireOfferedEffort } from '@main/ai/reasoning-effort';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, AIProviderStatus, ChatStreamEvent } from '@shared/types/ai';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';
import { silentLogger } from '../helpers/silent-logger';

/**
 * Reader Chat reasoning effort, end to end inside main: the v28 column, the
 * atomic binding write, and the send-time snapshot that refuses a level the
 * bound model no longer offers instead of silently changing it.
 */

const EFFORT_VERSION = 28;

const reasoningModel: AIModelInfo = {
  id: 'fake-grounded',
  name: 'Deterministic Grounded Model',
  contextWindow: 32_000,
  maxOutputTokens: 2_048,
  supportsStreaming: true,
  reasoning: { levels: ['low', 'medium', 'high'] },
};

class RecordingProvider implements AIProvider {
  readonly id = 'fake' as const;
  readonly name = 'Recording Provider';
  readonly capabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  };
  readonly requests: ProviderChatRequest[] = [];

  detect(): Promise<AIProviderStatus> {
    return Promise.resolve({
      id: this.id,
      name: this.name,
      available: true,
      installed: true,
      authentication: 'connected',
      version: '1.0',
      errorMessage: null,
      models: [reasoningModel],
      capabilities: this.capabilities,
    });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([reasoningModel]);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    this.requests.push(request);
    await Promise.resolve();
    yield { type: 'token', token: 'Answer.' };
    yield { type: 'done', totalTokens: 1 };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

class TestRegistry extends AIProviderRegistry {
  effectiveModel: AIModelInfo = reasoningModel;
  constructor(private readonly provider: AIProvider) {
    super(testAIProviderRegistryInput());
  }
  override require(): AIProvider {
    return this.provider;
  }
  override getStatus(): Promise<AIProviderStatus> {
    return this.provider.detect();
  }
  override resolveModel(): Promise<AIModelInfo> {
    return Promise.resolve(this.effectiveModel);
  }
}

function seedDocument(db: InterleafDatabase): void {
  new DocumentRepository(db).insert({
    id: 'doc-effort',
    title: 'Effort',
    author: null,
    format: 'pdf',
    filePath: '/effort.pdf',
    storageMode: 'link',
    fileSize: 1024,
    fileMtimeMs: 1,
    fileHash: 'hash-effort',
    pageCount: 2,
  });
}

function waitForDone(events: readonly ChatStreamEvent[]): Promise<void> {
  return vi.waitFor(() => {
    if (!events.some((event) => event.type === 'done' || event.type === 'error')) throw new Error('still streaming');
  });
}

describe('reasoning effort migration (v28)', () => {
  let db: InterleafDatabase;
  beforeEach(() => { db = InterleafDatabase.open(':memory:'); });
  afterEach(() => { db.close(); });

  it('is appended after every checksum-protected step', () => {
    expect(MIGRATIONS[EFFORT_VERSION - 1]).toMatchObject({ version: EFFORT_VERSION, name: 'chat_session_reasoning_effort' });
  });

  it('upgrades an existing conversation to Default without rewriting it', () => {
    applyMigrations(db, MIGRATIONS.slice(0, EFFORT_VERSION - 1));
    seedDocument(db);
    db.raw.prepare(`
      INSERT INTO chat_sessions (id, document_id, title, provider_id, model_id, document_hash)
      VALUES ('session-old', 'doc-effort', 'Existing chat', 'codex', 'gpt-x', 'hash-effort')
    `).run();
    runMigrations(db);
    const session = new ChatRepository(db).requireCurrentSession('session-old');
    expect(session.reasoningEffort).toBeNull();
    expect(session.modelId).toBe('gpt-x');
  });

  it('refuses a stored value outside the shared vocabulary', () => {
    runMigrations(db);
    seedDocument(db);
    const insert = (effort: string) => db.raw.prepare(`
      INSERT INTO chat_sessions (id, document_id, title, provider_id, model_id, document_hash, reasoning_effort)
      VALUES (?, 'doc-effort', 'Chat', 'codex', 'gpt-x', 'hash-effort', ?)
    `).run(`session-${effort}`, effort);
    expect(() => insert('ultra')).toThrow(/CHECK/u);
    expect(() => insert('xhigh')).not.toThrow();
  });
});

describe('reasoning effort guards', () => {
  const offered = { levels: ['low', 'high'] as const };

  it('accepts Default and offered levels, and refuses anything else', () => {
    expect(() => { requireOfferedEffort({ levels: [...offered.levels] }, null); }).not.toThrow();
    expect(() => { requireOfferedEffort(null, undefined); }).not.toThrow();
    expect(() => { requireOfferedEffort({ levels: [...offered.levels] }, 'high'); }).not.toThrow();
    expect(() => { requireOfferedEffort({ levels: [...offered.levels] }, 'max'); }).toThrow(/does not offer/u);
    expect(() => { requireOfferedEffort(null, 'low'); }).toThrow(/does not offer/u);
  });

  it('sends nothing for Default and refuses a level the model no longer offers', () => {
    expect(effortForTurn({ levels: ['low'] }, null)).toBeUndefined();
    expect(effortForTurn({ levels: ['low'] }, 'low')).toBe('low');
    expect(() => effortForTurn({ levels: ['low'] }, 'high')).toThrow(/no longer offers the High reasoning effort/u);
    expect(() => effortForTurn(null, 'low')).toThrow(/no longer offers/u);
  });
});

describe('ChatService reasoning effort', () => {
  let db: InterleafDatabase;
  let provider: RecordingProvider;
  let registry: TestRegistry;
  let service: ChatService;
  const events: ChatStreamEvent[] = [];
  const owner: ChatEventOwner = {
    id: 1,
    send: (_channel, payload) => { events.push(payload as ChatStreamEvent); },
    isDestroyed: () => false,
    onDestroyed: () => () => undefined,
  };

  beforeEach(() => {
    events.length = 0;
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    seedDocument(db);
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES ('c1', 'doc-effort', 0, 'Leader election.', 2, '{"format":"pdf","pageIndex":0}', 'Intro', '1')
    `).run();
    db.raw.prepare(`
      INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES ('doc-effort', 'ready', 1, 1, 'hash-effort', 'hash-effort', 1)
    `).run();
    provider = new RecordingProvider();
    registry = new TestRegistry(provider);
    service = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: new ChatRepository(db),
      context: new AIContextRepository(db),
      providers: registry,
      requireDocumentOpen: () => undefined,
      log: silentLogger,
    });
  });

  afterEach(async () => {
    await service.shutdown();
    db.close();
  });

  it('stores a draft choice on create and refuses one the model does not offer', async () => {
    const session = await service.createSession({ documentId: 'doc-effort', providerId: 'fake', reasoningEffort: 'high' });
    expect(session.reasoningEffort).toBe('high');
    await expect(service.createSession({ documentId: 'doc-effort', providerId: 'fake', reasoningEffort: 'max' }))
      .rejects.toThrow(/does not offer/u);
    expect(service.listSessions('doc-effort')).toHaveLength(1);
  });

  it('writes model and level together, and a plain model change chooses Default', async () => {
    const session = await service.createSession({ documentId: 'doc-effort', providerId: 'fake' });
    const bound = await service.updateSession({ sessionId: session.id, modelId: 'fake-grounded', reasoningEffort: 'low' });
    expect(bound).toMatchObject({ modelId: 'fake-grounded', reasoningEffort: 'low' });

    await expect(service.updateSession({ sessionId: session.id, modelId: 'fake-grounded', reasoningEffort: 'max' }))
      .rejects.toThrow(/does not offer/u);
    // A refused write leaves the whole binding as it was.
    expect(service.listSessions('doc-effort')[0]?.reasoningEffort).toBe('low');

    const titled = await service.updateSession({ sessionId: session.id, title: 'Renamed' });
    expect(titled.reasoningEffort).toBe('low');
    const remodelled = await service.updateSession({ sessionId: session.id, modelId: 'fake-grounded' });
    expect(remodelled.reasoningEffort).toBeNull();
  });

  it('snapshots the stored level into the turn and sends nothing for Default', async () => {
    const session = await service.createSession({ documentId: 'doc-effort', providerId: 'fake', reasoningEffort: 'medium' });
    await service.sendMessage({ sessionId: session.id, content: 'Explain' }, owner);
    await waitForDone(events);
    expect(provider.requests[0]?.reasoningEffort).toBe('medium');

    events.length = 0;
    await service.updateSession({ sessionId: session.id, reasoningEffort: null });
    await service.sendMessage({ sessionId: session.id, content: 'Again' }, owner);
    await waitForDone(events);
    expect(provider.requests[1]).not.toHaveProperty('reasoningEffort');
  });

  it('refuses a turn whose saved level the model no longer offers, keeping the level and the thread', async () => {
    const session = await service.createSession({ documentId: 'doc-effort', providerId: 'fake', reasoningEffort: 'high' });
    registry.effectiveModel = { ...reasoningModel, reasoning: { levels: ['low'] } };
    await expect(service.sendMessage({ sessionId: session.id, content: 'Explain' }, owner))
      .rejects.toThrow(/no longer offers the High reasoning effort/u);
    expect(provider.requests).toHaveLength(0);
    expect(service.listMessages(session.id)).toHaveLength(0);
    expect(service.listSessions('doc-effort')[0]?.reasoningEffort).toBe('high');
  });
});
