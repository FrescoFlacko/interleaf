import { describe, expect, it } from 'vitest';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfileStatus } from '@shared/types/agent';
import {
  deriveOnboardingRows,
  hasPendingRows,
  selectableAgentRows,
  selectableChatRows,
  ONBOARDING_CHAT_PROVIDER_IDS,
  type OnboardingProviderRow,
  type OnboardingRowInput,
  type RowProbe,
} from '../../src/renderer/features/onboarding/onboarding-rows';
import { installationHelpUrl } from '../../src/renderer/features/onboarding/installation-help';

/**
 * The §4 detection/status matrix.
 *
 * These assertions are about distinctness as much as about labels: the nine
 * states the scope names must stay separately observable, because collapsing
 * "not installed" into "signed out", or "installed" into "ready", is exactly
 * the untruthful readiness the feature exists to avoid.
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

function settled(status: AIProviderStatus): RowProbe<AIProviderStatus> {
  return { phase: 'settled', value: status };
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

describe('onboarding provider rows', () => {
  it('keeps every unresolved row at checking without holding back the settled ones', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: { openrouter: { phase: 'checking' }, local: settled(chatStatus({ id: 'local' })) },
        agentDetectionPending: true,
        openRouterCredential: 'ready',
      })
    );

    expect(row(rows, 'openrouter').chat?.state).toBe('checking');
    expect(row(rows, 'local').chat?.state).toBe('local-unreachable');
    expect(row(rows, 'codex').agent?.state).toBe('checking');
    expect(hasPendingRows(rows)).toBe(true);
  });

  it('separates OpenRouter-not-configured from a stored key that cannot be read', () => {
    const absent = deriveOnboardingRows(input({ openRouterCredential: 'absent' }));
    expect(row(absent, 'openrouter').chat?.state).toBe('api-key-missing');
    expect(row(absent, 'openrouter').chat?.actions).toContain('add-openrouter-key');

    const unreadable = deriveOnboardingRows(input({ openRouterCredential: 'stored-unreadable' }));
    expect(row(unreadable, 'openrouter').chat?.state).toBe('error');
    expect(row(unreadable, 'openrouter').chat?.selectable).toBe(false);
  });

  it('offers the connection check only once there is a key to check', () => {
    // Nothing is configured yet, so there is no connection to check and the
    // only honest action is adding a key.
    const absent = deriveOnboardingRows(input({ openRouterCredential: 'absent' }));
    expect(absent.find((entry) => entry.id === 'openrouter')?.chat?.actions).not.toContain('test-connection');

    const configured = deriveOnboardingRows(
      input({
        openRouterCredential: 'ready',
        chatProbes: {
          openrouter: settled(
            chatStatus({
              id: 'openrouter',
              installed: true,
              available: true,
              authentication: 'connected',
              models: [
                {
                  id: 'openrouter/auto',
                  name: 'Auto',
                  contextWindow: 32_000,
                  maxOutputTokens: 2_048,
                  supportsStreaming: true,
                },
              ],
            })
          ),
        },
      })
    );
    const openrouter = row(configured, 'openrouter');
    expect(openrouter.chat?.state).toBe('ready-chat');
    expect(openrouter.chat?.actions).toContain('test-connection');
    // A connectivity check is never an inference offer. Asserted as a closed
    // set rather than as the absence of one name, so adding any prompt-sending
    // action to a row fails here instead of shipping quietly.
    const PERMITTED: readonly string[] = [
      'install-help', 'add-openrouter-key', 'configure-local-endpoint',
      'sign-in-chatgpt', 'test-connection', 'retry',
    ];
    for (const entry of configured) {
      for (const action of [...(entry.chat?.actions ?? []), ...(entry.agent?.actions ?? [])]) {
        expect(PERMITTED).toContain(action);
      }
    }
  });

  it('reports an unreachable local server without ever asking it to sign in', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          local: settled(
            chatStatus({ id: 'local', installed: false, errorMessage: 'No server responded on 127.0.0.1:11434.' })
          ),
        },
      })
    );

    const local = row(rows, 'local');
    expect(local.chat?.state).toBe('local-unreachable');
    expect(local.chat?.actions).toEqual(['configure-local-endpoint']);
    expect(local.chat?.label).not.toContain('Sign-in');
  });

  it('distinguishes a missing CLI from a CLI that is installed but signed out', () => {
    const missing = deriveOnboardingRows(
      input({ chatProbes: { claude: settled(chatStatus({ id: 'claude', installed: false })) } })
    );
    expect(row(missing, 'claude-code').chat?.state).toBe('not-installed');
    expect(row(missing, 'claude-code').chat?.actions).toEqual(['install-help']);

    const signedOut = deriveOnboardingRows(
      input({ chatProbes: { claude: settled(chatStatus({ id: 'claude', installed: true })) } })
    );
    expect(row(signedOut, 'claude-code').chat?.state).toBe('sign-in-required');
  });

  it('offers the ChatGPT sign-in only for Codex', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          codex: settled(chatStatus({ id: 'codex', installed: true })),
          claude: settled(chatStatus({ id: 'claude', installed: true })),
        },
      })
    );

    expect(row(rows, 'codex').chat?.actions).toContain('sign-in-chatgpt');
    expect(row(rows, 'claude-code').chat?.actions).not.toContain('sign-in-chatgpt');
  });

  it('never calls an unsupported runtime ready, and never offers it installation help', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          antigravity: settled(
            chatStatus({
              id: 'antigravity',
              installed: true,
              available: false,
              authentication: 'connected',
              errorMessage: 'Antigravity does not expose a tool-free chat mode.',
            })
          ),
        },
        agentProfiles: [
          // A runtime main reports as refused outright (a product decision).
          agentStatus({ profileId: 'opencode', providerId: 'opencode', unavailability: 'unsupported' }),
          // A stale legacy Copilot status recreates no row: it is not built in.
          agentStatus({ profileId: 'copilot', providerId: 'copilot', unavailability: 'unsupported' }),
        ],
      })
    );

    const antigravity = row(rows, 'antigravity');
    expect(antigravity.chat?.state).toBe('unsupported');
    expect(antigravity.chat?.selectable).toBe(false);
    expect(antigravity.chat?.actions).toEqual([]);

    const unsupported = row(rows, 'opencode');
    expect(unsupported.agent?.state).toBe('unsupported');
    expect(unsupported.agent?.actions).toEqual([]);
    expect(unsupported.agent?.selectable).toBe(false);
    expect(rows.some((candidate) => candidate.id === 'copilot')).toBe(false);
  });

  it('lists Cursor as an Agent Mode runtime and never as a Reader Chat provider', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          // Cursor is not asked about for chat, and a status arriving anyway —
          // connected and available — still must not become a chat readout on
          // its row: it is Agent-Mode-only by registration, not by detection.
          cursor: settled(
            chatStatus({ id: 'cursor', installed: true, available: true, authentication: 'connected' })
          ),
        },
        agentProfiles: [agentStatus({ profileId: 'cursor', providerId: 'cursor', name: 'Cursor' })],
      })
    );

    const cursor = row(rows, 'cursor');
    expect(cursor.name).toBe('Cursor');
    expect(cursor.kind).toBe('agent');
    expect(cursor.chat).toBeNull();
    expect(cursor.chatProviderId).toBeNull();
    expect(cursor.agent).not.toBeNull();
    expect(selectableChatRows(rows).map((item) => item.id)).not.toContain('cursor');
    expect(ONBOARDING_CHAT_PROVIDER_IDS).not.toContain('cursor');
  });

  it('offers Cursor installation help when the CLI is absent, and selects it once found', () => {
    const missing = deriveOnboardingRows(
      input({ agentProfiles: [agentStatus({ profileId: 'cursor', providerId: 'cursor' })] })
    );
    const absent = row(missing, 'cursor');
    // Absence here is established by resolving `cursor-agent`, unlike Copilot's
    // product-decision unavailability, so the link is the honest offer.
    expect(absent.agent?.state).toBe('not-installed');
    expect(absent.agent?.actions).toEqual(['install-help']);
    expect(installationHelpUrl('cursor')).toBe('https://docs.cursor.com/en/cli/overview');

    const found = deriveOnboardingRows(
      input({
        agentProfiles: [
          agentStatus({
            profileId: 'cursor',
            providerId: 'cursor',
            availability: 'installed',
            unavailability: 'none',
          }),
        ],
      })
    );
    const installed = row(found, 'cursor');
    // Installation is not authentication: nothing has established a sign-in,
    // so the row says so while staying selectable for Agent Mode.
    expect(installed.agent?.state).toBe('installed-unverified');
    expect(selectableAgentRows(found).map((item) => item.id)).toContain('cursor');
  });

  it('keeps an authenticated provider with an empty catalog out of the ready state', () => {
    const rows = deriveOnboardingRows(
      input({
        openRouterCredential: 'ready',
        chatProbes: {
          openrouter: settled(
            chatStatus({ id: 'openrouter', available: true, authentication: 'connected', models: [] })
          ),
        },
      })
    );

    const openrouter = row(rows, 'openrouter');
    expect(openrouter.chat?.state).toBe('empty-catalog');
    expect(openrouter.chat?.selectable).toBe(false);
    expect(openrouter.chat?.models).toEqual([]);
  });

  it('renders an unknown authentication answer as unverified rather than signed out', () => {
    const rows = deriveOnboardingRows(
      input({ chatProbes: { pi: settled(chatStatus({ id: 'pi', installed: true, authentication: 'unknown' })) } })
    );

    const pi = row(rows, 'pi');
    expect(pi.chat?.state).toBe('unknown');
    expect(pi.chat?.actions).toEqual(['retry']);
    expect(pi.chat?.selectable).toBe(false);
  });

  it('treats a failed probe as unknown, never as absence', () => {
    const rows = deriveOnboardingRows(
      input({ chatProbes: { omp: { phase: 'failed', message: 'The check timed out.' } } })
    );

    const omp = row(rows, 'omp');
    expect(omp.chat?.state).toBe('unknown');
    expect(omp.chat?.detail).toBe('The check timed out.');
  });

  it('marks an installed agent runtime with no verified sign-in as installed-but-unverified', () => {
    const rows = deriveOnboardingRows(
      input({
        agentProfiles: [agentStatus({ profileId: 'opencode', providerId: 'opencode', availability: 'installed', unavailability: 'none' })],
      })
    );

    const opencode = row(rows, 'opencode');
    expect(opencode.agent?.state).toBe('installed-unverified');
    expect(opencode.agent?.selectable).toBe(true);
    expect(opencode.agent?.label).toBe('Installed — sign-in not verified');
  });

  it('reports chat and agent readiness independently on the same row', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          codex: settled(
            chatStatus({
              id: 'codex',
              installed: true,
              available: true,
              authentication: 'connected',
              models: [{ id: 'gpt-5-codex', name: 'gpt-5-codex', contextWindow: 256000, maxOutputTokens: 8192, supportsStreaming: true }],
            })
          ),
        },
        agentProfiles: [
          agentStatus({
            profileId: 'codex',
            availability: 'installed',
            unavailability: 'none',
            supportsModelSelection: true,
            availableModels: ['gpt-5-codex'],
          }),
        ],
      })
    );

    const codex = row(rows, 'codex');
    expect(codex.chat?.state).toBe('ready-chat');
    expect(codex.chat?.models).toEqual(['gpt-5-codex']);
    expect(codex.agent?.state).toBe('ready-agent');
    expect(selectableChatRows(rows).map((item) => item.id)).toEqual(['codex']);
    expect(selectableAgentRows(rows).map((item) => item.id)).toEqual(['codex']);
  });

  it('summarizes an agent-only runtime by its usable capability', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          antigravity: settled(
            chatStatus({ id: 'antigravity', installed: true, authentication: 'connected', available: false })
          ),
        },
        agentProfiles: [
          agentStatus({
            profileId: 'antigravity',
            providerId: 'antigravity',
            availability: 'installed',
            unavailability: 'none',
          }),
        ],
      })
    );

    const antigravity = row(rows, 'antigravity');
    expect(antigravity.chat?.label).toBe('Agent Mode only');
    expect(antigravity.statusLabel).toBe('Ready for Agent Mode');
    expect(antigravity.tone).toBe('ready');
  });

  it('lists a custom profile without probing it and keeps it out of the default choices', () => {
    const rows = deriveOnboardingRows(
      input({
        agentProfiles: [
          agentStatus({
            profileId: 'my-runner',
            providerId: 'custom',
            name: 'My Runner',
            availability: 'installed',
            unavailability: 'none',
            isCustom: true,
          }),
        ],
      })
    );

    const custom = row(rows, 'custom:my-runner');
    expect(custom.name).toBe('My Runner');
    expect(custom.chat).toBeNull();
    expect(selectableAgentRows(rows).map((item) => item.id)).not.toContain('custom:my-runner');
  });

  it('bounds an untrusted provider message before showing it', () => {
    const rows = deriveOnboardingRows(
      input({
        chatProbes: {
          local: settled(
            chatStatus({ id: 'local', authentication: 'error', errorMessage: `x${'y'.repeat(500)}` })
          ),
        },
      })
    );

    const detail = row(rows, 'local').chat?.detail ?? '';
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.endsWith('…')).toBe(true);
  });
});
