// @vitest-environment jsdom
/**
 * The saved local model, from Settings to the session that is actually created.
 *
 * The renderer never asks main "what is the default model for this provider?" —
 * it takes the first entry of the published catalog. So the saved preference is
 * only real if it arrives at the head of that catalog and survives every layer
 * in between. These tests exercise that path with fixtures rather than a
 * server, and pair with the main-side half in `tests/unit/local-provider.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { LocalProviderPanel } from '../../src/renderer/features/chat/LocalProviderPanel';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { Mock } from 'vitest';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { chooseValue, optionValues } from '../helpers/listbox-select';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const testDocument: DocumentMetadata = {
  id: 'doc-local',
  title: 'Local Model Routing',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 2048,
  fileMtimeMs: 1,
  fileHash: 'hash-local',
  pageCount: 3,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

/**
 * A local status as main publishes it: the saved model first.
 *
 * `preferSavedModel` in the provider is what produces this order; here it is
 * the input, so this file tests the consumers of that contract.
 */
function localStatus(modelIds: readonly string[]): AIProviderStatus {
  return {
    id: 'local',
    name: 'Local server (loopback)',
    available: modelIds.length > 0,
    installed: true,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: modelIds.map((id) => ({
      id,
      name: id,
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      supportsStreaming: true,
    })),
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: false,
      persistentSessions: false,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
  };
}

describe('A new local chat uses the saved model', () => {
  const created: { providerId: string; modelId: string | null }[] = [];
  let published: AIProviderStatus = localStatus(['qwen3:8b', 'llama3.2']);

  const createSession = vi.fn((input: { documentId: string; providerId: string; modelId?: string | null }) => {
    created.push({ providerId: input.providerId, modelId: input.modelId ?? null });
    const session: ChatSession = {
      id: `session-${String(created.length)}`,
      documentId: input.documentId,
      documentHash: testDocument.fileHash,
      title: 'New Chat',
      providerId: input.providerId as ChatSession['providerId'],
      // Main stores whatever the renderer asked for, so the row is the
      // observable proof of which model the session was opened against.
      modelId: input.modelId ?? null,
      reasoningEffort: null,
      messageCount: 0,
      previewText: null,
      isArchived: false,
      compactedThroughOrdinal: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    return Promise.resolve(session);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    created.length = 0;
    published = localStatus(['qwen3:8b', 'llama3.2']);
    stubBridge({
      ai: { listProviders: vi.fn(() => Promise.resolve([published])) },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([])),
        getSession: vi.fn(() => Promise.resolve(null)),
        createSession,
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        sendMessage: vi.fn(),
        cancel: vi.fn(),
        attachContext: vi.fn(),
        removeContext: vi.fn(),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
  });


  it('opens the session against the head of the published catalog', async () => {
    await chat.getState().initializeDocument(testDocument);
    const session = await chat.getState().createSession('local');

    expect(created).toEqual([{ providerId: 'local', modelId: 'qwen3:8b' }]);
    expect(session?.modelId).toBe('qwen3:8b');
  });

  it('follows the catalog to the new endpoint rather than keeping the old model', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().createSession('local');

    // The endpoint changed in Settings; main re-probed and published a catalog
    // with no model in common with the previous server's.
    published = localStatus(['phi4', 'mistral']);
    await chat.getState().refreshProviders();
    await chat.getState().createSession('local');

    expect(created).toEqual([
      { providerId: 'local', modelId: 'qwen3:8b' },
      { providerId: 'local', modelId: 'phi4' },
    ]);
    // No identifier crossed endpoints: the second session cannot name a model
    // that only the first server offered.
    expect(created[1]?.modelId).not.toBe('qwen3:8b');
  });

  it('still honours a model the user picked explicitly for this session', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().createSession('local', 'llama3.2');

    expect(created).toEqual([{ providerId: 'local', modelId: 'llama3.2' }]);
  });
});

describe('The Settings panel never tests an address that is not saved', () => {
  afterEach(cleanup);

  function panel(overrides: {
    readonly settings?: AppSettings;
    readonly status?: AIProviderStatus;
  } = {}) {
    const onCheckConnection = vi.fn();
    const onSettingsChange = vi.fn();
    renderWithChatStore(chat,
      <LocalProviderPanel
        settings={overrides.settings ?? DEFAULT_APP_SETTINGS}
        onSettingsChange={onSettingsChange}
        status={overrides.status ?? localStatus(['qwen3:8b'])}
        settingsReady
        checking={false}
        onCheckConnection={onCheckConnection}
      />
    );
    return { onCheckConnection, onSettingsChange };
  }

  it('disables the check while the typed address differs from the saved one', () => {
    const { onCheckConnection } = panel();
    const button = screen.getByTestId('local-test-connection-button');
    expect(button).toBeEnabled();

    // A perfectly valid address, but not the one main would probe.
    fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:8080' } });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCheckConnection).not.toHaveBeenCalled();
    expect(screen.getByText(/Use address.*before checking it/u)).toBeInTheDocument();
  });

  it('re-enables the check once the address has been saved', () => {
    const saved: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, local: { ...DEFAULT_APP_SETTINGS.ai.local, endpoint: 'http://127.0.0.1:8080' } },
    };
    const { onCheckConnection } = panel({ settings: saved });

    fireEvent.click(screen.getByTestId('local-test-connection-button'));
    expect(onCheckConnection).toHaveBeenCalledTimes(1);
  });

  it('does not show a vanished saved model as the current selection', () => {
    const saved: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, local: { ...DEFAULT_APP_SETTINGS.ai.local, model: 'qwen3:8b' } },
    };
    // The server that is answering now publishes a different set entirely.
    panel({ settings: saved, status: localStatus(['phi4', 'mistral']) });

    const select = screen.getByTestId('local-model-select');
    expect(select.dataset.value).toBe('');
    expect(optionValues(select))
      .toEqual(['', 'phi4', 'mistral']);
  });

  it('shows a saved model that the server still offers', () => {
    const saved: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, local: { ...DEFAULT_APP_SETTINGS.ai.local, model: 'qwen3:8b' } },
    };
    panel({ settings: saved, status: localStatus(['qwen3:8b', 'phi4']) });

    const select = screen.getByTestId('local-model-select');
    expect(select.dataset.value).toBe('qwen3:8b');
  });
});

/**
 * Settings to Reader Chat, through the wiring the application actually uses.
 *
 * The tests above start from a status that has already been published. This one
 * does not: it renders the real dialog, saves through the real settings path,
 * and connects `onProvidersChanged` exactly as `App.tsx` does — to
 * `chat.refreshProviders`. The chat store subscribes to nothing else,
 * so if the dialog stops short of that callback the store keeps the previous
 * server's catalog and this test creates a session against the wrong model.
 */
describe('Saving a local endpoint reaches the chat store that creates sessions', () => {
  // Two servers with nothing in common, so any model identifier in a created
  // session names exactly one of them.
  const CATALOGS: Record<string, readonly string[]> = {
    'http://127.0.0.1:11434': ['llama3.2', 'qwen3:8b'],
    'http://127.0.0.1:8080': ['phi4', 'mistral'],
  };

  /** The narrow status probe the dialog calls; swapped by the timing test. */
  type StatusProbe = (id: string, options?: { readonly forceRefresh?: boolean }) => Promise<AIProviderStatus>;

  /** Fire an interaction and let the effects and promises it starts settle. */
  async function actEvent(run: () => void): Promise<void> {
    await act(async () => {
      run();
      await Promise.resolve();
    });
  }

  let saved: AppSettings;
  const created: { providerId: string; modelId: string | null }[] = [];

  /** Main's view of the local provider for whatever is currently saved. */
  function currentLocalStatus(): AIProviderStatus {
    const models = CATALOGS[saved.ai.local.endpoint] ?? [];
    const preferred = saved.ai.local.model;
    // `preferSavedModel`, as main applies it before publishing: the saved model
    // first when the server still lists it.
    const ordered = preferred !== null && models.includes(preferred)
      ? [preferred, ...models.filter((id) => id !== preferred)]
      : models;
    return localStatus(ordered);
  }

  let getProviderStatus: Mock<StatusProbe>;
  let listProviders: Mock<() => Promise<readonly AIProviderStatus[]>>;

  beforeEach(() => {
    vi.clearAllMocks();
    created.length = 0;
    saved = structuredClone(DEFAULT_APP_SETTINGS);
    saved.ai.local.endpoint = 'http://127.0.0.1:11434';
    listProviders = vi.fn(() => Promise.resolve([currentLocalStatus()]));
    getProviderStatus = vi.fn(() => Promise.resolve(currentLocalStatus()));
    stubBridge({
      app: { exportDebugLog: vi.fn(() => Promise.resolve({ status: 'cancelled' as const })) },
      ai: {
        listProviders,
        getProviderStatus: (id: string, options?: { readonly forceRefresh?: boolean }) =>
          getProviderStatus(id, options),
        signInWithChatGPT: vi.fn(),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
        clearOpenRouterKey: vi.fn(),
        testOpenRouterConnection: vi.fn(),
      },
      settings: {
        get: vi.fn(() => Promise.resolve(structuredClone(saved))),
        // Main is the one that validates and returns the confirmed document;
        // the dialog only ever adopts what comes back from here.
        update: vi.fn((next: AppSettings) => {
          saved = structuredClone(next);
          return Promise.resolve(structuredClone(saved));
        }),
      },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([])),
        refreshModels: vi.fn(() => Promise.resolve([])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([])),
        getSession: vi.fn(() => Promise.resolve(null)),
        createSession: vi.fn((input: { documentId: string; providerId: string; modelId?: string | null }) => {
          created.push({ providerId: input.providerId, modelId: input.modelId ?? null });
          return Promise.resolve({
            id: `session-${String(created.length)}`,
            documentId: input.documentId,
            documentHash: testDocument.fileHash,
            title: 'New Chat',
            providerId: input.providerId as ChatSession['providerId'],
            modelId: input.modelId ?? null,
            reasoningEffort: null,
            messageCount: 0,
            previewText: null,
            isArchived: false,
            compactedThroughOrdinal: null,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          } satisfies ChatSession);
        }),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        sendMessage: vi.fn(),
        cancel: vi.fn(),
        attachContext: vi.fn(),
        removeContext: vi.fn(),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  /** Render the dialog with the callback `App.tsx` gives it, and open Local. */
  async function openLocalPanel(): Promise<void> {
    renderWithChatStore(chat,
      <AIProviderSettingsModal
        open
        onClose={() => undefined}
        onProvidersChanged={() => { void chat.getState().refreshProviders(); }}
        initialTarget="ai"
      />
    );
    await waitFor(() => { expect(screen.getByTestId('provider-summary-local')).toBeEnabled(); });
    if (screen.getByTestId('provider-summary-local').getAttribute('aria-expanded') !== 'true') {
      fireEvent.click(screen.getByTestId('provider-summary-local'));
    }
    await screen.findByTestId('provider-panel-local');
    await waitFor(() => { expect(screen.getByTestId('local-endpoint-input')).toBeEnabled(); });
  }

  /** Wait for the save, the forced re-probe, and the store refresh it triggers. */
  async function settleRefresh(before: number): Promise<void> {
    await waitFor(() => { expect(getProviderStatus.mock.calls.length).toBeGreaterThan(before); });
    await waitFor(() => {
      expect(chat.getState().providers[0]?.models[0]?.id)
        .toBe(currentLocalStatus().models[0]?.id);
    });
  }

  it('creates the next session against the newly saved endpoint catalog', async () => {
    await act(async () => { await chat.getState().initializeDocument(testDocument); });
    await act(async () => { await chat.getState().createSession('local'); });
    expect(created).toEqual([{ providerId: 'local', modelId: 'llama3.2' }]);

    await openLocalPanel();
    await actEvent(() => {
      fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:8080' } });
      fireEvent.click(screen.getByTestId('local-endpoint-save-button'));
    });
    await act(async () => { await settleRefresh(0); });

    expect(saved.ai.local.endpoint).toBe('http://127.0.0.1:8080');
    expect(getProviderStatus).toHaveBeenCalledWith('local', { forceRefresh: true });

    // No explicit model: the store must have re-read the catalog for the server
    // that is now saved, rather than still holding the previous one's.
    await act(async () => { await chat.getState().createSession('local'); });
    expect(created[1]).toEqual({ providerId: 'local', modelId: 'phi4' });
    expect(CATALOGS['http://127.0.0.1:11434']).not.toContain(created[1]?.modelId);
  });

  it('creates the next session against the model the reader chose in Settings', async () => {
    await act(async () => { await chat.getState().initializeDocument(testDocument); });
    await act(async () => { await chat.getState().createSession('local'); });

    await openLocalPanel();
    // The listbox opens and commits as two user events, each flushed by act.
    chooseValue(screen.getByTestId('local-model-select'), 'qwen3:8b');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await settleRefresh(0); });

    expect(saved.ai.local.model).toBe('qwen3:8b');
    // The saved model is not the first the server lists, so a session that
    // lands on it can only have come from the preference being honoured.
    expect(CATALOGS['http://127.0.0.1:11434']?.[0]).toBe('llama3.2');
    await act(async () => { await chat.getState().createSession('local'); });
    expect(created[1]).toEqual({ providerId: 'local', modelId: 'qwen3:8b' });
  });

  it('leaves the chat store alone when a save changes nothing local', async () => {
    await act(async () => { await chat.getState().initializeDocument(testDocument); });
    await openLocalPanel();

    await actEvent(() => {
      fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:11434' } });
    });
    // The typed address matches the saved one, so there is nothing to save and
    // no reason to make every chat surface re-read its providers.
    expect(screen.getByTestId('local-endpoint-save-button')).toBeDisabled();
    expect(getProviderStatus).not.toHaveBeenCalled();
  });

  it('re-probes the saved endpoint when the reader checks the connection', async () => {
    await act(async () => { await chat.getState().initializeDocument(testDocument); });
    await openLocalPanel();

    await actEvent(() => {
      fireEvent.click(screen.getByTestId('local-test-connection-button'));
    });
    await act(async () => { await settleRefresh(0); });

    expect(getProviderStatus).toHaveBeenCalledWith('local', { forceRefresh: true });
    expect(screen.getByTestId('local-test-connection-button')).toHaveTextContent('Check connection');
    expect(screen.getByTestId('provider-panel-local')).toHaveTextContent('Connected — 2 models available.');
  });

  it('ignores a slow re-probe of an endpoint the reader has already replaced', async () => {
    // The first probe is held open deliberately: it stands for a server that is
    // slow to answer, whose answer arrives after the reader has moved on.
    let releaseStale: (() => void) | null = null;
    getProviderStatus = vi.fn(() => {
      const snapshot = currentLocalStatus();
      if (releaseStale !== null) return Promise.resolve(snapshot);
      return new Promise<AIProviderStatus>((resolve) => {
        releaseStale = () => { resolve(snapshot); };
      });
    });

    await act(async () => { await chat.getState().initializeDocument(testDocument); });
    await openLocalPanel();

    // Save B. Its probe hangs.
    await actEvent(() => {
      fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:8080' } });
      fireEvent.click(screen.getByTestId('local-endpoint-save-button'));
    });
    await waitFor(() => { expect(getProviderStatus).toHaveBeenCalledTimes(1); });

    // Change back to A. Its probe answers immediately and is the current one.
    await actEvent(() => {
      fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:11434' } });
      fireEvent.click(screen.getByTestId('local-endpoint-save-button'));
    });
    await act(async () => { await settleRefresh(1); });
    const refreshesSoFar = listProviders.mock.calls.length;

    // Only now does B's probe come back, describing a server that is no longer
    // the saved one.
    await act(async () => {
      releaseStale?.();
      await Promise.resolve();
    });

    // It neither replaced the catalog nor asked every chat surface to re-read.
    expect(listProviders.mock.calls).toHaveLength(refreshesSoFar);
    expect(chat.getState().providers[0]?.models.map((model) => model.id)).toEqual(['llama3.2', 'qwen3:8b']);
    await act(async () => { await chat.getState().createSession('local'); });
    expect(created.at(-1)).toEqual({ providerId: 'local', modelId: 'llama3.2' });
  });
});
