// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type { AIProviderStatus, ChatMessage, ChatSession, ChatStreamEvent, SendChatMessageResult } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

const testDocument: DocumentMetadata = {
  id: 'doc-instances',
  title: 'Instance Ownership',
  author: 'Test Author',
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-instances',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  source: null,
};

const fakeProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [{ id: 'fake-grounded', name: 'Deterministic Grounded Model', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
};

const session: ChatSession = {
  id: 'session-1',
  documentId: testDocument.id,
  documentHash: testDocument.fileHash,
  title: 'First Chat',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 0,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

const requestId = '550e8400-e29b-41d4-a716-446655440000';

function message(id: string, role: ChatMessage['role'], status: ChatMessage['status']): ChatMessage {
  return {
    id,
    sessionId: session.id,
    role,
    ordinal: role === 'user' ? 0 : 1,
    content: role === 'user' ? 'Who owns this state?' : '',
    citations: [],
    status,
    requestId: role === 'user' ? null : requestId,
    tokenCount: null,
    errorMessage: null,
    createdAt: '2026-10-03T00:00:01.000Z',
    disclosures: [],
    webSources: [],
  };
}

const accepted: SendChatMessageResult = {
  requestId,
  userMessage: message('msg-user', 'user', 'complete'),
  assistantMessage: message('msg-assistant', 'assistant', 'streaming'),
};

const token: ChatStreamEvent = {
  type: 'token',
  documentId: testDocument.id,
  sessionId: session.id,
  requestId,
  messageId: 'msg-assistant',
  token: 'Each controller.',
};

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('chat controller instances', () => {
  const listSessions = vi.fn(() => Promise.resolve([session]));
  const sendMessage = vi.fn<(sessionId: string) => Promise<SendChatMessageResult>>();
  const cancel = vi.fn(() => Promise.resolve(undefined));
  const unsubscribe = vi.fn();
  /** Every stream listener a controller registered, in subscription order. */
  let listeners: ((event: ChatStreamEvent) => void)[] = [];
  const stores: ChatStore[] = [];

  function createStore(): ChatStore {
    const store = createChatStore();
    stores.push(store);
    return store;
  }

  function emit(event: ChatStreamEvent): void {
    for (const listener of listeners) listener(event);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = [];
    listSessions.mockResolvedValue([session]);
    sendMessage.mockResolvedValue(accepted);
    stubBridge({
      ai: { listProviders: vi.fn(() => Promise.resolve([fakeProvider])) },
      chat: {
        listSessions,
        listMessages: vi.fn(() => Promise.resolve([])),
        // Context is already attached, so a send dispatches without awaiting.
        listContext: vi.fn(() => Promise.resolve([{
          id: 'ctx-1', sessionId: session.id, kind: 'entire_document' as const, sourceRef: {},
          excerptText: '', excerptHash: '', documentHash: testDocument.fileHash,
          location: { format: 'markdown' as const, blockIndex: 0 }, provenance: {},
          displayLabel: 'Entire document', pinned: true, createdAt: '2026-10-03T00:00:00.000Z',
        }])),
        sendMessage,
        cancel,
        onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
          listeners.push(listener);
          return unsubscribe;
        }),
      },
    });
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
  });

  it('keeps each instance to its own state, turn and stream', async () => {
    const first = createStore();
    const second = createStore();
    await first.getState().initializeDocument(testDocument);
    await second.getState().initializeDocument(testDocument);

    await first.getState().sendMessage('Who owns this state?');
    expect(first.getState().isStreaming).toBe(true);
    expect(first.getState().activeRequestId).toBe(requestId);
    expect(second.getState().isStreaming).toBe(false);

    // The same event reaches both subscriptions; only the instance whose turn
    // it belongs to may show it.
    emit(token);
    expect(first.getState().messages.find((entry) => entry.id === 'msg-assistant')?.content).toBe('Each controller.');
    expect(second.getState().messages).toEqual([]);

    first.setState({ lastFailedDraft: 'Only mine' });
    expect(second.getState().lastFailedDraft).toBeNull();
  });

  it('ignores stream events once disposed and unsubscribes from the stream', async () => {
    const store = createStore();
    await store.getState().initializeDocument(testDocument);
    await store.getState().sendMessage('Who owns this state?');
    const before = store.getState();

    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // The disposed turn is cancelled in main rather than left running unseen.
    expect(cancel).toHaveBeenCalledWith(requestId);

    emit(token);
    emit({ type: 'done', documentId: testDocument.id, sessionId: session.id, requestId, messageId: 'msg-assistant', message: { ...accepted.assistantMessage, status: 'complete' } });
    expect(store.getState()).toBe(before);
  });

  it('drops a document load that resolves after disposal', async () => {
    const pending = deferred<ChatSession[]>();
    listSessions.mockReturnValueOnce(pending.promise);
    const store = createStore();
    const loading = store.getState().initializeDocument(testDocument);
    const before = store.getState();

    store.dispose();
    pending.resolve([session]);
    await loading;

    expect(store.getState()).toBe(before);
    expect(store.getState().sessions).toEqual([]);
  });

  it('writes nothing from a send whose invoke resolves after disposal, and cancels it in main', async () => {
    const pending = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(pending.promise);
    const store = createStore();
    await store.getState().initializeDocument(testDocument);
    const sending = store.getState().sendMessage('Who owns this state?');
    await vi.waitFor(() => { expect(sendMessage).toHaveBeenCalledTimes(1); });
    const before = store.getState();

    store.dispose();
    pending.resolve(accepted);
    await sending;

    expect(store.getState()).toBe(before);
    expect(store.getState().activeRequestId).toBeNull();
    expect(cancel).toHaveBeenCalledWith(requestId);
  });
});
