import { afterEach, beforeEach, expect, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { DebugLogExportResult } from '@shared/schemas/ipc';
import type { InterleafAPI } from '@shared/types/api';
import { testAgentProfile } from './agent-profile';
import { stubBridge } from './interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS, USABLE_CREDENTIAL_STORAGE } from './credential-status';
import { DEVELOPMENT_UPDATE_STATE } from './updates-api';

export const claudeProvider: AIProviderStatus = {
  id: 'claude',
  name: 'Claude Code CLI',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '2.1.210',
  errorMessage: null,
  models: [
    {
      id: 'claude-default',
      name: 'Claude CLI default',
      contextWindow: 200_000,
      maxOutputTokens: 4_096,
      supportsStreaming: true,
    },
  ],
  capabilities: {
    streaming: true,
    subscriptionAuth: true,
    apiKeyAuth: false,
    persistentSessions: false,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

export const codexProvider: AIProviderStatus = {
  id: 'codex',
  name: 'Codex CLI',
  available: false,
  installed: true,
  authentication: 'connected',
  version: '0.149.1',
  errorMessage: 'Codex CLI has no verified tool-free mode in non-interactive exec; it remains available for Agent Mode only.',
  models: [
    {
      id: 'codex-default',
      name: 'Codex CLI default',
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsStreaming: true,
    },
  ],
  capabilities: {
    streaming: true,
    subscriptionAuth: true,
    apiKeyAuth: false,
    persistentSessions: false,
    toolFreeMode: false,
    hostedWebSearch: false,
  },
};

const OPENROUTER_CATALOG: readonly AIModelInfo[] = [
  { id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 128000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'unavailable' }, output: { kind: 'unavailable' } } },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet', contextWindow: 200000, maxOutputTokens: 8192, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: 0.000003 }, output: { kind: 'priced', usdPerToken: 0.000015 } } },
  { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', contextWindow: 128000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: 0.0000025 }, output: { kind: 'priced', usdPerToken: 0.00001 } } },
  { id: 'demo/free-tier', name: 'Demo Free Tier (zero price)', contextWindow: 8192, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'free' }, output: { kind: 'free' } } },
  { id: 'vendor/sentinel', name: 'Vendor Sentinel (-1)', contextWindow: 32000, maxOutputTokens: 8192, supportsStreaming: true, pricing: { input: { kind: 'unavailable' }, output: { kind: 'unavailable' } } },
  { id: 'vendor/partial', name: 'Vendor Partial (mixed directions)', contextWindow: 64000, maxOutputTokens: 8192, supportsStreaming: true, pricing: { input: { kind: 'unavailable' }, output: { kind: 'priced', usdPerToken: 0.000004 } } },
  { id: 'wide/priced-large', name: 'Wide Priced Large (2.5)', contextWindow: 128000, maxOutputTokens: 8192, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: 2.5 }, output: { kind: 'priced', usdPerToken: 1000 } } },
  { id: 'sci/tiny-rate', name: 'Sci Tiny Rate (1e-12)', contextWindow: 32000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: 1e-12 }, output: { kind: 'priced', usdPerToken: 1e-12 } } },
  { id: 'sci/sub-exponent-rate', name: 'Sci Sub Exponent Rate', contextWindow: 8000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: 1e-22 }, output: { kind: 'free' } } },
  { id: 'wide/near-max-finite', name: 'Near Max Finite Rate', contextWindow: 16000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'priced', usdPerToken: Number.MAX_VALUE }, output: { kind: 'free' } } },
  { id: 'opaque/unpublished', name: 'Opaque Unpublished (no price fields)', contextWindow: 16000, maxOutputTokens: 4096, supportsStreaming: true, pricing: { input: { kind: 'not_published' }, output: { kind: 'not_published' } } },
  { id: 'opaque/no-pricing-object', name: 'Opaque No Pricing Object', contextWindow: 8000, maxOutputTokens: 4096, supportsStreaming: true },
];

/**
 * The bridge doubles every Settings dialog spec starts from, installed afresh
 * before each test. `configured` is whether main reports a stored OpenRouter
 * key; tests flip it before rendering.
 */
export function settingsModalFixture() {
  const listProfiles = vi.fn(() => Promise.resolve([
    testAgentProfile('codex', 'Codex', { reasoningSelection: true }),
    testAgentProfile('claude-code', 'Claude Code', { reasoningSelection: true }),
    testAgentProfile('antigravity', 'Antigravity', { reasoningSelection: true }),
    testAgentProfile('copilot', 'GitHub Copilot'),
    testAgentProfile('opencode', 'OpenCode', { reasoningSelection: true }),
    testAgentProfile('pi', 'Pi'),
  ]));
  const fixture = {
    configured: false,
    // The full boundary payload: a stored key without a derivable preview is
    // the separate "unreadable" state, covered in settings-provider-accordion.spec.
    getOpenRouterStatus: vi.fn((): ReturnType<InterleafAPI['credentials']['getOpenRouterStatus']> => Promise.resolve({
      configured: fixture.configured,
      keyPreview: fixture.configured ? { prefix: 'sk-or-v1', lastFour: 'mnop' } : null,
      storageBackend: USABLE_CREDENTIAL_STORAGE,
    })),
    testOpenRouterConnection: vi.fn<InterleafAPI['credentials']['testOpenRouterConnection']>(() => Promise.resolve({ success: true, message: 'Connected successfully to OpenRouter.' })),
    listOpenRouterModels: vi.fn<() => Promise<readonly AIModelInfo[]>>(() => Promise.resolve(OPENROUTER_CATALOG)),
    clearOpenRouterKey: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
    configureOpenRouter: vi.fn((input: { readonly apiKey?: string; readonly model: string }) => {
      const next = {
        ...DEFAULT_APP_SETTINGS,
        ai: { ...DEFAULT_APP_SETTINGS.ai, openRouterModel: input.model },
      };
      return Promise.resolve(next);
    }),
    listProviders: vi.fn(() => Promise.resolve([claudeProvider, codexProvider])),
    signInWithChatGPT: vi.fn(() => Promise.resolve(codexProvider)),
    listProfiles,
    refreshModels: vi.fn(() => listProfiles()),
    getSettings: vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))),
    updateSettings: vi.fn((next: AppSettings) => Promise.resolve(next)),
    exportDebugLog: vi.fn<() => Promise<DebugLogExportResult>>(() => Promise.resolve({ status: 'cancelled' })),
    onClose: vi.fn(),
    onProvidersChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.configured = false;
    stubBridge({
      app: { exportDebugLog: fixture.exportDebugLog },
      ai: {
        listProviders: fixture.listProviders,
        signInWithChatGPT: fixture.signInWithChatGPT,
        listOpenRouterModels: fixture.listOpenRouterModels,
        configureOpenRouter: fixture.configureOpenRouter,
      },
      credentials: {
        getOpenRouterStatus: fixture.getOpenRouterStatus,
        clearOpenRouterKey: fixture.clearOpenRouterKey,
        testOpenRouterConnection: fixture.testOpenRouterConnection,
      },
      settings: {
        get: fixture.getSettings,
        update: fixture.updateSettings,
      },
      agent: {
        listProfiles: fixture.listProfiles,
        refreshModels: fixture.refreshModels,
        // Defect 17 mounts the Custom profiles surface only when selected;
        // the panel needs its narrow API to render its saved list.
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
      // About & Updates reads main's state when its rail section is shown.
      updates: { getState: vi.fn(() => Promise.resolve(DEVELOPMENT_UPDATE_STATE)) },
    });
  });
  afterEach(() => {
    cleanup();
  });

  return fixture;
}

/** Opens one provider accordion row and waits for its panel. */
export async function expandProvider(id: string): Promise<void> {
  await waitFor(() => { expect(screen.getByTestId(`provider-summary-${id}`)).toBeEnabled(); });
  if (screen.getByTestId(`provider-summary-${id}`).getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(screen.getByTestId(`provider-summary-${id}`));
  }
  await screen.findByTestId(`provider-panel-${id}`);
}
