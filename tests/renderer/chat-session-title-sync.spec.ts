// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import type { AIProviderStatus, ChatSession, ChatSessionTitleChangedEvent, ChatStreamEvent } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

const CREATED = '2026-10-10T00:00:00.000Z';

const testDocument: DocumentMetadata = {
  id: 'doc-titles', title: 'Titles', author: null, format: 'pdf', storageMode: 'managed', fileSize: 1024, fileMtimeMs: 1,
  fileHash: 'hash-titles', pageCount: 5, folderId: null, storageHealth: 'ok', readingPosition: null,
  createdAt: CREATED, updatedAt: CREATED, source: null,
};

const provider: AIProviderStatus = {
  id: 'fake', name: 'Test Provider', available: true, installed: true, authentication: 'connected', version: '1.0', errorMessage: null,
  models: [{ id: 'fake-grounded', name: 'Model', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
};

const session: ChatSession = {
  id: 'session-1', documentId: 'doc-titles', documentHash: 'hash-titles', title: 'Conversation 1', providerId: 'fake',
  modelId: 'fake-grounded', reasoningEffort: null, messageCount: 2, previewText: 'An answer.', isArchived: false, compactedThroughOrdinal: null,
  createdAt: CREATED, updatedAt: CREATED,
};

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Lets every queued promise callback run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('automatic title events in the chat store', () => {
  let chat: ChatStore;
  let emitTitle: ((event: ChatSessionTitleChangedEvent) => void) | null;
  let titleUnsubscribed: boolean;
  const getSession = vi.fn<(sessionId: string, documentId: string) => Promise<ChatSession | null>>();
  const updateSession = vi.fn<(input: { sessionId: string; title?: string }) => Promise<ChatSession>>();

  const titleOf = (id: string): string | undefined => chat.getState().sessions.find((entry) => entry.id === id)?.title;

  beforeEach(async () => {
    vi.clearAllMocks();
    emitTitle = null;
    titleUnsubscribed = false;
    chat = createChatStore();
    stubBridge({
      ai: { listProviders: vi.fn(() => Promise.resolve([provider])) },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([session])),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        getSession,
        updateSession,
        onStreamEvent: vi.fn<(callback: (event: ChatStreamEvent) => void) => () => void>(() => () => undefined),
        onSessionTitleChanged: vi.fn((callback: (event: ChatSessionTitleChangedEvent) => void) => {
          emitTitle = callback;
          return () => { titleUnsubscribed = true; };
        }),
      },
    });
    await chat.getState().initializeDocument(testDocument);
  });

  afterEach(() => {
    chat.dispose();
  });

  it('shows the stored automatic title without a reload, taking only the title', async () => {
    getSession.mockResolvedValue({ ...session, title: 'Leader Replication Basics', messageCount: 99, providerId: 'codex' });
    emitTitle?.({ sessionId: 'session-1', documentId: 'doc-titles' });

    await vi.waitFor(() => { expect(titleOf('session-1')).toBe('Leader Replication Basics'); });
    expect(getSession).toHaveBeenCalledWith('session-1', 'doc-titles');
    const stored = chat.getState().sessions[0];
    expect(stored?.messageCount).toBe(2);
    expect(stored?.providerId).toBe('fake');
  });

  it('ignores events for another document or a conversation that is not listed', async () => {
    emitTitle?.({ sessionId: 'session-1', documentId: 'doc-other' });
    emitTitle?.({ sessionId: 'session-gone', documentId: 'doc-titles' });
    await flush();
    expect(getSession).not.toHaveBeenCalled();
    expect(chat.getState().sessions.map((entry) => entry.id)).toEqual(['session-1']);
  });

  it('does not resurrect a conversation deleted while the re-read was in flight', async () => {
    const read = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(read.promise);
    emitTitle?.({ sessionId: 'session-1', documentId: 'doc-titles' });
    chat.setState({ sessions: [] });
    read.resolve({ ...session, title: 'Too late' });
    await flush();
    expect(chat.getState().sessions).toEqual([]);
  });

  it('lets a rename made after the event win over the slower re-read', async () => {
    const read = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(read.promise);
    updateSession.mockResolvedValue({ ...session, title: 'My own title' });

    emitTitle?.({ sessionId: 'session-1', documentId: 'doc-titles' });
    expect(await chat.getState().renameSession('session-1', 'My own title')).toBe(true);
    read.resolve({ ...session, title: 'Leader Replication Basics' });
    await flush();

    expect(titleOf('session-1')).toBe('My own title');
  });

  it('stops listening when the store is disposed', () => {
    chat.dispose();
    expect(titleUnsubscribed).toBe(true);
    chat = createChatStore();
  });
});
