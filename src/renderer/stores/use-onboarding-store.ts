import { create } from 'zustand';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type {
  AgentAvailability,
  AgentProfile,
  AgentProviderId,
  AgentProfileStatus,
  AgentUnavailabilityReason,
} from '@shared/types/agent';
import type { InterleafAPI } from '@shared/types/api';
import type { AppSettings } from '@shared/schemas/settings';
import {
  ONBOARDING_STAGES,
  resolveResumeStage,
  type OnboardingStage,
  type OnboardingStatus,
} from '@shared/constants/onboarding';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import { bridge, enqueueSettingsWrite } from '../app/api-client';
import { useUiStore } from './use-ui-store';
import { publishProviderStatus } from './provider-status-freshness';
import { openRouterCredentialState, type OpenRouterCredentialState } from '../features/settings/provider-rows';
import {
  deriveOnboardingRows,
  ONBOARDING_CHAT_PROVIDER_IDS,
  type OnboardingProviderRow,
  type RowProbe,
} from '../features/onboarding/onboarding-rows';
import {
  agentDefaultOptions,
  chatDefaultOptions,
  isPersistableAgentProfileId,
  isPersistableChatProviderId,
  persistedAgentChoice,
  persistedChatChoice,
  resolveDefaultChoice,
  type DefaultChoice,
  type PersistableAgentProfileId,
  type PersistableChatProviderId,
} from '../features/onboarding/onboarding-defaults';
import { defaultProfilePreference, findProfileEditorDefinition } from '../features/agent/profile-preferences';

/**
 * Guided onboarding — renderer orchestration.
 *
 * Discovery here is observation, not a probe engine: every check is an existing
 * main-owned entry point (`ai.getProviderStatus`, `agent.listProfileStatus`),
 * issued one per row so a row renders the moment it settles instead of waiting
 * for the slowest provider. Nothing is cached a second time; main keeps its own
 * coalescing and TTL.
 *
 * Two rules govern the lifecycle:
 *
 * - **Generation.** Every refresh takes the next generation number. A response
 *   that belongs to a superseded generation is dropped, so a slow answer can
 *   never overwrite a newer one.
 * - **Ownership.** Closing the wizard stops observation — it raises the
 *   generation so late responses are discarded — and cancels nothing in main.
 *   Settings, the chat store and startup share that discovery, and a closing
 *   wizard must not tear down a check another surface is waiting on.
 */

const PROBE_CHECKING: RowProbe<AIProviderStatus> = { phase: 'checking' };

const PROBE_FAILED_MESSAGE = 'This check did not complete.';

/** Why the wizard closed. Only an involuntary exit leaves it resumable. */
export type OnboardingExitReason = 'skip-ai' | 'finish-later' | 'dismissed' | 'completed';

/**
 * The status each voluntary exit is recorded as.
 *
 * `skip-ai` and `finish-later` share `finish-later` because they mean the same
 * thing to the next launch — the user left on purpose, so nothing reopens — while
 * staying distinct as *reasons* at the call site. `dismissed` is kept apart from
 * both so the upgrade entry point can tell "closed the wizard" from "declined the
 * offer", and only `completed` is a finished flow.
 */
const EXIT_STATUS: Readonly<Record<OnboardingExitReason, OnboardingStatus>> = {
  completed: 'completed',
  dismissed: 'dismissed',
  'skip-ai': 'finish-later',
  'finish-later': 'finish-later',
};

/**
 * The Step 3 edits a user has made but not committed.
 *
 * Held as *overrides* rather than as a fully resolved pair, so a row that
 * settles after the step opened still improves the suggestion underneath an
 * untouched control instead of freezing an early guess.
 */
type OnboardingDefaultsDraft = {
  readonly chat: DefaultChoice;
  readonly agent: DefaultChoice;
};

const EMPTY_DEFAULTS_DRAFT: OnboardingDefaultsDraft = { chat: null, agent: null };

export type OnboardingState = {
  readonly launchState: OnboardingLaunchState | null;
  readonly open: boolean;
  readonly stage: OnboardingStage;
  readonly status: OnboardingStatus;
  readonly lastStageAcknowledged: OnboardingStage | null;
  /** The control that opened the wizard, for deterministic focus return. */
  readonly openerId: string | null;
  /** Bumped by every refresh and by every stop; stale responses compare to it. */
  readonly generation: number;
  readonly observing: boolean;
  readonly chatProbes: Readonly<Partial<Record<AIProviderId, RowProbe<AIProviderStatus>>>>;
  readonly agentProfiles: readonly AgentProfileStatus[];
  readonly agentDetectionPending: boolean;
  readonly agentDiscoveryPending: boolean;
  readonly openRouterCredential: OpenRouterCredentialState;
  /** A failed `settings:update`. Progress is never reported as saved. */
  readonly saveError: string | null;
  /** The tip is deferred until a document is genuinely open. */
  readonly tipDismissed: boolean;
  readonly autoDiscoveryStarted: boolean;
  /** Step 3's uncommitted choices. Writing happens only on Continue. */
  readonly defaultsDraft: OnboardingDefaultsDraft;

  initialize: () => Promise<void>;
  openWizard: (options?: { readonly stage?: OnboardingStage; readonly openerId?: string }) => void;
  closeWizard: (reason: OnboardingExitReason) => void;
  goToStage: (stage: OnboardingStage) => void;
  acknowledgeStage: (stage: OnboardingStage) => void;
  refreshDiscovery: () => Promise<void>;
  refreshProvider: (providerId: AIProviderId) => Promise<void>;
  stopObserving: () => void;
  setChatDefault: (providerId: PersistableChatProviderId, modelId: string | null) => Promise<void>;
  setAgentDefault: (profileId: string, modelId: string | null) => Promise<void>;
  setDefaultsDraft: (patch: Partial<OnboardingDefaultsDraft>) => void;
  commitDefaults: () => Promise<void>;
  dismissTip: () => void;
  dismissEntryPoint: () => void;
  rerunFromSettings: (openerId?: string) => void;
};

const UNSAVED_PROGRESS = 'Your progress could not be saved.';

/**
 * The hydrated settings document every onboarding write builds on.
 *
 * `settings:update` replaces main's whole stored document, so a write built on
 * anything else would overwrite every saved preference. Before hydration there
 * is nothing true to build on, and the write fails as an unsaved change rather
 * than fabricating a document from the defaults.
 */
function hydratedSettings(): AppSettings {
  const settings = useUiStore.getState().loadedSettings;
  if (settings === null) throw new Error(UNSAVED_PROGRESS);
  return settings;
}

/**
 * Writes a settings document on the single ordered renderer queue every other
 * settings writer uses, and reports failure rather than claiming a save.
 */
async function writeSettings(build: (current: AppSettings) => AppSettings): Promise<string | null> {
  try {
    const saved = await enqueueSettingsWrite(() => build(hydratedSettings()));
    useUiStore.getState().setLoadedSettings(saved);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : UNSAVED_PROGRESS;
  }
}

function withOnboarding(
  current: AppSettings,
  patch: Partial<AppSettings['onboarding']>
): AppSettings {
  return { ...current, onboarding: { ...current.onboarding, ...patch } };
}

function stageIndex(stage: OnboardingStage): number {
  return ONBOARDING_STAGES.indexOf(stage);
}
function deriveAgentUnavailability(
  availability: AgentAvailability,
  providerId: AgentProviderId
): AgentUnavailabilityReason {
  if (availability === 'installed') return 'none';
  if (availability === 'error') return 'error';
  // Legacy id: main no longer registers Copilot, but still refuses it.
  if (providerId === 'copilot') return 'unsupported';
  return 'not-found';
}

function updateExistingStatus(
  existing: AgentProfileStatus,
  fresh: AgentProfile
): AgentProfileStatus {
  return {
    ...existing,
    defaultModel: fresh.defaultModel,
    availableModels: fresh.availableModels,
    supportsModelSelection: fresh.capabilities.modelSelection,
    version: fresh.detection.version ?? existing.version,
    errorMessage: fresh.detection.errorMessage ?? existing.errorMessage,
    checkedAt: fresh.detection.checkedAt || existing.checkedAt,
  };
}

function createRefreshedStatus(fresh: AgentProfile): AgentProfileStatus {
  return {
    profileId: fresh.id,
    providerId: fresh.providerId,
    name: fresh.name,
    availability: fresh.detection.availability,
    unavailability: deriveAgentUnavailability(fresh.detection.availability, fresh.providerId),
    version: fresh.detection.version,
    errorMessage: fresh.detection.errorMessage,
    checkedAt: fresh.detection.checkedAt,
    defaultModel: fresh.defaultModel,
    availableModels: fresh.availableModels,
    supportsModelSelection: fresh.capabilities.modelSelection,
    isCustom: fresh.isCustom,
  };
}

function applyRefreshedAgentProfiles(
  current: readonly AgentProfileStatus[],
  refreshed: readonly AgentProfile[]
): readonly AgentProfileStatus[] {
  const byId = new Map(refreshed.map((profile) => [profile.id, profile]));
  const updated = current.map((existing) => {
    const fresh = byId.get(existing.profileId);
    if (fresh === undefined) return existing;
    byId.delete(existing.profileId);
    return updateExistingStatus(existing, fresh);
  });
  for (const fresh of byId.values()) {
    updated.push(createRefreshedStatus(fresh));
  }
  return updated;
}

async function performAgentDiscovery(
  agentApi: InterleafAPI['agent'],
  isCurrent: () => boolean,
  setProfiles: (profiles: readonly AgentProfileStatus[], pending: boolean) => void,
  updateRefreshed: (refreshed: readonly AgentProfile[]) => void,
  failDetection: () => void,
  failDiscovery: () => void
): Promise<void> {
  try {
    const snapshot = await agentApi.listProfileStatus();
    if (!isCurrent()) return;
    setProfiles(snapshot.profiles, snapshot.modelDiscoveryPending);
  } catch {
    if (!isCurrent()) return;
    failDetection();
  }

  try {
    const refreshed = await agentApi.refreshModels();
    if (!isCurrent()) return;
    updateRefreshed(refreshed);
  } catch {
    if (!isCurrent()) return;
    failDiscovery();
  }
}



/** Applies a resolved Reader Chat choice; an unpersistable id is dropped. */
function applyChatDefault(current: AppSettings, choice: DefaultChoice): AppSettings {
  if (choice === null || !isPersistableChatProviderId(choice.id)) return current;
  return { ...current, ai: { ...current.ai, defaultChat: { providerId: choice.id, modelId: choice.modelId } } };
}

/**
 * Applies a resolved Agent Mode choice.
 *
 * The model rides on the existing per-profile preference record, composed from
 * the allowlisted preset table so main's strict profile validation accepts it.
 * Restricted to built-in profiles for this release.
 */
function applyAgentDefault(current: AppSettings, choice: DefaultChoice): AppSettings {
  if (choice === null || !isPersistableAgentProfileId(choice.id)) return current;
  const profileId: PersistableAgentProfileId = choice.id;
  const definition = findProfileEditorDefinition(profileId);
  if (definition === undefined) return current;
  const existing = current.agent.profiles[profileId] ?? defaultProfilePreference(definition);
  const models = existing.models;
  const modelId = choice.modelId;
  return {
    ...current,
    agent: {
      ...current.agent,
      defaultProfileId: profileId,
      profiles: {
        ...current.agent.profiles,
        [profileId]: {
          ...existing,
          defaultModel: modelId,
          models: modelId === null || models.includes(modelId) ? models : [...models, modelId],
        },
      },
    },
  };
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  launchState: null,
  open: false,
  stage: 'welcome',
  status: 'not-started',
  lastStageAcknowledged: null,
  openerId: null,
  generation: 0,
  observing: false,
  chatProbes: {},
  agentProfiles: [],
  agentDetectionPending: true,
  agentDiscoveryPending: false,
  openRouterCredential: 'absent',
  saveError: null,
  tipDismissed: false,
  autoDiscoveryStarted: false,
  defaultsDraft: EMPTY_DEFAULTS_DRAFT,

  /**
   * Reads the verdict main latched at startup. The renderer never classifies a
   * launch itself, and auto-opening is main's verdict, not a renderer guess.
   */
  initialize: async () => {
    try {
      const launchState = await bridge.onboarding.getLaunchState();
      const persisted = useUiStore.getState().loadedSettings?.onboarding;
      set({
        launchState,
        status: persisted?.status ?? 'not-started',
        lastStageAcknowledged: persisted?.lastStageAcknowledged ?? null,
      });
      if (launchState.shouldAutoOpen) {
        get().openWizard({ stage: launchState.resumeStage });
      }
    } catch {
      // Fail closed: a launch we could not classify never opens a wizard.
    }
  },

  openWizard: ({ stage, openerId } = {}) => {
    const targetStage = stage ?? resolveResumeStage(get().lastStageAcknowledged);
    const shouldStartDiscovery = targetStage === 'discover' || targetStage === 'connect';
    set({
      open: true,
      stage: targetStage,
      openerId: openerId ?? null,
      saveError: null,
      autoDiscoveryStarted: shouldStartDiscovery,
      // A new opening starts from what is actually stored, never from an
      // abandoned draft of a previous one.
      defaultsDraft: EMPTY_DEFAULTS_DRAFT,
    });
    void writeSettings((current) => withOnboarding(current, { status: 'in-progress' })).then((error) => {
      set({ saveError: error, status: error === null ? 'in-progress' : get().status });
    });
    // Do not probe providers simply because Welcome opened. Start
    // onboarding-owned discovery when the user enters Discover or when
    // a resume/rerun opens directly on Discover or Connect.
    if (shouldStartDiscovery) {
      void get().refreshDiscovery().catch(() => undefined);
    }
  },

  /**
   * Every voluntary exit suppresses automatic reopening. An involuntary exit —
   * an OS quit or a crash — never reaches here, so the stored `in-progress`
   * survives and the next launch resumes.
   */
  closeWizard: (reason) => {
    const status = EXIT_STATUS[reason];
    get().stopObserving();
    set({ open: false, status, autoDiscoveryStarted: false, defaultsDraft: EMPTY_DEFAULTS_DRAFT });
    void writeSettings((current) =>
      withOnboarding(current, {
        status,
        ...(status === 'completed' && current.onboarding.completedAt === null
          ? { completedAt: new Date().toISOString() }
          : {}),
      })
    ).then((error) => { set({ saveError: error }); });
  },

  goToStage: (stage) => {
    set({ stage });
    // Guided onboarding performs exactly one automatic discovery pass per wizard
    // opening, when entering Discover (or Connect). Subsequent stage transitions
    // do not trigger additional automatic passes; explicit refresh remains available.
    if (!get().autoDiscoveryStarted && (stage === 'discover' || stage === 'connect')) {
      set({ autoDiscoveryStarted: true });
      void get().refreshDiscovery().catch(() => undefined);
    }
  },

  /**
   * Records a stage the user actually acted on. A stage they merely looked at
   * never advances the resume point.
   */
  acknowledgeStage: (stage) => {
    const current = get().lastStageAcknowledged;
    if (current !== null && stageIndex(current) >= stageIndex(stage)) return;
    set({ lastStageAcknowledged: stage });
    void writeSettings((settings) =>
      withOnboarding(settings, { status: 'in-progress', lastStageAcknowledged: stage })
    ).then((error) => { set({ saveError: error }); });
  },

  /**
   * Asks main for each row independently.
   *
   * One hanging provider leaves every other row correct: the calls are not
   * awaited together, and each writes only its own slot.
   */
  refreshDiscovery: async () => {
    const generation = get().generation + 1;
    set({
      generation,
      autoDiscoveryStarted: true,
      observing: true,
      chatProbes: Object.fromEntries(ONBOARDING_CHAT_PROVIDER_IDS.map((id) => [id, PROBE_CHECKING])),
      agentDetectionPending: true,
      agentDiscoveryPending: true,
    });

    const isCurrent = (): boolean => get().generation === generation && get().observing;

    const credentialCheck = bridge.credentials
      .getOpenRouterStatus()
      .then((status) => {
        if (!isCurrent()) return;
        set({ openRouterCredential: openRouterCredentialState(status) });
      })
      .catch(() => undefined);

    const providerChecks = ONBOARDING_CHAT_PROVIDER_IDS.map(async (providerId) => {
      try {
        const status = await bridge.ai.getProviderStatus(providerId, { forceRefresh: true });
        if (!isCurrent()) return;
        // Share the fresh answer with the surfaces that already track it,
        // rather than keeping a second copy only the wizard can see.
        publishProviderStatus(status);
        set((state) => ({ chatProbes: { ...state.chatProbes, [providerId]: { phase: 'settled', value: status } } }));
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : PROBE_FAILED_MESSAGE;
        set((state) => ({ chatProbes: { ...state.chatProbes, [providerId]: { phase: 'failed', message } } }));
      }
    });

    const agentCheck = performAgentDiscovery(
      bridge.agent,
      isCurrent,
      (profiles, pending) => {
        set({ agentProfiles: profiles, agentDiscoveryPending: pending, agentDetectionPending: false });
      },
      (refreshed) => {
        set((state) => ({
          agentProfiles: applyRefreshedAgentProfiles(state.agentProfiles, refreshed),
          agentDiscoveryPending: false,
        }));
      },
      () => { set({ agentDetectionPending: false }); },
      () => { set({ agentDiscoveryPending: false }); }
    );

    await Promise.allSettled([credentialCheck, agentCheck, ...providerChecks]);
  },

  /** Re-checks one row, typically after an authentication action. */
  refreshProvider: async (providerId) => {
    const generation = get().generation;
    set((state) => ({ chatProbes: { ...state.chatProbes, [providerId]: PROBE_CHECKING } }));
    try {
      const status = await bridge.ai.getProviderStatus(providerId, { forceRefresh: true });
      if (get().generation !== generation || !get().observing) return;
      publishProviderStatus(status);
      set((state) => ({ chatProbes: { ...state.chatProbes, [providerId]: { phase: 'settled', value: status } } }));
    } catch (error) {
      if (get().generation !== generation || !get().observing) return;
      const message = error instanceof Error ? error.message : PROBE_FAILED_MESSAGE;
      set((state) => ({ chatProbes: { ...state.chatProbes, [providerId]: { phase: 'failed', message } } }));
    }
  },

  /**
   * Stops wizard-owned observation.
   *
   * Raising the generation is the whole mechanism: in-flight answers belong to
   * an older generation and are discarded on arrival. No main-side work is
   * cancelled, because the same coalesced discovery serves Settings and chat.
   */
  stopObserving: () => {
    set((state) => ({ generation: state.generation + 1, observing: false }));
  },

  /**
   * Records the Reader Chat default the user explicitly confirmed.
   *
   * New sessions only: `resolveNewSessionBinding` re-validates readiness at use,
   * and an existing conversation keeps the binding it was created with.
   */
  setChatDefault: async (providerId, modelId) => {
    const error = await writeSettings((current) => ({
      ...current,
      ai: { ...current.ai, defaultChat: { providerId, modelId } },
    }));
    set({ saveError: error });
  },

  /**
   * Records the Agent Mode default the user explicitly confirmed.
   *
   * Restricted to built-in profiles for this release; anything else is reported
   * rather than written, because a settings document must not be able to name
   * an arbitrary user-configured executable as a startup default.
   */
  setAgentDefault: async (profileId, modelId) => {
    if (findProfileEditorDefinition(profileId) === undefined || !isPersistableAgentProfileId(profileId)) {
      set({ saveError: 'That agent profile cannot be saved as a default.' });
      return;
    }
    const error = await writeSettings((current) => applyAgentDefault(current, { id: profileId, modelId }));
    set({ saveError: error });
  },

  /** Records a Step 3 edit. Nothing is written and nothing is granted here. */
  setDefaultsDraft: (patch) => {
    set((state) => ({ defaultsDraft: { ...state.defaultsDraft, ...patch } }));
  },

  /**
   * Commits both Step 3 choices as the single user action *Continue* is.
   *
   * One settings document, one write, one ordered queue entry: a user who
   * chose a chat provider and an agent runtime never ends up with half of
   * their decision stored because the second write failed. When detection
   * offers nothing selectable there is nothing to resolve, so nothing is
   * written and any previously stored default is left exactly as it was.
   */
  commitDefaults: async () => {
    const settings = useUiStore.getState().loadedSettings;
    if (settings === null) {
      set({ saveError: UNSAVED_PROGRESS });
      return;
    }
    const rows = selectOnboardingRows(get());
    const draft = get().defaultsDraft;
    const chat = resolveDefaultChoice(chatDefaultOptions(rows), persistedChatChoice(settings), draft.chat);
    const agent = resolveDefaultChoice(agentDefaultOptions(rows), persistedAgentChoice(settings), draft.agent);
    if (chat === null && agent === null) return;
    const error = await writeSettings((current) => applyAgentDefault(applyChatDefault(current, chat), agent));
    set({ saveError: error, defaultsDraft: EMPTY_DEFAULTS_DRAFT });
  },

  dismissTip: () => { set({ tipDismissed: true }); },

  /**
   * Dismisses the upgrade entry point without ever having opened the wizard.
   *
   * Recorded as `dismissed` for the same reason every other exit is: an
   * existing user who says no once is not asked again on their own launches.
   * Settings still offers the rerun.
   */
  dismissEntryPoint: () => {
    set({ status: 'dismissed' });
    void writeSettings((current) => withOnboarding(current, { status: 'dismissed' })).then((error) => {
      set({ saveError: error });
    });
  },

  /**
   * A Settings rerun resets the wizard's own progress and nothing else: no
   * credential, no provider default, no library content is touched.
   */
  rerunFromSettings: (openerId) => {
    set({ lastStageAcknowledged: null, tipDismissed: false });
    void writeSettings((current) =>
      withOnboarding(current, { status: 'in-progress', lastStageAcknowledged: null })
    ).then((error) => { set({ saveError: error }); });
    get().openWizard({ stage: 'welcome', ...(openerId === undefined ? {} : { openerId }) });
  },
}));

/** The §4 rows for the current observation. */
export function selectOnboardingRows(state: OnboardingState): readonly OnboardingProviderRow[] {
  return deriveOnboardingRows({
    chatProbes: state.chatProbes,
    agentProfiles: state.agentProfiles,
    agentDiscoveryPending: state.agentDiscoveryPending,
    agentDetectionPending: state.agentDetectionPending,
    openRouterCredential: state.openRouterCredential,
  });
}
