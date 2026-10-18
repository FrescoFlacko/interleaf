// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfileStatus, AgentProfileStatusSnapshot } from '@shared/types/agent';
import type { AppSettings } from '@shared/schemas/settings';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { OnboardingLaunchState } from '@shared/types/onboarding';
import { resetSettingsWriteQueueForTests } from '../../src/renderer/app/api-client';
import { OnboardingHost } from '../../src/renderer/features/onboarding/OnboardingHost';
import { useOnboardingStore } from '../../src/renderer/stores/use-onboarding-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import {
  resolveDefaultChoice,
  type DefaultOption,
} from '../../src/renderer/features/onboarding/onboarding-defaults';
import { stubBridge } from '../helpers/interleaf-api';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { UNCONFIGURED_CREDENTIAL_STATUS, USABLE_CREDENTIAL_STORAGE } from '../helpers/credential-status';
import { chooseValue } from '../helpers/listbox-select';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * Step 3 — choosing defaults.
 *
 * The properties defended here are the ones a click-through would miss: a
 * suggestion is only a suggestion until Continue, both modes are written as one
 * settings document rather than two races, skipping writes nothing at all, and
 * a machine with nothing ready still lets the user leave the step.
 */

const INITIAL_ONBOARDING = useOnboardingStore.getState();

const READY_OPENROUTER_MODELS = ['openrouter/auto', 'anthropic/claude'] as const;

function launchState(): OnboardingLaunchState {
  return {
    verdict: 'new-install',
    shouldAutoOpen: true,
    resumeStage: 'welcome',
    settingsRowPresent: false,
    onboardingSectionPresent: false,
    priorInstallEvidence: false,
  };
}

function providerStatus(id: AIProviderId): AIProviderStatus {
  const ready = id === 'openrouter';
  return {
    id,
    name: id,
    available: ready,
    installed: ready,
    authentication: ready ? 'connected' : 'disconnected',
    version: null,
    errorMessage: null,
    models: ready
      ? READY_OPENROUTER_MODELS.map((model) => ({
          id: model,
          name: model,
          contextWindow: 32_000,
          maxOutputTokens: 2_048,
          supportsStreaming: true,
        }))
      : [],
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: true,
      persistentSessions: false,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
  };
}

function installedAgent(profileId: string): AgentProfileStatus {
  return {
    profileId,
    providerId: 'claude-code',
    name: profileId === 'claude-code' ? 'Claude Code' : profileId,
    availability: 'installed',
    unavailability: 'none',
    version: '2.1.273',
    errorMessage: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
    defaultModel: null,
    availableModels: ['sonnet', 'opus'],
    supportsModelSelection: true,
    isCustom: false,
  };
}

const settingsWrites: AppSettings[] = [];

type ApiOptions = {
  readonly openRouterConfigured?: boolean;
  readonly agents?: readonly AgentProfileStatus[];
};

function installApi({ openRouterConfigured = true, agents = [installedAgent('claude-code')] }: ApiOptions = {}): void {
  const snapshot: AgentProfileStatusSnapshot = { profiles: [...agents], modelDiscoveryPending: false };
  stubBridge({
    settings: {
      update: (next: AppSettings) => {
        settingsWrites.push(next);
        return Promise.resolve(next);
      },
    },
    onboarding: { getLaunchState: () => Promise.resolve(launchState()) },
    credentials: {
      getOpenRouterStatus: () =>
        Promise.resolve(
          openRouterConfigured
            ? { configured: true, keyPreview: { prefix: 'sk-or-v1', lastFour: '1234' }, storageBackend: USABLE_CREDENTIAL_STORAGE }
            : UNCONFIGURED_CREDENTIAL_STATUS
        ),
    },
    agent: { listProfileStatus: () => Promise.resolve(snapshot) },
    ai: { getProviderStatus: (id: AIProviderId) => Promise.resolve(providerStatus(id)) },
  });
}

/** Opens the wizard and walks to Step 3 with discovery settled. */
async function reachDefaultsStage(settings: AppSettings = DEFAULT_APP_SETTINGS): Promise<void> {
  renderWithChatStore(chat, <OnboardingHost />);
  await act(async () => {
    useUiStore.setState({ loadedSettings: settings });
    await Promise.resolve();
  });
  await screen.findByTestId('onboarding-wizard');
  fireEvent.click(screen.getByTestId('onboarding-continue'));
  await waitFor(() => {
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('discover');
  });
  await waitFor(() => {
    expect(useOnboardingStore.getState().chatProbes.openrouter?.phase).toBe('settled');
    expect(useOnboardingStore.getState().agentDetectionPending).toBe(false);
  });
  fireEvent.click(screen.getByTestId('onboarding-continue'));
  await waitFor(() => {
    expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('connect');
  });
}

function settingsWith(patch: (base: AppSettings) => AppSettings): AppSettings {
  return patch(structuredClone(DEFAULT_APP_SETTINGS));
}

function select(testId: string): HTMLElement {
  const element = screen.getByTestId(testId);
  if (element.getAttribute('role') !== 'combobox') throw new Error(`${testId} is not a select`);
  return element;
}

beforeEach(() => {
  settingsWrites.length = 0;
  const main = document.createElement('div');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.append(main);
});

afterEach(() => {
  cleanup();
  document.getElementById('main-content')?.remove();
  useOnboardingStore.setState(INITIAL_ONBOARDING, true);
  useUiStore.setState({ settingsOpen: false, loadedSettings: null });
  resetSettingsWriteQueueForTests();
  vi.restoreAllMocks();
});

describe('default resolution', () => {
  const options: readonly DefaultOption[] = [
    { id: 'openrouter', name: 'OpenRouter', models: ['openrouter/auto'] },
    { id: 'local', name: 'Local server', models: [] },
  ];

  it('keeps a stored default that is still available', () => {
    expect(resolveDefaultChoice(options, { id: 'local', modelId: null }, null)).toEqual({
      id: 'local',
      modelId: null,
    });
  });

  it('suggests the first ready option when the stored default is gone', () => {
    expect(resolveDefaultChoice(options, { id: 'codex', modelId: 'gpt-5-codex' }, null)).toEqual({
      id: 'openrouter',
      modelId: null,
    });
  });

  it('drops a model the provider no longer lists rather than binding to another', () => {
    expect(resolveDefaultChoice(options, { id: 'openrouter', modelId: 'retired-model' }, null)).toEqual({
      id: 'openrouter',
      modelId: null,
    });
  });

  it('prefers the user’s own edit over both', () => {
    expect(
      resolveDefaultChoice(options, { id: 'openrouter', modelId: 'openrouter/auto' }, { id: 'local', modelId: null })
    ).toEqual({ id: 'local', modelId: null });
  });

  it('has nothing to resolve when nothing is ready', () => {
    expect(resolveDefaultChoice([], { id: 'openrouter', modelId: null }, null)).toBeNull();
  });
});

describe('onboarding defaults stage', () => {
  it('shows one card with both modes and no provider action list', async () => {
    installApi();
    await reachDefaultsStage();

    expect(screen.getByTestId('onboarding-defaults-card')).toBeTruthy();
    expect(screen.getByTestId('onboarding-default-chat')).toBeTruthy();
    expect(screen.getByTestId('onboarding-default-agent')).toBeTruthy();
    // Detection stays on Step 2.
    expect(screen.queryByTestId('onboarding-rows')).toBeNull();
    expect(screen.queryByTestId('onboarding-recheck')).toBeNull();
  });

  it('starts from a persisted default that is still available', async () => {
    installApi();
    await reachDefaultsStage(
      settingsWith((base) => ({
        ...base,
        ai: { ...base.ai, defaultChat: { providerId: 'openrouter', modelId: 'anthropic/claude' } },
      }))
    );

    expect(select('onboarding-default-chat-provider').dataset.value).toBe('openrouter');
    expect(select('onboarding-default-chat-model').dataset.value).toBe('anthropic/claude');
  });

  it('suggests a ready option when nothing valid is stored, without writing it', async () => {
    installApi();
    await reachDefaultsStage();

    expect(select('onboarding-default-chat-provider').dataset.value).toBe('openrouter');
    expect(select('onboarding-default-agent-provider').dataset.value).toBe('claude-code');
    // A suggestion is not a save: only the wizard's own progress was written.
    expect(settingsWrites.every((write) => write.ai.defaultChat === null)).toBe(true);
    expect(settingsWrites.every((write) => write.agent.defaultProfileId === null)).toBe(true);
  });

  it('commits both modes in a single settings write on Continue', async () => {
    installApi();
    await reachDefaultsStage();

    chooseValue(select('onboarding-default-chat-model'), 'anthropic/claude');
    chooseValue(select('onboarding-default-agent-model'), 'opus');

    const before = settingsWrites.length;
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
    });

    await waitFor(() => {
      expect(settingsWrites.some((write) => write.ai.defaultChat !== null)).toBe(true);
    });
    // Exactly one write introduces the defaults, and it carries both of them:
    // a later write may inherit them, but nothing else ever sets them.
    const introductions = settingsWrites.filter((write, index) => {
      const previous = index === 0 ? null : (settingsWrites[index - 1]?.ai.defaultChat ?? null);
      return write.ai.defaultChat !== null && previous === null;
    });
    expect(introductions).toHaveLength(1);
    expect(settingsWrites.length - before).toBeLessThanOrEqual(2);
    const saved = introductions[0];
    expect(saved?.ai.defaultChat).toEqual({ providerId: 'openrouter', modelId: 'anthropic/claude' });
    expect(saved?.agent.defaultProfileId).toBe('claude-code');
    expect(saved?.agent.profiles['claude-code']?.defaultModel).toBe('opus');
  });

  it('writes nothing when the step is skipped', async () => {
    installApi();
    await reachDefaultsStage();

    fireEvent.click(screen.getByTestId('onboarding-skip-defaults'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
    });
    await act(async () => { await Promise.resolve(); });

    expect(settingsWrites.every((write) => write.ai.defaultChat === null)).toBe(true);
    expect(settingsWrites.every((write) => write.agent.defaultProfileId === null)).toBe(true);
  });

  it('supports partial availability: one mode chooses, the other explains', async () => {
    installApi({ agents: [] });
    await reachDefaultsStage();

    expect(select('onboarding-default-chat-provider').dataset.value).toBe('openrouter');
    expect(screen.getByTestId('onboarding-default-agent-empty').textContent).toMatch(/later in Settings/i);
    expect(screen.queryByTestId('onboarding-default-agent-provider')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(settingsWrites.some((write) => write.ai.defaultChat !== null)).toBe(true);
    });
    expect(settingsWrites.at(-1)?.agent.defaultProfileId).toBeNull();
  });

  it('never traps the user when nothing is ready at all', async () => {
    installApi({ openRouterConfigured: false, agents: [] });
    await reachDefaultsStage();

    expect(screen.getByTestId('onboarding-default-chat-empty')).toBeTruthy();
    expect(screen.getByTestId('onboarding-default-agent-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
    });
    expect(settingsWrites.every((write) => write.ai.defaultChat === null)).toBe(true);
  });

  it('leaves an existing stored default alone when nothing is ready', async () => {
    installApi({ openRouterConfigured: false, agents: [] });
    await reachDefaultsStage(
      settingsWith((base) => ({
        ...base,
        ai: { ...base.ai, defaultChat: { providerId: 'openrouter', modelId: null } },
      }))
    );

    fireEvent.click(screen.getByTestId('onboarding-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard').dataset.stage).toBe('import');
    });
    expect(useUiStore.getState().loadedSettings?.ai.defaultChat).toEqual({
      providerId: 'openrouter',
      modelId: null,
    });
  });

  it('names each control for the mode it belongs to and states that nothing is granted', async () => {
    installApi();
    await reachDefaultsStage();

    expect(screen.getByLabelText('Provider for Reader Chat')).toBe(select('onboarding-default-chat-provider'));
    expect(screen.getByLabelText('Model for Reader Chat')).toBe(select('onboarding-default-chat-model'));
    expect(screen.getByLabelText('Provider for Agent Mode')).toBe(select('onboarding-default-agent-provider'));
    expect(screen.getByTestId('onboarding-wizard').textContent).toContain('grants nothing and starts nothing');

    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
