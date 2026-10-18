import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { MIGRATIONS, applyMigrations, runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { ChatTitleRepository } from '@main/db/repositories/chat-title-repository';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService, type ChatEventOwner } from '@main/ai/chat-service';
import {
  ConversationTitler,
  TITLE_INSTRUCTION,
  TITLE_MAX_RESPONSE_TOKENS,
  TITLE_QUESTION_MAX_TEXT_UNITS,
  TITLE_SYSTEM_PROMPT,
  chooseNamingModel,
  sanitizeGeneratedTitle,
  type ConversationNamingMode,
} from '@main/ai/conversation-titling';
import { responseTokenLimit } from '@main/ai/providers/response-token-limit';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { Logger } from '@main/logging/logger';
import { IPC_EVENTS } from '@shared/constants/ipc';
import type { AIModelInfo, AIModelPricing, AIProviderId, AIProviderStatus, ChatStreamEvent } from '@shared/types/ai';
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';
import { isChatSessionTitleChanged } from '../../src/preload/wire-guards';

const DOCUMENT_ID = 'doc-naming';

function modelInfo(id: string, pricing?: AIModelPricing): AIModelInfo {
  return { id, name: id, contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true, ...(pricing ? { pricing } : {}) };
}

const CHAT_MODEL = modelInfo('claude-sonnet');
const HAIKU_MODEL = modelInfo('claude-haiku');
/** The picker catalog a real ChatGPT/Codex profile advertised, in its order. */
const CODEX_CATALOG = ['codex-default', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'].map((id) => modelInfo(id));
const EXPLICIT: ConversationNamingMode = { providerId: 'local', modelId: 'local-small' };

type TitleBehaviour = 'answer' | 'hang' | 'no-done' | 'throw' | 'flood' | 'stall';

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A provider that answers chat turns and title requests, telling them apart by system prompt. */
class ScriptedProvider implements AIProvider {
  readonly name: string;
  readonly capabilities = { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false };
  available = true;
  titleText = 'Leader Replication Basics';
  titleBehaviour: TitleBehaviour = 'answer';
  titleGate: Promise<void> | null = null;
  /** For `stall`: the title token arrives, then `done` waits for this. */
  stallGate: Promise<void> = Promise.resolve();
  readonly titleRequests: ProviderChatRequest[] = [];
  readonly chatRequests: ProviderChatRequest[] = [];
  readonly cancelled: string[] = [];

  constructor(readonly id: AIProviderId, public models: AIModelInfo[]) {
    this.name = `Scripted ${id}`;
  }

  detect(): Promise<AIProviderStatus> {
    const { id, name, available, models, capabilities } = this;
    return Promise.resolve({ id, name, available, installed: true, authentication: 'connected', version: '1.0', errorMessage: null, models, capabilities });
  }

  listModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve(this.models);
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    if (request.systemPrompt !== TITLE_SYSTEM_PROMPT) {
      this.chatRequests.push(request);
      yield { type: 'token', token: 'An answer.' };
      yield { type: 'done' };
      return;
    }
    this.titleRequests.push(request);
    if (this.titleGate) await this.titleGate;
    switch (this.titleBehaviour) {
      case 'hang':
        await new Promise<never>(() => undefined);
        return;
      case 'throw':
        throw new Error(`provider leaked ${request.contextXml}`);
      case 'flood':
        for (let index = 0; index < 600; index += 1) yield { type: 'token', token: 'x' };
        yield { type: 'done' };
        return;
      case 'stall':
        yield { type: 'token', token: this.titleText };
        await this.stallGate;
        yield { type: 'done' };
        return;
      case 'no-done':
        yield { type: 'token', token: this.titleText };
        return;
      case 'answer':
        yield { type: 'token', token: this.titleText };
        yield { type: 'done' };
    }
  }

  cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
    return Promise.resolve();
  }
}

class ScriptedRegistry extends AIProviderRegistry {
  /** Replaces what `resolveModel` answers, to model a provider that resolves elsewhere. */
  resolvedOverride: AIModelInfo | null = null;
  catalog: readonly AIModelInfo[] = [];
  constructor(private readonly byId: ReadonlyMap<AIProviderId, ScriptedProvider>) {
    super(testAIProviderRegistryInput());
  }
  override require(providerId: AIProviderId): ScriptedProvider {
    const provider = this.byId.get(providerId);
    if (!provider) throw new Error(`no provider ${providerId}`);
    return provider;
  }
  override getStatus(providerId: AIProviderId): Promise<AIProviderStatus> {
    return this.require(providerId).detect();
  }
  override resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo> {
    if (this.resolvedOverride) return Promise.resolve(this.resolvedOverride);
    const known = [...this.require(providerId).models, ...this.catalog];
    // Like OpenRouter, an unknown id resolves as itself; catalog membership is checked separately.
    return Promise.resolve(known.find((entry) => entry.id === modelId) ?? (modelId === null ? known[0]! : modelInfo(modelId)));
  }
  override listOpenRouterModels(): Promise<readonly AIModelInfo[]> {
    return Promise.resolve(this.catalog);
  }
}

function seedDocument(db: InterleafDatabase, id: string, hash: string): void {
  new DocumentRepository(db).insert({
    id, title: 'Distributed Systems', author: null, format: 'pdf', filePath: `/tmp/${id}.pdf`,
    storageMode: 'link', fileSize: 1024, fileMtimeMs: 1, fileHash: hash, pageCount: 4,
  });
}

function titleRow(db: InterleafDatabase, sessionId: string): { readonly title: string; readonly title_state: string } | undefined {
  return db.raw.prepare('SELECT title, title_state FROM chat_sessions WHERE id = ?').get(sessionId) as
    { readonly title: string; readonly title_state: string } | undefined;
}

describe('automatic Reader Chat naming', () => {
  let db: InterleafDatabase;
  let claude: ScriptedProvider;
  let local: ScriptedProvider;
  let openrouter: ScriptedProvider;
  let codex: ScriptedProvider;
  let registry: ScriptedRegistry;
  let settings: SettingsRepository;
  let log: Logger & { readonly warn: ReturnType<typeof vi.fn<Logger['warn']>> };
  let service: ChatService;
  let streamEvents: ChatStreamEvent[];
  let sent: { readonly channel: string; readonly payload: Parameters<ChatEventOwner['send']>[1] }[];
  let ownerDestroyed: boolean;
  let destroyListeners: Set<() => void>;
  let owner: ChatEventOwner;

  /** Saves the mode through the settings repository, as the Settings modal does. */
  function saveNaming(next: ConversationNamingMode, ai: Partial<ReturnType<SettingsRepository['get']>['ai']> = {}): void {
    const current = settings.get();
    settings.update({ ...current, ai: { ...current.ai, ...ai, conversationNaming: next } });
  }

  function destroyOwner(): void {
    ownerDestroyed = true;
    for (const listener of [...destroyListeners]) listener();
  }

  /** Starts naming a new `claude` conversation and waits until `namer`'s title call is in flight. */
  async function heldRun(namer: ScriptedProvider = claude): Promise<{ readonly sessionId: string; readonly requestId: string }> {
    const before = namer.titleRequests.length;
    const session = await service.createSession({ documentId: DOCUMENT_ID, providerId: 'claude' });
    await exchange(session.id, 'Question');
    await vi.waitFor(() => { expect(namer.titleRequests).toHaveLength(before + 1); });
    return { sessionId: session.id, requestId: namer.titleRequests[before]!.requestId };
  }

  /** Lets any late provider output arrive, then checks a retired run stayed retired. */
  async function expectRetired(run: { readonly sessionId: string; readonly requestId: string }, namer: ScriptedProvider = claude): Promise<void> {
    expect(namer.cancelled).toContain(run.requestId);
    expect(titleRow(db, run.sessionId)?.title_state).toBe('failed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(titleRow(db, run.sessionId)).toEqual({ title: 'Conversation 1', title_state: 'failed' });
    expect(sent).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  }

  function buildService(timeoutMs?: number): ChatService {
    const titler = new ConversationTitler({ settings, providers: registry, log, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return new ChatService({
      chat: new ChatRepository(db),
      context: new AIContextRepository(db),
      providers: registry,
      requireDocumentOpen: () => undefined,
      resolveOpenRouterModelId: () => Promise.resolve(null),
      log,
      titles: titler.forStore(new ChatTitleRepository(db)),
    });
  }

  /** Sends one turn and waits for its done event. */
  async function exchange(sessionId: string, content: string): Promise<void> {
    const before = streamEvents.filter((event) => event.type === 'done').length;
    await service.sendMessage({ sessionId, content }, owner);
    await vi.waitFor(() => {
      expect(streamEvents.filter((event) => event.type === 'done').length).toBe(before + 1);
    });
  }

  /** A new `providerId` conversation after one completed exchange. */
  async function answered(providerId: AIProviderId = 'claude', content = 'Question', title?: string): Promise<string> {
    const session = await service.createSession({ documentId: DOCUMENT_ID, providerId, ...(title ? { title } : {}) });
    await exchange(session.id, content);
    return session.id;
  }

  async function settled(sessionId: string, state: string): Promise<void> {
    await vi.waitFor(() => { expect(titleRow(db, sessionId)?.title_state).toBe(state); });
  }

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    seedDocument(db, DOCUMENT_ID, 'hash-v1');
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES ('c1', ?, 0, 'Replication log and leader consensus.', 6, '{"format":"pdf","pageIndex":0}', 'Replication', '1')
    `).run(DOCUMENT_ID);
    db.raw.prepare(`
      INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES (?, 'ready', 1, 1, 'hash-v1', 'hash-v1', 1)
    `).run(DOCUMENT_ID);
    claude = new ScriptedProvider('claude', [CHAT_MODEL, HAIKU_MODEL]);
    local = new ScriptedProvider('local', [modelInfo('local-small'), modelInfo('local-other')]);
    openrouter = new ScriptedProvider('openrouter', [modelInfo('openrouter/auto')]);
    codex = new ScriptedProvider('codex', CODEX_CATALOG);
    registry = new ScriptedRegistry(new Map([['claude', claude], ['local', local], ['openrouter', openrouter], ['codex', codex]]));
    // A fresh profile: Automatic naming is the default.
    settings = new SettingsRepository(db, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
    log = { info: vi.fn(), warn: vi.fn<Logger['warn']>(), error: vi.fn(), debug: vi.fn() };
    streamEvents = [];
    sent = [];
    ownerDestroyed = false;
    destroyListeners = new Set();
    owner = {
      id: 1,
      send: (channel, payload) => {
        if (channel === IPC_EVENTS.chatSessionTitleChanged) sent.push({ channel, payload });
        else streamEvents.push(payload as ChatStreamEvent);
      },
      isDestroyed: () => ownerDestroyed,
      onDestroyed: (listener) => {
        destroyListeners.add(listener);
        return () => { destroyListeners.delete(listener); };
      },
    };
    service = buildService();
  });

  afterEach(async () => {
    await service.shutdown();
    db.close();
  });

  it('names by default with the conversation provider\'s lightweight model, once, from the bounded first question only', async () => {
    expect(settings.get().ai.conversationNaming).toBe('auto');
    const question = `How does <leader> replication & "quorum" work? ${'q'.repeat(3_000)}`;
    const sessionId = await answered('claude', question);
    await settled(sessionId, 'generated');

    expect(claude.titleRequests).toHaveLength(1);
    expect(local.titleRequests).toHaveLength(0);
    const request = claude.titleRequests[0]!;
    expect(request).toMatchObject({
      modelId: HAIKU_MODEL.id,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userMessage: TITLE_INSTRUCTION,
      history: [],
      sources: [],
      webSearch: false,
      maxResponseTokens: TITLE_MAX_RESPONSE_TOKENS,
    });
    // Escaped inert data, cut to the question bound, and nothing else.
    expect(request.contextXml).toContain('How does &lt;leader&gt; replication &amp; "quorum" work?');
    expect(request.contextXml).not.toContain('<leader>');
    expect(request.contextXml).not.toContain('An answer.');
    expect(request.contextXml).not.toContain('Replication log');
    expect(request.contextXml).not.toContain('q'.repeat(TITLE_QUESTION_MAX_TEXT_UNITS));
    expect(request.contextXml).toMatch(/^<first-question>[\s\S]*<\/first-question>$/u);

    const stored = service.getSessionForDocument(sessionId, DOCUMENT_ID)!;
    expect(stored.title).toBe('Leader Replication Basics');
    // The conversation's own binding is untouched.
    expect(stored.providerId).toBe('claude');
    expect(stored.modelId).toBe(CHAT_MODEL.id);
    expect(service.listMessages(sessionId).map((message) => message.content)).toEqual([question, 'An answer.']);

    expect(sent).toEqual([{ channel: IPC_EVENTS.chatSessionTitleChanged, payload: { sessionId, documentId: DOCUMENT_ID } }]);
    expect(isChatSessionTitleChanged(sent[0]?.payload)).toBe(true);
    expect(claude.cancelled).toContain(request.requestId);
    await vi.waitFor(() => { expect(destroyListeners.size).toBe(0); });

    // Later turns never name again.
    await exchange(sessionId, 'And a follow-up?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.titleRequests).toHaveLength(1);
  });

  it('skips Automatic naming without any call when the conversation\'s provider advertises no lightweight model', async () => {
    claude.models = [CHAT_MODEL];
    const sessionId = await answered();
    await settled(sessionId, 'failed');
    // Never a full-size model, and never another provider's small one.
    expect([...claude.titleRequests, ...local.titleRequests, ...openrouter.titleRequests]).toEqual([]);
    expect(titleRow(db, sessionId)?.title).toBe('Conversation 1');
  });

  it('names a Codex conversation with an advertised Luna model from the same provider by default', async () => {
    expect(settings.get().ai.conversationNaming).toBe('auto');
    const sessionId = await answered('codex');
    await settled(sessionId, 'generated');

    expect(codex.titleRequests.map((request) => request.modelId)).toEqual(['gpt-5.6-luna']);
    expect([...claude.titleRequests, ...local.titleRequests, ...openrouter.titleRequests]).toEqual([]);
    const stored = service.getSessionForDocument(sessionId, DOCUMENT_ID)!;
    expect(stored.title).toBe('Leader Replication Basics');
    expect(stored.providerId).toBe('codex');
    expect(stored.modelId).toBe('codex-default');
    expect(service.listMessages(sessionId).map((message) => message.content)).toEqual(['Question', 'An answer.']);
  });

  it('chooses from the OpenRouter live catalog, which an explicit OpenRouter model must also be in', async () => {
    registry.catalog = [modelInfo('openai/gpt-4o'), modelInfo('openai/gpt-4o-mini')];
    const automatic = await answered('openrouter');
    await settled(automatic, 'generated');
    expect(openrouter.titleRequests.map((request) => request.modelId)).toEqual(['openai/gpt-4o-mini']);

    saveNaming({ providerId: 'openrouter', modelId: 'vendor/unlisted' });
    const unlisted = await answered();
    await settled(unlisted, 'failed');
    saveNaming({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    const listed = await answered();
    await settled(listed, 'generated');
    expect(openrouter.titleRequests.map((request) => request.modelId)).toEqual(['openai/gpt-4o-mini', 'openai/gpt-4o']);
  });

  it('makes no naming call when naming is off, the conversation was titled explicitly, or the provider or model no longer matches', async () => {
    saveNaming(null);
    const off = await answered();
    saveNaming(EXPLICIT);
    const explicit = await answered('claude', 'Explicit question', 'My notes');

    local.available = false;
    const unready = await answered();
    await settled(unready, 'failed');
    local.available = true;

    registry.resolvedOverride = modelInfo('some-other-model');
    const mismatched = await answered();
    await settled(mismatched, 'failed');

    expect([...claude.titleRequests, ...local.titleRequests]).toHaveLength(0);
    expect(titleRow(db, off)).toEqual({ title: 'Conversation 1', title_state: 'default' });
    expect(titleRow(db, explicit)).toEqual({ title: 'My notes', title_state: 'manual' });
    expect(titleRow(db, unready)?.title).toMatch(/^Conversation \d$/u);
    expect(sent).toHaveLength(0);
  });

  it('emits the answer before any naming work and keeps later turns unblocked while naming runs', async () => {
    const release = gate();
    claude.titleGate = release.promise;
    const { sessionId } = await heldRun();
    expect(titleRow(db, sessionId)?.title_state).toBe('generating');
    await exchange(sessionId, 'Second question');
    expect(claude.chatRequests).toHaveLength(2);

    release.open();
    await settled(sessionId, 'generated');
  });

  it('keeps a manual rename made while naming runs, even to identical text', async () => {
    const release = gate();
    claude.titleGate = release.promise;
    const run = await heldRun();

    await service.updateSession({ sessionId: run.sessionId, title: 'Conversation 1' });
    expect(claude.cancelled).toContain(run.requestId);
    release.open();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(titleRow(db, run.sessionId)).toEqual({ title: 'Conversation 1', title_state: 'manual' });
    expect(sent).toHaveLength(0);
  });

  it('never resurrects a deleted conversation or titles an archived one', async () => {
    const release = gate();
    claude.titleGate = release.promise;
    const deleted = await heldRun();
    const archived = await heldRun();

    service.deleteSession(deleted.sessionId);
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = ?").run(DOCUMENT_ID);
    release.open();
    await settled(archived.sessionId, 'failed');

    expect(titleRow(db, deleted.sessionId)).toBeUndefined();
    expect(titleRow(db, archived.sessionId)?.title).toBe('Conversation 2');
    expect(sent).toHaveLength(0);
  });

  it.each<[string, ConversationNamingMode, ConversationNamingMode]>([
    ['Automatic to Off and back', 'auto', null],
    ['Automatic to an explicit model and back', 'auto', EXPLICIT],
    ['an explicit model to another model and back', EXPLICIT, { providerId: 'local', modelId: 'local-other' }],
    ['an explicit model to Automatic and back', EXPLICIT, 'auto'],
  ])('retires a stalled run when the saved mode goes from %s', async (_label, start, away) => {
    saveNaming(start);
    const namer = start === 'auto' ? claude : local;
    const stall = gate();
    namer.titleBehaviour = 'stall';
    namer.stallGate = stall.promise;
    const run = await heldRun(namer);

    saveNaming(away);
    saveNaming(start);
    stall.open();
    await expectRetired(run, namer);
    expect(namer.titleRequests).toHaveLength(1);
    // The retired run's slot is free again.
    namer.titleBehaviour = 'answer';
    await settled((await heldRun(namer)).sessionId, 'generated');
  });

  it('retires a run whose provider validation is still pending when the mode changes', async () => {
    saveNaming(EXPLICIT);
    const status = gate();
    const detect = local.detect.bind(local);
    local.detect = () => status.promise.then(detect);
    const sessionId = await answered();
    await settled(sessionId, 'generating');

    saveNaming(null);
    saveNaming(EXPLICIT);
    await settled(sessionId, 'failed');
    status.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(local.titleRequests).toHaveLength(0);
    expect(titleRow(db, sessionId)).toEqual({ title: 'Conversation 1', title_state: 'failed' });
  });

  it('keeps a running name through an equal save and an unrelated preference edit', async () => {
    const release = gate();
    claude.titleGate = release.promise;
    const { sessionId } = await heldRun();

    saveNaming('auto');
    saveNaming('auto', { openRouterModel: 'vendor/elsewhere' });
    release.open();
    await settled(sessionId, 'generated');
    expect(titleRow(db, sessionId)?.title).toBe('Leader Replication Basics');
  });

  it.each<[TitleBehaviour, string]>([
    ['no-done', 'a stream that ends without done'],
    ['flood', 'output past the stream bound'],
    ['throw', 'a provider error'],
    ['answer', 'a title the sanitizer cannot use'],
  ])('leaves the default title after %s (%s), logging nothing from the conversation', async (behaviour) => {
    claude.titleBehaviour = behaviour;
    if (behaviour === 'answer') claude.titleText = 'Line one\nLine two';
    const sessionId = await answered('claude', 'A private question about secrets');
    await settled(sessionId, 'failed');

    expect(titleRow(db, sessionId)?.title).toBe('Conversation 1');
    expect(service.listMessages(sessionId)[1]?.content).toBe('An answer.');
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).toContain('Conversation naming failed');
    expect(logged).not.toContain('private question');
    expect(logged).not.toContain(claude.titleText);
  });

  it('cancels a stalled call at the fixed deadline', async () => {
    await service.shutdown();
    service = buildService(30);
    claude.titleBehaviour = 'hang';
    const sessionId = await answered();
    await settled(sessionId, 'failed');
    expect(claude.cancelled).toContain(claude.titleRequests[0]?.requestId);
  });

  it('writes nothing after shutdown or document close, and a restart retires a stranded claim', async () => {
    claude.titleBehaviour = 'hang';
    const closed = await heldRun();
    await service.cancelForDocument(DOCUMENT_ID);
    expect(claude.cancelled).toContain(closed.requestId);

    const stranded = await heldRun();
    await service.shutdown();
    expect(claude.cancelled).toContain(stranded.requestId);
    expect(titleRow(db, stranded.sessionId)?.title_state).toBe('generating');

    // The next launch's repository retires every claim nobody can finish.
    new ChatTitleRepository(db);
    expect(titleRow(db, stranded.sessionId)).toEqual({ title: 'Conversation 2', title_state: 'failed' });
    expect(titleRow(db, closed.sessionId)?.title).toBe('Conversation 1');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('makes no naming call for a window destroyed before the answer completed', async () => {
    ownerDestroyed = true;
    const session = await service.createSession({ documentId: DOCUMENT_ID, providerId: 'claude' });
    await service.sendMessage({ sessionId: session.id, content: 'Question' }, owner);
    await vi.waitFor(() => { expect(service.listMessages(session.id)[1]?.status).toBe('complete'); });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(claude.titleRequests).toHaveLength(0);
    expect(titleRow(db, session.id)).toEqual({ title: 'Conversation 1', title_state: 'default' });
    expect(sent).toHaveLength(0);
    expect(destroyListeners.size).toBe(0);
  });

  it('retires a stalled run when its window is destroyed, ignoring late tokens and completion', async () => {
    const stall = gate();
    claude.titleBehaviour = 'stall';
    claude.stallGate = stall.promise;
    const run = await heldRun();
    expect(destroyListeners.size).toBe(1);

    destroyOwner();
    stall.open();
    await expectRetired(run);
    expect(destroyListeners.size).toBe(0);
    expect(service.listMessages(run.sessionId).map((message) => message.content)).toEqual(['Question', 'An answer.']);
    // No automatic retry: a later answer in the same conversation never names it.
    ownerDestroyed = false;
    await exchange(run.sessionId, 'Follow-up');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.titleRequests).toHaveLength(1);
  });

  it('skips naming while two runs are in flight instead of queueing', async () => {
    claude.titleBehaviour = 'hang';
    await heldRun();
    await heldRun();
    const skipped = await answered();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.titleRequests).toHaveLength(2);
    expect(titleRow(db, skipped)?.title_state).toBe('default');
  });
});

describe('choosing the Automatic naming model', () => {
  const priced = (input: number, output: number): AIModelPricing =>
    ({ input: { kind: 'priced', usdPerToken: input }, output: { kind: 'priced', usdPerToken: output } });

  it.each<[string, readonly AIModelInfo[], string | null]>([
    ['a tier marker over a size marker and a lower price', [modelInfo('vendor/tiny-3b', priced(1e-9, 1e-9)), modelInfo('vendor/model-mini', priced(1e-6, 1e-6))], 'vendor/model-mini'],
    ['each tier marker', ['nano', 'haiku', 'flash', 'lite', 'small'].map((tier) => modelInfo(`vendor/x-${tier}`)), 'vendor/x-flash'],
    ['a bounded parameter size', [modelInfo('vendor/llama-70b'), modelInfo('vendor/llama-3.2-3b'), modelInfo('vendor/smol-135m')], 'vendor/llama-3.2-3b'],
    ['the lowest advertised price, free first and unknown last', [modelInfo('a-mini'), modelInfo('b-mini', priced(2e-7, 2e-7)), modelInfo('c-mini', { input: { kind: 'free' }, output: { kind: 'free' } })], 'c-mini'],
    ['the id when prices tie', [modelInfo('z-mini'), modelInfo('a-mini')], 'a-mini'],
    ['4000M, which is 4B, at the size bound', [modelInfo('vendor/model-4000m'), modelInfo('vendor/model-4001m')], 'vendor/model-4000m'],
    ['nothing over 4B, whether written in B or M', [modelInfo('vendor/model-8b'), modelInfo('vendor/model-8000m'), modelInfo('vendor/model-5000M'), modelInfo('vendor/model-4.5B')], null],
    ['decimal sizes in either case', [modelInfo('vendor/model-4.5b'), modelInfo('vendor/model-3.5B'), modelInfo('vendor/model-4500M')], 'vendor/model-3.5B'],
    ['labels whose every size is in bound', [modelInfo('vendor/draft-3b-70b'), modelInfo('vendor/pair-300m-4b')], 'vendor/pair-300m-4b'],
    ['nothing from full-size models or embedded words', [modelInfo('google/gemini-pro'), modelInfo('vendor/model-7b'), modelInfo('openai/gpt-4o')], null],
    ['a bounded Luna name in any case', [modelInfo('vendor/x-lunar'), { ...modelInfo('vendor/x-pro'), name: 'Vendor LUNA' }], 'vendor/x-pro'],
    ['a bounded Luna id in any case', [modelInfo('openai/gpt-6-sol'), modelInfo('OpenAI/GPT-6-LUNA')], 'OpenAI/GPT-6-LUNA'],
    ['nothing from embedded Luna words or a full-size-only Codex catalog', [modelInfo('vendor/lunar'), modelInfo('vendor/lunatic'), modelInfo('x-lunafoo'), ...CODEX_CATALOG.filter((model) => !model.id.includes('luna'))], null],
    ['nothing from an empty list', [], null],
  ])('prefers %s', (_label, models, expected) => {
    expect(chooseNamingModel(models)?.id ?? null).toBe(expected);
    expect(chooseNamingModel([...models].reverse())?.id ?? null).toBe(expected);
  });
});

describe('chat title ownership migration (v27)', () => {
  it('appends at v27 and treats every existing conversation as manually titled', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      expect(MIGRATIONS[26]).toMatchObject({ version: 27, name: 'chat_session_title_ownership' });
      applyMigrations(db, MIGRATIONS.slice(0, 26));
      seedDocument(db, 'doc-old', 'hash-old');
      db.raw.prepare(`
        INSERT INTO chat_sessions (id, document_id, title, provider_id, model_id, document_hash)
        VALUES ('session-old', 'doc-old', 'Conversation 1', 'openrouter', 'model-x', 'hash-old')
      `).run();
      db.raw.prepare(`
        INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
        VALUES ('u', 'session-old', 'user', 0, 'Old question', 'complete'),
               ('a', 'session-old', 'assistant', 1, 'Old answer', 'complete')
      `).run();

      runMigrations(db);
      expect(titleRow(db, 'session-old')).toEqual({ title: 'Conversation 1', title_state: 'manual' });
      expect(new ChatTitleRepository(db).claim('session-old', 'claim', 100)).toBeNull();
      expect(() => db.raw.prepare("UPDATE chat_sessions SET title_state = 'bogus'").run()).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('conversation naming bounds', () => {
  it.each<[string, string | null]>([
    ['Leader Replication Basics', 'Leader Replication Basics'],
    ['  Title: "Raft  consensus explained."  ', 'Raft consensus explained'],
    ['**Quorum reads**', 'Quorum reads'],
    ['“Smart quotes”', 'Smart quotes'],
    ['', null],
    ['"..."', null],
    ['Two\nlines', null],
    ['Bidi ‮trick', null],
    ['x'.repeat(81), null],
  ])('sanitizes %j to %j', (raw, expected) => {
    expect(sanitizeGeneratedTitle(raw)).toBe(expected);
  });

  it('caps HTTP response tokens at the request cap, never above the model limit', () => {
    const request: ProviderChatRequest = {
      requestId: 'r', modelId: null, systemPrompt: '', contextXml: '', history: [], userMessage: '', sources: [], webSearch: false,
    };
    expect(responseTokenLimit(request, 4_096)).toBe(4_096);
    expect(responseTokenLimit({ ...request, maxResponseTokens: 64 }, 4_096)).toBe(64);
    expect(responseTokenLimit({ ...request, maxResponseTokens: 64 }, 32)).toBe(32);
    expect(responseTokenLimit({ ...request, maxResponseTokens: 0 }, 4_096)).toBe(4_096);
    expect(responseTokenLimit({ ...request, maxResponseTokens: 1.5 }, 4_096)).toBe(4_096);
  });

  it('defaults naming to Automatic, including for documents written before it, and keeps explicit choices', () => {
    expect(DEFAULT_APP_SETTINGS.ai.conversationNaming).toBe('auto');
    const legacyAi: Partial<typeof DEFAULT_APP_SETTINGS.ai> = { ...DEFAULT_APP_SETTINGS.ai };
    delete legacyAi.conversationNaming;
    expect(appSettingsSchema.parse({ ...DEFAULT_APP_SETTINGS, ai: legacyAi }).ai.conversationNaming).toBe('auto');
    const parse = (conversationNaming: { readonly providerId: string; readonly modelId: string } | string | null) =>
      appSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, ai: { ...DEFAULT_APP_SETTINGS.ai, conversationNaming } });
    expect(parse(EXPLICIT).data?.ai.conversationNaming).toEqual(EXPLICIT);
    expect(parse(null).data?.ai.conversationNaming).toBeNull();
    expect(parse({ providerId: 'fake', modelId: 'm' }).success).toBe(false);
    expect(parse('manual').success).toBe(false);
  });
});
