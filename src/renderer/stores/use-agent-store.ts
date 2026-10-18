import { create } from 'zustand';
import { reportRejection } from '@shared/models/caught-error';
import type { AgentContextPacket, AgentEvent, AgentProfile, AgentSession, AgentSessionDetail, AgentSessionStatus, AgentWorkingDirectory } from '@shared/types/agent';
import type { AgentExecutionMode } from '@shared/constants/agent-modes';
import type { DocumentAnchor } from '@shared/types/annotation';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import type { InterleafAPI } from '@shared/types/api';
import type { AgentModeAvailability } from '@shared/types/agent-environment';
import type { AppSettings } from '@shared/schemas/settings';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH, AGENT_MAX_SURROUNDING_TEXT_LENGTH } from '@shared/schemas/agent';
import { fitAgentContextPacketToByteBudget, takeCodePointPrefix } from '@shared/agent-context';
import type { ReaderSelection } from '../features/reader/types';
import { selectActiveDocument, useReaderStore } from './use-reader-store';
import { anchorToLocation } from './agent-anchor-location';
import { nextAgentContextRevision } from './agent-context-attach';
import { recordAgentFollowUp } from './agent-follow-up-drafts';
import { beginRunAttempt, runAttemptOf, withDiscarded } from './agent-run-attempts';
import { discardOriginHolds, type AgentDiscardOrigin } from './agent-discard-origin';
import { createContextActions, type AgentContextActions, type AgentPendingContext } from './agent-context-actions';
import { bridge, flushPendingSettingsWrites } from '../app/api-client';
let agentEventUnsubscribe: (() => void) | null = null;
let hydrateGeneration = 0;
let modeAvailabilityGeneration = 0;
let profileRefreshGeneration = 0;
let profileDataLoadGeneration = 0;
// Bumped whenever the reader chooses what the panel shows — open, close, start,
// resume or a book change. A late run result may update the session list, but
// only takes focus while no newer choice has been made.
let sessionFocusRevision = 0;
// Whoever set `loading` last — a hydrate, start or resume — is the one that clears it.
let loadingTurn = 0;

/** Clears `loading` only for the turn that set it last. */
function releaseLoading(turn: number): { loading?: false } {
  return turn === loadingTurn ? { loading: false } : {};
}
const pendingEvents = new Map<string, AgentEvent[]>();
// A cancellation acknowledgement is emitted before the adapter consumer has
// reaped its process and persisted the closing `ended` event. Keep this
// process-local marker so switching sessions or hydrating during that window
// does not make the Stop action available again. It is intentionally not
// reconstructed from durable history after an application restart.
const stoppingSessionIds = new Set<string>();
const terminalEnvironmentRefreshes = new Map<string, symbol>();
let environmentRefreshGeneration = 0;
let profileSelectionRevision = 0;
let directorySelectionRequestRevision = 0;
let directorySelectionCompletionRevision = 0;
let workingDirectorySettingsSyncGeneration = 0;
let workingDirectorySettingsSyncSettledGeneration = 0;
let workingDirectorySettingsSyncAppliedGeneration = 0;
const TERMINAL_ENVIRONMENT_REFRESH_ATTEMPTS = 50;
const TERMINAL_ENVIRONMENT_REFRESH_DELAY_MS = 20;

export type WorkingDirectorySelectionSource = 'profile-default' | 'global-default' | 'session-override' | 'none';

type AgentState = AgentContextActions & {
  documentId: string | null;
  profiles: readonly AgentProfile[];
  modeAvailability: readonly AgentModeAvailability[];
  selectedProfileId: string | null;
  /** `null` means "use the profile's configured default model". Any non-null
   * value is always one of the selected profile's `availableModels`. */
  selectedModel: string | null;
  workingDirectory: AgentWorkingDirectory | null;
  workingDirectories: readonly AgentWorkingDirectory[];
  workingDirectorySource: WorkingDirectorySelectionSource;
  workingDirectoryDefaults: Readonly<Record<string, string>>;
  globalDefaultWorkingDirectory: string | null;
  contextPacket: AgentContextPacket | null;
  pendingContext: AgentPendingContext | null;
  sessions: readonly AgentSession[];
  activeSession: AgentSessionDetail | null;
  events: readonly AgentEvent[];
  loading: boolean;
  /** A start or resume is in flight. Unlike `loading`, a refresh never sets it. */
  launching: boolean;
  stopping: boolean;
  error: string | null;
  hydrated: boolean;
  hydrate(documentId?: string | null): Promise<void>;
  setDocument(documentId: string | null): Promise<void>;
  refreshProfiles(): Promise<void>;
  selectWorkingDirectory(): Promise<void>;
  syncWorkingDirectorySettings(settings: AppSettings): Promise<void>;
  setSelection(document: DocumentMetadata, anchor: DocumentAnchor, selectedText: string, location?: DocumentLocation, surroundingText?: string | null): void;
  attachSelection(document: DocumentMetadata, selection: ReaderSelection): void;
  clearSelection(): void;
  clearContextPacket(): void;
  start(profileId: string, executionMode: AgentExecutionMode, prompt: string): Promise<boolean>;
  resume(prompt: string): Promise<boolean>;
  stop(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  deselectSession(): void;
  copyResult(): Promise<{ readonly copied: boolean; readonly characterCount: number } | null>;
  refreshEnvironment(): Promise<void>;
  applyChanges(): Promise<void>;
  /** Discards only the exact review the reader confirmed, checked against this store just before main; anything else is refused. */
  discardSandbox(origin: AgentDiscardOrigin): Promise<'refused' | 'failed' | 'discarded'>;
  /** Resolves to a status to show the reader, or null when the export failed. */
  exportPatch(): Promise<string | null>;
  openFolder(): Promise<void>;
  setSelectedProfile: (id: string) => void;
  setSelectedModel: (model: string | null) => void;
};

export const useAgentStore = create<AgentState>((set, get) => {
  const refreshEnvironmentForSession = async (api: InterleafAPI['agent'], sessionId: string, refreshGeneration: number): Promise<void> => {
    if (get().activeSession?.id !== sessionId || refreshGeneration !== environmentRefreshGeneration) return;
    const documentId = get().documentId;
    if (documentId === null) return;
    try {
      const result = await api.getEnvironmentReview(sessionId);
      if (result?.sessionId !== sessionId) return;
      const detail = await api.getSession(sessionId, documentId);
      if (detail === null || get().activeSession?.id !== sessionId || refreshGeneration !== environmentRefreshGeneration) return;
      const environment = { ...result.review, sessionId };
      const updated = { ...detail, environment };
      set({ activeSession: updated, events: detail.events, sessions: get().sessions.map((item) => item.id === sessionId ? updated : item) });
    } catch (error) {
      if (get().activeSession?.id === sessionId && refreshGeneration === environmentRefreshGeneration) {
        set({ error: error instanceof Error ? error.message : 'Could not refresh environment review.' });
      }
    }
  };

  /**
   * Ask main for ownership of a session this window did not start (item C).
   * Main grants it only when the previous owner's window was destroyed and its
   * work has drained; a refusal is expected and not an error to show, since the
   * session stays readable and its owner-bound actions keep rejecting.
   */
  const claimSessionOwnership = async (api: InterleafAPI['agent'], sessionId: string): Promise<void> => {
    try { await api.claimSession(sessionId); } catch { /* another window still owns it */ }
  };

  const refreshEnvironmentAfterTerminal = async (api: InterleafAPI['agent'], sessionId: string): Promise<void> => {
    const refreshGeneration = ++environmentRefreshGeneration;
    for (let attempt = 0; attempt < TERMINAL_ENVIRONMENT_REFRESH_ATTEMPTS; attempt += 1) {
      if (get().activeSession?.id !== sessionId || refreshGeneration !== environmentRefreshGeneration) return;
      const documentId = get().documentId;
      if (documentId === null) return;
      const detail = await api.getSession(sessionId, documentId);
      if (detail === null) return;
      if (isTerminalSessionStatus(detail.status)) {
        await refreshEnvironmentForSession(api, sessionId, refreshGeneration);
        return;
      }
      await delay(TERMINAL_ENVIRONMENT_REFRESH_DELAY_MS);
    }
  };

  const scheduleTerminalEnvironmentRefresh = (api: InterleafAPI['agent'], sessionId: string): void => {
    if (terminalEnvironmentRefreshes.has(sessionId)) return;
    const refreshToken = Symbol(sessionId);
    terminalEnvironmentRefreshes.set(sessionId, refreshToken);
    void reportRejection(refreshEnvironmentAfterTerminal(api, sessionId), (caught) => {
      if (terminalEnvironmentRefreshes.get(sessionId) === refreshToken && get().activeSession?.id === sessionId) {
        set({ error: caught === null ? 'Could not refresh environment review.' : caught.message });
      }
    })
      .finally(() => {
        // A resumed session or a later event may have installed a newer
        // refresh while this one was unwinding. Never remove that newer job.
        if (terminalEnvironmentRefreshes.get(sessionId) === refreshToken) {
          terminalEnvironmentRefreshes.delete(sessionId);
        }
      });
  };

  /**
   * Records a started or resumed run under the book that owns it. It always
   * joins that book's list, so it stays recoverable, but takes focus only if
   * the reader has not opened, closed or switched anything since the click.
   */
  const landRun = (api: InterleafAPI['agent'], documentId: string, attempt: Attempt, session: AgentSessionDetail): void => {
    if (get().documentId !== documentId) return;
    const replay = mergeEvents([...session.events, ...(pendingEvents.get(session.id) ?? [])]);
    // Main-owned status is authoritative at this hydration boundary. A fast
    // start/resume may not have persisted its new `started` event yet while
    // the detail still contains the prior run's terminal history.
    const reconciled = reconcileSession(session, replay);
    const sessions = [reconciled, ...get().sessions.filter((item) => item.id !== session.id)];
    const loading = releaseLoading(attempt.turn);
    if (attempt.focus !== sessionFocusRevision) {
      set({ sessions, ...loading });
      return;
    }
    pendingEvents.delete(session.id);
    set({ activeSession: reconciled, events: replay, stopping: false, sessions, ...loading });
    if (isTerminalSessionStatus(reconciled.status) && replay.some((event) => event.type === 'ended' || event.type === 'error')) {
      scheduleTerminalEnvironmentRefresh(api, session.id);
    }
  };

  /** A failed start or resume reports only to the run the panel still shows, and only on its book. */
  const settleFailedAttempt = (documentId: string, attempt: Attempt, error: string): void => {
    if (get().documentId !== documentId) return;
    set({
      ...releaseLoading(attempt.turn),
      ...(attempt.focus === sessionFocusRevision ? { stopping: false, error } : {}),
    });
  };

  /**
   * Context belongs to one book. Closing it or opening another invalidates any
   * capture or run result still in flight for it, and drops an attachment from
   * another book. Returns the state change that drop needs.
   */
  const leaveDocument = (previousDocId: string | null, nextDocId: string | null): { contextPacket?: null; pendingContext?: null } => {
    if (nextDocId === previousDocId) return {};
    nextAgentContextRevision();
    ++sessionFocusRevision;
    const packet = get().contextPacket;
    return { pendingContext: null, ...(packet !== null && packet.document.id !== nextDocId ? { contextPacket: null } : {}) };
  };

  /**
   * Whether a late action result still belongs to what the panel shows: the
   * same session, on the same book, in the same run of it.
   */
  const showsAttempt = (sessionId: string, documentId: string, attempt: number): boolean =>
    get().activeSession?.id === sessionId && get().documentId === documentId && runAttemptOf(sessionId) === attempt;

  const landActionResult = (documentId: string, attempt: number, detail: AgentSessionDetail): void => {
    if (get().documentId !== documentId || runAttemptOf(detail.id) !== attempt) return;
    const sessions = get().sessions.map((item) => item.id === detail.id ? detail : item);
    if (showsAttempt(detail.id, documentId, attempt)) set({ activeSession: detail, events: detail.events, sessions });
    else set({ sessions });
  };

  return ({
  profiles: [],
  modeAvailability: [],
  selectedProfileId: null,
  selectedModel: null,
  workingDirectory: null,
  workingDirectories: [],
  workingDirectorySource: 'none',
  workingDirectoryDefaults: {},
  globalDefaultWorkingDirectory: null,
  contextPacket: null,
  pendingContext: null,
  documentId: null,
  sessions: [],
  activeSession: null,
  events: [],
  loading: false,
  launching: false,
  stopping: false,
  error: null,
  hydrated: false,
  setDocument: async (documentId) => {
    await get().hydrate(documentId);
  },
  hydrate: async (targetDocumentId?: string | null) => {
    const api = bridge.agent;
    const generation = ++hydrateGeneration;
    const profileLoadGeneration = ++profileDataLoadGeneration;
    const profileRevisionAtStart = profileSelectionRevision;
    const pickerCompletionRevisionAtStart = directorySelectionCompletionRevision;
    const settingsSyncGenerationAtStart = workingDirectorySettingsSyncGeneration;
    const settingsSyncAppliedGenerationAtStart = workingDirectorySettingsSyncAppliedGeneration;

    const previousDocId = get().documentId;
    const activeDocId = selectActiveDocument(useReaderStore.getState())?.id ?? null;
    const resolvedDocumentId = targetDocumentId !== undefined
      ? targetDocumentId
      : (previousDocId ?? activeDocId);
    const documentChanged = previousDocId !== null && targetDocumentId !== undefined && targetDocumentId !== previousDocId;

    const packetReset = leaveDocument(previousDocId, resolvedDocumentId);
    if (documentChanged) {
      // A pending session load or action result belongs to the previous book.
      ++environmentRefreshGeneration;
      set({
        documentId: resolvedDocumentId,
        sessions: [],
        activeSession: null,
        events: [],
        stopping: false,
        ...packetReset,
      });
    } else if (resolvedDocumentId !== previousDocId) {
      const current = get();
      const shouldClearActive = current.activeSession !== null && resolvedDocumentId !== null && current.activeSession.documentId !== resolvedDocumentId;
      set({
        documentId: resolvedDocumentId,
        ...(shouldClearActive ? { activeSession: null, events: [] } : {}),
        ...packetReset,
      });
    }
    const turn = ++loadingTurn;
    set({ loading: true, error: null });
    try {
      const [profiles, sessions, workingDirectories, loadedSettings] = await Promise.all([
        api.listProfiles(),
        resolvedDocumentId !== null
          ? api.listSessions(resolvedDocumentId)
          : Promise.resolve<readonly AgentSession[]>([]),
        api.listWorkingDirectories(),
        bridge.settings.get(),
      ]);
      if (generation !== hydrateGeneration) return;
      if (resolvedDocumentId !== null && get().documentId !== resolvedDocumentId) return;
      agentEventUnsubscribe ??= api.onEvent((event) => {
          const active = get().activeSession;
          if (active?.id !== event.sessionId) {
            const pending = pendingEvents.get(event.sessionId) ?? [];
            pending.push(event);
            pendingEvents.set(event.sessionId, pending.slice(-500));
            while (pendingEvents.size > 32) {
              const first = pendingEvents.keys().next().value;
              if (typeof first !== 'string') break;
              pendingEvents.delete(first);
            }
            if (event.type === 'ended' || event.type === 'error') stoppingSessionIds.delete(event.sessionId);
            set((state) => ({ sessions: state.sessions.map((session) => session.id === event.sessionId ? applySummaryEvent(session, event, pending) : session) }));
            return;
          }
          set((state) => applyLiveEvent(state, event));
          if (event.type === 'ended' || event.type === 'error') scheduleTerminalEnvironmentRefresh(api, event.sessionId);
      });
      const currentBeforeMode = get();
      const provisionalIsLatestProfileLoad = profileLoadGeneration === profileDataLoadGeneration;
      const provisionalProfiles = provisionalIsLatestProfileLoad ? profiles : currentBeforeMode.profiles;
      const fallbackProfileIdBeforeMode = initialDraftProfileId(
        provisionalProfiles,
        loadedSettings.agent.defaultProfileId
      );
      const selectedProfileAtStart = currentBeforeMode.selectedProfileId;
      const selectedProfileIdForMode = selectedProfileAtStart !== null && provisionalProfiles.some((profile) => profile.id === selectedProfileAtStart)
        ? selectedProfileAtStart
        : fallbackProfileIdBeforeMode;
      const modeAvailability = provisionalIsLatestProfileLoad ? await api.getModeAvailability(selectedProfileIdForMode) : currentBeforeMode.modeAvailability;
      if (generation !== hydrateGeneration) return;
      const current = get();
      const isLatestProfileLoad = profileLoadGeneration === profileDataLoadGeneration;
      const resolvedProfiles = isLatestProfileLoad ? profiles : current.profiles;
      const fallbackProfileId = initialDraftProfileId(resolvedProfiles, loadedSettings.agent.defaultProfileId);
      const profileChangedDuringHydrate = profileSelectionRevision !== profileRevisionAtStart;
      const pickerCompletedDuringHydrate = directorySelectionCompletionRevision !== pickerCompletionRevisionAtStart;
      const syncStartedDuringHydrate = workingDirectorySettingsSyncGeneration !== settingsSyncGenerationAtStart;
      const syncAppliedDuringHydrate = workingDirectorySettingsSyncAppliedGeneration !== settingsSyncAppliedGenerationAtStart;
      const syncInFlight = workingDirectorySettingsSyncGeneration > workingDirectorySettingsSyncSettledGeneration;
      const settingsSyncInProgressOrChanged = syncStartedDuringHydrate || syncAppliedDuringHydrate || syncInFlight;
      const selectedProfileId = profileChangedDuringHydrate
        ? (current.selectedProfileId !== null && resolvedProfiles.some((profile) => profile.id === current.selectedProfileId) ? current.selectedProfileId : fallbackProfileId)
        : isLatestProfileLoad
        ? (current.selectedProfileId !== null && resolvedProfiles.some((profile) => profile.id === current.selectedProfileId) ? current.selectedProfileId : selectedProfileIdForMode !== null && resolvedProfiles.some((profile) => profile.id === selectedProfileIdForMode) ? selectedProfileIdForMode : fallbackProfileId)
        : (current.selectedProfileId !== null && resolvedProfiles.some((profile) => profile.id === current.selectedProfileId) ? current.selectedProfileId : fallbackProfileId);
      const selectedProfileChanged = selectedProfileId !== current.selectedProfileId;
      if (selectedProfileChanged) {
        profileSelectionRevision += 1;
      }
      const profileSelectionChangedDuringHydrate = profileChangedDuringHydrate && !selectedProfileChanged;
      const currentDirectoryIsAuthoritative = current.workingDirectory !== null
        && workingDirectories.some((directory) => directory.handle === current.workingDirectory?.handle);
      const preserveSessionOverride = !selectedProfileChanged
        && current.workingDirectorySource === 'session-override'
        && (currentDirectoryIsAuthoritative || pickerCompletedDuringHydrate);
      const effectiveWorkingDirectories = preserveSessionOverride && current.workingDirectory !== null && !currentDirectoryIsAuthoritative
        ? [...workingDirectories, current.workingDirectory]
        : workingDirectories;
      const resolvedWorkingDirectories = (settingsSyncInProgressOrChanged && !selectedProfileChanged) ? current.workingDirectories : effectiveWorkingDirectories;
      const resolvedWorkingDirectoryDefaults = (settingsSyncInProgressOrChanged && !selectedProfileChanged)
        ? current.workingDirectoryDefaults
        : loadedSettings.agent.defaultWorkingDirectoryByProfile;
      const globalDefault = (settingsSyncInProgressOrChanged && !selectedProfileChanged)
        ? current.globalDefaultWorkingDirectory
        : (loadedSettings.agent.defaultWorkingDirectory ?? null);
      const resolvedDefault = selectedProfileChanged
        ? resolveWorkingDirectoryDefault(selectedProfileId, resolvedWorkingDirectories, resolvedWorkingDirectoryDefaults, globalDefault)
        : (profileSelectionChangedDuringHydrate || settingsSyncInProgressOrChanged || preserveSessionOverride)
        ? { directory: current.workingDirectory, source: current.workingDirectorySource }
        : resolveWorkingDirectoryDefault(selectedProfileId, resolvedWorkingDirectories, resolvedWorkingDirectoryDefaults, globalDefault);
      const profileDefault = resolvedDefault.directory;
      const resolvedWorkingDirectorySource = selectedProfileChanged
        ? resolvedDefault.source
        : (profileSelectionChangedDuringHydrate || settingsSyncInProgressOrChanged)
        ? current.workingDirectorySource
        : preserveSessionOverride
        ? 'session-override'
        : resolvedDefault.source;
      const resolvedModeAvailability = (!isLatestProfileLoad || profileChangedDuringHydrate)
        ? current.modeAvailability
        : modeAvailability;
      const runningSession = sessions.find((s) => s.status === 'running' || s.status === 'queued' || s.status === 'waiting');
      let activeDetail: AgentSessionDetail | null = current.activeSession;
      let activeEvents: readonly AgentEvent[] = current.events;
      if (activeDetail !== null && resolvedDocumentId !== null && activeDetail.documentId !== resolvedDocumentId) {
        activeDetail = null;
        activeEvents = [];
      }
      if (runningSession && current.activeSession?.id !== runningSession.id) {
        if (resolvedDocumentId === null) return;
        await claimSessionOwnership(api, runningSession.id);
        activeDetail = await api.getSession(runningSession.id, resolvedDocumentId);
        if (generation !== hydrateGeneration || get().documentId !== resolvedDocumentId) return;
        activeEvents = activeDetail?.events ?? [];
      }
      const hydratedStopping = activeDetail !== null && activeDetail.id === current.activeSession?.id
        ? shouldKeepStopping(current.stopping || stoppingSessionIds.has(activeDetail.id), activeDetail, activeEvents)
        : false;
      if (activeDetail !== null && !hydratedStopping) stoppingSessionIds.delete(activeDetail.id);
      set({
        documentId: resolvedDocumentId,
        profiles: resolvedProfiles,
        selectedProfileId,
        selectedModel: reconcileSelectedModel(resolvedProfiles, selectedProfileId, current.selectedModel),
        modeAvailability: resolvedModeAvailability,
        sessions,
        activeSession: activeDetail,
        events: activeEvents,
        workingDirectories: resolvedWorkingDirectories,
        workingDirectoryDefaults: resolvedWorkingDirectoryDefaults,
        globalDefaultWorkingDirectory: globalDefault,
        workingDirectory: profileDefault,
        workingDirectorySource: resolvedWorkingDirectorySource,
        ...releaseLoading(turn),
        stopping: hydratedStopping,
        hydrated: true,
      });
    } catch (error) {
      if (generation === hydrateGeneration) set({ ...releaseLoading(turn), error: error instanceof Error ? error.message : 'Could not load agent runtime.' });
    }
  },

  refreshProfiles: async () => {
    const api = bridge.agent;
    const generation = ++profileRefreshGeneration;
    const profileLoadGeneration = ++profileDataLoadGeneration;
    const profileRevisionAtStart = profileSelectionRevision;
    try {
      const profiles = await api.listProfiles();
      if (generation !== profileRefreshGeneration || profileLoadGeneration !== profileDataLoadGeneration) return;
      const fallbackProfileId = initialDraftProfileId(profiles, null);
      const currentId = get().selectedProfileId;
      const selectedProfileIdAtStart = currentId !== null && profiles.some((profile) => profile.id === currentId)
        ? currentId
        : fallbackProfileId;
      const modeAvailability = await api.getModeAvailability(selectedProfileIdAtStart);
      if (generation !== profileRefreshGeneration || profileLoadGeneration !== profileDataLoadGeneration) return;
      const current = get();
      const profileChangedDuringRefresh = profileSelectionRevision !== profileRevisionAtStart;
      const selectedProfileId = profileChangedDuringRefresh
        ? (current.selectedProfileId !== null && profiles.some((profile) => profile.id === current.selectedProfileId) ? current.selectedProfileId : fallbackProfileId)
        : selectedProfileIdAtStart;
      const selectedProfileChanged = selectedProfileId !== current.selectedProfileId;
      if (selectedProfileChanged) {
        profileSelectionRevision += 1;
      }
      const resolvedDefault = selectedProfileChanged
        ? resolveWorkingDirectoryDefault(selectedProfileId, current.workingDirectories, current.workingDirectoryDefaults, current.globalDefaultWorkingDirectory)
        : { directory: current.workingDirectory, source: current.workingDirectorySource };
      const profileDefault = resolvedDefault.directory;
      const resolvedWorkingDirectorySource = selectedProfileChanged
        ? resolvedDefault.source
        : current.workingDirectorySource;
      set({
        profiles,
        selectedProfileId,
        selectedModel: reconcileSelectedModel(profiles, selectedProfileId, current.selectedModel),
        modeAvailability: profileChangedDuringRefresh ? current.modeAvailability : modeAvailability,
        workingDirectory: profileDefault,
        workingDirectorySource: resolvedWorkingDirectorySource,
        error: null,
      });
    } catch (error) {
      if (generation === profileRefreshGeneration && profileLoadGeneration === profileDataLoadGeneration) {
        set({ error: error instanceof Error ? error.message : 'Could not refresh agent profiles.' });
      }
    }
  },

  selectWorkingDirectory: async () => {
    const api = bridge.agent;
    const requestRevision = ++directorySelectionRequestRevision;
    const profileIdAtStart = get().selectedProfileId;
    const profileRevisionAtStart = profileSelectionRevision;
    try {
      const workingDirectory = await api.selectWorkingDirectory();
      if (
        workingDirectory !== null
        && requestRevision === directorySelectionRequestRevision
        && profileRevisionAtStart === profileSelectionRevision
        && profileIdAtStart === get().selectedProfileId
      ) {
        directorySelectionCompletionRevision += 1;
        const known = get().workingDirectories.some((directory) => directory.handle === workingDirectory.handle);
        set({
          workingDirectory,
          workingDirectories: known ? get().workingDirectories : [...get().workingDirectories, workingDirectory],
          workingDirectorySource: 'session-override',
          error: null,
        });
      }
    } catch (error) {
      if (requestRevision === directorySelectionRequestRevision) {
        set({ error: error instanceof Error ? error.message : 'Could not select a working directory.' });
      }
    }
  },

  syncWorkingDirectorySettings: async (settings) => {
    const api = bridge.agent;
    const syncGeneration = ++workingDirectorySettingsSyncGeneration;
    const pickerCompletionRevisionAtStart = directorySelectionCompletionRevision;
    try {
      const workingDirectories = await api.listWorkingDirectories();
      if (syncGeneration !== workingDirectorySettingsSyncGeneration) return;
      const current = get();
      const isKnown = current.workingDirectory !== null
        && workingDirectories.some((directory) => directory.handle === current.workingDirectory?.handle);
      const isSessionOverride = current.workingDirectorySource === 'session-override' && current.workingDirectory !== null;
      const pickerCompletedDuringSync = directorySelectionCompletionRevision !== pickerCompletionRevisionAtStart;
      const preserveSessionOverride = isSessionOverride && (isKnown || pickerCompletedDuringSync);
      const effectiveWorkingDirectories = preserveSessionOverride && !isKnown && current.workingDirectory !== null
        ? [...workingDirectories, current.workingDirectory]
        : workingDirectories;
      const globalDefault = settings.agent.defaultWorkingDirectory ?? null;
      const resolvedDefault = preserveSessionOverride
        ? { directory: current.workingDirectory, source: 'session-override' as const }
        : resolveWorkingDirectoryDefault(current.selectedProfileId, effectiveWorkingDirectories, settings.agent.defaultWorkingDirectoryByProfile, globalDefault);
      const profileDefault = resolvedDefault.directory;
      set({
        workingDirectories: effectiveWorkingDirectories,
        workingDirectoryDefaults: settings.agent.defaultWorkingDirectoryByProfile,
        globalDefaultWorkingDirectory: globalDefault,
        workingDirectory: profileDefault,
        workingDirectorySource: preserveSessionOverride
          ? 'session-override'
          : resolvedDefault.source,
        error: null,
      });
      workingDirectorySettingsSyncAppliedGeneration = syncGeneration;
    } catch (error) {
      if (syncGeneration === workingDirectorySettingsSyncGeneration) {
        set({ error: error instanceof Error ? error.message : 'Could not refresh working directories.' });
      }
    } finally {
      if (syncGeneration >= workingDirectorySettingsSyncSettledGeneration) {
        workingDirectorySettingsSyncSettledGeneration = syncGeneration;
      }
    }
  },
  setSelection: (document, anchor, selectedText, location, surroundingText) => {
    const rawQuote = anchor.quote.exact === selectedText ? selectedText : anchor.quote.exact;
    const truncated = rawQuote.length > AGENT_MAX_CONTEXT_TEXT_LENGTH;
    const exactQuote = takeCodePointPrefix(rawQuote, AGENT_MAX_CONTEXT_TEXT_LENGTH);
    const rawSurroundingText = surroundingText !== undefined
      ? surroundingText
      : [anchor.quote.prefix, anchor.quote.suffix]
        .filter((part) => part.length > 0)
        .join(' … ');
    const boundedSurroundingText = takeCodePointPrefix(rawSurroundingText ?? '', AGENT_MAX_SURROUNDING_TEXT_LENGTH) || null;
    const packet: AgentContextPacket = {
      version: 1,
      document: { id: document.id, hash: document.fileHash, title: document.title, author: document.author },
      selection: {
        exactQuote,
        anchor,
        location: location ?? anchorToLocation(anchor),
        surroundingText: boundedSurroundingText,
      },
      provenance: {
        source: 'interleaf-reader-selection',
        capturedAt: new Date().toISOString(),
        contentIsUntrustedReference: true,
        truncated,
      },
    };
    nextAgentContextRevision();
    try {
      set({
        contextPacket: fitAgentContextPacketToByteBudget(packet, truncated),
        pendingContext: null,
        error: null,
      });
    } catch (error) {
      set({ contextPacket: null, pendingContext: null, error: error instanceof Error ? error.message : 'Could not attach selection to Agent context.' });
    }
  },

  attachSelection: (document, selection) => {
    if (!selection.anchor) return;
    const location = anchorToLocation(selection.anchor);
    get().setSelection(document, selection.anchor, selection.selectedText, location, null);
  },

  ...createContextActions(set, get),

  clearSelection: () => { nextAgentContextRevision(); set({ contextPacket: null, pendingContext: null }); },
  clearContextPacket: () => { nextAgentContextRevision(); set({ contextPacket: null, pendingContext: null }); },
  setSelectedProfile: (id) => {
    const api = bridge.agent;
    const generation = ++modeAvailabilityGeneration;
    profileSelectionRevision += 1;
    directorySelectionRequestRevision += 1;
    const resolvedDefault = resolveWorkingDirectoryDefault(id, get().workingDirectories, get().workingDirectoryDefaults, get().globalDefaultWorkingDirectory);
    set({
      selectedProfileId: id,
      // Keep the chosen model when the new profile supports it; otherwise fall
      // back to that profile's default so no unsupported pair is ever shown.
      selectedModel: reconcileSelectedModel(get().profiles, id, get().selectedModel),
      modeAvailability: [],
      workingDirectory: resolvedDefault.directory,
      workingDirectorySource: resolvedDefault.source,
    });
    void reportRejection(api.getModeAvailability(id).then((availability) => {
      if (generation === modeAvailabilityGeneration && get().selectedProfileId === id) set({ modeAvailability: availability });
    }), (caught) => {
      if (generation === modeAvailabilityGeneration && get().selectedProfileId === id) set({ error: caught === null ? 'Could not load execution mode availability.' : caught.message });
    });
  },
  setSelectedModel: (model) => {
    if (model === null) {
      set({ selectedModel: null });
      return;
    }
    set({ selectedModel: reconcileSelectedModel(get().profiles, get().selectedProfileId, model) });
  },
  deselectSession: () => {
    ++environmentRefreshGeneration;
    ++sessionFocusRevision;
    set({ activeSession: null, events: [], error: null, stopping: false });
  },

  start: async (profileId, executionMode, prompt) => {
    const api = bridge.agent;
    const state = get();
    // The run is for what the reader sees when pressing Start: this book, its
    // attached context, this model and this directory. All of it is taken now,
    // before any await, so a choice made while settings flush or a
    // confirmation is open never changes this launch, and is never overwritten.
    const frozen = freezeLaunch(state, selectActiveDocument(useReaderStore.getState())?.id ?? null, profileId);
    if ('problem' in frozen) { set({ error: frozen.problem }); return false; }
    if (isActiveSessionStatus(state.activeSession?.status ?? 'completed') || state.launching || state.loading) return false;
    const { launch } = frozen;
    ++environmentRefreshGeneration;
    const attempt: Attempt = { focus: ++sessionFocusRevision, turn: ++loadingTurn };
    set({
      loading: true, launching: true, stopping: false, error: null, events: [],
      ...(launch.model !== state.selectedModel ? { selectedModel: launch.model } : {}),
      ...(launch.contextPacket !== state.contextPacket ? { contextPacket: launch.contextPacket } : {}),
    });
    try {
      // Serialize any in-flight settings write (such as a model selection
      // change made immediately before clicking Start) so main's profile
      // preferences, fingerprints, and defaults are committed before launch.
      await flushPendingSettingsWrites();
      const { documentId, directory, contextPacket, model } = launch;
      let grant: { readonly grantId: string; readonly expiresAt: number } | null = null;
      let draftId: string | null = null;
      // The risk grant is fingerprinted over exactly the model `agent:start` receives.
      if (executionMode === 'active-env' || executionMode === 'native-restricted') {
        draftId = crypto.randomUUID();
        grant = await api.issueRiskGrant({ draftId, profileId, workingDirectoryHandle: directory.handle, executionMode, prompt, model, contextPacket });
      }
      const result = await api.startSession({
        documentId,
        profileId,
        workingDirectoryHandle: directory.handle,
        executionMode,
        prompt,
        contextPacket,
        model,
        riskConfirmation: grant !== null && draftId !== null ? { grantId: grant.grantId, draftId } : null,
      });
      const detail = await api.getSession(result.session.id, documentId);
      landRun(api, documentId, attempt, detail ?? { ...result.session, events: [], artifacts: [] });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start agent.';
      try {
        await get().refreshProfiles();
      } catch {
        // preserve the launch error
      }
      settleFailedAttempt(launch.documentId, attempt, message);
      return false;
    } finally {
      set({ launching: false });
    }
  },

  resume: async (prompt) => {
    const api = bridge.agent;
    const active = get().activeSession;
    if (active === null) { set({ error: 'No agent session is selected to resume.' }); return false; }
    if (active.status === 'running' || active.status === 'queued' || active.status === 'waiting') return false;
    if (get().launching || get().loading) return false;
    ++environmentRefreshGeneration;
    const attempt: Attempt = { focus: ++sessionFocusRevision, turn: ++loadingTurn };
    beginRunAttempt(active.id);
    stoppingSessionIds.delete(active.id);
    terminalEnvironmentRefreshes.delete(active.id);
    set({ loading: true, launching: true, stopping: false, error: null });
    try {
      const result = await api.resumeSession({
        sessionId: active.id,
        prompt,
      });
      const detail = await api.getSession(result.session.id, active.documentId);
      recordAgentFollowUp(active.id, prompt);
      landRun(api, active.documentId, attempt, detail ?? { ...result.session, events: [], artifacts: [] });
      return true;
    } catch (error) {
      settleFailedAttempt(active.documentId, attempt, error instanceof Error ? error.message : 'Could not resume agent.');
      return false;
    } finally {
      set({ launching: false });
    }
  },

  copyResult: async () => {
    const api = bridge.agent;
    const session = get().activeSession;
    if (session === null) return null;
    const attempt = runAttemptOf(session.id);
    try {
      const result = await api.copyResult(session.id);
      if (showsAttempt(session.id, session.documentId, attempt)) set({ error: null });
      return result;
    } catch (error) {
      if (showsAttempt(session.id, session.documentId, attempt)) set({ error: error instanceof Error ? error.message : 'Could not copy result.' });
      return null;
    }
  },

  stop: async () => {
    const api = bridge.agent;
    const session = get().activeSession;
    if (session === null) return;
    if (get().stopping) return;
    if (isTerminalSessionStatus(session.status)) return;
    // The request always reaches main; only its landing is bound to this run.
    // Once the session is resumed, this Stop has nothing left to say about it.
    const attempt = runAttemptOf(session.id);
    stoppingSessionIds.add(session.id);
    set({ stopping: true });
    try {
      await api.stopSession(session.id);
      const detail = await api.getSession(session.id, session.documentId);
      if (detail && runAttemptOf(session.id) === attempt) {
        const replay = mergeEvents([...detail.events, ...(pendingEvents.get(session.id) ?? [])]);
        const reconciled = reconcileSession(detail, replay);
        const current = get();
        // The user can switch sessions or books while the stop request is in
        // flight. Do not let the old request overwrite the newly selected
        // session's transcript or stopping state.
        if (!showsAttempt(session.id, session.documentId, attempt)) {
          if (reconciled.status !== 'cancelled' || !hasPendingCancellation(replay)) stoppingSessionIds.delete(session.id);
          if (current.documentId === session.documentId) set({ sessions: current.sessions.map((item) => item.id === detail.id ? reconciled : item) });
          return;
        }
        pendingEvents.delete(session.id);
        const keepStopping = shouldKeepStopping(current.stopping || stoppingSessionIds.has(session.id), reconciled, replay);
        if (!keepStopping) stoppingSessionIds.delete(session.id);
        set({
          activeSession: reconciled,
          events: replay,
          stopping: keepStopping,
          sessions: current.sessions.map((item) => item.id === detail.id ? reconciled : item),
        });
      }
    } catch (error) {
      // A resumed run may have its own Stop pending; that marker is not ours.
      if (runAttemptOf(session.id) !== attempt) return;
      stoppingSessionIds.delete(session.id);
      if (showsAttempt(session.id, session.documentId, attempt)) {
        set({ stopping: false, error: error instanceof Error ? error.message : 'Could not stop agent.' });
      }
    }
  },

  selectSession: async (sessionId) => {
    const api = bridge.agent;
    const selectionGeneration = ++environmentRefreshGeneration;
    ++sessionFocusRevision;
    try {
      const currentDocId = get().documentId;
      if (currentDocId === null) return;
      await claimSessionOwnership(api, sessionId);
      const detail = await api.getSession(sessionId, currentDocId);
      if (detail && selectionGeneration === environmentRefreshGeneration) {
        if (detail.documentId !== currentDocId || get().documentId !== currentDocId) {
          return;
        }
        const reconciled = reconcileSession(detail, detail.events);
        const current = get();
        const keepStopping = shouldKeepStopping(
          (current.activeSession?.id === detail.id ? current.stopping : false) || stoppingSessionIds.has(detail.id),
          reconciled,
          detail.events,
        );
        if (!keepStopping) stoppingSessionIds.delete(detail.id);
        // An error belonged to the session being left, not this one.
        set({ activeSession: reconciled, events: detail.events, stopping: keepStopping, error: null, sessions: current.sessions.map((item) => item.id === detail.id ? reconciled : item) });
      }
    } catch (error) {
      if (selectionGeneration === environmentRefreshGeneration) {
        set({ error: error instanceof Error ? error.message : 'Could not load agent session.' });
      }
    }
  },

  refreshEnvironment: async () => {
    const api = bridge.agent;
    const sessionId = get().activeSession?.id;
    if (sessionId === undefined) return;
    const refreshGeneration = ++environmentRefreshGeneration;
    await refreshEnvironmentForSession(api, sessionId, refreshGeneration);
  },

  // Workspace actions land on the session they were started for. If the
  // reader has opened another session or book meanwhile, the list still
  // learns the new state but the open session and its errors are untouched.
  applyChanges: async () => {
    const api = bridge.agent;
    const session = get().activeSession;
    if (session === null) return;
    const attempt = runAttemptOf(session.id);
    try {
      const result = await api.applyChanges(session.id);
      const detail = await api.getSession(session.id, session.documentId);
      if (detail) landActionResult(session.documentId, attempt, { ...detail, environment: { ...result.review, sessionId: session.id } });
    } catch (error) {
      if (showsAttempt(session.id, session.documentId, attempt)) set({ error: error instanceof Error ? error.message : 'Could not apply changes.' });
    }
  },

  discardSandbox: async (origin) => {
    if (!discardOriginHolds(origin, get())) return 'refused';
    const { sessionId, documentId, attempt } = origin;
    try { await bridge.agent.discardSandbox(sessionId); } catch (error) {
      if (showsAttempt(sessionId, documentId, attempt)) set({ error: error instanceof Error ? error.message : 'Could not discard sandbox.' });
      return 'failed';
    }
    // Main has discarded it: nothing of it stays actionable here, whether or not it then reloads.
    if (get().documentId === documentId && runAttemptOf(sessionId) === attempt) {
      const active = showsAttempt(sessionId, documentId, attempt) ? get().activeSession : null;
      set({ sessions: get().sessions.map((item) => withDiscarded(item, sessionId)), ...(active ? { activeSession: withDiscarded(active, sessionId) } : {}) });
    }
    const detail = await bridge.agent.getSession(sessionId, documentId).catch(() => null);
    if (detail) landActionResult(documentId, attempt, detail);
    else if (showsAttempt(sessionId, documentId, attempt)) set({ error: 'Sandbox discarded, but this run could not be reloaded. Reopen it to see its current state.' });
    return 'discarded';
  },

  exportPatch: async () => {
    const api = bridge.agent;
    const session = get().activeSession;
    if (session === null) return null;
    const attempt = runAttemptOf(session.id);
    try {
      const exported = await api.exportPatch(session.id);
      if (showsAttempt(session.id, session.documentId, attempt)) set({ error: null });
      // Closing the save dialog is the reader's choice, not a failure.
      return exported.outcome === 'cancelled'
        ? 'Patch export cancelled. Nothing was saved.'
        : `Patch exported: ${exported.fileName} (${String(exported.bytes)} bytes).`;
    } catch (error) {
      if (showsAttempt(session.id, session.documentId, attempt)) set({ error: error instanceof Error ? error.message : 'Could not export patch.' });
      return null;
    }
  },

  openFolder: async () => {
    const api = bridge.agent;
    const session = get().activeSession;
    if (session === null) return;
    const attempt = runAttemptOf(session.id);
    let message: string | null;
    try {
      // The system can decline to open the folder without throwing.
      message = (await api.openFolder(session.id)).opened ? null : 'The environment folder could not be opened.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not open environment folder.';
    }
    if (showsAttempt(session.id, session.documentId, attempt)) set({ error: message });
  },
  });
});

/** A start or resume: the focus it took and the `loading` it set. */
type Attempt = { readonly focus: number; readonly turn: number };

type Launch = {
  readonly documentId: string;
  readonly directory: AgentWorkingDirectory;
  readonly contextPacket: AgentContextPacket | null;
  readonly model: string | null;
};

/**
 * Everything a launch uses, taken at the click. The reader and the panel must
 * agree on the book: while a newly opened book is still loading, the panel
 * may still hold the previous one, and Start must not run against it.
 */
function freezeLaunch(state: AgentState, readerDocumentId: string | null, profileId: string): { readonly problem: string } | { readonly launch: Launch } {
  if (state.workingDirectory === null) return { problem: 'Select a working directory before starting an agent.' };
  if (state.documentId === null || readerDocumentId === null) return { problem: 'Open a document before starting an agent.' };
  if (state.documentId !== readerDocumentId) return { problem: 'This book is still loading. Start again once it has opened.' };
  if (state.pendingContext !== null) return { problem: `${state.pendingContext.label} is still being attached. Wait for it, or cancel it, before starting.` };
  const attached = state.contextPacket;
  return {
    launch: {
      documentId: state.documentId,
      directory: state.workingDirectory,
      contextPacket: attached === null ? null : fitAgentContextPacketToByteBudget(attached, attached.provenance.truncated),
      model: reconcileSelectedModel(state.profiles, profileId, state.selectedModel),
    },
  };
}

function isTerminalSessionStatus(status: AgentSessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function hasPendingCancellation(events: readonly AgentEvent[]): boolean {
  const latestCancelledOrdinal = latestEventOrdinal(events, 'cancelled');
  if (latestCancelledOrdinal === undefined) return false;
  const latestEndedOrdinal = latestEventOrdinal(events, 'ended');
  return latestEndedOrdinal === undefined || latestCancelledOrdinal > latestEndedOrdinal;
}

function cancellationClosesEndedRun(events: readonly AgentEvent[], endedOrdinal: number): boolean {
  const latestCancelledOrdinal = latestEventOrdinalBefore(events, 'cancelled', endedOrdinal);
  if (latestCancelledOrdinal === undefined) return false;
  const latestPriorEndedOrdinal = latestEventOrdinalBefore(events, 'ended', endedOrdinal);
  return latestPriorEndedOrdinal === undefined || latestCancelledOrdinal > latestPriorEndedOrdinal;
}

function latestEventOrdinal(events: readonly AgentEvent[], type: AgentEvent['type']): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== type || (latest !== undefined && event.ordinal <= latest)) continue;
    latest = event.ordinal;
  }
  return latest;
}

function latestEventOrdinalBefore(events: readonly AgentEvent[], type: AgentEvent['type'], upperBound: number): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== type || event.ordinal >= upperBound || (latest !== undefined && event.ordinal <= latest)) continue;
    latest = event.ordinal;
  }
  return latest;
}

function shouldKeepStopping(stopping: boolean, session: AgentSessionDetail, events: readonly AgentEvent[]): boolean {
  if (!stopping) return false;
  if (session.status === 'cancelled') return hasPendingCancellation(events);
  return !isTerminalSessionStatus(session.status);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function resolveWorkingDirectoryDefault(
  profileId: string | null,
  directories: readonly AgentWorkingDirectory[],
  defaults: Readonly<Record<string, string>>,
  globalDefaultHandle: string | null,
): { directory: AgentWorkingDirectory | null; source: WorkingDirectorySelectionSource } {
  if (profileId !== null) {
    const handle = defaults[profileId];
    if (handle !== undefined) {
      const match = directories.find((directory) => directory.handle === handle);
      if (match) return { directory: match, source: 'profile-default' };
    }
  }
  if (globalDefaultHandle) {
    const match = directories.find((directory) => directory.handle === globalDefaultHandle);
    if (match) return { directory: match, source: 'global-default' };
  }
  return { directory: null, source: 'none' };
}

/**
 * Which profile a **new** draft starts on.
 *
 * The persisted `agent.defaultProfileId` is a preference for composing a fresh
 * draft, so it is only consulted where nothing has been selected yet: a draft
 * already open keeps its selection, and a queued, running or resumable session
 * keeps the binding it was created with. Without a usable default the draft
 * starts on the first installed profile, or on none: an uninstalled agent is
 * only ever selected because the user chose it, never by this fallback.
 */
export function initialDraftProfileId(
  profiles: readonly AgentProfile[],
  defaultProfileId: string | null | undefined
): string | null {
  if (
    defaultProfileId !== null
    && defaultProfileId !== undefined
    && profiles.some((profile) => profile.id === defaultProfileId)
  ) {
    return defaultProfileId;
  }
  return profiles.find((profile) => profile.detection.availability === 'installed')?.id ?? null;
}

/**
 * Deterministically reconciles a chosen model against a profile.
 *
 * The renderer must never keep (or launch) a model the selected profile does
 * not resolve to: `availableModels` is main's own allowlist projection, so a
 * value outside it would be rejected by `agent:start`. A retained choice wins,
 * then the profile's configured default, then "provider default" (`null`).
 */
export function reconcileSelectedModel(
  profiles: readonly AgentProfile[],
  profileId: string | null,
  current: string | null,
): string | null {
  if (profileId === null) return null;
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined || profile.availableModels.length === 0) return null;
  if (current !== null && profile.availableModels.includes(current)) return current;
  if (profile.defaultModel !== null && profile.availableModels.includes(profile.defaultModel)) return profile.defaultModel;
  return null;
}

function mergeEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
  return [...new Map(events.map((event) => [`${event.sessionId}:${String(event.ordinal)}`, event])).values()].sort((a, b) => a.ordinal - b.ordinal);
}

function applyLiveEvent(state: AgentState, event: AgentEvent): Partial<AgentState> {
  if (state.activeSession?.id !== event.sessionId) {
    if (event.type === 'ended' || event.type === 'error') stoppingSessionIds.delete(event.sessionId);
    return state;
  }
  const events = mergeEvents([...state.events, event]);
  const activeSession = reconcileSession(state.activeSession, events, { liveEvent: event });
  const sessions = state.sessions.map((session) => session.id === activeSession.id ? activeSession : session);
  const stopping = shouldKeepStopping(state.stopping || stoppingSessionIds.has(event.sessionId), activeSession, events);
  if (stopping) stoppingSessionIds.add(event.sessionId);
  else stoppingSessionIds.delete(event.sessionId);
  return { events, activeSession, sessions, stopping };
}

function applySummaryEvent(session: AgentSession, event: AgentEvent, events: readonly AgentEvent[] = [event]): AgentSession {
  // Event subscriptions can replay a historical terminal event while a
  // persisted session is already running after resume. Ordinals distinguish
  // that replay from a new event for this run.
  const isNewEvent = event.ordinal >= session.eventCount;
  const status = !isNewEvent
    ? session.status
    : event.type === 'started'
    ? 'running'
    : event.type === 'cancelled' && isActiveSessionStatus(session.status)
      ? 'cancelled'
      : event.type === 'ended' && isActiveSessionStatus(session.status)
        ? cancellationClosesEndedRun(events, event.ordinal)
          ? 'cancelled'
          : event.exitCode === 0 ? 'completed' : 'failed'
        : session.status;
  return {
    ...session,
    status,
    eventCount: Math.min(1_000_000, session.eventCount + 1),
    ...(event.type === 'final' ? { finalReport: event.text } : {}),
  };
}

function reconcileSession(session: AgentSessionDetail, events: readonly AgentEvent[], options: { readonly liveEvent?: AgentEvent } = {}): AgentSessionDetail {
  const latestStartedOrdinal = [...events].reverse().find((event) => event.type === 'started')?.ordinal;
  const latestEndedOrdinal = [...events].reverse().find((event) => event.type === 'ended')?.ordinal;
  const latestFinalOrdinal = [...events].reverse().find((event) => event.type === 'final')?.ordinal;
  const liveEvent = options.liveEvent;
  const isNewLiveEvent = liveEvent !== undefined && liveEvent.ordinal >= session.eventCount;
  const status = !isNewLiveEvent
    ? session.status
    : liveEvent.type === 'started'
      ? 'running'
      : liveEvent.type === 'cancelled' && latestStartedOrdinal !== undefined && liveEvent.ordinal > latestStartedOrdinal
        ? 'cancelled'
        : liveEvent.type === 'ended' && latestStartedOrdinal !== undefined && liveEvent.ordinal > latestStartedOrdinal
          ? cancellationClosesEndedRun(events, liveEvent.ordinal)
            ? 'cancelled'
            : liveEvent.exitCode === 0 ? 'completed' : 'failed'
          : session.status;
  const reconciledStatus = latestEndedOrdinal !== undefined && cancellationClosesEndedRun(events, latestEndedOrdinal)
    && status !== 'interrupted'
    ? 'cancelled'
    : status;
  const staleTerminalReport = isActiveSessionStatus(reconciledStatus)
    && session.finalReport !== null
    && (latestStartedOrdinal === undefined
      || latestFinalOrdinal === undefined
      || (latestEndedOrdinal !== undefined && latestFinalOrdinal <= latestEndedOrdinal)
      || latestFinalOrdinal < latestStartedOrdinal);
  const finalReport = liveEvent?.type === 'final' && isNewLiveEvent
    ? liveEvent.text
    : staleTerminalReport ? null : session.finalReport;
  return { ...session, status: reconciledStatus, eventCount: events.length, finalReport };
}

function isActiveSessionStatus(status: AgentSessionStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}
