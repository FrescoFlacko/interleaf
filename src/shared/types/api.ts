import type { AppInfo } from '../schemas/ipc';
import type { AppSettings } from '../schemas/settings';
import type { DebugLogExportResult } from '../schemas/ipc';
import type {
  BatchImportResult,
  DocumentFilter,
  DocumentImportOptions,
  DocumentLocation,
  DocumentMetadata,
  Folder,
  FolderTree,
  LibrarySummary,
  OpenedDocument,
  ReadingPosition,
  StorageHealthUpdate,
  DocumentPreviewData,
  WebArticleImportOutcome,
} from './document';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationPage,
  CreateAnnotationInput,
  RepairAnnotationAnchorInput,
  UpdateAnnotationInput,
} from './annotation';
import type {
  DocumentIndexState,
  IndexGeneration,
  SearchHit,
  SearchMatchAnchor,
  SearchIndexChunkInput,
} from './search';
import type {
  AIModelInfo,
  AIProviderId,
  AIProviderStatus,
  ChatContextAttachInput,
  ChatContextBudget,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatSessionTitleChangedEvent,
  ChatStreamEvent,
  CitationTarget,
  CleanChatContextResult,
  SendChatMessageResult,
} from './ai';
import type {
  AgentCopyResultResult,
  AgentSessionClaimResult,
  AgentEvent,
  AgentProfile,
  AgentProfileStatusSnapshot,
  AgentResumeRequest,
  AgentRunRequestInput,
  AgentSessionDetail,
  AgentSession,
  AgentStartResult,
  AgentWorkingDirectory,
} from './agent';
import type { OnboardingLaunchState } from './onboarding';
import type { UpdateReleasePageResult, UpdateRestartResult, UpdateState } from '../schemas/updates';
import type { FileCommand } from './files';
import type {
  AgentEnvironmentReviewResult,
  AgentOpenFolderResult,
  AgentPatchExportResult,
  AgentRiskGrant,
  AgentRiskGrantRequest,
  AgentModeAvailability,
} from './agent-environment';
import type {
  AgentExecutableSelection,
  CustomAgentProfile,
  CustomAgentProfileCreateInput,
  CustomAgentProfileUpdateInput,
} from './custom-agent-profile';
import type { ClipboardWriteResult } from './clipboard';
import type { MermaidRenderRequest, MermaidRenderResult } from './mermaid';
import type { OpenExternalResult } from '../schemas/external-link';
import type { OpenRouterCredentialStatus } from '../schemas/credential-preview';

/**
 * The narrow, typed API surface exposed to the renderer as
 * `window.interleafAPI`. No raw `ipcRenderer`, no Node primitives — every
 * method is a whitelisted domain operation (AGENTS.md §2).
 */
export type InterleafAPI = {
  readonly app: {
    getInfo(): Promise<AppInfo>;
    exportDebugLog(): Promise<DebugLogExportResult>;
    /**
     * Opens one absolute http/https link in the operating system's default
     * browser. The renderer never navigates: it names a target and main decides
     * whether that target may leave the application at all.
     */
    openExternal(url: string): Promise<OpenExternalResult>;
    onBeforeClose(callback: () => Promise<void> | void): () => void;
  };
  readonly settings: {
    get(): Promise<AppSettings>;
    update(next: AppSettings): Promise<AppSettings>;
  };
  readonly onboarding: {
    /**
     * The launch verdict main latched at startup. Read-only: the renderer
     * cannot classify a launch, and persisted onboarding progress is written
     * through `settings.update` like every other preference.
     */
    getLaunchState(): Promise<OnboardingLaunchState>;
  };
  readonly library: {
    importDroppedFiles(files: readonly File[], options?: DocumentImportOptions): Promise<BatchImportResult>;
    openFileDialog(options?: DocumentImportOptions): Promise<BatchImportResult>;
    importWebArticle(url: string, options?: DocumentImportOptions): Promise<WebArticleImportOutcome>;
    listDocuments(filter?: DocumentFilter): Promise<readonly DocumentMetadata[]>;
    openDocument(id: string): Promise<OpenedDocument>;
    closeDocument(id: string): Promise<void>;
    deleteDocument(id: string): Promise<void>;
    getContinueReading(limit?: number): Promise<readonly DocumentMetadata[]>;
    getRecentlyAdded(limit?: number): Promise<readonly DocumentMetadata[]>;
    getRecentlyRead(limit?: number): Promise<readonly DocumentMetadata[]>;
    getSummary(): Promise<LibrarySummary>;
    createFolder(name: string, parentId: string | null): Promise<Folder>;
    renameFolder(id: string, name: string): Promise<Folder>;
    deleteFolder(id: string): Promise<void>;
    listFolders(): Promise<readonly Folder[]>;
    getFolderTree(): Promise<readonly FolderTree[]>;
    moveDocumentToFolder(documentId: string, folderId: string | null): Promise<void>;
    updateReadingPosition(documentId: string, location: DocumentLocation, progress: number): Promise<ReadingPosition>;
    getDocumentPreview(documentId: string, location: DocumentLocation | null): Promise<DocumentPreviewData>;
    onStorageHealthUpdated(callback: (update: StorageHealthUpdate) => void): () => void;
  };
  /**
   * Reading one file without adding it to the library. Main chooses the path,
   * owns the file's records, and discards them when the file is closed.
   */
  readonly files: {
    openDialog(): Promise<DocumentMetadata | null>;
    openPending(): Promise<DocumentMetadata | null>;
    onCommand(callback: (command: FileCommand) => void): () => void;
  };
  readonly reader: {
    /**
     * Draws one fenced diagram. Never rejects for an undrawable diagram: the
     * failure is typed so the reader can show the fenced source instead.
     */
    renderMermaid(request: MermaidRenderRequest): Promise<MermaidRenderResult>;
  };
  readonly annotations: {
    create(input: CreateAnnotationInput): Promise<Annotation>;
    list(documentId: string, filter?: AnnotationFilter): Promise<readonly Annotation[]>;
    page(documentId: string, filter?: AnnotationFilter): Promise<AnnotationPage>;
    update(input: UpdateAnnotationInput): Promise<Annotation | null>;
    delete(documentId: string, id: string): Promise<Annotation | null>;
    repairAnchor(input: RepairAnnotationAnchorInput): Promise<Annotation | null>;
  };
  readonly search: {
    beginIndex(documentId: string, documentHash: string): Promise<IndexGeneration>;
    appendIndex(documentId: string, documentHash: string, generationId: string, chunks: readonly SearchIndexChunkInput[]): Promise<DocumentIndexState>;
    completeIndex(documentId: string, documentHash: string, generationId: string): Promise<DocumentIndexState>;
    failIndex(documentId: string, documentHash: string, generationId: string, errorMessage: string): Promise<DocumentIndexState>;
    getIndexState(documentId: string): Promise<DocumentIndexState | null>;
    searchDocument(documentId: string, query: string, limit?: number): Promise<readonly SearchHit[]>;
    resolveHit(documentId: string, documentHash: string, chunkId: string, query: string): Promise<SearchMatchAnchor | null>;
  };
  readonly ai: {
    listProviders(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIProviderStatus[]>;
    getProviderStatus(
      providerId: AIProviderId,
      options?: { readonly forceRefresh?: boolean }
    ): Promise<AIProviderStatus>;
    signInWithChatGPT(): Promise<AIProviderStatus>;
    listOpenRouterModels(options?: { readonly forceRefresh?: boolean }): Promise<readonly AIModelInfo[]>;
    configureOpenRouter(input: { readonly apiKey?: string; readonly removeKey?: boolean; readonly model: string }): Promise<AppSettings>;
  };
  readonly credentials: {
    getOpenRouterStatus(): Promise<OpenRouterCredentialStatus>;
    /**
     * Removes the stored OpenRouter credential at once and answers with the
     * masked status that replaces it. No secret or ciphertext crosses back.
     */
    clearOpenRouterKey(): Promise<OpenRouterCredentialStatus>;
    testOpenRouterConnection(): Promise<{ readonly success: boolean; readonly message?: string }>;
  };
  readonly chat: {
    createSession(input: ChatSessionCreateInput): Promise<ChatSession>;
    getSession(sessionId: string, documentId: string): Promise<ChatSession | null>;
    listSessions(documentId: string): Promise<readonly ChatSession[]>;
    updateSession(input: ChatSessionUpdateInput): Promise<ChatSession>;
    deleteSession(sessionId: string): Promise<void>;
    listMessages(sessionId: string): Promise<readonly ChatMessage[]>;
    listContext(sessionId: string): Promise<readonly ChatContextItem[]>;
    attachContext(input: {
      readonly sessionId: string;
      readonly documentId: string;
      readonly documentHash: string;
      readonly input: ChatContextAttachInput;
    }): Promise<ChatContextItem>;
    removeContext(sessionId: string, contextItemId: string): Promise<void>;
    /**
     * Sends one turn. `webSearch` opts that turn
     * into the bound provider's hosted search.
     */
    /**
     * Compacts this conversation: main summarises it with the session's own
     * provider and model, records the boundary it summarised through, and
     * removes every attached context item. The reply names what changed; the
     * summary text stays in main.
     */
    cleanContext(sessionId: string): Promise<CleanChatContextResult>;
    sendMessage(sessionId: string, content: string, currentLocation?: DocumentLocation | null, webSearch?: boolean): Promise<SendChatMessageResult>;
    cancel(requestId: string): Promise<void>;
    resolveCitation(sessionId: string, messageId: string, sourceId: string): Promise<CitationTarget | null>;
    /**
     * Main-owned accounting for the last request this session packed, or `null`
     * when there is none under its current binding. Schema-validated in preload.
     */
    getContextBudget(sessionId: string): Promise<ChatContextBudget | null>;
    onStreamEvent(callback: (event: ChatStreamEvent) => void): () => void;
    /** A conversation's title was renamed automatically; re-read it by id. Schema-validated in preload. */
    onSessionTitleChanged(callback: (event: ChatSessionTitleChangedEvent) => void): () => void;
  };
  readonly agent: {
    listProfiles(): Promise<readonly AgentProfile[]>;
    /**
     * Detection facts that have already settled, without waiting for the
     * background model listing `listProfiles` blocks on. Starts nothing; the
     * returned flag says whether that existing listing is still running.
     */
    listProfileStatus(): Promise<AgentProfileStatusSnapshot>;
    /** Re-probes the installed CLIs for the models they accept. */
    refreshModels(): Promise<readonly AgentProfile[]>;
    listWorkingDirectories(): Promise<readonly AgentWorkingDirectory[]>;
    selectWorkingDirectory(): Promise<AgentWorkingDirectory | null>;
    startSession(request: AgentRunRequestInput): Promise<AgentStartResult>;
    resumeSession(request: AgentResumeRequest): Promise<AgentStartResult>;
    stopSession(sessionId: string): Promise<void>;
    getSession(sessionId: string, documentId: string): Promise<AgentSessionDetail | null>;
    listSessions(documentId: string): Promise<readonly AgentSession[]>;
    copyResult(sessionId: string): Promise<AgentCopyResultResult>;
    /** Take over a session whose owning window was destroyed (item C). */
    claimSession(sessionId: string): Promise<AgentSessionClaimResult>;
    issueRiskGrant(request: AgentRiskGrantRequest): Promise<AgentRiskGrant>;
    getEnvironmentReview(sessionId: string): Promise<AgentEnvironmentReviewResult | null>;
    applyChanges(sessionId: string): Promise<AgentEnvironmentReviewResult>;
    discardSandbox(sessionId: string): Promise<void>;
    exportPatch(sessionId: string): Promise<AgentPatchExportResult>;
    openFolder(sessionId: string): Promise<AgentOpenFolderResult>;
    getModeAvailability(profileId: string | null): Promise<readonly AgentModeAvailability[]>;
    selectExecutable(): Promise<AgentExecutableSelection | null>;
    listCustomProfiles(): Promise<readonly CustomAgentProfile[]>;
    createCustomProfile(input: CustomAgentProfileCreateInput): Promise<CustomAgentProfile>;
    updateCustomProfile(input: CustomAgentProfileUpdateInput): Promise<CustomAgentProfile>;
    deleteCustomProfile(id: string): Promise<void>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };
  readonly clipboard: {
    writeText(text: string): Promise<ClipboardWriteResult>;
  };
  /**
   * Application updates from the pinned stable release destination. The
   * renderer reads main's state and asks for fixed operations; it never names
   * a feed, a file, a version or a command.
   */
  readonly updates: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    /** Starts the download of the verified available update; progress arrives through `onState`. */
    download(): Promise<UpdateState>;
    /** Main refuses while agent, chat or import work is running and never forces a restart. */
    restart(): Promise<UpdateRestartResult>;
    openReleasePage(): Promise<UpdateReleasePageResult>;
    onState(callback: (state: UpdateState) => void): () => void;
  };
};

declare global {
  /**
   * Preload installs the bridge as a property of the global object, so the
   * renderer sees it as `window.interleafAPI`: `lib.dom` types `window` as
   * `Window & typeof globalThis`, and this declaration is the `typeof
   * globalThis` half. The main window always loads the preload, so the bridge
   * is required; `src/renderer/app/api-client.ts` is the only renderer module
   * that reads it and verifies it once at startup.
   */
  var interleafAPI: InterleafAPI;
}
