// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type {
  AIProviderStatus,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  SendChatMessageResult,
} from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * What a turn is spawned from while the reader's choice and the stored binding
 * disagree.
 *
 * Moving a conversation to another provider is not instant: main re-validates
 * readiness and writes the row, and until it answers the session in the store
 * still carries the provider the reader is moving *away from*. A send in that
 * window has an old row to read and a new name on screen. Sending on the row is
 * the one outcome that cannot be allowed — it spawns the turn from a provider
 * the reader has already rejected, which on a paid provider is their money — so
 * every one of these says the same thing: nothing is sent until the two agree,
 * the refusal names what happened, and the question is handed back.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-binding',
  title: 'Binding Under Change',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-binding',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  source: null,
};

const otherDocument: DocumentMetadata = {
  ...testDocument,
  id: 'doc-binding-other',
  title: 'Another Book',
  fileHash: 'hash-binding-other',
};

const installedProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [
    { id: 'fake-grounded', name: 'Deterministic Grounded Model', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true },
  ],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
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
    { id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true },
  ],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
};

const claudeProvider: AIProviderStatus = {
  ...openRouterProvider,
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  models: [{ id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 200_000, maxOutputTokens: 32_000, supportsStreaming: true }],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sessionRow(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-bound',
    documentId: testDocument.id,
    documentHash: testDocument.fileHash,
    title: 'Conversation 1',
    providerId: 'fake',
    modelId: 'fake-grounded',
    reasoningEffort: null,
    messageCount: 0,
    previewText: null,
    isArchived: false,
    compactedThroughOrdinal: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

function sentResult(sessionId: string): SendChatMessageResult {
  const base = {
    id: 'msg-user',
    sessionId,
    role: 'user' as const,
    content: 'Who elects the leader?',
    status: 'complete' as const,
    ordinal: 0,
    citations: [],
    webSources: [],
    disclosures: [],
    errorMessage: null,
    requestId: 'req-1',
    tokenCount: null,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  return {
    requestId: 'req-1',
    userMessage: base,
    assistantMessage: { ...base, id: 'msg-assistant', role: 'assistant', status: 'streaming', ordinal: 1 },
  };
}

describe('sending while a conversation is being rebound', () => {
  const listProviders = vi.fn<() => Promise<readonly AIProviderStatus[]>>();
  const listSessions = vi.fn<(documentId: string) => Promise<readonly ChatSession[]>>();
  const createSession = vi.fn<(input: { documentId: string; providerId: string; modelId?: string | null }) => Promise<ChatSession>>();
  const updateSession = vi.fn<(input: { sessionId: string; providerId?: string; modelId?: string | null }) => Promise<ChatSession>>();
  const sendMessage = vi.fn<(sessionId: string) => Promise<SendChatMessageResult>>();
  const listMessages = vi.fn<() => Promise<readonly ChatMessage[]>>(() => Promise.resolve([]));
  const listContext = vi.fn<() => Promise<readonly ChatContextItem[]>>(() => Promise.resolve([]));

  /** The conversation as it stands in the store, by the store's own reckoning. */
  function activeSession(): ChatSession | undefined {
    const state = chat.getState();
    return state.sessions.find((session) => session.id === state.activeSessionId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listProviders.mockReset().mockResolvedValue([installedProvider, openRouterProvider, claudeProvider]);
    listSessions.mockReset().mockImplementation((documentId) =>
      Promise.resolve(documentId === testDocument.id ? [sessionRow()] : [])
    );
    createSession
      .mockReset()
      .mockImplementation((input) =>
        Promise.resolve(sessionRow({ providerId: input.providerId as ChatSession['providerId'], modelId: input.modelId ?? null }))
      );
    updateSession
      .mockReset()
      .mockImplementation((input) =>
        Promise.resolve(
          sessionRow({
            id: input.sessionId,
            providerId: (input.providerId ?? 'fake') as ChatSession['providerId'],
            modelId: input.modelId ?? null,
          })
        )
      );
    sendMessage.mockReset().mockImplementation((sessionId) => Promise.resolve(sentResult(sessionId)));
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        getSession: vi.fn(() => Promise.resolve(null)),
        createSession,
        updateSession,
        listMessages,
        listContext,
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage,
        cancel: vi.fn(() => Promise.resolve(undefined)),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
  });

  it('sends nothing while the move to the chosen provider is still in flight', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-bound');
    const rebinding = deferred<ChatSession>();
    updateSession.mockImplementationOnce(() => rebinding.promise);

    const choosing = chat.getState().selectProvider('openrouter', 'openrouter/auto');
    // The reader types and submits before main has answered — the whole point of
    // the window. The composer has already cleared itself by now.
    await chat.getState().sendMessage('Who elects the leader?');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(chat.getState().error).toContain('OpenRouter');
    // Their question came back rather than disappearing with the refusal.
    expect(chat.getState().lastFailedDraft).toBe('Who elects the leader?');

    rebinding.resolve(sessionRow({ id: 'session-bound', providerId: 'openrouter', modelId: 'openrouter/auto' }));
    await choosing;

    // Settled: one answer everywhere, and the turn now goes.
    expect(chat.getState().bindingIntents['session-bound']).toBeUndefined();
    expect(activeSession()?.providerId).toBe('openrouter');
    await chat.getState().sendMessage('Who elects the leader?');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe('session-bound');
  });

  it('does not fall back to the old provider when main refuses the move', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-bound');
    updateSession.mockImplementationOnce(() => Promise.reject(new Error('OpenRouter needs an API key in Settings.')));

    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    expect(chat.getState().error).toContain('OpenRouter needs an API key');

    await chat.getState().sendMessage('Who elects the leader?');

    // The row still says `fake`, and that is exactly why nothing was sent.
    expect(activeSession()?.providerId).toBe('fake');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(chat.getState().error).toContain('OpenRouter needs an API key');
    expect(chat.getState().lastFailedDraft).toBe('Who elects the leader?');

    // Choosing again is the way out, and it clears the refusal it replaces.
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    expect(chat.getState().bindingIntents['session-bound']).toBeUndefined();
    await chat.getState().sendMessage('Who elects the leader?');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('will not spawn a turn from the binding a just-created conversation was born with', async () => {
    listSessions.mockResolvedValue([]);
    await chat.getState().initializeDocument(testDocument);
    const created = deferred<ChatSession>();
    const rebinding = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => created.promise);
    updateSession.mockImplementationOnce(() => rebinding.promise);

    const creating = chat.getState().createSession();
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    created.resolve(sessionRow({ providerId: 'fake', modelId: 'fake-grounded' }));
    // The session is published and switched to; its stored binding is still the
    // one discovery supplied, and the reader's choice is still with main.
    await Promise.resolve();
    await Promise.resolve();
    await chat.getState().sendMessage('Who elects the leader?');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(chat.getState().error).toContain('OpenRouter');

    rebinding.resolve(sessionRow({ providerId: 'openrouter', modelId: 'openrouter/auto' }));
    const session = await creating;
    expect(session?.providerId).toBe('openrouter');
    await chat.getState().sendMessage('Who elects the leader?');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('lets the newest choice stand when an older one answers after it', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-bound');
    const older = deferred<ChatSession>();
    updateSession.mockImplementationOnce(() => older.promise);

    const first = chat.getState().selectProvider('claude', 'claude-opus-5');
    const second = chat.getState().selectProvider('openrouter', 'openrouter/auto');
    await second;

    // The newer choice has settled. The older one is still in flight.
    expect(activeSession()?.providerId).toBe('openrouter');
    expect(chat.getState().bindingIntents['session-bound']).toBeUndefined();

    older.resolve(sessionRow({ id: 'session-bound', providerId: 'claude', modelId: 'claude-opus-5' }));
    await first;

    // It published nothing: not the binding, not an intent, not an error.
    expect(activeSession()?.providerId).toBe('openrouter');
    expect(chat.getState().bindingIntents['session-bound']).toBeUndefined();
    expect(chat.getState().error).toBeNull();

    await chat.getState().sendMessage('Who elects the leader?');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves another conversation able to send while this one is unsettled', async () => {
    const second = sessionRow({ id: 'session-second', providerId: 'fake', title: 'Conversation 2' });
    listSessions.mockResolvedValue([sessionRow(), second]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-bound');
    const rebinding = deferred<ChatSession>();
    updateSession.mockImplementationOnce(() => rebinding.promise);

    const choosing = chat.getState().selectProvider('openrouter', 'openrouter/auto');
    await chat.getState().switchSession('session-second');
    await chat.getState().sendMessage('Who elects the leader?');

    // The unsettled binding belongs to the conversation the reader left, and
    // says nothing about this one.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe('session-second');
    rebinding.resolve(sessionRow({ id: 'session-bound', providerId: 'openrouter', modelId: 'openrouter/auto' }));
    await choosing;
    expect(chat.getState().sessions.find((row) => row.id === 'session-bound')?.providerId).toBe('openrouter');
  });

  it('changes nothing in the document the reader moved to when a late rebinding answers', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-bound');
    const rebinding = deferred<ChatSession>();
    updateSession.mockImplementationOnce(() => rebinding.promise);

    const choosing = chat.getState().selectProvider('openrouter', 'openrouter/auto');
    await chat.getState().initializeDocument(otherDocument);
    rebinding.reject(new Error('Provider went away while you were reading something else.'));
    await choosing;

    // The other document's status line, loading state and intents are its own.
    expect(chat.getState().activeDocument?.id).toBe(otherDocument.id);
    expect(chat.getState().error).toBeNull();
    expect(chat.getState().bindingIntents).toEqual({});
    expect(chat.getState().sessions).toEqual([]);
  });
});
