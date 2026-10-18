// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { CompanionPanel } from '../../src/renderer/components/CompanionPanel';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
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

const testDocument: DocumentMetadata = {
  id: 'doc-tabs',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-tabs',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
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
  models: [{
    id: 'fake-grounded',
    name: 'Deterministic Grounded Model',
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    supportsStreaming: true,
  }],
  capabilities: {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

const currentSession: ChatSession = {
  id: 'session-current',
  documentId: 'doc-tabs',
  documentHash: 'hash-tabs',
  title: 'Quorum Notes',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 1,
  previewText: 'Majority overlap guarantees quorum.',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const otherSession: ChatSession = {
  ...currentSession,
  id: 'session-other',
  title: 'Replication Notes',
  messageCount: 1,
  previewText: 'Replication lag bounds staleness.',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

const messagesBySession: Record<string, readonly ChatMessage[]> = {
  'session-current': [{
    id: 'msg-current',
    sessionId: 'session-current',
    role: 'assistant',
    ordinal: 1,
    content: 'Majority overlap guarantees quorum.',
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: 6,
    errorMessage: null,
    createdAt: '2026-09-01T00:00:01.000Z',
    disclosures: [],
    webSources: [],
  }],
  'session-other': [{
    id: 'msg-other',
    sessionId: 'session-other',
    role: 'assistant',
    ordinal: 1,
    content: 'Replication lag bounds staleness.',
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: 6,
    errorMessage: null,
    createdAt: '2026-09-01T00:00:02.000Z',
    disclosures: [],
    webSources: [],
  }],
};

describe('Companion tab lifecycle around AI Chat', () => {
  /**
   * Session reads are gated so the regression measures the real IPC gap the
   * user hits after a tab-away/tab-back cycle: while `listMessages` and
   * `listContext` are still in flight, the clicked card must already own the
   * screen. Immediate promise mocks would resolve within the same microtask
   * queue as the click and hide the defect.
   */
  const gate = { open: true, releases: [] as (() => void)[] };
  const gated = <T,>(value: T): Promise<T> => {
    if (gate.open) return Promise.resolve(value);
    return new Promise<T>((resolve) => { gate.releases.push(() => { resolve(value); }); });
  };
  const releaseSessionReads = async (): Promise<void> => {
    const releases = gate.releases.splice(0, gate.releases.length);
    gate.open = true;
    await act(async () => {
      for (const release of releases) release();
      await Promise.resolve();
    });
  };

  const listMessages = vi.fn((sessionId: string) => gated(messagesBySession[sessionId] ?? []));
  const listContext = vi.fn(() => gated([]));

  beforeEach(() => {
    vi.clearAllMocks();
    gate.open = true;
    gate.releases = [];
    stubBridge({
      ai: { listProviders: vi.fn(() => Promise.resolve([fakeProvider])) },
      // The annotations tab counts its chips whenever it mounts on a document.
      annotations: {
        page: vi.fn((_documentId: string, filter: { readonly offset: number; readonly limit: number }) =>
          Promise.resolve({ items: [], total: 0, offset: filter.offset, limit: filter.limit })),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([currentSession, otherSession])),
        createSession: vi.fn(() => Promise.resolve(currentSession)),
        updateSession: vi.fn(() => Promise.resolve(currentSession)),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        getSession: vi.fn(() => Promise.resolve(currentSession)),
        listMessages,
        listContext,
        attachContext: vi.fn(),
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage: vi.fn(),
        cancel: vi.fn(() => Promise.resolve(undefined)),
        resolveCitation: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useUiStore.setState({ rightTab: 'chat', settingsOpen: false });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
    });
  });

  afterEach(async () => {
    await releaseSessionReads();
    cleanup();
    await chat.getState().initializeDocument(null);
  });

  /** Leaves AI Chat for Search and comes back, through the real tablist. */
  const cycleAwayAndBack = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
    await waitFor(() => {
      expect(screen.getByTestId('companion-panel-chat')).toHaveAttribute('hidden');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'AI Chat' }));
    await waitFor(() => {
      expect(screen.getByTestId('companion-panel-chat')).not.toHaveAttribute('hidden');
    });
  };

  /** Renders the real tab owner and parks AI Chat on the Conversations screen. */
  const renderOnConversations = async (): Promise<void> => {
    renderWithChatStore(chat, <CompanionPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));
    expect(await screen.findByText('Conversations')).toBeTruthy();
  };

  it('resumes the current conversation after leaving and returning to the AI Chat tab', async () => {
    await renderOnConversations();
    await cycleAwayAndBack();
    expect(screen.getByText('Conversations')).toBeTruthy();

    gate.open = false;
    fireEvent.click(screen.getByTestId('resume-chat-session'));

    // The card owns the screen on click, without waiting for any session read.
    expect(screen.queryByText('Conversations')).toBeNull();
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Quorum Notes');
    expect(chat.getState().activeSessionId).toBe('session-current');

    await releaseSessionReads();
    await waitFor(() => {
      expect(screen.getByTestId('chat-messages')).toHaveTextContent('Majority overlap guarantees quorum.');
    });
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Quorum Notes');
  });

  it('opens a non-current conversation after leaving and returning to the AI Chat tab', async () => {
    await renderOnConversations();
    await cycleAwayAndBack();

    gate.open = false;
    fireEvent.click(screen.getByTestId('open-session-session-other'));

    expect(screen.queryByText('Conversations')).toBeNull();
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Replication Notes');
    expect(chat.getState().activeSessionId).toBe('session-other');
    // A conversation still loading its rows is unknown, not empty.
    expect(screen.queryByTestId('chat-empty-thread')).toBeNull();

    await releaseSessionReads();
    await waitFor(() => {
      expect(screen.getByTestId('chat-messages')).toHaveTextContent('Replication lag bounds staleness.');
    });
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Replication Notes');
    expect(screen.queryByText('Majority overlap guarantees quorum.')).toBeNull();
  });

  it('keeps the AI Chat thread on the selected session when a tab cycle interleaves reads', async () => {
    await renderOnConversations();
    await cycleAwayAndBack();

    gate.open = false;
    fireEvent.click(screen.getByTestId('open-session-session-other'));
    // Leaving and returning while the session read is still pending must not
    // strand the panel on Conversations or revert the selection.
    await cycleAwayAndBack();

    expect(screen.queryByText('Conversations')).toBeNull();
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Replication Notes');

    await releaseSessionReads();
    await waitFor(() => {
      expect(screen.getByTestId('chat-messages')).toHaveTextContent('Replication lag bounds staleness.');
    });
    expect(chat.getState().activeSessionId).toBe('session-other');
  });
});
