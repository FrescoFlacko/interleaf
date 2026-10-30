// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AppSettings } from '@shared/schemas/settings';
import { applyDefaultChatBinding } from '../../src/renderer/stores/chat/provider-readiness';
import { initialDraftProfileId } from '../../src/renderer/stores/use-agent-store';
import type { AgentProfile } from '@shared/types/agent';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * What a chosen default is allowed to touch.
 *
 * The rule under test is narrow on purpose: a default is a starting point for
 * something being created now. An open conversation, a queued run and a draft
 * the user already pointed somewhere keep exactly what they were bound to, so
 * choosing a default in onboarding can never re-route work in flight.
 */

const DOCUMENT: DocumentMetadata = {
  id: 'doc-defaults',
  title: 'Defaults',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-defaults',
  pageCount: 2,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

function provider(id: AIProviderStatus['id'], modelId: string): AIProviderStatus {
  return {
    id,
    name: id,
    available: true,
    installed: true,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: [{ id: modelId, name: modelId, contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true }],
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: false,
      persistentSessions: true,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
  };
}

const EXISTING_SESSION: ChatSession = {
  id: 'session-existing',
  documentId: DOCUMENT.id,
  documentHash: DOCUMENT.fileHash,
  title: 'Existing conversation',
  providerId: 'fake',
  modelId: 'fake-grounded',
  reasoningEffort: null,
  messageCount: 3,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

type CreateInput = {
  documentId: string;
  title?: string;
  providerId: string;
  modelId?: string | null;
};

const createSession = vi.fn<(input: CreateInput) => Promise<ChatSession>>((input) =>
  Promise.resolve({
    ...EXISTING_SESSION,
    id: 'session-new',
    title: 'New conversation',
    providerId: input.providerId as ChatSession['providerId'],
    modelId: input.modelId ?? null,
    messageCount: 0,
  })
);

function settingsWithChatDefault(defaultChat: AppSettings['ai']['defaultChat']): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat } };
}
let persistedSessions: readonly ChatSession[] = [EXISTING_SESSION];

beforeEach(() => {
  vi.clearAllMocks();
  persistedSessions = [EXISTING_SESSION];
  stubBridge({
    ai: { listProviders: () => Promise.resolve([provider('fake', 'fake-grounded'), provider('openrouter', 'openrouter/auto')]) },
    chat: {
      listSessions: () => Promise.resolve(persistedSessions),
      getSession: () => Promise.resolve(EXISTING_SESSION),
      createSession,
      listMessages: () => Promise.resolve([]),
      listContext: () => Promise.resolve([]),
      attachContext: ({ sessionId, documentHash }) => Promise.resolve({
        id: 'item-1', sessionId, kind: 'selection' as const, sourceRef: {},
        excerptText: 'hello', excerptHash: 'hash-hello', documentHash,
        location: { format: 'pdf' as const, pageIndex: 1 }, provenance: {},
        displayLabel: 'Passage', pinned: false, createdAt: '2026-01-01T00:00:00.000Z',
      }),
      onStreamEvent: () => () => undefined,
    },
  });
});

afterEach(() => {
  useUiStore.setState({ loadedSettings: null });
});

describe('chat default binding', () => {
  it('never overrides a provider the caller named', () => {
    const resolved = applyDefaultChatBinding('openrouter', 'openrouter/auto', {
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
    expect(resolved).toEqual({ providerId: 'openrouter', modelId: 'openrouter/auto' });
  });

  it('fills only an unspecified choice', () => {
    expect(applyDefaultChatBinding(undefined, undefined, { providerId: 'fake', modelId: 'fake-grounded' })).toEqual({
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
  });

  it('leaves the choice open when no default was ever stored', () => {
    expect(applyDefaultChatBinding(undefined, undefined, null)).toEqual({ providerId: undefined, modelId: undefined });
  });

  it('does not attach the default model to a different provider', () => {
    const resolved = applyDefaultChatBinding('openrouter', undefined, {
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
    expect(resolved.modelId).toBeUndefined();
  });
});

describe('chat sessions', () => {
  it('starts a new conversation on the stored default', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault({ providerId: 'openrouter', modelId: 'openrouter/auto' }) });
    await chat.getState().initializeDocument(DOCUMENT);

    await chat.getState().createSession();

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', modelId: 'openrouter/auto' })
    );
  });

  it('leaves an existing conversation bound to what it was created with', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault({ providerId: 'openrouter', modelId: 'openrouter/auto' }) });
    await chat.getState().initializeDocument(DOCUMENT);

    const existing = chat.getState().sessions.find((session) => session.id === EXISTING_SESSION.id);
    expect(existing?.providerId).toBe('fake');
    expect(existing?.modelId).toBe('fake-grounded');
  });

  it('still honours an explicit choice over the default', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault({ providerId: 'openrouter', modelId: 'openrouter/auto' }) });
    await chat.getState().initializeDocument(DOCUMENT);

    await chat.getState().createSession('fake', 'fake-grounded');

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'fake', modelId: 'fake-grounded' })
    );
  });
  it('ensureSessionForDocument uses configured default for a document without sessions', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault({ providerId: 'openrouter', modelId: 'openrouter/auto' }) });
    persistedSessions = [];
    const newDoc: DocumentMetadata = { ...DOCUMENT, id: 'doc-fresh-1', fileHash: 'hash-fresh-1' };

    createSession.mockClear();
    const result = await chat.getState().addSelectionContext(
      newDoc,
      { format: 'pdf', startPageIndex: 1, endPageIndex: 1, selectedTextSnippet: 'hello' },
      false
    );

    expect(result).toBe(true);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', modelId: 'openrouter/auto' })
    );
  });

  it('ensureSessionForDocument fails closed when default is unavailable without falling back to ready provider', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault({ providerId: 'claude', modelId: null }) });
    persistedSessions = [];
    const newDoc: DocumentMetadata = { ...DOCUMENT, id: 'doc-fresh-2', fileHash: 'hash-fresh-2' };
    createSession.mockClear();
    const result = await chat.getState().addSelectionContext(
      newDoc,
      { format: 'pdf', startPageIndex: 1, endPageIndex: 1, selectedTextSnippet: 'hello' },
      false
    );

    expect(result).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(chat.getState().error).toMatch(/Claude.*is unavailable/i);
  });

  it('ensureSessionForDocument selects first ready provider when no default is configured', async () => {
    useUiStore.setState({ loadedSettings: settingsWithChatDefault(null) });
    persistedSessions = [];
    const newDoc: DocumentMetadata = { ...DOCUMENT, id: 'doc-fresh-3', fileHash: 'hash-fresh-3' };
    createSession.mockClear();
    const result = await chat.getState().addSelectionContext(
      newDoc,
      { format: 'pdf', startPageIndex: 1, endPageIndex: 1, selectedTextSnippet: 'hello' },
      false
    );

    expect(result).toBe(true);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'fake', modelId: 'fake-grounded' })
    );
  });
});

describe('agent draft profile', () => {
  // Only the id and whether it is installed participate in the decision; the
  // rest of an `AgentProfile` is irrelevant to which one a fresh draft starts on.
  const agent = (id: string, availability: AgentProfile['detection']['availability'] = 'installed'): AgentProfile =>
    ({ id, name: id, detection: { availability } }) as AgentProfile;
  const profiles: readonly AgentProfile[] = [agent('claude-code'), agent('codex')];

  it('starts a new draft on the stored default', () => {
    expect(initialDraftProfileId(profiles, 'codex')).toBe('codex');
  });

  it('falls back to an available profile when the default is not on this machine', () => {
    expect(initialDraftProfileId(profiles, 'not-installed-here')).toBe('claude-code');
  });

  it('has nothing to choose when no profile exists', () => {
    expect(initialDraftProfileId([], 'codex')).toBeNull();
  });

  it('behaves as before when no default was chosen', () => {
    expect(initialDraftProfileId(profiles, null)).toBe('claude-code');
  });

  it('never falls back to an agent that is not installed', () => {
    const absentFirst = [agent('claude-code', 'not-installed'), agent('opencode', 'error'), agent('codex')];
    expect(initialDraftProfileId(absentFirst, null)).toBe('codex');
    expect(initialDraftProfileId(absentFirst, 'gone')).toBe('codex');
  });

  it('starts on no agent rather than an uninstalled one when nothing is installed', () => {
    expect(initialDraftProfileId([agent('claude-code', 'not-installed')], null)).toBeNull();
  });

  it('still honours a stored default the user chose, even if it is not installed now', () => {
    // A real stale choice stays selected so the view can flag it, not swap it.
    expect(initialDraftProfileId([agent('claude-code', 'not-installed'), agent('codex')], 'claude-code')).toBe('claude-code');
  });
});
