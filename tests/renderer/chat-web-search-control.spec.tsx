// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import type { AIProviderStatus, ChatMessage, ChatSession, ChatStreamEvent, SendChatMessageResult } from '@shared/types/ai';
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
 * Web search is an explicit, per-turn choice, and the renderer is the place
 * where that choice is offered rather than where it is trusted. These tests
 * hold the properties the reader can see: the control exists only where the
 * capability does, and it starts off and returns to off.
 *
 * The main-side re-check that makes an untrusted `true` harmless lives in
 * tests/unit/chat-service.spec.ts, and the request shape it produces in
 * tests/unit/openrouter-provider.spec.ts.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-web-search',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-web-search',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  source: null,
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
    hostedWebSearch: true,
  },
};

const claudeProvider: AIProviderStatus = {
  ...openRouterProvider,
  id: 'claude',
  name: 'Claude Code CLI',
  installed: true,
  models: [{
    id: 'claude-default',
    name: 'Claude default',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
  }],
  capabilities: { ...openRouterProvider.capabilities, hostedWebSearch: false },
};

function sessionFor(provider: AIProviderStatus): ChatSession {
  return {
    id: 'session-1',
    documentId: testDocument.id,
    documentHash: testDocument.fileHash,
    title: 'Consensus Notes',
    providerId: provider.id,
    modelId: provider.models[0]!.id,
    reasoningEffort: null,
    messageCount: 0,
    previewText: null,
    isArchived: false,
    compactedThroughOrdinal: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

/** The assistant turn main opens for an accepted send. */
function streamingAnswer(sessionId: string): ChatMessage {
  return {
    id: 'msg-a', sessionId, role: 'assistant', ordinal: 1, content: '', citations: [],
    status: 'streaming', requestId: '550e8400-e29b-41d4-a716-446655440000',
    tokenCount: null, errorMessage: null, createdAt: '2026-09-06T00:00:03.000Z',
    disclosures: [],
    webSources: [],
  };
}

describe('per-turn web search control', () => {
  // Declared with the full bridge signature: the per-turn flag these tests assert
  // on is part of the call, not an extra argument the fixture happens to ignore.
  const sendMessage = vi.fn<
    (
      sessionId: string,
      content: string,
      currentLocation?: DocumentLocation | null,
      webSearch?: boolean
    ) => Promise<SendChatMessageResult>
  >((sessionId, content) =>
    Promise.resolve({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      userMessage: {
        id: 'msg-u', sessionId, role: 'user' as const, ordinal: 0, content, citations: [],
        status: 'complete' as const, requestId: null, tokenCount: 2, errorMessage: null,
        createdAt: '2026-09-06T00:00:02.000Z',
        disclosures: [],
        webSources: [],
      },
      assistantMessage: streamingAnswer(sessionId),
    })
  );

  /** The store's stream subscription, used to finish a turn the way main does. */
  let streamListener: ((event: ChatStreamEvent) => void) | null = null;

  /** Mounts the panel with `provider` bound to the document's only session. */
  async function renderPanel(provider: AIProviderStatus): Promise<HTMLElement> {
    stubBridge({
      ai: {
        listProviders: vi.fn(() => Promise.resolve([provider])),
        getProviderStatus: vi.fn(() => Promise.resolve(provider)),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([sessionFor(provider)])),
        getSession: vi.fn(() => Promise.resolve(sessionFor(provider))),
        createSession: vi.fn(() => Promise.resolve(sessionFor(provider))),
        updateSession: vi.fn(() => Promise.resolve(sessionFor(provider))),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        attachContext: vi.fn(() => Promise.resolve({
          id: 'ctx-1', sessionId: 'session-1', kind: 'range' as const, sourceRef: {},
          excerptText: '', excerptHash: '', documentHash: testDocument.fileHash,
          location: { format: 'pdf' as const, pageIndex: 0 }, provenance: {},
          displayLabel: 'Pages 1–10', pinned: true, createdAt: '2026-09-06T00:00:00.000Z',
        })),
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage,
        cancel: vi.fn(() => Promise.resolve(undefined)),
        resolveCitation: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
          streamListener = listener;
          return () => undefined;
        }),
      },
    });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
      goToLocation: vi.fn(() => Promise.resolve()),
    });
    const { container } = renderWithChatStore(chat, <ChatPanel />);
    await screen.findByLabelText('Message Reader AI');
    return container;
  }

  /** Types `text` into the composer and submits the turn. */
  async function send(text: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('Message Reader AI'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('send-chat-button'));
    await waitFor(() => { expect(sendMessage).toHaveBeenCalled(); });
  }

  /** Completes the acknowledged turn, as main's `done` event does. */
  async function finishTurn(): Promise<void> {
    const requestId = '550e8400-e29b-41d4-a716-446655440000';
    await waitFor(() => { expect(chat.getState().activeRequestId).toBe(requestId); });
    act(() => {
      streamListener?.({
        type: 'done',
        documentId: testDocument.id,
        sessionId: 'session-1',
        requestId,
        messageId: 'msg-a',
        message: { ...streamingAnswer('session-1'), content: 'Answer.', status: 'complete' },
      });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    streamListener = null;
  });

  afterEach(async () => {
    cleanup();
    await chat.getState().initializeDocument(null);
  });

  it('is a glyph with a spoken name rather than a labelled word in the control row', async () => {
    await renderPanel(openRouterProvider);

    const toggle = await screen.findByTestId('chat-web-search-toggle');
    // No wording in the row: the composer's controls stay narrow enough for the
    // provider and model menus at a small width or a large zoom.
    expect(toggle.textContent.trim()).toBe('');
    expect(screen.queryByText('Web Search')).toBeNull();
    expect(screen.queryByText('Web search')).toBeNull();

    // The name is still said, once, and the state with it.
    expect(toggle).toHaveAccessibleName('Web search');
    expect(toggle).toHaveAttribute('title', 'Web search');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Offered off, with no explanatory disclosure text attached.
    expect(toggle).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('chat-web-search-disclosure')).toBeNull();
    expect(toggle.querySelector('svg')).not.toBeNull();
    // The glyph is decoration for the name the button already carries.
    expect(toggle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    // Reachable and operable from the keyboard as a real button.
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);
    expect(screen.getByTestId('chat-web-search-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-web-search-toggle')).toHaveAccessibleName('Web search');
  });

  it('is absent, not merely disabled, for a provider without the hosted path', async () => {
    await renderPanel(claudeProvider);

    // Claude and Codex run as local CLIs. Offering a disabled toggle would
    // suggest the capability is one setting away; it is not present at all,
    // and no local tool access is enabled to fake it.
    expect(screen.queryByTestId('chat-web-search-toggle')).toBeNull();
    expect(screen.queryByTestId('chat-web-search-disclosure')).toBeNull();

    await send('What changed since publication?');
    expect(sendMessage).toHaveBeenCalledWith('session-1', 'What changed since publication?', expect.anything(), false);
  });

  it('sends the opt-in for the turn it was set on, then returns to off', async () => {
    await renderPanel(openRouterProvider);

    fireEvent.click(await screen.findByTestId('chat-web-search-toggle'));
    expect(screen.getByTestId('chat-web-search-toggle')).toHaveAttribute('aria-pressed', 'true');

    await send('What changed since publication?');
    expect(sendMessage).toHaveBeenLastCalledWith('session-1', 'What changed since publication?', expect.anything(), true);

    // Per-turn means per turn: the next question is an ordinary grounded turn
    // unless the reader opts in again, so search cost is never silently
    // recurring.
    await waitFor(() => {
      expect(screen.getByTestId('chat-web-search-toggle')).toHaveAttribute('aria-pressed', 'false');
    });
    await finishTurn();
    await send('And before that?');
    expect(sendMessage).toHaveBeenLastCalledWith('session-1', 'And before that?', expect.anything(), false);
  });

  it('consumes the same per-turn choice when a recovered draft is sent again', async () => {
    // A failed turn comes back to the composer rather than to a Retry control,
    // so sending it again is a send like any other. If it ignored the toggle,
    // the reader would watch a search they had just asked for run as an
    // ordinary turn — and the opt-in would stay armed for the next one.
    await renderPanel(openRouterProvider);
    sendMessage.mockRejectedValueOnce(new Error('Provider unavailable.'));
    await send('What changed since publication?');

    await waitFor(() => {
      expect(screen.getByLabelText('Message Reader AI')).toHaveValue('What changed since publication?');
    });
    fireEvent.click(await screen.findByTestId('chat-web-search-toggle'));
    fireEvent.click(screen.getByTestId('send-chat-button'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenLastCalledWith(
        'session-1', 'What changed since publication?', expect.anything(), true
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-web-search-toggle')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('passes an accessibility audit with the control present', async () => {
    const container = await renderPanel(openRouterProvider);
    await screen.findByTestId('chat-web-search-toggle');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
