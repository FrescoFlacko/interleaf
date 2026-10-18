// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type { AIProviderId, AIProviderStatus, ChatContextItem, ChatMessage, ChatSession, ChatStreamEvent, SendChatMessageResult } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const testDocument: DocumentMetadata = {
  id: 'doc-actions',
  title: 'Testing AI Chat',
  author: 'Test Author',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-actions',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
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

const session1: ChatSession = {
  id: 'session-1',
  documentId: 'doc-actions',
  documentHash: 'hash-actions',
  title: 'First Chat',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 2,
  previewText: 'Majority overlap guarantees consensus.',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second Chat', previewText: null, messageCount: 0 };

const wholeDocumentItem: ChatContextItem = {
  id: 'ctx-whole',
  sessionId: 'session-1',
  kind: 'entire_document',
  sourceRef: {},
  excerptText: 'Whole document',
  excerptHash: 'h-whole',
  documentHash: 'hash-actions',
  location: { format: 'pdf', pageIndex: 0 },
  provenance: {},
  displayLabel: 'Entire document',
  pinned: true,
  createdAt: '2026-08-24T00:00:00.000Z',
};

const assistantAnswer: ChatMessage = {
  id: 'message-2',
  sessionId: 'session-1',
  role: 'assistant',
  ordinal: 1,
  content: 'Quorums intersect in at least one replica.',
  citations: [],
  status: 'complete',
  requestId: 'request-1',
  tokenCount: 12,
  errorMessage: null,
  createdAt: '2026-08-24T00:01:00.000Z',
  disclosures: [],
  webSources: [],
};

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Conversation-scoped store behaviour behind the reference 2b cards: acting on
 * a card that is not the open conversation, and keeping a late attachment
 * result out of a conversation the user has already left.
 */
describe('useChatStore conversation actions', () => {
  const listProviders = vi.fn(() => Promise.resolve([fakeProvider]));
  const listSessions = vi.fn(() => Promise.resolve([session1, session2]));
  const listMessages = vi.fn(() => Promise.resolve([]));
  const listContext = vi.fn(() => Promise.resolve([]));
  const attachContext = vi.fn<(input: { sessionId: string }) => Promise<ChatContextItem>>();
  const removeContext = vi.fn(() => Promise.resolve(undefined));
  /** Stored conversation records, so successive writes accumulate as they do in the database. */
  const stored = new Map<string, ChatSession>();
  const updateSession = vi.fn((input: { sessionId: string; title?: string; providerId?: AIProviderId; modelId?: string | null }) => {
    const base = stored.get(input.sessionId) ?? session1;
    const next: ChatSession = {
      ...base,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    };
    stored.set(input.sessionId, next);
    return Promise.resolve(next);
  });
  const deleteSession = vi.fn(() => Promise.resolve(undefined));
  const sendMessage = vi.fn<(sessionId: string) => Promise<SendChatMessageResult>>();
  const getSession = vi.fn<(sessionId: string, documentId: string) => Promise<ChatSession | null>>();
  /** Conversation the last attach request was issued for. */
  let requestedSessionId: string | null = null;
  /** Stream listener the store registered, used to replay a finished turn. */
  let emitStreamEvent: ((event: ChatStreamEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    requestedSessionId = null;
    emitStreamEvent = null;
    stored.clear();
    stored.set('session-1', session1);
    stored.set('session-2', session2);
    listSessions.mockResolvedValue([session1, session2]);
    attachContext.mockResolvedValue(wholeDocumentItem);
    getSession.mockResolvedValue(null);
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        getSession,
        createSession: vi.fn(),
        listMessages,
        listContext,
        sendMessage,
        cancel: vi.fn(),
        attachContext,
        removeContext,
        updateSession,
        deleteSession,
        onStreamEvent: vi.fn((callback: (event: ChatStreamEvent) => void) => {
          emitStreamEvent = callback;
          return () => undefined;
        }),
      },
    });
    await chat.getState().initializeDocument(testDocument);
  });


  it('keeps a single whole-document chip when the main process resolves the request to the stored attachment', async () => {
    expect(await chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 0 })).toBe(true);
    // A second request from another reading location resolves to the same item.
    expect(await chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 3 })).toBe(true);

    const items = chat.getState().contextItems;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('ctx-whole');
    expect(attachContext).toHaveBeenCalledTimes(2);
  });

  /** Sends a turn in the open conversation and replays its finished answer. */
  const finishTurn = async (requestId: string, messageId: string): Promise<void> => {
    sendMessage.mockResolvedValueOnce({
      requestId,
      userMessage: { ...assistantAnswer, id: `${messageId}-question`, role: 'user', requestId },
      assistantMessage: { ...assistantAnswer, id: messageId, content: '', status: 'streaming', requestId },
    });
    await chat.getState().sendMessage('Do quorums intersect?');
    expect(chat.getState().activeRequestId).toBe(requestId);
    expect(emitStreamEvent).not.toBeNull();
    emitStreamEvent!({
      type: 'done',
      documentId: 'doc-actions',
      sessionId: 'session-1',
      requestId,
      messageId,
      message: { ...assistantAnswer, id: messageId, requestId },
    });
  };

  it('refreshes the stored conversation summary when a turn finishes', async () => {
    getSession.mockResolvedValue({
      ...session1,
      messageCount: 4,
      previewText: 'Quorums intersect in at least one replica.',
      updatedAt: '2026-08-24T00:01:00.000Z',
    });
    await finishTurn('request-1', 'message-2');

    await vi.waitFor(() => {
      const refreshed = chat.getState().sessions.find((session) => session.id === 'session-1');
      expect(refreshed?.messageCount).toBe(4);
      expect(refreshed?.previewText).toBe('Quorums intersect in at least one replica.');
    });
    expect(getSession).toHaveBeenCalledWith('session-1', 'doc-actions');
    // The conversation that did not take the turn keeps its own summary.
    expect(chat.getState().sessions.find((session) => session.id === 'session-2')).toEqual(session2);
  });

  it('keeps a rename and a rebinding that land while a summary refresh is in flight', async () => {
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(pending.promise);
    await finishTurn('request-1', 'message-2');
    await vi.waitFor(() => { expect(getSession).toHaveBeenCalledTimes(1); });

    const metadataWriteTime = '2026-08-24T00:02:00.000Z';
    stored.set('session-1', { ...session1, updatedAt: metadataWriteTime });

    // Both writes are owned by their own actions, not by the summary read that
    // started before them and still carries the previous values.
    expect(await chat.getState().renameSession('session-1', 'Renamed First')).toBe(true);
    await chat.getState().changeSessionProvider('openrouter', 'openrouter/auto');
    pending.resolve({
      ...session1,
      messageCount: 4,
      previewText: 'Quorums intersect in at least one replica.',
      updatedAt: '2026-08-24T00:01:00.000Z',
    });

    await vi.waitFor(() => {
      const refreshed = chat.getState().sessions.find((session) => session.id === 'session-1');
      expect(refreshed?.messageCount).toBe(4);
    });
    const settled = chat.getState().sessions.find((session) => session.id === 'session-1');
    expect(settled?.title).toBe('Renamed First');
    expect(settled?.providerId).toBe('openrouter');
    expect(settled?.modelId).toBe('openrouter/auto');
    expect(settled?.previewText).toBe('Quorums intersect in at least one replica.');
    expect(settled?.updatedAt).toBe(metadataWriteTime);
  });

  it('ignores a summary that resolves after a newer one for the same conversation', async () => {
    const older = deferred<ChatSession | null>();
    const newer = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    await finishTurn('request-1', 'message-2');
    await vi.waitFor(() => { expect(getSession).toHaveBeenCalledTimes(1); });
    await finishTurn('request-2', 'message-4');
    await vi.waitFor(() => { expect(getSession).toHaveBeenCalledTimes(2); });

    newer.resolve({ ...session1, messageCount: 6, previewText: 'Newest answer.', updatedAt: '2026-08-24T00:02:00.000Z' });
    await vi.waitFor(() => {
      expect(chat.getState().sessions.find((session) => session.id === 'session-1')?.messageCount).toBe(6);
    });

    older.resolve({ ...session1, messageCount: 4, previewText: 'Older answer.', updatedAt: '2026-08-24T00:01:00.000Z' });
    await Promise.resolve();
    await Promise.resolve();
    const settled = chat.getState().sessions.find((session) => session.id === 'session-1');
    expect(settled?.messageCount).toBe(6);
    expect(settled?.previewText).toBe('Newest answer.');
    expect(settled?.updatedAt).toBe('2026-08-24T00:02:00.000Z');
  });

  it('discards an attachment that resolves after the user switched conversation', async () => {
    const pending = deferred<ChatContextItem>();
    attachContext.mockImplementationOnce((input: { sessionId: string }) => {
      requestedSessionId = input.sessionId;
      return pending.promise;
    });

    const inFlight = chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 0 });
    // The request must be in flight for the open conversation before the switch.
    await vi.waitFor(() => { expect(requestedSessionId).toBe('session-1'); });
    await chat.getState().switchSession('session-2');
    pending.resolve(wholeDocumentItem);

    expect(await inFlight).toBe(false);
    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().contextItems).toEqual([]);
  });

  it('discards an attachment that resolves after the document revision changed', async () => {
    const pending = deferred<ChatContextItem>();
    attachContext.mockImplementationOnce((input: { sessionId: string }) => {
      requestedSessionId = input.sessionId;
      return pending.promise;
    });

    const inFlight = chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 0 });
    await vi.waitFor(() => { expect(requestedSessionId).toBe('session-1'); });
    chat.setState({ activeDocument: { id: testDocument.id, fileHash: 'hash-actions-v2' } });
    pending.resolve(wholeDocumentItem);

    expect(await inFlight).toBe(false);
    expect(chat.getState().contextItems).toEqual([]);
  });

  it('renames the conversation that was acted on without opening it', async () => {
    expect(await chat.getState().renameSession('session-2', '  Renamed Second  ')).toBe(true);

    expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-2', title: 'Renamed Second' });
    const state = chat.getState();
    expect(state.activeSessionId).toBe('session-1');
    expect(state.sessions.find((session) => session.id === 'session-2')?.title).toBe('Renamed Second');
    expect(state.sessions.find((session) => session.id === 'session-1')?.title).toBe('First Chat');
  });

  it('deletes a conversation that is not open without disturbing the open one', async () => {
    await chat.getState().deleteSession('session-2');

    expect(deleteSession).toHaveBeenCalledWith('session-2');
    const state = chat.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(['session-1']);
    expect(state.activeSessionId).toBe('session-1');
    expect(state.error).toBeNull();
  });

  it('opens the remaining conversation when the open one is deleted', async () => {
    await chat.getState().deleteSession('session-1');

    expect(deleteSession).toHaveBeenCalledWith('session-1');
    expect(chat.getState().activeSessionId).toBe('session-2');
  });

  it('surfaces a delete failure without dropping the conversation from the list', async () => {
    deleteSession.mockRejectedValueOnce(new Error('Disk failure on delete'));

    await chat.getState().deleteSession('session-2');

    const state = chat.getState();
    expect(state.error).toContain('Disk failure on delete');
    expect(state.sessions.map((session) => session.id)).toEqual(['session-1', 'session-2']);
  });
});
