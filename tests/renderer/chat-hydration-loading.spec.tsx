// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import type { DocumentMetadata } from '@shared/types/document';
import type { AIProviderStatus, ChatMessage, ChatSession } from '@shared/types/ai';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * Reader Chat opens on rows that are already in SQLite. Provider discovery
 * probes external CLIs and a loopback server and can take seconds, so these
 * tests hold `ai.listProviders` (or `chat.listSessions`) open and assert what
 * the panel is entitled to say while the answer is still outstanding.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-hydration',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-hydration',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const persistedSession: ChatSession = {
  id: 'session-persisted',
  documentId: 'doc-hydration',
  documentHash: 'hash-hydration',
  title: 'Quorum notes',
  providerId: 'openrouter',
  modelId: 'openrouter/auto',
  reasoningEffort: null,
  messageCount: 1,
  previewText: 'Quorum overlap',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const persistedMessage: ChatMessage = {
  id: 'msg-persisted',
  sessionId: 'session-persisted',
  role: 'assistant',
  ordinal: 1,
  content: 'Majority overlap guarantees quorum intersection.',
  citations: [],
  status: 'complete',
  requestId: null,
  tokenCount: 8,
  errorMessage: null,
  createdAt: '2026-09-01T00:00:01.000Z',
  disclosures: [],
  webSources: [],
};

const openRouterProvider: AIProviderStatus = {
  id: 'openrouter',
  name: 'OpenRouter',
  available: true,
  installed: false,
  authentication: 'connected',
  version: null,
  errorMessage: null,
  models: [{
    id: 'openrouter/auto',
    name: 'OpenRouter Auto',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsStreaming: true,
  }],
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A second document, so a switch can land while the first answer is still in the store. */
const secondDocument: DocumentMetadata = {
  ...testDocument,
  id: 'doc-second',
  title: 'Log Replication',
  fileHash: 'hash-second',
};

const secondSession: ChatSession = {
  ...persistedSession,
  id: 'session-second',
  documentId: 'doc-second',
  documentHash: 'hash-second',
  title: 'Replication notes',
};

const secondMessage: ChatMessage = {
  ...persistedMessage,
  id: 'msg-second',
  sessionId: 'session-second',
  content: 'Chunked appends keep the replicated log honest.',
};

describe('Reader Chat hydration and loading state', () => {
  const listProviders = vi.fn(() => Promise.resolve<readonly AIProviderStatus[]>([openRouterProvider]));
  const listSessions = vi.fn(() => Promise.resolve<readonly ChatSession[]>([persistedSession]));
  const listMessages = vi.fn(() => Promise.resolve<readonly ChatMessage[]>([persistedMessage]));
  const listContext = vi.fn(() => Promise.resolve([]));
  const createSession = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listProviders.mockResolvedValue([openRouterProvider]);
    listSessions.mockResolvedValue([persistedSession]);
    listMessages.mockResolvedValue([persistedMessage]);
    listContext.mockResolvedValue([]);
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        listMessages,
        listContext,
        createSession,
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
        attachContext: vi.fn(),
        removeContext: vi.fn(),
        sendMessage,
        cancel: vi.fn(() => Promise.resolve(undefined)),
        resolveCitation: vi.fn(() => Promise.resolve(null)),
        getContextBudget: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    useReaderStore.setState({ session: null });
  });

  it('reads a persisted thread while provider discovery is still running', async () => {
    const providers = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => providers.promise);

    renderWithChatStore(chat, <ChatPanel />);

    // The stored answer is on screen before discovery has said anything.
    expect(await screen.findByText(/Majority overlap guarantees quorum intersection/)).toBeTruthy();
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Quorum notes');

    // And nothing claims a verdict discovery has not reached.
    expect(screen.queryByTestId('no-provider-banner')).toBeNull();
    expect(screen.queryByTestId('active-provider-unavailable')).toBeNull();
    expect(screen.getByTestId('provider-discovery-loading')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Message Reader AI')).toHaveAttribute(
      'placeholder',
      'Checking available AI providers…'
    );

    // Once discovery answers with nothing ready, the honest banner returns.
    providers.resolve([]);
    expect(await screen.findByTestId('no-provider-banner')).toHaveTextContent('No AI Provider Ready');
    expect(screen.queryByTestId('provider-discovery-loading')).toBeNull();
    expect(screen.getByText(/Majority overlap guarantees quorum intersection/)).toBeTruthy();
  });

  it('does not report the session provider as unavailable before discovery settles', async () => {
    const providers = deferred<readonly AIProviderStatus[]>();
    listProviders.mockImplementationOnce(() => providers.promise);

    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));

    const meta = await screen.findByTestId('session-meta-session-persisted');
    expect(meta).not.toHaveTextContent('PROVIDER UNAVAILABLE');

    providers.resolve([{ ...openRouterProvider, available: false, authentication: 'disconnected' }]);
    await waitFor(() => {
      expect(screen.getByTestId('session-meta-session-persisted')).toHaveTextContent('PROVIDER UNAVAILABLE');
    });
  });

  describe('switching to a second document', () => {
    /**
     * Renders on document A and waits until its probe has really succeeded, so
     * the provider list the store carries into document B is a genuine, and
     * genuinely stale, answer.
     */
    async function renderSettledFirstDocument(): Promise<void> {
      renderWithChatStore(chat, <ChatPanel />);
      expect(await screen.findByText(/Majority overlap guarantees quorum intersection/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Message Reader AI'), { target: { value: 'Ready?' } });
      await waitFor(() => {
        expect(screen.getByTestId('send-chat-button')).not.toBeDisabled();
      });
      expect(screen.getByTestId('new-chat-session')).not.toBeDisabled();
    }

    function openSecondDocument(): void {
      listSessions.mockResolvedValue([secondSession]);
      listMessages.mockResolvedValue([secondMessage]);
      act(() => {
        useReaderStore.setState({ session: testReaderSession(secondDocument) });
      });
    }

    it('reads the new document\'s thread with every action disabled while its probe runs', async () => {
      await renderSettledFirstDocument();

      const providers = deferred<readonly AIProviderStatus[]>();
      listProviders.mockImplementationOnce(() => providers.promise);
      openSecondDocument();

      // B's stored thread arrives without waiting for B's probe.
      expect(await screen.findByText(/Chunked appends keep the replicated log honest/)).toBeTruthy();
      expect(screen.getByTestId('provider-discovery-loading')).toHaveAttribute('role', 'status');
      expect(screen.queryByTestId('no-provider-banner')).toBeNull();
      expect(screen.queryByTestId('active-provider-unavailable')).toBeNull();

      // A's answer is still in the store, and it authorizes nothing about B.
      expect(screen.getByTestId('new-chat-session')).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Message Reader AI'), { target: { value: 'Does the quorum hold?' } });
      expect(screen.getByTestId('send-chat-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('send-chat-button'));
      fireEvent.click(screen.getByTestId('new-chat-session'));
      expect(sendMessage).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();

      // Once B's own probe answers, the controls come back.
      providers.resolve([openRouterProvider]);
      await waitFor(() => {
        expect(screen.getByTestId('new-chat-session')).not.toBeDisabled();
      });
      expect(screen.queryByTestId('provider-discovery-loading')).toBeNull();
    });

    it('says the new document\'s probe failed rather than that no provider is ready', async () => {
      await renderSettledFirstDocument();

      listProviders.mockRejectedValueOnce(new Error('Provider probe failed.'));
      openSecondDocument();

      const failure = await screen.findByTestId('provider-discovery-failed');
      // Opening a document reads main's readiness as it stands.
      expect(listProviders.mock.lastCall).toEqual([]);
      expect(failure).toHaveAttribute('role', 'alert');
      // A failed check is not the verdict that nothing is configured.
      expect(screen.queryByTestId('no-provider-banner')).toBeNull();
      expect(screen.queryByTestId('active-provider-unavailable')).toBeNull();
      // And the stored conversation stays readable through it.
      expect(screen.getByText(/Chunked appends keep the replicated log honest/)).toBeTruthy();

      expect(screen.getByTestId('new-chat-session')).toBeDisabled();
      const composer = screen.getByLabelText('Message Reader AI');
      expect(composer).toHaveAttribute(
        'placeholder',
        'Could not check AI providers. Use Check Again above, or open Settings.'
      );
      fireEvent.change(composer, { target: { value: 'Does the quorum hold?' } });
      fireEvent.click(screen.getByTestId('send-chat-button'));
      expect(sendMessage).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
      expect(screen.getByTestId('new-conversation-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('new-conversation-button'));
      expect(createSession).not.toHaveBeenCalled();
      expect(screen.getByText('Replication notes')).toBeTruthy();

      // The reader can ask again instead of being stranded.
      listProviders.mockResolvedValueOnce([openRouterProvider]);
      fireEvent.click(screen.getByTestId('retry-provider-discovery'));
      await waitFor(() => {
        expect(screen.getByTestId('new-conversation-button')).not.toBeDisabled();
      });
      expect(screen.queryByTestId('provider-discovery-failed')).toBeNull();
      // Check Again is an explicit check, so main probes instead of answering
      // from its cache.
      expect(listProviders.mock.lastCall).toEqual([{ forceRefresh: true }]);
    });
  });

  it('separates a still-loading conversation list from an empty one', async () => {
    const sessions = deferred<readonly ChatSession[]>();
    listSessions.mockImplementationOnce(() => sessions.promise);

    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));

    expect(await screen.findByTestId('chat-sessions-loading')).toHaveAttribute('role', 'status');
    expect(screen.queryByText('No conversations yet.')).toBeNull();

    sessions.resolve([]);
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
    expect(screen.queryByTestId('chat-sessions-loading')).toBeNull();
  });
});
