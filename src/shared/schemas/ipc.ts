import { z } from 'zod';
import { IPC, type IpcChannel } from '../constants/ipc';
import { appSettingsSchema, type AppSettings } from './settings';
import type { OnboardingLaunchState } from '../types/onboarding';
import type { SerializedInterleafError } from '../errors/interleaf-error';
import type { OpenRouterCredentialStatus } from './credential-preview';
import {
  createFolderRequestSchema,
  deleteDocumentRequestSchema,
  deleteFolderRequestSchema,
  documentFilterSchema,
  openDocumentRequestSchema,
  closeDocumentRequestSchema,
  importDroppedFilesRequestSchema,
  importWebArticleRequestSchema,
  limitQuerySchema,
  moveDocumentToFolderRequestSchema,
  documentImportOptionsSchema,
  renameFolderRequestSchema,
  updateReadingPositionRequestSchema,
  getDocumentPreviewRequestSchema,
} from './document';
import type {
  BatchImportResult,
  DocumentMetadata,
  OpenedDocument,
  Folder,
  FolderTree,
  LibrarySummary,
  ReadingPosition,
  DocumentPreviewData,
  WebArticleImportResult,
} from '../types/document';
import {
  createAnnotationRequestSchema,
  deleteAnnotationRequestSchema,
  listAnnotationsRequestSchema,
  repairAnnotationAnchorRequestSchema,
  updateAnnotationRequestSchema,
} from './annotation';
import type {
  Annotation,
  AnnotationPage,
} from '../types/annotation';
import {
  appendDocumentIndexRequestSchema,
  beginDocumentIndexRequestSchema,
  failDocumentIndexRequestSchema,
  finishDocumentIndexRequestSchema,
  getDocumentIndexStateRequestSchema,
  resolveSearchHitRequestSchema,
  searchRequestSchema,
} from './search';
import type {
  DocumentIndexState,
  IndexGeneration,
  SearchHit,
  SearchMatchAnchor,
} from '../types/search';
import {
  attachChatContextRequestSchema,
  cancelChatRequestSchema,
  cleanChatContextRequestSchema,
  configureOpenRouterRequestSchema,
  createChatSessionRequestSchema,
  credentialProviderRequestSchema,
  deleteChatSessionRequestSchema,
  getAIProviderStatusRequestSchema,
  getChatContextBudgetRequestSchema,
  getChatSessionRequestSchema,
  listChatContextRequestSchema,
  listChatMessagesRequestSchema,
  listChatSessionsRequestSchema,
  listOpenRouterModelsRequestSchema,
  listProvidersRequestSchema,
  removeChatContextRequestSchema,
  resolveChatCitationRequestSchema,
  sendChatMessageRequestSchema,
  updateChatSessionRequestSchema,
} from './ai';
import type {
  AIModelInfo,
  AIProviderStatus,
  ChatContextBudget,
  ChatContextItem,
  ChatMessage,
  ChatSession,
  CitationTarget,
  CleanChatContextResult,
  SendChatMessageResult,
} from '../types/ai';
import {
  agentSessionRequestSchema,
  agentDocumentSessionRequestSchema,
  agentStartRequestSchema,
  agentResumeRequestSchema,
  agentStopRequestSchema,
  agentSelectDirectoryRequestSchema,
  agentListSessionsRequestSchema,
  agentModeAvailabilityRequestSchema,
} from './agent';
import type {
  AgentCopyResultResult,
  AgentSessionClaimResult,
  AgentProfile,
  AgentProfileStatusSnapshot,
  AgentSession,
  AgentSessionDetail,
  AgentStartResult,
  AgentWorkingDirectory,
} from '../types/agent';
import type {
  AgentEnvironmentReviewResult,
  AgentModeAvailability,
  AgentOpenFolderResult,
  AgentPatchExportResult,
  AgentRiskGrant,
} from '../types/agent-environment';
import { agentRiskGrantRequestSchema } from './agent-environment';
import {
  createCustomAgentProfileRequestSchema,
  deleteCustomAgentProfileRequestSchema,
  selectAgentExecutableRequestSchema,
  updateCustomAgentProfileRequestSchema,
} from './custom-agent-profile';
import type { AgentExecutableSelection, CustomAgentProfile } from '../types/custom-agent-profile';
import { clipboardWriteTextRequestSchema } from './clipboard';
import { openExternalRequestSchema, type OpenExternalResult } from './external-link';
import type { ClipboardWriteResult } from '../types/clipboard';
import { mermaidRenderRequestSchema } from './mermaid';
import type { MermaidRenderResult } from '../types/mermaid';
import type { UpdateReleasePageResult, UpdateRestartResult, UpdateState } from './updates';

export type AppInfo = {
  name: string;
  tagline: string;
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  versions: {
    electron: string;
    node: string;
    chrome: string;
  };
};

/** Result of the main-owned native Save dialog debug-log export. */
export type DebugLogExportResult =
  | { status: 'cancelled' }
  | { status: 'success'; bytes: number; fileName: string };

/**
 * Runtime validation schemas per channel. `undefined` means the channel takes
 * no payload — the dispatcher rejects any non-undefined argument.
 */
export const ipcRequestSchemas = {
  [IPC.appGetInfo]: undefined,
  [IPC.appExportDebugLog]: undefined,
  [IPC.appOpenExternal]: openExternalRequestSchema,
  [IPC.settingsGet]: undefined,
  // settings:update carries the complete merged settings object: the renderer
  // loads current settings, applies local edits, and submits the full document.
  // This keeps validation total and avoids partial-merge races.
  [IPC.settingsUpdate]: appSettingsSchema,
  [IPC.onboardingGetLaunchState]: undefined,

  // Phase 3 — Library & Folder Management
  [IPC.libraryImportDroppedFiles]: importDroppedFilesRequestSchema,
  [IPC.libraryOpenFileDialog]: documentImportOptionsSchema,
  [IPC.libraryImportWebArticle]: importWebArticleRequestSchema,
  [IPC.libraryListDocuments]: documentFilterSchema,
  [IPC.libraryOpenDocument]: openDocumentRequestSchema,
  [IPC.libraryCloseDocument]: closeDocumentRequestSchema,
  [IPC.libraryDeleteDocument]: deleteDocumentRequestSchema,
  [IPC.libraryGetContinueReading]: limitQuerySchema,
  [IPC.libraryGetRecentlyAdded]: limitQuerySchema,
  [IPC.libraryGetRecentlyRead]: limitQuerySchema,
  [IPC.libraryGetSummary]: undefined,
  [IPC.libraryCreateFolder]: createFolderRequestSchema,
  [IPC.libraryRenameFolder]: renameFolderRequestSchema,
  [IPC.libraryDeleteFolder]: deleteFolderRequestSchema,
  [IPC.libraryListFolders]: undefined,
  [IPC.libraryGetFolderTree]: undefined,
  [IPC.libraryMoveDocumentToFolder]: moveDocumentToFolderRequestSchema,
  [IPC.libraryUpdateReadingPosition]: updateReadingPositionRequestSchema,
  [IPC.libraryGetDocumentPreview]: getDocumentPreviewRequestSchema,
  [IPC.filesOpenDialog]: undefined,
  [IPC.filesOpenPending]: undefined,
  [IPC.readerRenderMermaid]: mermaidRenderRequestSchema,
  // Phase 5 — Annotations & Highlights
  [IPC.annotationsCreate]: createAnnotationRequestSchema,
  [IPC.annotationsList]: listAnnotationsRequestSchema,
  [IPC.annotationsPage]: listAnnotationsRequestSchema,
  [IPC.annotationsUpdate]: updateAnnotationRequestSchema,
  [IPC.annotationsDelete]: deleteAnnotationRequestSchema,
  [IPC.annotationsRepairAnchor]: repairAnnotationAnchorRequestSchema,
  [IPC.searchBeginIndex]: beginDocumentIndexRequestSchema,
  [IPC.searchAppendIndex]: appendDocumentIndexRequestSchema,
  [IPC.searchCompleteIndex]: finishDocumentIndexRequestSchema,
  [IPC.searchFailIndex]: failDocumentIndexRequestSchema,
  [IPC.searchGetIndexState]: getDocumentIndexStateRequestSchema,
  [IPC.searchDocument]: searchRequestSchema.required({ documentId: true }),
  [IPC.searchResolveHit]: resolveSearchHitRequestSchema,
  [IPC.aiListProviders]: listProvidersRequestSchema,
  [IPC.aiGetProviderStatus]: getAIProviderStatusRequestSchema,
  [IPC.aiSignInWithChatGPT]: undefined,
  [IPC.aiListOpenRouterModels]: listOpenRouterModelsRequestSchema,
  [IPC.aiConfigureOpenRouter]: configureOpenRouterRequestSchema,
  [IPC.credentialsGetStatus]: credentialProviderRequestSchema,
  [IPC.credentialsClear]: credentialProviderRequestSchema,
  [IPC.credentialsTest]: credentialProviderRequestSchema,
  [IPC.chatCreateSession]: createChatSessionRequestSchema,
  [IPC.chatGetSession]: getChatSessionRequestSchema,
  [IPC.chatListSessions]: listChatSessionsRequestSchema,
  [IPC.chatUpdateSession]: updateChatSessionRequestSchema,
  [IPC.chatDeleteSession]: deleteChatSessionRequestSchema,
  [IPC.chatListMessages]: listChatMessagesRequestSchema,
  [IPC.chatListContext]: listChatContextRequestSchema,
  [IPC.chatGetContextBudget]: getChatContextBudgetRequestSchema,
  [IPC.chatAttachContext]: attachChatContextRequestSchema,
  [IPC.chatRemoveContext]: removeChatContextRequestSchema,
  [IPC.chatCleanContext]: cleanChatContextRequestSchema,
  [IPC.chatSendMessage]: sendChatMessageRequestSchema,
  [IPC.chatCancel]: cancelChatRequestSchema,
  [IPC.chatResolveCitation]: resolveChatCitationRequestSchema,
  [IPC.agentListProfiles]: undefined,
  [IPC.agentListProfileStatus]: undefined,
  [IPC.agentRefreshModels]: undefined,
  [IPC.agentListWorkingDirectories]: undefined,
  [IPC.agentSelectWorkingDirectory]: agentSelectDirectoryRequestSchema,
  [IPC.agentStartSession]: agentStartRequestSchema,
  [IPC.agentResumeSession]: agentResumeRequestSchema,
  [IPC.agentStopSession]: agentStopRequestSchema,
  [IPC.agentGetSession]: agentDocumentSessionRequestSchema,
  [IPC.agentListSessions]: agentListSessionsRequestSchema,
  [IPC.agentCopyResult]: agentSessionRequestSchema,
  [IPC.agentClaimSession]: agentSessionRequestSchema,
  [IPC.agentIssueRiskGrant]: agentRiskGrantRequestSchema,
  [IPC.agentGetEnvironmentReview]: agentSessionRequestSchema,
  [IPC.agentApplyChanges]: agentSessionRequestSchema,
  [IPC.agentDiscardSandbox]: agentSessionRequestSchema,
  [IPC.agentExportPatch]: agentSessionRequestSchema,
  [IPC.agentOpenFolder]: agentSessionRequestSchema,
  [IPC.agentGetModeAvailability]: agentModeAvailabilityRequestSchema,
  [IPC.agentSelectExecutable]: selectAgentExecutableRequestSchema,
  [IPC.agentListCustomProfiles]: undefined,
  [IPC.agentCreateCustomProfile]: createCustomAgentProfileRequestSchema,
  [IPC.agentUpdateCustomProfile]: updateCustomAgentProfileRequestSchema,
  [IPC.agentDeleteCustomProfile]: deleteCustomAgentProfileRequestSchema,
  [IPC.clipboardWriteText]: clipboardWriteTextRequestSchema,
  [IPC.updatesGetState]: undefined,
  [IPC.updatesCheck]: undefined,
  [IPC.updatesDownload]: undefined,
  [IPC.updatesRestart]: undefined,
  [IPC.updatesOpenReleasePage]: undefined,
} as const satisfies Readonly<Record<IpcChannel, z.ZodType | undefined>>;

/** Result type per channel. */
type IpcResults = {
  readonly [IPC.appGetInfo]: AppInfo;
  readonly [IPC.appExportDebugLog]: DebugLogExportResult;
  readonly [IPC.appOpenExternal]: OpenExternalResult;
  readonly [IPC.settingsGet]: AppSettings;
  readonly [IPC.settingsUpdate]: AppSettings;
  readonly [IPC.onboardingGetLaunchState]: OnboardingLaunchState;
  readonly [IPC.libraryImportDroppedFiles]: BatchImportResult;
  readonly [IPC.libraryOpenFileDialog]: BatchImportResult;
  readonly [IPC.libraryImportWebArticle]: WebArticleImportResult;
  readonly [IPC.libraryListDocuments]: readonly DocumentMetadata[];
  readonly [IPC.libraryOpenDocument]: OpenedDocument;
  readonly [IPC.libraryCloseDocument]: undefined;
  readonly [IPC.libraryDeleteDocument]: undefined;
  readonly [IPC.libraryGetContinueReading]: readonly DocumentMetadata[];
  readonly [IPC.libraryGetRecentlyAdded]: readonly DocumentMetadata[];
  readonly [IPC.libraryGetRecentlyRead]: readonly DocumentMetadata[];
  readonly [IPC.libraryGetSummary]: LibrarySummary;
  readonly [IPC.libraryCreateFolder]: Folder;
  readonly [IPC.libraryRenameFolder]: Folder;
  readonly [IPC.libraryDeleteFolder]: undefined;
  readonly [IPC.libraryListFolders]: readonly Folder[];
  readonly [IPC.libraryGetFolderTree]: readonly FolderTree[];
  readonly [IPC.libraryMoveDocumentToFolder]: undefined;
  readonly [IPC.libraryUpdateReadingPosition]: ReadingPosition;
  readonly [IPC.libraryGetDocumentPreview]: DocumentPreviewData;
  readonly [IPC.filesOpenDialog]: DocumentMetadata | null;
  readonly [IPC.filesOpenPending]: DocumentMetadata | null;
  readonly [IPC.readerRenderMermaid]: MermaidRenderResult;
  readonly [IPC.annotationsCreate]: Annotation;
  readonly [IPC.annotationsList]: readonly Annotation[];
  readonly [IPC.annotationsPage]: AnnotationPage;
  readonly [IPC.annotationsUpdate]: Annotation | null;
  readonly [IPC.annotationsDelete]: Annotation | null;
  readonly [IPC.annotationsRepairAnchor]: Annotation | null;
  readonly [IPC.searchBeginIndex]: IndexGeneration;
  readonly [IPC.searchAppendIndex]: DocumentIndexState;
  readonly [IPC.searchCompleteIndex]: DocumentIndexState;
  readonly [IPC.searchFailIndex]: DocumentIndexState;
  readonly [IPC.searchGetIndexState]: DocumentIndexState | null;
  readonly [IPC.searchDocument]: readonly SearchHit[];
  readonly [IPC.searchResolveHit]: SearchMatchAnchor | null;
  readonly [IPC.aiListProviders]: readonly AIProviderStatus[];
  readonly [IPC.aiGetProviderStatus]: AIProviderStatus;
  readonly [IPC.aiSignInWithChatGPT]: AIProviderStatus;
  readonly [IPC.aiListOpenRouterModels]: readonly AIModelInfo[];
  readonly [IPC.aiConfigureOpenRouter]: AppSettings;
  readonly [IPC.credentialsGetStatus]: OpenRouterCredentialStatus;
  readonly [IPC.credentialsClear]: OpenRouterCredentialStatus;
  readonly [IPC.credentialsTest]: { readonly success: boolean; readonly message?: string };
  readonly [IPC.chatCreateSession]: ChatSession;
  readonly [IPC.chatGetSession]: ChatSession | null;
  readonly [IPC.chatListSessions]: readonly ChatSession[];
  readonly [IPC.chatUpdateSession]: ChatSession;
  readonly [IPC.chatDeleteSession]: undefined;
  readonly [IPC.chatListMessages]: readonly ChatMessage[];
  readonly [IPC.chatListContext]: readonly ChatContextItem[];
  readonly [IPC.chatGetContextBudget]: ChatContextBudget | null;
  readonly [IPC.chatAttachContext]: ChatContextItem;
  readonly [IPC.chatRemoveContext]: undefined;
  readonly [IPC.chatCleanContext]: CleanChatContextResult;
  readonly [IPC.chatSendMessage]: SendChatMessageResult;
  readonly [IPC.chatCancel]: undefined;
  readonly [IPC.chatResolveCitation]: CitationTarget | null;
  readonly [IPC.agentListProfiles]: readonly AgentProfile[];
  readonly [IPC.agentListProfileStatus]: AgentProfileStatusSnapshot;
  readonly [IPC.agentRefreshModels]: readonly AgentProfile[];
  readonly [IPC.agentListWorkingDirectories]: readonly AgentWorkingDirectory[];
  readonly [IPC.agentSelectWorkingDirectory]: AgentWorkingDirectory | null;
  readonly [IPC.agentStartSession]: AgentStartResult;
  readonly [IPC.agentResumeSession]: AgentStartResult;
  readonly [IPC.agentStopSession]: undefined;
  readonly [IPC.agentGetSession]: AgentSessionDetail | null;
  readonly [IPC.agentListSessions]: readonly AgentSession[];
  readonly [IPC.agentCopyResult]: AgentCopyResultResult;
  readonly [IPC.agentClaimSession]: AgentSessionClaimResult;
  readonly [IPC.agentIssueRiskGrant]: AgentRiskGrant;
  readonly [IPC.agentGetEnvironmentReview]: AgentEnvironmentReviewResult | null;
  readonly [IPC.agentApplyChanges]: AgentEnvironmentReviewResult;
  readonly [IPC.agentDiscardSandbox]: undefined;
  readonly [IPC.agentExportPatch]: AgentPatchExportResult;
  readonly [IPC.agentOpenFolder]: AgentOpenFolderResult;
  readonly [IPC.agentGetModeAvailability]: readonly AgentModeAvailability[];
  readonly [IPC.agentSelectExecutable]: AgentExecutableSelection | null;
  readonly [IPC.agentListCustomProfiles]: readonly CustomAgentProfile[];
  readonly [IPC.agentCreateCustomProfile]: CustomAgentProfile;
  readonly [IPC.agentUpdateCustomProfile]: CustomAgentProfile;
  readonly [IPC.agentDeleteCustomProfile]: undefined;
  readonly [IPC.clipboardWriteText]: ClipboardWriteResult;
  readonly [IPC.updatesGetState]: UpdateState;
  readonly [IPC.updatesCheck]: UpdateState;
  readonly [IPC.updatesDownload]: UpdateState;
  readonly [IPC.updatesRestart]: UpdateRestartResult;
  readonly [IPC.updatesOpenReleasePage]: UpdateReleasePageResult;
};

type IpcRequestSchemas = typeof ipcRequestSchemas;

/**
 * Compile-time contract map: channel → request payload type → result type.
 * The preload bridge, the main-process dispatcher, and the renderer client
 * are all typed against this single source of truth. `request` is the channel
 * schema's input (what a caller may send) and `parsed` its output (what a
 * handler receives after defaults apply); a channel without a schema takes no
 * payload.
 */
export type IpcContracts = {
  readonly [K in IpcChannel]: {
    readonly request: IpcRequestSchemas[K] extends z.ZodType ? z.input<IpcRequestSchemas[K]> : undefined;
    readonly parsed: IpcRequestSchemas[K] extends z.ZodType ? z.output<IpcRequestSchemas[K]> : undefined;
    readonly result: IpcResults[K];
  };
};

/**
 * Envelope used for every invoke round-trip. Errors cross the bridge as plain
 * serialized payloads, never as raw Electron error objects.
 */
export type IpcResultEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SerializedInterleafError };

export function okEnvelope<T>(data: T): IpcResultEnvelope<T> {
  return { ok: true, data };
}
