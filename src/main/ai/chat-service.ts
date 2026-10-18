import { randomUUID } from 'node:crypto';
import { IPC_EVENTS } from '@shared/constants/ipc';
import {
  CHAT_COMPACTION_INSTRUCTION,
  CHAT_COMPACTION_SYSTEM_PROMPT,
  CHAT_REPLAY_MAX_SOURCES,
  CHAT_RESPONSE_MAX_TEXT_UNITS,
} from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import { WorkAdmission } from '../app/work-admission';
import type { AppSettings } from '@shared/schemas/settings';
import type { OpenRouterCredentialStatus } from '@shared/schemas/credential-preview';
import type { SettingsRepository } from '../db/repositories/settings-repository';
import type {
  AIModelInfo,
  AIModelReasoning,
  AIProviderId,
  AIProviderStatus,
  ChatCitation,
  ChatContextAttachInput,
  ChatContextBudget,
  ChatContextDisclosure,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatWebSource,
  CitationTarget,
  CleanChatContextResult,
  ReasoningEffort,
  SendChatMessageResult,
} from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import type { Logger } from '../logging/logger';
import type { ChatRepository } from '../db/repositories/chat-repository';
import type { AIContextRepository } from './context-repository';
import type { AIProvider } from './providers/types';
import { OpenRouterProvider } from './providers/openrouter-provider';
import { splitToSafeChunks } from './providers/cli-ai-provider';
import { assertChatTurnIdentifiers, type ChatStreamEventBody, projectChatMessageForWire, projectChatStreamEventForWire } from './chat-wire-projection';
import { ChatContextBuilder } from './context-builder';
import { planCompaction } from './compaction-plan';
import { runBoundedCompaction } from './compaction-runner';
import type { StoreTitler } from './conversation-titling';
import { PackedRequestBudgets, packedRequestBudget } from './context-budget';
import { resolveEffectiveModel, type EffectiveModelDeps } from './effective-model';
import { effortForTurn, reasoningFor, requireOfferedEffort } from './reasoning-effort';
import { readStoredEffort } from '../db/repositories/chat-row-mappers';
import { deriveContext } from './attached-context';
import type { PortableValue } from '@shared/models/portable';
export type ChatEventOwner = {
  readonly id: number;
  readonly send: (channel: string, payload: PortableValue) => void;
  readonly isDestroyed: () => boolean;
  readonly onDestroyed: (listener: () => void) => () => void;
};

type ActiveRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly messageId: string;
  readonly owner: ChatEventOwner;
  readonly provider: AIProvider;
  readonly disclosures?: readonly ChatContextDisclosure[];
  /** Provider search metadata for the turn; never appended to `buffer`. */
  webSources: readonly ChatWebSource[] | undefined;
  buffer: string;
  finalized: boolean;
};

/** The session row main resolved for a send, as the repository returns it. */
type ActiveChatSessionRow = ReturnType<ChatRepository['requireActiveSession']>;

/** One compaction in flight; `abandoned` (set by shutdown) forbids its commit. */
type CleanRun = {
  readonly requestId: string;
  provider: AIProvider | null;
  abandoned: boolean;
};

function isProviderReady(status: AIProviderStatus): boolean {
  return (
    status.available &&
    (status.capabilities.toolFreeMode || status.id === 'codex') &&
    status.authentication === 'connected'
  );
}

export type ChatProviderGateway = {
  listStatuses(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIProviderStatus[]>;
  getStatus(
    providerId: AIProviderId,
    options?: { readonly forceRefresh?: boolean }
  ): Promise<AIProviderStatus>;
  resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo>;
  /** The reasoning levels main verified for a resolved model; `null` offers only Default. */
  modelReasoning?(providerId: AIProviderId, model: AIModelInfo): Promise<AIModelReasoning | null>;
  require(providerId: AIProviderId): AIProvider;
  testConnection(providerId: AIProviderId): Promise<{ readonly success: boolean; readonly message?: string }>;
  signInWithChatGPT?(): Promise<AIProviderStatus>;
  shutdown?(): Promise<void>;
  listOpenRouterModels?(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIModelInfo[]>;
  configureOpenRouter?(
    input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string },
    settings: SettingsRepository
  ): Promise<AppSettings>;
};

export class ChatService {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly builder: ChatContextBuilder;
  /** What the builder actually packed, per session, for the budget endpoint. */
  private readonly packedBudgets = new PackedRequestBudgets();
  /**
   * Compactions in flight, keyed by session.
   *
   * Membership is the session's clean lock and is claimed synchronously, so one
   * session can never have two compactions, and every mutation that would race
   * one is refused while it is held. The run carries what shutdown needs to
   * cancel the provider call and to stop a late result from committing.
   */
  private readonly cleaning = new Map<string, CleanRun>();
  /**
   * Operations that have decided to act on a session but have not finished
   * deciding, keyed by session with a count of how many are in flight.
   *
   * `sendMessage` and `updateSession` both await provider and model readiness
   * before they touch stored state; a compaction is refused for the whole of
   * that window, not just once the turn exists.
   */
  private readonly preparing = new Map<string, number>();
  /**
   * The tail of each session's binding work, keyed by session.
   *
   * Rebinding a conversation is not one step: readiness is probed and a model is
   * resolved — both of which call providers and take as long as the provider
   * takes — and only then is the row written. Two rebindings of the same session
   * therefore finish in whatever order their *probes* happen to finish in, which
   * is not the order the reader made the choices in, and the row can be left
   * carrying the older one. Queueing them here makes the stored binding follow
   * the order the requests arrived in, and a send joins the same queue so it
   * reads a settled row rather than one a rebinding is in the middle of writing.
   * Keyed per session, and dropped as soon as a session's queue drains.
   */
  private readonly bindingQueues = new Map<string, Promise<void>>();
  private isShuttingDown = false;
  /** Closed by an update restart; also counts session creations until they settle. */
  private readonly admission = new WorkAdmission();
  private shutdownPromise: Promise<void> | null = null;
  constructor(private readonly deps: {
    readonly chat: ChatRepository;
    readonly context: AIContextRepository;
    readonly providers: ChatProviderGateway;
    readonly requireDocumentOpen: (documentId: string) => void;
    readonly log: Logger;
    /** Resolves the persisted, non-secret OpenRouter model identifier from settings. */
    readonly resolveOpenRouterModelId: () => Promise<string | null>;
    readonly titles?: StoreTitler;
  }) {
    this.builder = new ChatContextBuilder(deps.context);
  }

  /** One binding resolver for the send path and every read that must match it. */
  private get binding(): EffectiveModelDeps {
    return {
      resolveModel: (providerId, modelId) => this.deps.providers.resolveModel(providerId, modelId),
      resolveOpenRouterModelId: this.deps.resolveOpenRouterModelId,
    };
  }

  listProviders(options?: { readonly forceRefresh?: boolean }) {
    return this.deps.providers.listStatuses(options);
  }

  getProviderStatus(providerId: AIProviderId, options?: { readonly forceRefresh?: boolean }) {
    return this.deps.providers.getStatus(providerId, options);
  }

  testProviderConnection(providerId: AIProviderId) {
    return this.deps.providers.testConnection(providerId);
  }

  signInWithChatGPT(): Promise<AIProviderStatus> {
    if (this.isShuttingDown) return Promise.reject(new InterleafError('internal', 'Application is shutting down.'));
    if (typeof this.deps.providers.signInWithChatGPT !== 'function') {
      return Promise.reject(new InterleafError('validation', 'ChatGPT sign-in is unavailable.'));
    }
    return this.deps.providers.signInWithChatGPT();
  }

  async listOpenRouterModels(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIModelInfo[]> {
    if (typeof this.deps.providers.listOpenRouterModels === 'function') {
      return this.deps.providers.listOpenRouterModels(options);
    }
    const provider = this.deps.providers.require('openrouter');
    if (provider instanceof OpenRouterProvider) {
      return provider.listCatalogModels(options);
    }
    return provider.listModels();
  }

  async configureOpenRouter(
    input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string },
    settings: SettingsRepository
  ): Promise<AppSettings> {
    if (typeof this.deps.providers.configureOpenRouter === 'function') {
      return this.deps.providers.configureOpenRouter(input, settings);
    }
    const provider = this.deps.providers.require('openrouter');
    if (provider instanceof OpenRouterProvider) {
      return provider.configure(input, settings);
    }
    throw new InterleafError('validation', 'OpenRouter provider is unavailable.');
  }

  /**
   * Immediate, main-owned removal of the stored OpenRouter credential.
   *
   * It deliberately goes through the provider rather than straight to the
   * vault: the provider serializes it against `configureOpenRouter`, so a
   * removal and a replacement cannot interleave on the vault document and
   * cannot report a result the store does not hold. The reply is the masked
   * status only — never a secret or ciphertext.
   */
  async clearOpenRouterCredential(): Promise<OpenRouterCredentialStatus> {
    const provider = this.deps.providers.require('openrouter');
    if (provider instanceof OpenRouterProvider) {
      return provider.clearCredential();
    }
    throw new InterleafError('validation', 'OpenRouter provider is unavailable.');
  }

  createSession(input: {
    readonly documentId: string;
    readonly title?: string;
    readonly providerId: AIProviderId;
    readonly modelId?: string | null;
    readonly reasoningEffort?: ReasoningEffort | null;
  }): Promise<ChatSession> {
    return this.admission.run(async () => {
      this.assertOpen();
      this.deps.requireDocumentOpen(input.documentId);
      const provider = this.deps.providers.require(input.providerId);
      assertProviderIdentity(input.providerId, provider.id);
      const status = await this.deps.providers.getStatus(input.providerId);
      assertProviderIdentity(input.providerId, status.id);
      if (!isProviderReady(status)) {
        throw new InterleafError(
          'validation',
          status.errorMessage ?? `${status.name} is not ready for Reader Chat. Check Settings to configure or authenticate.`
        );
      }
      const model = await this.deps.providers.resolveModel(input.providerId, input.modelId ?? null);
      await this.requireEffortOffered(input.providerId, model.id, input.reasoningEffort);
      return this.deps.chat.createSession({ ...input, modelId: model.id });
    });
  }

  /**
   * Detail hydration for the active document only. The document must be open
   * (matching every other session operation) and the session must belong to it;
   * a cross-document session ID resolves to `null` rather than leaking the row.
   */
  getSessionForDocument(sessionId: string, documentId: string): ChatSession | null {
    this.deps.requireDocumentOpen(documentId);
    return this.deps.chat.getSessionForDocument(sessionId, documentId);
  }

  listSessions(documentId: string): readonly ChatSession[] {
    this.deps.requireDocumentOpen(documentId);
    return this.deps.chat.listSessions(documentId);
  }

  async updateSession(input: {
    readonly sessionId: string;
    readonly title?: string;
    readonly providerId?: AIProviderId;
    readonly modelId?: string | null;
    readonly reasoningEffort?: ReasoningEffort | null;
  }): Promise<ChatSession> {
    this.assertOpen(true);
    const session = this.deps.chat.requireCurrentSession(input.sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    if ([...this.active.values()].some((request) => request.sessionId === input.sessionId)) {
      throw new InterleafError('validation', 'Stop the active response before changing this session.');
    }
    // Rebinding the provider or model mid-compaction would leave the stored
    // summary attributed to a binding that never wrote it.
    this.requireNoCleanInFlight(input.sessionId);
    // Held across the readiness awaits and the write itself, so a clean cannot
    // slip in between them and summarise against the old binding.
    const releaseReservation = this.reservePreparation(input.sessionId);
    try {
      // Queued behind any rebinding of this same conversation that is already
      // probing a provider: the row must end up carrying the choice that arrived
      // last, not the one whose probe happened to return first.
      return await this.runSerializedForSession(input.sessionId, () => this.writeSessionBinding(input));
    } finally {
      releaseReservation();
    }
  }

  /**
   * One rebinding, with the session re-read inside the queue.
   *
   * Re-read rather than captured: an update queued ahead of this one may have
   * already moved the conversation, and the readiness checks and the model
   * resolution below are about the binding this update is actually changing.
   */
  private async writeSessionBinding(input: {
    readonly sessionId: string;
    readonly title?: string;
    readonly providerId?: AIProviderId;
    readonly modelId?: string | null;
    readonly reasoningEffort?: ReasoningEffort | null;
  }): Promise<ChatSession> {
    const session = this.deps.chat.requireCurrentSession(input.sessionId);
    const targetProvider = input.providerId ?? session.providerId;
    if (input.providerId !== undefined && input.providerId !== session.providerId) {
      const provider = this.deps.providers.require(targetProvider);
      assertProviderIdentity(targetProvider, provider.id);
      const status = await this.deps.providers.getStatus(targetProvider);
      assertProviderIdentity(targetProvider, status.id);
      if (!isProviderReady(status)) {
        throw new InterleafError(
          'validation',
          status.errorMessage ?? `${status.name} is not ready for Reader Chat.`
        );
      }
    }
    let targetModelId = input.modelId;
    if (input.providerId !== undefined && input.providerId !== session.providerId && input.modelId === undefined) {
      const model = await this.deps.providers.resolveModel(targetProvider, null);
      targetModelId = model.id;
    } else if (targetModelId !== undefined) {
      const model = await this.deps.providers.resolveModel(targetProvider, targetModelId);
      targetModelId = model.id;
    }
    // Checked against the model this same write binds, so provider, model and
    // level land together or not at all.
    await this.requireEffortOffered(targetProvider, targetModelId ?? session.modelId, input.reasoningEffort);
    if (input.title !== undefined) this.deps.titles?.abandon(input.sessionId);
    return this.deps.chat.updateSession({
      sessionId: input.sessionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(targetModelId !== undefined ? { modelId: targetModelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    });
  }

  /** An explicit level must be one the effective model for this binding offers. */
  private async requireEffortOffered(
    providerId: AIProviderId,
    modelId: string | null,
    effort: ReasoningEffort | null | undefined
  ): Promise<void> {
    if (effort === null || effort === undefined) return;
    const model = await resolveEffectiveModel(this.binding, providerId, modelId);
    requireOfferedEffort(await reasoningFor(this.deps.providers, providerId, model), effort);
  }

  deleteSession(sessionId: string): void {
    this.assertOpen();
    const session = this.deps.chat.requireCurrentSession(sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    if ([...this.active.values()].some((request) => request.sessionId === sessionId)) {
      throw new InterleafError('validation', 'Stop the active response before deleting this session.');
    }
    this.requireNoCleanInFlight(sessionId);
    this.deps.titles?.abandon(sessionId);
    this.deps.chat.deleteSession(sessionId);
    this.packedBudgets.forget(sessionId);
  }

  listMessages(sessionId: string): readonly ChatMessage[] {
    const session = this.deps.chat.requireCurrentSession(sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    return this.deps.chat.listMessages(sessionId).map(projectChatMessageForWire);
  }

  listContext(sessionId: string): readonly ChatContextItem[] {
    const session = this.deps.chat.requireCurrentSession(sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    return this.deps.chat.listContext(sessionId);
  }

  /**
   * The budget of the last request this session packed under its current
   * provider and model. Main resolves that binding with the send path's own
   * resolver (a local lookup, never a provider request) and publishes the
   * builder's own figure; the renderer only formats it. Session and document
   * authorisation match every other session read.
   *
   * Packed records live in memory, so after a restart, a rebinding, or once a
   * session ages out of the bounded record, the figure is rebuilt from the
   * persisted conversation instead: the same builder packs the session's last
   * question against the history, context and summary it has now. `null`
   * remains the answer only while there is no question to pack, which is the
   * case before the first message and right after a context clean.
   */
  async getContextBudget(sessionId: string): Promise<ChatContextBudget | null> {
    const session = this.deps.chat.requireCurrentSession(sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    const model = await resolveEffectiveModel(this.binding, session.providerId, session.modelId);
    return this.packedBudgets.forBinding(session.id, session.providerId, model)
      ?? this.rebuiltBudget(session, model);
  }

  /** The last question in the persisted conversation, packed as it stands now. */
  private rebuiltBudget(session: ChatSession, model: AIModelInfo): ChatContextBudget | null {
    const replayable = this.deps.chat.listReplayableMessages(session.id);
    const lastQuestion = replayable.findLastIndex((message) => message.role === 'user');
    if (lastQuestion < 0) return null;
    try {
      const built = this.builder.build({
        session,
        model,
        question: replayable[lastQuestion]?.content ?? '',
        messages: replayable.slice(0, lastQuestion),
        contextItems: this.deps.chat.listContext(session.id),
        priorSources: this.deps.chat.listRecentTurnSources(session.id, CHAT_REPLAY_MAX_SOURCES),
        contextSummary: this.deps.chat.getCompactionState(session.id).summary,
      });
      return packedRequestBudget({ sessionId: session.id, providerId: session.providerId, model, built });
    } catch {
      // A conversation the builder cannot pack now (its index was rebuilt, or
      // the model shrank) has no honest figure to show.
      return null;
    }
  }

  attachContext(input: {
    readonly sessionId: string;
    readonly documentId: string;
    readonly documentHash: string;
    readonly input: ChatContextAttachInput;
  }): ChatContextItem {
    this.assertOpen();
    const session = this.deps.chat.requireActiveSession(input.sessionId);
    this.deps.requireDocumentOpen(session.document_id);
    // Attached context is part of what a running compaction clears, so it is not
    // added to or removed from underneath one.
    this.requireNoCleanInFlight(input.sessionId);
    if (
      session.document_id !== input.documentId ||
      session.document_hash !== input.documentHash
    ) {
      throw new InterleafError('validation', 'AI context does not match the active chat document revision.');
    }
    const documentInfo = this.deps.context.getDocument(input.documentId, input.documentHash);
    const derived = deriveContext(input.input, documentInfo.format, documentInfo.pageCount, (start, end) =>
      this.deps.context.listPdfPageRange(input.documentId, input.documentHash, start, end),
      (location) => this.deps.context.findClosestChunk(input.documentId, input.documentHash, location)
    );
    return this.deps.chat.createContext({
      sessionId: input.sessionId,
      documentId: input.documentId,
      documentHash: input.documentHash,
      ...derived,
    });
  }

  removeContext(sessionId: string, contextItemId: string): void {
    this.assertOpen();
    const session = this.deps.chat.requireActiveSession(sessionId);
    this.deps.requireDocumentOpen(session.document_id);
    this.requireNoCleanInFlight(sessionId);
    this.deps.chat.removeContext(sessionId, contextItemId);
  }

  async sendMessage(
    input: {
      readonly sessionId: string;
      readonly content: string;
      readonly currentLocation?: DocumentLocation | null;
      readonly webSearch?: boolean;
    },
    owner: ChatEventOwner
  ): Promise<SendChatMessageResult> {
    this.assertOpen(true);
    const session = this.deps.chat.requireActiveSession(input.sessionId);
    this.deps.requireDocumentOpen(session.document_id);
    // Refused in main, synchronously, before the first await: a turn accepted
    // while this conversation is being cleaned would change the transcript the
    // summary is being written from.
    this.requireNoCleanInFlight(input.sessionId);
    // And reserved for the whole of the preparation that follows, so a clean
    // arriving while readiness is being probed is refused before it calls a
    // provider. The turn is registered in `active` before this is released.
    const releaseReservation = this.reservePreparation(input.sessionId);
    try {
      // The binding is read from inside the session's own queue, so a rebinding
      // that has been accepted but not yet written cannot be stepped over: this
      // turn either precedes it entirely or is spawned from the row it wrote.
      // Only the read is queued — the turn itself runs outside it, so a running
      // answer does not hold up the next decision about this conversation.
      const settled = await this.runSerializedForSession(input.sessionId, () =>
        Promise.resolve(this.deps.chat.requireActiveSession(input.sessionId))
      );
      return await this.prepareTurn(input, owner, settled);
    } finally {
      releaseReservation();
    }
  }

  /**
   * The send path once the session is reserved: readiness, the packed request,
   * the persisted turn and the provider hand-off.
   *
   * Split out so the reservation covers every exit, including the readiness
   * refusals, without another level of nesting.
   */
  private async prepareTurn(
    input: {
      readonly sessionId: string;
      readonly content: string;
      readonly currentLocation?: DocumentLocation | null;
      readonly webSearch?: boolean;
    },
    owner: ChatEventOwner,
    session: ActiveChatSessionRow
  ): Promise<SendChatMessageResult> {
    const provider = this.deps.providers.require(session.provider_id);
    assertProviderIdentity(session.provider_id, provider.id);
    const status = await provider.detect();
    assertProviderIdentity(session.provider_id, status.id);
    if (!isProviderReady(status)) {
      throw new InterleafError(
        'validation',
        status.errorMessage ?? `${status.name} is not ready for Reader Chat.`
      );
    }
    // The renderer is untrusted, so the per-turn opt-in is re-checked here
    // against the capability the provider itself declares. A request for a
    // provider that does not host the search fails closed rather than
    // silently downgrading, so the answer never claims a search that the
    // request never asked for.
    const webSearch = input.webSearch === true;
    if (webSearch && !status.capabilities.hostedWebSearch) {
      throw new InterleafError(
        'validation',
        `${status.name} does not support web search for Reader Chat.`
      );
    }
    const model = await resolveEffectiveModel(this.binding, session.provider_id, session.model_id);
    // The level comes from the same settled row as the binding and is checked
    // against the model that will answer; one it no longer offers refuses the turn.
    const reasoningEffort = effortForTurn(
      await reasoningFor(this.deps.providers, session.provider_id, model),
      readStoredEffort(session.reasoning_effort)
    );
    // Only messages after the compaction boundary are eligible to be replayed;
    // everything before it is represented by the stored summary instead.
    const messages = this.deps.chat.listReplayableMessages(session.id);
    const compaction = this.deps.chat.getCompactionState(session.id);
    const contextItems = this.deps.chat.listContext(session.id);
    // What earlier accepted turns sent, for the builder to resend within its
    // own bounds. Read here rather than in the builder so the whole request is
    // composed from one main-owned view of the session.
    const priorSources = this.deps.chat.listRecentTurnSources(session.id, CHAT_REPLAY_MAX_SOURCES);
    const built = this.builder.build({
      session: this.deps.chat.requireCurrentSession(input.sessionId),
      model,
      question: input.content,
      messages,
      contextItems,
      priorSources,
      ...(input.currentLocation !== undefined ? { currentLocation: input.currentLocation } : {}),
      contextSummary: compaction.summary,
      webSearch,
    });
    // The indicator publishes this exact packing, never a re-derivation of it.
    this.packedBudgets.record(
      packedRequestBudget({ sessionId: session.id, providerId: session.provider_id, model, built })
    );
    const requestId = randomUUID();
    assertChatTurnIdentifiers({ requestId, sessionId: session.id, documentId: session.document_id });
    // Attached context is a standing statement about what this conversation is
    // about, not a one-shot payload: the chips survive the turn and every turn
    // after it, until the reader removes them or a successful Clean Context
    // clears them. Refusals above leave them exactly as the user left them too.
    const turn = this.deps.chat.beginTurn(
      session.id,
      requestId,
      input.content,
      built.sources,
      built.disclosures
    );
    const request: ActiveRequest = {
      requestId,
      sessionId: session.id,
      documentId: session.document_id,
      messageId: turn.assistantMessage.id,
      owner,
      provider,
      disclosures: built.disclosures,
      webSources: undefined,
      buffer: '',
      finalized: false,
    };
    this.active.set(requestId, request);

    setImmediate(() => {
      void this.runProvider(request, {
        requestId,
        modelId: model.id,
        systemPrompt: built.systemPrompt,
        contextXml: built.contextXml,
        history: built.history,
        userMessage: input.content,
        sources: built.sources,
        webSearch,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
    });

    return {
      requestId,
      userMessage: projectChatMessageForWire(turn.userMessage),
      assistantMessage: projectChatMessageForWire(turn.assistantMessage),
    };
  }

  /**
   * `Clean Context`: replaces the older part of this conversation with one
   * model-authored summary and drops every attached context item.
   *
   * The renderer supplies a session ID and nothing else. Main resolves the
   * session, its document, its provider and model, the transcript, the previous
   * summary and the attached context itself, so a compromised renderer cannot
   * choose what gets summarised, what model summarises it, or what the summary
   * says. Exactly one bounded provider call is made, and the summary, the
   * boundary it covers and the context removal are committed together or not at
   * all — a provider, cancellation or shutdown failure leaves all three as they
   * were. The transcript itself is never deleted.
   */
  async cleanContext(sessionId: string): Promise<CleanChatContextResult> {
    this.assertOpen(true);
    const session = this.deps.chat.requireActiveSession(sessionId);
    this.deps.requireDocumentOpen(session.document_id);
    if ([...this.active.values()].some((request) => request.sessionId === sessionId)) {
      throw new InterleafError(
        'validation',
        'Stop the active response before cleaning this conversation.'
      );
    }
    // The lock is claimed here, before the first await, so two requests that
    // arrive in the same tick cannot both get past this line and both call a
    // provider. Everything after it either commits or releases the lock.
    const run = this.claimCleanLock(sessionId);
    try {
      return await this.runCleanContext(sessionId, session.provider_id, session.model_id, run);
    } finally {
      if (this.cleaning.get(sessionId) === run) this.cleaning.delete(sessionId);
    }
  }

  /** One session, one compaction: synchronous, so concurrent requests cannot tie. */
  private claimCleanLock(sessionId: string): CleanRun {
    if (this.cleaning.has(sessionId)) {
      throw new InterleafError('validation', 'This conversation is already being cleaned.');
    }
    if ((this.preparing.get(sessionId) ?? 0) > 0) {
      throw new InterleafError(
        'validation',
        'This conversation is still finishing another change. Try cleaning it again in a moment.'
      );
    }
    const run: CleanRun = { requestId: randomUUID(), provider: null, abandoned: false };
    this.cleaning.set(sessionId, run);
    return run;
  }

  /**
   * Reserves a session for an operation that has to finish deciding before a
   * compaction may start, and returns its release.
   *
   * The clean lock alone was not enough: `sendMessage` and `updateSession` both
   * check it synchronously and then await provider and model readiness, so a
   * clean arriving inside that window found nothing held and went on to call a
   * provider against state the other operation was about to change. Claiming
   * this before the first await closes the window from both sides — the clean
   * refuses while an operation prepares, and the operation still refuses while a
   * clean is in flight. Every failure path releases it, and the hand-off is
   * synchronous: a send has already registered its request in `active`, and an
   * update has already written, by the time the release runs.
   */
  /**
   * Runs `task` after every binding operation already queued for this session,
   * and before every one queued after it.
   *
   * A failed task does not block the queue: the next one runs regardless, with
   * its own view of the stored row. Callers keep their own result and their own
   * error — nothing is shared between queued tasks but the order.
   */
  private runSerializedForSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.bindingQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.bindingQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.bindingQueues.get(sessionId) === tail) this.bindingQueues.delete(sessionId);
    });
    return result;
  }

  private reservePreparation(sessionId: string): () => void {
    this.preparing.set(sessionId, (this.preparing.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.preparing.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.preparing.set(sessionId, remaining);
      else this.preparing.delete(sessionId);
    };
  }

  /**
   * Refuses anything that would race a compaction on this session.
   *
   * Main owns the decision, not the renderer: sends, session rebinding and every
   * context mutation are the state a running compaction was planned against, so
   * they wait rather than changing it underneath the summary. Reads are
   * deliberately not covered — the transcript stays readable while it is cleaned.
   */
  private requireNoCleanInFlight(sessionId: string): void {
    if (this.cleaning.has(sessionId)) {
      throw new InterleafError(
        'validation',
        'This conversation is being cleaned. Wait for that to finish and try again.'
      );
    }
  }

  /**
   * The compaction itself, once the lock is held.
   *
   * Provider readiness is authoritative before anything is summarised, on the
   * same terms as a send. The plan is fitted to the session's own effective model
   * and refused before the call if it cannot fit. The state the plan was made
   * from is captured first and required again inside the commit, so a summary
   * written from an older transcript, or by a provider the session has since been
   * rebound away from, cannot overwrite newer state.
   */
  private async runCleanContext(
    sessionId: string,
    providerId: AIProviderId,
    sessionModelId: string | null,
    run: CleanRun
  ): Promise<CleanChatContextResult> {
    const provider = this.deps.providers.require(providerId);
    assertProviderIdentity(providerId, provider.id);
    run.provider = provider;
    const status = await provider.detect();
    assertProviderIdentity(providerId, status.id);
    if (!isProviderReady(status)) {
      throw new InterleafError(
        'validation',
        status.errorMessage ?? `${status.name} is not ready for Reader Chat.`
      );
    }
    const model = await resolveEffectiveModel(this.binding, providerId, sessionModelId);
    const plan = planCompaction({
      previousSummary: this.deps.chat.getCompactionState(sessionId).summary,
      messages: this.deps.chat.listReplayableMessages(sessionId),
      model,
    });
    const expectedRevision = this.deps.chat.compactionRevision(sessionId);

    const summary = await runBoundedCompaction({
      provider,
      log: this.deps.log,
      isAbandoned: () => run.abandoned || this.isShuttingDown,
      request: {
        requestId: run.requestId,
        modelId: model.id,
        systemPrompt: CHAT_COMPACTION_SYSTEM_PROMPT,
        // The transcript rides in the request's data block as the `<transcript>`
        // envelope the system prompt names, never in the prompt itself.
        contextXml: plan.transcriptXml,
        history: [],
        userMessage: CHAT_COMPACTION_INSTRUCTION,
        sources: [],
        webSearch: false,
      },
    });
    // A compaction that was cancelled or overtaken by shutdown must not land
    // afterwards, however far the provider had got.
    if (run.abandoned || this.isShuttingDown) {
      throw new InterleafError('internal', 'Interleaf could not clean this conversation. Nothing was changed.');
    }
    const applied = this.deps.chat.applyContextCompaction({
      sessionId,
      summary,
      compactedThroughOrdinal: plan.compactedThroughOrdinal,
      expectedRevision,
    });
    // The packed figure described a request built from context this session no
    // longer has, so it is dropped rather than left to describe the past.
    this.packedBudgets.forget(sessionId);
    return {
      sessionId,
      compactedThroughOrdinal: plan.compactedThroughOrdinal,
      summaryTextUnits: summary.length,
      clearedContextItemIds: [...applied.clearedContextItemIds],
    };
  }

  /** Abandons every compaction in flight and cancels the provider calls behind them. */
  private abandonCleanRuns(): readonly Promise<void>[] {
    const cancellations: Promise<void>[] = [];
    for (const run of this.cleaning.values()) {
      run.abandoned = true;
      if (run.provider) {
        cancellations.push(run.provider.cancel(run.requestId).catch(() => undefined));
      }
    }
    return cancellations;
  }

  cancel(requestId: string, ownerId: number): Promise<void> {
    const request = this.active.get(requestId);
    if (!request) return Promise.resolve();
    if (request.owner.id !== ownerId) {
      throw new InterleafError('sender-rejected', 'The chat request belongs to another renderer.');
    }
    this.active.delete(requestId);
    this.finalize(request, 'cancelled', null, null);
    void request.provider.cancel(requestId).catch(() => undefined);
    return Promise.resolve();
  }

  resolveCitation(sessionId: string, messageId: string, sourceId: string): CitationTarget | null {
    const session = this.deps.chat.requireCurrentSession(sessionId);
    this.deps.requireDocumentOpen(session.documentId);
    return this.deps.chat.resolveCitation(sessionId, messageId, sourceId);
  }

  cancelForDocument(documentId: string): Promise<void> {
    const requests = [...this.active.values()].filter((request) => request.documentId === documentId);
    for (const request of requests) {
      this.active.delete(request.requestId);
      this.finalize(request, 'cancelled', null, null);
      void request.provider.cancel(request.requestId).catch(() => undefined);
    }
    this.deps.titles?.abandonDocument(documentId);
    return Promise.resolve();
  }

  /** Responses, preparations, session creations and compactions still in flight. */
  liveWork(): number {
    return this.active.size + this.cleaning.size + this.preparing.size + this.admission.liveWork();
  }

  /** Closed before an update restart's renderer handshake: no new turn or clean starts. */
  closeAdmission(): void {
    this.admission.close();
  }

  private assertOpen(startsWork = false): void {
    if (this.isShuttingDown || (startsWork && this.admission.isClosed())) throw new InterleafError('internal', 'Application is shutting down.');
  }

  shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return this.shutdownPromise ?? Promise.resolve();
    }
    this.isShuttingDown = true;
    this.deps.titles?.shutdown();
    this.shutdownPromise = (async () => {
      const requests = [...this.active.values()];
      this.active.clear();
      for (const request of requests) {
        this.finalize(request, 'cancelled', null, null);
      }
      // Compactions are cancelled on the same terms as answers. They are not
      // waited on for their own sake: each one is already forbidden to commit.
      const cleanCancellations = this.abandonCleanRuns();
      await Promise.race([
        Promise.allSettled([
          ...requests.map((request) => request.provider.cancel(request.requestId)),
          ...cleanCancellations,
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
      ]);
      await this.deps.providers.shutdown?.();
    })();
    return this.shutdownPromise;
  }

  private async runProvider(
    request: ActiveRequest,
    providerRequest: Parameters<AIProvider['streamChat']>[0]
  ): Promise<void> {
    if (!this.active.has(request.requestId) || this.isShuttingDown) return;
    try {
      let totalTokens: number | null = null;
      for await (const event of request.provider.streamChat(providerRequest)) {
        if (!this.isRequestActive(request)) return;
        if (event.type === 'token') {
          if (request.buffer.length + event.token.length > CHAT_RESPONSE_MAX_TEXT_UNITS) {
            this.active.delete(request.requestId);
            void request.provider.cancel(request.requestId).catch(() => undefined);
            this.finalize(request, 'failed', null, 'AI response exceeded the safe output limit.');
            return;
          }
          request.buffer += event.token;
          const chunks = splitToSafeChunks(event.token);
          for (const chunk of chunks) {
            this.emit(request, { type: 'token', token: chunk });
          }
        } else {
          totalTokens = event.totalTokens ?? null;
          // Metadata only: it is stored beside the answer, never concatenated
          // into the buffer that becomes the message's model-authored content.
          request.webSources = event.webSources;
        }
      }
      if (this.isRequestActive(request)) {
        this.active.delete(request.requestId);
        this.finalize(request, 'complete', totalTokens, null);
      }
    } catch (error) {
      if (!this.isRequestActive(request)) return;
      this.active.delete(request.requestId);
      const message = error instanceof InterleafError
        ? error.message
        : 'The AI provider could not complete this response.';
      this.deps.log.error('AI provider request failed', {
        providerId: request.provider.id,
        requestId: request.requestId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.finalize(request, 'failed', null, message);
    }
  }

  private finalize(
    request: ActiveRequest,
    status: 'complete' | 'cancelled' | 'failed',
    tokenCount: number | null,
    errorMessage: string | null
  ): void {
    if (request.finalized) return;
    request.finalized = true;
    const citations = collectCitations(request.buffer, request.messageId, this.deps.chat);
    let message: ChatMessage;
    try {
      message = this.deps.chat.finalizeAssistant({
        messageId: request.messageId,
        requestId: request.requestId,
        content: request.buffer,
        citations,
        disclosures: request.disclosures,
        webSources: request.webSources,
        status,
        tokenCount,
        errorMessage,
      });
    } catch (error) {
      this.deps.log.error('Failed to finalize chat turn in database', {
        messageId: request.messageId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return;
    }

    if (status === 'failed') {
      this.emit(request, {
        type: 'error',
        error: new InterleafError('internal', errorMessage ?? 'AI provider failed.').toPayload(),
      });
    } else {
      this.emit(request, { type: 'done', message });
      if (status === 'complete') this.deps.titles?.afterExchange(request.sessionId, request.provider.id, request.owner);
    }
  }

  private emit(request: ActiveRequest, event: ChatStreamEventBody): void {
    if (request.owner.isDestroyed()) return;
    const { requestId, sessionId, documentId, messageId } = request;
    // Projected onto the wire contract the preload bridge enforces (chat-wire-projection.ts).
    request.owner.send(IPC_EVENTS.chatStreamEvent, projectChatStreamEventForWire({ requestId, sessionId, documentId, messageId }, event));
  }

  private isRequestActive(request: ActiveRequest): boolean {
    return this.active.get(request.requestId) === request && !this.isShuttingDown;
  }
}

function assertProviderIdentity(expected: AIProviderId, actual: AIProviderId): void {
  if (expected !== actual) {
    throw new InterleafError(
      'validation',
      'The selected AI provider could not be verified. Refresh provider status and try again.'
    );
  }
}

function collectCitations(
  text: string,
  messageId: string,
  chat: ChatRepository
): readonly ChatCitation[] {
  const citations: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]/gu)) {
    const sourceId = match[1];
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const target = chat.resolveCitationForMessage(messageId, sourceId);
    if (!target) continue;
    citations.push({
      sourceId,
      label: target.label,
      pageLabel: target.pageLabel,
      heading: target.heading,
    });
  }
  return citations;
}
