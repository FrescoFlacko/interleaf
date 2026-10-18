// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type {
  AIProviderStatus,
  ChatContextItem,
  ChatMessage,
  ChatSession,
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
 * The provider a conversation is created with, when the reader chooses one
 * while it is being created.
 *
 * Creating a conversation is not always an explicit act: `Ask AI` creates one
 * through `ensureSessionForDocument`, and that call waits for provider
 * discovery — seconds, against real CLIs and a loopback server — before it
 * decides anything. The provider menu is live for that entire window. So a
 * reader can, in one uninterrupted gesture, choose OpenRouter and ask a
 * question, and have the session created from the *first ready provider*
 * instead: whatever happens to be installed on that machine.
 *
 * These are the sequencing rules that decide the outcome. They are written
 * against the store because the store is where the three things that must
 * agree meet: what the panel shows, what is persisted on the session, and
 * which provider main is asked to spawn.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-provider-race',
  title: 'Provider Race',
  author: 'Test Author',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-provider-race',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  source: null,
};

/** A ready CLI provider, standing for whatever is installed on the machine. */
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

/** The provider the reader chooses. Listed second, so first-ready is not it. */
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

/** Configured but signed out: a choice that must fail rather than fall back. */
const unavailableProvider: AIProviderStatus = {
  ...openRouterProvider,
  id: 'claude',
  name: 'Claude Code',
  available: true,
  installed: true,
  authentication: 'disconnected',
  models: [{ id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 200_000, maxOutputTokens: 32_000, supportsStreaming: true }],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sessionRow(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-new',
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

const selectionDescriptor = {
  format: 'pdf' as const,
  startPageIndex: 0,
  endPageIndex: 0,
  startPageLabel: '1',
  endPageLabel: '1',
  startQuote: { exact: 'A passage worth asking about', prefix: '', suffix: '' },
  endQuote: { exact: 'A passage worth asking about', prefix: '', suffix: '' },
};

describe('explicit provider selection during session creation', () => {
  const listProviders = vi.fn<() => Promise<readonly AIProviderStatus[]>>();
  const listSessions = vi.fn<(documentId: string) => Promise<readonly ChatSession[]>>();
  const createSession = vi.fn<(input: { documentId: string; providerId: string; modelId?: string | null }) => Promise<ChatSession>>();
  const updateSession = vi.fn<(input: { sessionId: string; providerId?: string; modelId?: string | null }) => Promise<ChatSession>>();
  const listMessages = vi.fn<() => Promise<readonly ChatMessage[]>>(() => Promise.resolve([]));
  const listContext = vi.fn<() => Promise<readonly ChatContextItem[]>>(() => Promise.resolve([]));
  const attachContext = vi.fn(
    (): Promise<ChatContextItem> =>
      Promise.resolve({
        id: 'ctx-1',
        sessionId: 'session-new',
        kind: 'selection' as const,
        sourceRef: {},
        excerptText: 'A passage worth asking about',
        excerptHash: 'h-1',
        documentHash: testDocument.fileHash,
        location: { format: 'pdf' as const, pageIndex: 0 },
        provenance: {},
        displayLabel: 'A passage worth asking about',
        pinned: true,
        createdAt: '2026-09-22T00:00:00.000Z',
      })
  );

  beforeEach(() => {
    vi.clearAllMocks();
    listProviders.mockReset().mockResolvedValue([installedProvider, openRouterProvider]);
    listSessions.mockReset().mockResolvedValue([]);
    createSession
      .mockReset()
      .mockImplementation((input) =>
        Promise.resolve(sessionRow({ providerId: input.providerId as ChatSession['providerId'], modelId: input.modelId ?? null }))
      );
    // Main is the authority on a rebinding, and it re-validates readiness; the
    // fixture answers the way main does, echoing the binding it accepted.
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
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        getSession: vi.fn(() => Promise.resolve(null)),
        createSession,
        updateSession,
        listMessages,
        listContext,
        attachContext,
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage: vi.fn(),
        cancel: vi.fn(() => Promise.resolve(undefined)),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
  });

  it('binds the session Ask AI creates to a provider chosen while discovery was still running', async () => {
    const providers = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => providers.promise);

    // Ask AI: the create is already decided on, and waits for discovery.
    const asked = chat.getState().addSelectionContext(testDocument, selectionDescriptor, true);
    expect(createSession).not.toHaveBeenCalled();

    // The reader chooses in that window. There is no session to carry it yet.
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');

    providers.resolve([installedProvider, openRouterProvider]);
    expect(await asked).toBe(true);

    // The choice reached the conversation that was created for it — not the
    // first ready provider, which is what the machine would have supplied.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({
      documentId: testDocument.id,
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
      reasoningEffort: null,
    });
    const active = chat.getState().sessions.find((session) => session.id === chat.getState().activeSessionId);
    expect(active?.providerId).toBe('openrouter');
    // Consumed: the conversation now carries the binding, so the next one it
    // does not silently inherit it.
    expect(chat.getState().pendingProviderId).toBeNull();
  });

  it('moves a conversation onto a choice made after the create was issued', async () => {
    await chat.getState().initializeDocument(testDocument);
    const created = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => created.promise);

    const creating = chat.getState().createSession();
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    created.resolve(sessionRow({ providerId: 'fake', modelId: 'fake-grounded' }));
    const session = await creating;

    expect(updateSession).toHaveBeenCalledWith({
      sessionId: 'session-new',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
      reasoningEffort: null,
    });
    expect(session?.providerId).toBe('openrouter');
    expect(chat.getState().sessions[0]?.providerId).toBe('openrouter');
  });

  it('gives the newest choice the conversation when several are made while it is created', async () => {
    await chat.getState().initializeDocument(testDocument);
    const created = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => created.promise);

    const creating = chat.getState().createSession();
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    await chat.getState().selectProvider('fake', 'fake-grounded');
    created.resolve(sessionRow({ providerId: 'openrouter', modelId: 'openrouter/auto' }));
    const session = await creating;

    expect(session?.providerId).toBe('fake');
    expect(chat.getState().sessions[0]?.modelId).toBe('fake-grounded');
  });

  it('refuses to create a conversation on a chosen provider that cannot run a turn', async () => {
    listProviders.mockResolvedValue([installedProvider, unavailableProvider]);
    await chat.getState().initializeDocument(testDocument);

    await chat.getState().selectProvider('claude', 'claude-opus-5');
    const session = await chat.getState().createSession();

    expect(session).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    // Named, and about the provider that was chosen: no other provider is
    // substituted for it, silently or otherwise.
    expect(chat.getState().error).toContain('Claude Code');
  });

  it('reports main refusing the rebinding instead of leaving a provider it refused on screen', async () => {
    await chat.getState().initializeDocument(testDocument);
    const created = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => created.promise);
    updateSession.mockRejectedValueOnce(new Error('OpenRouter is not connected.'));

    const creating = chat.getState().createSession();
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');
    created.resolve(sessionRow({ providerId: 'fake', modelId: 'fake-grounded' }));
    await creating;

    expect(chat.getState().error).toContain('OpenRouter is not connected.');
  });

  it('does not let a create that finishes late take the screen from the conversation the reader opened', async () => {
    listSessions.mockResolvedValue([sessionRow({ id: 'session-existing', title: 'Earlier chat' })]);
    await chat.getState().initializeDocument(testDocument);
    // The document initialization enters the existing conversation; the reader
    // asks for a new one, then goes back to the one they were reading.
    const created = deferred<ChatSession>();
    createSession.mockImplementationOnce(() => created.promise);
    const creating = chat.getState().createSession();
    await chat.getState().switchSession('session-existing');

    created.resolve(sessionRow({ id: 'session-late' }));
    await creating;

    expect(chat.getState().activeSessionId).toBe('session-existing');
    expect(chat.getState().sessions.map((session) => session.id)).toContain('session-late');
  });

  it('keeps a rebinding of the open conversation on the newest choice when two are in flight', async () => {
    listSessions.mockResolvedValue([sessionRow({ id: 'session-existing' })]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-existing');

    const slow = deferred<ChatSession>();
    updateSession.mockImplementationOnce(() => slow.promise);
    const first = chat.getState().selectProvider('openrouter', 'openrouter/auto');
    const second = chat.getState().selectProvider('fake', 'fake-grounded');
    await second;
    // The earlier rebinding answers last, and must not reinstate itself.
    slow.resolve(sessionRow({ id: 'session-existing', providerId: 'openrouter', modelId: 'openrouter/auto' }));
    await first;

    expect(chat.getState().sessions[0]?.providerId).toBe('fake');
  });

  it('rebinds the open conversation rather than the next one when a session already exists', async () => {
    listSessions.mockResolvedValue([sessionRow({ id: 'session-existing' })]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().switchSession('session-existing');

    await chat.getState().selectProvider('openrouter', 'openrouter/auto');

    expect(updateSession).toHaveBeenCalledWith({
      sessionId: 'session-existing',
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
      reasoningEffort: null,
    });
    expect(chat.getState().pendingProviderId).toBeNull();
  });

  it('forgets a choice made for another document', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().selectProvider('openrouter', 'openrouter/auto');

    await chat.getState().initializeDocument({ ...testDocument, id: 'doc-other', fileHash: 'hash-other' });

    expect(chat.getState().pendingProviderId).toBeNull();
    expect(chat.getState().pendingModelId).toBeNull();
  });
});
