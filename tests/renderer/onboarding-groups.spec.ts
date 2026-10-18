import { describe, expect, it } from 'vitest';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfileStatus } from '@shared/types/agent';
import {
  deriveOnboardingRows,
  type OnboardingProviderRow,
  type OnboardingRowInput,
  type RowProbe,
} from '../../src/renderer/features/onboarding/onboarding-rows';
import {
  groupOnboardingRows,
  onboardingGroupKey,
  primaryRowAction,
  rowReason,
} from '../../src/renderer/features/onboarding/onboarding-groups';

/**
 * Step 2's grouping.
 *
 * The property under test is that grouping never upgrades a row: a pending
 * probe keeps its row out of READY even when the other capability already
 * answered, and an unconfirmed runtime is never filed with the confirmed ones.
 */

function chatStatus(overrides: Partial<AIProviderStatus> & { readonly id: AIProviderId }): AIProviderStatus {
  return {
    name: overrides.id,
    available: false,
    installed: false,
    authentication: 'disconnected',
    version: null,
    errorMessage: null,
    models: [],
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

function readyChat(id: AIProviderId, modelId: string): RowProbe<AIProviderStatus> {
  return {
    phase: 'settled',
    value: chatStatus({
      id,
      installed: true,
      available: true,
      authentication: 'connected',
      models: [
        { id: modelId, name: modelId, contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true },
      ],
    }),
  };
}

function agentStatus(overrides: Partial<AgentProfileStatus> & { readonly profileId: string }): AgentProfileStatus {
  return {
    providerId: 'codex',
    name: overrides.profileId,
    availability: 'not-installed',
    unavailability: 'not-found',
    version: null,
    errorMessage: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
    defaultModel: null,
    availableModels: [],
    supportsModelSelection: false,
    isCustom: false,
    ...overrides,
  };
}

function input(overrides: Partial<OnboardingRowInput> = {}): OnboardingRowInput {
  return {
    chatProbes: {},
    agentProfiles: [],
    agentDiscoveryPending: false,
    agentDetectionPending: false,
    openRouterCredential: 'absent',
    ...overrides,
  };
}

function row(rows: readonly OnboardingProviderRow[], id: string): OnboardingProviderRow {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

describe('onboarding row groups', () => {
  it('keeps every row in checking until its own probes answer', () => {
    // A stored key is readable, so OpenRouter waits on its probe like the rest
    // instead of short-circuiting to "no key added".
    const rows = deriveOnboardingRows(input({ openRouterCredential: 'ready', agentDetectionPending: true }));
    const groups = groupOnboardingRows(rows);

    expect(groups.map((group) => group.key)).toEqual(['checking']);
    expect(groups[0]?.rows.length).toBe(rows.length);
  });

  it('holds a half-answered row out of ready', () => {
    // Chat has already settled as ready; agent detection has not answered.
    const rows = deriveOnboardingRows(
      input({ chatProbes: { codex: readyChat('codex', 'gpt-5-codex') }, agentDetectionPending: true })
    );

    expect(row(rows, 'codex').chat?.state).toBe('ready-chat');
    expect(onboardingGroupKey(row(rows, 'codex'))).toBe('checking');
  });

  it('separates ready, unconfirmed and unavailable rows and counts each group', () => {
    const rows = deriveOnboardingRows(
      input({
        openRouterCredential: 'ready',
        chatProbes: {
          openrouter: readyChat('openrouter', 'openrouter/auto'),
          local: { phase: 'settled', value: chatStatus({ id: 'local', installed: false }) },
          claude: { phase: 'settled', value: chatStatus({ id: 'claude', installed: false }) },
        },
        agentProfiles: [
          agentStatus({ profileId: 'opencode', providerId: 'opencode', availability: 'installed', unavailability: 'none' }),
          agentStatus({ profileId: 'copilot', providerId: 'copilot', unavailability: 'unsupported' }),
          agentStatus({ profileId: 'cursor', providerId: 'cursor' }),
        ],
      })
    );

    expect(onboardingGroupKey(row(rows, 'openrouter'))).toBe('ready');
    expect(onboardingGroupKey(row(rows, 'opencode'))).toBe('not-verified');
    // A stale legacy Copilot status is not a built-in row at all.
    expect(rows.some((entry) => entry.id === 'copilot')).toBe(false);
    // Agent-Mode-only and not installed: one agent readout, filed as missing.
    expect(onboardingGroupKey(row(rows, 'cursor'))).toBe('unavailable');
    expect(onboardingGroupKey(row(rows, 'local'))).toBe('unavailable');

    const groups = groupOnboardingRows(rows);
    // Order is the progression a user watches; rows whose probes have not
    // answered yet stay in front of it, and empty groups are omitted.
    expect(groups.map((group) => group.key)).toEqual(['checking', 'ready', 'not-verified', 'unavailable']);
    for (const group of groups) {
      expect(group.rows.length).toBeGreaterThan(0);
      expect(group.rows.length).toBe(rows.filter((entry) => onboardingGroupKey(entry) === group.key).length);
    }
  });

  it('carries the unconfirmed explanation once, at the group', () => {
    const rows = deriveOnboardingRows(
      input({
        agentProfiles: [
          agentStatus({ profileId: 'opencode', providerId: 'opencode', availability: 'installed', unavailability: 'none' }),
        ],
      })
    );
    const group = groupOnboardingRows(rows).find((entry) => entry.key === 'not-verified');

    expect(group?.description).toMatch(/not guaranteed to succeed/i);
    expect(groupOnboardingRows(rows).find((entry) => entry.key === 'ready')?.description ?? null).toBeNull();
  });

  it('offers one action per row, preferring the one that would unblock it', () => {
    const rows = deriveOnboardingRows(
      input({
        openRouterCredential: 'absent',
        chatProbes: {
          codex: { phase: 'settled', value: chatStatus({ id: 'codex', installed: true }) },
          claude: { phase: 'settled', value: chatStatus({ id: 'claude', installed: false }) },
        },
        agentProfiles: [
          agentStatus({ profileId: 'opencode', providerId: 'opencode', availability: 'installed', unavailability: 'none' }),
          agentStatus({ profileId: 'copilot', providerId: 'copilot', unavailability: 'unsupported' }),
          agentStatus({ profileId: 'cursor', providerId: 'cursor' }),
        ],
      })
    );

    expect(primaryRowAction(row(rows, 'openrouter'))).toBe('add-openrouter-key');
    // Cursor's absence is established by resolving its CLI, so the row offers
    // the documentation link rather than nothing.
    expect(primaryRowAction(row(rows, 'cursor'))).toBe('install-help');
    expect(primaryRowAction(row(rows, 'codex'))).toBe('sign-in-chatgpt');
    expect(primaryRowAction(row(rows, 'claude-code'))).toBe('retry');
    // Copilot is not offered at all, so there is no row to act on.
    expect(rows.some((entry) => entry.id === 'copilot')).toBe(false);
    // An installed-but-unconfirmed runtime can still be re-checked.
    expect(primaryRowAction(row(rows, 'opencode'))).toBe('retry');
  });

  it('checks the connection only on a row that is already ready', () => {
    const rows = deriveOnboardingRows(
      input({ openRouterCredential: 'ready', chatProbes: { openrouter: readyChat('openrouter', 'openrouter/auto') } })
    );

    expect(primaryRowAction(row(rows, 'openrouter'))).toBe('test-connection');
  });

  it('says why a row is unusable, and stays silent on the ready ones', () => {
    const rows = deriveOnboardingRows(
      input({
        openRouterCredential: 'ready',
        chatProbes: {
          openrouter: readyChat('openrouter', 'openrouter/auto'),
          local: {
            phase: 'settled',
            value: chatStatus({ id: 'local', installed: false, errorMessage: 'No server responded on 127.0.0.1.' }),
          },
        },
        agentProfiles: [
          agentStatus({ profileId: 'opencode', providerId: 'opencode', availability: 'installed', unavailability: 'none' }),
        ],
      })
    );

    expect(rowReason(row(rows, 'openrouter'), 'ready')).toBeNull();
    expect(rowReason(row(rows, 'local'), 'unavailable')).toBe('No server responded on 127.0.0.1.');
    expect(rowReason(row(rows, 'opencode'), 'not-verified')).toBe('Installed — sign-in not verified');
  });
});
