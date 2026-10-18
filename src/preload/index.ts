import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { z } from 'zod';
import { IPC, IPC_EVENTS, type IpcChannel } from '@shared/constants/ipc';
import type { IpcContracts, IpcResultEnvelope } from '@shared/schemas/ipc';
import { openRouterCredentialStatusSchema } from '@shared/schemas/credential-preview';
import type {
  ImportFileError,
  StorageHealthUpdate,
} from '@shared/types/document';
import { InterleafError, interleafErrorFromPayload } from '@shared/errors/interleaf-error';
import { openExternalResultSchema, parseExternalHttpUrl } from '@shared/schemas/external-link';
import { hasOnlyKeys, isPlainRecord } from './guards';
import { isAgentEvent, isChatSessionTitleChanged, isChatStreamEvent } from './wire-guards';
import { createFilesBridge } from './files-bridge';
import { createUpdatesBridge } from './updates-bridge';
import {
  aiProviderIdSchema,
  aiProviderStatusListSchema,
  aiProviderStatusSchema,
  chatContextBudgetReplySchema,
  chatSessionListReplySchema,
  chatSessionReplySchema,
  chatSessionSchema,
  cleanChatContextReplySchema,
} from '@shared/schemas/ai';
import { webArticleMediaSummarySchema } from '@shared/schemas/document';
import { agentProfileStatusSnapshotSchema } from '@shared/schemas/agent';
import { onboardingLaunchStateSchema } from '@shared/schemas/onboarding';
import type { InterleafAPI } from '@shared/types/api';
import type {
  AIProviderId,
} from '@shared/types/ai';
import type {
  AgentEvent,
} from '@shared/types/agent';
import { mermaidRenderResultSchema } from '@shared/schemas/mermaid';
import type { CloneableValue } from '@shared/models/portable';

/**
 * Narrow preload bridge (ADR-0001). Exposes exactly the whitelisted domain
 * operations on `window.interleafAPI` — no raw `ipcRenderer`, no Node
 * primitives, no dynamic channels. Compile-time types improve callers, while
 * the main process performs the authoritative runtime validation.
 */
export { isAgentEvent, isChatCitation, isChatMessage, isChatSessionTitleChanged, isChatStreamEvent } from './wire-guards';

export type PreloadIpc = {
  invoke(channel: string, ...args: readonly CloneableValue[]): Promise<CloneableValue>;
  on(channel: string, listener: (event: Electron.IpcRendererEvent, payload: CloneableValue) => void): void;
  removeListener(channel: string, listener: (event: Electron.IpcRendererEvent, payload: CloneableValue) => void): void;
  send(channel: string, ...args: readonly CloneableValue[]): void;
};

type IpcRequest = IpcContracts[IpcChannel]['request'];
type ChannelRequest<K extends IpcChannel> = IpcContracts[K]['request'];
type ChannelResult<K extends IpcChannel> = IpcContracts[K]['result'];
/** A channel's payload argument, omissible when the channel accepts none. */
type InvokeArgs<K extends IpcChannel> = undefined extends ChannelRequest<K>
  ? [payload?: ChannelRequest<K>]
  : [payload: ChannelRequest<K>];
export type PreloadInvoke = <K extends IpcChannel>(channel: K, ...args: InvokeArgs<K>) => Promise<ChannelResult<K>>;

export type PreloadWebUtils = {
  getPathForFile(file: File): string;
};

export function isStorageHealthUpdate(value: CloneableValue): value is StorageHealthUpdate {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['documentId', 'storageHealth', 'storageHealthMessage'])) {
    return false;
  }
  try {
    if (JSON.stringify(value).length > 2048) {
      return false;
    }
  } catch {
    return false;
  }
  if (!('documentId' in value) || typeof value.documentId !== 'string' || value.documentId.length === 0 || value.documentId.length > 128) {
    return false;
  }
  if (!('storageHealth' in value)) {
    return false;
  }
  const storageHealth = value.storageHealth;
  if (
    storageHealth !== 'ok' &&
    storageHealth !== 'missing' &&
    storageHealth !== 'changed' &&
    storageHealth !== 'checking'
  ) {
    return false;
  }
  if ('storageHealthMessage' in value && value.storageHealthMessage !== undefined) {
    if (typeof value.storageHealthMessage !== 'string' || value.storageHealthMessage.length > 1024) {
      return false;
    }
  }
  return true;
}

/**
 * The test-only `fake` provider exists in the shared type but not on the wire;
 * it is refused here with the error main's validation would have returned.
 */
function ipcProviderId(providerId: AIProviderId): z.output<typeof aiProviderIdSchema> {
  const parsed = aiProviderIdSchema.safeParse(providerId);
  if (!parsed.success) throw new InterleafError('validation', 'The AI provider is not supported.');
  return parsed.data;
}

function isUuidV4(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

export function createInterleafApi(
  ipc: PreloadIpc = ipcRenderer,
  utils: PreloadWebUtils = webUtils
): InterleafAPI {
  async function invokeEnvelope(channel: IpcChannel, payload: IpcRequest): Promise<CloneableValue> {
    const envelope = (await ipc.invoke(channel, payload)) as IpcResultEnvelope<CloneableValue>;
    if (!envelope.ok) {
      throw interleafErrorFromPayload(envelope.error);
    }
    return envelope.data;
  }
  // Main validates every request and answers with the channel's contract result.
  const invoke: PreloadInvoke = async (channel, ...args) =>
    (await invokeEnvelope(channel, args[0])) as ChannelResult<typeof channel>;

  const INVALID_SESSION = 'The chat session response was invalid.';

  async function invokeValidated<K extends IpcChannel, T>(
    channel: K,
    payload: IpcContracts[K]['request'],
    schema: z.ZodType<T>,
    invalidMessage = 'The AI provider returned an invalid status response.'
  ): Promise<T> {
    const value = await invokeEnvelope(channel, payload);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new InterleafError('internal', invalidMessage);
    }
    return parsed.data;
  }

  return {
  app: {
    getInfo: () => invoke(IPC.appGetInfo),
    exportDebugLog: () => invoke(IPC.appExportDebugLog),
    /**
     * The bridge only forwards a link main would accept anyway. Rejecting the
     * rest here spares a round trip and keeps the failure typed on the renderer
     * side; it is not the security decision, which main makes on receipt.
     */
    openExternal: async (url) => {
      const canonical = parseExternalHttpUrl(url);
      if (canonical === null) {
        throw new InterleafError('validation', 'Only absolute http and https links can be opened.');
      }
      return invokeValidated(
        IPC.appOpenExternal,
        { url: canonical },
        openExternalResultSchema,
        'The external link response was invalid.'
      );
    },
    onBeforeClose: (callback) => {
      const handleCloseRequest = async (payload: CloneableValue): Promise<void> => {
        if (
          !isPlainRecord(payload) ||
          !hasOnlyKeys(payload, ['requestId']) ||
          typeof payload.requestId !== 'string' ||
          !isUuidV4(payload.requestId)
        ) {
          return;
        }
        try {
          if (JSON.stringify(payload).length > 256) return;
        } catch {
          return;
        }
        try {
          await callback();
        } finally {
          ipc.send(IPC_EVENTS.appCloseReady, { requestId: payload.requestId });
        }
      };
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        void handleCloseRequest(payload);
      };
      ipc.on(IPC_EVENTS.appBeforeClose, listener);
      return () => {
        ipc.removeListener(IPC_EVENTS.appBeforeClose, listener);
      };
    },
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (next) => invoke(IPC.settingsUpdate, next),
  },
  onboarding: {
    getLaunchState: () =>
      invokeValidated(
        IPC.onboardingGetLaunchState,
        undefined,
        onboardingLaunchStateSchema,
        'The onboarding launch state response was invalid.'
      ),
  },
  library: {
    importDroppedFiles: (files, options) => {
      const filePaths: string[] = [];
      const failed: ImportFileError[] = [];
      for (const file of files) {
        try {
          const p = utils.getPathForFile(file);
          if (p && p.length > 0) {
            filePaths.push(p);
          } else {
            failed.push({ fileName: file.name, error: 'Could not resolve path for file' });
          }
        } catch {
          failed.push({ fileName: file.name, error: 'Failed to access dropped file path' });
        }
      }
      if (filePaths.length === 0) {
        return Promise.resolve({
          imported: [],
          failed: failed.length > 0 ? failed : [{ fileName: 'drop', error: 'No valid files received' }],
          totalAttempted: files.length,
        });
      }
      return invoke(IPC.libraryImportDroppedFiles, { filePaths, ...(options !== undefined ? { options } : {}) }).then((res) => {
        if (failed.length > 0) {
          return {
            imported: res.imported,
            failed: [...res.failed, ...failed],
            totalAttempted: res.totalAttempted + failed.length,
          };
        }
        return res;
      });
    },
    /**
     * The completeness summary is re-checked here rather than trusted.
     *
     * It is the one part of an import result the renderer turns into prose, so
     * the bridge admits only two bounded counts and forwards nothing else — a
     * summary carrying a URL, a host, or a failure reason is dropped at this
     * line and becomes `null`, which the UI reports as an unknown count rather
     * than as zero. Discarding the whole result would throw away a completed
     * import over a cosmetic field, so the document always survives.
     */
    importWebArticle: async (url, options) => {
      const result = await invoke(IPC.libraryImportWebArticle, {
        url,
        ...(options !== undefined ? { options } : {}),
      });
      const media = webArticleMediaSummarySchema.safeParse(result.media);
      return {
        document: result.document,
        alreadyInLibrary: result.alreadyInLibrary,
        media: media.success ? media.data : null,
      };
    },
    openFileDialog: (options) => invoke(IPC.libraryOpenFileDialog, options),
    listDocuments: (filter) => invoke(IPC.libraryListDocuments, filter),
    openDocument: (id) => invoke(IPC.libraryOpenDocument, { id }),
    closeDocument: (id) => invoke(IPC.libraryCloseDocument, { id }),
    deleteDocument: (id) => invoke(IPC.libraryDeleteDocument, { id }),
    getContinueReading: (limit) =>
      invoke(IPC.libraryGetContinueReading, limit !== undefined ? { limit } : undefined),
    getRecentlyAdded: (limit) =>
      invoke(IPC.libraryGetRecentlyAdded, limit !== undefined ? { limit } : undefined),
    getRecentlyRead: (limit) =>
      invoke(IPC.libraryGetRecentlyRead, limit !== undefined ? { limit } : undefined),
    getSummary: () => invoke(IPC.libraryGetSummary),
    createFolder: (name, parentId) =>
      invoke(IPC.libraryCreateFolder, { name, parentId }),
    renameFolder: (id, name) =>
      invoke(IPC.libraryRenameFolder, { id, name }),
    deleteFolder: (id) => invoke(IPC.libraryDeleteFolder, { id }),
    listFolders: () => invoke(IPC.libraryListFolders),
    getFolderTree: () => invoke(IPC.libraryGetFolderTree),
    moveDocumentToFolder: (documentId, folderId) =>
      invoke(IPC.libraryMoveDocumentToFolder, { documentId, folderId }),
    updateReadingPosition: (documentId, location, progress) =>
      invoke(IPC.libraryUpdateReadingPosition, { documentId, location, progress }),
    getDocumentPreview: (documentId, location) =>
      invoke(IPC.libraryGetDocumentPreview, { documentId, location }),
    onStorageHealthUpdated: (callback: (update: StorageHealthUpdate) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, update: CloneableValue) => {
        if (isStorageHealthUpdate(update)) {
          const message =
            'storageHealthMessage' in update && typeof update.storageHealthMessage === 'string'
              ? update.storageHealthMessage
              : undefined;
          callback({
            documentId: update.documentId,
            storageHealth: update.storageHealth,
            ...(message !== undefined ? { storageHealthMessage: message } : {}),
          });
        }
      };
      ipc.on(IPC_EVENTS.libraryStorageHealthUpdated, listener);
      return () => {
        ipc.removeListener(IPC_EVENTS.libraryStorageHealthUpdated, listener);
      };
    },
  },
  files: createFilesBridge(invoke, ipc),
  reader: {
    /**
     * The result is re-parsed here as well as in main. The reader inserts a
     * diagram into a live document, so a reply that does not match the contract
     * must fail at the bridge rather than reach the page as an untyped value.
     */
    renderMermaid: (request) =>
      invokeValidated(
        IPC.readerRenderMermaid,
        request,
        mermaidRenderResultSchema,
        'The diagram renderer returned an invalid response.'
      ),
  },
  annotations: {
    create: (input) => invoke(IPC.annotationsCreate, input),
    list: (documentId, filter) =>
      invoke(IPC.annotationsList, { documentId, ...(filter !== undefined ? { filter } : {}) }),
    page: (documentId, filter) =>
      invoke(IPC.annotationsPage, { documentId, ...(filter !== undefined ? { filter } : {}) }),
    update: (input) => invoke(IPC.annotationsUpdate, input),
    delete: (documentId, id) =>
      invoke(IPC.annotationsDelete, { documentId, id }),
    repairAnchor: (input) =>
      invoke(IPC.annotationsRepairAnchor, input),
  },
  search: {
    beginIndex: (documentId, documentHash) =>
      invoke(IPC.searchBeginIndex, { documentId, documentHash }),
    appendIndex: (documentId, documentHash, generationId, chunks) =>
      invoke(IPC.searchAppendIndex, { documentId, documentHash, generationId, chunks: [...chunks] }),
    completeIndex: (documentId, documentHash, generationId) =>
      invoke(IPC.searchCompleteIndex, { documentId, documentHash, generationId }),
    failIndex: (documentId, documentHash, generationId, errorMessage) =>
      invoke(IPC.searchFailIndex, { documentId, documentHash, generationId, errorMessage }),
    getIndexState: (documentId) =>
      invoke(IPC.searchGetIndexState, { documentId }),
    searchDocument: (documentId, query, limit) =>
      invoke(IPC.searchDocument, { documentId, query, ...(limit ? { limit } : {}) }),
    resolveHit: (documentId, documentHash, chunkId, query) =>
      invoke(IPC.searchResolveHit, { documentId, documentHash, chunkId, query }),
  },
  ai: {
    listProviders: (options) => invokeValidated(
      IPC.aiListProviders,
      options?.forceRefresh === true ? { forceRefresh: true } : undefined,
      aiProviderStatusListSchema
    ),
    getProviderStatus: (providerId, options) =>
      invokeValidated(
        IPC.aiGetProviderStatus,
        { providerId: ipcProviderId(providerId), ...(options?.forceRefresh === true ? { forceRefresh: true } : {}) },
        aiProviderStatusSchema
      ),
    signInWithChatGPT: () => invokeValidated(IPC.aiSignInWithChatGPT, undefined, aiProviderStatusSchema),
    listOpenRouterModels: (options) =>
      invoke(IPC.aiListOpenRouterModels, options),
    configureOpenRouter: (input) =>
      invoke(IPC.aiConfigureOpenRouter, input),
  },
  credentials: {
    // A credential status is validated in full before it reaches the renderer:
    // an unparsable, inconsistent or padded payload fails closed as an error
    // rather than crossing the bridge.
    getOpenRouterStatus: () =>
      invokeValidated(
        IPC.credentialsGetStatus,
        { providerId: 'openrouter' },
        openRouterCredentialStatusSchema,
        'The credential store returned an invalid status response.'
      ),
    // Removal is a main-owned deletion. The reply is validated with the same
    // strict status schema, so a padded or inconsistent payload fails closed
    // instead of telling the renderer a credential state that is not true.
    clearOpenRouterKey: () =>
      invokeValidated(
        IPC.credentialsClear,
        { providerId: 'openrouter' },
        openRouterCredentialStatusSchema,
        'The credential store returned an invalid removal response.'
      ),
    testOpenRouterConnection: () =>
      invoke(IPC.credentialsTest, {
        providerId: 'openrouter',
      }),
  },
  chat: {
    // Every session reply is parsed against the typed projection: the renderer
    // receives display and readiness facts only, and a main response that gained
    // a field — the stored compaction summary above all — is rejected here rather
    // than handed to the UI.
    createSession: (input) =>
      invokeValidated(IPC.chatCreateSession, { ...input, providerId: ipcProviderId(input.providerId) }, chatSessionSchema, INVALID_SESSION),
    getSession: (sessionId, documentId) =>
      invokeValidated(IPC.chatGetSession, { sessionId, documentId }, chatSessionReplySchema, INVALID_SESSION),
    listSessions: (documentId) =>
      invokeValidated(IPC.chatListSessions, { documentId }, chatSessionListReplySchema, INVALID_SESSION),
    updateSession: ({ providerId, ...input }) =>
      invokeValidated(
        IPC.chatUpdateSession,
        { ...input, ...(providerId !== undefined ? { providerId: ipcProviderId(providerId) } : {}) },
        chatSessionSchema,
        INVALID_SESSION
      ),
    deleteSession: (sessionId) => invoke(IPC.chatDeleteSession, { sessionId }),
    listMessages: (sessionId) =>
      invoke(IPC.chatListMessages, { sessionId }),
    listContext: (sessionId) =>
      invoke(IPC.chatListContext, { sessionId }),
    getContextBudget: (sessionId) =>
      invokeValidated(
        IPC.chatGetContextBudget,
        { sessionId },
        chatContextBudgetReplySchema,
        'The context budget response was invalid.'
      ),
    attachContext: (input) =>
      invoke(IPC.chatAttachContext, input),
    removeContext: (sessionId, contextItemId) =>
      invoke(IPC.chatRemoveContext, { sessionId, contextItemId }),
    // The bridge sends a session ID and validates a narrow reply: what was
    // compacted through, how large the stored summary is, and which context
    // items were cleared. The summary text itself never crosses this boundary.
    cleanContext: (sessionId) =>
      invokeValidated(
        IPC.chatCleanContext,
        { sessionId },
        cleanChatContextReplySchema,
        'The context cleanup response was invalid.'
      ),
    sendMessage: (sessionId, content, currentLocation, webSearch) =>
      invoke(IPC.chatSendMessage, {
        sessionId,
        content,
        ...(currentLocation ? { currentLocation } : {}),
        // Forwarded as a plain boolean only when the renderer asked for it, so
        // main sees an explicit opt-in and never an ambiguous value.
        ...(webSearch === true ? { webSearch: true } : {}),
      }),
    cancel: (requestId) => invoke(IPC.chatCancel, { requestId }),
    resolveCitation: (sessionId, messageId, sourceId) =>
      invoke(IPC.chatResolveCitation, { sessionId, messageId, sourceId }),
    onStreamEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        if (isChatStreamEvent(payload)) callback(payload);
      };
      ipc.on(IPC_EVENTS.chatStreamEvent, listener);
      return () => {
        ipc.removeListener(IPC_EVENTS.chatStreamEvent, listener);
      };
    },
    onSessionTitleChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        if (isChatSessionTitleChanged(payload)) callback(payload);
      };
      ipc.on(IPC_EVENTS.chatSessionTitleChanged, listener);
      return () => {
        ipc.removeListener(IPC_EVENTS.chatSessionTitleChanged, listener);
      };
    },
  },
  agent: {
    listProfiles: () => invoke(IPC.agentListProfiles),
    listProfileStatus: () =>
      invokeValidated(
        IPC.agentListProfileStatus,
        undefined,
        agentProfileStatusSnapshotSchema,
        'The agent profile status response was invalid.'
      ),
    refreshModels: () => invoke(IPC.agentRefreshModels),
    listWorkingDirectories: () => invoke(IPC.agentListWorkingDirectories),
    selectWorkingDirectory: () => invoke(IPC.agentSelectWorkingDirectory),
    startSession: (request) => invoke(IPC.agentStartSession, request),
    resumeSession: (request) => invoke(IPC.agentResumeSession, request),
    stopSession: (sessionId: string) => invoke(IPC.agentStopSession, { sessionId }),
    getSession: (sessionId: string, documentId: string) => invoke(IPC.agentGetSession, { sessionId, documentId }),
    listSessions: (documentId: string) => invoke(IPC.agentListSessions, { documentId }),
    issueRiskGrant: (request) => invoke(IPC.agentIssueRiskGrant, request),
    copyResult: (sessionId: string) => invoke(IPC.agentCopyResult, { sessionId }),
    claimSession: (sessionId: string) => invoke(IPC.agentClaimSession, { sessionId }),
    getEnvironmentReview: (sessionId: string) => invoke(IPC.agentGetEnvironmentReview, { sessionId }),
    applyChanges: (sessionId: string) => invoke(IPC.agentApplyChanges, { sessionId }),
    discardSandbox: (sessionId: string) => invoke(IPC.agentDiscardSandbox, { sessionId }),
    exportPatch: (sessionId: string) => invoke(IPC.agentExportPatch, { sessionId }),
    openFolder: (sessionId: string) => invoke(IPC.agentOpenFolder, { sessionId }),
    getModeAvailability: (profileId: string | null) => invoke(IPC.agentGetModeAvailability, { profileId }),
    selectExecutable: () => invoke(IPC.agentSelectExecutable),
    listCustomProfiles: () => invoke(IPC.agentListCustomProfiles),
    createCustomProfile: (input) => invoke(IPC.agentCreateCustomProfile, input),
    updateCustomProfile: (input) => invoke(IPC.agentUpdateCustomProfile, input),
    deleteCustomProfile: (id: string) => invoke(IPC.agentDeleteCustomProfile, { id }),
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        if (isAgentEvent(payload)) callback(payload);
      };
      ipc.on(IPC_EVENTS.agentEvent, listener);
      return () => { ipc.removeListener(IPC_EVENTS.agentEvent, listener); };
    },
  },
  clipboard: {
    writeText: (text: string) => invoke(IPC.clipboardWriteText, { text }),
  },
  updates: createUpdatesBridge(invoke, ipc),
  };
}

if (typeof contextBridge !== 'undefined' && typeof contextBridge.exposeInMainWorld === 'function') {
  const api = createInterleafApi(ipcRenderer, webUtils);
  contextBridge.exposeInMainWorld('interleafAPI', api);
}
