import { ZodError, type ZodType } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, IPC_EVENTS, type IpcChannel } from '@shared/constants/ipc';
import type { CloneableValue } from '@shared/models/portable';
import { describeError } from '@shared/models/caught-error';
import {
  ipcRequestSchemas,
  type IpcContracts,
  type IpcResultEnvelope,
  okEnvelope,
} from '@shared/schemas/ipc';
import {
  InterleafError,
  serializeInternalError,
  type SerializedInterleafError,
} from '@shared/errors/interleaf-error';
import type { DebugLogExportResult } from '@shared/schemas/ipc';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import { openExternalFromDocument } from '../app/open-external';
import { reconcileOnboardingLaunchState } from '../app/onboarding-launch-state';
import type { SettingsRepository } from '../db/repositories/settings-repository';
import type { LibraryService } from '../library/library-service';
import type { AnnotationRepository } from '../db/repositories/annotation-repository';
import type { SearchRepository } from '../db/repositories/search-repository';
import type { ChatService } from '../ai/chat-service';
import type { CredentialVault } from '../ai/credential-vault';
import { readOpenRouterCredentialStatus } from '../ai/openrouter-credential-status';
import type { Logger } from '../logging/logger';
import type { AgentService } from '../agents/agent-service';
import type { ClipboardService } from '../clipboard/clipboard-service';
import type { MermaidRenderService } from '../documents/mermaid/mermaid-render-service';
import { buildUpdateHandlers, type UpdateHandlerDeps } from './update-handlers';
import { isSenderAllowed, sanitizeSenderForLog, type SenderEvent, type SenderRule } from './sender-validation';
import {
  assertLibraryDocument,
  cancelChatRouted,
  closeDocumentRouted,
  isOpenFileDocument,
  openDocumentRouted,
  openFromDialog,
  openPending,
  servicesForDocument,
  servicesForSession,
  type OpenFilesRuntime,
} from '../open-files/open-file-routing';

/**
 * Contract-driven IPC dispatcher. One `handle()` registration per whitelisted
 * channel; every request passes through schema validation and sender check
 * before reaching domain repositories (AGENTS.md §2).
 */

export type AppInfoProviderResult = {
  readonly name: string;
  readonly tagline: string;
  readonly version: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly versions: {
    readonly electron: string;
    readonly node: string;
    readonly chrome: string;
  };
};

export type IpcDispatcherDeps = UpdateHandlerDeps & {
  readonly settings: SettingsRepository;
  /**
   * The guided-onboarding verdict main latched at startup. A getter rather than
   * a value so the dispatcher can never hold a copy taken before the latch, and
   * so the latch stays the single source of the answer.
   */
  readonly onboardingLaunchState: () => OnboardingLaunchState;
  readonly library: LibraryService;
  readonly annotations: AnnotationRepository;
  readonly search: SearchRepository;
  readonly chat: ChatService;
  readonly credentials: CredentialVault;
  readonly appInfo: () => AppInfoProviderResult;
  readonly senderRule: SenderRule;
  readonly log: Logger;
  readonly parentWindow: () => BrowserWindow | null;
  /** Main-owned native Save-dialog export; renderer supplies no destination. */
  readonly exportDebugLog: (parentWindow: BrowserWindow | null) => Promise<DebugLogExportResult>;
  /**
   * Hands one already-validated absolute http/https link to the desktop.
   * Production wires Electron's `shell.openExternal`; tests inject their own so
   * a suite never launches a browser.
   */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Native confirmation shown before an external link is opened, when the
   * reader has turned that preference on. Production always wires it so the
   * preference cannot silently degrade to opening links unconfirmed.
   */
  readonly confirmExternalLink: (url: string) => Promise<boolean>;
  /** Applies the saved diagnostic-logging preference to the main log sink. */
  readonly applyDiagnosticLogging: (enabled: boolean) => void;
  readonly agent: AgentService;
  /** Native confirmation for unsafe profile presets; production always wires
   * this callback so a renderer cannot silently enable a bypass. */
  readonly confirmUnsafeProfile: (profileId: string) => Promise<boolean>;
  readonly clipboard: Pick<ClipboardService, 'writeText'>;
  /** Draws fenced diagrams in a main-owned, terminable process. */
  readonly mermaid: Pick<MermaidRenderService, 'render'>;
  /**
   * Files opened without joining the library. Document- and session-scoped
   * requests are routed to the store main says owns them; anything no open
   * file owns goes to the library.
   */
  readonly openFiles: OpenFilesRuntime;
};

type ChannelHandler<K extends IpcChannel> = (
  request: IpcContracts[K]['parsed'],
  event: InvocationEvent
) => Promise<IpcContracts[K]['result']> | IpcContracts[K]['result'];

/**
 * The part of a renderer's web contents the dispatcher drives: who it is, how
 * to push one event to it, whether it is still there, and a single notice when
 * it goes away. Electron's `WebContents` answers this, so the real invoke event
 * passes unchanged and a test can describe the renderer it means.
 */
type InvocationSender = {
  readonly id: number;
  send(channel: string, payload: CloneableValue): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
};

type InvocationEvent = SenderEvent & {
  readonly sender?: InvocationSender;
};

const agentSenderSubscriptions = new WeakMap<object, () => void>();

/**
 * One agent event subscription per renderer sender, torn down when that
 * `webContents` is destroyed. Destruction is also what drives the main-owned
 * cancellation and owner release behind `agent:claim-session` (item C).
 */
function ensureAgentSubscription(deps: IpcDispatcherDeps, sender: NonNullable<InvocationEvent['sender']>): number {
  const ownerId = sender.id;
  if (!agentSenderSubscriptions.has(sender)) {
    const unsubscribe = deps.agent.subscribe(ownerId, (payload) => {
      if (!sender.isDestroyed()) sender.send(IPC_EVENTS.agentEvent, payload);
    });
    agentSenderSubscriptions.set(sender, unsubscribe);
    sender.once('destroyed', () => {
      unsubscribe();
      agentSenderSubscriptions.delete(sender);
      void deps.agent.cancelOwner(ownerId);
    });
  }
  return ownerId;
}

/** Runs `listener` once when the sender is destroyed (at once if it already is). */
function onSenderDestroyed(sender: InvocationSender, listener: () => void): () => void {
  if (sender.isDestroyed()) {
    listener();
    return () => undefined;
  }
  sender.once('destroyed', listener);
  return () => { sender.removeListener('destroyed', listener); };
}

function buildHandlers(deps: IpcDispatcherDeps): {
  [K in keyof IpcContracts]: ChannelHandler<K>;
} {
  return {
    'app:get-info': () => deps.appInfo(),
    'app:export-debug-log': () => deps.exportDebugLog(deps.parentWindow()),
    'app:open-external': (req) =>
      openExternalFromDocument(req, {
        openExternal: deps.openExternal,
        requireConfirmation: () => deps.settings.get().privacy.confirmExternalLinks,
        confirmExternalLink: deps.confirmExternalLink,
        log: deps.log,
      }),
    'settings:get': () => deps.settings.get(),
    'onboarding:get-launch-state': () =>
      // A reload is not a new launch: a decision the user has already made in
      // this process outranks the verdict latched when it started.
      reconcileOnboardingLaunchState(
        deps.onboardingLaunchState(),
        deps.settings.get().onboarding
      ),
    'settings:update': async (next) => {
      // One persist path, so every accepted update applies its runtime effects.
      const persist = () => {
        deps.agent.assertSettingsUpdateAllowed();
        const saved = deps.settings.update(next);
        deps.agent.applyProfileSettings(saved.agent.profiles);
        deps.applyDiagnosticLogging(saved.advanced.debugLogging);
        deps.updates.setAutomaticChecks(saved.updates.automaticChecks);
        return saved;
      };
      await deps.agent.validateSavedWorkingDirectorySettings(next);
      const unsafeProfile = Object.entries(next.agent.profiles).find(([, profile]) => profile.permissionMode === 'unsafe-yolo')?.[0];
      const storedUnsafe = unsafeProfile !== undefined && deps.settings.get().agent.profiles[unsafeProfile]?.permissionMode === 'unsafe-yolo';
      if (unsafeProfile !== undefined && !storedUnsafe) {
        return deps.confirmUnsafeProfile(unsafeProfile).then((confirmed) => {
          if (!confirmed) throw new InterleafError('validation', 'Unsafe profile changes were cancelled.');
          return persist();
        });
      }
      return persist();
    },

    // Phase 3 — Library & Folder Management
    'library:import-dropped-files': (req) => deps.library.importFiles(req.filePaths, req.options),
    'library:open-file-dialog': (req) =>
      deps.library.openFileDialog(req, deps.parentWindow()),
    'library:import-web-article': (req) => deps.library.importWebArticle(req.url, req.options),
    'library:list-documents': (filter) => deps.library.listDocuments(filter),
    'library:open-document': (req) => openDocumentRouted(deps, req.id),
    'library:close-document': async (req) => {
      await closeDocumentRouted(deps, req.id);
      return undefined;
    },
    'library:delete-document': async (req) => {
      await deps.chat.cancelForDocument(req.id);
      await deps.library.deleteDocument(req.id);
      return undefined;
    },
    'library:get-continue-reading': (req) => deps.library.getContinueReading(req?.limit),
    'library:get-recently-added': (req) => deps.library.getRecentlyAdded(req?.limit),
    'library:get-recently-read': (req) => deps.library.getRecentlyRead(req?.limit),
    'library:get-summary': () => deps.library.getSummary(),
    'library:create-folder': (req) => deps.library.createFolder(req.name, req.parentId),
    'library:rename-folder': (req) => deps.library.renameFolder(req.id, req.name),
    'library:delete-folder': (req) => {
      deps.library.deleteFolder(req.id);
      return undefined;
    },
    'library:list-folders': () => deps.library.listFolders(),
    'library:get-folder-tree': () => deps.library.getFolderTree(),
    'library:move-document-to-folder': (req) => {
      deps.library.moveDocumentToFolder(req.documentId, req.folderId);
      return undefined;
    },
    'library:update-reading-position': (req) => servicesForDocument(deps, req.documentId).library.updateReadingPosition(req.documentId, req.location, req.progress),
    'library:get-document-preview': (req) => servicesForDocument(deps, req.documentId).library.getDocumentPreview(req.documentId, req.location),
    'files:open-dialog': () => openFromDialog(deps),
    'files:open-pending': () => openPending(deps),

    // Phase 5 — Annotations & Highlights
    'annotations:create': (req) => servicesForDocument(deps, req.documentId).annotations.create(req),
    'annotations:list': (req) => servicesForDocument(deps, req.documentId).annotations.list(req.documentId, req.filter),
    'annotations:page': (req) => servicesForDocument(deps, req.documentId).annotations.page(req.documentId, req.filter),
    'annotations:update': (req) => servicesForDocument(deps, req.documentId).annotations.update(req),
    'annotations:delete': (req) => servicesForDocument(deps, req.documentId).annotations.delete(req.documentId, req.id),
    'annotations:repair-anchor': (req) => servicesForDocument(deps, req.documentId).annotations.repairAnchor(req),
    'search:begin-index': (req) => {
      const services = servicesForDocument(deps, req.documentId);
      services.library.requireDocumentOpen(req.documentId);
      return services.search.begin(req.documentId, req.documentHash);
    },
    'search:append-index': (req) => {
      const services = servicesForDocument(deps, req.documentId);
      services.library.requireDocumentOpen(req.documentId);
      return services.search.append(req.documentId, req.documentHash, req.generationId, req.chunks);
    },
    'search:complete-index': (req) => {
      const services = servicesForDocument(deps, req.documentId);
      services.library.requireDocumentOpen(req.documentId);
      return services.search.complete(req.documentId, req.documentHash, req.generationId);
    },
    'search:fail-index': (req) => servicesForDocument(deps, req.documentId).search.fail(req.documentId, req.documentHash, req.generationId, req.errorMessage),
    'search:get-index-state': (req) => servicesForDocument(deps, req.documentId).search.getState(req.documentId),
    'search:document': (req) => servicesForDocument(deps, req.documentId).search.search(req.documentId, req.query, req.limit),
    'search:resolve-hit': (req) => servicesForDocument(deps, req.documentId).search.resolveHit(req.documentId, req.documentHash, req.chunkId, req.query),
    'ai:list-providers': (req) => deps.chat.listProviders(req),
    'ai:get-provider-status': (req) => deps.chat.getProviderStatus(
      req.providerId,
      req.forceRefresh === true ? { forceRefresh: true } : undefined,
    ),
    'ai:sign-in-with-chatgpt': () => deps.chat.signInWithChatGPT(),
    'ai:list-openrouter-models': (req) => deps.chat.listOpenRouterModels(req),
    'ai:configure-openrouter': (req) => deps.chat.configureOpenRouter(req, deps.settings),
    'credentials:get-status': () => readOpenRouterCredentialStatus(deps.credentials),
    // Removal goes through the provider so it is serialized against
    // `ai:configure-openrouter`; a same-tick or hostile renderer cannot
    // interleave a deletion with a replacement on the vault document.
    'credentials:clear': () => deps.chat.clearOpenRouterCredential(),
    'credentials:test': (req) => deps.chat.testProviderConnection(req.providerId),
    'chat:create-session': (req) => servicesForDocument(deps, req.documentId).chat.createSession(req),
    'chat:get-session': (req) => servicesForDocument(deps, req.documentId).chat.getSessionForDocument(req.sessionId, req.documentId),
    'chat:list-sessions': (req) => servicesForDocument(deps, req.documentId).chat.listSessions(req.documentId),
    'chat:update-session': (req) => servicesForSession(deps, req.sessionId).chat.updateSession(req),
    'chat:delete-session': (req) => {
      servicesForSession(deps, req.sessionId).chat.deleteSession(req.sessionId);
      return undefined;
    },
    'chat:list-messages': (req) => servicesForSession(deps, req.sessionId).chat.listMessages(req.sessionId),
    'chat:list-context': (req) => servicesForSession(deps, req.sessionId).chat.listContext(req.sessionId),
    'chat:get-context-budget': (req) => servicesForSession(deps, req.sessionId).chat.getContextBudget(req.sessionId),
    'chat:attach-context': (req) => servicesForSession(deps, req.sessionId).chat.attachContext(req),
    'chat:remove-context': (req) => {
      servicesForSession(deps, req.sessionId).chat.removeContext(req.sessionId, req.contextItemId);
      return undefined;
    },
    // The request carries the session and nothing else; main resolves the
    // provider, model, transcript, prior summary and attached context itself.
    'chat:clean-context': (req) => servicesForSession(deps, req.sessionId).chat.cleanContext(req.sessionId),
    'chat:send-message': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Chat streaming requires a live renderer sender.');
      return servicesForSession(deps, req.sessionId).chat.sendMessage(req, {
        id: sender.id,
        send: (channel, payload) => { sender.send(channel, payload); },
        isDestroyed: () => sender.isDestroyed(),
        onDestroyed: (listener) => onSenderDestroyed(sender, listener),
      });
    },
    'chat:cancel': async (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Chat cancellation requires a live renderer sender.');
      await cancelChatRouted(deps, req.requestId, sender.id);
      return undefined;
    },
    'chat:resolve-citation': (req) =>
      servicesForSession(deps, req.sessionId).chat.resolveCitation(req.sessionId, req.messageId, req.sourceId),
    'agent:list-profiles': () => deps.agent.listDiscoveredProfiles(),
    'agent:list-profile-status': () => deps.agent.listProfileStatuses(),
    'agent:refresh-models': () => deps.agent.refreshDiscoveredModels(),
    'agent:list-working-directories': () => deps.agent.listWorkingDirectories(),
    'agent:select-working-directory': () => deps.agent.selectWorkingDirectory(),
    'agent:start-session': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Agent streaming requires a live renderer sender.');
      assertLibraryDocument(deps, req.documentId);
      return deps.agent.startSession(req, ensureAgentSubscription(deps, sender));
    },
    'agent:resume-session': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Agent streaming requires a live renderer sender.');
      return deps.agent.resumeSession(req, ensureAgentSubscription(deps, sender));
    },
    'agent:stop-session': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Agent cancellation requires a live renderer sender.');
      return deps.agent.stopSession(req.sessionId, sender.id).then(() => undefined);
    },
    'agent:get-session': (req) => isOpenFileDocument(deps, req.documentId) ? null : deps.agent.getSessionForDocument(req.sessionId, req.documentId),
    'agent:list-sessions': (req) => isOpenFileDocument(deps, req.documentId) ? [] : deps.agent.listSessions(req.documentId),
    'agent:copy-result': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Clipboard copy requires a live renderer sender.');
      return deps.agent.copyResult(req.sessionId, sender.id);
    },
    // Item C: the replacement window takes over a destroyed owner's session
    // explicitly, and subscribes to its events as part of the same handoff.
    'agent:claim-session': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Claiming an agent session requires a live renderer sender.');
      return deps.agent.claimSession(req.sessionId, ensureAgentSubscription(deps, sender));
    },
    'agent:issue-risk-grant': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Risk confirmation requires a live renderer sender.');
      return deps.agent.issueRiskGrant(req, sender.id);
    },
    'agent:get-environment-review': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Reading an agent review requires a live renderer sender.');
      return deps.agent.getEnvironmentReview(req.sessionId, sender.id);
    },
    'agent:apply-changes': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Applying changes requires a live renderer sender.');
      return deps.agent.applyChanges(req.sessionId, sender.id);
    },
    'agent:discard-sandbox': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Discarding a sandbox requires a live renderer sender.');
      return deps.agent.discardSandbox(req.sessionId, sender.id).then(() => undefined);
    },
    'agent:export-patch': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Exporting a patch requires a live renderer sender.');
      return deps.agent.exportPatch(req.sessionId, sender.id);
    },
    'agent:open-folder': (req, event) => {
      const sender = event.sender;
      if (!sender) throw new InterleafError('sender-rejected', 'Opening an agent folder requires a live renderer sender.');
      return deps.agent.openFolder(req.sessionId, sender.id);
    },
    'agent:get-mode-availability': (req) => deps.agent.listModeAvailability(req.profileId),
    'agent:select-executable': () => deps.agent.selectExecutable(),
    'agent:list-custom-profiles': () => deps.agent.listCustomProfiles(),
    'agent:create-custom-profile': (req) => deps.agent.createCustomProfile(req),
    'agent:update-custom-profile': (req) => deps.agent.updateCustomProfile(req),
    'agent:delete-custom-profile': (req) => {
      deps.agent.deleteCustomProfile(req.id);
      return undefined;
    },
    'reader:render-mermaid': (req) => deps.mermaid.render(req),
    'clipboard:write-text': (req) => deps.clipboard.writeText(req.text),
    ...buildUpdateHandlers(deps),
  };
}

export function registerIpcHandlers(
  ipcMain: Pick<IpcMainLike, 'handle'>,
  deps: IpcDispatcherDeps
): void {
  const handlers = buildHandlers(deps);

  for (const channel of IPC_CHANNELS) {
    const handler = handlers[channel];
    ipcMain.handle(channel, async (event, payload: CloneableValue) =>
      invokeChannel(channel, handler as ChannelHandler<typeof channel>, payload, event, deps)
    );
  }
}

export async function invokeChannel<K extends IpcChannel>(
  channel: K,
  handler: ChannelHandler<K>,
  payload: CloneableValue,
  event: InvocationEvent,
  deps: Pick<IpcDispatcherDeps, 'senderRule' | 'log'>
): Promise<IpcResultEnvelope<IpcContracts[K]['result']>> {
  if (!isSenderAllowed(event, deps.senderRule)) {
    deps.log.warn('Rejected message from unauthorized sender', {
      channel,
      sender: sanitizeSenderForLog(event.senderFrame?.url),
    });
    return envelopeError(
      new InterleafError(
        'sender-rejected',
        'IPC sender origin does not match the configured application origin.'
      ).toPayload()
    );
  }

  try {
    const parsedRequest = parseRequest<K>(
      channel,
      ipcRequestSchemas[channel],
      payload
    );
    const result = await handler(parsedRequest, event);
    return okEnvelope(result);
  } catch (error) {
    return envelopeError(toErrorPayload(error instanceof Error ? error : null, deps.log, channel));
  }
}

/**
 * Validates a channel payload and returns that channel schema's output.
 *
 * `IpcContracts[K]['parsed']` is derived from `ipcRequestSchemas[K]`, but a
 * generic index into that map cannot carry the correlation through `safeParse`.
 * The assertions below restate it only after the channel's registration has
 * accepted the payload (or, for a schemaless channel, confirmed there is none);
 * an unvalidated payload never reaches them.
 */
function parseRequest<K extends IpcChannel>(
  channel: K,
  schema: ZodType | undefined,
  payload: CloneableValue
): IpcContracts[K]['parsed'] {
  if (schema === undefined) {
    if (payload !== undefined) {
      throw new InterleafError(
        'validation',
        `Channel ${channel} does not accept a payload.`
      );
    }
    return undefined as IpcContracts[K]['parsed'];
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data as IpcContracts[K]['parsed'];
}

function toErrorPayload(
  error: Error | null,
  log: Logger,
  channel: IpcChannel
): SerializedInterleafError {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const location = first ? first.path.join('.') || '(root)' : '';
    const description = first ? `${location}: ${first.message}` : 'Invalid request payload.';
    return new InterleafError('validation', `IPC validation failed — ${description}`).toPayload();
  }

  if (error instanceof InterleafError && error.code !== 'internal') {
    return error.toPayload();
  }

  const diagnosticId = randomUUID();
  log.error('IPC handler failed', {
    channel,
    diagnosticId,
    errorType: describeError(error).name,
    ...(error instanceof InterleafError ? { errorCode: error.code } : {}),
  });
  return serializeInternalError(diagnosticId);
}
function envelopeError(error: SerializedInterleafError): IpcResultEnvelope<never> {
  return { ok: false, error };
}

/** Structural subset of Electron's IpcMain used by the dispatcher. Exported so
 * a test can register the same listeners the real `ipcMain` would receive. */
export type IpcMainLike = {
  handle(
    channel: string,
    listener: (
      event: InvocationEvent,
      ...args: readonly CloneableValue[]
    ) => Promise<IpcResultEnvelope<IpcContracts[IpcChannel]['result']>>
  ): void;
};
