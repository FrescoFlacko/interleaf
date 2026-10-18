// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { DocumentMetadata } from '@shared/types/document';
import type { AIProviderStatus, ChatMessage, ChatSession } from '@shared/types/ai';
import type { InterleafAPI } from '@shared/types/api';
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
 * A conversation is read at its end. Opening one and landing on its opening
 * lines makes the reader scroll through everything they already read to find
 * the answer they came back for.
 *
 * jsdom performs no layout, so the thread's scroll extent is stubbed and these
 * tests hold the placement logic: which events re-place the thread, and that
 * the placement is done by writing the thread's own `scrollTop` rather than by
 * `scrollIntoView`, which would scroll every scrollable ancestor — including
 * the document the reader is looking at.
 *
 * The companion panel keeps all four tabs mounted and hides the inactive ones,
 * so a hidden thread loses its scroll offset; `useUiStore.rightTab` is the seam
 * both the panel and this suite use for that.
 */

const TURN_HEIGHT = 100;

const testDocument: DocumentMetadata = {
  id: 'doc-scroll',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-scroll',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  source: null,
};

const provider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [{ id: 'fake-grounded', name: 'Grounded', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true }],
  capabilities: {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

const session: ChatSession = {
  id: 'session-1',
  documentId: testDocument.id,
  documentHash: testDocument.fileHash,
  title: 'Consensus Notes',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 40,
  previewText: 'Quorum overlap',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

function message(ordinal: number): ChatMessage {
  return {
    id: `msg-${String(ordinal)}`,
    sessionId: session.id,
    role: ordinal % 2 === 0 ? 'user' : 'assistant',
    ordinal,
    content: `Turn number ${String(ordinal)}`,
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: 4,
    errorMessage: null,
    createdAt: '2026-09-06T00:00:01.000Z',
    disclosures: [],
    webSources: [],
  };
}

const history = Array.from({ length: 40 }, (_unused, index) => message(index));

describe('chat thread scroll position', () => {
  let listMessages: Mock<InterleafAPI['chat']['listMessages']>;
  let scrollIntoView: Mock<() => void>;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  /** The thread's scroller, which is the only element given a scroll extent. */
  const thread = (): HTMLElement => screen.getByTestId('chat-messages');

  /** The thread is at its end, and there was an end to reach. */
  function expectAtNewestTurn(): void {
    const messages = thread();
    expect(messages.scrollHeight).toBeGreaterThan(0);
    expect(messages.scrollTop).toBe(messages.scrollHeight);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Only the thread has an extent, so any scrolling of an ancestor would be
    // a write of 0 onto an element that never needed one.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        // Extent grows with the turns actually rendered, so an empty thread has
        // nowhere to scroll and a hydrated one does.
        return this.dataset.testid === 'chat-messages' ? this.childElementCount * TURN_HEIGHT : 0;
      },
    });
    // A spy in place of the setup's inert `scrollIntoView` is what makes its
    // absence from the panel an assertion rather than an accident.
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    listMessages = vi.fn(() => Promise.resolve(history));
    stubBridge({
      ai: {
        listProviders: vi.fn(() => Promise.resolve([provider])),
        getProviderStatus: vi.fn(() => Promise.resolve(provider)),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([session])),
        createSession: vi.fn(() => Promise.resolve(session)),
        updateSession: vi.fn(() => Promise.resolve(session)),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        listMessages: (sessionId: string) => listMessages(sessionId),
        listContext: vi.fn(() => Promise.resolve([])),
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        sendMessage: vi.fn(),
        cancel: vi.fn(() => Promise.resolve(undefined)),
        resolveCitation: vi.fn(() => Promise.resolve(null)),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });

    useUiStore.setState({ rightTab: 'chat' });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
      goToLocation: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(async () => {
    cleanup();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    await chat.getState().initializeDocument(null);
    useUiStore.setState({ rightTab: 'chat' });
  });

  /** Renders the panel and waits for the stored conversation to hydrate. */
  async function openChat(): Promise<void> {
    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByText('Turn number 39');
  }

  it('opens an existing conversation at its newest turn', async () => {
    await openChat();
    expectAtNewestTurn();
  });

  it('places the thread when hydration finishes after the panel mounted', async () => {
    let deliver!: (messages: readonly ChatMessage[]) => void;
    listMessages.mockImplementation(
      () => new Promise<readonly ChatMessage[]>((resolve) => { deliver = resolve; })
    );

    renderWithChatStore(chat, <ChatPanel />);
    await screen.findByTestId('chat-messages');
    // Nothing to be at the bottom of yet.
    expect(thread().scrollTop).toBe(0);

    await act(async () => {
      deliver(history);
      await Promise.resolve();
    });

    await waitFor(() => { expectAtNewestTurn(); });
  });

  it('returns to the newest turn after the conversation list', async () => {
    await openChat();
    thread().scrollTop = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    await screen.findByText('Conversations');
    fireEvent.click(screen.getByTestId('resume-chat-session'));

    await screen.findByText('Turn number 39');
    expectAtNewestTurn();
  });

  it('re-places the thread when the companion tab comes back', async () => {
    await openChat();

    // Hidden tabs stay mounted but lose their layout box, and with it the
    // scroll offset: coming back must not land the reader at turn one.
    act(() => { useUiStore.setState({ rightTab: 'annotations' }); });
    thread().scrollTop = 0;
    act(() => { useUiStore.setState({ rightTab: 'chat' }); });

    expectAtNewestTurn();
  });

  it('follows a new turn to the bottom', async () => {
    await openChat();
    thread().scrollTop = 0;

    act(() => {
      chat.setState({ messages: [...history, message(40)] });
    });

    expect(await screen.findByText('Turn number 40')).toBeVisible();
    expectAtNewestTurn();
  });

  it('reaches the newest turn without scrolling anything but the thread', async () => {
    const { container } = renderWithChatStore(chat,
      <div data-testid="outer-scroller">
        <ChatPanel />
      </div>
    );
    await screen.findByText('Turn number 39');

    // `scrollIntoView` is the tempting shortcut and the wrong one: it scrolls
    // every scrollable ancestor, so the reader's document would move to bring
    // a chat bubble into view.
    expect(scrollIntoView).not.toHaveBeenCalled();

    const scrolled = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element.scrollTop !== 0)
      .map((element) => element.dataset.testid ?? element.tagName);
    expect(scrolled).toEqual(['chat-messages']);
    expect(screen.getByTestId('outer-scroller').scrollTop).toBe(0);
  });
});
