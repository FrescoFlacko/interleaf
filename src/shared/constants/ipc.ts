/**
 * The complete whitelist of IPC channels exposed to the renderer.
 *
 * Invariants (AGENTS.md §2):
 * - Every channel is a high-level domain operation. No generic `fs`, `exec`,
 *   or SQL channels exist.
 * - Each channel has a Zod-validated request contract in
 *   `src/shared/schemas/ipc.ts`; the main process rejects anything else.
 */
export const IPC = {
  appGetInfo: 'app:get-info',
  appExportDebugLog: 'app:export-debug-log',
  /** Hands one validated http/https link to the operating system's browser. */
  appOpenExternal: 'app:open-external',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  /**
   * The guided-onboarding launch verdict main latched at startup.
   *
   * Read-only and payload-free. `settings:get` cannot answer this: it
   * substitutes defaults for a missing row, so by the time the renderer could
   * ask, the evidence that the row or the section was absent is gone.
   */
  onboardingGetLaunchState: 'onboarding:get-launch-state',

  // Phase 3 — Library & Folder Management
  /** Preload-internal channel populated only from genuine dropped File objects. */
  libraryImportDroppedFiles: 'library:import-dropped-files',
  libraryOpenFileDialog: 'library:open-file-dialog',
  libraryImportWebArticle: 'library:import-web-article',
  libraryListDocuments: 'library:list-documents',
  libraryOpenDocument: 'library:open-document',
  libraryCloseDocument: 'library:close-document',
  libraryDeleteDocument: 'library:delete-document',
  libraryGetContinueReading: 'library:get-continue-reading',
  libraryGetRecentlyAdded: 'library:get-recently-added',
  libraryGetRecentlyRead: 'library:get-recently-read',
  libraryGetSummary: 'library:get-summary',
  libraryCreateFolder: 'library:create-folder',
  libraryRenameFolder: 'library:rename-folder',
  libraryDeleteFolder: 'library:delete-folder',
  libraryListFolders: 'library:list-folders',
  libraryGetFolderTree: 'library:get-folder-tree',
  libraryMoveDocumentToFolder: 'library:move-document-to-folder',
  libraryUpdateReadingPosition: 'library:update-reading-position',
  libraryGetDocumentPreview: 'library:get-document-preview',

  /**
   * Opens one file for reading without adding it to the library. Neither
   * channel carries a path: main shows its own dialog, or hands over the file
   * the operating system asked it to open.
   */
  filesOpenDialog: 'files:open-dialog',
  filesOpenPending: 'files:open-pending',

  /**
   * Draws one fenced diagram found in a document.
   *
   * The reader sends the fenced source and the appearance it is displaying;
   * main renders it in a process it owns and can terminate, and answers with
   * inert markup or a typed failure. The renderer supplies no path, no
   * configuration, and no colour.
   */
  readerRenderMermaid: 'reader:render-mermaid',

  // Phase 5 — Annotations & Highlights
  annotationsCreate: 'annotations:create',
  annotationsList: 'annotations:list',
  annotationsPage: 'annotations:page',
  annotationsUpdate: 'annotations:update',
  annotationsDelete: 'annotations:delete',
  annotationsRepairAnchor: 'annotations:repair-anchor',

  // Phase 6 — Revision-aware lexical indexing and FTS5 search
  searchBeginIndex: 'search:begin-index',
  searchAppendIndex: 'search:append-index',
  searchCompleteIndex: 'search:complete-index',
  searchFailIndex: 'search:fail-index',
  searchGetIndexState: 'search:get-index-state',
  searchDocument: 'search:document',
  searchResolveHit: 'search:resolve-hit',

  // Phase 7 — AI providers, persistent chat, and revision-bound context
  aiListProviders: 'ai:list-providers',
  aiGetProviderStatus: 'ai:get-provider-status',
  aiSignInWithChatGPT: 'ai:sign-in-with-chatgpt',
  aiListOpenRouterModels: 'ai:list-openrouter-models',
  aiConfigureOpenRouter: 'ai:configure-openrouter',
  credentialsGetStatus: 'credentials:get-status',
  /**
   * Deletes the stored provider credential immediately. Main owns the deletion
   * and never decrypts the removed secret, so an unreadable ciphertext can
   * still be cleared. The reply is the same masked status projection.
   */
  credentialsClear: 'credentials:clear',
  credentialsTest: 'credentials:test',
  chatCreateSession: 'chat:create-session',
  chatGetSession: 'chat:get-session',
  chatListSessions: 'chat:list-sessions',
  chatUpdateSession: 'chat:update-session',
  chatDeleteSession: 'chat:delete-session',
  chatListMessages: 'chat:list-messages',
  chatListContext: 'chat:list-context',
  chatGetContextBudget: 'chat:get-context-budget',
  chatAttachContext: 'chat:attach-context',
  chatRemoveContext: 'chat:remove-context',
  chatCleanContext: 'chat:clean-context',
  chatSendMessage: 'chat:send-message',
  chatCancel: 'chat:cancel',
  chatResolveCitation: 'chat:resolve-citation',

  // Phase 8 — Agent Runtime foundation (Phase 9 isolation is main-owned and gated)
  agentListProfiles: 'agent:list-profiles',
  /**
   * Detection-only snapshot of the agent profiles, without waiting for the
   * background model listing.
   *
   * `agent:list-profiles` deliberately awaits that listing so the composer and
   * Settings see one allowlist. A progressive row set needs the facts that are
   * already settled, so this returns them plus whether the existing coalesced
   * listing is still running. It starts no detection pass of its own.
   */
  agentListProfileStatus: 'agent:list-profile-status',
  agentRefreshModels: 'agent:refresh-models',
  agentListWorkingDirectories: 'agent:list-working-directories',
  agentSelectWorkingDirectory: 'agent:select-working-directory',
  agentStartSession: 'agent:start-session',
  agentResumeSession: 'agent:resume-session',
  agentStopSession: 'agent:stop-session',
  agentGetSession: 'agent:get-session',
  agentListSessions: 'agent:list-sessions',
  agentCopyResult: 'agent:copy-result',
  /** Explicit owner-to-owner session handoff after a window was destroyed. */
  agentClaimSession: 'agent:claim-session',
  agentIssueRiskGrant: 'agent:issue-risk-grant',
  agentGetEnvironmentReview: 'agent:get-environment-review',
  agentApplyChanges: 'agent:apply-changes',
  agentDiscardSandbox: 'agent:discard-sandbox',
  agentExportPatch: 'agent:export-patch',
  agentOpenFolder: 'agent:open-folder',
  agentGetModeAvailability: 'agent:get-mode-availability',
  agentSelectExecutable: 'agent:select-executable',
  agentListCustomProfiles: 'agent:list-custom-profiles',
  agentCreateCustomProfile: 'agent:create-custom-profile',
  agentUpdateCustomProfile: 'agent:update-custom-profile',
  agentDeleteCustomProfile: 'agent:delete-custom-profile',
  // Clipboard
  clipboardWriteText: 'clipboard:write-text',

  /**
   * Application updates from the pinned stable release destination. None of
   * these carries a payload: main owns the feed, the verified version, the
   * downloaded file and the restart barrier.
   */
  updatesGetState: 'updates:get-state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesRestart: 'updates:restart',
  updatesOpenReleasePage: 'updates:open-release-page',
} as const;
export const IPC_EVENTS = {
  appBeforeClose: 'app:before-close',
  appCloseReady: 'app:close-ready',
  libraryStorageHealthUpdated: 'library:storage-health-updated',
  /** A native menu command or an operating-system open request for the renderer to act on. */
  filesCommand: 'files:command',
  chatStreamEvent: 'chat:stream-event',
  chatSessionTitleChanged: 'chat:session-title-changed',
  agentEvent: 'agent:event',
  /** Main's latest application-update state projection. */
  updatesState: 'updates:state',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export const IPC_CHANNELS: readonly IpcChannel[] = Object.values(IPC);
