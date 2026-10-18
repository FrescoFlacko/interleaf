import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { AnnotationRepository } from '../../src/main/db/repositories/annotation-repository';
import { SearchRepository } from '../../src/main/db/repositories/search-repository';
import { ChatRepository } from '../../src/main/db/repositories/chat-repository';
import { AIContextRepository } from '../../src/main/ai/context-repository';
import { ChatService, type ChatEventOwner, type ChatProviderGateway } from '../../src/main/ai/chat-service';
import { ConversationTitler, TITLE_SYSTEM_PROMPT, type ConversationNamingMode } from '../../src/main/ai/conversation-titling';
import { ChatTitleRepository } from '../../src/main/db/repositories/chat-title-repository';
import { SettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { registerIpcHandlers, type IpcDispatcherDeps, type IpcMainLike } from '../../src/main/ipc/dispatcher';
import type { AgentService } from '../../src/main/agents/agent-service';
import { IPC, IPC_EVENTS } from '../../src/shared/constants/ipc';
import type { CloneableValue } from '../../src/shared/models/portable';
import { makeIpcDeps, testSenderRule } from '../helpers/ipc-deps';
import { unstubbed } from '../helpers/unstubbed';
import { LibraryService } from '../../src/main/library/library-service';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { OpenFileManager } from '../../src/main/open-files/open-file-manager';
import { OpenFileStore, type DocumentServices } from '../../src/main/open-files/open-file-store';
import type { DocumentMetadata } from '../../src/shared/types/document';
import {
  assertLibraryDocument,
  cancelChatRouted,
  closeDocumentRouted,
  openDocumentRouted,
  openFromDialog,
  openPending,
  servicesForDocument,
  servicesForSession,
} from '../../src/main/open-files/open-file-routing';
import type { Logger } from '../../src/main/logging/logger';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '../../src/main/ai/providers/types';
import type { AIModelInfo, AIProviderId, AIProviderStatus, ChatStreamEvent } from '../../src/shared/types/ai';
import { makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { makePptxFixture } from '../fixtures/pptx-fixtures';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';
import { createActiveWork } from '../../src/main/app/active-work';
import { ShutdownBarrier, type BarrierWindow } from '../../src/main/app/shutdown-barrier';
import { AgentServiceLiveness } from '../../src/main/agents/agent-service-liveness';
import { restartToUpdate } from '../../src/main/updates/update-runtime';

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const model: AIModelInfo = {
  // A lightweight tier, so Automatic naming chooses it.
  id: 'fixture-mini',
  name: 'Fixture Mini',
  contextWindow: 32_000,
  maxOutputTokens: 1_024,
  supportsStreaming: true,
};

/** An offline provider that streams until it is cancelled. */
class HeldProvider implements AIProvider {
  id: AIProviderId = 'fake';
  /** What each kind of request answers at once; `null` streams until cancelled. */
  readonly replies: Record<'chat' | 'title', string | null> = { chat: null, title: 'Opened File Title' };
  readonly requests: Record<'chat' | 'title', string[]> = { chat: [], title: [] };
  readonly name = 'Fixture Provider';
  readonly capabilities = {
    streaming: true,
    subscriptionAuth: false,
    apiKeyAuth: false,
    persistentSessions: true,
    toolFreeMode: true,
    hostedWebSearch: false,
  };
  readonly cancelled = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();

  detect(): Promise<AIProviderStatus> {
    return Promise.resolve({
      id: this.id, name: this.name, available: true, installed: true, authentication: 'connected',
      version: '1', errorMessage: null, models: [model], capabilities: this.capabilities,
    });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve([model]);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    const controller = new AbortController();
    this.aborts.set(request.requestId, controller);
    const reply = this.replyTo(request);
    if (reply !== null) {
      yield { type: 'token', token: reply };
      yield { type: 'done' };
      return;
    }
    yield { type: 'token', token: 'Reading ' };
    await new Promise<void>((resolve) => { controller.signal.addEventListener('abort', () => { resolve(); }); });
  }

  private replyTo(request: ProviderChatRequest): string | null {
    const kind = request.systemPrompt === TITLE_SYSTEM_PROMPT ? 'title' : 'chat';
    this.requests[kind].push(request.requestId);
    return this.replies[kind];
  }

  cancel(requestId: string): Promise<void> {
    this.cancelled.add(requestId);
    this.aborts.get(requestId)?.abort();
    return Promise.resolve();
  }
}

function owner(events: ChatStreamEvent[]): ChatEventOwner {
  return { id: 7, send: (_channel, payload) => { events.push(payload as ChatStreamEvent); }, isDestroyed: () => false, onDestroyed: () => () => undefined };
}

/** A renderer `webContents` as the dispatcher sees it, which a test can destroy. */
type FakeSender = {
  readonly sender: { id: number; send(channel: string, payload: CloneableValue): void; isDestroyed(): boolean; once(event: 'destroyed', listener: () => void): void; removeListener(event: 'destroyed', listener: () => void): void };
  readonly events: CloneableValue[];
  readonly destroy: () => void;
};

function fakeSender(id: number): FakeSender {
  let destroyed = false;
  const listeners = new Set<() => void>();
  const events: CloneableValue[] = [];
  return {
    sender: {
      id,
      send: (_channel, payload) => { events.push(payload); },
      isDestroyed: () => destroyed,
      once: (_event, listener) => { listeners.add(listener); },
      removeListener: (_event, listener) => { listeners.delete(listener); },
    },
    events,
    destroy: () => {
      destroyed = true;
      const pending = [...listeners];
      listeners.clear();
      pending.forEach((listener) => { listener(); });
    },
  };
}

/** What the renderer's indexer sends through the routed search channels. */
function indexPdf(services: DocumentServices, document: DocumentMetadata): void {
  const generation = services.search.begin(document.id, document.fileHash);
  services.search.append(document.id, document.fileHash, generation.generationId, [
    { ordinal: 0, text: 'Replication keeps copies of data on several machines.', location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: '1' },
  ]);
  services.search.complete(document.id, document.fileHash, generation.generationId);
}

function tableCount(db: InterleafDatabase, table: string): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('opening files without adding them to the library', () => {
  let tempDir: string;
  let openRoot: string;
  let libraryDb: InterleafDatabase;
  let provider: HeldProvider;
  let gateway: ChatProviderGateway & { shutdown: ReturnType<typeof vi.fn> };
  let registry: AssetRegistry;
  let deps: {
    library: LibraryService;
    annotations: AnnotationRepository;
    search: SearchRepository;
    chat: ChatService;
    openFiles: OpenFileManager;
  };
  let pendingPath: string | null;
  let chosenPath: string | null;
  let settings: SettingsRepository;
  let invoke: (channel: string, payload: CloneableValue, sender: FakeSender) => ReturnType<Parameters<IpcMainLike['handle']>[1]>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'open-files-'));
    const libraryRoot = join(tempDir, 'library');
    openRoot = join(tempDir, 'open-files');
    mkdirSync(openRoot, { recursive: true });
    libraryDb = InterleafDatabase.open(join(tempDir, 'interleaf.db'));
    runMigrations(libraryDb);
    const storage = new StorageManager(libraryRoot, log);
    await storage.initialize();
    registry = new AssetRegistry([libraryRoot, openRoot]);
    provider = new HeldProvider();
    gateway = {
      listStatuses: async () => [await provider.detect()],
      getStatus: () => provider.detect(),
      resolveModel: () => Promise.resolve(model),
      require: () => provider,
      testConnection: () => Promise.resolve({ success: true }),
      shutdown: vi.fn(() => Promise.resolve()),
    };
    const library = new LibraryService({
      db: libraryDb,
      storage,
      documents: new DocumentRepository(libraryDb),
      folders: new FolderRepository(libraryDb),
      readingPositions: new ReadingPositionRepository(libraryDb),
      log,
      assetRegistry: registry,
      currentScopeId: () => 'scope',
      documentAssets: new DocumentAssetRepository(libraryDb),
    });
    pendingPath = null;
    chosenPath = null;
    settings = new SettingsRepository(libraryDb, log);
    // Production wiring: one titler following the persisted settings, shared by
    // the library and every opened file.
    const titler = new ConversationTitler({ settings, providers: { ...gateway, listOpenRouterModels: () => Promise.resolve([]) }, log });
    deps = {
      library,
      annotations: new AnnotationRepository(libraryDb),
      search: new SearchRepository(libraryDb),
      chat: new ChatService({
        resolveOpenRouterModelId: () => Promise.resolve(null),
        chat: new ChatRepository(libraryDb),
        context: new AIContextRepository(libraryDb),
        providers: gateway,
        requireDocumentOpen: (id) => { library.requireDocumentOpen(id); },
        log,
        titles: titler.forStore(new ChatTitleRepository(libraryDb)),
      }),
      openFiles: new OpenFileManager({
        root: openRoot,
        createStore: ({ root }) => OpenFileStore.create({
          root, assetRegistry: registry, currentScopeId: () => 'scope', providers: gateway, resolveOpenRouterModelId: () => Promise.resolve(null), log,
          titler,
        }),
        chooseFile: () => Promise.resolve(chosenPath),
        takePendingPath: () => { const next = pendingPath; pendingPath = null; return next; },
      }),
    };
    const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
    registerIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } }, makeIpcDeps({
      ...deps,
      settings,
      agent: unstubbed<AgentService>('agent', {
        assertSettingsUpdateAllowed: () => undefined,
        validateSavedWorkingDirectorySettings: () => Promise.resolve(),
        applyProfileSettings: () => undefined,
      }),
      applyDiagnosticLogging: () => undefined,
      updates: unstubbed<IpcDispatcherDeps['updates']>('updates', { setAutomaticChecks: () => undefined }),
    }));
    invoke = (channel, payload, sender) =>
      handlers.get(channel)!({ senderFrame: { url: testSenderRule.allowedProductionFileUrl }, sender: sender.sender }, payload);
  });

  afterEach(async () => {
    await deps.chat.shutdown();
    await deps.openFiles.shutdown();
    libraryDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(name: string, bytes: Buffer | string): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, bytes);
    return filePath;
  }

  function libraryIsEmpty(): void {
    for (const table of ['documents', 'chat_sessions', 'chat_messages', 'annotations', 'reading_positions', 'document_text_chunks']) {
      expect(tableCount(libraryDb, table), table).toBe(0);
    }
  }

  it('reads a Markdown file through its own store and leaves the library and the original untouched', async () => {
    const source = write('Notes.MD', makeMarkdownFixture({ title: 'Field Notes' }));
    const before = { bytes: readFileSync(source), mtime: statSync(source).mtimeMs };
    chosenPath = source;

    const document = await openFromDialog(deps);
    expect(document?.format).toBe('markdown');
    const opened = await openDocumentRouted(deps, document!.id);
    expect(opened.document.title).toBe('Field Notes');

    const services = servicesForDocument(deps, document!.id);
    expect(services).not.toBe(deps);
    services.library.updateReadingPosition(document!.id, { format: 'markdown', blockIndex: 2, progression: 0.5 }, 0.5);
    expect((await services.library.getDocument(document!.id))?.readingPosition?.progress).toBe(0.5);
    expect(await deps.library.listDocuments()).toEqual([]);
    libraryIsEmpty();
    expect(readdirSync(openRoot)).toHaveLength(1);

    await closeDocumentRouted(deps, document!.id);
    expect(readdirSync(openRoot)).toEqual([]);
    expect(readFileSync(source).equals(before.bytes)).toBe(true);
    expect(statSync(source).mtimeMs).toBe(before.mtime);
    libraryIsEmpty();
  });

  it('keeps an opened file\'s chat out of the library and cancels its stream before disposal', async () => {
    chosenPath = write('paper.pdf', makePdfFixture());
    const document = (await openFromDialog(deps))!;
    await openDocumentRouted(deps, document.id);
    const services = servicesForDocument(deps, document.id);
    indexPdf(services, document);
    const session = await services.chat.createSession({ documentId: document.id, title: 'Chat', providerId: 'fake' });
    expect(servicesForSession(deps, session.id)).toBe(services);

    const events: ChatStreamEvent[] = [];
    const sent = await servicesForSession(deps, session.id).chat.sendMessage({ sessionId: session.id, content: 'Summarize' }, owner(events));
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'token')).toBe(true); });
    libraryIsEmpty();

    await closeDocumentRouted(deps, document.id);
    expect(provider.cancelled.has(sent.requestId)).toBe(true);
    expect(gateway.shutdown).not.toHaveBeenCalled();
    // Late work for a closed file is refused instead of reaching the library.
    expect(() => servicesForDocument(deps, document.id)).toThrow('no longer open');
    expect(servicesForSession(deps, session.id)).toBe(deps);
    await expect(services.chat.sendMessage({ sessionId: session.id, content: 'late' }, owner(events))).rejects.toThrow();
    expect(() => deps.chat.listSessions(document.id)).toThrow();
    libraryIsEmpty();
  });

  /** Saves the naming mode the way the Settings modal does. */
  async function saveNaming(mode: ConversationNamingMode, ai: Partial<ReturnType<SettingsRepository['get']>['ai']> = {}): Promise<void> {
    const current = settings.get();
    await expect(invoke(IPC.settingsUpdate, { ...current, ai: { ...current.ai, ...ai, conversationNaming: mode } }, fakeSender(1))).resolves.toMatchObject({ ok: true });
  }

  function titleState(db: InterleafDatabase, sessionId: string): string | undefined {
    return (db.raw.prepare('SELECT title_state FROM chat_sessions WHERE id = ?').get(sessionId) as { title_state: string } | undefined)?.title_state;
  }

  /** Opens an indexed PDF and finishes one turn in a default-titled conversation, named automatically. */
  async function namedTurn(name: string): Promise<{ readonly services: DocumentServices; readonly documentId: string; readonly sessionId: string }> {
    provider.id = 'local';
    provider.replies.chat = 'Read.';
    chosenPath = write(name, makePdfFixture());
    const document = (await openFromDialog(deps))!;
    await openDocumentRouted(deps, document.id);
    const services = servicesForDocument(deps, document.id);
    indexPdf(services, document);
    const session = await services.chat.createSession({ documentId: document.id, providerId: 'local' });
    const events: ChatStreamEvent[] = [];
    await services.chat.sendMessage({ sessionId: session.id, content: 'What is replicated?' }, owner(events));
    await vi.waitFor(() => { expect(events.some((event) => event.type === 'done')).toBe(true); });
    return { services, documentId: document.id, sessionId: session.id };
  }

  it('names an opened file\'s conversation in its own store by default', async () => {
    const { services, documentId, sessionId } = await namedTurn('named.pdf');
    await vi.waitFor(() => { expect(services.chat.getSessionForDocument(sessionId, documentId)?.title).toBe('Opened File Title'); });
    expect(provider.requests.title).toHaveLength(1);
    libraryIsEmpty();
  });

  it('cancels an opened file\'s naming call before its database is disposed', async () => {
    provider.replies.title = null;
    const { documentId } = await namedTurn('held.pdf');
    await vi.waitFor(() => { expect(provider.requests.title).toHaveLength(1); });
    await closeDocumentRouted(deps, documentId);
    expect(provider.cancelled.has(provider.requests.title[0] ?? '')).toBe(true);
    libraryIsEmpty();
  });

  /** An indexed PDF in the library, open, with one default-titled conversation. */
  async function libraryConversation(name: string): Promise<{ readonly documentId: string; readonly sessionId: string }> {
    provider.id = 'local';
    provider.replies.chat = 'Read.';
    const imported = await deps.library.importFile(write(name, makePdfFixture()), { storageMode: 'link', folderId: null });
    await openDocumentRouted(deps, imported.id);
    indexPdf(servicesForDocument(deps, imported.id), imported);
    return { documentId: imported.id, sessionId: (await deps.chat.createSession({ documentId: imported.id, providerId: 'local' })).id };
  }

  /** Sends the first question through `chat:send-message` and waits for its answer. */
  async function dispatchedTurn(sessionId: string, sender: FakeSender): Promise<void> {
    await expect(invoke(IPC.chatSendMessage, { sessionId, content: 'What is replicated?' }, sender)).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => { expect(sender.events.some((event) => (event as { type?: string }).type === 'done')).toBe(true); });
  }

  it('retires held naming in the library and an opened file when the saved mode goes Off and back', async () => {
    provider.replies.title = null;
    // Opening a library document ends open files, so the library turn goes first.
    const { sessionId: librarySession } = await libraryConversation('library.pdf');
    await dispatchedTurn(librarySession, fakeSender(11));
    const opened = await namedTurn('opened.pdf');
    await vi.waitFor(() => { expect(provider.requests.title).toHaveLength(2); });

    // An equal write and an unrelated edit keep both runs.
    await saveNaming('auto', { openRouterModel: 'vendor/other' });
    expect(provider.requests.title.filter((requestId) => provider.cancelled.has(requestId))).toEqual([]);

    await saveNaming(null);
    await saveNaming('auto');
    expect(provider.requests.title.filter((requestId) => !provider.cancelled.has(requestId))).toEqual([]);
    expect(titleState(libraryDb, librarySession)).toBe('failed');
    expect(opened.services.chat.getSessionForDocument(opened.sessionId, opened.documentId)?.title).toBe('Conversation 1');
    // The slots are free again and a new conversation is named under the restored mode.
    provider.replies.title = 'Fresh Title';
    const fresh = await namedTurn('fresh.pdf');
    await vi.waitFor(() => { expect(fresh.services.chat.getSessionForDocument(fresh.sessionId, fresh.documentId)?.title).toBe('Fresh Title'); });
    expect(provider.requests.title).toHaveLength(3);
    expect(titleState(libraryDb, librarySession)).toBe('failed');
  });

  it('retires naming when the asking renderer is destroyed, through the dispatcher\'s owner', async () => {
    provider.replies.title = null;
    const sender = fakeSender(21);
    const { documentId, sessionId } = await libraryConversation('owner.pdf');
    await dispatchedTurn(sessionId, sender);
    await vi.waitFor(() => { expect(provider.requests.title).toHaveLength(1); });

    sender.destroy();
    expect(provider.cancelled.has(provider.requests.title[0] ?? '')).toBe(true);
    expect(titleState(libraryDb, sessionId)).toBe('failed');
    expect(deps.chat.getSessionForDocument(sessionId, documentId)?.title).toBe('Conversation 1');
    expect(deps.chat.listMessages(sessionId).map((message) => message.content)).toEqual(['What is replicated?', 'Read.']);
  });

  it('routes a cancellation to the opened file\'s chat as well as the library\'s', async () => {
    chosenPath = write('cancel.pdf', makePdfFixture());
    const document = (await openFromDialog(deps))!;
    await openDocumentRouted(deps, document.id);
    const services = servicesForDocument(deps, document.id);
    indexPdf(services, document);
    const { chat } = services;
    const session = await chat.createSession({ documentId: document.id, title: 'Chat', providerId: 'fake' });
    const events: ChatStreamEvent[] = [];
    const sent = await chat.sendMessage({ sessionId: session.id, content: 'Outline' }, owner(events));
    await cancelChatRouted(deps, sent.requestId, 7);
    expect(provider.cancelled.has(sent.requestId)).toBe(true);
    await expect(cancelChatRouted(deps, sent.requestId, 7)).resolves.toBeUndefined();
  });

  it('opens a PPTX presentation and discards its staged copy on close', async () => {
    chosenPath = write('Slides.PPTX', makePptxFixture());
    const document = (await openFromDialog(deps))!;
    expect(document.format).toBe('pptx');
    expect((await openDocumentRouted(deps, document.id)).document.id).toBe(document.id);
    libraryIsEmpty();
    await closeDocumentRouted(deps, document.id);
    expect(readdirSync(openRoot)).toEqual([]);
  });

  it('replaces the open file only after the next one loads, and keeps it when that one is refused', async () => {
    const first = (await deps.openFiles.open(write('first.md', makeMarkdownFixture({ title: 'First' }))));
    await expect(deps.openFiles.open(write('fake.pdf', 'not a pdf at all'))).rejects.toThrow();
    expect(deps.openFiles.forDocument(first.id)).not.toBeNull();
    expect(readdirSync(openRoot)).toHaveLength(1);

    const second = await deps.openFiles.open(write('second.markdown', makeMarkdownFixture({ title: 'Second', extension: '.markdown' })));
    expect(() => deps.openFiles.forDocument(first.id)).toThrow('no longer open');
    expect(deps.openFiles.forDocument(second.id)).not.toBeNull();
    expect(readdirSync(openRoot)).toHaveLength(1);
  });

  it('refuses directories, missing files, and files whose bytes do not match their extension', async () => {
    const directory = join(tempDir, 'folder.pdf');
    mkdirSync(directory);
    await expect(deps.openFiles.open(directory)).rejects.toThrow();
    await expect(deps.openFiles.open(join(tempDir, 'missing.epub'))).rejects.toThrow();
    await expect(deps.openFiles.open(write('broken.pptx', 'PK not really a presentation'))).rejects.toThrow();
    await expect(deps.openFiles.open(write('renamed.docx', makePdfFixture()))).rejects.toThrow();
    expect(readdirSync(openRoot)).toEqual([]);
    libraryIsEmpty();
  });

  it('closes an open file when a library document is opened, and never offers it to Agent Mode', async () => {
    const libraryDoc = await deps.library.importFile(write('kept.md', makeMarkdownFixture({ title: 'Kept' })), { folderId: null, storageMode: 'managed' });
    chosenPath = write('visiting.md', makeMarkdownFixture({ title: 'Visiting' }));
    const visiting = (await openFromDialog(deps))!;
    expect(() => { assertLibraryDocument(deps, visiting.id); }).toThrow('Agent Mode');

    expect((await openDocumentRouted(deps, libraryDoc.id)).document.id).toBe(libraryDoc.id);
    expect(readdirSync(openRoot)).toEqual([]);
    expect(() => servicesForDocument(deps, visiting.id)).toThrow('no longer open');
    expect((await deps.library.listDocuments()).map((doc) => doc.title)).toEqual(['Kept']);
    expect(() => { assertLibraryDocument(deps, libraryDoc.id); }).not.toThrow();
  });

  it('opens the pending operating-system request once, and nothing when the dialog is cancelled', async () => {
    await expect(openFromDialog(deps)).resolves.toBeNull();
    await expect(openPending(deps)).resolves.toBeNull();
    pendingPath = write('queued.md', makeMarkdownFixture({ title: 'Queued' }));
    expect((await openPending(deps))?.title).toBe('Queued');
    await expect(openPending(deps)).resolves.toBeNull();
  });

  it('shuts down cleanly, refuses later opens, and discards what a crashed run left behind', async () => {
    await deps.openFiles.open(write('a.md', makeMarkdownFixture()));
    await deps.openFiles.shutdown();
    expect(readdirSync(openRoot)).toEqual([]);
    await expect(deps.openFiles.open(write('b.md', makeMarkdownFixture()))).rejects.toThrow('shutting down');

    mkdirSync(join(openRoot, 'left-over', 'library'), { recursive: true });
    writeFileSync(join(openRoot, 'left-over', 'library', 'copy.md'), '# stale');
    await OpenFileManager.discardLeftovers(openRoot);
    expect(readdirSync(openRoot)).toEqual([]);
  });

  it('serializes rapid opens so only the last file stays open', async () => {
    const paths = ['r1.md', 'r2.md', 'r3.md'].map((name) => write(name, makeMarkdownFixture({ title: name })));
    const results = await Promise.all(paths.map((filePath) => deps.openFiles.open(filePath)));
    const last = results.at(-1)!;
    expect(deps.openFiles.forDocument(last.id)).not.toBeNull();
    for (const earlier of results.slice(0, -1)) {
      expect(() => deps.openFiles.forDocument(earlier.id)).toThrow('no longer open');
    }
    expect(readdirSync(openRoot)).toHaveLength(1);
  });

  it('blocks an update restart until library, opened-file and import work settles, then refuses new work during the handshake', async () => {
    const libraryDoc = await deps.library.importFile(write('kept.pdf', makePdfFixture()), { folderId: null, storageMode: 'managed' });
    await deps.library.openDocument(libraryDoc.id);
    indexPdf(deps, libraryDoc);
    const librarySession = await deps.chat.createSession({ documentId: libraryDoc.id, title: 'Library', providerId: 'fake' });
    const events: ChatStreamEvent[] = [];
    const libraryTurn = await deps.chat.sendMessage({ sessionId: librarySession.id, content: 'Summarize' }, owner(events));
    chosenPath = write('visiting.pdf', makePdfFixture());
    const visiting = (await openFromDialog(deps))!;
    await openDocumentRouted(deps, visiting.id);
    const visitingServices = servicesForDocument(deps, visiting.id);
    indexPdf(visitingServices, visiting);
    const visitingSession = await visitingServices.chat.createSession({ documentId: visiting.id, title: 'Visiting', providerId: 'fake' });
    const visitingTurn = await visitingServices.chat.sendMessage({ sessionId: visitingSession.id, content: 'Summarize' }, owner(events));

    const agents = new AgentServiceLiveness();
    const activeWork = createActiveWork({
      agentSessions: [],
      chatStreams: [() => deps.chat.liveWork(), () => deps.openFiles.liveChatWork()],
      imports: [() => deps.library.importAdmission.liveWork(), () => deps.openFiles.liveOpens()],
      closeAdmission: [() => { deps.chat.closeAdmission(); }, () => { deps.openFiles.closeAdmission(); }, () => { agents.closeAdmission(); }, () => { deps.library.importAdmission.close(); }],
    });
    const pendingImport = deps.library.importFile(write('later.md', makeMarkdownFixture({ title: 'Later' })), { folderId: null, storageMode: 'managed' });
    // A refused file keeps the current one open, so its chat stays live.
    // The assertion is attached at once, since the refusal can arrive before it is awaited.
    const pendingOpenRefused = expect(deps.openFiles.open(write('refused.pdf', 'not a pdf at all'))).rejects.toThrow();
    expect(activeWork.probe()).toEqual({ agentSessions: 0, chatStreams: 2, imports: 2 });

    const install = vi.fn();
    const prepared = { prepareInstall: vi.fn(() => Promise.resolve({ version: '0.5.1', install })), cancelPreparedInstall: vi.fn() };
    const sent: { channel: string; payload: CloneableValue }[] = [];
    const window: BarrierWindow = { isDestroyed: () => false, close: vi.fn(), webContents: { send: (channel, payload) => { sent.push({ channel, payload }); } } };
    const drained: string[] = [];
    const barrier = new ShutdownBarrier({
      mainWindow: () => window,
      drain: () => { drained.push('drain'); return Promise.resolve(); },
      hasLiveServices: () => true,
      quit: vi.fn(),
      log,
      handshakeTimeoutMs: 60_000,
    });
    const update = { activeWork, requestQuitForUpdate: (run: () => void, close: () => void) => barrier.requestQuitForUpdate(run, close) };
    await expect(restartToUpdate(prepared, update)).resolves.toMatchObject({ outcome: 'blocked', activeWork: { chatStreams: 2, imports: 2 } });
    expect(prepared.prepareInstall).not.toHaveBeenCalled();

    expect((await pendingImport).title).toBe('Later');
    await pendingOpenRefused;
    expect(activeWork.probe()).toEqual({ agentSessions: 0, chatStreams: 2, imports: 0 });
    await cancelChatRouted(deps, libraryTurn.requestId, 7);
    await cancelChatRouted(deps, visitingTurn.requestId, 7);
    await vi.waitFor(() => { expect(activeWork.probe()).toEqual({ agentSessions: 0, chatStreams: 0, imports: 0 }); });

    await expect(restartToUpdate(prepared, update)).resolves.toEqual({ outcome: 'restarting', version: '0.5.1' });
    expect(sent.map((message) => message.channel)).toEqual([IPC_EVENTS.appBeforeClose]);
    // The renderer has not answered yet: nothing new may start.
    await expect(deps.chat.sendMessage({ sessionId: librarySession.id, content: 'again' }, owner(events))).rejects.toThrow('shutting down');
    await expect(visitingServices.chat.sendMessage({ sessionId: visitingSession.id, content: 'again' }, owner(events))).rejects.toThrow('shutting down');
    await expect(deps.library.importFile(write('blocked.md', makeMarkdownFixture()), { folderId: null, storageMode: 'managed' })).rejects.toThrow('shutting down');
    await expect(deps.openFiles.open(write('blocked-open.md', makeMarkdownFixture()))).rejects.toThrow('shutting down');
    expect(() => { agents.assertAcceptingRuns(); }).toThrow('shutting down');
    expect(activeWork.probe()).toEqual({ agentSessions: 0, chatStreams: 0, imports: 0 });
    // The renderer's flush still lands.
    expect(deps.library.updateReadingPosition(libraryDoc.id, { format: 'pdf', pageIndex: 0 }, 0.25).progress).toBe(0.25);
    expect(visitingServices.library.updateReadingPosition(visiting.id, { format: 'pdf', pageIndex: 0 }, 0.75).progress).toBe(0.75);
    expect(drained).toEqual([]);
    expect(install).not.toHaveBeenCalled();

    barrier.handleCloseReady(window.webContents, sent[0]?.payload ?? null);
    await vi.waitFor(() => { expect(install).toHaveBeenCalledOnce(); });
    expect(drained).toEqual(['drain']);
  });
});
