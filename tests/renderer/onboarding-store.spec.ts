// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfile, AgentProfileStatus, AgentProfileStatusSnapshot } from '@shared/types/agent';
import type { AppSettings } from '@shared/schemas/settings';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import { resetSettingsWriteQueueForTests } from '../../src/renderer/app/api-client';
import { selectOnboardingRows, useOnboardingStore } from '../../src/renderer/stores/use-onboarding-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

/**
 * Wizard-owned observation.
 *
 * The properties under test are the ones a hanging or superseded provider can
 * break: a row must settle on its own, a late answer must never overwrite a
 * newer one, and closing the wizard must stop the wizard's observation without
 * cancelling the discovery Settings and chat share.
 */

const INITIAL_STORE = useOnboardingStore.getState();

function launchState(overrides: Partial<OnboardingLaunchState> = {}): OnboardingLaunchState {
  return {
    verdict: 'new-install',
    shouldAutoOpen: true,
    resumeStage: 'welcome',
    settingsRowPresent: false,
    onboardingSectionPresent: false,
    priorInstallEvidence: false,
    ...overrides,
  };
}

function providerStatus(id: AIProviderId, overrides: Partial<AIProviderStatus> = {}): AIProviderStatus {
  return {
    id,
    name: id,
    available: true,
    installed: true,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: [
      { id: `${id}-model`, name: `${id} model`, contextWindow: 1000, maxOutputTokens: 100, supportsStreaming: true },
    ],
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: false,
      persistentSessions: false,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
    ...overrides,
  };
}

const EMPTY_AGENT_SNAPSHOT: AgentProfileStatusSnapshot = { profiles: [], modelDiscoveryPending: false };

type Harness = {
  readonly settingsWrites: AppSettings[];
  readonly providerCalls: AIProviderId[];
  /** Resolves the oldest outstanding `getProviderStatus` call for a provider. */
  readonly settle: (id: AIProviderId, status?: AIProviderStatus) => void;
  readonly settleAgentRefresh: (profiles?: readonly AgentProfile[]) => void;
  readonly agentRefreshCalls: () => number;
};

function installApi(options: {
  readonly launch?: OnboardingLaunchState;
  readonly agentSnapshot?: AgentProfileStatusSnapshot;
  readonly agentRefreshedProfiles?: readonly AgentProfile[];
  readonly deferAgentRefresh?: boolean;
  /** Provider ids whose probe hangs until `settle` is called. */
  readonly deferred?: readonly AIProviderId[];
} = {}): Harness {
  const settingsWrites: AppSettings[] = [];
  const providerCalls: AIProviderId[] = [];
  const pending = new Map<AIProviderId, ((status: AIProviderStatus) => void)[]>();
  const deferred = new Set(options.deferred ?? []);
  let agentRefreshCount = 0;
  const pendingAgentRefreshes: ((profiles: readonly AgentProfile[]) => void)[] = [];

  stubBridge({
      settings: {
        update: (next: AppSettings) => {
          settingsWrites.push(next);
          return Promise.resolve(next);
        },
      },
      onboarding: { getLaunchState: () => Promise.resolve(options.launch ?? launchState()) },
      credentials: { getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS) },
      agent: {
        listProfileStatus: () => Promise.resolve(options.agentSnapshot ?? EMPTY_AGENT_SNAPSHOT),
        refreshModels: () => {
          agentRefreshCount += 1;
          if (!options.deferAgentRefresh) {
            return Promise.resolve(options.agentRefreshedProfiles ?? []);
          }
          return new Promise<readonly AgentProfile[]>((resolve) => {
            pendingAgentRefreshes.push(resolve);
          });
        },
      },
      ai: {
        getProviderStatus: (id: AIProviderId) => {
          providerCalls.push(id);
          if (!deferred.has(id)) return Promise.resolve(providerStatus(id));
          return new Promise<AIProviderStatus>((resolve) => {
            pending.set(id, [...(pending.get(id) ?? []), resolve]);
          });
        },
      },
    });

  return {
    settingsWrites,
    providerCalls,
    settle: (id, status) => {
      const queue = pending.get(id) ?? [];
      const next = queue.shift();
      pending.set(id, queue);
      next?.(status ?? providerStatus(id));
    },
    settleAgentRefresh: (profiles) => {
      const next = pendingAgentRefreshes.shift();
      next?.(profiles ?? options.agentRefreshedProfiles ?? []);
    },
    agentRefreshCalls: () => agentRefreshCount,
  };
}

/** Lets already-resolved provider promises deliver into the store. */
async function drain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  useOnboardingStore.setState(INITIAL_STORE, true);
  useUiStore.setState({ loadedSettings: null });
  resetSettingsWriteQueueForTests();
  vi.restoreAllMocks();
});

describe('onboarding store', () => {
  it('auto-opens only on the verdict main latched', async () => {
    installApi({ launch: launchState({ shouldAutoOpen: true }) });
    await useOnboardingStore.getState().initialize();
    expect(useOnboardingStore.getState().open).toBe(true);

    useOnboardingStore.setState(INITIAL_STORE, true);
    installApi({ launch: launchState({ verdict: 'upgraded-install', shouldAutoOpen: false }) });
    await useOnboardingStore.getState().initialize();
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it('persists in-progress as the first-launch auto-open happens, before the reader acts', async () => {
    // The documented contract, and the reason `not-started` describes only the
    // window before the wizard opens: the auto-open is itself an opening, so a
    // reload after it resumes the flow rather than auto-opening a second time.
    // OnboardingHost initializes only once settings have hydrated.
    const harness = installApi({ launch: launchState({ shouldAutoOpen: true }) });
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    await useOnboardingStore.getState().initialize();
    await drain();

    expect(useOnboardingStore.getState().open).toBe(true);
    expect(harness.settingsWrites.at(-1)?.onboarding.status).toBe('in-progress');
    expect(
      harness.settingsWrites.every((written) => written.onboarding.status !== 'not-started')
    ).toBe(true);
  });

  it('never writes a settings document built on defaults before settings hydrate', async () => {
    // settings:update replaces the whole stored document, so a write built on
    // DEFAULT_APP_SETTINGS would erase every saved preference.
    const harness = installApi();
    useOnboardingStore.getState().openWizard();
    await drain();
    expect(useOnboardingStore.getState().saveError).toBe('Your progress could not be saved.');
    expect(useOnboardingStore.getState().status).toBe('not-started');
    useOnboardingStore.getState().closeWizard('dismissed');
    await drain();
    await useOnboardingStore.getState().setChatDefault('openrouter', 'openrouter/auto');
    useOnboardingStore.getState().setDefaultsDraft({ chat: { id: 'openrouter', modelId: null } });
    await useOnboardingStore.getState().commitDefaults();
    await drain();
    expect(harness.settingsWrites).toHaveLength(0);
    expect(useOnboardingStore.getState().saveError).toBe('Your progress could not be saved.');
  });

  it('resumes at the stage the launch state named', async () => {
    installApi({ launch: launchState({ verdict: 'resume', shouldAutoOpen: true, resumeStage: 'connect' }) });
    await useOnboardingStore.getState().initialize();
    expect(useOnboardingStore.getState().stage).toBe('connect');
  });

  it('fails closed when the launch state cannot be read', async () => {
    stubBridge({ onboarding: { getLaunchState: () => Promise.reject(new Error('unavailable')) } });
    await useOnboardingStore.getState().initialize();
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it('settles every other row while one provider check hangs', async () => {
    const harness = installApi({ deferred: ['claude'] });
    const refresh = useOnboardingStore.getState().refreshDiscovery();
    await drain();

    const rows = selectOnboardingRows(useOnboardingStore.getState());
    expect(rows.find((item) => item.id === 'claude-code')?.chat?.state).toBe('checking');
    expect(rows.find((item) => item.id === 'codex')?.chat?.state).toBe('ready-chat');
    expect(rows.find((item) => item.id === 'omp')?.chat?.state).toBe('ready-chat');

    harness.settle('claude');
    await refresh;
    expect(
      selectOnboardingRows(useOnboardingStore.getState()).find((item) => item.id === 'claude-code')?.chat?.state
    ).toBe('ready-chat');
  });

  it('asks main once per provider row and never runs a probe of its own', async () => {
    const harness = installApi();
    await useOnboardingStore.getState().refreshDiscovery();
    const counts = new Map<AIProviderId, number>();
    for (const id of harness.providerCalls) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(harness.providerCalls).toContain('openrouter');
    expect(harness.providerCalls).toContain('local');
  });

  it('discards an answer that belongs to a superseded generation', async () => {
    const harness = installApi({ deferred: ['pi'] });
    void useOnboardingStore.getState().refreshDiscovery();
    await drain();

    void useOnboardingStore.getState().refreshDiscovery();
    await drain();
    // The first generation's answer arrives after the second refresh started.
    harness.settle('pi', providerStatus('pi', { installed: false, authentication: 'disconnected', available: false }));
    await drain();

    expect(useOnboardingStore.getState().chatProbes.pi).toEqual({ phase: 'checking' });
  });

  it('stops observing on close without cancelling shared discovery', async () => {
    const harness = installApi({ deferred: ['codex'] });
    void useOnboardingStore.getState().refreshDiscovery();
    await drain();

    useOnboardingStore.getState().closeWizard('finish-later');
    expect(useOnboardingStore.getState().observing).toBe(false);

    // Main was never asked to abandon the check, and its late answer is ignored
    // rather than repainting a closed wizard.
    harness.settle('codex');
    await drain();
    expect(useOnboardingStore.getState().chatProbes.codex).toEqual({ phase: 'checking' });
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it('records a failed check as a failed probe rather than as absence', async () => {
    stubBridge({
      settings: { update: (next: AppSettings) => Promise.resolve(next) },
      credentials: { getOpenRouterStatus: () => Promise.reject(new Error('no')) },
      agent: { listProfileStatus: () => Promise.reject(new Error('no')) },
      ai: { getProviderStatus: () => Promise.reject(new Error('The check failed.')) },
    });
    await useOnboardingStore.getState().refreshDiscovery();
    expect(useOnboardingStore.getState().chatProbes.codex).toEqual({
      phase: 'failed',
      message: 'The check failed.',
    });
  });

  it('maps every voluntary exit to a status that suppresses reopening', async () => {
    for (const [reason, expected] of [
      ['skip-ai', 'finish-later'],
      ['finish-later', 'finish-later'],
      ['dismissed', 'dismissed'],
      ['completed', 'completed'],
    ] as const) {
      const harness = installApi();
      useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
      useOnboardingStore.getState().closeWizard(reason);
      await drain();
      expect(useOnboardingStore.getState().status).toBe(expected);
      expect(harness.settingsWrites.at(-1)?.onboarding.status).toBe(expected);
      resetSettingsWriteQueueForTests();
    }
  });

  it('stamps a completion time once', async () => {
    const harness = installApi();
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    useOnboardingStore.getState().closeWizard('completed');
    await drain();
    const first = harness.settingsWrites.at(-1)?.onboarding.completedAt;
    expect(first).not.toBeNull();

    useOnboardingStore.getState().closeWizard('completed');
    await drain();
    expect(harness.settingsWrites.at(-1)?.onboarding.completedAt).toBe(first);
  });

  it('only ever moves the resume point forward', async () => {
    installApi();
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    useOnboardingStore.getState().acknowledgeStage('connect');
    await drain();
    useOnboardingStore.getState().acknowledgeStage('welcome');
    await drain();
    expect(useOnboardingStore.getState().lastStageAcknowledged).toBe('connect');
  });

  it('persists an explicitly confirmed chat default', async () => {
    const harness = installApi();
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    await useOnboardingStore.getState().setChatDefault('openrouter', 'openrouter/auto');
    expect(harness.settingsWrites.at(-1)?.ai.defaultChat).toEqual({
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    });
    expect(useOnboardingStore.getState().saveError).toBeNull();
  });

  it('persists an agent default as a complete profile record', async () => {
    const harness = installApi();
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    await useOnboardingStore.getState().setAgentDefault('claude-code', 'sonnet');
    const saved = harness.settingsWrites.at(-1);
    expect(saved?.agent.defaultProfileId).toBe('claude-code');
    expect(saved?.agent.profiles['claude-code']?.defaultModel).toBe('sonnet');
    expect(saved?.agent.profiles['claude-code']?.models).toContain('sonnet');
  });

  it('refuses to store a profile that is not a built-in default', async () => {
    const harness = installApi();
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    await useOnboardingStore.getState().setAgentDefault('custom:anything', null);
    expect(harness.settingsWrites).toHaveLength(0);
    expect(useOnboardingStore.getState().saveError).not.toBeNull();
  });

  it('reports a failed save instead of claiming progress was kept', async () => {
    stubBridge({ settings: { update: () => Promise.reject(new Error('Disk is full.')) } });
    useUiStore.setState({ loadedSettings: structuredClone(DEFAULT_APP_SETTINGS) });
    await useOnboardingStore.getState().setChatDefault('openrouter', null);
    expect(useOnboardingStore.getState().saveError).toBe('Disk is full.');
  });

  it('resets only the wizard when rerun from Settings', async () => {
    const harness = installApi();
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    const configured: AppSettings = {
      ...settings,
      ai: { ...settings.ai, defaultChat: { providerId: 'openrouter', modelId: 'openrouter/auto' } },
      onboarding: { ...settings.onboarding, status: 'completed', lastStageAcknowledged: 'first-action' },
    };
    useUiStore.setState({ loadedSettings: configured });
    useOnboardingStore.setState({ lastStageAcknowledged: 'first-action', status: 'completed' });

    useOnboardingStore.getState().rerunFromSettings('settings-rerun');
    await drain();

    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().stage).toBe('welcome');
    expect(useOnboardingStore.getState().openerId).toBe('settings-rerun');
    const saved = harness.settingsWrites.at(-1);
    expect(saved?.onboarding.lastStageAcknowledged).toBeNull();
    expect(saved?.ai.defaultChat).toEqual({ providerId: 'openrouter', modelId: 'openrouter/auto' });
  });
  it('starts discovery immediately on a direct Discover resume', async () => {
    const harnessDiscover = installApi();
    useOnboardingStore.getState().openWizard({ stage: 'discover' });
    await drain();

    expect(useOnboardingStore.getState().stage).toBe('discover');
    expect(useOnboardingStore.getState().observing).toBe(true);
    expect(harnessDiscover.providerCalls.length).toBeGreaterThan(0);
  });

  it('performs exactly one automatic discovery pass per opening, suppresses checks on navigation, and refreshes on explicit request', async () => {
    const harness = installApi();
    useOnboardingStore.getState().openWizard({ stage: 'welcome' });
    await drain();

    // 1. Welcome opens without observing and does not probe
    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().stage).toBe('welcome');
    expect(useOnboardingStore.getState().observing).toBe(false);
    expect(harness.providerCalls).toHaveLength(0);

    // 2. Entering Discover begins observing and performs the single automatic discovery pass
    useOnboardingStore.getState().goToStage('discover');
    await drain();
    expect(useOnboardingStore.getState().observing).toBe(true);
    const countAfterDiscover = harness.providerCalls.length;
    expect(countAfterDiscover).toBeGreaterThan(0);

    // 3. Navigating forward to Connect does not start another pass
    useOnboardingStore.getState().goToStage('connect');
    await drain();
    expect(harness.providerCalls).toHaveLength(countAfterDiscover);

    // 4. Navigating backward to Discover does not start another pass
    useOnboardingStore.getState().goToStage('discover');
    await drain();
    expect(harness.providerCalls).toHaveLength(countAfterDiscover);

    // 5. Navigating back to Welcome and forward to Discover again does not start another pass
    useOnboardingStore.getState().goToStage('welcome');
    await drain();
    useOnboardingStore.getState().goToStage('discover');
    await drain();
    expect(harness.providerCalls).toHaveLength(countAfterDiscover);

    // 6. Explicit refresh / "Check again" starts a fresh pass
    await useOnboardingStore.getState().refreshDiscovery();
    const countAfterExplicitRefresh = harness.providerCalls.length;
    expect(countAfterExplicitRefresh).toBeGreaterThan(countAfterDiscover);

    // 7. Navigating after explicit refresh still does not start automatic passes
    useOnboardingStore.getState().goToStage('connect');
    await drain();
    useOnboardingStore.getState().goToStage('discover');
    await drain();
    expect(harness.providerCalls).toHaveLength(countAfterExplicitRefresh);

    // 8. Closing and reopening starts a new opening with exactly one automatic pass
    useOnboardingStore.getState().closeWizard('finish-later');
    expect(useOnboardingStore.getState().open).toBe(false);

    useOnboardingStore.getState().openWizard({ stage: 'welcome' });
    await drain();
    expect(harness.providerCalls).toHaveLength(countAfterExplicitRefresh);

    useOnboardingStore.getState().goToStage('discover');
    await drain();
    expect(harness.providerCalls.length).toBeGreaterThan(countAfterExplicitRefresh);
  });

  it('starts exactly one automatic pass when opening directly on Connect and does not recheck on navigating to Discover', async () => {
    const harness = installApi();
    useOnboardingStore.getState().openWizard({ stage: 'connect' });
    await drain();

    expect(useOnboardingStore.getState().stage).toBe('connect');
    expect(useOnboardingStore.getState().observing).toBe(true);
    const countAtConnect = harness.providerCalls.length;
    expect(countAtConnect).toBeGreaterThan(0);

    useOnboardingStore.getState().goToStage('discover');
    await drain();

    expect(harness.providerCalls).toHaveLength(countAtConnect);

    // Explicit refresh on Discover starts a fresh pass
    await useOnboardingStore.getState().refreshDiscovery();
    expect(harness.providerCalls.length).toBeGreaterThan(countAtConnect);
  });

  it('shows agent detection rows before model refresh, updates with refreshed profiles, and drops late refresh on close', async () => {
    const initialStatus: AgentProfileStatus = {
      profileId: 'codex',
      providerId: 'codex',
      name: 'Codex',
      availability: 'installed',
      unavailability: 'none',
      version: '1.0.0',
      errorMessage: null,
      checkedAt: '2026-09-01T00:00:00.000Z',
      defaultModel: null,
      availableModels: [],
      supportsModelSelection: true,
      isCustom: false,
    };
    const refreshedCodex: AgentProfile = {
      id: 'codex',
      providerId: 'codex',
      name: 'Codex',
      defaultModel: 'gpt-4o',
      availableModels: ['gpt-4o', 'o3-mini'],
      reasoningEffort: null,
      defaultSandboxMode: 'auto-isolated',
      capabilities: {
        structuredOutput: true,
        sessionResume: true,
        nativeSandbox: true,
        workingDirectory: true,
        modelSelection: true,
        reasoningSelection: false,
        fileChangeEvents: false,
        toolEvents: true,
        subagents: false,
        interactiveAuthentication: false,
        nonInteractiveMode: true,
      },
      detection: {
        availability: 'installed',
        version: '1.0.0',
        checkedAt: '2026-09-01T00:00:00.000Z',
        errorMessage: null,
      },
      isCustom: false,
      unsafe: false,
    };

    const harness = installApi({
      agentSnapshot: { profiles: [initialStatus], modelDiscoveryPending: true },
      agentRefreshedProfiles: [refreshedCodex],
      deferAgentRefresh: true,
    });

    void useOnboardingStore.getState().refreshDiscovery();
    await drain();

    // 1. Agent detection row is visible before model refresh finishes
    const rowsBefore = selectOnboardingRows(useOnboardingStore.getState());
    const codexBefore = rowsBefore.find((r) => r.id === 'codex');
    expect(codexBefore?.agent?.selectable).toBe(true);
    expect(codexBefore?.agent?.models).toEqual([]);

    // 2. Final refreshed profiles update the row's models
    harness.settleAgentRefresh();
    await drain();

    const rowsAfter = selectOnboardingRows(useOnboardingStore.getState());
    const codexAfter = rowsAfter.find((r) => r.id === 'codex');
    expect(codexAfter?.agent?.models).toEqual(['gpt-4o', 'o3-mini']);

    // 3. Closing the wizard drops late refresh from an in-flight operation
    const harnessLate = installApi({
      agentSnapshot: { profiles: [initialStatus], modelDiscoveryPending: true },
      deferAgentRefresh: true,
    });
    void useOnboardingStore.getState().refreshDiscovery();
    await drain();

    useOnboardingStore.getState().closeWizard('finish-later');
    expect(useOnboardingStore.getState().observing).toBe(false);

    harnessLate.settleAgentRefresh([
      {
        ...refreshedCodex,
        availableModels: ['never-applied-model'],
      },
    ]);
    await drain();

    const codexProfiles = useOnboardingStore.getState().agentProfiles.find((p) => p.profileId === 'codex');
    expect(codexProfiles?.availableModels).not.toContain('never-applied-model');
  });
});
