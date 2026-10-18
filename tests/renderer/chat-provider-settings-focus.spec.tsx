// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { ChatPanel } from '../../src/renderer/features/chat/ChatPanel';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const testDocument: DocumentMetadata = {
  id: 'doc-settings-focus',
  title: 'Consensus Guide',
  author: 'Leslie',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-settings-focus',
  pageCount: 10,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  source: null,
};

const fakeProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [{ id: 'fake-grounded', name: 'Deterministic Grounded Model', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
};

const session: ChatSession = {
  id: 'session-1',
  documentId: 'doc-settings-focus',
  documentHash: 'hash-settings-focus',
  title: 'Consensus Notes',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 2,
  previewText: 'Quorum consensus is guaranteed by majority overlap.',
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

/**
 * Mounts the chat panel and the settings dialog the way `App` does, so the
 * dialog's real open/close lifecycle — including the return target it captures
 * when it opens — is exercised rather than simulated by a callback.
 */
function ChatWithSettings() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  return (
    <>
      <ChatPanel />
      {settingsOpen && (
        <AIProviderSettingsModal
          open={settingsOpen}
          onClose={() => { useUiStore.getState().setSettingsOpen(false); }}
          onProvidersChanged={vi.fn()}
          initialTarget="ai"
        />
      )}
    </>
  );
}

describe('model picker to Settings focus lifecycle', () => {
  const listProviders = vi.fn(() => Promise.resolve([fakeProvider]));
  const updateSession = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ settingsOpen: false });
    stubBridge({
      app: { exportDebugLog: vi.fn(() => Promise.resolve({ status: 'cancelled' as const })) },
      ai: {
        listProviders,
        signInWithChatGPT: vi.fn(),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
        testOpenRouterConnection: vi.fn(),
      },
      settings: {
        get: vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))),
        update: vi.fn(),
      },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
      },
      chat: {
        listSessions: vi.fn(() => Promise.resolve([session])),
        getSession: vi.fn(() => Promise.resolve(session)),
        createSession: vi.fn(),
        updateSession,
        deleteSession: vi.fn(),
        listMessages: vi.fn(() => Promise.resolve([])),
        listContext: vi.fn(() => Promise.resolve([])),
        attachContext: vi.fn(),
        removeContext: vi.fn(),
        sendMessage: vi.fn(),
        cancel: vi.fn(),
        resolveCitation: vi.fn(),
        onStreamEvent: vi.fn(() => () => undefined),
      },
    });
    useReaderStore.setState({
      session: testReaderSession(testDocument),
      currentPage: 1,
      explicitNavigationLocation: { format: 'pdf', pageIndex: 0 },
    });
  });

  afterEach(async () => {
    cleanup();
    useUiStore.setState({ settingsOpen: false });
    await chat.getState().initializeDocument(null);
  });

  it('returns focus to the model picker when Settings is dismissed with Escape or its own control', async () => {
    renderWithChatStore(chat, <ChatWithSettings />);
    const trigger = await screen.findByTestId('chat-model-picker');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId('chat-provider-edit'));

    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog).toBeTruthy();
    // The picker is gone and the binding was not written.
    await waitFor(() => { expect(screen.queryByTestId('chat-model-picker-popover')).toBeNull(); });
    expect(updateSession).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
      expect(trigger).toHaveFocus();
    });

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId('chat-provider-edit'));
    await screen.findByRole('dialog', { name: 'Settings' });

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
      expect(trigger).toHaveFocus();
    });
    expect(chat.getState().sessions[0]?.providerId).toBe('fake');
    expect(chat.getState().sessions[0]?.modelId).toBe('fake-grounded');
  });
});
