import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService, type ChatEventOwner, type ChatProviderGateway } from '@main/ai/chat-service';
import type { Logger } from '@main/logging/logger';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, AIProviderStatus, ChatContextItem, ChatMessage, ChatStreamEvent, ChatWebSource } from '@shared/types/ai';
import { CHAT_REPLAY_MAX_SOURCES } from '@shared/constants/ai';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';
import { isChatMessage, isChatStreamEvent } from '../../src/preload/wire-guards';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const testModel: AIModelInfo = {
  id: 'fake-grounded',
  name: 'Deterministic Grounded Model',
  contextWindow: 32_000,
  maxOutputTokens: 2_048,
  supportsStreaming: true,
};

class ControlledTestProvider implements AIProvider {
  readonly id = 'fake' as const;
  readonly name = 'Controlled Test Provider';
  readonly capabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  };

  shouldThrow = false;
  abortControllers = new Map<string, AbortController>();
  canceledRequests = new Set<string>();

  detect(): Promise<AIProviderStatus> {
    return Promise.resolve({
      id: this.id,
      name: this.name,
      available: true,
      installed: true,
      authentication: 'connected',
      version: '1.0',
      errorMessage: null,
      models: [testModel],
      capabilities: this.capabilities,
    });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([testModel]);
  }

  lastRequest: ProviderChatRequest | null = null;
  /** The reply, one provider chunk per entry. */
  tokens: readonly string[] = ['Here ', 'is ', 'the ', 'answer ', '[src-1] ', 'and ', 'an ', 'unknown ', '[src-999].'];
  /** Structured search metadata a provider reports with its done event. */
  webSources: readonly ChatWebSource[] = [];
  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    this.lastRequest = request;
    const controller = new AbortController();
    this.abortControllers.set(request.requestId, controller);
    if (this.shouldThrow) {
      throw new Error('Simulated provider runtime error');
    }
    for (const token of this.tokens) {
      if (controller.signal.aborted) return;
      yield { type: 'token', token };
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (!controller.signal.aborted) {
      yield { type: 'done', totalTokens: 9, webSources: this.webSources };
    }
  }

  cancel(requestId: string): Promise<void> {
    this.canceledRequests.add(requestId);
    this.abortControllers.get(requestId)?.abort();
    return Promise.resolve();
  }
}

/** A live window owner that records every chat event it is sent. */
function recordingOwner(events: ChatStreamEvent[]): ChatEventOwner {
  return { id: 1, send: (_channel, payload) => { events.push(payload as ChatStreamEvent); }, isDestroyed: () => false, onDestroyed: () => () => undefined };
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
  /** The binding the send path resolves; a test may rebind it mid-session. */
  effectiveModel: AIModelInfo = testModel;
  override resolveModel(): Promise<AIModelInfo> {
    return Promise.resolve(this.effectiveModel);
  }
}

describe('ChatService', () => {
  let db: InterleafDatabase;
  let chatRepo: ChatRepository;
  let contextRepo: AIContextRepository;
  let providerRegistry: TestProviderRegistry;
  let testProvider: ControlledTestProvider;
  let chatService: ChatService;
  let openDocuments: Set<string>;
  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-chat-service',
      title: 'Distributed Systems',
      author: 'Martin',
      format: 'pdf',
      filePath: '/dist.pdf',
      storageMode: 'link',
      fileSize: 1024,
      fileMtimeMs: 1,
      fileHash: 'hash-dist',
      pageCount: 10,
    });

    // Insert indexed text chunks
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES
        ('c1', 'doc-chat-service', 0, 'Replication log and leader consensus mechanism.', 6, '{"format":"pdf","pageIndex":0}', 'Replication', '1'),
        ('c2', 'doc-chat-service', 1, 'Followers replicate state machine writes.', 5, '{"format":"pdf","pageIndex":1}', 'State Machine', '2')
    `).run();

    db.raw.prepare(`
      INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES ('doc-chat-service', 'ready', 2, 2, 'hash-dist', 'hash-dist', 2)
    `).run();

    chatRepo = new ChatRepository(db);
    contextRepo = new AIContextRepository(db);
    testProvider = new ControlledTestProvider();
    providerRegistry = new TestProviderRegistry(testProvider);

    openDocuments = new Set(['doc-chat-service']);
    chatService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: chatRepo,
      context: contextRepo,
      providers: providerRegistry,
      requireDocumentOpen: (docId: string) => {
        if (!openDocuments.has(docId)) {
          throw new Error('Document is not open.');
        }
      },
      log: logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('streams chat tokens, validates citations, and finalizes assistant message', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Consensus Q&A',
      providerId: 'fake',
    });

    const emittedEvents: ChatStreamEvent[] = [];
    const owner = recordingOwner(emittedEvents);

    const result = await chatService.sendMessage(
      { sessionId: session.id, content: 'Explain leader replication' },
      owner
    );

    expect(result.userMessage.content).toBe('Explain leader replication');
    expect(result.assistantMessage.status).toBe('streaming');

    // Wait for the stream to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (emittedEvents.some((e) => e.type === 'done')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const doneEvent = emittedEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === 'done') {
      expect(doneEvent.message.status).toBe('complete');
      expect(doneEvent.message.content).toContain('Here is the answer [src-1] and an unknown [src-999].');
      // Only valid [src-1] should be parsed as citation, [src-999] was not in envelope and must be ignored
      expect(doneEvent.message.citations).toHaveLength(1);
      expect(doneEvent.message.citations[0]?.sourceId).toBe('src-1');
      expect(doneEvent.message.citations[0]?.label).toContain('Page 1');
    }

    // Verify persisted message in DB
    const messages = chatService.listMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.status).toBe('complete');
    expect(messages[1]?.citations).toHaveLength(1);

    // Verify resolveCitation works for src-1 and returns null for src-999
    const target = chatService.resolveCitation(session.id, messages[1]!.id, 'src-1');
    expect(target).toMatchObject({
      documentId: 'doc-chat-service',
      sourceId: 'src-1',
      location: { format: 'pdf', pageIndex: 0 },
    });
    expect(chatService.resolveCitation(session.id, messages[1]!.id, 'src-999')).toBeNull();
  });

  it('delivers a reply longer than the old bridge cap as a done event the preload accepts', async () => {
    // 150,000 units: past the 131,072 the preload guard used to allow, so the
    // renderer would have dropped the done event and stayed in streaming state.
    testProvider.tokens = Array.from({ length: 30 }, () => 'y'.repeat(5_000));
    const session = await chatService.createSession({ documentId: 'doc-chat-service', title: 'Long reply', providerId: 'fake' });
    const events: ChatStreamEvent[] = [];
    const owner = recordingOwner(events);

    const result = await chatService.sendMessage({ sessionId: session.id, content: 'Write at length' }, owner);
    expect(isChatMessage(result.userMessage)).toBe(true);
    expect(isChatMessage(result.assistantMessage)).toBe(true);
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'done')).toBe(true); });

    for (const event of events) expect(isChatStreamEvent(event)).toBe(true);
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' ? done.message.content.length : 0).toBe(150_000);
    for (const message of chatService.listMessages(session.id)) expect(isChatMessage(message)).toBe(true);
  });

  it('delivers a citation whose indexed heading makes its label longer than the wire allows', async () => {
    // A 500-unit heading is valid in the index; the label composed from it,
    // "Page 1 · " plus the heading, is 509 units. The citation must still reach
    // the renderer, in the done event and in history, with its source intact.
    const heading = 'H'.repeat(500);
    db.raw.prepare(`UPDATE document_text_chunks SET heading = ?, page_label = '1' WHERE id = 'c1'`).run(heading);
    testProvider.tokens = ['Leaders replicate the log [src-1][src-2].'];
    const session = await chatService.createSession({ documentId: 'doc-chat-service', title: 'Long heading', providerId: 'fake' });
    const events: ChatStreamEvent[] = [];
    const owner = recordingOwner(events);

    await chatService.sendMessage({ sessionId: session.id, content: 'Explain leader replication' }, owner);
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(true); });

    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(isChatStreamEvent(done)).toBe(true);
    const expectLongCitation = (message: ChatMessage | undefined): void => {
      const citation = message?.citations.find((item) => item.heading === heading);
      expect(citation).toBeDefined();
      expect(citation?.sourceId).toMatch(/^src-\d+$/u);
      expect(citation?.pageLabel).toBe('1');
      expect(citation?.label).toBe(`Page 1 · ${heading}`.slice(0, 500));
    };
    expectLongCitation(done?.type === 'done' ? done.message : undefined);

    const history = chatService.listMessages(session.id);
    for (const message of history) expect(isChatMessage(message)).toBe(true);
    expectLongCitation(history.find((message) => message.role === 'assistant'));
  });

  it('reports the last packed request, and only under the binding that packed it', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Budget Q&A',
      providerId: 'fake',
    });
    const events: ChatStreamEvent[] = [];
    const owner = recordingOwner(events);

    // Nothing has been packed: main reports nothing rather than a forecast.
    expect(await chatService.getContextBudget(session.id)).toBeNull();

    await chatService.sendMessage({ sessionId: session.id, content: 'Explain leader replication' }, owner);
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'done')).toBe(true); });
    const budget = await chatService.getContextBudget(session.id);
    expect(budget).not.toBeNull();
    expect(budget?.sessionId).toBe(session.id);
    expect(budget?.providerId).toBe('fake');
    expect(budget?.modelId).toBe(testModel.id);
    expect(budget?.totalTokens).toBe(testModel.contextWindow);
    expect(budget?.reservedOutputTokens).toBe(testModel.maxOutputTokens);
    expect(budget?.usedTokens).toBeGreaterThan(0);
    expect(budget?.sourceCount).toBeGreaterThan(0);

    // The effective model changes without the session row changing — exactly
    // what a reconfigured provider default does. The stale figure is withheld
    // and the conversation is packed again for the model now in force.
    providerRegistry.effectiveModel = { ...testModel, id: 'fake-other', contextWindow: 16_000 };
    const rebound = await chatService.getContextBudget(session.id);
    expect(rebound?.modelId).toBe('fake-other');
    expect(rebound?.totalTokens).toBe(16_000);
    expect(rebound?.usedTokens).toBeGreaterThan(0);

    providerRegistry.effectiveModel = testModel;
    expect(await chatService.getContextBudget(session.id)).not.toBeNull();

    chatService.deleteSession(session.id);
    await expect(chatService.getContextBudget(session.id)).rejects.toThrow();
  });

  it('rebuilds the budget from the persisted conversation after a restart', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Budget after restart',
      providerId: 'fake',
    });
    const events: ChatStreamEvent[] = [];
    const owner = recordingOwner(events);
    await chatService.sendMessage({ sessionId: session.id, content: 'Explain leader replication' }, owner);
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'done')).toBe(true); });
    const packed = await chatService.getContextBudget(session.id);

    // A new service has no packed records, as after an app restart.
    const restarted = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: chatRepo,
      context: contextRepo,
      providers: providerRegistry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });
    const rebuilt = await restarted.getContextBudget(session.id);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.modelId).toBe(packed?.modelId);
    expect(rebuilt?.sourceCount).toBeGreaterThan(0);
    expect(rebuilt?.usedTokens).toBeGreaterThan(0);
  });

  it('cancels active generation and updates assistant message status to cancelled', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Cancellation Test',
      providerId: 'fake',
    });

    const owner = recordingOwner([]);

    const result = await chatService.sendMessage(
      { sessionId: session.id, content: 'Explain replication' },
      owner
    );

    // Cancel while in flight
    await chatService.cancel(result.requestId, 1);
    expect(testProvider.canceledRequests.has(result.requestId)).toBe(true);

    const messages = chatService.listMessages(session.id);
    expect(messages[1]?.status).toBe('cancelled');
  });

  it('handles provider error and marks message failed with error event', async () => {
    testProvider.shouldThrow = true;
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Error Test',
      providerId: 'fake',
    });
    const emittedEvents: ChatStreamEvent[] = [];
    const owner = recordingOwner(emittedEvents);

    const result = await chatService.sendMessage(
      { sessionId: session.id, content: 'Trigger failure' },
      owner
    );
    expect(result.assistantMessage.status).toBe('streaming');

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (emittedEvents.some((e) => e.type === 'error')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const errorEvent = emittedEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();

    const messages = chatService.listMessages(session.id);
    expect(messages[1]?.status).toBe('failed');
    expect(messages[1]?.errorMessage).toContain('could not complete this response');
  });

  it('requires document to be open for chat operations', async () => {
    openDocuments.clear();
    await expect(
      chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Closed Doc',
        providerId: 'fake',
      })
    ).rejects.toThrow(/Document is not open/i);
  });

  it('attaches selection, page range, and entire document context', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Context Test',
      providerId: 'fake',
    });

    const selectionContext = chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-chat-service',
      documentHash: 'hash-dist',
      input: {
        kind: 'selection',
        descriptor: {
          format: 'pdf',
          startPageIndex: 0,
          endPageIndex: 0,
          startQuote: { exact: 'leader consensus mechanism', prefix: '', suffix: '' },
          endQuote: { exact: 'leader consensus mechanism', prefix: '', suffix: '' },
        },
      },
    });
    expect(selectionContext.kind).toBe('selection');
    expect(selectionContext.displayLabel).toContain('leader consensus mechanism');
    expect(selectionContext.sourceRef).toEqual({
      descriptor: expect.objectContaining({
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 0,
      }),
    });
    expect(chatService.listContext(session.id)[0]?.sourceRef).toEqual(selectionContext.sourceRef);

    const rangeContext = chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-chat-service',
      documentHash: 'hash-dist',
      input: {
        kind: 'range',
        format: 'pdf',
        pageStart: 1,
        pageEnd: 2,
      },
    });
    expect(rangeContext.kind).toBe('range');
    expect(rangeContext.displayLabel).toBe('Pages 1–2');

    const entireDocContext = chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-chat-service',
      documentHash: 'hash-dist',
      input: {
        kind: 'entire_document',
        location: { format: 'pdf', pageIndex: 0 },
      },
    });
    expect(entireDocContext.kind).toBe('entire_document');

    const items = chatService.listContext(session.id);
    expect(items).toHaveLength(3);

    chatService.removeContext(session.id, selectionContext.id);
    expect(chatService.listContext(session.id)).toHaveLength(2);
  });

  it('persists the selection descriptor and resolves it again when sending a turn', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Selection Source Reference',
      providerId: 'fake',
    });
    const descriptor = {
      format: 'pdf' as const,
      startPageIndex: 0,
      endPageIndex: 0,
      startQuote: { exact: 'leader consensus mechanism', prefix: '', suffix: '' },
      endQuote: { exact: 'leader consensus mechanism', prefix: '', suffix: '' },
    };

    const attached = chatService.attachContext({
      sessionId: session.id,
      documentId: session.documentId,
      documentHash: session.documentHash,
      input: { kind: 'selection', descriptor },
    });
    // Read through the repository boundary to prove the JSON source reference
    // survives storage; ContextBuilder must consume this exact shape later.
    const persisted = chatService.listContext(session.id)[0];
    expect(persisted?.sourceRef).toEqual({ descriptor });
    expect(persisted?.id).toBe(attached.id);

    const owner = recordingOwner([]);
    await chatService.sendMessage({ sessionId: session.id, content: 'Explain this selection' }, owner);
    await waitForTurnSettled(chatService, session.id);

    expect(testProvider.lastRequest?.contextXml).toContain('leader consensus mechanism');
    expect(testProvider.lastRequest?.contextXml).toContain('id="src-1"');
  });

  it('enforces document page bounds and ordering in the main-owned context service', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Range Validation',
      providerId: 'fake',
    });

    expect(() => {
      chatService.attachContext({
        sessionId: session.id,
        documentId: 'doc-chat-service',
        documentHash: 'hash-dist',
        input: { kind: 'range', format: 'pdf', pageStart: 9, pageEnd: 11 },
      });
    }).toThrow(/10 pages/i);
  });

  it('keeps range validation main-owned for safe integers, the exact limit, and indexed availability', async () => {
    const rangeDocumentId = 'doc-chat-range-limits';
    const rangeDocumentHash = 'hash-range-limits';
    new DocumentRepository(db).insert({
      id: rangeDocumentId,
      title: 'Range Limits',
      author: null,
      format: 'pdf',
      filePath: '/range-limits.pdf',
      storageMode: 'link',
      fileSize: 1024,
      fileMtimeMs: 1,
      fileHash: rangeDocumentHash,
      pageCount: 300,
    });
    const insertChunk = db.raw.prepare(`
      INSERT INTO document_text_chunks
        (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let pageIndex = 0; pageIndex < 250; pageIndex += 1) {
      insertChunk.run(
        `range-${String(pageIndex)}`,
        rangeDocumentId,
        pageIndex,
        `Indexed range page ${String(pageIndex + 1)}`,
        4,
        JSON.stringify({ format: 'pdf', pageIndex }),
        null,
        String(pageIndex + 1),
      );
    }
    db.raw.prepare(`
      INSERT INTO document_index_state
        (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES (?, 'ready', ?, ?, ?, ?, ?)
    `).run(rangeDocumentId, 250, 250, rangeDocumentHash, rangeDocumentHash, 250);
    openDocuments.add(rangeDocumentId);
    const session = await chatService.createSession({
      documentId: rangeDocumentId,
      title: 'Range Limits',
      providerId: 'fake',
    });
    const attach = (pageStart: number, pageEnd: number): ChatContextItem =>
      chatService.attachContext({
        sessionId: session.id,
        documentId: rangeDocumentId,
        documentHash: rangeDocumentHash,
        input: { kind: 'range', format: 'pdf', pageStart, pageEnd },
      });

    expect(() => { attach(0, 1); }).toThrow(/positive whole numbers/i);
    expect(() => { attach(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1); }).toThrow(/positive whole numbers/i);
    expect(() => { attach(1, 251); }).toThrow(/safe maximum of 250/i);
    expect(() => { attach(2, 1); }).toThrow(/greater than or equal/i);
    expect(() => { attach(251, 251); }).toThrow(/not available in the current search index/i);
    const exactLimit = attach(1, 250);
    expect(exactLimit.kind).toBe('range');
    expect(exactLimit.displayLabel).toBe('Pages 1–250');
  });

  it.each([
    ['markdown', { format: 'markdown', blockIndex: 0 }],
    ['epub', { format: 'epub', cfi: 'epubcfi(/6/2)' }],
    ['mobi', { format: 'mobi', sectionIndex: 0 }],
  ] as const)('accepts Entire document for %s and rejects mismatched locations', async (format, location) => {
    const documentId = `doc-chat-${format}`;
    const documentHash = `hash-${format}`;
    new DocumentRepository(db).insert({
      id: documentId,
      title: `${format} context`,
      author: null,
      format,
      filePath: `/${format}.fixture`,
      storageMode: 'link',
      fileSize: 1024,
      fileMtimeMs: 1,
      fileHash: documentHash,
      pageCount: null,
    });
    db.raw.prepare(`
      INSERT INTO document_text_chunks
        (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES (?, ?, 0, ?, 4, ?, ?, NULL)
    `).run(
      `${documentId}-chunk`,
      documentId,
      `Indexed ${format} context fixture`,
      JSON.stringify(location),
      `${format} fixture`,
    );
    db.raw.prepare(`
      INSERT INTO document_index_state
        (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES (?, 'ready', 1, 1, ?, ?, 1)
    `).run(documentId, documentHash, documentHash);
    openDocuments.add(documentId);
    const session = await chatService.createSession({ documentId, title: `${format} context`, providerId: 'fake' });
    const entire = chatService.attachContext({
      sessionId: session.id,
      documentId,
      documentHash,
      input: { kind: 'entire_document', location },
    });
    expect(entire).toMatchObject({ kind: 'entire_document', location, displayLabel: 'Entire document' });
    expect(() => {
      chatService.attachContext({
        sessionId: session.id,
        documentId,
        documentHash,
        input: { kind: 'entire_document', location: { format: 'pdf', pageIndex: 0 } },
      });
    }).toThrow(/Context location does not match the active document/i);
    expect(() => {
      chatService.attachContext({
        sessionId: session.id,
        documentId,
        documentHash,
        input: { kind: 'location', location: { format: 'pdf', pageIndex: 0 } },
      });
    }).toThrow(/does not match the active document/i);
  });

  it('cancels active requests when cancelling for document and on shutdown', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Shutdown Test',
      providerId: 'fake',
    });

    const owner = recordingOwner([]);
    const result = await chatService.sendMessage({ sessionId: session.id, content: 'Test' }, owner);

    await chatService.cancelForDocument('doc-chat-service');
    expect(testProvider.canceledRequests.has(result.requestId)).toBe(true);

    const session2 = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Shutdown Test 2',
      providerId: 'fake',
    });
    const result2 = await chatService.sendMessage({ sessionId: session2.id, content: 'Test 2' }, owner);
    await chatService.shutdown();
    expect(testProvider.canceledRequests.has(result2.requestId)).toBe(true);
  });

  it('finalizes DB immediately and handles provider cancel that never resolves', async () => {
    class HangingCancelProvider implements AIProvider {
      readonly id = 'fake' as const;
      readonly name = 'Hanging Provider';
      readonly capabilities = {
        streaming: true,
        subscriptionAuth: true,
        apiKeyAuth: false,
        persistentSessions: false,
        toolFreeMode: true,
        hostedWebSearch: false,
      };
      detect() {
        return Promise.resolve({
          id: 'fake' as const,
          name: 'Hanging Provider',
          available: true,
          installed: true,
          authentication: 'connected' as const,
          version: null,
          errorMessage: null,
          models: [testModel],
          capabilities: this.capabilities,
        });
      }
      listModels() { return Promise.resolve([testModel]); }
      async *streamChat(): AsyncIterable<ProviderChatEvent> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: 'token', token: 'Should not persist' };
      }
      cancel() {
        return new Promise<void>(() => undefined);
      }
    }

    const hangingRegistry = new TestProviderRegistry(new HangingCancelProvider());
    const hangingService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: new ChatRepository(db),
      context: new AIContextRepository(db),
      providers: hangingRegistry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });

    const session = await hangingService.createSession({
      documentId: 'doc-chat-service',
      title: 'Hanging Cancel Test',
      providerId: 'fake',
    });

    const owner = recordingOwner([]);
    const result = await hangingService.sendMessage({ sessionId: session.id, content: 'Test' }, owner);

    // Cancel should finalize DB immediately without waiting forever
    await hangingService.cancel(result.requestId, owner.id);

    const messages = hangingService.listMessages(session.id);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('cancelled');
  });

  it('discards tokens emitted after cancellation begins', async () => {
    let emitMoreTokens: () => void = () => undefined;
    class EmittingAfterCancelProvider implements AIProvider {
      readonly id = 'fake' as const;
      readonly name = 'Emitting Provider';
      readonly capabilities = {
        streaming: true,
        subscriptionAuth: true,
        apiKeyAuth: false,
        persistentSessions: false,
        toolFreeMode: true,
        hostedWebSearch: false,
      };
      detect() {
        return Promise.resolve({
          id: 'fake' as const,
          name: 'Emitting Provider',
          available: true,
          installed: true,
          authentication: 'connected' as const,
          version: null,
          errorMessage: null,
          models: [testModel],
          capabilities: this.capabilities,
        });
      }
      listModels() { return Promise.resolve([testModel]); }
      async *streamChat(): AsyncIterable<ProviderChatEvent> {
        yield { type: 'token', token: 'First chunk ' };
        const pending = deferred<undefined>();
        emitMoreTokens = () => { pending.resolve(undefined); };
        await pending.promise;
        yield { type: 'token', token: 'Post-cancel chunk' };
        yield { type: 'done' };
      }
      cancel() {
        return Promise.resolve();
      }
    }

    const emittingRegistry = new TestProviderRegistry(new EmittingAfterCancelProvider());
    const emittingService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: new ChatRepository(db),
      context: new AIContextRepository(db),
      providers: emittingRegistry,
      requireDocumentOpen: () => undefined,
      log: logger,
    });

    const session = await emittingService.createSession({
      documentId: 'doc-chat-service',
      title: 'Emitting Test',
      providerId: 'fake',
    });

    const receivedTokens: string[] = [];
    const owner: ChatEventOwner = {
      id: 1,
      send: (_channel, payload) => {
        const event = payload as ChatStreamEvent;
        if (event.type === 'token') receivedTokens.push(event.token);
      },
      isDestroyed: () => false,
      onDestroyed: () => () => undefined,
    };

    const result = await emittingService.sendMessage({ sessionId: session.id, content: 'Test' }, owner);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await emittingService.cancel(result.requestId, owner.id);
    // Trigger post-cancel emission
    emitMoreTokens();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedTokens).toEqual(['First chunk ']);
    const messages = emittingService.listMessages(session.id);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('cancelled');
    expect(assistant?.content).toBe('First chunk ');
  });

  it('shutdown is idempotent and guarantees no DB access after close', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Idempotent Shutdown',
      providerId: 'fake',
    });
    const owner = recordingOwner([]);
    await chatService.sendMessage({ sessionId: session.id, content: 'Test' }, owner);

    const shut1 = chatService.shutdown();
    const shut2 = chatService.shutdown();
    expect(shut1).toBe(shut2);
    await shut1;

    // Subsequent operations fail closed cleanly without attempting DB writes
    await expect(
      chatService.sendMessage({ sessionId: session.id, content: 'After shutdown' }, owner)
    ).rejects.toThrow(/shutting down/i);
  });

  it('enforces archived session immutability at service boundaries', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Archived Immutability Test',
      providerId: 'fake',
    });

    const selectionContext = chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-chat-service',
      documentHash: session.documentHash,
      input: {
        kind: 'selection',
        descriptor: {
          format: 'pdf',
          startPageIndex: 0,
          endPageIndex: 0,
          startQuote: { exact: 'Quorum consensus', prefix: '', suffix: '' },
          endQuote: { exact: 'Quorum consensus', prefix: '', suffix: '' },
        },
      },
    });

    // Simulate document revision update (archive session)
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-dist-v2' WHERE id = 'doc-chat-service'").run();

    // 1. Rename is permitted
    const renamed = await chatService.updateSession({
      sessionId: session.id,
      title: 'Renamed Archived Session',
    });
    expect(renamed.title).toBe('Renamed Archived Session');

    // 2. Changing provider on archived session is rejected
    await expect(
      chatService.updateSession({
        sessionId: session.id,
        providerId: 'fake',
      })
    ).rejects.toThrow(/Provider or model cannot be changed for an archived conversation/i);

    // 3. Attaching context on archived session is rejected
    await expect(async () => {
      await Promise.resolve();
      chatService.attachContext({
        sessionId: session.id,
        documentId: 'doc-chat-service',
        documentHash: 'hash-dist-v2',
        input: {
          kind: 'selection',
          descriptor: {
            format: 'pdf',
            startPageIndex: 0,
            endPageIndex: 0,
            startQuote: { exact: 'Quorum consensus', prefix: '', suffix: '' },
            endQuote: { exact: 'Quorum consensus', prefix: '', suffix: '' },
          },
        },
      });
    }).rejects.toThrow(/This conversation is archived/i);

    // 4. Removing context on archived session is rejected
    expect(() => {
      chatService.removeContext(session.id, selectionContext.id);
    }).toThrow(/This conversation is archived/i);

    // 5. Sending turn on archived session is rejected
    const owner = recordingOwner([]);
    await expect(
      chatService.sendMessage({ sessionId: session.id, content: 'Will fail' }, owner)
    ).rejects.toThrow(/This conversation is archived/i);
  });

  it('rejects creating session with providers lacking verified tool-free mode', async () => {
    testProvider.capabilities.toolFreeMode = false;
    await expect(
      chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Tool-Free Test',
        providerId: 'fake',
      })
    ).rejects.toThrow(/not ready for Reader Chat/i);
    testProvider.capabilities.toolFreeMode = true;
  });

  it('resolves OpenRouter sessions through the persisted configured model setting', async () => {
    const configuredModel = 'anthropic/claude-haiku-configured';
    // Minimal openrouter-tagged provider so ChatService takes the settings-driven
    const openRouterTagged: AIProvider = {
      id: 'openrouter',
      name: 'OpenRouter',
      capabilities: {
        streaming: true,
        subscriptionAuth: false,
        apiKeyAuth: true,
        persistentSessions: false,
        toolFreeMode: true,
        hostedWebSearch: false,
      },
      detect: () =>
        Promise.resolve({
          id: 'openrouter',
          name: 'OpenRouter',
          available: true,
          installed: false,
          authentication: 'connected',
          version: null,
          errorMessage: null,
          models: [testModel],
          capabilities: openRouterTagged.capabilities,
        }),
      listModels: () => Promise.resolve([testModel]),
      streamChat: (request) => testProvider.streamChat(request),
      cancel: (requestId) => testProvider.cancel(requestId),
    };
    const gateway: ChatProviderGateway = {
      listStatuses: () => Promise.resolve([]),
      getStatus: () => openRouterTagged.detect(),
      resolveModel: (_providerId, modelId) => {
        if (modelId === null || modelId === '' || modelId === 'openrouter/auto') {
          return Promise.resolve({ ...testModel, id: 'openrouter/auto' });
        }
        if (modelId.includes(' ')) {
          return Promise.reject(new Error('Invalid model id'));
        }
        return Promise.resolve({ ...testModel, id: modelId });
      },
      require: () => openRouterTagged,
      testConnection: () => Promise.resolve({ success: true }),
    };
    const service = new ChatService({
      chat: chatRepo,
      context: contextRepo,
      providers: gateway,
      requireDocumentOpen: () => undefined,
      resolveOpenRouterModelId: () => Promise.resolve(configuredModel),
      log: logger,
    });

    // Create an OpenRouter-bound session with no pinned model so runtime
    // resolution must consult the persisted settings identifier.
    const session = await service.createSession({
      documentId: 'doc-chat-service',
      title: 'OpenRouter Settings Model',
      providerId: 'openrouter',
    });

    const owner = recordingOwner([]);
    await service.sendMessage({ sessionId: session.id, content: 'Q' }, owner);
    await waitForTurnSettled(service, session.id);
    expect(testProvider.lastRequest?.modelId).toBe(configuredModel);

    // A pinned session model wins over the configured default.
    db.raw.prepare('UPDATE chat_sessions SET model_id = ? WHERE id = ?')
      .run('pinned/custom-model', session.id);
    const turnsAfterFirst = service.listMessages(session.id).filter((m) => m.role === 'assistant').length;
    await service.sendMessage({ sessionId: session.id, content: 'Q2' }, owner);
    await waitForTurnSettled(service, session.id, 2_000, turnsAfterFirst + 1);
    expect(testProvider.lastRequest?.modelId).toBe('pinned/custom-model');
  });

  it('generates distinct sequential titles for concurrent createSession calls', async () => {
    const [s1, s2, s3] = await Promise.all([
      chatService.createSession({ documentId: 'doc-chat-service', providerId: 'fake' }),
      chatService.createSession({ documentId: 'doc-chat-service', providerId: 'fake' }),
      chatService.createSession({ documentId: 'doc-chat-service', providerId: 'fake' }),
    ]);

    const titles = [s1.title, s2.title, s3.title].sort();
    expect(titles).toEqual(['Conversation 1', 'Conversation 2', 'Conversation 3']);
  });

  it('resolves multi-page selection into distinct cited sources and exact locations', async () => {
    const session = await chatService.createSession({
      documentId: 'doc-chat-service',
      title: 'Multi-Page Selection Test',
      providerId: 'fake',
    });

    // Attach multi-page selection
    const item = chatService.attachContext({
      sessionId: session.id,
      documentId: 'doc-chat-service',
      documentHash: 'hash-dist',
      input: {
        kind: 'selection',
        descriptor: {
          format: 'pdf',
          startPageIndex: 0,
          endPageIndex: 1,
          startPageLabel: '1',
          endPageLabel: '2',
          startQuote: { exact: 'Page 1 selection', prefix: '', suffix: '' },
          endQuote: { exact: 'Page 2 selection', prefix: '', suffix: '' },
          selectedTextSnippet: 'Multi-page selection text',
        },
      },
    });

    expect(item.kind).toBe('selection');

    const owner = recordingOwner([]);

    await chatService.sendMessage(
      { sessionId: session.id, content: 'Explain selection' },
      owner
    );

    const streamingMessages = chatService.listMessages(session.id);
    expect(streamingMessages[1]?.disclosures).toEqual([
      expect.objectContaining({
        contextItemId: item.id,
        reason: 'boundary_over_inclusion',
      }),
    ]);

    await waitForTurnSettled(chatService, session.id);

    const messages = chatService.listMessages(session.id);
    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    expect(assistant.status).toBe('complete');
    expect(assistant.disclosures).toEqual([
      expect.objectContaining({
        contextItemId: item.id,
        reason: 'boundary_over_inclusion',
      }),
    ]);

    // Citation target for src-1
    const target = chatService.resolveCitation(session.id, assistant.id, 'src-1');
    expect(target).not.toBeNull();
    expect(target?.documentId).toBe('doc-chat-service');
  });

  it('rejects stale hash, malformed descriptors, or cross-format mismatches in selection chunk resolution', () => {
    // Cross format mismatch
    const mismatch = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      {
        format: 'markdown',
        startBlockIndex: 0,
        endBlockIndex: 1,
      }
    );
    expect(mismatch.chunks).toHaveLength(0);

    // Reversed page range
    const reversedChunks = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      {
        format: 'pdf',
        startPageIndex: 5,
        endPageIndex: 1,
      }
    );
    expect(reversedChunks.chunks).toHaveLength(0);
  });

  it('resolves EPUB next-boundary and final section descriptors through the context repository', async () => {
    const documentId = 'doc-chat-epub-range';
    const documentHash = 'hash-epub-range';
    new DocumentRepository(db).insert({
      id: documentId,
      title: 'EPUB range fixture',
      author: null,
      format: 'epub',
      filePath: '/epub-range.fixture',
      storageMode: 'link',
      fileSize: 1,
      fileMtimeMs: 1,
      fileHash: documentHash,
      pageCount: null,
    });
    const insertChunk = db.raw.prepare(`
      INSERT INTO document_text_chunks
        (id, document_id, ordinal, text, token_count, location_json, heading, page_label,
         location_order, location_detail, location_offset)
      VALUES (?, ?, ?, ?, 4, ?, ?, NULL, ?, 0, 0)
    `);
    for (let spineIndex = 0; spineIndex < 5; spineIndex += 1) {
      insertChunk.run(
        `${documentId}-${String(spineIndex)}`,
        documentId,
        spineIndex,
        `EPUB spine unit ${String(spineIndex)}`,
        JSON.stringify({ format: 'epub', cfi: `epubcfi(/6/${String((spineIndex + 1) * 2)})`, spineHref: `OPS/chapter-${String(spineIndex + 1)}.xhtml` }),
        `Heading ${String(spineIndex)}`,
        spineIndex,
      );
    }
    db.raw.prepare(`
      INSERT INTO document_index_state
        (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES (?, 'ready', 5, 5, ?, ?, 5)
    `).run(documentId, documentHash, documentHash);
    openDocuments.add(documentId);

    const nextBoundary = contextRepo.resolveSelectionChunks(documentId, documentHash, {
      format: 'epub',
      startSpineHref: 'OPS/chapter-1.xhtml',
      endSpineHref: 'OPS/chapter-3.xhtml',
      startCfi: 'epubcfi(/6/2)',
      endCfi: 'epubcfi(/6/6)',
    });
    expect(nextBoundary.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);

    const finalSection = contextRepo.resolveSelectionChunks(documentId, documentHash, {
      format: 'epub',
      startSpineHref: 'OPS/chapter-4.xhtml',
      endSpineHref: 'OPS/chapter-5.xhtml',
      startCfi: 'epubcfi(/6/8)',
      endCfi: 'epubcfi(/6/10)',
    });
    expect(finalSection.chunks.map((chunk) => chunk.ordinal)).toEqual([3, 4]);

    const session = await chatService.createSession({ documentId, title: 'EPUB range', providerId: 'fake' });
    const item = chatService.attachContext({
      sessionId: session.id,
      documentId,
      documentHash,
      input: {
        kind: 'selection',
        descriptor: {
          format: 'epub',
          startSpineHref: 'OPS/chapter-1.xhtml',
          endSpineHref: 'OPS/chapter-3.xhtml',
          startCfi: 'epubcfi(/6/2)',
          endCfi: 'epubcfi(/6/6)',
        },
      },
    });
    expect(item.displayLabel).toBe('Sections OPS/chapter-1.xhtml–OPS/chapter-3.xhtml');
  });

  it('performs boundary clamping for selection chunks using exact quote matching', () => {
    // Single chunk clamping
    const clampedSingle = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      {
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 0,
        startQuote: { exact: 'leader consensus', prefix: '', suffix: '' },
        endQuote: { exact: 'leader consensus', prefix: '', suffix: '' },
      }
    );
    expect(clampedSingle.chunks).toHaveLength(1);
    expect(clampedSingle.chunks[0]?.text).toBe('leader consensus');
    expect(clampedSingle.boundaryOverIncluded).toBe(false);

    // Missing, repeated, and offset-inconsistent endpoint evidence must keep
    // the complete boundary chunk and disclose the uncertainty.
    const missingQuote = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      { format: 'pdf', startPageIndex: 0, endPageIndex: 0 }
    );
    expect(missingQuote.chunks[0]?.text).toBe('Replication log and leader consensus mechanism.');
    expect(missingQuote.boundaryOverIncluded).toBe(true);

    const repeatedQuote = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      {
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 0,
        startQuote: { exact: 'e', prefix: '', suffix: '' },
        endQuote: { exact: 'e', prefix: '', suffix: '' },
      }
    );
    expect(repeatedQuote.chunks[0]?.text).toBe('Replication log and leader consensus mechanism.');
    expect(repeatedQuote.boundaryOverIncluded).toBe(true);

    const offsetMismatch = contextRepo.resolveSelectionChunks(
      'doc-chat-service',
      'hash-dist',
      {
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 0,
        startQuote: { exact: 'leader consensus', prefix: '', suffix: '' },
        endQuote: { exact: 'leader consensus', prefix: '', suffix: '' },
        startTextOffset: 0,
        endTextOffset: 15,
      }
    );
    expect(offsetMismatch.chunks[0]?.text).toBe('Replication log and leader consensus mechanism.');
    expect(offsetMismatch.boundaryOverIncluded).toBe(true);
  });

  describe('per-turn web search opt-in', () => {
    const owner = recordingOwner([]);

    async function newSession(): Promise<string> {
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Web search',
        providerId: 'fake',
      });
      return session.id;
    }

    it('refuses the opt-in for a provider that cannot host the search', async () => {
      // The renderer is untrusted: a boolean it sends is re-checked here against
      // the capability the provider itself declares. Failing closed matters more
      // than succeeding quietly — a downgraded turn would leave the reader
      // believing the answer had been checked against the web.
      const sessionId = await newSession();
      testProvider.capabilities.hostedWebSearch = false;

      await expect(
        chatService.sendMessage({ sessionId, content: 'What changed since publication?', webSearch: true }, owner)
      ).rejects.toThrow('Controlled Test Provider does not support web search for Reader Chat.');

      // Nothing was dispatched and no turn was recorded against the refusal.
      expect(testProvider.lastRequest).toBeNull();
      expect(chatService.listMessages(sessionId)).toHaveLength(0);
    });

    it('refuses a forged opt-in on a Pi session, whose invocation has no search', async () => {
      // Pi runs tool-free and offline for incidental traffic, so it never
      // exposes the toggle. A renderer that sends `true` anyway is refused
      // here on Pi's own declared capability, not on the UI's silence.
      const piStatus: AIProviderStatus = {
        ...(await testProvider.detect()),
        id: 'pi',
        name: 'Pi',
        capabilities: { ...testProvider.capabilities, toolFreeMode: true, hostedWebSearch: false },
      };
      // Same controlled provider, presenting Pi's identity and capabilities.
      const piProvider = Object.create(testProvider) as AIProvider;
      Object.defineProperty(piProvider, 'id', { value: 'pi' });
      Object.defineProperty(piProvider, 'capabilities', { value: piStatus.capabilities });
      Object.defineProperty(piProvider, 'detect', { value: () => Promise.resolve(piStatus) });
      vi.spyOn(providerRegistry, 'getStatus').mockResolvedValue(piStatus);
      vi.spyOn(providerRegistry, 'require').mockReturnValue(piProvider);
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Pi web search',
        providerId: 'pi',
      });

      await expect(
        chatService.sendMessage({ sessionId: session.id, content: 'What changed since publication?', webSearch: true }, owner)
      ).rejects.toThrow('Pi does not support web search for Reader Chat.');

      expect(testProvider.lastRequest).toBeNull();
      expect(chatService.listMessages(session.id)).toHaveLength(0);
    });

    it('passes the opt-in through to the provider when it is supported', async () => {
      const sessionId = await newSession();
      testProvider.capabilities.hostedWebSearch = true;

      await chatService.sendMessage({ sessionId, content: 'What changed since publication?', webSearch: true }, owner);
      await vi.waitFor(() => { expect(testProvider.lastRequest).not.toBeNull(); });

      expect(testProvider.lastRequest?.webSearch).toBe(true);
      // The turn is told what it may do, and told that web text is untrusted on
      // the same terms as document text.
      expect(testProvider.lastRequest?.systemPrompt).toContain('hosted web search');
      expect(testProvider.lastRequest?.systemPrompt).toContain('UNTRUSTED SOURCE DATA');
      expect(testProvider.lastRequest?.systemPrompt).toContain('never present one as [src-N]');
    });

    it('leaves an ordinary turn with search off and the document-only prompt', async () => {
      const sessionId = await newSession();
      testProvider.capabilities.hostedWebSearch = true;

      await chatService.sendMessage({ sessionId, content: 'Explain leader replication' }, owner);
      await vi.waitFor(() => { expect(testProvider.lastRequest).not.toBeNull(); });

      // Absent is off: the opt-in is per turn, never sticky.
      expect(testProvider.lastRequest?.webSearch).toBe(false);
      expect(testProvider.lastRequest?.systemPrompt).not.toContain('hosted web search');
    });

    it('stores the provider’s web sources as metadata, outside the answer and usage', async () => {
      // What OpenRouter's provider reports once its hosted search has run.
      const sources = [{ url: 'https://example.com/report', title: 'Annual Report' }];
      const sessionId = await newSession();
      testProvider.capabilities.hostedWebSearch = true;
      testProvider.webSources = sources;

      const events: ChatStreamEvent[] = [];
      const streamOwner = recordingOwner(events);

      await chatService.sendMessage(
        { sessionId, content: 'What changed since publication?', webSearch: true },
        streamOwner
      );
      await vi.waitFor(() => { expect(events.some((e) => e.type === 'done')).toBe(true); });

      const assistant = chatService.listMessages(sessionId).find((m) => m.role === 'assistant');
      expect(assistant?.status).toBe('complete');
      // Attribution survives persistence, as typed metadata beside the answer.
      expect(assistant?.webSources).toEqual(sources);
      // The answer itself stays exactly what the model streamed, so the text
      // replayed as assistant history carries nothing the provider supplied.
      expect(assistant?.content).not.toContain('example.com');
      expect(assistant?.content).not.toContain('Annual Report');
      // The web URL is not a document source, so it must not appear among the
      // resolvable [src-*] citations the reader can jump into.
      expect(assistant?.citations.some((c) => c.sourceId.includes('example.com'))).not.toBe(true);
      // Usage is whatever the provider reported.
      expect(assistant?.tokenCount).toBe(9);
    });
  });

  /**
   * Attached context is a standing statement, not a one-turn one: an accepted
   * turn leaves it attached, and later turns resend only what earlier turns
   * retrieved.
   */
  describe('submitted context lifecycle', () => {
    const owner = recordingOwner([]);

    const attachSelection = (
      session: { id: string; documentId: string; documentHash: string },
      exact: string
    ): ChatContextItem =>
      chatService.attachContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        input: {
          kind: 'selection',
          descriptor: {
            format: 'pdf',
            startPageIndex: 0,
            endPageIndex: 0,
            startQuote: { exact, prefix: '', suffix: '' },
            endQuote: { exact, prefix: '', suffix: '' },
          },
        },
      });

    it('keeps the submitted context attached after the accepted turn', async () => {
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Persistence',
        providerId: 'fake',
      });
      const submitted = attachSelection(session, 'leader consensus mechanism');

      const result = await chatService.sendMessage(
        { sessionId: session.id, content: 'Explain this selection' },
        owner
      );
      await waitForTurnSettled(chatService, session.id);

      // The accepted turn says what it created and nothing about consuming
      // context, because it consumes none: the chip is still attached.
      expect(Object.keys(result).toSorted()).toEqual([
        'assistantMessage',
        'requestId',
        'userMessage',
      ]);
      expect(chatService.listContext(session.id).map((item) => item.id)).toEqual([submitted.id]);
      const assistant = chatService.listMessages(session.id).at(-1);
      expect(assistant).toBeDefined();
      expect(chatService.resolveCitation(session.id, assistant!.id, 'src-1')).toMatchObject({
        sourceId: 'src-1',
        documentId: 'doc-chat-service',
      });
    });

    it('resends earlier turns snapshots as untrusted document context on a later question', async () => {
      db.raw.prepare(`
        INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
        VALUES ('c3', 'doc-chat-service', 2, ?, 3000, '{"format":"pdf","pageIndex":2}', 'Bulk', '3')
      `).run('Bulk unrelated body text. '.repeat(1_200));
      providerRegistry.effectiveModel = { ...testModel, contextWindow: 8_000, maxOutputTokens: 500 };

      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Replay',
        providerId: 'fake',
      });
      // Retrieved context, not attached context: an attachment stays attached and
      // is re-sent from the live item, so only retrieval snapshots are replayed.
      await chatService.sendMessage({ sessionId: session.id, content: 'Explain this selection' }, owner);
      await waitForTurnSettled(chatService, session.id);

      const stored = chatRepo.listRecentTurnSources(session.id, CHAT_REPLAY_MAX_SOURCES);
      expect(stored.length).toBeGreaterThan(0);
      const marked = stored.map((source) => ({
        ...source,
        excerptText: `${source.excerptText} REPLAY-MARKER-QUORUM`,
        excerptHash: `${source.excerptHash}-marked`,
      }));
      const replaySpy = vi.spyOn(chatRepo, 'listRecentTurnSources').mockReturnValue(marked);

      await chatService.sendMessage({ sessionId: session.id, content: 'Why does that matter?' }, owner);
      await waitForTurnSettled(chatService, session.id, 2_000, 2);
      expect(replaySpy).toHaveBeenCalledWith(session.id, CHAT_REPLAY_MAX_SOURCES);
      replaySpy.mockRestore();

      const replayed = testProvider.lastRequest?.sources.find((source) =>
        source.excerptText.includes('REPLAY-MARKER-QUORUM')
      );
      expect(replayed).toBeDefined();
      expect(replayed?.sourceId).toMatch(/^src-\d+$/);
      expect(replayed?.contextItemId).toBeNull();
      expect(testProvider.lastRequest?.contextXml).toContain('REPLAY-MARKER-QUORUM');
      expect(testProvider.lastRequest?.history.map((message) => message.content)).toContain(
        'Explain this selection'
      );
      for (const message of testProvider.lastRequest?.history ?? []) {
        expect(message.content).not.toContain('REPLAY-MARKER-QUORUM');
      }

      const secondAssistant = chatService.listMessages(session.id).filter((m) => m.role === 'assistant').at(-1);
      expect(secondAssistant).toBeDefined();
      expect(secondAssistant!.content).not.toContain('REPLAY-MARKER-QUORUM');
      const storedRows = db.raw
        .prepare('SELECT source_id, excerpt_text, context_item_id FROM chat_message_sources WHERE message_id = ?')
        .all(secondAssistant!.id) as { source_id: string; excerpt_text: string; context_item_id: string | null }[];
      const persistedReplay = storedRows.find((row) => row.source_id === replayed?.sourceId);
      expect(persistedReplay?.excerpt_text).toContain('REPLAY-MARKER-QUORUM');
      expect(storedRows.every((row) => row.context_item_id === null)).toBe(true);
      expect(chatService.resolveCitation(session.id, secondAssistant!.id, replayed!.sourceId)).toMatchObject({
        sourceId: replayed!.sourceId,
        documentId: 'doc-chat-service',
      });
    });
  });

  describe('getSessionForDocument scoping', () => {
    beforeEach(() => {
      new DocumentRepository(db).insert({
        id: 'doc-other-service',
        title: 'Unrelated Document',
        author: null,
        format: 'pdf',
        filePath: '/other.pdf',
        storageMode: 'link',
        fileSize: 1024,
        fileMtimeMs: 1,
        fileHash: 'hash-other',
        pageCount: 3,
      });
    });

    it('hydrates a session for its own open document', async () => {
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Owned session',
        providerId: 'fake',
      });
      const found = chatService.getSessionForDocument(session.id, 'doc-chat-service');
      expect(found?.id).toBe(session.id);
    });

    it('refuses hydration when the requested document is not open', async () => {
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Owned session',
        providerId: 'fake',
      });
      openDocuments.delete('doc-chat-service');
      expect(() => chatService.getSessionForDocument(session.id, 'doc-chat-service')).toThrow(/not open/i);
    });

    it('does not return another document\'s session even when that document is open', async () => {
      const session = await chatService.createSession({
        documentId: 'doc-chat-service',
        title: 'Private to doc-chat-service',
        providerId: 'fake',
      });
      // The caller opens a different document and claims the foreign session.
      openDocuments.add('doc-other-service');
      expect(chatService.getSessionForDocument(session.id, 'doc-other-service')).toBeNull();
    });
  });
});

async function waitForTurnSettled(
  service: ChatService,
  sessionId: string,
  timeoutMs = 2_000,
  minAssistantCount = 1
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const assistants = service.listMessages(sessionId).filter((m) => m.role === 'assistant');
    const newest = assistants.at(-1);
    if (assistants.length >= minAssistantCount && newest && newest.status !== 'streaming') return;
    if (Date.now() > deadline) throw new Error('chat turn did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
