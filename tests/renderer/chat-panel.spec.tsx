// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { OPENROUTER_AUTH_FAILED_MESSAGE } from '@shared/constants/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { testAnnotation } from '../helpers/annotation';
import type {
  AIProviderId,
  AIProviderStatus,
  ChatContextBudget,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  CitationTarget,
} from '@shared/types/ai';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const testDocument: DocumentMetadata = {
  id: 'doc-chat-ui',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-chat-ui',
  pageCount: 10,
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

const connectedCodexProvider: AIProviderStatus = {
  id: 'codex',
  name: 'Codex CLI',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '0.149.1',
  errorMessage: null,
  models: [{ id: 'codex-default', name: 'ChatGPT default', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: false, hostedWebSearch: false },
};

const session1: ChatSession = {
  id: 'session-1',
  documentId: 'doc-chat-ui',
  documentHash: 'hash-chat-ui',
  title: 'Consensus Notes',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 2,
  previewText: 'Quorum consensus is guaranteed by majority overlap.',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const sampleMessage: ChatMessage = {
  id: 'msg-1',
  sessionId: 'session-1',
  role: 'assistant',
  ordinal: 1,
  content: 'Quorum consensus is guaranteed by majority overlap [src-1].',
  citations: [
    {
      sourceId: 'src-1',
      label: 'Page 1 · Quorum',
      pageLabel: '1',
      heading: 'Quorum',
    },
  ],
  status: 'complete',
  requestId: '550e8400-e29b-41d4-a716-446655440000',
  tokenCount: 10,
  errorMessage: null,
  createdAt: '2026-08-24T00:00:01.000Z',
  disclosures: [],
  webSources: [],
};

const sampleContext: ChatContextItem = {
  id: 'ctx-1',
  sessionId: 'session-1',
  kind: 'selection',
  sourceRef: {},
  excerptText: 'Quorum consensus is guaranteed',
  excerptHash: 'h-1',
  documentHash: 'hash-chat-ui',
  location: { format: 'pdf', pageIndex: 0 },
  provenance: { pageLabel: '1' },
  displayLabel: '“Quorum consensus is guaranteed”',
  pinned: true,
  createdAt: '2026-08-24T00:00:00.000Z',
};

/**
 * Main's accounting for the last request this session packed. The panel only
 * formats it; the fixture exists here so the composer's control row can be
 * checked with the meter actually on screen.
 */
const sampleBudget: ChatContextBudget = {
  sessionId: 'session-1',
  providerId: 'fake',
  modelId: 'fake-grounded',
  usedTokens: 3_048,
  totalTokens: 32_000,
  accuracy: 'estimated',
  reservedOutputTokens: 2_048,
  sourceCount: 1,
  breakdown: {
    systemPromptTokens: 400,
    userPromptTokens: 100,
    historyTokens: 200,
    documentContextTokens: 200,
    documentSerializationTokens: 60,
    safetyHeadroomTokens: 100,
    reservedResponseTokens: 2_048,
  },
};

describe('ChatPanel', () => {
  let streamListener: ((event: ChatStreamEvent) => void) | null = null;
  const goToLocation = vi.fn(() => Promise.resolve());
  const listProviders = vi.fn(() => Promise.resolve([fakeProvider]));
  const listSessions = vi.fn(() => Promise.resolve([session1]));
  const createSession = vi.fn((input: Parameters<InterleafAPI['chat']['createSession']>[0]) =>
    Promise.resolve({
      ...session1,
      id: 'session-created',
      ...(input.title !== undefined ? { title: input.title } : {}),
    })
  );
  const deleteSession = vi.fn(() => Promise.resolve(undefined));
  const listMessages = vi.fn(() => Promise.resolve([sampleMessage]));
  const listContext = vi.fn(() => Promise.resolve([sampleContext]));
  let attachedContextCount = 0;
  const attachContext = vi.fn((input: { sessionId: string; input: { kind: string } }) =>
    Promise.resolve({
      ...sampleContext,
      id: `ctx-${input.input.kind}-${String(++attachedContextCount)}`,
      kind: input.input.kind as 'selection',
      displayLabel: `Context ${input.input.kind}`,
    })
  );
  const removeContext = vi.fn(() => Promise.resolve(undefined));
  const sendMessage = vi.fn((sessionId: string, content: string) =>
    Promise.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: {
        id: 'msg-u',
        sessionId,
        role: 'user' as const,
        ordinal: 2,
        content,
        citations: [],
        status: 'complete' as const,
        requestId: null,
        tokenCount: 2,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:02.000Z',
        disclosures: [],
        webSources: [],
      },
      assistantMessage: {
        id: 'msg-a',
        sessionId,
        role: 'assistant' as const,
        ordinal: 3,
        content: '',
        citations: [],
        status: 'streaming' as const,
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        tokenCount: null,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:03.000Z',
        disclosures: [],
        webSources: [],
      },
    })
  );
  const cancel = vi.fn(() => Promise.resolve(undefined));
  const resolveCitation = vi.fn<(sessionId: string, messageId: string, sourceId: string) => Promise<CitationTarget | null>>(
    () =>
      Promise.resolve({
        documentId: 'doc-chat-ui',
        documentHash: 'hash-chat-ui',
        sourceId: 'src-1',
        label: 'Page 1 · Quorum',
        location: { format: 'pdf', pageIndex: 0 },
      })
  );
  const updateSession = vi.fn((input: { sessionId: string; title?: string; providerId?: string; modelId?: string | null }) =>
    Promise.resolve({
      ...session1,
      id: input.sessionId,
      title: input.title ?? session1.title,
      ...(input.providerId !== undefined ? { providerId: input.providerId as AIProviderId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    })
  );

  beforeEach(() => {
    vi.clearAllMocks();
    attachedContextCount = 0;
    stubBridge({
      ai: {
        listProviders,
        getProviderStatus: vi.fn(() => Promise.resolve(fakeProvider)),
        // The picker asks main for OpenRouter's catalog when it opens; tests use a fake one.
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
      },
      chat: {
        listSessions,
        getSession: vi.fn(() => Promise.resolve(null)),
        createSession,
        updateSession,
        deleteSession,
        listMessages,
        listContext,
        attachContext,
        removeContext,
        sendMessage,
        cancel,
        resolveCitation,
        getContextBudget: vi.fn((sessionId: string) =>
          Promise.resolve(sessionId === 'session-1' ? sampleBudget : null)
        ),
        onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
          streamListener = listener;
          return () => {
            streamListener = null;
          };
        }),
      },
    });

    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
      goToLocation,
    });
  });

  afterEach(async () => {
    cleanup();
    await chat.getState().initializeDocument(null);
    useUiStore.setState({ loadedSettings: null });
  });

  /**
   * Waits for the panel's own document initialization to finish and leaves the
   * named conversation active, so a later `setState` is a change the reader
   * would see rather than a race with start-up.
   */
  const settled = async (sessionId: string): Promise<void> => {
    await waitFor(() => { expect(chat.getState().isLoading).toBe(false); });
    chat.setState({ activeSessionId: sessionId });
    await waitFor(() => {
      expect(chat.getState().activeSessionId).toBe(sessionId);
    });
  };

  const requestId = '550e8400-e29b-41d4-a716-446655440000';

  /**
   * Sends a real turn on session-1 once the panel has loaded. The stubbed send
   * accepts it with an empty streaming assistant row, `msg-a`.
   */
  const startTurn = async (): Promise<void> => {
    await waitFor(() => {
      expect(chat.getState().isLoading).toBe(false);
      expect(chat.getState().providerDiscovery).toBe('succeeded');
    });
    await act(async () => { await chat.getState().sendMessage('Explain quorum'); });
    expect(chat.getState().isStreaming).toBe(true);
  };

  /** Delivers a stream event for the turn `startTurn` sent. */
  const emitForTurn = (event: { type: 'token'; token: string } | { type: 'done'; message: ChatMessage } | { type: 'error'; message: string }): void => {
    const target = { documentId: testDocument.id, sessionId: 'session-1', requestId, messageId: 'msg-a' };
    act(() => {
      streamListener?.(
        event.type === 'error'
          ? { ...target, type: 'error', error: { __interleafError: true, code: 'internal', message: event.message } }
          : { ...target, ...event }
      );
    });
  };

  /** Opens the composer's model picker and returns its trigger button. */
  const openModelPicker = async (): Promise<HTMLElement> => {
    const trigger = await screen.findByTestId('chat-model-picker');
    fireEvent.click(trigger);
    await screen.findByRole('listbox', { name: 'AI models' });
    return trigger;
  };

  /** The picker row for one provider's model, or any of its models. */
  const modelOption = (providerId: string, modelId?: string): HTMLElement | null => {
    const model = modelId === undefined ? '' : `[data-model-id="${CSS.escape(modelId)}"]`;
    return document.querySelector<HTMLElement>(`[role="option"][data-provider-id="${providerId}"]${model}`);
  };

  it('renders chat interface with sessions, messages, and passes accessibility audit', async () => {
    const { container } = renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'AI research chat' })).toBeTruthy();
    });

    // The thread header names the conversation, not the document, and offers a
    // single create action beside the back control.
    expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Consensus Notes');
    expect(screen.queryByTestId('chat-document-line')).toBeNull();
    const newChatBtn = screen.getByRole('button', { name: 'New chat' });
    expect(newChatBtn).toBeTruthy();
    // Icon-only: the control is named by its label, not by a "+" character.
    expect(newChatBtn.textContent).toBe('');
    expect(newChatBtn.querySelector('svg[data-icon="add"]')).not.toBeNull();

    const backToSessions = screen.getByRole('button', { name: 'Back to conversations' });
    expect(backToSessions).toBeTruthy();

    // The model picker is under the textarea in chat view
    expect(screen.getByTestId('chat-model-picker')).toBeTruthy();
    // Session selector, active provider binding, and title do not live in chat view
    expect(screen.queryByLabelText('Chat session')).toBeNull();
    expect(screen.queryByTestId('active-session-binding')).toBeNull();
    expect(screen.queryByTestId('active-session-title')).toBeNull();

    // Attached context is one shelf line docked on the composer, its list
    // opened on demand; the model picker stays in the footer below the field.
    const contextBar = screen.getByTestId('chat-context-bar');
    expect(contextBar).toHaveAttribute('data-context-layout', 'shelf');
    expect(screen.getByTestId('chat-context-summary')).toHaveAccessibleName('Context, 1 item: “Quorum consensus is guaranteed”');
    expect(screen.queryByTestId('chat-context-list')).toBeNull();
    expect(document.querySelector('.chat-design-controls')?.contains(screen.getByTestId('chat-model-picker'))).toBe(true);
    expect(contextBar.compareDocumentPosition(screen.getByLabelText('Message Reader AI')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Quorum consensus is guaranteed by majority overlap/i)).toBeTruthy();
    });

    const chatResults = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(chatResults.violations).toEqual([]);

    // Navigate to the dedicated Conversations screen
    fireEvent.click(backToSessions);
    expect(await screen.findByText('Conversations')).toBeTruthy();
    // The header alone identifies the screen: the document title and the
    // conversation count only restated what the cards below already say.
    expect(screen.queryByTestId('chat-document-line')).toBeNull();
    expect(screen.queryByTestId('chat-session-count')).toBeNull();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy();
    expect(screen.getByTestId('configure-ai-providers')).toBeTruthy();
    // Cards are the only session browser: no dropdown, no separate binding block,
    // and no global back/open-chat controls.
    expect(screen.queryByLabelText('Chat session')).toBeNull();
    expect(screen.queryByTestId('active-session-binding')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to chat' })).toBeNull();
    const card = screen.getByTestId('session-card-session-1');
    expect(card).toHaveAttribute('aria-current', 'true');
    expect(card).toHaveTextContent('CURRENT');
    expect(card).toHaveTextContent('Quorum consensus is guaranteed by majority overlap.');
    expect(screen.getByTestId('session-meta-session-1')).toHaveTextContent('2 MSG');

    const historyResults = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(historyResults.violations).toEqual([]);

    // Return to the thread through the current card's own Resume action
    fireEvent.click(screen.getByTestId('resume-chat-session'));
    expect(await screen.findByTestId('chat-conversation-line')).toHaveTextContent('Consensus Notes');
    expect(screen.queryByText('Conversations')).toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText('Message Reader AI')).toHaveFocus();
    });
  });

  it('creates chat session via top New chat (+) and deletes via history UI buttons', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const newChatBtn = await screen.findByRole('button', { name: 'New chat' });

    fireEvent.click(newChatBtn);
    await waitFor(() => {
      expect(createSession).toHaveBeenCalled();
    });

    // Delete lives on the conversation's own card
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    const deleteBtn = await screen.findByTestId('delete-chat-session');
    fireEvent.click(deleteBtn);
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm delete conversation' });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('session-created');
    });
  });
  it('uses configured provider/model defaults when creating a new session from header', async () => {
    useUiStore.setState({
      loadedSettings: {
        ...DEFAULT_APP_SETTINGS,
        ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat: { providerId: 'openrouter', modelId: 'openrouter/auto' } },
      },
    });
    listProviders.mockResolvedValue([fakeProvider, openRouterProvider]);
    renderWithChatStore(chat, <ChatPanel />);
    const newChatBtn = await screen.findByRole('button', { name: 'New chat' });
    createSession.mockClear();
    fireEvent.click(newChatBtn);
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'openrouter', modelId: 'openrouter/auto' })
      );
    });
  });

  it('honours explicit provider selection over configured default when starting a conversation', async () => {
    useUiStore.setState({
      loadedSettings: {
        ...DEFAULT_APP_SETTINGS,
        ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat: { providerId: 'openrouter', modelId: 'openrouter/auto' } },
      },
    });
    listProviders.mockResolvedValue([fakeProvider, openRouterProvider]);
    listSessions.mockResolvedValueOnce([]);
    renderWithChatStore(chat, <ChatPanel />);
    const providerTrigger = await openModelPicker();
    fireEvent.click(modelOption('fake', 'fake-grounded')!);
    await waitFor(() => {
      expect(providerTrigger).toHaveTextContent('Deterministic Test Provider');
    });
    createSession.mockClear();
    const createBtn = await screen.findByRole('button', { name: 'New chat' });
    fireEvent.click(createBtn);
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'fake', modelId: 'fake-grounded' })
      );
    });
  });

  it('fails closed and does not fall back when default provider is unavailable', async () => {
    useUiStore.setState({
      loadedSettings: {
        ...DEFAULT_APP_SETTINGS,
        ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat: { providerId: 'claude', modelId: null } },
      },
    });
    listProviders.mockResolvedValue([fakeProvider]);
    renderWithChatStore(chat, <ChatPanel />);
    createSession.mockClear();
    const newChatBtn = await screen.findByRole('button', { name: 'New chat' });
    expect(newChatBtn).toBeDisabled();
    const result = await chat.getState().createSession();
    expect(result).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().error).toMatch(/Claude.*is unavailable/i);
  });

  it('selects first ready provider when no default is configured', async () => {
    useUiStore.setState({
      loadedSettings: {
        ...DEFAULT_APP_SETTINGS,
        ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat: null },
      },
    });
    renderWithChatStore(chat, <ChatPanel />);
    createSession.mockClear();
    const newChatBtn = await screen.findByRole('button', { name: 'New chat' });
    fireEvent.click(newChatBtn);
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'fake', modelId: 'fake-grounded' })
      );
    });
  });

  it('updates active existing session via changeSessionProvider under textarea without creating a conversation', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider, openRouterProvider]);
    renderWithChatStore(chat, <ChatPanel />);
    const providerTrigger = await openModelPicker();
    expect(providerTrigger).toHaveTextContent('Deterministic Test Provider');
    expect(modelOption('fake', 'fake-grounded')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(modelOption('openrouter', 'openrouter/auto')!);

    // One write carries provider and model together.
    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        providerId: 'openrouter',
        modelId: 'openrouter/auto',
      }));
    });
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    // The picker closes and the trigger keeps the persisted binding.
    await waitFor(() => {
      expect(screen.queryByTestId('chat-model-picker-popover')).toBeNull();
      expect(providerTrigger).toHaveTextContent('OpenRouter');
    });

    // The conversation card reflects the same persisted binding: the chip names
    // the model, the provider stays in the accessible text beside it.
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    expect(await screen.findByTestId('session-binding-session-1')).toHaveTextContent('openrouter/auto');
    expect(screen.getByTestId('session-provider-session-1')).toHaveTextContent('OpenRouter · openrouter/auto');
  });

  it('offers connected ChatGPT without mentioning Codex or the subscription', async () => {
    listProviders.mockResolvedValueOnce([fakeProvider, connectedCodexProvider]);
    renderWithChatStore(chat, <ChatPanel />);
    await openModelPicker();
    expect(screen.getByRole('group', { name: 'ChatGPT' })).toBeTruthy();
    expect(screen.getByTestId('chat-model-picker-popover')).not.toHaveTextContent(/subscription/i);
    const codexOption = modelOption('codex')!;
    expect(codexOption).not.toHaveTextContent('unavailable');
    expect(screen.getByRole('listbox', { name: 'AI models' })).not.toHaveTextContent(/Codex/i);

    fireEvent.click(codexOption);
    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        providerId: 'codex',
      }));
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('labels a codex-bound session as ChatGPT, never the transport CLI', async () => {
    // The backend status deliberately carries the transport name 'Codex CLI';
    // the binding readout must normalize it to the subscription label.
    listSessions.mockResolvedValueOnce([{ ...session1, providerId: 'codex', modelId: 'codex-default' }]);
    listProviders.mockResolvedValueOnce([fakeProvider, connectedCodexProvider]);
    renderWithChatStore(chat, <ChatPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));
    // `codex-default` is the subscription's own default, so the chip that would
    // only restate it is not drawn. The binding still reaches assistive
    // technology beside it, and neither readout may leak the transport CLI or
    // the raw model ID.
    await screen.findByTestId('session-card-session-1');
    expect(screen.queryByTestId('session-binding-session-1')).toBeNull();
    const provider = screen.getByTestId('session-provider-session-1');
    expect(provider).toHaveTextContent('ChatGPT · ChatGPT default');
    expect(provider).not.toHaveTextContent(/subscription/i);
    expect(screen.getByTestId('session-card-session-1')).not.toHaveTextContent(/Codex CLI/i);
    expect(screen.getByTestId('session-card-session-1')).not.toHaveTextContent(/codex-default/);
  });

  it('keeps the OpenRouter model ID verbatim in the card chip, as reference 2b does', async () => {
    // `openrouter/auto` restates its own name, and users configure that exact
    // ID, so the readout must not substitute "OpenRouter Auto". 2b puts the
    // model alone in the chip, so the visible text is exactly the stored ID.
    listSessions.mockResolvedValueOnce([{ ...session1, providerId: 'openrouter', modelId: 'openrouter/auto' }]);
    listProviders.mockResolvedValueOnce([fakeProvider, openRouterProvider]);
    renderWithChatStore(chat, <ChatPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));
    const binding = await screen.findByTestId('session-binding-session-1');
    expect(binding.textContent).toBe('openrouter/auto');
    expect(binding.getAttribute('title')).toBe('OpenRouter · openrouter/auto');
    expect(screen.getByTestId('session-provider-session-1')).toHaveTextContent('OpenRouter · openrouter/auto');
  });

  it('names ChatGPT in the unavailable-provider alert', async () => {
    listSessions.mockResolvedValueOnce([{ ...session1, providerId: 'codex', modelId: 'codex-default' }]);
    // Codex is bound to the session but not ready, so the alert must render.
    listProviders.mockResolvedValueOnce([
      fakeProvider,
      { ...connectedCodexProvider, available: false, authentication: 'disconnected' as const },
    ]);
    renderWithChatStore(chat, <ChatPanel />);

    const alert = await screen.findByTestId('active-provider-unavailable');
    expect(alert).toHaveTextContent('bound to ChatGPT, which is unavailable');
    expect(alert).not.toHaveTextContent(/Codex/i);
  });

  it('shows an actionable alert when active session provider is unavailable', async () => {
    const unavailableOpenRouter = { ...openRouterProvider, available: false, authentication: 'disconnected' as const, errorMessage: 'OpenRouter API key is not configured.' };
    // The conversation is already bound to OpenRouter, which is no longer ready.
    listSessions.mockResolvedValueOnce([{ ...session1, providerId: 'openrouter', modelId: 'openrouter/auto' }]);
    listProviders.mockResolvedValueOnce([fakeProvider, unavailableOpenRouter]);
    renderWithChatStore(chat, <ChatPanel />);

    // Alert appears in chat view and disables sending
    await waitFor(() => {
      expect(screen.getByTestId('active-provider-unavailable')).toHaveTextContent(/OpenRouter.*is unavailable/i);
    });
    expect(screen.getByLabelText('Message Reader AI')).toBeDisabled();
    expect(screen.getByTestId('send-chat-button')).toBeDisabled();

    // The binding stays named on the trigger, but the picker does not offer the
    // unready provider as a choice and nothing rebinds the conversation.
    expect(screen.getByTestId('chat-model-picker')).toHaveTextContent('OpenRouter');
    await openModelPicker();
    expect(modelOption('openrouter')).toBeNull();
    expect(modelOption('fake', 'fake-grounded')).toBeTruthy();
    expect(screen.getByTestId('chat-provider-edit')).toBeTruthy();
    expect(updateSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation and supports cancelling session deletion in history', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));
    const deleteBtn = await screen.findByTestId('delete-chat-session');

    fireEvent.click(deleteBtn);
    await screen.findByRole('button', { name: 'Confirm delete conversation' });
    expect(deleteSession).not.toHaveBeenCalled();

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel delete conversation' });
    fireEvent.click(cancelBtn);
    expect(await screen.findByTestId('rename-chat-session')).toBeTruthy();
    expect(deleteSession).not.toHaveBeenCalled();

    // Confirmation remains explicit after the cancelled prompt.
    fireEvent.click(screen.getByTestId('delete-chat-session'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete conversation' }));
    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledTimes(1);
    });
  });

  it('renames chat session via inline edit form on its card', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to conversations' }));
    const renameBtn = await screen.findByTestId('rename-chat-session');

    fireEvent.click(renameBtn);
    const input = screen.getByLabelText('Edit chat session title');
    fireEvent.change(input, { target: { value: 'Distributed Consensus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        title: 'Distributed Consensus',
      }));
      expect(screen.getByTestId('session-card-session-1')).toHaveTextContent('Distributed Consensus');
    });
  });


  it('opens AI Provider Settings when Configure button is clicked', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByTestId('back-to-sessions-button'));
    await waitFor(() => {
      expect(screen.getByTestId('configure-ai-providers')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('configure-ai-providers'));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('opens provider Settings from the composer menu without rebinding the session', async () => {
    useUiStore.setState({ settingsOpen: false });
    renderWithChatStore(chat, <ChatPanel />);
    const trigger = await openModelPicker();
    fireEvent.click(screen.getByTestId('chat-provider-edit'));

    await waitFor(() => {
      expect(useUiStore.getState().settingsOpen).toBe(true);
      // Focus returns to the trigger, so closing Settings lands there too.
      expect(trigger).toHaveFocus();
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().sessions[0]?.providerId).toBe('fake');
  });

  it('displays archived notice and disables composer when session revision is stale', async () => {
    const archivedSession: ChatSession = {
      ...session1,
      id: 'session-archived',
      documentHash: 'old-hash',
      isArchived: true,
      compactedThroughOrdinal: null,
    };
    listSessions.mockResolvedValueOnce([archivedSession]);

    renderWithChatStore(chat, <ChatPanel />);
    expect(await screen.findByText(/Archived:/i)).toBeTruthy();
    expect(screen.getByLabelText('Message Reader AI')).toBeDisabled();
  });

  it('withholds this conversation’s operations while it is being cleaned', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByLabelText('Message Reader AI')).toBeEnabled();
    });

    const composer = screen.getByLabelText('Message Reader AI');
    fireEvent.change(composer, { target: { value: 'Half-written question' } });
    chat.setState({ isCleaningContext: true });

    // Main refuses a turn and a rebinding of this session while the compaction
    // runs, so neither is offered.
    await waitFor(() => {
      expect(screen.getByLabelText('Message Reader AI')).toBeDisabled();
    });
    expect(screen.getByTestId('chat-model-picker')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
    expect(screen.getByTestId('send-chat-button')).toBeDisabled();

    // A submit that arrives anyway is refused locally, and the half-written
    // question stays in the composer rather than being thrown away.
    const form = composer.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Half-written question');

    // The clean finishes and the conversation is fully usable again.
    chat.setState({ isCleaningContext: false });
    await waitFor(() => {
      expect(screen.getByLabelText('Message Reader AI')).toBeEnabled();
    });
    expect(screen.getByTestId('chat-model-picker')).toBeEnabled();
    expect(screen.getByTestId('send-chat-button')).toBeEnabled();
  });

  it('returns a failed turn’s prompt to the composer and sends it as an ordinary turn', async () => {
    const failedMessage: ChatMessage = {
      id: 'msg-failed',
      sessionId: 'session-1',
      role: 'assistant',
      ordinal: 1,
      content: '',
      citations: [],
      status: 'failed',
      requestId: null,
      tokenCount: null,
      errorMessage: 'Provider error',
      createdAt: '2026-08-24T00:00:01.000Z',
      disclosures: [],
      webSources: [],
    };
    const userMessage: ChatMessage = {
      id: 'msg-u1',
      sessionId: 'session-1',
      role: 'user',
      ordinal: 0,
      content: 'Explain quorum',
      citations: [],
      status: 'complete',
      requestId: null,
      tokenCount: 2,
      errorMessage: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      disclosures: [],
      webSources: [],
    };

    listMessages.mockResolvedValueOnce([userMessage, failedMessage]);
    renderWithChatStore(chat, <ChatPanel />);
    const composer = await screen.findByLabelText('Message Reader AI');
    // The failure lands on the conversation the reader is looking at, which is
    // the only way the store ever publishes one.
    await settled('session-1');
    chat.setState({
      messages: [userMessage, failedMessage],
      lastFailedDraft: 'Explain quorum',
    });

    // The Retry nudge only returns the words the reader submitted to the
    // composer, where they can be edited or sent again unchanged; it never sends.
    await waitFor(() => { expect(composer).toHaveValue('Explain quorum'); });
    fireEvent.change(composer, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(composer).toHaveValue('Explain quorum');
    expect(sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('send-chat-button'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('session-1', 'Explain quorum', expect.anything(), false);
    });
  });

  it('starts a conversation from the first message when the document has none', async () => {
    listSessions.mockResolvedValueOnce([]);
    renderWithChatStore(chat, <ChatPanel />);
    const composer = await screen.findByLabelText('Message Reader AI');
    await waitFor(() => { expect(chat.getState().isLoading).toBe(false); });
    // No "create a session first" step: the composer is ready as soon as a
    // provider is.
    await waitFor(() => { expect(composer).not.toBeDisabled(); });
    expect(composer.getAttribute('placeholder') ?? '').not.toMatch(/Create a session/iu);

    fireEvent.change(composer, { target: { value: 'Explain quorum' } });
    fireEvent.click(screen.getByTestId('send-chat-button'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('session-created', 'Explain quorum', expect.anything(), false);
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]!);
  });

  it('keeps the first message in the composer when the conversation cannot be created', async () => {
    listSessions.mockResolvedValueOnce([]);
    createSession.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderWithChatStore(chat, <ChatPanel />);
    const composer = await screen.findByLabelText('Message Reader AI');
    await waitFor(() => { expect(composer).not.toBeDisabled(); });

    fireEvent.change(composer, { target: { value: 'Explain quorum' } });
    fireEvent.click(screen.getByTestId('send-chat-button'));

    await waitFor(() => { expect(createSession).toHaveBeenCalled(); });
    await waitFor(() => { expect(composer).toHaveValue('Explain quorum'); });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('leaves text typed after the failure alone', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const composer = await screen.findByLabelText('Message Reader AI');

    // The reader did not wait for the failure: they started a new question. The
    // recovered prompt must not appear over the top of it.
    fireEvent.change(composer, { target: { value: 'A different question' } });
    chat.setState({ lastFailedDraft: 'Explain quorum' });

    await waitFor(() => { expect(composer).toHaveValue('A different question'); });
  });

  /**
   * The composer's text belongs to the conversation it was typed in.
   *
   * The panel keeps the draft in local state, so nothing about React itself
   * makes it follow the conversation: these hold the rule that it does.
   */
  describe('who the composer’s words belong to', () => {
    it('does not carry a failed prompt into another session of the same document', async () => {
      renderWithChatStore(chat, <ChatPanel />);
      const composer = await screen.findByLabelText('Message Reader AI');
      await settled('session-1');
      chat.setState({ lastFailedDraft: 'Explain quorum' });
      await waitFor(() => { expect(composer).toHaveValue('Explain quorum'); });

      chat.setState({ activeSessionId: 'session-2' });
      await waitFor(() => { expect(composer).toHaveValue(''); });

      // Nor does it come back: the recovery was consumed when it was placed, so
      // returning to its own session does not resurrect words already handed
      // over — and edited or cleared away — once.
      chat.setState({ activeSessionId: 'session-1' });
      await waitFor(() => { expect(composer).toHaveValue(''); });
    });

    it('does not carry a failed prompt into another document', async () => {
      renderWithChatStore(chat, <ChatPanel />);
      const composer = await screen.findByLabelText('Message Reader AI');
      await settled('session-1');
      chat.setState({ lastFailedDraft: 'Explain quorum' });
      await waitFor(() => { expect(composer).toHaveValue('Explain quorum'); });

      useReaderStore.setState({ session: testReaderSession({ ...testDocument, id: 'doc-other' }) });
      await waitFor(() => { expect(composer).toHaveValue(''); });
    });

    it('discards an ordinary unsent draft rather than showing it under another conversation', async () => {
      renderWithChatStore(chat, <ChatPanel />);
      const composer = await screen.findByLabelText('Message Reader AI');
      await settled('session-1');
      fireEvent.change(composer, { target: { value: 'Half-written question' } });

      chat.setState({ activeSessionId: 'session-2' });
      await waitFor(() => { expect(composer).toHaveValue(''); });

      chat.setState({ activeSessionId: 'session-1' });
      await waitFor(() => { expect(composer).toHaveValue(''); });
    });

    it('places a failure that arrives for the session on screen, and only that one', async () => {
      renderWithChatStore(chat, <ChatPanel />);
      const composer = await screen.findByLabelText('Message Reader AI');
      await settled('session-2');
      await waitFor(() => { expect(composer).toHaveValue(''); });

      // The store only ever publishes `lastFailedDraft` for the conversation on
      // screen; a failure belonging to another one is parked until that one is
      // active again. Publishing it here is that conversation becoming active.
      chat.setState({ activeSessionId: 'session-1', lastFailedDraft: 'Explain quorum' });
      await waitFor(() => { expect(composer).toHaveValue('Explain quorum'); });

      // And once placed it is the composer's: an ordinary Send carries it.
      fireEvent.click(screen.getByTestId('send-chat-button'));
      await waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith('session-1', 'Explain quorum', expect.anything(), false);
      });
      expect(chat.getState().lastFailedDraft).toBeNull();
    });
  });

  it('adds entire document and page range to context', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const trigger = await screen.findByRole('button', { name: 'Add context' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Entire document' }));
    await waitFor(() => {
      expect(attachContext).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { kind: 'entire_document', location: { format: 'pdf', pageIndex: 0 } },
        })
      );
    });
    // Attaching it closes the popover; the range is one reopen away.
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    await waitFor(() => {
      expect(attachContext).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { kind: 'range', format: 'pdf', pageStart: 1, pageEnd: 1 },
        })
      );
    });
  });

  it('validates reversed and out-of-bounds page ranges without sending chat actions', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add context' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    expect(screen.getByRole('alert')).toHaveTextContent('End page must be greater than or equal to start page.');
    expect(attachContext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Pages must be between 1 and 10 for this document.');
      expect(attachContext).not.toHaveBeenCalled();
    });
  });

  it('opens the Pages popover with keyboard semantics and returns focus on Escape or outside click', async () => {
    const { container } = renderWithChatStore(chat, <ChatPanel />);
    const trigger = await screen.findByRole('button', { name: 'Add context' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('chat-pages-popover')).toBeVisible());
    expect(screen.getByRole('button', { name: 'Entire document' })).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    fireEvent.keyDown(screen.getByTestId('chat-pages-popover'), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('chat-pages-popover')).toBeVisible());
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
  });

  it('revalidates when the document page count changes and keeps duplicate range pins distinct', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const trigger = await screen.findByRole('button', { name: 'Add context' });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '4' } });
    useReaderStore.setState({ session: testReaderSession({ ...testDocument, pageCount: 3 }) });
    await waitFor(() => {
      expect(screen.getByText(/This document has 3 pages\./i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Pages must be between 1 and 3'));

    useReaderStore.setState({ session: testReaderSession({ ...testDocument, pageCount: 5 }) });
    await waitFor(() => {
      expect(screen.getByText(/This document has 5 pages\./i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    await waitFor(() => {
      expect(attachContext).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Start page for context'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('End page for context'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add range' }));
    await waitFor(() => {
      expect(attachContext).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByTestId('chat-context-summary'));
    expect(await screen.findAllByRole('button', { name: /Remove Context range from AI context/ })).toHaveLength(2);
  });

  const reflowContextCases = [
    ['markdown', { format: 'markdown', blockIndex: 2 }],
    ['epub', { format: 'epub', cfi: 'epubcfi(/6/2)' }],
  ] as const;

  it.each(reflowContextCases)('keeps Entire document available and hides page ranges for %s', async (format, location) => {
    useReaderStore.setState({
      session: testReaderSession({ ...testDocument, format, pageCount: null }),
      currentPage: 1,
      explicitNavigationLocation: location,
    });
    renderWithChatStore(chat, <ChatPanel />);
    // Without pages, Add context offers no page range.
    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }));
    expect(screen.queryByLabelText('Start page for context')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Entire document' }));
    await waitFor(() => {
      expect(attachContext).toHaveBeenCalledWith(expect.objectContaining({
        input: { kind: 'entire_document', location },
      }));
    });
  });

  it('keeps twenty pinned items to one shelf line, with every remove control in its list', async () => {
    const manyContextItems = Array.from({ length: 20 }, (_, index) => ({
      ...sampleContext,
      id: `ctx-many-${String(index)}`,
      displayLabel: `Pages ${String(index + 1)}–${String(index + 1)}`,
    }));
    listContext.mockResolvedValueOnce(manyContextItems);
    renderWithChatStore(chat, <ChatPanel />);
    const summary = await screen.findByRole('button', { name: 'Context, 20 items: Pages 1–1' });
    expect(summary.querySelector('.chat-context-shelf-count')).toHaveTextContent('+19');
    expect(screen.getByTestId('chat-context-bar')).toHaveAttribute('data-context-layout', 'shelf');
    fireEvent.click(summary);
    const list = await screen.findByTestId('chat-context-list');
    expect(within(list).getAllByRole('button', { name: /Remove Pages \d+–\d+ from AI context/ })).toHaveLength(20);
  });

  it('removes context item when remove button is clicked', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Context, 1 item: “Quorum consensus is guaranteed”' }));
    const removeBtn = await screen.findByRole('button', {
      name: 'Remove “Quorum consensus is guaranteed” from AI context',
    });
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(removeContext).toHaveBeenCalledWith('session-1', 'ctx-1');
    });
  });

  it('sends message on form submit / Enter key and navigates on citation click', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    const composer = screen.getByLabelText('Message Reader AI');
    fireEvent.change(composer, { target: { value: 'How does consensus work?' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('session-1', 'How does consensus work?', expect.anything(), false);
    });

    const citationChip = await screen.findByRole('button', { name: 'p. 1' });
    fireEvent.click(citationChip);

    await waitFor(() => {
      expect(resolveCitation).toHaveBeenCalledWith('session-1', 'msg-1', 'src-1');
      expect(goToLocation).toHaveBeenCalledWith({ format: 'pdf', pageIndex: 0 });
    });
  });

  it('says nothing about a boundary over-inclusion, including on turns already stored with one', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    // A turn as it was stored before this notice was withdrawn.
    const legacy: ChatMessage = {
      ...sampleMessage,
      id: 'msg-legacy',
      disclosures: [
        {
          contextItemId: 'ctx-1',
          displayLabel: '“Quorum consensus is guaranteed”',
          totalChunks: 2,
          includedChunks: 2,
          omittedChunks: 0,
          reason: 'boundary_over_inclusion',
        },
      ],
    };
    chat.setState({ messages: [legacy] });

    await screen.findByTestId('chat-message-msg-legacy');
    // A selection that carried a few extra words from the chunk it began in
    // withholds nothing the reader asked for, so there is nothing to warn about.
    expect(screen.queryByTestId('chat-context-disclosure')).toBeNull();
    expect(screen.queryByText(/Context partially included/i)).toBeNull();
    expect(screen.queryByText(/boundary/i)).toBeNull();

    // The turn itself is untouched: only the banner is withheld, and the stored
    // audit record still carries the disclosure.
    expect(screen.getByTestId('chat-message-msg-legacy').textContent).toContain('majority overlap');
    expect(chat.getState().messages[0]?.disclosures[0]?.reason).toBe('boundary_over_inclusion');
  });

  it('still discloses context that was actually left out of the request', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    chat.setState({
      messages: [
        {
          ...sampleMessage,
          id: 'msg-omitted',
          disclosures: [
            {
              contextItemId: 'ctx-1',
              displayLabel: 'Pages 1–10',
              totalChunks: 8,
              includedChunks: 3,
              omittedChunks: 5,
              reason: 'model_context_window',
            },
            {
              contextItemId: 'ctx-2',
              displayLabel: 'Chapter 2',
              totalChunks: 4,
              includedChunks: 0,
              omittedChunks: 4,
              reason: 'max_sources_per_request',
            },
            {
              contextItemId: 'ctx-3',
              displayLabel: 'Selection',
              totalChunks: 1,
              includedChunks: 1,
              omittedChunks: 0,
              reason: 'boundary_over_inclusion',
            },
          ],
        },
      ],
    });

    const disclosure = await screen.findByTestId('chat-context-disclosure');
    expect(disclosure.textContent).toContain('model context window limit');
    expect(disclosure.textContent).toContain('maximum sources per request limit');
    expect(disclosure.textContent).toContain('Context partially included:');
    // Only the boundary line is withheld, and only from the display.
    expect(disclosure.textContent).not.toContain('Selection');
  });

  it('says which pages a too-large pinned document was answered from', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    chat.setState({
      messages: [
        {
          ...sampleMessage,
          id: 'msg-nearby',
          disclosures: [
            {
              contextItemId: 'ctx-whole',
              displayLabel: 'Entire document',
              totalChunks: 400,
              includedChunks: 11,
              omittedChunks: 389,
              reason: 'nearby_context_only',
              includedLabel: 'Pages 195–205',
            },
          ],
        },
      ],
    });

    const disclosure = await screen.findByTestId('chat-context-disclosure');
    // A status disclosure, not an error, and not something the reader can
    // dismiss: it is the only statement of what the answer was built from.
    expect(disclosure).toHaveAttribute('role', 'status');
    expect(within(disclosure).queryByRole('button')).toBeNull();
    expect(disclosure.textContent).toContain('too large for this model');
    expect(disclosure.textContent).toContain('Pages 195–205');
    expect(disclosure.textContent).toContain('11 of 400 chunks included; 389 omitted');
    // The old refusal asked the reader to remove context or change model.
    expect(disclosure.textContent).not.toMatch(/Remove or narrow pinned context/u);
  });

  it('claims no pages for a nearby band in a format that has none', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    chat.setState({
      messages: [
        {
          ...sampleMessage,
          id: 'msg-nearby-markdown',
          disclosures: [
            {
              contextItemId: 'ctx-whole',
              displayLabel: 'Entire document',
              totalChunks: 40,
              includedChunks: 6,
              omittedChunks: 34,
              reason: 'nearby_context_only',
            },
          ],
        },
      ],
    });

    const disclosure = await screen.findByTestId('chat-context-disclosure');
    expect(disclosure.textContent).toContain('only context near your current position was included');
    expect(disclosure.textContent).not.toMatch(/Pages?\s/u);
  });

  it('shows the turn being generated at the end of the transcript, under the Reader AI label', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('chat-generating-notice')).toBeNull();

    await startTurn();

    const notice = await screen.findByTestId('chat-generating-notice');
    // It lives in the thread, where the answer will appear — not in the footer
    // above the composer, and not in the context section.
    expect(screen.getByTestId('chat-messages').contains(notice)).toBe(true);
    expect(notice.textContent).toContain('READER AI');
    expect(notice.textContent).toContain('Generating response…');
    expect(screen.queryByTestId('chat-status-message')).toBeNull();

    // The last thing in the thread, so the reader is already looking at it.
    const thread = screen.getByTestId('chat-messages');
    expect(thread.lastElementChild).toBe(notice);
  });

  it('takes the generating turn away the moment the answer starts arriving, and leaves nothing behind at the end', async () => {
    listMessages.mockResolvedValueOnce([]);
    renderWithChatStore(chat, <ChatPanel />);
    await startTurn();

    // A placeholder with no text yet is not an answer, so the notice stands in
    // — alone. The empty placeholder must not paint a second labelled turn
    // behind it.
    const notice = await screen.findByTestId('chat-generating-notice');
    await waitFor(() => { expect(screen.getAllByLabelText('Reader AI response')).toHaveLength(1); });
    expect(screen.getAllByLabelText('Reader AI response')[0]).toBe(notice);
    expect(notice.textContent).toContain('Generating response…');

    // First tokens: the answer itself now shows the model is working, and one
    // Reader AI label is enough for one turn.
    emitForTurn({ type: 'token', token: 'Quorum is' });
    await waitFor(() => { expect(screen.queryByTestId('chat-generating-notice')).toBeNull(); });
    const streamingTurns = screen.getAllByLabelText('Reader AI response');
    expect(streamingTurns).toHaveLength(1);
    expect(streamingTurns[0]).toBe(screen.getByTestId('chat-message-msg-a'));
    expect(streamingTurns[0]?.textContent).toContain('Quorum is');

    // Done: one labelled turn carrying the answer, and no completion notice is
    // left over anywhere in the panel.
    emitForTurn({
      type: 'done',
      message: { ...sampleMessage, id: 'msg-a', ordinal: 3, content: 'Quorum is a majority.', citations: [], requestId },
    });
    await waitFor(() => { expect(chat.getState().isStreaming).toBe(false); });
    expect(screen.queryByTestId('chat-generating-notice')).toBeNull();
    const completedTurns = screen.getAllByLabelText('Reader AI response');
    expect(completedTurns).toHaveLength(1);
    expect(completedTurns[0]?.textContent).toContain('Quorum is a majority.');
    expect(screen.queryByTestId('chat-status-message')).toBeNull();
    expect(screen.queryByText(/Response complete/i)).toBeNull();
    expect(screen.queryByText(/Response stopped/i)).toBeNull();
  });

  /** Starts a turn with an empty transcript and waits for its generating notice to stand alone. */
  const startGeneratingTurn = async (): Promise<void> => {
    listMessages.mockResolvedValueOnce([]);
    renderWithChatStore(chat, <ChatPanel />);
    await startTurn();
    expect(await screen.findByTestId('chat-generating-notice')).toBeInTheDocument();
    await waitFor(() => { expect(screen.getAllByLabelText('Reader AI response')).toHaveLength(1); });
  };

  /** A settled turn keeps its own labelled bubble, with no stray second one. */
  const expectSettledTurn = async (note: string): Promise<void> => {
    await waitFor(() => { expect(screen.queryByTestId('chat-generating-notice')).toBeNull(); });
    const settledTurns = screen.getAllByLabelText('Reader AI response');
    expect(settledTurns).toHaveLength(1);
    expect(settledTurns[0]?.textContent).toContain(note);
  };

  it('drops the generating turn when the request fails, and still reports the failure', async () => {
    await startGeneratingTurn();
    // After a failure the store re-reads what main persisted for the turn.
    listMessages.mockResolvedValueOnce([
      { ...sampleMessage, id: 'msg-a', ordinal: 3, content: '', citations: [], requestId, status: 'failed', errorMessage: 'Provider error' },
    ]);

    emitForTurn({ type: 'error', message: 'Provider error' });

    await expectSettledTurn('Generation failed');
    const notice = await screen.findByTestId('chat-error-message');
    expect(notice).toHaveTextContent('Provider error');
    // An ordinary failure is not dressed up as a key problem.
    expect(within(notice).queryByRole('button')).toBeNull();
  });

  it('offers AI Providers for a refused OpenRouter key, and only for that typed failure', async () => {
    await startGeneratingTurn();
    listMessages.mockResolvedValueOnce([
      { ...sampleMessage, id: 'msg-a', ordinal: 3, content: '', citations: [], requestId, status: 'failed', errorMessage: OPENROUTER_AUTH_FAILED_MESSAGE },
    ]);

    emitForTurn({ type: 'error', message: OPENROUTER_AUTH_FAILED_MESSAGE });

    const notice = await screen.findByTestId('chat-error-message');
    expect(notice).toHaveTextContent('OpenRouter did not accept the saved API key.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Open AI Providers' }));
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTarget: 'ai:openrouter' });
    useUiStore.setState({ settingsOpen: false });
  });

  it('drops the generating turn when the request is stopped', async () => {
    await startGeneratingTurn();

    await act(async () => { await chat.getState().cancel(); });

    await expectSettledTurn('Stopped');
    expect(screen.queryByTestId('chat-error-message')).toBeNull();
  });

  it('keeps an actionable status notice while the composer carries no progress line', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    chat.setState({ statusMessage: 'Context cleaned. Earlier messages are now summarised.' });
    expect(await screen.findByTestId('chat-status-message')).toHaveTextContent('Context cleaned. Earlier messages are now summarised.');
    expect(screen.queryByText('Generating response…')).toBeNull();
  });

  it('puts the context-window meter once, at the shelf edge, and leaves the footer to Add, model and Send', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const meter = await screen.findByTestId('chat-context-budget');
    const send = screen.getByTestId('send-chat-button');
    const toolRow = document.querySelector('.chat-design-controls')!;

    // The meter reports on what the next turn reads, so it ends the shelf line
    // above the field, drawn exactly once.
    expect(screen.getAllByTestId('chat-context-budget')).toHaveLength(1);
    expect(screen.getByTestId('chat-context-bar').lastElementChild).toBe(meter);
    expect(toolRow.contains(meter)).toBe(false);
    // The footer: Add context first, the model picker with its effort, Send last.
    expect(toolRow.firstElementChild).toBe(screen.getByTestId('chat-pages-trigger'));
    expect(toolRow.contains(screen.getByTestId('chat-model-picker'))).toBe(true);
    expect(toolRow.lastElementChild).toBe(send);
    // Reachable from the keyboard.
    expect(meter.tagName).toBe('BUTTON');
    expect(meter).not.toHaveAttribute('tabindex', '-1');
  });

  it('stops an active stream when Stop button is clicked', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this document/i)).toBeTruthy();
    });

    await startTurn();

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith(requestId);
    });
  });

  it('displays empty state when no document is open', () => {
    useReaderStore.setState({ session: null });
    renderWithChatStore(chat, <ChatPanel />);
    expect(screen.getByText(/Open a document to start a grounded research conversation/i)).toBeTruthy();
  });

  it('renders the full current session title in the thread header with a title attribute', async () => {
    const longTitle = 'Very Long Architectural Analysis of Byzantine Fault Tolerance and Asynchronous State Machine Replication Across Partitions';
    const longSession: ChatSession = {
      ...session1,
      id: 'session-long',
      title: longTitle,
    };
    listSessions.mockResolvedValueOnce([longSession]);

    renderWithChatStore(chat, <ChatPanel />);
    const titleElement = await screen.findByTestId('chat-conversation-line');
    await waitFor(() => {
      expect(titleElement).toHaveTextContent(longTitle);
    });
    expect(titleElement.getAttribute('title')).toBe(longTitle);
  });

  /** Mounts the panel on session-1 with a second conversation, then opens the conversations screen. */
  async function openConversationsBesideSecond(): Promise<void> {
    listSessions.mockResolvedValueOnce([session1, { ...session1, id: 'session-2', title: 'Second Conversation' }]);
    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByTestId('chat-messages');
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
  }

  it('opens another conversation directly from its card and returns to that thread', async () => {
    await openConversationsBesideSecond();
    await screen.findByTestId('session-card-session-2');

    // Every card is its own open control, the current one included.
    expect(screen.getByTestId('open-session-session-1')).toHaveAccessibleName('Open Consensus Notes');
    fireEvent.click(screen.getByTestId('open-session-session-2'));

    // Returns to the thread of that specific conversation
    await waitFor(() => {
      expect(chat.getState().activeSessionId).toBe('session-2');
      expect(screen.getByTestId('chat-conversation-line')).toHaveTextContent('Second Conversation');
      expect(screen.getByLabelText('Message Reader AI')).toHaveFocus();
    });
  });

  it('updates model selection under textarea via changeSessionProvider', async () => {
    const multiModelProvider: AIProviderStatus = {
      ...fakeProvider,
      models: [
        { id: 'model-a', name: 'Model A', contextWindow: 8000, maxOutputTokens: 2000, supportsStreaming: true },
        { id: 'model-b', name: 'Model B', contextWindow: 16000, maxOutputTokens: 4000, supportsStreaming: true },
      ],
    };
    listProviders.mockResolvedValueOnce([multiModelProvider]);
    listSessions.mockResolvedValueOnce([{ ...session1, providerId: 'fake', modelId: 'model-a' }]);

    renderWithChatStore(chat, <ChatPanel />);
    const modelTrigger = await screen.findByTestId('chat-model-picker');
    // The trigger shows the bound model's display name, not its identifier.
    await waitFor(() => { expect(modelTrigger).toHaveTextContent('Model A'); });

    await openModelPicker();
    fireEvent.click(await screen.findByRole('option', { name: /Model B/ }));
    // A same-provider choice is still one write naming both halves.
    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        providerId: 'fake',
        modelId: 'model-b',
      }));
    });
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('creates new conversation from the Conversations header button and returns to chat', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByTestId('chat-messages');

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    const newConvBtn = await screen.findByTestId('new-conversation-button');
    expect(newConvBtn.textContent).toBe('New');
    expect(newConvBtn.querySelector('svg[data-icon="add"]')).not.toBeNull();
    // Exactly one create action on the Conversations screen.
    expect(screen.queryByTestId('new-chat-session')).toBeNull();
    fireEvent.click(newConvBtn);

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled();
      expect(screen.getByTestId('chat-conversation-line')).toBeTruthy();
    });
  });

  it('targets a non-current conversation through its card overflow menu, not the current card', async () => {
    await openConversationsBesideSecond();
    // No dropdown session browser exists any more.
    expect(screen.queryByLabelText('Chat session')).toBeNull();

    fireEvent.click(await screen.findByTestId('session-actions-session-2'));
    fireEvent.click(await screen.findByTestId('rename-session-session-2'));

    const input = screen.getByLabelText('Edit chat session title');
    expect(input).toHaveValue('Second Conversation');
    fireEvent.change(input, { target: { value: 'Renamed Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-2',
        title: 'Renamed Second',
      }));
    });
    // Renaming another conversation never switches the current one.
    expect(chat.getState().activeSessionId).toBe('session-1');
  });
  it('disables provider and model controls under textarea when streaming or archived', async () => {
    renderWithChatStore(chat, <ChatPanel />);
    const providerSelect = await screen.findByTestId('chat-model-picker');
    expect(providerSelect).not.toBeDisabled();

    await startTurn();
    await waitFor(() => {
      expect(providerSelect).toBeDisabled();
      expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
    });

    // When archived
    await act(async () => { await chat.getState().cancel(); });
    const currentSession = chat.getState().sessions.find((s) => s.id === chat.getState().activeSessionId) ?? session1;
    chat.setState({
      sessions: [{ ...currentSession, isArchived: true }],
    });
    await waitFor(() => {
      expect(providerSelect).toBeDisabled();
    });
  });

  it('displays history operation errors in history view when delete fails', async () => {
    deleteSession.mockRejectedValueOnce(new Error('Disk failure on delete'));
    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByTestId('chat-messages');

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    const deleteBtn = await screen.findByTestId('delete-chat-session');
    fireEvent.click(deleteBtn);

    const confirmBtn = await screen.findByTestId('confirm-delete-session');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const errorEl = screen.getByTestId('chat-error-message');
      expect(errorEl).toBeInTheDocument();
      expect(errorEl).toHaveTextContent('Disk failure on delete');
    });
  });

  it('keeps rename editing open and displays error when renaming fails', async () => {
    updateSession.mockRejectedValueOnce(new Error('Rename lock error'));
    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByTestId('chat-messages');

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    const renameBtn = await screen.findByTestId('rename-chat-session');
    fireEvent.click(renameBtn);

    const input = screen.getByLabelText('Edit chat session title');
    fireEvent.change(input, { target: { value: 'Failed Rename Title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorEl = screen.getByTestId('chat-error-message');
      expect(errorEl).toBeInTheDocument();
      expect(errorEl).toHaveTextContent('Rename lock error');
      expect(screen.getByLabelText('Edit chat session title')).toBeInTheDocument();
    });
  });

  it('marks the current conversation card with aria-current and the CURRENT badge', async () => {
    await openConversationsBesideSecond();
    const card1 = await screen.findByTestId('session-card-session-1');
    const card2 = await screen.findByTestId('session-card-session-2');

    expect(card1).toHaveAttribute('aria-current', 'true');
    expect(card1).toHaveTextContent('CURRENT');
    expect(card2).not.toHaveAttribute('aria-current');
    expect(card2).not.toHaveTextContent('CURRENT');
    // Only the current card carries the inline Resume/Rename/Delete footer.
    expect(screen.getAllByTestId('resume-chat-session')).toHaveLength(1);
    expect(card2).toContainElement(screen.getByTestId('session-actions-session-2'));
  });

  /** How the stubbed annotation write behaves for a given save test. */
  type SaveOutcome = 'persisted' | 'refused' | 'threw' | 'deferred';

  /**
   * Arms the save path: one Markdown answer in the thread, a mounted reader
   * adapter for the anchor, and a stubbed annotation write whose outcome the
   * test chooses. Returns the write so the caller can inspect the payload.
   */
  const armNoteSaving = (outcome: SaveOutcome): {
    readonly createAnnotation: ReturnType<typeof vi.fn>;
    readonly answer: string;
    /** Completes a `deferred` write, so a test can watch the wait itself. */
    readonly settle: () => void;
    readonly restore: () => void;
  } => {
    const answer = '## Finding\n\n- **First** item\n- Second item with `code`';
    listMessages.mockResolvedValueOnce([{ ...sampleMessage, content: answer, citations: [] }]);
    const originalCreate = useAnnotationStore.getState().create;
    type Created = Awaited<ReturnType<typeof originalCreate>>;
    const created: Created = testAnnotation({ id: 'note-created', type: 'note' });
    let complete: () => void = () => undefined;
    const pending = new Promise<Created>((resolve) => { complete = () => { resolve(created); }; });
    const writes: Record<SaveOutcome, () => Promise<Created>> = {
      persisted: () => Promise.resolve(created),
      refused: () => Promise.resolve(null),
      threw: () => Promise.reject(new Error('database is locked')),
      deferred: () => pending,
    };
    const createAnnotation = vi.fn<typeof originalCreate>(() => writes[outcome]());
    useAnnotationStore.setState({ create: createAnnotation });
    seatReaderAdapter(testDocumentAdapter('pdf', {
        getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 0 }, progress: 0 }),
      }));
    return {
      createAnnotation,
      answer,
      settle: () => { complete(); },
      restore: () => { useAnnotationStore.setState({ create: originalCreate }); },
    };
  };

  it('saves a Markdown answer as a note with its source text unchanged', async () => {
    const { createAnnotation, restore, answer } = armNoteSaving('persisted');

    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    await waitFor(() => {
      expect(createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        documentId: 'doc-chat-ui',
        type: 'note',
        note: answer,
        isLocationNote: true,
      }));
    });
    expect(await screen.findByTestId('chat-toast')).toHaveTextContent('Note saved');
    // The Markdown answer is rendered, not stored, as semantic elements.
    expect(screen.getByRole('heading', { name: 'Finding', level: 2 })).toBeTruthy();
    restore();
  });

  it('anchors the saved note to the page the reader is on', async () => {
    const { createAnnotation, restore, answer } = armNoteSaving('persisted');
    // The reader deliberately navigated to page 7 before saving the answer.
    useReaderStore.setState({ explicitNavigationLocation: { format: 'pdf', pageIndex: 6, pageLabel: '7' } });

    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    // The Markdown source and the reading location travel together: the note
    // is stored exactly as written and lands where it was written, not at the
    // start of the document.
    await waitFor(() => {
      expect(createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        note: answer,
        anchor: {
          format: 'pdf',
          pageIndex: 6,
          pageLabel: '7',
          quote: { exact: '', prefix: '', suffix: '' },
        },
      }));
    });
    restore();
  });

  it('anchors to the adapter’s reading location when nothing was navigated to', async () => {
    const { createAnnotation, restore } = armNoteSaving('persisted');
    seatReaderAdapter(testDocumentAdapter('pdf', {
        getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 3 }, progress: 0 }),
      }));
    useReaderStore.setState({ explicitNavigationLocation: null });

    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    await waitFor(() => {
      expect(createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        anchor: expect.objectContaining({ format: 'pdf', pageIndex: 3 }),
      }));
    });
    restore();
  });

  it('confirms the save only after the write, and outside the thread and composer', async () => {
    const { settle, restore } = armNoteSaving('deferred');

    renderWithChatStore(chat, <ChatPanel />);
    const messages = await screen.findByTestId('chat-messages');
    const composer = screen.getByLabelText('Message Reader AI').closest('form');
    expect(composer).not.toBeNull();
    const messagesBefore = messages.innerHTML;
    const composerBefore = composer?.innerHTML;

    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));
    // The click alone confirms nothing: the note is not persisted yet.
    expect(screen.queryByTestId('chat-toast')).toBeNull();

    settle();
    const toast = await screen.findByTestId('chat-toast');
    expect(toast).toHaveAttribute('data-tone', 'success');

    // Nothing moved to make room for it: the thread and the composer are the
    // same markup they were, and the toast belongs to neither.
    expect(messages.innerHTML).toBe(messagesBefore);
    expect(composer?.innerHTML).toBe(composerBefore);
    expect(messages.contains(toast)).toBe(false);
    expect(composer?.contains(toast)).toBe(false);
    restore();
  });

  it('announces the save once, politely and atomically', async () => {
    const { restore } = armNoteSaving('persisted');
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    const announcement = await screen.findByTestId('chat-toast-announcement');
    await waitFor(() => { expect(announcement).toHaveTextContent('Note saved'); });
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');

    // The painted panel is not read a second time: exactly one node in the
    // whole panel carries the text to a screen reader.
    expect(screen.getByTestId('chat-toast')).toHaveAttribute('aria-hidden', 'true');
    const spoken = Array.from(document.querySelectorAll('[aria-live], [role="alert"]'))
      .filter((node) => node.textContent.includes('Note saved'));
    expect(spoken).toEqual([announcement]);
    restore();
  });

  it('keeps a refused save visible as a failure and never announces success', async () => {
    const { restore } = armNoteSaving('refused');
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    const toast = await screen.findByTestId('chat-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(toast).toHaveTextContent('Could not save note');
    // The failure is its own announcement, so it is not duplicated into the
    // polite region, and success is never claimed.
    expect(toast).toHaveAttribute('role', 'alert');
    expect(toast).not.toHaveAttribute('aria-hidden');
    expect(screen.getByTestId('chat-toast-announcement')).toHaveTextContent('');
    expect(screen.queryByText('Note saved')).toBeNull();

    // A failure is the reader's only record that the note is not there, so it
    // stays until they dismiss it.
    fireEvent.click(screen.getByTestId('chat-toast-dismiss'));
    expect(screen.queryByTestId('chat-toast')).toBeNull();
    restore();
  });

  it('reports a rejected write as the same failure rather than letting it escape', async () => {
    const { restore } = armNoteSaving('threw');
    renderWithChatStore(chat, <ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save answer as note' }));

    const toast = await screen.findByTestId('chat-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(toast).toHaveTextContent('Could not save note');
    expect(screen.queryByText('Note saved')).toBeNull();
    restore();
  });
});
