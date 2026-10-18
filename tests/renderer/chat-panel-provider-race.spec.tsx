// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { AIProviderId, AIProviderStatus, ChatContextItem, ChatSession } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
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
 * The reader's gesture, end to end: pick a provider for a conversation that is
 * being created at that moment, and get that provider.
 *
 * The panel is where the gesture happens and where its result is read back, so
 * the rule is pinned here as well as in the store: the name under the composer,
 * the binding persisted on the session, and the provider a turn would be
 * spawned from are one answer. A panel that kept the choice to itself showed
 * the reader one provider while the session it was about to send through
 * carried another.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-panel-race',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-panel-race',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  source: null,
};

const installedProvider: AIProviderStatus = {
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

const openRouterProvider: AIProviderStatus = {
  id: 'openrouter',
  name: 'OpenRouter',
  available: true,
  installed: false,
  authentication: 'connected',
  version: null,
  errorMessage: null,
  models: [{ id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
};

function sessionRow(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-created',
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

const sampleContext: ChatContextItem = {
  id: 'ctx-1',
  sessionId: 'session-created',
  kind: 'selection',
  sourceRef: {},
  excerptText: 'Quorum consensus is guaranteed',
  excerptHash: 'h-1',
  documentHash: testDocument.fileHash,
  location: { format: 'pdf', pageIndex: 0 },
  provenance: { pageLabel: '1' },
  displayLabel: '“Quorum consensus is guaranteed”',
  pinned: true,
  createdAt: '2026-09-22T00:00:00.000Z',
};

/** Opens the composer's model picker and chooses the exact provider-and-model row. */
async function chooseModel(providerId: AIProviderId, modelId: string): Promise<HTMLElement> {
  const trigger = await screen.findByTestId('chat-model-picker');
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const found = screen.getAllByRole('option').find((row) => row.dataset.providerId === providerId && row.dataset.modelId === modelId);
    expect(found).toBeDefined();
    return found!;
  });
  fireEvent.click(option);
  return trigger;
}

describe('ChatPanel provider selection during session creation', () => {
  const listProviders = vi.fn(() => Promise.resolve([installedProvider, openRouterProvider]));
  const listSessions = vi.fn(() => Promise.resolve([] as readonly ChatSession[]));
  let releaseCreate: ((session: ChatSession) => void) | null = null;
  const createSession = vi.fn(
    (input: { documentId: string; providerId: string; modelId?: string | null }) =>
      new Promise<ChatSession>((resolve) => {
        releaseCreate = () => {
          resolve(sessionRow({ providerId: input.providerId as AIProviderId, modelId: input.modelId ?? null }));
        };
      })
  );
  const updateSession = vi.fn((input: { sessionId: string; providerId?: string; modelId?: string | null }) =>
    Promise.resolve(
      sessionRow({
        id: input.sessionId,
        ...(input.providerId !== undefined ? { providerId: input.providerId as AIProviderId } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      })
    )
  );

  beforeEach(() => {
    vi.clearAllMocks();
    releaseCreate = null;
    stubBridge({
      ai: {
        listProviders,
        getProviderStatus: vi.fn(() => Promise.resolve(installedProvider)),
        listOpenRouterModels: vi.fn(() => Promise.resolve([
          { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 8_192, supportsStreaming: true },
        ])),
      },
      chat: {
        listSessions,
        createSession,
        updateSession,
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        attachContext: vi.fn(() => Promise.resolve(sampleContext)),
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage: vi.fn(),
        cancel: vi.fn(() => Promise.resolve(undefined)),
        getContextBudget: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
      goToLocation: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(async () => {
    cleanup();
    await chat.getState().initializeDocument(null);
    useUiStore.setState({ loadedSettings: null });
  });

  it('creates the conversation Ask AI asks for on the provider the reader already chose', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    // The reader chooses first, with no conversation open — the ordinary way to
    // say "use this one" before there is anything to bind it to.
    const trigger = await chooseModel('openrouter', 'openrouter/auto');
    await waitFor(() => {
      expect(trigger).toHaveTextContent('OpenRouter');
    });

    // Then they select a passage in the reader and press Ask AI, which creates
    // the conversation from outside this panel and never sees its props.
    const asked = chat.getState().addSelectionContext(
      testDocument,
      {
        format: 'pdf',
        startPageIndex: 0,
        endPageIndex: 0,
        startPageLabel: '1',
        endPageLabel: '1',
        startQuote: { exact: 'Quorum consensus is guaranteed', prefix: '', suffix: '' },
        endQuote: { exact: 'Quorum consensus is guaranteed', prefix: '', suffix: '' },
      },
      false
    );
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(1);
    });
    releaseCreate?.(sessionRow());
    expect(await asked).toBe(true);

    // Created on the chosen provider, not on the first one this machine has
    // ready — and no rebinding was needed to get there.
    expect(createSession).toHaveBeenCalledWith({
      documentId: testDocument.id,
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
      reasoningEffort: null,
    });
    expect(updateSession).not.toHaveBeenCalled();
    const active = chat
      .getState()
      .sessions.find((session) => session.id === chat.getState().activeSessionId);
    expect(active?.providerId).toBe('openrouter');
    // The composer still names the same provider it did before the session
    // existed, because it is now reading it off the session.
    await waitFor(() => {
      expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('OpenRouter');
    });
  });

  it('creates the conversation on an exact OpenRouter catalog model, never the first one', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const trigger = await chooseModel('openrouter', 'anthropic/claude-sonnet-4.5');
    await waitFor(() => { expect(trigger).toHaveTextContent('Anthropic: Claude Sonnet 4.5'); });
    expect(chat.getState().pendingProviderId).toBe('openrouter');
    expect(chat.getState().pendingModelId).toBe('anthropic/claude-sonnet-4.5');

    const asked = chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 0 });
    await waitFor(() => { expect(createSession).toHaveBeenCalledTimes(1); });
    releaseCreate?.(sessionRow());
    expect(await asked).toBe(true);
    expect(createSession).toHaveBeenCalledWith({
      documentId: testDocument.id,
      providerId: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.5',
      reasoningEffort: null,
    });
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe('ChatPanel picker choices for an open conversation', () => {
  const bound = sessionRow({ id: 'session-open' });
  const pendingUpdates: { input: { providerId?: string; modelId?: string | null }; resolve: (row: ChatSession) => void; reject: (error: Error) => void }[] = [];
  const updateSession = vi.fn((input: { sessionId: string; providerId?: string; modelId?: string | null }) =>
    new Promise<ChatSession>((resolve, reject) => { pendingUpdates.push({ input, resolve, reject }); }));
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    pendingUpdates.length = 0;
    stubBridge({
      ai: {
        listProviders: vi.fn(() => Promise.resolve([installedProvider, openRouterProvider])),
        getProviderStatus: vi.fn(() => Promise.resolve(installedProvider)),
        listOpenRouterModels: vi.fn(() => Promise.resolve([
          { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 8_192, supportsStreaming: true },
        ])),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([bound])),
        createSession: vi.fn(),
        updateSession,
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        attachContext: vi.fn(() => Promise.resolve(sampleContext)),
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage,
        cancel: vi.fn(() => Promise.resolve(undefined)),
        getContextBudget: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
      goToLocation: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(async () => {
    cleanup();
    await chat.getState().initializeDocument(null);
  });

  function answer(index: number): void {
    const update = pendingUpdates[index]!;
    update.resolve(sessionRow({
      id: bound.id,
      providerId: update.input.providerId as AIProviderId,
      modelId: update.input.modelId ?? null,
    }));
  }

  it('withholds the picker while a choice is written, then takes the next one as one exact write', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => { expect(chat.getState().activeSessionId).toBe(bound.id); });
    const trigger = await chooseModel('openrouter', 'openrouter/auto');
    await waitFor(() => { expect(updateSession).toHaveBeenCalledTimes(1); });
    // A second choice cannot race the first through the picker; the store's
    // revision order covers choices that do overlap.
    await waitFor(() => { expect(trigger).toBeDisabled(); });

    answer(0);
    await waitFor(() => { expect(trigger).toBeEnabled(); });
    await chooseModel('openrouter', 'anthropic/claude-sonnet-4.5');
    await waitFor(() => { expect(updateSession).toHaveBeenCalledTimes(2); });
    answer(1);
    expect(updateSession.mock.calls.map(([input]) => [input.providerId, input.modelId])).toEqual([
      ['openrouter', 'openrouter/auto'],
      ['openrouter', 'anthropic/claude-sonnet-4.5'],
    ]);
    await waitFor(() => {
      expect(chat.getState().sessions.find((session) => session.id === bound.id)?.modelId).toBe('anthropic/claude-sonnet-4.5');
      expect(trigger).toHaveTextContent('Anthropic: Claude Sonnet 4.5');
    });
  });

  it('sends nothing while a choice is unsettled, and does not fall back when main refuses it', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => { expect(chat.getState().activeSessionId).toBe(bound.id); });
    const trigger = await chooseModel('openrouter', 'openrouter/auto');
    await waitFor(() => { expect(updateSession).toHaveBeenCalledTimes(1); });

    const composer = screen.getByLabelText('Message Reader AI');
    fireEvent.change(composer, { target: { value: 'Explain quorum' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(sendMessage).not.toHaveBeenCalled();

    pendingUpdates[0]!.reject(new Error('Provider refused'));
    await waitFor(() => { expect(chat.getState().error).toContain('Provider refused'); });
    // The stored row was not moved, nothing else was written in its place, and
    // the trigger still names the reader's unsettled choice rather than
    // quietly showing the old binding as if it would be used.
    expect(chat.getState().sessions.find((session) => session.id === bound.id)?.providerId).toBe('fake');
    expect(trigger).toHaveTextContent('OpenRouter');
    expect(updateSession).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText('Message Reader AI'), { key: 'Enter' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
