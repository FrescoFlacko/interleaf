// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import type {
  AIProviderStatus,
  ChatContextAttachInput,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  SendChatMessageResult,
} from '@shared/types/ai';
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

type AttachContextArgs = {
  readonly sessionId: string;
  readonly documentId: string;
  readonly documentHash: string;
  readonly input: ChatContextAttachInput;
};

const testDocument: DocumentMetadata = {
  id: 'doc-auto-context',
  title: 'Auto Context Book',
  author: 'Test Author',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 2048,
  fileMtimeMs: 1,
  fileHash: 'hash-auto-context',
  pageCount: 12,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  source: null,
};

/** A second book, used to move the reader off the document a send prepared under. */
const otherDocument: DocumentMetadata = {
  ...testDocument,
  id: 'doc-other-book',
  title: 'Other Book',
  fileHash: 'hash-other-book',
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

const session1: ChatSession = {
  id: 'session-1',
  documentId: testDocument.id,
  documentHash: testDocument.fileHash,
  title: 'First Chat',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 0,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

const session2: ChatSession = { ...session1, id: 'session-2', title: 'Second Chat' };

const selectionItem: ChatContextItem = {
  id: 'ctx-selection',
  sessionId: 'session-1',
  kind: 'selection',
  sourceRef: {},
  excerptText: 'An explicitly chosen passage',
  excerptHash: 'h-selection',
  documentHash: testDocument.fileHash,
  location: { format: 'pdf', pageIndex: 3 },
  provenance: {},
  displayLabel: 'Page 4 selection',
  pinned: true,
  createdAt: '2026-09-05T00:00:00.000Z',
};

function entireDocumentItem(id: string): ChatContextItem {
  return {
    id,
    sessionId: 'session-1',
    kind: 'entire_document',
    sourceRef: {},
    excerptText: '',
    excerptHash: 'h-entire',
    documentHash: testDocument.fileHash,
    location: { format: 'pdf', pageIndex: 0 },
    provenance: {},
    displayLabel: 'Entire document',
    pinned: true,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

/** What main returns for the bounded window Reader Chat attaches on its own. */
function nearbyItem(id: string): ChatContextItem {
  return {
    id,
    sessionId: 'session-1',
    kind: 'range',
    sourceRef: {},
    excerptText: '',
    excerptHash: 'h-nearby',
    documentHash: testDocument.fileHash,
    location: { format: 'pdf', pageIndex: 0 },
    provenance: {},
    displayLabel: 'Pages 1–12',
    pinned: true,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

/** The attach input recorded for the single automatic attachment. */
function attachedInput(): ChatContextAttachInput {
  const call = attachContextCalls.at(-1);
  if (!call) throw new Error('no attachContext call was recorded');
  return call.input;
}

let attachContextCalls: AttachContextArgs[] = [];

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

/**
 * Runs `task` exactly `depth` microtasks from now, which is how the window
 * between an attachment resolving and the turn crossing IPC is walked one hop at
 * a time.
 */
function afterMicrotasks(depth: number, task: () => void): Promise<void> {
  const hops = Array.from({ length: depth }, () => undefined);
  return hops.reduce<Promise<void>>((hop) => hop.then(() => undefined), Promise.resolve()).then(task);
}

/**
 * A question asked with nothing attached gets *nearby* context, not the whole
 * book: sending an entire document for "what does this paragraph mean?" is both
 * expensive and worse grounding. The window is bounded and clamped to what the
 * document really contains, and the explicit Whole doc action is untouched.
 */
describe('automatic nearby context on empty-context submission', () => {
  /** Ordered record of the privileged calls, used to prove attach-before-send. */
  let callOrder: string[] = [];
  let attachCounter = 0;

  const listProviders = vi.fn(() => Promise.resolve([fakeProvider]));
  const listSessions = vi.fn(() => Promise.resolve([session1, session2]));
  const getSession = vi.fn(() => Promise.resolve(session1));
  const createSession = vi.fn(() => Promise.resolve(session1));
  const listMessages = vi.fn<(sessionId: string) => Promise<readonly ChatMessage[]>>(() =>
    Promise.resolve([])
  );
  const listContext = vi.fn<(sessionId: string) => Promise<readonly ChatContextItem[]>>(() =>
    Promise.resolve([])
  );
  const attachContext = vi.fn<(input: AttachContextArgs) => Promise<ChatContextItem>>((input) => {
    callOrder.push(`attach:${input.input.kind}`);
    attachContextCalls.push(input);
    return Promise.resolve(nearbyItem(`ctx-nearby-${String(++attachCounter)}`));
  });
  /**
   * An accepted turn keeps the context it sent, automatic windows included. The
   * fixture reports exactly what main would, so the store is exercised against
   * real acceptance semantics rather than against a turn that retires them.
   */
  function acceptedSend(sessionId: string, content: string): Promise<SendChatMessageResult> {
    callOrder.push('send');
    return Promise.resolve({
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
        createdAt: '2026-09-05T00:00:00.000Z',
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
        createdAt: '2026-09-05T00:00:01.000Z',
        disclosures: [],
        webSources: [],
      },
    });
  }
  /** The store's stream subscription, used to finish a turn the way main does. */
  let streamListener: ((event: ChatStreamEvent) => void) | null = null;
  const sendMessage =
    vi.fn<(sessionId: string, content: string) => Promise<SendChatMessageResult>>(acceptedSend);

  beforeEach(() => {
    callOrder = [];
    streamListener = null;
    attachContextCalls = [];
    attachCounter = 0;
    vi.clearAllMocks();
    listProviders.mockReset().mockResolvedValue([fakeProvider]);
    listSessions.mockReset().mockResolvedValue([session1, session2]);
    // A send that is refused leaves its one-shot implementation unconsumed, and
    // `clearAllMocks` does not drop those: re-arming keeps one test's queued
    // answer from being handed to the next one's turn.
    sendMessage.mockReset().mockImplementation(acceptedSend);
    listMessages.mockReset().mockResolvedValue([]);
    listContext.mockReset().mockResolvedValue([]);
    attachContext.mockReset().mockImplementation((input) => {
      callOrder.push(`attach:${input.input.kind}`);
      attachContextCalls.push(input);
      return Promise.resolve(nearbyItem(`ctx-nearby-${String(++attachCounter)}`));
    });
    stubBridge({
      ai: { listProviders },
      chat: {
        listSessions,
        getSession,
        createSession,
        listMessages,
        listContext,
        sendMessage,
        cancel: vi.fn(() => Promise.resolve(undefined)),
        attachContext,
        removeContext: vi.fn(() => Promise.resolve(undefined)),
        updateSession: vi.fn(() => Promise.resolve(session1)),
        deleteSession: vi.fn(() => Promise.resolve(undefined)),
        onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
          streamListener = listener;
          return () => undefined;
        }),
      },
    });
    useReaderStore.setState({ session: testReaderSession(testDocument), currentPage: 5 });
  });

  afterEach(() => {
    useReaderStore.setState({ session: null, currentPage: 1 });
  });

  it('attaches a bounded window around the reading position before sending', async () => {
    await chat.getState().initializeDocument(testDocument);
    expect(chat.getState().contextItems).toHaveLength(0);

    await chat.getState().sendMessage('What is this document about?');

    expect(callOrder).toEqual(['attach:range', 'send']);
    expect(attachContext).toHaveBeenCalledTimes(1);
    expect(attachContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        documentId: testDocument.id,
        documentHash: testDocument.fileHash,
      })
    );
    // Page 5 of a 12-page PDF: ten pages either side, clamped at both ends to
    // what the document actually has, so no page is claimed that cannot exist.
    expect(attachedInput()).toEqual({ kind: 'range', format: 'pdf', pageStart: 1, pageEnd: 12 });

    // The window stays attached after the turn, like any other context the
    // conversation carries, and its chip names the bounded range.
    expect(chat.getState().contextItems.map((item) => item.displayLabel)).toEqual([
      'Pages 1–12',
    ]);
    expect(sendMessage).toHaveBeenCalledWith('session-1', 'What is this document about?', expect.anything(), false);
  });

  it('spans exactly ten pages either side away from the document edges', async () => {
    const longDocument: DocumentMetadata = { ...testDocument, pageCount: 400 };
    useReaderStore.setState({ session: testReaderSession(longDocument), currentPage: 120 });
    await chat.getState().initializeDocument(longDocument);

    await chat.getState().sendMessage('What is happening on this page?');

    // 21 pages including the current one — the promise the status label makes.
    expect(attachedInput()).toEqual({ kind: 'range', format: 'pdf', pageStart: 110, pageEnd: 130 });
  });

  it('clamps to the real page count rather than reading past the end', async () => {
    const shortDocument: DocumentMetadata = { ...testDocument, pageCount: 122 };
    useReaderStore.setState({ session: testReaderSession(shortDocument), currentPage: 121 });
    await chat.getState().initializeDocument(shortDocument);

    await chat.getState().sendMessage('And near the end?');

    expect(attachedInput()).toEqual({ kind: 'range', format: 'pdf', pageStart: 111, pageEnd: 122 });
  });

  it('attaches the current indexed location for a reflowable format', async () => {
    const epubDocument: DocumentMetadata = {
      ...testDocument,
      id: 'doc-epub',
      fileHash: 'hash-epub',
      format: 'epub',
      pageCount: null,
    };
    getSession.mockResolvedValue({ ...session1, documentId: epubDocument.id, documentHash: epubDocument.fileHash });
    listSessions.mockResolvedValue([
      { ...session1, documentId: epubDocument.id, documentHash: epubDocument.fileHash },
    ]);
    useReaderStore.setState({
      session: testReaderSession(epubDocument),
      currentPage: 1,
      currentLocation: { format: 'epub', cfi: 'epubcfi(/6/14!/4/2/2)' },
    });
    await chat.getState().initializeDocument(epubDocument);

    await chat.getState().sendMessage('What is this section arguing?');

    // A reflowable book has no pages to count from, so the honest bounded unit
    // is the indexed location the reader is actually at.
    expect(callOrder).toEqual(['attach:location', 'send']);
    expect(attachedInput()).toEqual({
      kind: 'location',
      location: { format: 'epub', cfi: 'epubcfi(/6/14!/4/2/2)' },
    });
  });

  it('attaches one window for the conversation rather than one per submission', async () => {
    await chat.getState().initializeDocument(testDocument);

    await chat.getState().sendMessage('First question');
    const firstTurn = chat.getState().messages.find((message) => message.id === 'msg-assistant');
    if (!firstTurn) throw new Error('The first turn never showed its answer.');
    streamListener?.({
      type: 'done',
      documentId: testDocument.id,
      sessionId: 'session-1',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      messageId: 'msg-assistant',
      message: { ...firstTurn, content: 'First answer.', status: 'complete' },
    });
    expect(chat.getState().isStreaming).toBe(false);
    await chat.getState().sendMessage('Second question');

    // The window from the first turn is still attached, so the second question
    // already has context and nothing is piled on top of it.
    expect(attachContext).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['attach:range', 'send', 'send']);
    expect(chat.getState().contextItems).toHaveLength(1);
  });

  it('leaves sessions that already have explicit context untouched', async () => {
    listContext.mockResolvedValue([selectionItem]);
    await chat.getState().initializeDocument(testDocument);
    expect(chat.getState().contextItems).toHaveLength(1);

    await chat.getState().sendMessage('Explain this passage');

    // No window is added beside what the reader chose, and their selection is
    // still attached when the turn is done.
    expect(attachContext).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['send']);
    expect(chat.getState().contextItems).toEqual([selectionItem]);
  });

  it('does not send and keeps the draft recoverable when the attachment fails', async () => {
    attachContext.mockRejectedValueOnce(new Error('Document exceeds the model context window.'));
    await chat.getState().initializeDocument(testDocument);

    await chat.getState().sendMessage('Summarize the document');

    expect(sendMessage).not.toHaveBeenCalled();
    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
    expect(state.lastFailedDraft).toBe('Summarize the document');
    expect(state.error).toContain('Document exceeds the model context window.');
    expect(state.contextItems).toHaveLength(0);
  });

  it('keeps the explicit Whole doc action attaching the whole document', async () => {
    await chat.getState().initializeDocument(testDocument);

    await chat.getState().addEntireDocument(testDocument, { format: 'pdf', pageIndex: 0 });

    expect(attachContext).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { kind: 'entire_document', location: { format: 'pdf', pageIndex: 0 } },
      })
    );
  });

  it('leaves an explicit Whole doc attachment alone instead of adding a window to it', async () => {
    listContext.mockResolvedValue([entireDocumentItem('ctx-entire-explicit')]);
    await chat.getState().initializeDocument(testDocument);

    await chat.getState().sendMessage('Summarize the whole thing');

    // The explicit action stays idempotent: a session that already carries the
    // document is not topped up with a redundant nearby range, and the
    // attachment survives the turn.
    expect(attachContext).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['send']);
    expect(chat.getState().contextItems).toHaveLength(1);
  });

  it('sends the first draft once when a second submission arrives during the attachment', async () => {
    await chat.getState().initializeDocument(testDocument);
    const gate = deferred<ChatContextItem>();
    attachContext.mockImplementationOnce(() => {
      callOrder.push('attach:range');
      return gate.promise;
    });

    const first = chat.getState().sendMessage('First draft');
    const second = chat.getState().sendMessage('Second draft');
    gate.resolve(entireDocumentItem('ctx-entire-race'));
    await Promise.all([first, second]);

    expect(attachContext).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('session-1', 'First draft', expect.anything(), false);
    expect(callOrder).toEqual(['attach:range', 'send']);
    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('does not send when the session changes while the attachment is in flight', async () => {
    await chat.getState().initializeDocument(testDocument);
    const gate = deferred<ChatContextItem>();
    attachContext.mockImplementationOnce(() => {
      callOrder.push('attach:range');
      return gate.promise;
    });

    const inFlight = chat.getState().sendMessage('Stale session question');
    await chat.getState().switchSession('session-2');
    gate.resolve(entireDocumentItem('ctx-entire-stale'));
    await inFlight;

    expect(sendMessage).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['attach:range']);

    // The conversation now on screen is session 2, and it never typed this
    // draft: neither the draft nor the error may appear in it.
    const switched = chat.getState();
    expect(switched.activeSessionId).toBe('session-2');
    expect(switched.isStreaming).toBe(false);
    expect(switched.lastFailedDraft).toBeNull();
    expect(switched.error).toBeNull();

    // Session 1 owns the failed draft and gets it back when it is active again.
    await chat.getState().switchSession('session-1');
    const owning = chat.getState();
    expect(owning.lastFailedDraft).toBe('Stale session question');
    expect(owning.error).toContain('chat session changed');

    // Dismissing it in the owning conversation retires it for good.
    chat.getState().clearFailedDraft();
    await chat.getState().switchSession('session-2');
    await chat.getState().switchSession('session-1');
    expect(chat.getState().lastFailedDraft).toBeNull();
  });

  it('does not leak a rejected stale attachment into the newly selected session', async () => {
    await chat.getState().initializeDocument(testDocument);
    const gate = deferred<ChatContextItem>();
    attachContext.mockImplementationOnce(() => {
      callOrder.push('attach:range');
      return gate.promise;
    });

    const inFlight = chat.getState().sendMessage('Stale rejection question');
    await chat.getState().switchSession('session-2');
    gate.reject(new Error('attachment exploded'));
    await inFlight;

    expect(sendMessage).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['attach:range']);

    // Session 2 never asked for this attachment, so its own state is untouched.
    const switched = chat.getState();
    expect(switched.activeSessionId).toBe('session-2');
    expect(switched.isStreaming).toBe(false);
    expect(switched.error).toBeNull();
    expect(switched.lastFailedDraft).toBeNull();

    // Session 1 owns the failure and receives it when it is active again.
    await chat.getState().switchSession('session-1');
    const owning = chat.getState();
    expect(owning.lastFailedDraft).toBe('Stale rejection question');
    expect(owning.error).toContain('attachment exploded');
  });

  /**
   * The readiness that admits a send is read before the automatic attachment,
   * and the attachment is an await: a settings change can re-run discovery
   * during it. These tests hold the attachment open, move discovery underneath
   * it, and then release it, so the only thing that can stop the turn is a check
   * made after the attachment and before the IPC call.
   */
  describe('provider readiness changing while the attachment is in flight', () => {
    /** Starts a send whose automatic attachment is held open. */
    function sendWithHeldAttachment(draft: string): {
      readonly sent: Promise<void>;
      readonly attachment: ReturnType<typeof deferred<ChatContextItem>>;
    } {
      const attachment = deferred<ChatContextItem>();
      attachContext.mockImplementationOnce(() => {
        callOrder.push('attach:range');
        return attachment.promise;
      });
      return { sent: chat.getState().sendMessage(draft), attachment };
    }

    /** Begins the settings-triggered re-read the send has to notice. */
    function beginProviderRefresh(): {
      readonly refreshed: Promise<void>;
      readonly probe: ReturnType<typeof deferred<AIProviderStatus[]>>;
    } {
      const probe = deferred<AIProviderStatus[]>();
      listProviders.mockImplementationOnce(() => probe.promise);
      const refreshed = chat.getState().refreshProviders();
      expect(chat.getState().providerDiscovery).toBe('loading');
      return { refreshed, probe };
    }

    it('does not send when the refreshed probe fails before the attachment lands', async () => {
      await chat.getState().initializeDocument(testDocument);
      const { sent, attachment } = sendWithHeldAttachment('Question during a failing refresh');

      const { refreshed, probe } = beginProviderRefresh();
      probe.reject(new Error('Provider probe failed.'));
      await refreshed;
      expect(chat.getState().providerDiscovery).toBe('failed');

      attachment.resolve(nearbyItem('ctx-nearby-failed-refresh'));
      await sent;

      // The gate that let this send in was answered before the failure, so the
      // turn must not cross IPC on it.
      expect(sendMessage).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['attach:range']);

      const state = chat.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.activeRequestId).toBeNull();
      expect(state.statusMessage).toBe('');
      expect(state.lastFailedDraft).toBe('Question during a failing refresh');
      expect(state.error).toMatch(/Could not check which AI providers are ready/);
      // The window it attached stays in the tray for the retry.
      expect(state.contextItems.map((item) => item.id)).toEqual(['ctx-nearby-failed-refresh']);
    });

    /**
     * Sweeps the whole window between the attachment resolving and the turn
     * crossing IPC, one microtask at a time, including the very last one before
     * the call. Whatever the depth, the turn either does not go out or goes out
     * on an answer that is current at the moment of the call: there is no hop at
     * which readiness the store has already retracted can authorize a send.
     */
    it.each([0, 1, 2, 3, 4, 5, 6])(
      'keeps readiness retracted %i microtasks after the attachment out of the send IPC',
      async (depth) => {
        await chat.getState().initializeDocument(testDocument);
        const observed: { discoveryAtSend: string | null } = { discoveryAtSend: null };
        sendMessage.mockImplementationOnce((sessionId, content) => {
          observed.discoveryAtSend = chat.getState().providerDiscovery;
          return acceptedSend(sessionId, content);
        });
        const probe = deferred<AIProviderStatus[]>();
        listProviders.mockImplementationOnce(() => probe.promise);
        const { sent, attachment } = sendWithHeldAttachment(`Draft at depth ${String(depth)}`);

        attachment.resolve(nearbyItem(`ctx-depth-${String(depth)}`));
        void afterMicrotasks(depth, () => {
          void chat.getState().refreshProviders();
        });
        await sent;

        const state = chat.getState();
        // Both admissible outcomes are spelled out together, so a turn that went
        // out on readiness the store had already retracted matches neither.
        expect({
          sent: sendMessage.mock.calls.length > 0,
          discoveryAtSend: observed.discoveryAtSend,
          isStreaming: state.isStreaming,
          lastFailedDraft: state.lastFailedDraft,
          error: state.error,
        }).toBeOneOf([
          // It crossed IPC, and the answer it carried was current at that moment.
          {
            sent: true,
            discoveryAtSend: 'succeeded',
            isStreaming: true,
            lastFailedDraft: null,
            error: null,
          },
          // It was refused, and the draft is waiting with the reason.
          {
            sent: false,
            discoveryAtSend: null,
            isStreaming: false,
            lastFailedDraft: `Draft at depth ${String(depth)}`,
            error: expect.stringContaining('Still checking which AI providers are ready'),
          },
        ]);

        probe.resolve([fakeProvider]);
      }
    );

    /**
     * The same window, walked with a document switch instead of a refresh. A
     * send prepared under one document must never cross IPC once another one is
     * open, and its draft belongs to the conversation it was typed in: the
     * document that happened to be opened while it was preparing shows neither
     * the text nor the error, and the owning conversation gets both back.
     */
    it.each([0, 1, 2, 3, 4, 5, 6])(
      'keeps a document switch %i microtasks after the attachment from taking the draft with it',
      async (depth) => {
        await chat.getState().initializeDocument(testDocument);
        const draft = `Draft for the first document at depth ${String(depth)}`;
        const observed: { documentAtSend: string | null } = { documentAtSend: null };
        sendMessage.mockImplementationOnce((sessionId, content) => {
          observed.documentAtSend = chat.getState().activeDocument?.id ?? null;
          return acceptedSend(sessionId, content);
        });
        const { sent, attachment } = sendWithHeldAttachment(draft);

        attachment.resolve(nearbyItem(`ctx-switch-${String(depth)}`));
        const switched = afterMicrotasks(depth, () => {
          useReaderStore.setState({ session: testReaderSession(otherDocument), currentPage: 1 });
          void chat.getState().initializeDocument(otherDocument);
        });
        await sent;
        await switched;
        await chat.getState().initializeDocument(otherDocument);

        // Whatever the newly opened document shows, it shows nothing of a send
        // it never took part in.
        const opened = chat.getState();
        expect(opened.activeDocument?.id).toBe(otherDocument.id);
        expect(opened.isStreaming).toBe(false);
        expect(opened.activeRequestId).toBeNull();
        expect(opened.lastFailedDraft).toBeNull();
        expect(opened.error).toBeNull();

        await chat.getState().initializeDocument(testDocument);
        const owning = chat.getState();
        expect(owning.activeSessionId).toBe('session-1');
        // The two admissible outcomes, stated together so that a draft lost on
        // the way, or one shown for a turn that actually went out, matches
        // neither: either the turn crossed IPC while its own document was still
        // open and nothing was left unsent, or it was refused and the draft is
        // waiting in the conversation that typed it. Which refusal it is depends
        // on the side of the attachment the switch landed on; both say the
        // message did not go out.
        expect({
          documentAtSend: observed.documentAtSend,
          recoveredDraft: owning.lastFailedDraft,
          recoveredError: owning.error,
        }).toBeOneOf([
          { documentAtSend: testDocument.id, recoveredDraft: null, recoveredError: null },
          {
            documentAtSend: null,
            recoveredDraft: draft,
            recoveredError: expect.stringContaining('the message was not sent'),
          },
        ]);
      }
    );

    it('fails closed when the conversation is gone by the time the attachment lands', async () => {
      await chat.getState().initializeDocument(testDocument);
      const attachment = deferred<ChatContextItem>();
      attachContext.mockImplementationOnce(() => {
        callOrder.push('attach:range');
        // Deleted from another surface once this send is already under way, so
        // the conversation it was admitted for is gone before it is dispatched.
        chat.setState({ sessions: [session2] });
        return attachment.promise;
      });
      const sent = chat.getState().sendMessage('Draft for a deleted conversation');

      attachment.resolve(nearbyItem('ctx-deleted-session'));
      await sent;

      const state = chat.getState();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(state.isStreaming).toBe(false);
      expect(state.activeRequestId).toBeNull();
      expect(state.lastFailedDraft).toBe('Draft for a deleted conversation');
      // A conversation that cannot be found says nothing about which provider it
      // was bound to, so it is a refusal rather than the weaker "is any provider
      // ready" question answered by a provider this turn never chose.
      expect(state.error).toMatch(/no longer open/);
    });

    it('does not send while the refreshed probe is still outstanding, and sends once it answers', async () => {
      await chat.getState().initializeDocument(testDocument);
      const { sent, attachment } = sendWithHeldAttachment('Question during a pending refresh');

      const { refreshed, probe } = beginProviderRefresh();
      attachment.resolve(nearbyItem('ctx-nearby-pending-refresh'));
      await sent;

      // An unfinished check is not permission either.
      expect(sendMessage).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['attach:range']);
      const blocked = chat.getState();
      expect(blocked.isStreaming).toBe(false);
      expect(blocked.activeRequestId).toBeNull();
      expect(blocked.lastFailedDraft).toBe('Question during a pending refresh');
      expect(blocked.error).toMatch(/Still checking which AI providers are ready/);

      probe.resolve([fakeProvider]);
      await refreshed;
      await chat.getState().sendMessage('Question during a pending refresh');

      // The refusal was about currency: the same draft goes through once the
      // probe this send waited on has actually answered.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        'session-1',
        'Question during a pending refresh',
        expect.anything(),
        false
      );
      // The held window was attached once and reused by the turn that sent.
      expect(attachContext).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['attach:range', 'send']);
      const settled = chat.getState();
      expect(settled.lastFailedDraft).toBeNull();
      expect(settled.error).toBeNull();
    });
  });

  it('never sends when the reader shows a different document than the chat', async () => {
    await chat.getState().initializeDocument(testDocument);
    useReaderStore.setState({
      session: testReaderSession({ ...testDocument, id: 'doc-other', fileHash: 'hash-other' }),
      currentPage: 1,
    });

    await chat.getState().sendMessage('stale-reader draft');

    expect(attachContext).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callOrder).toEqual([]);
    const state = chat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.activeRequestId).toBeNull();
    expect(state.lastFailedDraft).toBe('stale-reader draft');
    expect(state.error).toContain('different document');
  });

  it('never sends when the reader shows another revision of the same document', async () => {
    await chat.getState().initializeDocument(testDocument);
    useReaderStore.setState({
      session: testReaderSession({ ...testDocument, fileHash: 'hash-auto-context-v2' }),
      currentPage: 1,
    });

    await chat.getState().sendMessage('stale-revision draft');

    expect(attachContext).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(chat.getState().lastFailedDraft).toBe('stale-revision draft');
  });
});
