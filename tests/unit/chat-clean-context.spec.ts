import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService, type ChatEventOwner } from '@main/ai/chat-service';
import {
  CHAT_COMPACTION_INSTRUCTION,
  CHAT_COMPACTION_SYSTEM_PROMPT,
} from '@shared/constants/ai';
import type { Logger } from '@main/logging/logger';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

/**
 * `Clean Context` — main-owned, bounded conversation compaction.
 *
 * The transcript is never deleted: what changes is how much of it is replayed.
 * Main resolves the session's own provider and model, makes exactly one bounded
 * call, and then atomically stores the model's summary, records the boundary it
 * summarised through, and drops every attached context item. Any failure on
 * that path must leave all three untouched.
 */

const testModel: AIModelInfo = {
  id: 'fake-model',
  name: 'Fake Model',
  contextWindow: 8_000,
  maxOutputTokens: 500,
  supportsStreaming: true,
};

class ScriptedProvider implements AIProvider {
  readonly id = 'fake' as const;
  readonly name = 'Scripted Provider';
  readonly capabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  };

  /** Every request this provider has been handed, in order. */
  readonly requests: ProviderChatRequest[] = [];
  summaryTokens: readonly string[] = ['The reader asked about quorums; ', 'the answer covered leader election.'];
  failWith: Error | null = null;
  answerTokens: readonly string[] = ['Answer text.'];
  /** Held open so a test can act while exactly one compaction is in flight. */
  compactionGate: Promise<void> | null = null;
  /** Resolves as soon as a compaction stream has started. */
  compactionStarted: Promise<void>;
  private announceStart!: () => void;
  readonly cancelled: string[] = [];
  /** Held open so a test can act while a send is still probing readiness. */
  detectGate: Promise<void> | null = null;
  private readonly detectWaiters: (() => void)[] = [];

  constructor() {
    this.compactionStarted = new Promise<void>((resolve) => { this.announceStart = resolve; });
  }

  /** Resolves the next time readiness is probed; arm it before the call. */
  nextDetect(): Promise<void> {
    return new Promise<void>((resolve) => { this.detectWaiters.push(resolve); });
  }

  async detect(): Promise<AIProviderStatus> {
    for (const waiter of this.detectWaiters.splice(0)) waiter();
    if (this.detectGate) await this.detectGate;
    return {
      id: this.id,
      name: this.name,
      available: true,
      installed: true,
      authentication: 'connected',
      version: '1.0',
      errorMessage: null,
      models: [testModel],
      capabilities: this.capabilities,
    };
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([testModel]);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    await Promise.resolve();
    this.requests.push(request);
    const isCompaction = request.systemPrompt === CHAT_COMPACTION_SYSTEM_PROMPT;
    if (isCompaction) {
      this.announceStart();
      if (this.compactionGate) await this.compactionGate;
      if (this.failWith) throw this.failWith;
    }
    for (const token of isCompaction ? this.summaryTokens : this.answerTokens) {
      yield { type: 'token', token };
    }
    yield { type: 'done', totalTokens: 4 };
  }

  cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
    return Promise.resolve();
  }
}

class TestProviderRegistry extends AIProviderRegistry {
  constructor(private readonly overrideProvider: AIProvider) {
    super(testAIProviderRegistryInput());
  }
  override require(): AIProvider {
    return this.overrideProvider;
  }
  override getStatus(): Promise<AIProviderStatus> {
    return this.overrideProvider.detect();
  }
  /** Held open so a test can act while a rebind is still resolving its model. */
  modelGate: Promise<void> | null = null;
  private readonly modelWaiters: (() => void)[] = [];

  /** Resolves the next time a model is resolved; arm it before the call. */
  nextModel(): Promise<void> {
    return new Promise<void>((resolve) => { this.modelWaiters.push(resolve); });
  }

  override async resolveModel(): Promise<AIModelInfo> {
    for (const waiter of this.modelWaiters.splice(0)) waiter();
    if (this.modelGate) await this.modelGate;
    return testModel;
  }
}

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const owner: ChatEventOwner = { id: 1, send: () => undefined, isDestroyed: () => false, onDestroyed: () => () => undefined };

/** A latch a test holds a compaction open with. */
function openGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('ChatService.cleanContext', () => {
  let db: InterleafDatabase;
  let chatRepo: ChatRepository;
  let provider: ScriptedProvider;
  let registry: TestProviderRegistry;
  let chatService: ChatService;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-clean',
      title: 'Designing Distributed Consensus',
      author: 'Martin',
      format: 'pdf',
      filePath: '/tmp/doc-clean.pdf',
      storageMode: 'managed',
      fileSize: 1024,
      fileMtimeMs: 1000,
      fileHash: 'h-doc-clean',
      pageCount: 10,
    });
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES
        ('c1', 'doc-clean', 0, 'Replication log and leader consensus mechanism.', 6, '{"format":"pdf","pageIndex":0}', 'Replication', '1'),
        ('c2', 'doc-clean', 1, 'Followers replicate state machine writes.', 5, '{"format":"pdf","pageIndex":1}', 'State Machine', '2')
    `).run();
    db.raw.prepare(`
      INSERT INTO document_index_state (
        document_id, status, total_chunks, indexed_chunks, document_hash,
        published_document_hash, published_total_chunks
      ) VALUES ('doc-clean', 'ready', 2, 2, 'h-doc-clean', 'h-doc-clean', 2)
    `).run();

    chatRepo = new ChatRepository(db);
    provider = new ScriptedProvider();
    registry = new TestProviderRegistry(provider);
    chatService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: chatRepo,
      context: new AIContextRepository(db),
      providers: registry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });
  });

  afterEach(() => { db.close(); });

  async function settle(sessionId: string, minAssistants = 1): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const assistants = chatService.listMessages(sessionId).filter((message) => message.role === 'assistant');
      const last = assistants.at(-1);
      if (assistants.length >= minAssistants && last && last.status !== 'streaming') return;
      if (Date.now() > deadline) throw new Error('Turn did not settle');
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
  }

  /** Only the compaction calls, so a test can assert none was ever made. */
  function compactionRequests(): readonly ProviderChatRequest[] {
    return provider.requests.filter((request) => request.systemPrompt === CHAT_COMPACTION_SYSTEM_PROMPT);
  }

  async function seedConversation(title = 'Quorums'): Promise<string> {
    const session = await chatService.createSession({
      documentId: 'doc-clean',
      title,
      providerId: 'fake',
    });
    chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-clean',
      documentHash: 'h-doc-clean',
      input: { kind: 'location', location: { format: 'pdf', pageIndex: 0 } },
    });
    await chatService.sendMessage({ sessionId: session.id, content: 'What is a quorum?' }, owner);
    await settle(session.id);
    return session.id;
  }

  it('summarises with the session provider, persists the boundary, and clears context', async () => {
    const sessionId = await seedConversation();
    expect(chatService.listContext(sessionId)).toHaveLength(1);

    const result = await chatService.cleanContext(sessionId);

    expect(result.sessionId).toBe(sessionId);
    expect(result.clearedContextItemIds).toHaveLength(1);
    expect(result.compactedThroughOrdinal).toBe(1);
    expect(chatService.listContext(sessionId)).toEqual([]);
    // Compaction, not deletion: the transcript stays readable.
    expect(chatService.listMessages(sessionId)).toHaveLength(2);

    const state = chatRepo.getCompactionState(sessionId);
    expect(state.compactedThroughOrdinal).toBe(1);
    expect(state.summary).toBe('The reader asked about quorums; the answer covered leader election.');

    const compaction = provider.requests.at(-1);
    expect(compaction?.systemPrompt).toBe(CHAT_COMPACTION_SYSTEM_PROMPT);
    expect(compaction?.modelId).toBe(testModel.id);
    expect(compaction?.webSearch).toBe(false);
    expect(compaction?.sources).toEqual([]);
    expect(compaction?.history).toEqual([]);
    // Exactly one provider call for the compaction itself.
    expect(provider.requests.filter((request) => request.systemPrompt === CHAT_COMPACTION_SYSTEM_PROMPT))
      .toHaveLength(1);
  });

  it('replays the stored summary as untrusted data, never as a system instruction', async () => {
    const sessionId = await seedConversation();
    await chatService.cleanContext(sessionId);

    await chatService.sendMessage({ sessionId, content: 'And after that?' }, owner);
    await settle(sessionId, 2);

    const answer = provider.requests.at(-1);
    expect(answer).toBeDefined();
    expect(answer!.systemPrompt).not.toContain('leader election');
    expect(answer!.contextXml).toContain('leader election');
    // Only the post-boundary turn is replayed as history.
    expect(answer!.history.map((message) => message.content)).not.toContain('What is a quorum?');
  });

  it('leaves every piece of state untouched when the provider fails', async () => {
    const sessionId = await seedConversation();
    provider.failWith = new Error('provider exploded');

    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/could not/iu);

    expect(chatService.listContext(sessionId)).toHaveLength(1);
    expect(chatRepo.getCompactionState(sessionId)).toEqual({
      summary: null,
      compactedThroughOrdinal: null,
    });
    expect(chatService.listMessages(sessionId)).toHaveLength(2);
  });

  it('refuses while a response is still streaming', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-clean',
      title: 'Busy',
      providerId: 'fake',
    });
    provider.answerTokens = ['slow'];
    await chatService.sendMessage({ sessionId: session.id, content: 'Question?' }, owner);
    // The turn is accepted with a streaming assistant message in place.
    await expect(chatService.cleanContext(session.id)).rejects.toThrow(/active response|generating/iu);
    await settle(session.id);
  });

  it('refuses an archived session', async () => {
    const sessionId = await seedConversation();
    db.raw.prepare("UPDATE documents SET file_hash = 'h-doc-clean-v2' WHERE id = 'doc-clean'").run();
    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/archived/iu);
  });

  it('refuses when there is nothing meaningful to summarise', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-clean',
      title: 'Empty',
      providerId: 'fake',
    });
    await expect(chatService.cleanContext(session.id)).rejects.toThrow(/nothing/iu);
    expect(provider.requests).toHaveLength(0);
  });

  it('replaces the prior summary when cleaned again', async () => {
    const sessionId = await seedConversation();
    await chatService.cleanContext(sessionId);
    await chatService.sendMessage({ sessionId, content: 'Follow-up question?' }, owner);
    await settle(sessionId, 2);

    provider.summaryTokens = ['Second summary.'];
    const second = await chatService.cleanContext(sessionId);

    expect(second.compactedThroughOrdinal).toBe(3);
    const state = chatRepo.getCompactionState(sessionId);
    expect(state.summary).toBe('Second summary.');
    // The prior summary is folded into the new input rather than accumulating.
    const compactionInputs = provider.requests
      .filter((request) => request.systemPrompt === CHAT_COMPACTION_SYSTEM_PROMPT)
      .map((request) => request.contextXml);
    expect(compactionInputs).toHaveLength(2);
    // The prior summary is carried forward once, inside the data envelope.
    expect(compactionInputs[1]).toContain('leader election');
    expect(compactionInputs[1]).toContain('Follow-up question?');
    expect(compactionInputs[1]?.match(/<previous-summary>/gu)).toHaveLength(1);
    const secondRequest = provider.requests.at(-1);
    expect(secondRequest?.userMessage).toBe(CHAT_COMPACTION_INSTRUCTION);
    expect(secondRequest?.systemPrompt).not.toContain('leader election');
  });

  it('refuses a second clean while one is in flight, and releases the lock after it', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    provider.compactionGate = gate.promise;

    const first = chatService.cleanContext(sessionId);
    await provider.compactionStarted;
    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/already being cleaned/iu);
    // Reading the conversation while it is being cleaned stays allowed.
    expect(chatService.listMessages(sessionId)).toHaveLength(2);

    gate.open();
    await expect(first).resolves.toMatchObject({ compactedThroughOrdinal: 1 });
    expect(
      provider.requests.filter((request) => request.systemPrompt === CHAT_COMPACTION_SYSTEM_PROMPT)
    ).toHaveLength(1);
  });

  it('refuses every mutation that would race a clean in flight', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    provider.compactionGate = gate.promise;

    const pending = chatService.cleanContext(sessionId);
    await provider.compactionStarted;

    const racing = /being cleaned/iu;
    await expect(
      chatService.sendMessage({ sessionId, content: 'A turn mid-clean?' }, owner)
    ).rejects.toThrow(racing);
    await expect(chatService.updateSession({ sessionId, modelId: 'fake-model' })).rejects.toThrow(racing);
    expect(() =>
      chatService.attachContext({
        sessionId,
        documentId: 'doc-clean',
        documentHash: 'h-doc-clean',
        input: { kind: 'location', location: { format: 'pdf', pageIndex: 1 } },
      })
    ).toThrow(racing);
    const attached = chatService.listContext(sessionId).at(0);
    expect(attached).toBeDefined();
    expect(() => { chatService.removeContext(sessionId, attached!.id); }).toThrow(racing);

    gate.open();
    await expect(pending).resolves.toMatchObject({ sessionId });
  });

  it('does not commit a compaction that shutdown overtook', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    provider.compactionGate = gate.promise;

    const pending = chatService.cleanContext(sessionId);
    await provider.compactionStarted;
    const closing = chatService.shutdown();
    gate.open();

    await expect(pending).rejects.toThrow(/could not clean|shutting down/iu);
    await closing;
    expect(chatRepo.getCompactionState(sessionId)).toEqual({
      summary: null,
      compactedThroughOrdinal: null,
    });
    expect(chatService.listContext(sessionId)).toHaveLength(1);
    // The in-flight compaction request was cancelled by name.
    expect(provider.cancelled.length).toBeGreaterThan(0);
  });

  it('refuses a summary written from a transcript that has since changed', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    provider.compactionGate = gate.promise;

    const pending = chatService.cleanContext(sessionId);
    await provider.compactionStarted;
    // A message appearing behind main's back — a path that never went through the
    // service guard — must not be silently claimed by the summary's boundary.
    db.raw.prepare(`
      INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
      VALUES (?, ?, 'user', 2, 'Inserted underneath the clean', 'complete')
    `).run(`${sessionId}-race`, sessionId);
    gate.open();

    await expect(pending).rejects.toThrow(/changed while/iu);
    expect(chatRepo.getCompactionState(sessionId).summary).toBeNull();
    expect(chatService.listContext(sessionId)).toHaveLength(1);
  });

  it('leaves every message the boundary did not summarise replayable', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-clean',
      title: 'Longer than one window',
      providerId: 'fake',
    });
    const insert = db.raw.prepare(`
      INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const total = 12;
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      const isAssistant = ordinal % 2 === 1;
      insert.run(
        `${session.id}-m${String(ordinal)}`,
        session.id,
        isAssistant ? 'assistant' : 'user',
        ordinal,
        // A cancelled turn with partial text is still replayed, so the boundary
        // may not cross it without the summary standing for it.
        `Turn ${String(ordinal)}: ${'consensus '.repeat(300)}`,
        ordinal === 1 ? 'cancelled' : 'complete'
      );
    }

    const result = await chatService.cleanContext(session.id);

    const boundary = result.compactedThroughOrdinal;
    // The window cannot hold the whole conversation, so this is a real prefix.
    expect(boundary).toBeGreaterThanOrEqual(1);
    expect(boundary).toBeLessThan(total - 1);
    const envelope = compactionRequests().at(-1)?.contextXml ?? '';
    for (let ordinal = 0; ordinal <= boundary; ordinal += 1) {
      expect(envelope).toContain(`Turn ${String(ordinal)}:`);
    }
    // Everything the summary did not cover is left for normal replay, in order,
    // and a later clean takes it in turn.
    const replayable = chatRepo.listReplayableMessages(session.id);
    expect(replayable.map((message) => message.ordinal)).toEqual(
      Array.from({ length: total - boundary - 1 }, (_unused, index) => boundary + 1 + index)
    );
    for (const message of replayable) expect(message.content).toContain('consensus');
  });

  it('refuses a clean that arrives while a send is still checking readiness', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    provider.detectGate = gate.promise;
    const probing = provider.nextDetect();

    const send = chatService.sendMessage({ sessionId, content: 'A second question?' }, owner);
    await probing;
    // The send has not persisted anything yet, so nothing but main's own
    // reservation can refuse this — and it must, before any provider call.
    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/finishing another change/iu);
    expect(compactionRequests()).toHaveLength(0);
    expect(provider.cancelled).toEqual([]);

    gate.open();
    provider.detectGate = null;
    await expect(send).resolves.toMatchObject({ requestId: expect.any(String) });
    // The turn now protects itself: the reservation handed off without a gap.
    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/Stop the active response/iu);
    expect(compactionRequests()).toHaveLength(0);

    await settle(sessionId, 2);
    // And the reservation was released, so a clean is accepted again afterwards.
    await expect(chatService.cleanContext(sessionId)).resolves.toMatchObject({ sessionId });
    expect(compactionRequests()).toHaveLength(1);
  });

  it('refuses a clean that arrives while a session rebind is still resolving its model', async () => {
    const sessionId = await seedConversation();
    const gate = openGate();
    registry.modelGate = gate.promise;
    const resolving = registry.nextModel();

    const pending = chatService.updateSession({ sessionId, modelId: 'fake-model' });
    await resolving;
    await expect(chatService.cleanContext(sessionId)).rejects.toThrow(/finishing another change/iu);
    expect(compactionRequests()).toHaveLength(0);

    gate.open();
    registry.modelGate = null;
    await expect(pending).resolves.toMatchObject({ modelId: 'fake-model' });
    await expect(chatService.cleanContext(sessionId)).resolves.toMatchObject({ sessionId });
    expect(compactionRequests()).toHaveLength(1);
  });

  it('releases the reservation when the operation that took it fails', async () => {
    const sessionId = await seedConversation();
    registry.modelGate = Promise.reject(new Error('model lookup failed'));

    await expect(chatService.updateSession({ sessionId, modelId: 'fake-model' })).rejects.toThrow(/model lookup/iu);
    registry.modelGate = null;
    await expect(chatService.cleanContext(sessionId)).resolves.toMatchObject({ sessionId });
  });
});
