import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent, IpcRendererEvent } from 'electron';
import { IPC, IPC_CHANNELS, IPC_EVENTS } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import { invokeChannel, registerIpcHandlers, type IpcMainLike } from '@main/ipc/dispatcher';
import { makeIpcDeps } from '../helpers/ipc-deps';
import { createSenderRule } from '@main/ipc/sender-validation';
import { installMainWindowSecurityHandlers, type MainWindowWebContents } from '@main/windows/main-window';
import { CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS } from '@shared/constants/chat-wire';
import { createInterleafApi, isAgentEvent, isChatSessionTitleChanged, isChatStreamEvent, isStorageHealthUpdate, type PreloadIpc } from '../../src/preload/index';
import { silentLogger as log } from '../helpers/silent-logger';
import type { CloneableValue } from '@shared/models/portable';
import type { InterleafAPI } from '@shared/types/api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

describe('IPC Security, Preload Bridge & Schema Drift Audit (Phase 11)', () => {
  const senderRule = createSenderRule({ indexHtmlPath: '/out/renderer/index.html', devUrl: 'http://localhost:5173' });
  const validEvent = { senderFrame: { url: senderRule.allowedProductionFileUrl } } as Pick<IpcMainInvokeEvent, 'senderFrame'>;
  const hostileEvent = { senderFrame: { url: 'https://evil.example/' } } as Pick<IpcMainInvokeEvent, 'senderFrame'>;
  const deps = makeIpcDeps({
    senderRule, log,
    appInfo: () => ({ name: 'Interleaf', tagline: 'Read. Think. Build.', version: '0.2.0', platform: 'darwin', versions: { electron: '43', node: '24', chrome: '130' } }),
  });

  it('registers exactly the declared request channels and no generic channels', () => {
    const registered = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
    registerIpcHandlers({ handle: (channel, listener) => { expect(registered.has(channel)).toBe(false); registered.set(channel, listener); } }, deps);
    expect([...registered.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    expect(registered.size).toBe(IPC_CHANNELS.length);
    for (const channel of IPC_CHANNELS) expect(channel in ipcRequestSchemas).toBe(true);
    for (const channel of IPC_CHANNELS) expect(channel).not.toMatch(/^(?:fs|shell|exec|sql|db:raw|eval|system):/u);
  });

  it('rejects hostile, frameless, malformed, and oversized requests at the main boundary', async () => {
    expect(await invokeChannel(IPC.settingsGet, (() => ({})) as never, undefined, hostileEvent, { senderRule, log })).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(await invokeChannel(IPC.appGetInfo, (() => ({})) as never, undefined, { senderFrame: null }, { senderRule, log })).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
    expect(await invokeChannel(IPC.annotationsCreate, (() => ({})) as never, { invalid: true }, validEvent, { senderRule, log })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await invokeChannel(IPC.agentStartSession, (() => ({})) as never, { profileId: 'fake', executionMode: 'auto-isolated', prompt: 'x'.repeat(150_000), workingDirectoryHandle: 'h' }, validEvent, { senderRule, log })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await invokeChannel(IPC.appGetInfo, (() => ({})) as never, { rogue: true }, validEvent, { senderRule, log })).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  describe('preload bridge surface and exact channel/payload mapping', () => {
    const setup = () => {
      const calls: { channel: string; payload: CloneableValue }[] = [];
      const sent: { channel: string; payload: CloneableValue }[] = [];
      const listeners = new Map<string, (event: IpcRendererEvent, payload: CloneableValue) => void>();
      const removed: { channel: string; listener: (event: IpcRendererEvent, payload: CloneableValue) => void }[] = [];
      const providerStatus = {
        id: 'codex' as const,
        name: 'Codex CLI',
        available: false,
        installed: true,
        authentication: 'connected' as const,
        version: 'test',
        errorMessage: 'fail-closed fixture',
        models: [{ id: 'codex-default', name: 'Codex', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true }],
        capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: false, hostedWebSearch: false },
      };
      const contextBudget = {
        sessionId: 'session', providerId: 'codex' as const, modelId: 'codex-default',
        usedTokens: 1_024, totalTokens: 128_000,
        accuracy: 'estimated' as const, reservedOutputTokens: 512, sourceCount: 2,
        // The itemisation main publishes, which the bridge requires to add up to
        // the aggregate beside it.
        breakdown: {
          systemPromptTokens: 128, userPromptTokens: 32, historyTokens: 64,
          documentContextTokens: 224, documentSerializationTokens: 48,
          safetyHeadroomTokens: 64, reservedResponseTokens: 512,
        },
      };
      // The session projection is validated in full at the bridge, so every
      // channel that returns one needs a real row rather than an empty object.
      const chatSession = {
        id: 'session', documentId: 'doc', documentHash: 'hash', title: 'Chat',
        providerId: 'codex', modelId: null, reasoningEffort: null, messageCount: 2, previewText: null,
        compactedThroughOrdinal: 3, isArchived: false,
        createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
      };
      const replies = new Map<string, CloneableValue>([
        [IPC.chatCreateSession, chatSession],
        [IPC.chatGetSession, chatSession],
        [IPC.chatListSessions, [chatSession]],
        [IPC.chatUpdateSession, chatSession],
        [IPC.aiListProviders, [providerStatus]],
        [IPC.aiGetProviderStatus, providerStatus],
        [IPC.aiSignInWithChatGPT, providerStatus],
        [IPC.chatGetContextBudget, contextBudget],
        // Validated in full at the bridge, so this channel needs a real result.
        [IPC.chatCleanContext, {
          sessionId: 'session', compactedThroughOrdinal: 3,
          summaryTextUnits: 240, clearedContextItemIds: ['ctx-1'],
        }],
        [IPC.appOpenExternal, { opened: true }],
        // The diagram result is validated in full at the bridge.
        [IPC.readerRenderMermaid, { status: 'failed', reason: 'unavailable' }],
        // Both onboarding-era channels validate their whole result at the
        // bridge, so each needs a real payload rather than an empty object.
        [IPC.onboardingGetLaunchState, {
          verdict: 'new-install', shouldAutoOpen: true, resumeStage: 'welcome',
          settingsRowPresent: false, onboardingSectionPresent: false, priorInstallEvidence: false,
        }],
        [IPC.agentListProfileStatus, {
          profiles: [{
            profileId: 'codex', providerId: 'codex', name: 'Codex CLI',
            availability: 'installed', unavailability: 'none', version: 'test',
            errorMessage: null, checkedAt: '2026-09-12T00:00:00.000Z',
            defaultModel: null, availableModels: [], supportsModelSelection: true, isCustom: false,
          }],
          modelDiscoveryPending: false,
        }],
        // Validated in full at the bridge, so this channel needs a real result.
        [IPC.credentialsGetStatus, UNCONFIGURED_CREDENTIAL_STATUS],
        [IPC.credentialsClear, UNCONFIGURED_CREDENTIAL_STATUS],
        // Every update result is validated in full at the bridge.
        ...[IPC.updatesGetState, IPC.updatesCheck, IPC.updatesDownload].map((channel) => [channel, {
          currentVersion: '0.5.0', channel: 'stable', support: 'development', automaticChecks: true, lastCheckedAt: null, phase: { status: 'idle' },
        }] as const),
        [IPC.updatesRestart, { outcome: 'not-ready' }],
        [IPC.updatesOpenReleasePage, { opened: true }],
      ]);
      const ipc: PreloadIpc = {
        invoke: (channel, payload) => {
          calls.push({ channel, payload });
          return Promise.resolve({ ok: true, data: replies.get(channel) ?? {} });
        },
        on: (channel, listener) => { listeners.set(channel, listener); },
        removeListener: (channel, listener) => { removed.push({ channel, listener }); listeners.delete(channel); },
        send: (channel, payload) => { sent.push({ channel, payload }); },
      };
      return { api: createInterleafApi(ipc, { getPathForFile: (file) => `/tmp/${file.name}` }), calls, sent, listeners, removed };
    };

    it('validates and strips hostile AI provider response fields at the preload boundary', async () => {
      const status = {
        id: 'codex', name: 'Codex CLI', available: false, installed: true,
        authentication: 'connected', version: 'test', errorMessage: null,
        models: [{ id: 'codex-default', name: 'Codex', contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true, rogueModelField: 'drop' }],
        capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: false, hostedWebSearch: false, rogueCapability: true },
        binaryPath: '/Users/alice/private/codex',
        rogueStatusField: 'drop',
      };
      const ipc: PreloadIpc = {
        invoke: (channel) => Promise.resolve({ ok: true, data: channel === IPC.aiListProviders ? [status] : status }),
        on: () => undefined,
        removeListener: () => undefined,
        send: () => undefined,
      };
      const api = createInterleafApi(ipc, { getPathForFile: (file) => `/tmp/${file.name}` });
      const [listed] = await api.ai.listProviders();
      const fetched = await api.ai.getProviderStatus('codex');
      const signedIn = await api.ai.signInWithChatGPT();
      for (const value of [listed, fetched, signedIn]) {
        expect(value).not.toHaveProperty('binaryPath');
        expect(value).not.toHaveProperty('rogueStatusField');
        expect(value?.models[0]).not.toHaveProperty('rogueModelField');
        expect(value?.capabilities).not.toHaveProperty('rogueCapability');
      }
    });

    it('forwards a provider-list force refresh only when one is asked for', async () => {
      const payloads: Parameters<PreloadIpc['invoke']>[1][] = [];
      const ipc: PreloadIpc = {
        invoke: (_channel, payload) => { payloads.push(payload); return Promise.resolve({ ok: true, data: [] }); },
        on: () => undefined,
        removeListener: () => undefined,
        send: () => undefined,
      };
      const api = createInterleafApi(ipc, { getPathForFile: (file) => `/tmp/${file.name}` });
      await api.ai.listProviders();
      await api.ai.listProviders({ forceRefresh: false });
      await api.ai.listProviders({ forceRefresh: true });
      expect(payloads).toEqual([undefined, undefined, { forceRefresh: true }]);
      const schema = ipcRequestSchemas[IPC.aiListProviders];
      expect(schema.safeParse({ forceRefresh: 'yes' }).success).toBe(false);
      expect(schema.safeParse({ forceRefresh: true, providerId: 'codex' }).success).toBe(false);
    });

    it('rejects malformed AI provider status responses with a safe typed error', async () => {
      const ipc: PreloadIpc = {
        invoke: (channel) => Promise.resolve({ ok: true, data: channel === IPC.aiListProviders ? [{ id: 'codex', binaryPath: '/secret' }] : { id: 'codex', binaryPath: '/secret' } }),
        on: () => undefined,
        removeListener: () => undefined,
        send: () => undefined,
      };
      const api = createInterleafApi(ipc, { getPathForFile: (file) => `/tmp/${file.name}` });
      await expect(api.ai.listProviders()).rejects.toMatchObject({ code: 'internal', message: 'The AI provider returned an invalid status response.' });
      await expect(api.ai.getProviderStatus('codex')).rejects.toMatchObject({ code: 'internal' });
      await expect(api.ai.signInWithChatGPT()).rejects.toMatchObject({ code: 'internal' });
    });

    it('invokes every non-subscription method exactly once with the production payload shape', async () => {
      const { api, calls, sent } = setup();
      const last = (channel: string, payload: CloneableValue) => { expect(calls.at(-1)).toEqual({ channel, payload }); };
      const loc = { format: 'pdf' as const, pageIndex: 0 };
      await api.app.getInfo(); last(IPC.appGetInfo, undefined);
      await api.app.exportDebugLog(); last(IPC.appExportDebugLog, undefined);
      await api.settings.get(); last(IPC.settingsGet, undefined);
      const settings = { theme: 'light' } as never; await api.settings.update(settings); last(IPC.settingsUpdate, settings);
      await api.onboarding.getLaunchState(); last(IPC.onboardingGetLaunchState, undefined);
      const f1 = new File(['x'], 'book.pdf', { type: 'application/pdf' }); const f2 = new File(['y'], 'book.epub', { type: 'application/epub+zip' });
      await api.library.importDroppedFiles([f1, f2], { folderId: null, storageMode: 'managed' }); last(IPC.libraryImportDroppedFiles, { filePaths: ['/tmp/book.pdf', '/tmp/book.epub'], options: { folderId: null, storageMode: 'managed' } });
      await api.library.openFileDialog({ folderId: null, storageMode: 'link' }); last(IPC.libraryOpenFileDialog, { folderId: null, storageMode: 'link' });
      await api.library.importWebArticle('https://example.com/article', { folderId: 'folder' }); last(IPC.libraryImportWebArticle, { url: 'https://example.com/article', options: { folderId: 'folder' } });
      await api.library.listDocuments({ folderId: 'folder' }); last(IPC.libraryListDocuments, { folderId: 'folder' });
      await api.library.openDocument('doc'); last(IPC.libraryOpenDocument, { id: 'doc' });
      await api.library.closeDocument('doc'); last(IPC.libraryCloseDocument, { id: 'doc' });
      await api.library.deleteDocument('doc'); last(IPC.libraryDeleteDocument, { id: 'doc' });
      await api.library.getContinueReading(5); last(IPC.libraryGetContinueReading, { limit: 5 });
      await api.library.getRecentlyAdded(5); last(IPC.libraryGetRecentlyAdded, { limit: 5 });
      await api.library.getRecentlyRead(5); last(IPC.libraryGetRecentlyRead, { limit: 5 });
      await api.library.getSummary(); last(IPC.libraryGetSummary, undefined);
      await api.library.createFolder('Folder', 'parent'); last(IPC.libraryCreateFolder, { name: 'Folder', parentId: 'parent' });
      await api.library.renameFolder('folder', 'Renamed'); last(IPC.libraryRenameFolder, { id: 'folder', name: 'Renamed' });
      await api.library.deleteFolder('folder'); last(IPC.libraryDeleteFolder, { id: 'folder' });
      await api.library.listFolders(); last(IPC.libraryListFolders, undefined);
      await api.library.getFolderTree(); last(IPC.libraryGetFolderTree, undefined);
      await api.library.moveDocumentToFolder('doc', null); last(IPC.libraryMoveDocumentToFolder, { documentId: 'doc', folderId: null });
      await api.library.updateReadingPosition('doc', loc, 0.5); last(IPC.libraryUpdateReadingPosition, { documentId: 'doc', location: loc, progress: 0.5 });
      await api.library.getDocumentPreview('doc', null); last(IPC.libraryGetDocumentPreview, { documentId: 'doc', location: null });
      const anchor = { format: 'pdf' as const, pageIndex: 0, quote: { exact: 'text', prefix: '', suffix: '' } };
      const createAnno = { documentId: 'doc', type: 'highlight' as const, anchor }; await api.annotations.create(createAnno); last(IPC.annotationsCreate, createAnno);
      await api.annotations.list('doc', { type: 'highlight' }); last(IPC.annotationsList, { documentId: 'doc', filter: { type: 'highlight' } });
      await api.annotations.page('doc', { limit: 10 }); last(IPC.annotationsPage, { documentId: 'doc', filter: { limit: 10 } });
      const updateAnno = { documentId: 'doc', id: 'anno', note: 'note' }; await api.annotations.update(updateAnno); last(IPC.annotationsUpdate, updateAnno);
      await api.annotations.delete('doc', 'anno'); last(IPC.annotationsDelete, { documentId: 'doc', id: 'anno' });
      const repair = { documentId: 'doc', id: 'anno', documentHash: 'hash', anchor, status: 'anchored' as const }; await api.annotations.repairAnchor(repair); last(IPC.annotationsRepairAnchor, repair);
      await api.search.beginIndex('doc', 'hash'); last(IPC.searchBeginIndex, { documentId: 'doc', documentHash: 'hash' });
      const chunks = [{ ordinal: 0, text: 'text', location: loc, heading: null, pageLabel: null }]; await api.search.appendIndex('doc', 'hash', 'gen', chunks); last(IPC.searchAppendIndex, { documentId: 'doc', documentHash: 'hash', generationId: 'gen', chunks });
      await api.search.completeIndex('doc', 'hash', 'gen'); last(IPC.searchCompleteIndex, { documentId: 'doc', documentHash: 'hash', generationId: 'gen' });
      await api.search.failIndex('doc', 'hash', 'gen', 'failure'); last(IPC.searchFailIndex, { documentId: 'doc', documentHash: 'hash', generationId: 'gen', errorMessage: 'failure' });
      await api.search.getIndexState('doc'); last(IPC.searchGetIndexState, { documentId: 'doc' });
      await api.search.searchDocument('doc', 'query', 10); last(IPC.searchDocument, { documentId: 'doc', query: 'query', limit: 10 });
      await api.search.resolveHit('doc', 'hash', 'chunk', 'query'); last(IPC.searchResolveHit, { documentId: 'doc', documentHash: 'hash', chunkId: 'chunk', query: 'query' });
      await api.ai.listProviders(); last(IPC.aiListProviders, undefined);
      await api.ai.getProviderStatus('codex'); last(IPC.aiGetProviderStatus, { providerId: 'codex' });
      await api.ai.signInWithChatGPT(); last(IPC.aiSignInWithChatGPT, undefined);
      await api.ai.listOpenRouterModels({ forceRefresh: true }); last(IPC.aiListOpenRouterModels, { forceRefresh: true });
      await api.ai.configureOpenRouter({ apiKey: 'sk-or-v1-test-secret', model: 'openrouter/auto' }); last(IPC.aiConfigureOpenRouter, { apiKey: 'sk-or-v1-test-secret', model: 'openrouter/auto' });
      await api.credentials.getOpenRouterStatus(); last(IPC.credentialsGetStatus, { providerId: 'openrouter' });
      await api.credentials.clearOpenRouterKey(); last(IPC.credentialsClear, { providerId: 'openrouter' });
      await api.credentials.testOpenRouterConnection(); last(IPC.credentialsTest, { providerId: 'openrouter' });
      const chatCreate = { documentId: 'doc', title: 'Chat', providerId: 'codex' as const, modelId: null }; await api.chat.createSession(chatCreate); last(IPC.chatCreateSession, chatCreate);
      await api.chat.getSession('session', 'doc'); last(IPC.chatGetSession, { sessionId: 'session', documentId: 'doc' });
      await api.chat.listSessions('doc'); last(IPC.chatListSessions, { documentId: 'doc' });
      const chatUpdate = { sessionId: 'session', title: 'Renamed' }; await api.chat.updateSession(chatUpdate); last(IPC.chatUpdateSession, chatUpdate);
      await api.chat.deleteSession('session'); last(IPC.chatDeleteSession, { sessionId: 'session' });
      await api.chat.listMessages('session'); last(IPC.chatListMessages, { sessionId: 'session' });
      await api.chat.listContext('session'); last(IPC.chatListContext, { sessionId: 'session' });
      await api.chat.getContextBudget('session'); last(IPC.chatGetContextBudget, { sessionId: 'session' });
      const attach = { sessionId: 'session', documentId: 'doc', documentHash: 'hash', input: { kind: 'location' as const, location: loc } }; await api.chat.attachContext(attach); last(IPC.chatAttachContext, attach);
      await api.chat.removeContext('session', 'context'); last(IPC.chatRemoveContext, { sessionId: 'session', contextItemId: 'context' });
      await api.chat.cleanContext('session'); last(IPC.chatCleanContext, { sessionId: 'session' });
      await api.chat.sendMessage('session', 'hello', loc); last(IPC.chatSendMessage, { sessionId: 'session', content: 'hello', currentLocation: loc });
      await api.chat.cancel('request'); last(IPC.chatCancel, { requestId: 'request' });
      await api.chat.resolveCitation('session', 'message', 'source'); last(IPC.chatResolveCitation, { sessionId: 'session', messageId: 'message', sourceId: 'source' });
      await api.agent.listProfiles(); last(IPC.agentListProfiles, undefined);
      await api.agent.listProfileStatus(); last(IPC.agentListProfileStatus, undefined);
      await api.agent.refreshModels(); last(IPC.agentRefreshModels, undefined);
      await api.agent.listWorkingDirectories(); last(IPC.agentListWorkingDirectories, undefined);
      await api.agent.selectWorkingDirectory(); last(IPC.agentSelectWorkingDirectory, undefined);
      const run = { documentId: 'doc-audit', profileId: 'codex', workingDirectoryHandle: 'handle', executionMode: 'auto-isolated' as const, prompt: 'prompt' }; await api.agent.startSession(run); last(IPC.agentStartSession, run);
      const resume = { sessionId: 'session', prompt: 'follow-up prompt' }; await api.agent.resumeSession(resume); last(IPC.agentResumeSession, resume);
      await api.agent.stopSession('session'); last(IPC.agentStopSession, { sessionId: 'session' });
      await api.agent.getSession('session', 'doc-audit'); last(IPC.agentGetSession, { sessionId: 'session', documentId: 'doc-audit' });
      await api.agent.listSessions('doc-audit'); last(IPC.agentListSessions, { documentId: 'doc-audit' });
      await api.agent.copyResult('session'); last(IPC.agentCopyResult, { sessionId: 'session' });
      await api.agent.claimSession('session'); last(IPC.agentClaimSession, { sessionId: 'session' });
      const grant = { draftId: 'draft', profileId: 'codex', workingDirectoryHandle: 'handle', executionMode: 'active-env' as const, prompt: 'prompt', model: null, contextPacket: null }; await api.agent.issueRiskGrant(grant); last(IPC.agentIssueRiskGrant, grant);
      await api.agent.getEnvironmentReview('session'); last(IPC.agentGetEnvironmentReview, { sessionId: 'session' });
      await api.agent.applyChanges('session'); last(IPC.agentApplyChanges, { sessionId: 'session' });
      await api.agent.discardSandbox('session'); last(IPC.agentDiscardSandbox, { sessionId: 'session' });
      await api.agent.exportPatch('session'); last(IPC.agentExportPatch, { sessionId: 'session' });
      await api.agent.openFolder('session'); last(IPC.agentOpenFolder, { sessionId: 'session' });
      await api.agent.getModeAvailability('codex'); last(IPC.agentGetModeAvailability, { profileId: 'codex' });
      await api.agent.selectExecutable(); last(IPC.agentSelectExecutable, undefined);
      await api.agent.listCustomProfiles(); last(IPC.agentListCustomProfiles, undefined);
      const customCreate = { name: 'Custom', executableHandle: '550e8400-e29b-41d4-a716-446655440000', argvTemplate: ['--prompt', '{{promptFile}}'], promptDeliveryMode: 'temp-file' as const, stdoutParsingMode: 'text' as const, supportsResume: false, resumeCommandTemplate: null, defaultSandboxMode: 'auto-isolated' as const, environmentOverrides: [], unsafe: false };
      await api.agent.createCustomProfile(customCreate); last(IPC.agentCreateCustomProfile, customCreate);
      await api.agent.updateCustomProfile({ id: 'custom:550e8400-e29b-41d4-a716-446655440000', name: 'Updated' }); last(IPC.agentUpdateCustomProfile, { id: 'custom:550e8400-e29b-41d4-a716-446655440000', name: 'Updated' });
      await api.agent.deleteCustomProfile('custom:550e8400-e29b-41d4-a716-446655440000'); last(IPC.agentDeleteCustomProfile, { id: 'custom:550e8400-e29b-41d4-a716-446655440000' });
      await api.files.openDialog(); last(IPC.filesOpenDialog, undefined);
      await api.files.openPending(); last(IPC.filesOpenPending, undefined);
      const diagram = { source: 'flowchart TD\n  A --> B', appearance: 'light' as const }; await api.reader.renderMermaid(diagram); last(IPC.readerRenderMermaid, diagram);
      await api.clipboard.writeText('copied text'); last(IPC.clipboardWriteText, { text: 'copied text' });
      await api.updates.getState(); last(IPC.updatesGetState, undefined);
      await api.updates.check(); last(IPC.updatesCheck, undefined);
      await api.updates.download(); last(IPC.updatesDownload, undefined);
      await api.updates.restart(); last(IPC.updatesRestart, undefined);
      await api.updates.openReleasePage(); last(IPC.updatesOpenReleasePage, undefined);
      await api.app.openExternal('https://example.com/a'); last(IPC.appOpenExternal, { url: 'https://example.com/a' });
      expect(sent).toEqual([]); expect(calls).toHaveLength(IPC_CHANNELS.length); expect(new Set(calls.map((call) => call.channel))).toEqual(new Set(IPC_CHANNELS));
    });

    it('exposes only the declared namespace surface and no raw or generic bridge', () => {
      const { api } = setup();
      const exposed = new Set(Object.keys(api));
      expect([...exposed].sort()).toEqual(['agent', 'ai', 'annotations', 'app', 'chat', 'clipboard', 'credentials', 'files', 'library', 'onboarding', 'reader', 'search', 'settings', 'updates']);
      for (const key of ['ipcRenderer', 'require', 'process', 'invoke', 'send', 'on']) expect(exposed.has(key)).toBe(false);
      const expectedNamespaces: readonly (readonly [keyof InterleafAPI, readonly string[]])[] = [
        ['app', ['exportDebugLog', 'getInfo', 'onBeforeClose', 'openExternal']],
        ['settings', ['get', 'update']],
        // Read-only by design: the renderer reads the verdict main latched and
        // never writes onboarding state on a channel of its own.
        ['onboarding', ['getLaunchState']],
        ['library', ['closeDocument', 'createFolder', 'deleteDocument', 'deleteFolder', 'getContinueReading', 'getDocumentPreview', 'getFolderTree', 'getRecentlyAdded', 'getRecentlyRead', 'getSummary', 'importDroppedFiles', 'importWebArticle', 'listDocuments', 'listFolders', 'moveDocumentToFolder', 'onStorageHealthUpdated', 'openDocument', 'openFileDialog', 'renameFolder', 'updateReadingPosition']],
        ['annotations', ['create', 'delete', 'list', 'page', 'repairAnchor', 'update']],
        ['search', ['appendIndex', 'beginIndex', 'completeIndex', 'failIndex', 'getIndexState', 'resolveHit', 'searchDocument']],
        ['ai', ['configureOpenRouter', 'getProviderStatus', 'listOpenRouterModels', 'listProviders', 'signInWithChatGPT']],
        ['credentials', ['clearOpenRouterKey', 'getOpenRouterStatus', 'testOpenRouterConnection']],
        ['chat', ['attachContext', 'cancel', 'cleanContext', 'createSession', 'deleteSession', 'getContextBudget', 'getSession', 'listContext', 'listMessages', 'listSessions', 'onSessionTitleChanged', 'onStreamEvent', 'removeContext', 'resolveCitation', 'sendMessage', 'updateSession']],
        ['agent', ['applyChanges', 'claimSession', 'copyResult', 'createCustomProfile', 'deleteCustomProfile', 'discardSandbox', 'exportPatch', 'getEnvironmentReview', 'getModeAvailability', 'getSession', 'issueRiskGrant', 'listCustomProfiles', 'listProfiles', 'listProfileStatus', 'listSessions', 'listWorkingDirectories', 'onEvent', 'openFolder', 'refreshModels', 'resumeSession', 'selectExecutable', 'selectWorkingDirectory', 'startSession', 'stopSession', 'updateCustomProfile']],
        ['files', ['onCommand', 'openDialog', 'openPending']],
        ['reader', ['renderMermaid']],
        ['clipboard', ['writeText']],
        ['updates', ['check', 'download', 'getState', 'onState', 'openReleasePage', 'restart']],
      ];
      expect(expectedNamespaces.map(([namespace]) => namespace).sort()).toEqual([...exposed].sort());
      for (const [namespace, methods] of expectedNamespaces) {
        expect(Object.keys(api[namespace]).sort()).toEqual([...methods].sort());
      }
    });

    it('validates actual push listeners and removes exact listener identities', async () => {
      const { api, listeners, removed, sent } = setup(); const event = {} as IpcRendererEvent;
      let close = 0; const unClose = api.app.onBeforeClose(() => { close++; }); const closeListener = listeners.get(IPC_EVENTS.appBeforeClose)!;
      closeListener(event, { requestId: 'bad' }); closeListener(event, { requestId: '550e8400-e29b-41d4-a716-446655440000', extra: 'x'.repeat(1_000) }); await Promise.resolve(); expect(close).toBe(0);
      closeListener(event, { requestId: '550e8400-e29b-41d4-a716-446655440000' }); await Promise.resolve(); expect(close).toBe(1); expect(sent.at(-1)).toEqual({ channel: IPC_EVENTS.appCloseReady, payload: { requestId: '550e8400-e29b-41d4-a716-446655440000' } }); unClose(); expect(removed.at(-1)?.listener).toBe(closeListener);
      let health = 0; const unHealth = api.library.onStorageHealthUpdated(() => { health++; }); const healthListener = listeners.get(IPC_EVENTS.libraryStorageHealthUpdated)!;
      healthListener(event, { documentId: 'd', storageHealth: 'bad' }); healthListener(event, { documentId: 'd', storageHealth: 'missing', storageHealthMessage: 'x'.repeat(2_000) }); expect(health).toBe(0); healthListener(event, { documentId: 'd', storageHealth: 'missing', storageHealthMessage: 'gone' }); expect(health).toBe(1); unHealth(); expect(removed.at(-1)?.listener).toBe(healthListener);
      const base = { requestId: '550e8400-e29b-41d4-a716-446655440000', sessionId: 's', documentId: 'd', messageId: 'm' };
      const message = { id: 'm', sessionId: 's', role: 'assistant' as const, ordinal: 0, content: 'done', citations: [], status: 'complete' as const, requestId: base.requestId, tokenCount: 1, errorMessage: null, disclosures: [], webSources: [], createdAt: '2026-01-01T00:00:00.000Z' };
      const failedMessage = { ...message, status: 'failed' as const, errorMessage: 'failed' };
      const chats: CloneableValue[] = []; const unChat = api.chat.onStreamEvent((value) => { chats.push(value); }); const chatListener = listeners.get(IPC_EVENTS.chatStreamEvent)!;
      chatListener(event, { ...base, type: 'token', token: 'ok' }); chatListener(event, { ...base, type: 'done', message }); chatListener(event, { ...base, type: 'done', message: failedMessage }); chatListener(event, { ...base, type: 'done', message: { ...message, status: 'pending' as const } }); chatListener(event, { ...base, type: 'done', message: { ...message, status: 'error' as const } }); chatListener(event, { ...base, type: 'error', error: { __interleafError: true, code: 'internal', message: 'failed' } }); chatListener(event, { ...base, type: 'token', token: 'x'.repeat(70_000) }); chatListener(event, { ...base, type: 'done', message: { ...message, content: 'x'.repeat(CHAT_WIRE_MESSAGE_CONTENT_MAX_TEXT_UNITS + 1) } }); expect(chats).toHaveLength(4); unChat(); expect(removed.at(-1)?.listener).toBe(chatListener);
      const titles: CloneableValue[] = []; const unTitles = api.chat.onSessionTitleChanged((value) => { titles.push(value); }); const titleListener = listeners.get(IPC_EVENTS.chatSessionTitleChanged)!;
      titleListener(event, { sessionId: 's', documentId: 'd' }); titleListener(event, { sessionId: 's', documentId: 'd', title: 'Forged title' }); titleListener(event, { sessionId: '', documentId: 'd' }); titleListener(event, 'session'); expect(titles).toEqual([{ sessionId: 's', documentId: 'd' }]); unTitles(); expect(removed.at(-1)?.listener).toBe(titleListener);
      expect(isChatSessionTitleChanged({ sessionId: 's', documentId: 'd' })).toBe(true); expect(isChatSessionTitleChanged({ sessionId: 's' })).toBe(false);
      const agentEvents: CloneableValue[] = []; const unAgent = api.agent.onEvent((value) => { agentEvents.push(value); }); const agentListener = listeners.get(IPC_EVENTS.agentEvent)!; const stamp = '2026-01-01T00:00:00.000Z';
      const variants = [
        { sessionId: 's', ordinal: 0, type: 'started', timestamp: stamp }, { sessionId: 's', ordinal: 1, type: 'stdout', stream: 'stdout', text: 'out', timestamp: stamp }, { sessionId: 's', ordinal: 2, type: 'stderr', stream: 'stderr', text: 'err', timestamp: stamp }, { sessionId: 's', ordinal: 3, type: 'structured', data: { value: 'ok' }, timestamp: stamp }, { sessionId: 's', ordinal: 4, type: 'changed-files', data: { files: [] }, timestamp: stamp }, { sessionId: 's', ordinal: 5, type: 'tests', data: { status: 'passed' }, timestamp: stamp }, { sessionId: 's', ordinal: 6, type: 'final', text: 'final', timestamp: stamp }, { sessionId: 's', ordinal: 7, type: 'ended', exitCode: 0, signal: null, timestamp: stamp }, { sessionId: 's', ordinal: 8, type: 'cancelled', timestamp: stamp }, { sessionId: 's', ordinal: 9, type: 'error', error: { __interleafError: true, code: 'internal', message: 'error' }, timestamp: stamp },
      ];
      for (const variant of variants) agentListener(event, variant); agentListener(event, { ...variants[0], ordinal: 10, data: { huge: 'x'.repeat(70_000) } }); expect(agentEvents).toHaveLength(10); unAgent(); expect(removed.at(-1)?.listener).toBe(agentListener);
      const commands: string[] = []; const unFiles = api.files.onCommand((command) => { commands.push(command); }); const filesListener = listeners.get(IPC_EVENTS.filesCommand)!;
      filesListener(event, 'open-path'); filesListener(event, { command: 'open-dialog' }); filesListener(event, '/etc/passwd'); expect(commands).toEqual([]); filesListener(event, 'open-dialog'); filesListener(event, 'import-dialog'); filesListener(event, 'open-pending'); expect(commands).toEqual(['open-dialog', 'import-dialog', 'open-pending']); unFiles(); expect(removed.at(-1)?.listener).toBe(filesListener);
      expect(isStorageHealthUpdate({ documentId: 'd', storageHealth: 'ok' })).toBe(true); expect(isStorageHealthUpdate({ documentId: 'd', storageHealth: 'nope' })).toBe(false); expect(isChatStreamEvent({ ...base, type: 'token', token: 'ok' })).toBe(true); expect(isChatStreamEvent({ ...base, type: 'token', token: 'x'.repeat(70_000) })).toBe(false); expect(isAgentEvent(variants[0])).toBe(true); expect(isAgentEvent({ ...variants[0], ordinal: 2_000_000 })).toBe(false);
    });
  });

  describe('main-window security callback execution', () => {
    it('registers and executes exact navigation, popup, and webview defenses', () => {
      const events: string[] = []; let nav: ((event: { preventDefault(): void }, url: string) => void) | undefined; let attach: ((event: { preventDefault(): void }) => void) | undefined; let popup: ((details: { url: string }) => { action: 'deny' | 'allow' }) | undefined;
      const on: MainWindowWebContents['on'] = (event, listener) => { events.push(event); if (event === 'will-navigate') nav = listener; else attach = listener as (event: { preventDefault(): void }) => void; };
      const contents: MainWindowWebContents = { on, setWindowOpenHandler: (handler) => { popup = handler; } };
      installMainWindowSecurityHandlers(contents, 'http://localhost:5173', log);
      expect(events.sort()).toEqual(['will-attach-webview', 'will-navigate']); expect(popup?.({ url: 'https://evil.example' })).toEqual({ action: 'deny' });
      let prevented = 0; nav!({ preventDefault: () => { prevented++; } }, 'https://evil.example'); expect(prevented).toBe(1); nav!({ preventDefault: () => { prevented++; } }, 'http://localhost:5173/ok'); expect(prevented).toBe(1); nav!({ preventDefault: () => { prevented++; } }, 'not a url'); expect(prevented).toBe(2); let attached = 0; attach!({ preventDefault: () => { attached++; } }); expect(attached).toBe(1);
    });
  });
});
