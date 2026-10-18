// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type {
  AIProviderStatus,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  CleanChatContextResult,
  SendChatMessageResult,
} from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const testDocument: DocumentMetadata = {
  id: 'doc-chat-store',
  title: 'Testing AI Chat',
  author: 'Test Author',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-chat-store',
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
  models: [
    {
      id: 'fake-grounded',
      name: 'Deterministic Grounded Model',
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
      supportsStreaming: true,
    },
  ],
  capabilities: {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

const openRouterProvider: AIProviderStatus = {
  id: 'openrouter',
  name: 'OpenRouter',
  available: true,
  installed: false,
  authentication: 'connected',
  version: null,
  errorMessage: null,
  models: [
    {
      id: 'openrouter/auto',
      name: 'OpenRouter Auto',
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsStreaming: true,
    },
  ],
  capabilities: {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: true,
    persistentSessions: false,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const session1: ChatSession = {
  id: 'session-1',
  documentId: 'doc-chat-store',
  documentHash: 'hash-chat-store',
  title: 'First Chat',

  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 0,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

describe('useChatStore', () => {
  let streamListener: ((event: ChatStreamEvent) => void) | null = null;
  const listProviders = vi.fn<() => Promise<readonly AIProviderStatus[]>>(() =>
    Promise.resolve([fakeProvider])
  );
  const listSessions = vi.fn<(documentId: string) => Promise<readonly ChatSession[]>>(() =>
    Promise.resolve([session1])
  );
  /** Summary re-read the store performs after a turn reaches a terminal state. */
  const getSession = vi.fn<(sessionId: string, documentId: string) => Promise<ChatSession | null>>(() =>
    Promise.resolve(session1)
  );
  let sessionCounter = 0;
  const createSession = vi.fn<
    (input: {
      documentId: string;
      title?: string;
      providerId: string;
      modelId?: string | null;
    }) => Promise<ChatSession>
  >((input) =>
    Promise.resolve({
      id: 'session-new',
      documentId: input.documentId,
      documentHash: 'hash-chat-store',
      title: input.title ?? `Conversation ${String(++sessionCounter)}`,
      providerId: input.providerId as ChatSession['providerId'],
      modelId: input.modelId ?? null,
      reasoningEffort: null,
      messageCount: 0,
      previewText: null,
      isArchived: false,
      compactedThroughOrdinal: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
  );
  const listMessages = vi.fn<(sessionId: string) => Promise<readonly ChatMessage[]>>(() =>
    Promise.resolve([])
  );
  const listContext = vi.fn<(sessionId: string) => Promise<readonly ChatContextItem[]>>(() =>
    Promise.resolve([])
  );
  // The fixture mirrors the bridge signature exactly, including the optional
  // per-turn `webSearch` flag, so a store that stops passing it fails to compile.
  const sendMessage = vi.fn<
    (
      sessionId: string,
      content: string,
      currentLocation?: DocumentLocation | null,
      webSearch?: boolean
    ) => Promise<SendChatMessageResult>
  >(
    (sessionId, content) =>
      Promise.resolve({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        userMessage: {
          id: 'msg-user',
          sessionId,
          role: 'user',
          ordinal: 0,
          content,
          citations: [],
          status: 'complete',
          requestId: null,
          tokenCount: 4,
          errorMessage: null,
          createdAt: '2026-08-24T00:00:00.000Z',
          disclosures: [],
          webSources: [],
        },
        assistantMessage: {
          id: 'msg-assistant',
          sessionId,
          role: 'assistant',
          ordinal: 1,
          content: '',
          citations: [],
          status: 'streaming',
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          tokenCount: null,
          errorMessage: null,
          createdAt: '2026-08-24T00:00:01.000Z',
          disclosures: [],
          webSources: [],
        },
      })
  );
  const cancel = vi.fn<(requestId: string) => Promise<undefined>>(() => Promise.resolve(undefined));
  const attachContext = vi.fn((): Promise<ChatContextItem> =>
    Promise.resolve({
      id: 'ctx-1',
      sessionId: 'session-1',
      kind: 'selection' as const,
      sourceRef: {},
      excerptText: 'Selection quote',
      excerptHash: 'h-1',
      documentHash: 'hash-chat-store',
      location: { format: 'pdf' as const, pageIndex: 0 },
      provenance: {},
      displayLabel: 'Selection quote',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    })
  );
  const removeContext = vi.fn(() => Promise.resolve(undefined));
  const cleanContext = vi.fn((sessionId: string) =>
    Promise.resolve({
      sessionId,
      compactedThroughOrdinal: 1,
      summaryTextUnits: 42,
      clearedContextItemIds: [] as string[],
    })
  );
  const updateSession = vi.fn((input: { sessionId: string; title: string }) =>
    Promise.resolve({ ...session1, title: input.title })
  );
  const deleteSession = vi.fn(() => Promise.resolve(undefined));

  beforeEach(() => {
    sessionCounter = 0;
    vi.clearAllMocks();
    // Per-test overrides use mockImplementation/mockResolvedValueOnce; re-arm
    // deterministic defaults so state never leaks between tests.
    listProviders.mockReset().mockResolvedValue([fakeProvider]);
    listSessions.mockReset().mockResolvedValue([session1]);
    listMessages.mockReset().mockResolvedValue([]);
    listContext.mockReset().mockResolvedValue([]);
    streamListener = null;
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        getSession,
        createSession,
        listMessages,
        listContext,
        sendMessage,
        cancel,
        attachContext,
        removeContext,
        cleanContext,
        updateSession,
        deleteSession,
        onStreamEvent: vi.fn((cb: (event: ChatStreamEvent) => void) => {
          streamListener = cb;
          return () => {
            streamListener = null;
          };
        }),
      },
    });
  });


  it('initializes document chats and selects the first active session', async () => {
    await chat.getState().initializeDocument(testDocument);
    const state = chat.getState();

    expect(state.activeDocument?.id).toBe(testDocument.id);
    expect(state.activeDocument?.fileHash).toBe(testDocument.fileHash);
    expect(state.providers).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe('session-1');
    expect(listMessages).toHaveBeenCalledWith('session-1');
    expect(listContext).toHaveBeenCalledWith('session-1');
  });

  it('publishes persisted sessions and hydrates the thread while provider discovery is still pending', async () => {
    // Provider discovery probes external CLIs and a loopback server, so it can
    // take seconds. The rows already in SQLite must not wait behind it.
    const slowProviders = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => slowProviders.promise);
    listSessions.mockResolvedValueOnce([session1]);
    listMessages.mockResolvedValueOnce([userMsg('m-persisted')]);

    const init = chat.getState().initializeDocument(testDocument);
    await vi.waitFor(() => {
      expect(chat.getState().messages.map((m) => m.id)).toEqual(['m-persisted']);
    });

    const pending = chat.getState();
    expect(pending.sessions.map((session) => session.id)).toEqual(['session-1']);
    expect(pending.activeSessionId).toBe('session-1');
    expect(pending.isLoading).toBe(false);
    expect(pending.sessionsLoaded).toBe(true);
    // Readiness is still genuinely unknown, and the store says so rather than
    // reporting an empty provider list as an answer.
    expect(pending.providerDiscovery).toBe('loading');
    expect(pending.providers).toHaveLength(0);

    slowProviders.resolve([fakeProvider]);
    await init;

    const settled = chat.getState();
    expect(settled.providerDiscovery).toBe('succeeded');
    expect(settled.providers.map((provider) => provider.id)).toEqual(['fake']);
    expect(settled.sessions.map((session) => session.id)).toEqual(['session-1']);
    expect(settled.messages.map((m) => m.id)).toEqual(['m-persisted']);
  });

  it('keeps persisted sessions when provider discovery fails', async () => {
    listProviders.mockRejectedValueOnce(new Error('Provider probe failed.'));
    listSessions.mockResolvedValueOnce([session1]);

    await chat.getState().initializeDocument(testDocument);

    const state = chat.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(['session-1']);
    expect(state.activeSessionId).toBe('session-1');
    // The probe failed, which is not the same answer as an empty ready list:
    // the panel may say so plainly instead of waiting forever.
    expect(state.providerDiscovery).toBe('failed');
    expect(state.providers).toHaveLength(0);
  });

  it('reports a chat-load error when the persisted session read fails', async () => {
    listSessions.mockRejectedValueOnce(new Error('Chat database is unavailable.'));

    await chat.getState().initializeDocument(testDocument);

    const state = chat.getState();
    expect(state.error).toBe('Chat database is unavailable.');
    expect(state.isLoading).toBe(false);
    expect(state.sessionsLoaded).toBe(true);
    expect(state.providerDiscovery).toBe('succeeded');
  });

  describe('provider readiness across a document switch', () => {
    // Switching documents keeps the previous document's provider objects so the
    // conversation cards can still be labelled. These tests hold the new
    // document's probe open, or fail it, and ask what that retained list is
    // allowed to authorize in the meantime.
    const secondDocument: DocumentMetadata = { ...testDocument, id: 'doc-second', fileHash: 'hash-second' };
    const secondSession: ChatSession = {
      ...session1,
      id: 'session-second',
      documentId: 'doc-second',
      documentHash: 'hash-second',
      title: 'Second Chat',
    };
    const secondMessage: ChatMessage = { ...userMsg('m-second'), sessionId: 'session-second' };

    /** Document A, fully settled, so the switch has a real success to go stale from. */
    async function openFirstDocument(): Promise<void> {
      await chat.getState().initializeDocument(testDocument);
      expect(chat.getState().providerDiscovery).toBe('succeeded');
      expect(chat.getState().providers.map((provider) => provider.id)).toEqual(['fake']);
      createSession.mockClear();
      sendMessage.mockClear();
    }

    it('refuses to act on the previous document while the new probe is still running', async () => {
      await openFirstDocument();

      const probe = deferred<readonly AIProviderStatus[]>();
      listProviders.mockImplementationOnce(() => probe.promise);
      listSessions.mockResolvedValueOnce([secondSession]);
      listMessages.mockResolvedValueOnce([secondMessage]);

      const init = chat.getState().initializeDocument(secondDocument);
      await vi.waitFor(() => {
        expect(chat.getState().sessionsLoaded).toBe(true);
      });

      const pending = chat.getState();
      expect(pending.activeSessionId).toBe('session-second');
      expect(pending.messages.map((message) => message.id)).toEqual(['m-second']);
      expect(pending.isLoading).toBe(false);
      // A's providers are still here as labels, and they are not an answer about B.
      expect(pending.providers.map((provider) => provider.id)).toEqual(['fake']);
      expect(pending.providerDiscovery).toBe('loading');

      expect(await chat.getState().createSession()).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(chat.getState().error).toMatch(/Still checking which AI providers are ready/);

      await chat.getState().sendMessage('Does the quorum still hold?');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(chat.getState().error).toMatch(/Still checking which AI providers are ready/);

      probe.resolve([fakeProvider]);
      await init;

      // The refusal was about currency, not a standing block on the document.
      expect(chat.getState().providerDiscovery).toBe('succeeded');
      expect(await chat.getState().createSession()).not.toBeNull();
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('refuses to act on the previous document after the new probe rejects', async () => {
      await openFirstDocument();

      listProviders.mockRejectedValueOnce(new Error('Provider probe failed.'));
      listSessions.mockResolvedValueOnce([secondSession]);
      listMessages.mockResolvedValueOnce([secondMessage]);

      await chat.getState().initializeDocument(secondDocument);

      const state = chat.getState();
      expect(state.providerDiscovery).toBe('failed');
      expect(state.providers.map((provider) => provider.id)).toEqual(['fake']);
      // The stored conversation stays readable through the failure.
      expect(state.sessions.map((session) => session.id)).toEqual(['session-second']);
      expect(state.messages.map((message) => message.id)).toEqual(['m-second']);

      // Naming the retained provider outright does not make it current either.
      expect(await chat.getState().createSession('fake')).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(chat.getState().error).toMatch(/Could not check which AI providers are ready/);

      await chat.getState().sendMessage('Does the quorum still hold?');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('distinguishes a failed probe from an authoritative empty provider list', async () => {
      listProviders.mockRejectedValueOnce(new Error('Provider probe failed.'));
      await chat.getState().initializeDocument(testDocument);

      expect(await chat.getState().createSession()).toBeNull();
      const afterFailure = chat.getState();
      expect(afterFailure.providerDiscovery).toBe('failed');

      listProviders.mockResolvedValueOnce([]);
      chat.dispose();
      chat = createChatStore();
      await chat.getState().initializeDocument(testDocument);

      expect(await chat.getState().createSession()).toBeNull();
      const afterEmpty = chat.getState();
      expect(afterEmpty.providerDiscovery).toBe('succeeded');

      // Both refuse, and they say different things: one could not find out, the
      // other found out that nothing is configured.
      expect(afterFailure.error).toMatch(/Could not check which AI providers are ready/);
      expect(afterEmpty.error).toMatch(/No AI provider is configured and ready/);
      expect(afterEmpty.error).not.toBe(afterFailure.error);
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  it('fails closed for an explicitly selected unavailable OpenRouter provider instead of choosing fake', async () => {
    const unavailableOpenRouter = { ...openRouterProvider, available: false, authentication: 'disconnected' as const, errorMessage: 'OpenRouter API key is not configured.' };
    listProviders.mockResolvedValueOnce([fakeProvider, unavailableOpenRouter]);
    listSessions.mockResolvedValueOnce([]);

    await chat.getState().initializeDocument(testDocument);
    const created = await chat.getState().createSession('openrouter', 'openrouter/auto');

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().error).toContain('OpenRouter API key is not configured.');
  });

  it('fails closed when an explicitly selected provider disappears during refresh', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider]);
    listSessions.mockResolvedValueOnce([]);

    await chat.getState().initializeDocument(testDocument);
    const created = await chat.getState().createSession('openrouter', 'openrouter/auto');

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().error).toContain('OpenRouter');
  });

  it('creates an explicitly selected OpenRouter session with the exact provider and model', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider, openRouterProvider]);
    listSessions.mockResolvedValueOnce([]);

    await chat.getState().initializeDocument(testDocument);
    await chat.getState().createSession('openrouter', 'openrouter/auto');

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    }));
  });

  it('delegates title generation to main process by omitting title from createSession', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider]);
    listSessions.mockResolvedValueOnce([]);

    await chat.getState().initializeDocument(testDocument);
    await chat.getState().createSession('fake', 'fake-grounded');

    expect(createSession).toHaveBeenCalledTimes(1);
    const callArg = createSession.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg).not.toHaveProperty('title');
    expect(callArg).toMatchObject({
      documentId: testDocument.id,
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
  });

  it('stores multiple sequentially created sessions with their generated titles and activates the newest', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider]);
    listSessions.mockResolvedValueOnce([]);

    await chat.getState().initializeDocument(testDocument);
    const first = await chat.getState().createSession('fake', 'fake-grounded');
    expect(first?.title).toBe('Conversation 1');
    expect(chat.getState().activeSessionId).toBe(first?.id);

    const second = await chat.getState().createSession('fake', 'fake-grounded');
    expect(second?.title).toBe('Conversation 2');
    expect(chat.getState().activeSessionId).toBe(second?.id);

    expect(chat.getState().sessions.map((s) => s.title)).toEqual(['Conversation 2', 'Conversation 1']);
  });

  it('keeps the newest provider refresh from being overwritten by an older response', async () => {
    await chat.getState().initializeDocument(testDocument);
    const older = deferred<readonly AIProviderStatus[]>();
    const newer = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);

    const olderRefresh = chat.getState().refreshProviders();
    const newerRefresh = chat.getState().refreshProviders();
    newer.resolve([openRouterProvider]);
    await newerRefresh;
    older.resolve([fakeProvider]);
    await olderRefresh;

    expect(chat.getState().providers.map((provider) => provider.id)).toEqual(['openrouter']);
  });

  it('announces a provider configuration re-read before the provider list resolves', async () => {
    await chat.getState().initializeDocument(testDocument);
    const before = chat.getState().providerBindingRevision;
    const pending = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => pending.promise);

    // Saving a changed OpenRouter model refreshes providers; anything bound to
    // the old effective model is stale from the call, not from the reply.
    const refresh = chat.getState().refreshProviders();
    expect(chat.getState().providerBindingRevision).toBe(before + 1);

    pending.resolve([openRouterProvider]);
    await refresh;
    expect(chat.getState().providerBindingRevision).toBe(before + 1);
  });

  it('restores a persisted OpenRouter session binding without rebinding it to fake', async () => {
    const openRouterSession: ChatSession = {
      ...session1,
      id: 'session-openrouter',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    };
    listProviders.mockResolvedValueOnce([fakeProvider, openRouterProvider]);
    listSessions.mockResolvedValueOnce([openRouterSession]);

    await chat.getState().initializeDocument(testDocument);

    expect(chat.getState().activeSessionId).toBe('session-openrouter');
    expect(chat.getState().sessions[0]).toMatchObject({ providerId: 'openrouter', modelId: 'openrouter/auto' });
  });

  it('ignores rapid duplicate new-chat requests while the first exact binding is being created', async () => {
    listProviders.mockResolvedValueOnce([openRouterProvider]);
    listSessions.mockResolvedValueOnce([]);
    await chat.getState().initializeDocument(testDocument);

    const createdSession: ChatSession = {
      ...session1,
      id: 'session-openrouter-created',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    };
    const pendingCreate = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => pendingCreate.promise);

    const first = chat.getState().createSession('openrouter', 'openrouter/auto');
    const second = chat.getState().createSession('fake', 'fake-grounded');
    expect(await second).toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);

    pendingCreate.resolve(createdSession);
    await first;
    expect(chat.getState().sessions[0]?.providerId).toBe('openrouter');
  });

  it('discards earlier session responses when switching documents in-flight', async () => {
    const { promise, resolve } = deferred<readonly ChatSession[]>();
    listSessions.mockReturnValueOnce(promise);

    const firstInit = chat.getState().initializeDocument(testDocument);
    const secondDoc: DocumentMetadata = { ...testDocument, id: 'doc-2', fileHash: 'hash-2' };
    const secondInit = chat.getState().initializeDocument(secondDoc);
    await secondInit;

    resolve([session1]);
    await firstInit;
    expect(chat.getState().activeDocument?.id).toBe('doc-2');
    expect(chat.getState().activeDocument?.fileHash).toBe('hash-2');
  });

  it('sends message, receives streaming tokens, and handles done event', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('How does consensus work?');
    expect(sendMessage).toHaveBeenCalledWith('session-1', 'How does consensus work?', null, false);
    expect(chat.getState().activeRequestId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(chat.getState().messages).toHaveLength(2);

    // Push token stream events
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      token: 'Leader ',
    });
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      token: 'election.',
    });

    const assistantMsg = chat.getState().messages.find((m) => m.id === 'msg-assistant');
    expect(assistantMsg?.content).toBe('Leader election.');

    // Push done event
    const finalAssistant: ChatMessage = {
      id: 'msg-assistant',
      sessionId: 'session-1',
      role: 'assistant',
      ordinal: 1,
      content: 'Leader election. [src-1]',
      citations: [{ sourceId: 'src-1', label: 'Page 1', pageLabel: '1', heading: null }],
      status: 'complete',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      tokenCount: 4,
      errorMessage: null,
      createdAt: '2026-08-24T00:00:01.000Z',
      disclosures: [],
      webSources: [],
    };

    streamListener?.({
      type: 'done',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      message: finalAssistant,
    });

    expect(chat.getState().isStreaming).toBe(false);
    expect(chat.getState().activeRequestId).toBeNull();
    const updatedAssistant = chat.getState().messages.find((m) => m.id === 'msg-assistant');
    expect(updatedAssistant?.status).toBe('complete');
    expect(updatedAssistant?.citations).toHaveLength(1);
  });

  /**
   * A turn that fails after it crossed the bridge is reported by a stream event
   * carrying a request id and nothing the reader wrote. With no Retry control
   * left, the words have to come back on their own, and they can only come back
   * to the conversation that submitted them.
   */
  it('hands a provider-streaming failure’s prompt back to the composer', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Explain the quorum rule');

    streamListener?.({
      type: 'error',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      error: { __interleafError: true, code: 'internal', message: 'Provider crash' },
    });

    expect(chat.getState().lastFailedDraft).toBe('Explain the quorum rule');
    expect(chat.getState().isStreaming).toBe(false);
    expect(chat.getState().activeRequestId).toBeNull();
    expect(chat.getState().error).toBe('Provider crash');
  });

  it('keeps a failed prompt out of another conversation', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Explain the quorum rule');

    // The reader moves on before the provider gives up. The failure belongs to
    // the conversation that sent it and must not appear in this one.
    await chat.getState().switchSession('session-2');
    streamListener?.({
      type: 'error',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      error: { __interleafError: true, code: 'internal', message: 'Provider crash' },
    });

    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('forgets the prompt once the turn finishes', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Explain the quorum rule');

    streamListener?.({
      type: 'done',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      message: {
        id: 'msg-assistant',
        sessionId: 'session-1',
        role: 'assistant',
        ordinal: 1,
        content: 'A quorum is a majority.',
        citations: [],
        status: 'complete',
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        tokenCount: 5,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:01.000Z',
        disclosures: [],
        webSources: [],
      },
    });

    // A late error for a settled request has no prompt left to restore, so a
    // finished conversation cannot have an old question pushed back into it.
    streamListener?.({
      type: 'error',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      error: { __interleafError: true, code: 'internal', message: 'Late failure' },
    });

    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('cancels active streaming request when cancel is triggered', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Long generation');

    await chat.getState().cancel();
    expect(cancel).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
  });

  it('ignores stream events for mismatching documents or sessions', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Active query');

    // Event for wrong session ID
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'other-session',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      token: 'Wrong token',
    });

    const assistantMsg = chat.getState().messages.find((m) => m.id === 'msg-assistant');
    expect(assistantMsg?.content).toBe('');
  });
  /**
   * A recovery is handed over once. The composer takes the words and owns them
   * from that point, so the parked copy has to go with them: otherwise the same
   * prompt reappears every time the reader returns to the conversation, over
   * whatever they have since decided to write instead.
   */
  it('does not park a recovery the composer has already taken', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);
    sendMessage.mockRejectedValueOnce(new Error('provider offline'));
    await chat.getState().sendMessage('First attempt');
    expect(chat.getState().lastFailedDraft).toBe('First attempt');

    chat.getState().clearFailedDraft();
    expect(chat.getState().lastFailedDraft).toBeNull();

    await chat.getState().switchSession('session-2');
    expect(chat.getState().lastFailedDraft).toBeNull();
    await chat.getState().switchSession('session-1');
    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('changes session provider and model', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().changeSessionProvider('fake', 'fake-grounded');
    expect(updateSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      providerId: 'fake',
      modelId: 'fake-grounded',
      reasoningEffort: null,
    });
  });
  it('coalesces concurrent same-document initialization calls to invoke IPC once', async () => {
    const providersDeferred = deferred<readonly AIProviderStatus[]>();
    const sessionsDeferred = deferred<readonly ChatSession[]>();
    listProviders.mockImplementationOnce(() => providersDeferred.promise);
    listSessions.mockImplementationOnce(() => sessionsDeferred.promise);

    const p1 = chat.getState().initializeDocument(testDocument);
    const p2 = chat.getState().initializeDocument(testDocument);
    const p3 = chat.getState().initializeDocument(testDocument);

    providersDeferred.resolve([fakeProvider]);
    sessionsDeferred.resolve([session1]);

    await Promise.all([p1, p2, p3]);

    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(chat.getState().activeSessionId).toBe('session-1');
  });

  it('opening or initializing a document alone does not create a chat session', async () => {
    listSessions.mockResolvedValue([]);
    await chat.getState().initializeDocument(testDocument);

    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().sessions).toHaveLength(0);
    expect(chat.getState().activeSessionId).toBeNull();
  });

  it('Ask AI waits for in-flight document initialization and creates session on demand', async () => {
    const providersDeferred = deferred<readonly AIProviderStatus[]>();
    const sessionsDeferred = deferred<readonly ChatSession[]>();
    listProviders.mockImplementationOnce(() => providersDeferred.promise);
    listSessions.mockImplementationOnce(() => sessionsDeferred.promise);

    // 1. Start initialization (e.g. from ChatPanel mounting)
    const initPromise = chat.getState().initializeDocument(testDocument);
    expect(chat.getState().activeDocument?.id).toBe(testDocument.id);
    expect(chat.getState().isLoading).toBe(true);

    const descriptor = {
      format: 'pdf' as const,
      startPageIndex: 0,
      endPageIndex: 0,
      startPageLabel: '1',
      endPageLabel: '1',
      startQuote: { exact: 'Lazy session anchor target', prefix: '', suffix: '' },
      endQuote: { exact: 'Lazy session anchor target', prefix: '', suffix: '' },
    };

    // 2. Concurrently invoke addSelectionContext (Ask AI click)
    const addPromise = chat.getState().addSelectionContext(testDocument, descriptor, true);

    // Prove no session is created prematurely before providers/sessions resolve
    expect(createSession).not.toHaveBeenCalled();

    // 3. Resolve initialization
    providersDeferred.resolve([fakeProvider]);
    sessionsDeferred.resolve([]);

    await initPromise;
    const added = await addPromise;

    expect(added).toBe(true);
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(attachContext).toHaveBeenCalledTimes(1);
    expect(chat.getState().contextItems).toHaveLength(1);
  });

  it('redundant same-document initialize during active streaming is a no-op and preserves live request', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Live stream question');
    expect(chat.getState().isStreaming).toBe(true);
    const activeId = chat.getState().activeRequestId;
    expect(activeId).toBeTruthy();

    // Redundant same-document initialize call while streaming
    await chat.getState().initializeDocument(testDocument);
    expect(chat.getState().isStreaming).toBe(true);
    expect(chat.getState().activeRequestId).toBe(activeId);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('records the selected session before awaiting cancellation of a live request', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Live stream question');
    expect(chat.getState().isStreaming).toBe(true);

    const slowCancel = deferred<undefined>();
    cancel.mockReturnValueOnce(slowCancel.promise);
    listMessages.mockResolvedValueOnce([{ ...userMsg('m-session-2'), sessionId: 'session-2' }]);

    const switchPromise = chat.getState().switchSession('session-2');

    // The thread must be able to render session-2 while the cancel is pending.
    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().isLoading).toBe(true);
    expect(chat.getState().isStreaming).toBe(false);
    expect(chat.getState().messages).toHaveLength(0);

    slowCancel.resolve(undefined);
    await switchPromise;
    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().messages.map((m) => m.id)).toEqual(['m-session-2']);
    expect(chat.getState().isLoading).toBe(false);
  });

  it('stale switchSession completion cannot overwrite the newer active session', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);

    const firstMessages = deferred<readonly ChatMessage[]>();
    const secondMessages = deferred<readonly ChatMessage[]>();
    listMessages.mockImplementation((sessionId: string) =>
      sessionId === 'session-1' ? firstMessages.promise : secondMessages.promise
    );

    const staleSwitch = chat.getState().switchSession('session-1');
    const freshSwitch = chat.getState().switchSession('session-2');

    secondMessages.resolve([{ ...userMsg('m-b'), sessionId: 'session-2' }]);
    await freshSwitch;
    expect(chat.getState().activeSessionId).toBe('session-2');

    // The older switch resolves late with its own payload — it must be ignored.
    firstMessages.resolve([{ ...userMsg('m-a'), sessionId: 'session-1' }]);
    await staleSwitch;
    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().messages.map((m) => m.id)).toEqual(['m-b']);
  });

  it('initializeDocument(null) invalidates in-flight switchSession and in-flight initialization', async () => {
    // 1. In-flight switchSession invalidation on null
    await chat.getState().initializeDocument(testDocument);
    const pendingMessages = deferred<readonly ChatMessage[]>();
    const pendingContext = deferred<readonly ChatContextItem[]>();
    listMessages.mockImplementationOnce(() => pendingMessages.promise);
    listContext.mockImplementationOnce(() => pendingContext.promise);

    const switchPromise = chat.getState().switchSession('session-1');

    // Document closed/cleared while switch was in flight
    await chat.getState().initializeDocument(null);

    // Old switch resolves late
    pendingMessages.resolve([userMsg('m-late')]);
    pendingContext.resolve([{
      id: 'ctx-late',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: {},
      excerptText: 'Late text',
      excerptHash: 'h-late',
      documentHash: 'hash-chat-store',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: {},
      displayLabel: 'Late context',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    }]);
    await switchPromise;

    const stateAfterSwitch = chat.getState();
    expect(stateAfterSwitch.activeDocument).toBeNull();
    expect(stateAfterSwitch.activeSessionId).toBeNull();
    expect(stateAfterSwitch.messages).toHaveLength(0);
    expect(stateAfterSwitch.contextItems).toHaveLength(0);
    // 2. In-flight initializeDocument invalidation on null
    const initProviders = deferred<readonly AIProviderStatus[]>();
    const initSessions = deferred<readonly ChatSession[]>();
    listProviders.mockImplementationOnce(() => initProviders.promise);
    listSessions.mockImplementationOnce(() => initSessions.promise);

    const initPromise = chat.getState().initializeDocument(testDocument);
    await chat.getState().initializeDocument(null);

    initProviders.resolve([fakeProvider]);
    initSessions.resolve([session1]);
    await initPromise;

    const stateAfterInit = chat.getState();
    expect(stateAfterInit.activeDocument).toBeNull();
    expect(stateAfterInit.activeSessionId).toBeNull();
    expect(stateAfterInit.sessions).toHaveLength(0);
    expect(stateAfterInit.messages).toHaveLength(0);
    expect(stateAfterInit.contextItems).toHaveLength(0);
  });

  it('preserves the submitted draft for retry when the send IPC rejects', async () => {
    await chat.getState().initializeDocument(testDocument);
    const failure = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(failure.promise);

    const sendPromise = chat.getState().sendMessage('Explain quorum');
    failure.reject(new Error('provider offline'));
    await sendPromise;

    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.lastFailedDraft).toBe('Explain quorum');
    expect(state.error).toContain('provider offline');
    expect(state.messages).toHaveLength(0);

    // There is no retry action: sending the recovered draft again is an
    // ordinary turn that submits it verbatim and clears the parked copy.
    await chat.getState().sendMessage('Explain quorum');
    expect(sendMessage).toHaveBeenLastCalledWith('session-1', 'Explain quorum', null, false);
    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('cancels a returned stale request after the session switched mid-send', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);

    const slowSend = deferred<SendChatMessageResult>();
    // The switch lands once the turn is already in flight, which is the window
    // this guard exists for: a send refused before it is dispatched never
    // produces a request to cancel, so the switch has to happen after the call.
    sendMessage.mockImplementationOnce(() => {
      void chat.getState().switchSession('session-2');
      return slowSend.promise;
    });
    const sendPromise = chat.getState().sendMessage('Slow question');

    slowSend.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: { ...userMsg('u-stale'), content: 'Slow question' },
      assistantMessage: { ...assistantMsg('a-stale') },
    });
    await sendPromise;

    expect(cancel).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
    expect(chat.getState().activeRequestId).toBeNull();
    expect(chat.getState().isStreaming).toBe(false);
    expect(chat.getState().messages.map((m) => m.id)).not.toContain('a-stale');
  });

  it('keeps early streamed content when the invoke result carries an empty assistant row', async () => {
    await chat.getState().initializeDocument(testDocument);
    const slowSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(slowSend.promise);

    const sendPromise = chat.getState().sendMessage('Fast stream');
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      token: 'Early ',
    });
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      token: 'tokens',
    });
    // Tokens show while the invoke is still in flight.
    expect(chat.getState().messages.find((m) => m.id === 'msg-assistant')?.content).toBe('Early tokens');

    slowSend.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: userMsg('msg-user'),
      assistantMessage: assistantMsg('msg-assistant'),
    });
    await sendPromise;

    const streamed = chat.getState().messages.find((m) => m.id === 'msg-assistant');
    expect(streamed?.content).toBe('Early tokens');
    expect(streamed?.status).toBe('streaming');

    // Authoritative done event replaces buffered content without duplication
    // and pins the persisted ordinal.
    streamListener?.({
      type: 'done',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant',
      message: { ...assistantMsg('msg-assistant'), content: 'Early tokens finalized', status: 'complete', ordinal: 9 },
    });
    const settled = chat.getState().messages.find((m) => m.id === 'msg-assistant');
    expect(settled?.content).toBe('Early tokens finalized');
    expect(settled?.ordinal).toBe(9);
    expect(chat.getState().isStreaming).toBe(false);
  });

  it('ignores unknown-request tokens even when no request is active', async () => {
    await chat.getState().initializeDocument(testDocument);

    streamListener?.({
      type: 'token',
      requestId: '99999999-9999-4999-8999-999999999999',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'ghost-message',
      token: 'should be dropped',
    });

    const state = chat.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
  });

  it('replays early done event that arrived before sendMessage invoke resolved', async () => {
    await chat.getState().initializeDocument(testDocument);
    const slowSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(slowSend.promise);

    const sendPromise = chat.getState().sendMessage('Fast complete query');
    expect(chat.getState().isStreaming).toBe(true);

    // Early done arrives before invoke resolves
    streamListener?.({
      type: 'done',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant-fast-done',
      message: {
        ...assistantMsg('msg-assistant-fast-done'),
        content: 'Fast complete answer [src-1]',
        citations: [{ sourceId: 'src-1', label: 'Page 1', pageLabel: '1', heading: null }],
        status: 'complete',
        tokenCount: 4,
      },
    });

    slowSend.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: { ...userMsg('u-fast-done'), content: 'Fast complete query' },
      assistantMessage: { ...assistantMsg('msg-assistant-fast-done') },
    });

    await sendPromise;
    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
    // A finished turn leaves no notice behind: the answer is the outcome.
    expect(state.statusMessage).toBe('');
    const assistant = state.messages.find((m) => m.id === 'msg-assistant-fast-done');
    expect(assistant?.status).toBe('complete');
    expect(assistant?.content).toBe('Fast complete answer [src-1]');
    expect(assistant?.citations).toHaveLength(1);
  });

  it('replays early error event that arrived before sendMessage invoke resolved', async () => {
    await chat.getState().initializeDocument(testDocument);
    const slowSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(slowSend.promise);

    const sendPromise = chat.getState().sendMessage('Fast failing query');
    expect(chat.getState().isStreaming).toBe(true);

    // Early error arrives before invoke resolves
    streamListener?.({
      type: 'error',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant-fast-fail',
      error: {
        __interleafError: true,
        code: 'internal',
        message: 'Early provider crash',
      },
    });

    slowSend.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: { ...userMsg('u-fast-fail'), content: 'Fast failing query' },
      assistantMessage: { ...assistantMsg('msg-assistant-fast-fail') },
    });

    await sendPromise;
    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
    expect(state.error).toBe('Early provider crash');
  });

  it('hands back the prompt when a token, then a failure, both beat the invoke', async () => {
    // The order main can genuinely produce: a token reveals the request id, the
    // turn then fails, and only afterwards does the invoke that started it come
    // back. Knowing the id early must not let the failure be settled against a
    // turn the store cannot yet describe — the words submitted are not recorded
    // until the invoke resolves, and a failure settled before that would lose
    // them and then be undone by the resolving invoke.
    await chat.getState().initializeDocument(testDocument);
    const slowSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(slowSend.promise);

    const sendPromise = chat.getState().sendMessage('  Words worth keeping  ');

    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant-raced',
      token: 'Partial ',
    });
    expect(chat.getState().activeRequestId).toBe('550e8400-e29b-41d4-a716-446655440000');

    streamListener?.({
      type: 'error',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant-raced',
      error: { __interleafError: true, code: 'internal', message: 'Provider dropped the turn' },
    });

    slowSend.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: { ...userMsg('u-raced'), content: 'Words worth keeping' },
      assistantMessage: { ...assistantMsg('msg-assistant-raced') },
    });
    await sendPromise;
    // Lets the transcript re-read the failure branch schedules settle too, so
    // nothing arriving after the turn can put the request back.
    await Promise.resolve();
    await Promise.resolve();

    const settled = chat.getState();
    expect(settled.lastFailedDraft).toBe('Words worth keeping');
    expect(settled.activeRequestId).toBeNull();
    expect(settled.isStreaming).toBe(false);
    expect(settled.error).toBe('Provider dropped the turn');

    // The retired request cannot stream itself back to life.
    streamListener?.({
      type: 'token',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'msg-assistant-raced',
      token: 'resurrected',
    });
    expect(chat.getState().activeRequestId).toBeNull();
    expect(chat.getState().isStreaming).toBe(false);
  });

  it('survives deleteActiveSession late completion when user switches session in-flight', async () => {
    const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second Session' };
    listSessions.mockResolvedValue([session1, session2]);
    await chat.getState().initializeDocument(testDocument);
    expect(chat.getState().activeSessionId).toBe('session-1');

    const slowDelete = deferred<undefined>();
    deleteSession.mockReturnValueOnce(slowDelete.promise);

    // User clicks delete on session-1
    const deletePromise = chat.getState().deleteActiveSession();

    // User quickly switches to session-2 before delete finishes
    listMessages.mockResolvedValueOnce([{ ...userMsg('m-session-2'), sessionId: 'session-2' }]);
    await chat.getState().switchSession('session-2');
    expect(chat.getState().activeSessionId).toBe('session-2');
    expect(chat.getState().messages.map((m) => m.id)).toEqual(['m-session-2']);

    // Late delete IPC finishes for session-1
    slowDelete.resolve(undefined);
    await deletePromise;

    // Session-2 and its payload must survive completely!
    const state = chat.getState();
    expect(state.activeSessionId).toBe('session-2');
    expect(state.messages.map((m) => m.id)).toEqual(['m-session-2']);
    expect(state.sessions.map((s) => s.id)).toEqual(['session-2']);
  });
  it('drops late tokens from an old cancelled request after document reinitialization while new request streams normally', async () => {
    await chat.getState().initializeDocument(testDocument);
    const oldSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(oldSend.promise);

    // Start send on request A
    const oldSendPromise = chat.getState().sendMessage('Old question');
    oldSend.resolve({
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: { ...userMsg('u-old'), content: 'Old question' },
      assistantMessage: { ...assistantMsg('a-old'), requestId: '11111111-1111-4111-8111-111111111111' },
    });
    await oldSendPromise;
    expect(chat.getState().activeRequestId).toBe('11111111-1111-4111-8111-111111111111');

    // Reinitialize document while request A was active
    await chat.getState().initializeDocument(null);
    await chat.getState().initializeDocument(testDocument);
    expect(chat.getState().activeRequestId).toBeNull();
    expect(chat.getState().isStreaming).toBe(false);

    // Start new send on request B
    const newSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(newSend.promise);
    const newSendPromise = chat.getState().sendMessage('New question');

    // A late token from old request A arrives while new send is in flight
    streamListener?.({
      type: 'token',
      requestId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'a-old',
      token: 'Ghost token from cancelled turn',
    });

    // Verify the old token was completely ignored and not added to state
    expect(chat.getState().messages.find((m) => m.id === 'a-old')).toBeUndefined();

    // Resolve new send on request B
    newSend.resolve({
      requestId: '22222222-2222-4222-8222-222222222222',
      userMessage: { ...userMsg('u-new'), content: 'New question' },
      assistantMessage: { ...assistantMsg('a-new'), requestId: '22222222-2222-4222-8222-222222222222' },
    });
    await newSendPromise;

    // Emit valid token for request B
    streamListener?.({
      type: 'token',
      requestId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'a-new',
      token: 'Valid token B',
    });

    // Verify only request B content exists
    const newAssistant = chat.getState().messages.find((m) => m.id === 'a-new');
    expect(newAssistant?.content).toBe('Valid token B');
    expect(chat.getState().messages.find((m) => m.id === 'a-old')).toBeUndefined();
  });

  it('cleans up and retires pending terminal entries when send IPC rejects and drops late tokens on subsequent send', async () => {
    await chat.getState().initializeDocument(testDocument);
    const sendFailure = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(sendFailure.promise);

    const sendPromise = chat.getState().sendMessage('Failing question');

    // Early error arrives while invoke is pending for request 3333...
    streamListener?.({
      type: 'error',
      requestId: '33333333-3333-4333-8333-333333333333',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'a-err',
      error: {
        __interleafError: true,
        code: 'internal',
        message: 'IPC reject error',
      },
    });

    sendFailure.reject(new Error('Network error'));
    await sendPromise;

    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
    expect(state.error).toContain('Network error');

    // Start a fresh new send in the same session
    const nextSend = deferred<SendChatMessageResult>();
    sendMessage.mockReturnValueOnce(nextSend.promise);
    const nextSendPromise = chat.getState().sendMessage('Next valid question');

    // A late token for the previously rejected request arrives while next send is pending
    streamListener?.({
      type: 'token',
      requestId: '33333333-3333-4333-8333-333333333333',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'a-err',
      token: 'Zombie token from rejected request',
    });

    // The zombie token must be completely dropped
    expect(chat.getState().messages.find((m) => m.id === 'a-err')).toBeUndefined();

    // Resolve the next send
    nextSend.resolve({
      requestId: '44444444-4444-4444-8444-444444444444',
      userMessage: { ...userMsg('u-next'), content: 'Next valid question' },
      assistantMessage: { ...assistantMsg('a-next'), requestId: '44444444-4444-4444-8444-444444444444' },
    });
    await nextSendPromise;

    // Emit token for the valid request
    streamListener?.({
      type: 'token',
      requestId: '44444444-4444-4444-8444-444444444444',
      sessionId: 'session-1',
      documentId: testDocument.id,
      messageId: 'a-next',
      token: 'Valid response token',
    });

    // Verify valid turn binds and streams normally
    const nextAssistant = chat.getState().messages.find((m) => m.id === 'a-next');
    expect(nextAssistant?.content).toBe('Valid response token');
    expect(chat.getState().messages.find((m) => m.id === 'a-err')).toBeUndefined();
  });

  describe('attached context chips outlive the turns that send them', () => {
    const chip = (id: string): ChatContextItem => ({
      id,
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: {},
      excerptText: `Excerpt ${id}`,
      excerptHash: `hash-${id}`,
      documentHash: 'hash-chat-store',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: {},
      displayLabel: `Excerpt ${id}`,
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    });

    const accepted = (): SendChatMessageResult => ({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: userMsg('u-consume'),
      assistantMessage: assistantMsg('a-consume'),
    });

    const chipIds = (): string[] => chat.getState().contextItems.map((item) => item.id);

    it('keeps every chip when the send is rejected and after the accepted turn that follows', async () => {
      listContext.mockResolvedValue([chip('ctx-1'), chip('ctx-2')]);
      await chat.getState().initializeDocument(testDocument);
      sendMessage.mockRejectedValueOnce(new Error('Provider is unavailable.'));

      await chat.getState().sendMessage('Explain the first excerpt');

      expect(chipIds()).toEqual(['ctx-1', 'ctx-2']);
      expect(chat.getState().error).toBe('Provider is unavailable.');
      sendMessage.mockResolvedValueOnce(accepted());
      await chat.getState().sendMessage('Explain the first excerpt');
      expect(chipIds()).toEqual(['ctx-1', 'ctx-2']);
    });

    it('keeps a chip attached while the send was in flight', async () => {
      listContext.mockResolvedValue([chip('ctx-1')]);
      await chat.getState().initializeDocument(testDocument);
      const slowSend = deferred<SendChatMessageResult>();
      sendMessage.mockReturnValueOnce(slowSend.promise);

      const sendPromise = chat.getState().sendMessage('Explain the first excerpt');
      attachContext.mockResolvedValueOnce(chip('ctx-late'));
      await chat.getState().addSelectionContext(
        testDocument,
        {
          format: 'pdf',
          startPageIndex: 0,
          endPageIndex: 0,
          startQuote: { exact: 'Late selection', prefix: '', suffix: '' },
          endQuote: { exact: 'Late selection', prefix: '', suffix: '' },
        },
        false
      );
      slowSend.resolve(accepted());
      await sendPromise;

      expect(chipIds()).toEqual(['ctx-1', 'ctx-late']);
    });

    it('removes a chip only when the reader removes it', async () => {
      listContext.mockResolvedValue([chip('ctx-1'), chip('ctx-2')]);
      await chat.getState().initializeDocument(testDocument);
      sendMessage.mockResolvedValueOnce(accepted());
      await chat.getState().sendMessage('Explain the first excerpt');

      await chat.getState().removeContext('ctx-1');

      expect(removeContext).toHaveBeenCalledWith('session-1', 'ctx-1');
      expect(chipIds()).toEqual(['ctx-2']);
      // The chip leaving is the confirmation; no status line lingers after it.
      expect(chat.getState().statusMessage).toBe('');
    });

    it('clears exactly the chips a successful clean reports', async () => {
      listContext.mockResolvedValue([chip('ctx-1'), chip('ctx-2')]);
      await chat.getState().initializeDocument(testDocument);
      cleanContext.mockResolvedValueOnce({
        sessionId: 'session-1',
        compactedThroughOrdinal: 1,
        summaryTextUnits: 120,
        clearedContextItemIds: ['ctx-1', 'ctx-2'],
      });

      await expect(chat.getState().cleanContext()).resolves.toBe(true);

      expect(cleanContext).toHaveBeenCalledWith('session-1');
      expect(chipIds()).toEqual([]);
      expect(chat.getState().isCleaningContext).toBe(false);
    });

    it('records the compaction boundary a successful clean reports', async () => {
      await chat.getState().initializeDocument(testDocument);
      expect(chat.getState().sessions[0]?.compactedThroughOrdinal).toBeNull();
      cleanContext.mockResolvedValueOnce({
        sessionId: 'session-1',
        compactedThroughOrdinal: 5,
        summaryTextUnits: 120,
        clearedContextItemIds: [],
      });

      await expect(chat.getState().cleanContext()).resolves.toBe(true);

      // The boundary is the only compaction state a surface sees; the summary
      // itself never crosses the bridge.
      const session = chat.getState().sessions.find((entry) => entry.id === 'session-1');
      expect(session?.compactedThroughOrdinal).toBe(5);
      expect(Object.keys(session ?? {})).not.toContain('contextSummary');
    });

    it('hydrates the stored boundary on reload and on a session switch', async () => {
      const compacted: ChatSession = { ...session1, compactedThroughOrdinal: 3 };
      const fresh: ChatSession = {
        ...session1,
        id: 'session-2',
        title: 'Second Chat',
        compactedThroughOrdinal: null,
      };
      listSessions.mockResolvedValue([compacted, fresh]);
      getSession.mockResolvedValue(compacted);

      await chat.getState().initializeDocument(testDocument);

      // Restart: the boundary main stored comes back with the session row.
      expect(
        chat.getState().sessions.find((entry) => entry.id === 'session-1')?.compactedThroughOrdinal
      ).toBe(3);
      await chat.getState().switchSession('session-2');
      expect(
        chat.getState().sessions.find((entry) => entry.id === 'session-2')?.compactedThroughOrdinal
      ).toBeNull();
    });

    it('records the boundary even when the reader switched conversations mid-clean', async () => {
      const other: ChatSession = { ...session1, id: 'session-2', title: 'Second Chat' };
      listSessions.mockResolvedValue([session1, other]);
      listContext.mockResolvedValue([chip('ctx-1')]);
      await chat.getState().initializeDocument(testDocument);
      const pending = deferred<CleanChatContextResult>();
      cleanContext.mockReturnValueOnce(pending.promise);

      const cleaning = chat.getState().cleanContext();
      // Away to another conversation while the compaction is still running: the
      // one in view is not the one being cleaned, so it is not disabled.
      await chat.getState().switchSession('session-2');
      expect(chat.getState().isCleaningContext).toBe(false);

      pending.resolve({
        sessionId: 'session-1',
        compactedThroughOrdinal: 7,
        summaryTextUnits: 80,
        clearedContextItemIds: ['ctx-1'],
      });
      await expect(cleaning).resolves.toBe(true);

      // The boundary belongs to its own session and is recorded regardless, so
      // switching back reads the compacted conversation rather than a stale one.
      expect(
        chat.getState().sessions.find((entry) => entry.id === 'session-1')?.compactedThroughOrdinal
      ).toBe(7);
      // Only the visible surface was bound to the session still being active.
      expect(chat.getState().statusMessage).toBe('');
      await chat.getState().switchSession('session-1');
      expect(chat.getState().isCleaningContext).toBe(false);
    });

    it('disables only the conversation being cleaned, and again when it comes back', async () => {
      const other: ChatSession = { ...session1, id: 'session-2', title: 'Second Chat' };
      listSessions.mockResolvedValue([session1, other]);
      await chat.getState().initializeDocument(testDocument);
      const pending = deferred<CleanChatContextResult>();
      cleanContext.mockReturnValueOnce(pending.promise);

      const cleaning = chat.getState().cleanContext();
      expect(chat.getState().isCleaningContext).toBe(true);
      await chat.getState().switchSession('session-2');
      expect(chat.getState().isCleaningContext).toBe(false);
      // Back to the conversation that is still being cleaned: disabled again,
      // rather than left enabled or disabled for the unrelated one forever.
      await chat.getState().switchSession('session-1');
      expect(chat.getState().isCleaningContext).toBe(true);

      pending.resolve({
        sessionId: 'session-1',
        compactedThroughOrdinal: 1,
        summaryTextUnits: 10,
        clearedContextItemIds: [],
      });
      await cleaning;
      expect(chat.getState().isCleaningContext).toBe(false);
    });

    it('refuses a programmatic send while cleaning without losing the draft', async () => {
      await chat.getState().initializeDocument(testDocument);
      const pending = deferred<CleanChatContextResult>();
      cleanContext.mockReturnValueOnce(pending.promise);
      const cleaning = chat.getState().cleanContext();

      // The composer is disabled while this runs; a programmatic caller still
      // has to fail locally, and the message it was asked to send is named back
      // to the reader rather than silently dropped.
      await chat.getState().sendMessage('A turn mid-clean?');

      expect(sendMessage).not.toHaveBeenCalled();
      expect(chat.getState().error).toMatch(/being cleaned/iu);
      expect(chat.getState().isStreaming).toBe(false);

      pending.resolve({
        sessionId: 'session-1',
        compactedThroughOrdinal: 1,
        summaryTextUnits: 10,
        clearedContextItemIds: [],
      });
      await cleaning;
      // And the same message goes through once the clean is done.
      sendMessage.mockResolvedValueOnce(accepted());
      await chat.getState().sendMessage('A turn mid-clean?');
      expect(sendMessage).toHaveBeenCalledWith('session-1', 'A turn mid-clean?', null, false);
    });

    it('leaves the chips and reports the failure when a clean fails', async () => {
      listContext.mockResolvedValue([chip('ctx-1')]);
      await chat.getState().initializeDocument(testDocument);
      cleanContext.mockRejectedValueOnce(new Error('Provider is unavailable.'));

      await expect(chat.getState().cleanContext()).resolves.toBe(false);

      expect(chipIds()).toEqual(['ctx-1']);
      expect(chat.getState().error).toBe('Provider is unavailable.');
      expect(chat.getState().isCleaningContext).toBe(false);
    });

    it('refuses to clean while a response is streaming', async () => {
      listContext.mockResolvedValue([chip('ctx-1')]);
      await chat.getState().initializeDocument(testDocument);
      const slowSend = deferred<SendChatMessageResult>();
      sendMessage.mockReturnValueOnce(slowSend.promise);
      const sendPromise = chat.getState().sendMessage('Explain the first excerpt');

      await expect(chat.getState().cleanContext()).resolves.toBe(false);
      expect(cleanContext).not.toHaveBeenCalled();

      slowSend.resolve(accepted());
      await sendPromise;
    });
  });
});

function userMsg(id: string): ChatMessage {
  return {
    id,
    sessionId: 'session-1',
    role: 'user',
    ordinal: 0,
    content: 'Question',
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: 1,
    errorMessage: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    disclosures: [],
    webSources: [],
  };
}

function assistantMsg(id: string): ChatMessage {
  return {
    id,
    sessionId: 'session-1',
    role: 'assistant',
    ordinal: 1,
    content: '',
    citations: [],
    status: 'streaming',
    requestId: '550e8400-e29b-41d4-a716-446655440000',
    tokenCount: null,
    errorMessage: null,
    createdAt: '2026-08-24T00:00:01.000Z',
    disclosures: [],
    webSources: [],
  };
}
