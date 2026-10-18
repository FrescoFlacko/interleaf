// @vitest-environment jsdom
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { aiProviderStatusSchema } from '@shared/schemas/ai';
import { agentProfileSchema, agentProfileStatusSnapshotSchema } from '@shared/schemas/agent';
import type { AppSettings } from '@shared/schemas/settings';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfile, AgentProfileStatusSnapshot } from '@shared/types/agent';
import { z } from 'zod';
import { invokeChannel } from '@main/ipc/dispatcher';
import { createSenderRule } from '@main/ipc/sender-validation';
import { selectOnboardingRows, useOnboardingStore } from '../../src/renderer/stores/use-onboarding-store';
import { stubBridge, testBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

/**
 * Progressive discovery across the real IPC boundary.
 *
 * The renderer store here talks to a preload-shaped bridge that calls the real
 * `invokeChannel` — the same sender rule, request validation, handler
 * invocation and result envelope main uses — over a deterministic fake provider
 * service. No executable is resolved and no provider is contacted, so the
 * behaviour under test is the boundary's, not a real CLI's.
 *
 * What matters is that one unfinished check never holds back the others: a
 * hanging provider leaves its own row at `checking` while every other row
 * reaches its true state.
 */

const indexHtmlPath = path.resolve('out/renderer/index.html');
const senderRule = createSenderRule({ indexHtmlPath });
const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const event = { senderFrame: { url: pathToFileURL(indexHtmlPath).href } } as never;

const INITIAL_STORE = useOnboardingStore.getState();

function status(id: AIProviderId, overrides: Partial<AIProviderStatus> = {}): AIProviderStatus {
  return {
    id,
    name: id,
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

const READY_CODEX = status('codex', {
  available: true,
  installed: true,
  authentication: 'connected',
  models: [
    { id: 'gpt-5-codex', name: 'gpt-5-codex', contextWindow: 200_000, maxOutputTokens: 8_192, supportsStreaming: true },
  ],
});

const AGENT_SNAPSHOT: AgentProfileStatusSnapshot = {
  profiles: [
    {
      profileId: 'codex',
      providerId: 'codex',
      name: 'Codex',
      availability: 'installed',
      unavailability: 'none',
      version: '1.2.3',
      errorMessage: null,
      checkedAt: '2026-01-01T00:00:00.000Z',
      defaultModel: 'gpt-5-codex',
      availableModels: ['gpt-5-codex'],
      supportsModelSelection: true,
      isCustom: false,
    },
    {
      profileId: 'copilot',
      providerId: 'copilot',
      name: 'GitHub Copilot',
      availability: 'not-installed',
      unavailability: 'unsupported',
      version: null,
      errorMessage: 'This runtime is not supported by Interleaf.',
      checkedAt: '2026-01-01T00:00:00.000Z',
      defaultModel: null,
      availableModels: [],
      supportsModelSelection: false,
      isCustom: false,
    },
    {
      profileId: 'cursor',
      providerId: 'cursor',
      name: 'Cursor',
      availability: 'not-installed',
      // Unlike a refused runtime's, Cursor's absence is established by resolving its CLI,
      // so it is `not-found` and the row may offer installation help.
      unavailability: 'not-found',
      version: null,
      errorMessage: null,
      checkedAt: '2026-01-01T00:00:00.000Z',
      defaultModel: null,
      availableModels: [],
      supportsModelSelection: false,
      isCustom: false,
    },
  ],
  modelDiscoveryPending: false,
};
const READY_AGENT_PROFILE: AgentProfile = {
  id: 'codex',
  providerId: 'codex',
  name: 'Codex',
  defaultModel: 'gpt-5-codex',
  availableModels: ['gpt-5-codex'],
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
    version: '1.2.3',
    checkedAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
  },
  isCustom: false,
  unsafe: false,
};


/** A preload-shaped bridge whose every call crosses the real dispatcher. */
function installBridge(options: { readonly hang: readonly AIProviderId[] }): {
  readonly settle: (id: AIProviderId, value: AIProviderStatus) => void;
  /** Every provider id the wizard actually asked main about. */
  readonly requested: readonly AIProviderId[];
} {
  const pending = new Map<AIProviderId, (value: AIProviderStatus) => void>();
  const requested: AIProviderId[] = [];

  function unwrap<T>(envelope: { ok: boolean; data?: T; error?: { message: string } }): T {
    if (!envelope.ok || envelope.data === undefined) {
      throw new Error(envelope.error?.message ?? 'The request failed.');
    }
    return envelope.data;
  }

  const providerService = {
    getProviderStatus: (providerId: AIProviderId): Promise<AIProviderStatus> => {
      requested.push(providerId);
      if (options.hang.includes(providerId)) {
        return new Promise<AIProviderStatus>((resolve) => { pending.set(providerId, resolve); });
      }
      return Promise.resolve(providerId === 'codex' ? READY_CODEX : status(providerId));
    },
  };

  stubBridge({
    settings: { update: (next: AppSettings) => Promise.resolve(next) },
    credentials: { getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS) },
    ai: {
      getProviderStatus: async (providerId: AIProviderId, options2?: { forceRefresh?: boolean }) =>
        unwrap(
          await invokeChannel(
            IPC.aiGetProviderStatus,
            (req) => providerService.getProviderStatus(req.providerId),
            { providerId, forceRefresh: options2?.forceRefresh ?? false },
            event,
            { senderRule, log }
          )
        ),
    },
    agent: {
      listProfileStatus: async () =>
        unwrap(
          await invokeChannel(
            IPC.agentListProfileStatus,
            () => AGENT_SNAPSHOT,
            undefined,
            event,
            { senderRule, log }
          )
        ),
      refreshModels: async () =>
        unwrap(
          await invokeChannel(
            IPC.agentRefreshModels,
            () => [READY_AGENT_PROFILE],
            undefined,
            event,
            { senderRule, log }
          )
        ),
    },
  });

  return { settle: (id, value) => { pending.get(id)?.(value); }, requested };
}

afterEach(() => {
  useOnboardingStore.setState(INITIAL_STORE, true);
});

describe('guided onboarding discovery across the IPC boundary', () => {
  it('settles rows independently while one provider check never answers', async () => {
    const bridge = installBridge({ hang: ['claude'] });
    const discovery = useOnboardingStore.getState().refreshDiscovery();

    // Let every non-hanging round trip complete without awaiting the whole set.
    for (let index = 0; index < 40; index += 1) await Promise.resolve();

    const rows = selectOnboardingRows(useOnboardingStore.getState());
    const byId = (id: string): (typeof rows)[number] | undefined => rows.find((row) => row.id === id);

    expect(byId('claude-code')?.chat?.state).toBe('checking');
    expect(byId('codex')?.chat?.state).toBe('ready-chat');
    expect(byId('codex')?.agent?.state).toBe('ready-agent');
    expect(byId('openrouter')?.chat?.state).toBe('api-key-missing');
    expect(byId('local')?.chat?.state).toBe('local-unreachable');
    expect(byId('opencode')?.chat).toBeNull();
    // A legacy Copilot status crossing the boundary recreates no row.
    expect(byId('copilot')).toBeUndefined();
    // Cursor crosses the boundary as an Agent Mode runtime only: no Reader Chat
    // readout, and no chat status was requested for it at all.
    expect(byId('cursor')?.chat).toBeNull();
    expect(byId('cursor')?.agent?.state).toBe('not-installed');
    expect(byId('cursor')?.agent?.actions).toEqual(['install-help']);
    expect(bridge.requested).not.toContain('cursor');

    bridge.settle('claude', status('claude', { installed: false }));
    await discovery;
    expect(
      selectOnboardingRows(useOnboardingStore.getState()).find((row) => row.id === 'claude-code')?.chat?.state
    ).toBe('not-installed');
  });

  it('carries payloads that satisfy the published result schemas', async () => {
    installBridge({ hang: [] });
    const api = testBridge;

    expect(aiProviderStatusSchema.safeParse(await api.ai.getProviderStatus('codex')).success).toBe(true);
    expect(agentProfileStatusSnapshotSchema.safeParse(await api.agent.listProfileStatus()).success).toBe(true);
    expect(z.array(agentProfileSchema).safeParse(await api.agent.refreshModels()).success).toBe(true);
  });

  it('rejects a provider id the contract does not allow', async () => {
    const envelope = await invokeChannel(
      IPC.aiGetProviderStatus,
      () => READY_CODEX,
      { providerId: 'not-a-provider', forceRefresh: false },
      event,
      { senderRule, log }
    );

    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.error.code).toBe('validation');
  });
});
