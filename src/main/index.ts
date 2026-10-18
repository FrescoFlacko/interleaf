import { app, autoUpdater, BrowserWindow, ipcMain, Menu, net, protocol, session, dialog, safeStorage, shell, clipboard } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { APP_NAME, APP_TAGLINE } from '@shared/constants/brand';
import { InterleafDatabase, DATABASE_FILE_NAME } from './db/database';
import { configureDurableLogging, createLogger, flushDurableLogs, resetDurableLogging, setDurableDebugLogging, type DurableLogSink } from './logging/logger';
import { createDebugLogExporter } from './logging/debug-log-export';
import { IPC_EVENTS } from '@shared/constants/ipc';
import { resolveAppPaths } from './app/paths';
import { brandEnvFlagEnabled } from './app/brand-env';
import { applyTestCliSearchPathRestriction } from './app/cli-search-path-isolation';
import { applyDevelopmentDockIcon, applyEarlyStartupIdentity, runtimePackagingSignals } from './app/brand-startup';
import { assertStartupContinues } from './app/startup-decision';
import { applyLinuxRuntimeSwitches } from './app/linux-platform';
import { adoptLegacyDatabase } from './db/legacy-database-migration';
import { repairLegacyProfilePaths } from './db/legacy-profile-path-repair';
import { LEGACY_BRAND_PROFILE_DIRECTORY_NAME } from './app/legacy-profile-migration';
import { LifecycleCoordinator } from './app/lifecycle-coordinator';
import {
  captureOnboardingLaunchEvidence,
  deriveOnboardingLaunchState,
  OnboardingLaunchStateLatch,
} from './app/onboarding-launch-state';
import { formatFatalBootstrapDiagnostic, cleanupBootstrapResources } from './app/bootstrap-diagnostics';
import { runMigrations } from './db/migrations';
import { SettingsRepository } from './db/repositories/settings-repository';
import { DocumentRepository } from './db/repositories/document-repository';
import { FolderRepository } from './db/repositories/folder-repository';
import { ReadingPositionRepository } from './db/repositories/reading-position-repository';
import { AnnotationRepository } from './db/repositories/annotation-repository';
import { SearchRepository } from './db/repositories/search-repository';
import { ChatRepository } from './db/repositories/chat-repository';
import { ChatTitleRepository } from './db/repositories/chat-title-repository';
import { StorageManager } from './library/storage-manager';
import { LibraryService } from './library/library-service';
import { WebArticleImportService } from './library/web-article-import';
import { WebArticleFetcher } from './net/web-article-fetcher';
import { TestWebArticleTransport } from './net/test-web-article-transport';
import { WebMediaFetcher } from './net/web-media-fetcher';
import { TestWebMediaTransport } from './net/test-web-media-transport';
import { DocumentAssetRepository } from './db/repositories/document-asset-repository';
import type { StorageHealthUpdate } from '@shared/types/document';
import { installContentSecurityPolicy } from './security/csp';
import { installPermissionGuards } from './security/permissions';
import { AssetRegistry } from './security/asset-registry';
import { registerMediaProtocol } from './security/protocol-handler';
import { createSenderRule } from './ipc/sender-validation';
import { registerIpcHandlers, type AppInfoProviderResult } from './ipc/dispatcher';
import { AIContextRepository } from './ai/context-repository';
import { CredentialVault } from './ai/credential-vault';
import { AIProviderRegistry } from './ai/provider-registry';
import { ChatService } from './ai/chat-service';
import { ConversationTitler } from './ai/conversation-titling';
import { AgentRepository } from './db/repositories/agent-repository';
import { WorkingDirectoryRegistry } from './agents/working-directory-registry';
import { ProtectedRootPolicy } from './agents/protected-roots';
import { AgentRegistry } from './agents/agent-adapter';
import { createAgentModelDiscovery } from './agents/model-discovery';
import { createChatModelListing } from './ai/chat-model-listing';
import { AgentService } from './agents/agent-service';
import { ExecutableRegistry } from './agents/executable-registry';
import { CustomAgentProfileRepository } from './db/repositories/custom-agent-profile-repository';
import { AgentEnvironmentManager } from './agents/environment-manager';
import { createDangerousAgentRunConfirmationOptions, createExpertShellProfileConfirmationOptions } from './agents/native-confirmations';
import {
  createMainWindow,
  defaultIndexHtmlPath,
  defaultPreloadPath,
} from './windows/main-window';
import { ClipboardService } from './clipboard/clipboard-service';
import { MermaidRenderService } from './documents/mermaid/mermaid-render-service';
import { createMermaidSandboxWindow } from './documents/mermaid/mermaid-sandbox-window';
import type { CloneableValue } from '@shared/models/portable';
import type { FileCommand } from '@shared/types/files';
import { installAppMenu } from './app/app-menu';
import { OpenFileRequestQueue, openablePathsFromArgv } from './open-files/open-file-requests';
import { createOpenFiles, sendFileCommand } from './open-files/open-files-bootstrap';
import type { OpenFileManager } from './open-files/open-file-manager';
import { ShutdownBarrier } from './app/shutdown-barrier';
import { createActiveWork } from './app/active-work';
import { createUpdateRuntime, type UpdateController } from './updates/update-runtime';

// Names the process, then selects the profile directory (isolated override, or
// the real default with a pre-rebrand profile adopted) before anything can open
// a file under userData. An unsafe or half-applied profile stops bootstrap
// below; nothing is created here, so the process can still reach its
// fatal-startup reporting path.
const userDataProfileStartup = applyEarlyStartupIdentity();

// Linux/Wayland switches must be appended before app ready; Chromium reads
// them once during initialization. No-op on darwin and win32.
applyLinuxRuntimeSwitches(app.commandLine, process.platform, process.env);

// Custom scheme must be registered before app ready (ADR-0011).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'interleaf-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const log = createLogger('app');
const securityLog = createLogger('security');

let database: InterleafDatabase | null = null;
let assetRegistry: AssetRegistry | null = null;
let assetSweepTimer: NodeJS.Timeout | null = null;
let managedOrphanSweepTimer: NodeJS.Timeout | null = null;
let mediaScopeId = randomUUID();
let chatService: ChatService | null = null;
let agentService: AgentService | null = null;
let mermaidRenderService: MermaidRenderService | null = null;
let durableLogSink: DurableLogSink | null = null;
let openFiles: OpenFileManager | null = null;
let updates: UpdateController | null = null;
// Operating-system open requests can arrive before app ready (macOS
// `open-file`, the launch command line); they wait here for the renderer.
const openFileRequests = new OpenFileRequestQueue();

function createAndAttachMainWindow(): BrowserWindow {
  mediaScopeId = randomUUID();
  const window = createMainWindow({
    devUrl: process.env.ELECTRON_RENDERER_URL,
    indexHtmlPath: defaultIndexHtmlPath(),
    preloadPath: defaultPreloadPath(),
    log: securityLog,
  });
  attachMainWindowLifecycle(window, mediaScopeId);
  // Item C: main, not the renderer, names the window that may take over agent
  // sessions a destroyed window left behind. This is the only caller.
  agentService?.adoptMainWindow(window.webContents.id);
  return window;
}

const lifecycleCoordinator = new LifecycleCoordinator<BrowserWindow>({
  createWindow: createAndAttachMainWindow,
  onQuit: () => {
    app.quit();
  },
});

const shutdownBarrier = new ShutdownBarrier<BrowserWindow>({
  mainWindow: () => lifecycleCoordinator.mainWindow,
  drain: drainServices,
  hasLiveServices: () => chatService !== null || database !== null,
  quit: () => { app.quit(); },
  log,
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!lifecycleCoordinator.handleSingleInstanceLock(hasSingleInstanceLock)) {
  log.warn('secondary instance detected; aborting startup');
} else {
  registerAppLifecycle();
}

function registerAppLifecycle(): void {
  openFileRequests.enqueue(openablePathsFromArgv(process.argv, process.cwd()));
  app.on('second-instance', (_event, argv, workingDirectory) => {
    openFileRequests.enqueue(openablePathsFromArgv(argv, workingDirectory));
    lifecycleCoordinator.handleSecondInstance();
  });
  // Registered at module load: macOS delivers a Finder or Dock open before ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (openFileRequests.enqueue([filePath])) lifecycleCoordinator.handleActivate();
  });

  void app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      lifecycleCoordinator.markBootstrapFailed();
      updates?.dispose();
      updates = null;
      const diagnostic = formatFatalBootstrapDiagnostic(error instanceof Error ? error : null);
      log.error('fatal startup failure', diagnostic);
      await cleanupBootstrapResources({
        database,
        assetRegistry,
        assetSweepTimer,
        managedOrphanSweepTimer,
        chatService,
        agentService,
        flushLogs: flushDurableLogs,
        resetLogs: resetDurableLogging,
      });
      database = null;
      assetRegistry = null;
      assetSweepTimer = null;
      managedOrphanSweepTimer = null;
      chatService = null;
      agentService = null;
      durableLogSink = null;
      dialog.showErrorBox(
        `${APP_NAME} failed to start`,
        'Interleaf could not initialize its local data. See the redacted application log for details.'
      );
      app.quit();
    }
  });

  app.on('activate', () => {
    lifecycleCoordinator.handleActivate();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    shutdownBarrier.handleBeforeQuit(event);
  });

  app.on('will-quit', (event) => {
    if (shutdownBarrier.handleWillQuit(event) && database !== null) {
      database.close();
      database = null;
    }
  });
}

async function bootstrap(): Promise<void> {
  // Fail closed on the profile decision taken at module load, before any
  // directory, database, vault, or service is created.
  assertStartupContinues(userDataProfileStartup);
  lifecycleCoordinator.startBootstrap();
  if (process.platform === 'darwin') {
    // The name is already set at module load; the Dock icon needs app.ready.
    applyDevelopmentDockIcon(runtimePackagingSignals());
  }

  const paths = resolveAppPaths();
  durableLogSink = configureDurableLogging({
    directory: paths.logs,
    debugEnabled: brandEnvFlagEnabled('DEBUG_LOGS'),
  });
  log.info('durable logging initialized', {
    debugEnabled: durableLogSink.debugEnabled,
    retention: 3,
  });
  // Adopt a pre-rebrand `marginlab.sqlite` (and its WAL/SHM sidecars) while no
  // connection is open. Skipped whenever an Interleaf database already exists,
  // and throws rather than open a fresh database over an unsafe or partially
  // adopted layout.
  adoptLegacyDatabase({
    databaseDirectory: paths.database,
    currentFileName: DATABASE_FILE_NAME,
    log: createLogger('database'),
  });
  database = InterleafDatabase.open(join(paths.database, DATABASE_FILE_NAME));
  // Guided onboarding classifies this launch from evidence that startup itself
  // destroys: `applyMigrations` creates `schema_migrations` when it is missing,
  // and migration 2 seeds the `settings` row on every fresh database. The "did
  // this database exist before now" question therefore has to be asked here,
  // before the first migration runs, and never again.
  const onboardingLaunchEvidence = captureOnboardingLaunchEvidence(database, createLogger('app'));
  const applied = runMigrations(database);
  createLogger('database').info('database ready', { appliedMigrations: applied });
  // Rows adopted from a pre-rebrand profile still store `<appData>/MarginLab`
  // paths. They have to be rebased here — after the schema is current and
  // before storage initialization or any managed-orphan sweep — or every
  // referenced blob in the adopted library would look like an orphan.
  repairLegacyProfilePaths({
    db: database,
    legacyUserDataRoot: join(app.getPath('appData'), LEGACY_BRAND_PROFILE_DIRECTORY_NAME),
    currentUserDataRoot: paths.userData,
    log: createLogger('database'),
  });

  const appLogger = createLogger('app');
  // Latched before the SettingsRepository below is constructed, and therefore
  // before any read that would substitute defaults for a missing row or a
  // missing `onboarding` section. Every later query is answered from this
  // value, so a normalization write cannot change the verdict mid-session.
  const onboardingLaunchStateLatch = new OnboardingLaunchStateLatch(deriveOnboardingLaunchState(onboardingLaunchEvidence));
  appLogger.info('onboarding launch state latched', {
    verdict: onboardingLaunchStateLatch.get().verdict,
  });
  const settings = new SettingsRepository(database, appLogger);
  // The sink is configured before the database exists, so the stored diagnostic
  // preference is applied here. The environment override still forces it on.
  const forceDebugLogs = brandEnvFlagEnabled('DEBUG_LOGS');
  const applyDiagnosticLogging = (enabled: boolean): void => {
    setDurableDebugLogging(forceDebugLogs || enabled);
  };
  applyDiagnosticLogging(settings.get().advanced.debugLogging);
  const storage = new StorageManager(paths.library, appLogger);
  // Reconcile abandoned imports before any IPC handler or renderer can begin
  // a new import; otherwise cleanup could race a live temp file.
  await storage.initialize();

  assetRegistry = new AssetRegistry([paths.library, paths.openFiles]);
  registerMediaProtocol(assetRegistry, () => mediaScopeId, securityLog);
  assetSweepTimer = setInterval(() => {
    assetRegistry?.sweepExpired();
  }, 60_000);
  assetSweepTimer.unref();

  const documents = new DocumentRepository(database);
  const documentAssets = new DocumentAssetRepository(database);
  const folders = new FolderRepository(database);
  const readingPositions = new ReadingPositionRepository(database);
  const annotations = new AnnotationRepository(database);
  const search = new SearchRepository(database);
  const chat = new ChatRepository(database);
  const agentRepository = new AgentRepository(database);
  const customProfileRepository = new CustomAgentProfileRepository(database);
  const executableRegistry = new ExecutableRegistry();
  // Main-owned protected application-data roots (docs/REMAINING_WORK.md item
  // A). An agent target that equals, contains, or lives inside any of these
  // would put the database, library, credentials, logs, or another session's
  // workspace inside an agent's writable tree, so the whole symmetric overlap
  // matrix is rejected before any lock, copy, baseline, or workspace mutation.
  // The legacy brand profile directory is included because it can still hold
  // a previous installation's data.
  const protectedAppRoots = new ProtectedRootPolicy([
    paths.userData,
    paths.database,
    paths.library,
    paths.aiChat,
    paths.agentWorkspaces,
    paths.agentContext,
    paths.logs,
    paths.openFiles,
    join(app.getPath('appData'), LEGACY_BRAND_PROFILE_DIRECTORY_NAME),
  ]);
  const workingDirectories = new WorkingDirectoryRegistry({ protectedRoots: protectedAppRoots });
  const aiContext = new AIContextRepository(database);
  const credentials = new CredentialVault(join(paths.userData, 'credentials.v1.json'), safeStorage);
  // Deterministic providers are available only to an explicit test harness.
  // NODE_ENV/development must never make them user-selectable.
  const allowTestDoubles = !app.isPackaged && brandEnvFlagEnabled('TEST_SEAM');
  // Before any provider or agent discovery: an unpackaged test run may confine
  // CLI lookup to the exact PATH it was launched with.
  const cliPathConfined = applyTestCliSearchPathRestriction({ isPackaged: app.isPackaged, env: process.env });
  const agentLogger = createLogger('agent');
  // Agent Mode's identifier catalog. Absent under NODE_ENV=test.
  const modelDiscovery = createAgentModelDiscovery({ log: agentLogger, probeCwd: paths.agentContext });
  const aiProviders = new AIProviderRegistry({
    chatRoot: paths.aiChat,
    // Reader Chat reads per-model reasoning levels too, which Agent Mode's
    // identifier catalog does not carry. Under NODE_ENV=test, only against
    // the confined fixture PATH.
    modelListing: createChatModelListing({ log: createLogger('ai'), probeCwd: paths.agentContext }, cliPathConfined),
    vault: credentials,
    isPackaged: app.isPackaged,
    allowFakeProvider: allowTestDoubles,
    logger: createLogger('ai'),
    // Read per use, so changing the local endpoint or model in Settings takes
    // effect on the next status refresh rather than at the next launch.
    readLocalSettings: () => settings.get().ai.local,
  });
  // Read-only CLI detection starts now, while the rest of startup runs, so the
  // first document's Reader Chat reads a settled answer instead of waiting.
  aiProviders.prewarm();
  // The socket is the only part of web-article import a test may replace. URL
  // policy, extraction bounds, storage, and deduplication always run for real.
  const webArticleTransport = allowTestDoubles
    ? new TestWebArticleTransport()
    : new WebArticleFetcher();
  // Image bytes get the same treatment: a test may supply them, but format
  // admission, storage, hashing, and capability issuance always run for real.
  const webMediaTransport = allowTestDoubles
    ? new TestWebMediaTransport()
    : new WebMediaFetcher();
  const library = new LibraryService({
    db: database,
    storage,
    documents,
    folders,
    readingPositions,
    documentAssets,
    log: appLogger,
    assetRegistry,
    currentScopeId: () => mediaScopeId,
    webArticles: new WebArticleImportService({
      transport: webArticleTransport,
      media: webMediaTransport,
      log: createLogger('security'),
    }),
  });
  // One titler, mode and run limit for the library and every opened file.
  const titler = new ConversationTitler({ settings, providers: aiProviders, log: createLogger('ai') });
  chatService = new ChatService({
    chat,
    context: aiContext,
    providers: aiProviders,
    requireDocumentOpen: (documentId) => { library.requireDocumentOpen(documentId); },
    resolveOpenRouterModelId: () => Promise.resolve(settings.get().ai.openRouterModel),
    log: createLogger('ai'),
    titles: titler.forStore(new ChatTitleRepository(database)),
  });
  openFiles = await createOpenFiles({
    root: paths.openFiles,
    store: {
      assetRegistry,
      currentScopeId: () => mediaScopeId,
      providers: aiProviders,
      resolveOpenRouterModelId: () => Promise.resolve(settings.get().ai.openRouterModel),
      titler,
      log: appLogger,
    },
    requests: openFileRequests,
    dialog,
    parentWindow: () => lifecycleCoordinator.mainWindow,
  });
  agentService = new AgentService({
    repository: agentRepository,
    registry: workingDirectories,
    agentRegistry: new AgentRegistry({
      executableRegistry,
      promptRoot: join(paths.agentContext, 'custom-prompts'),
      logger: agentLogger,
      // `probeCwd` is a neutral app-owned directory: these CLIs read hooks,
      // skills and extensions from their working directory, and a listing must
      // not execute any project's. Absent under NODE_ENV=test.
      modelDiscovery,
      ...(allowTestDoubles && brandEnvFlagEnabled('FAKE_RESUME_SLEEP') ? { fakeFixtureBehavior: { resumeSleep: true } } : {}),
    }),
    allowFakeAgent: allowTestDoubles,
    contextRoot: paths.agentContext,
    clipboard,
    chooseDirectory: async () => {
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Select an agent working directory',
        })
        : await dialog.showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select an agent working directory',
      });
      return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
    },
    log: createLogger('agent'),
    isPackaged: app.isPackaged,
    confirmDirectWorkspace: async ({ mode, riskLevel, canonicalTargetPath, profileName }) => {
      const warning = mode === 'active-env'
        ? `HIGH/CRITICAL RISK: ${profileName} will run directly in the selected workspace and may create, modify, or delete files in ${canonicalTargetPath}. Interleaf cannot undo changes made by the process. Continue only if you trust this task.`
        : `Native Restricted mode relies on the selected adapter's verified native sandbox. A failure to prove that sandbox will stop the run. This is ${riskLevel.toUpperCase()} risk for ${profileName}. Continue?`;
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, title: 'Confirm direct workspace execution', message: warning })
        : await dialog.showMessageBox(parent, { type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, title: 'Confirm direct workspace execution', message: warning });
      return result.response === 1;
    },
    confirmExpertShellProfile: async (profileName) => {
      const options = createExpertShellProfileConfirmationOptions(profileName);
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
      return result.response === 1;
    },
    customProfiles: customProfileRepository,
    executableRegistry,
    chooseExecutable: async () => {
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showOpenDialog({
          properties: ['openFile'],
          title: 'Select a custom agent executable',
          ...(process.platform === 'win32' ? { filters: [{ name: 'Executable files', extensions: ['exe', 'com'] }] } : {}),
        })
        : await dialog.showOpenDialog(parent, {
          properties: ['openFile'],
          title: 'Select a custom agent executable',
          ...(process.platform === 'win32' ? { filters: [{ name: 'Executable files', extensions: ['exe', 'com'] }] } : {}),
        });
      return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
    },
    confirmUnsafeCustomProfile: async (profileName) => {
      const message = `The custom agent profile “${profileName}” is marked unsafe. It may bypass the CLI's normal permission controls. Continue?`;
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Enable unsafe profile'], defaultId: 0, cancelId: 0, title: 'Enable unsafe custom agent profile', message: message })
        : await dialog.showMessageBox(parent, { type: 'warning', buttons: ['Cancel', 'Enable unsafe profile'], defaultId: 0, cancelId: 0, title: 'Enable unsafe custom agent profile', message: message });
      return result.response === 1;
    },
    confirmDangerousAgentRun: async ({ profileName, canonicalTargetPath, riskLevel, expertShell }) => {
      const options = createDangerousAgentRunConfirmationOptions({
        profileName,
        canonicalTargetPath,
        riskLevel,
        ...(expertShell === undefined ? {} : { expertShell }),
      });
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
      return result.response === 1;
    },
    environmentManager: new AgentEnvironmentManager({
      root: paths.agentWorkspaces,
      protectedRoots: [...protectedAppRoots.declaredRoots],
      openFolder: async (canonicalPath) => (await shell.openPath(canonicalPath)).length === 0,
      savePatch: async (fileName, contents) => {
        const parent = lifecycleCoordinator.mainWindow;
        const result = parent === null
          ? await dialog.showSaveDialog({ title: 'Export Interleaf patch', defaultPath: fileName, filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }] })
          : await dialog.showSaveDialog(parent, { title: 'Export Interleaf patch', defaultPath: fileName, filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }] });
        if (result.canceled) return false;
        await writeFile(result.filePath, contents, { encoding: 'utf8', mode: 0o600 });
        return true;
      },
    }),
  });
  await agentService.initialize();
  agentService.applyProfileSettings(settings.get().agent.profiles);
  library.onHealthUpdated((update: StorageHealthUpdate) => {
    const activeWindow = lifecycleCoordinator.mainWindow;
    if (activeWindow !== null && !activeWindow.isDestroyed()) {
      activeWindow.webContents.send(IPC_EVENTS.libraryStorageHealthUpdated, update);
    }
  });
  await library.reconcileManagedStorage();
  managedOrphanSweepTimer = setInterval(() => {
    void library.reconcileManagedStorage();
  }, 10 * 60 * 1000);
  managedOrphanSweepTimer.unref();
  installContentSecurityPolicy(session.defaultSession, {
    devUrl: process.env.ELECTRON_RENDERER_URL,
  });
  installPermissionGuards(session.defaultSession, securityLog);

  const exportDebugLog = createDebugLogExporter(
    durableLogSink,
    async (parentWindow, options) => {
      const result = parentWindow === null
        ? await dialog.showSaveDialog({ ...options, filters: options.filters.map((filter) => ({ ...filter, extensions: [...filter.extensions] })) })
        : await dialog.showSaveDialog(parentWindow, { ...options, filters: options.filters.map((filter) => ({ ...filter, extensions: [...filter.extensions] })) });
      return {
        canceled: result.canceled,
        ...(result.filePath.length === 0 ? {} : { filePath: result.filePath }),
      };
    },
  );

  // The isolated renderer is created on the first diagram and recreated after
  // any termination, so an application that never opens one never starts it.
  mermaidRenderService = new MermaidRenderService({
    createSandbox: () =>
      createMermaidSandboxWindow({
        log: securityLog,
        devUrl: process.env.ELECTRON_RENDERER_URL,
      }),
    log: securityLog,
  });

  const liveOpenFiles = openFiles;
  const liveAgents = agentService;
  const libraryChat = chatService;
  updates = createUpdateRuntime({
    currentVersion: app.getVersion(),
    packaging: runtimePackagingSignals(),
    automaticChecks: settings.get().updates.automaticChecks,
    fetch: (input, init) => net.fetch(input, init),
    nativeMacUpdater: autoUpdater,
    releaseSingleInstanceLock: () => { app.releaseSingleInstanceLock(); },
    activeWork: createActiveWork({
      agentSessions: [() => liveAgents.liveWork()],
      chatStreams: [() => libraryChat.liveWork(), () => liveOpenFiles.liveChatWork()],
      imports: [() => library.importAdmission.liveWork(), () => liveOpenFiles.liveOpens()],
      closeAdmission: [
        () => { libraryChat.closeAdmission(); },
        () => { liveOpenFiles.closeAdmission(); },
        () => { liveAgents.closeAdmission(); },
        () => { library.importAdmission.close(); },
      ],
    }),
    requestQuitForUpdate: (install, closeAdmission) => shutdownBarrier.requestQuitForUpdate(install, closeAdmission),
    openExternal: (url) => shell.openExternal(url),
    publish: (state) => { lifecycleCoordinator.mainWindow?.webContents.send(IPC_EVENTS.updatesState, state); },
    log: createLogger('app'),
  });

  registerIpcHandlers(ipcMain, {
    settings,
    onboardingLaunchState: () => onboardingLaunchStateLatch.get(),
    library,
    annotations,
    search,
    chat: chatService,
    credentials,
    appInfo: provideAppInfo,
    senderRule: createSenderRule({
      devUrl: process.env.ELECTRON_RENDERER_URL,
      indexHtmlPath: defaultIndexHtmlPath(),
    }),
    log: securityLog,
    parentWindow: () => lifecycleCoordinator.mainWindow,
    exportDebugLog,
    // The only path out of the application for a link found in a document. The
    // dispatcher has already re-validated the target; `shell` is reached from
    // main alone, never from the renderer.
    openExternal: (url) => shell.openExternal(url),
    // Shown only when the reader turned confirmation on. The dispatcher passes
    // the canonical target, so the dialog names the link that would be opened.
    confirmExternalLink: async (url) => {
      const parent = lifecycleCoordinator.mainWindow;
      const options = {
        type: 'question' as const,
        buttons: ['Cancel', 'Open link'],
        defaultId: 0,
        cancelId: 0,
        title: 'Open external link',
        message: 'Open this link outside Interleaf?',
        detail: url,
      };
      const result = parent === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
      return result.response === 1;
    },
    applyDiagnosticLogging,
    confirmUnsafeProfile: async (profileId) => {
      const warning = `Enable the unsafe ${profileId} profile preset? This may bypass normal agent permission checks. Every run still requires deliberate review and direct-workspace confirmation.`;
      const parent = lifecycleCoordinator.mainWindow;
      const result = parent === null
        ? await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Enable unsafe preset'], defaultId: 0, cancelId: 0, title: 'Enable unsafe agent profile', message: warning })
        : await dialog.showMessageBox(parent, { type: 'warning', buttons: ['Cancel', 'Enable unsafe preset'], defaultId: 0, cancelId: 0, title: 'Enable unsafe agent profile', message: warning });
      return result.response === 1;
    },
    agent: agentService,
    clipboard: new ClipboardService({ clipboard }),
    mermaid: mermaidRenderService,
    openFiles,
    updates,
  });
  const deliverFileCommand = (command: FileCommand): void => {
    sendFileCommand(() => lifecycleCoordinator.ensureMainWindow(), command);
  };
  installAppMenu(Menu, process.platform, {
    openFile: () => { deliverFileCommand('open-dialog'); },
    importToLibrary: () => { deliverFileCommand('import-dialog'); },
  });
  ipcMain.on(IPC_EVENTS.appCloseReady, (event, payload: CloneableValue) => {
    shutdownBarrier.handleCloseReady(event.sender, payload);
  });
  // Defense-in-depth at the app level: no <webview> attachment anywhere.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      securityLog.warn('blocked webview attachment');
    });
  });

  lifecycleCoordinator.markBootstrapReady();
  lifecycleCoordinator.ensureMainWindow();
  openFileRequests.attach(() => { deliverFileCommand('open-pending'); });
  updates.start();
}

function attachMainWindowLifecycle(window: BrowserWindow, scopeId: string): void {
  window.on('close', (event) => {
    shutdownBarrier.handleWindowClose(window, event);
  });

  window.on('closed', () => {
    // An open file lives only as long as the reader showing it.
    void openFiles?.closeAll();
    assetRegistry?.unregisterScope(scopeId);
    lifecycleCoordinator.handleWindowClosed(window);
    shutdownBarrier.handleWindowClosed();
  });
}

/** Stops every service once, in dependency order; the shutdown barrier decides when. */
async function drainServices(): Promise<void> {
  lifecycleCoordinator.startShutdown();
  updates?.dispose();
  updates = null;
  try {
    // Open files first: their chat services borrow the provider registry
    // that the library chat service shuts down.
    await openFiles?.shutdown();
    openFiles = null;
    if (chatService !== null) {
      await chatService.shutdown();
    }
    if (agentService !== null) {
      await agentService.shutdown();
    }
  } finally {
    chatService = null;
    agentService = null;
    // Ends the hidden diagram renderer and answers anything still queued, so
    // shutdown never waits on a render and never leaves a process behind.
    mermaidRenderService?.dispose();
    mermaidRenderService = null;
    if (assetSweepTimer !== null) {
      clearInterval(assetSweepTimer);
      assetSweepTimer = null;
    }
    if (managedOrphanSweepTimer !== null) {
      clearInterval(managedOrphanSweepTimer);
      managedOrphanSweepTimer = null;
    }
    assetRegistry?.clear();
    assetRegistry = null;
    database?.close();
    database = null;
    await flushDurableLogs();
    resetDurableLogging();
    durableLogSink = null;
    lifecycleCoordinator.markTerminated();
  }
}

function provideAppInfo(): AppInfoProviderResult {
  const platform =
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
      ? process.platform
      : 'linux';
  return {
    name: APP_NAME,
    tagline: APP_TAGLINE,
    version: app.getVersion(),
    platform,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
  };
}

