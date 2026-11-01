// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { isEffortStale, publishedReasoning, staleEffortMessage } from '../../src/renderer/stores/chat/reasoning';
import type { AIModelInfo, AIProviderStatus, ChatSession, ReasoningEffort } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The renderer's half of per-conversation reasoning effort: a draft choice
 * travels with the exact model into the new conversation, a change writes model
 * and level in one call, and a saved level the model no longer offers is kept,
 * shown and refused rather than swapped.
 */

const testDocument: DocumentMetadata = {
  id: 'doc-effort',
  title: 'Effort',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-effort',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  source: null,
};

function model(id: string, levels?: readonly ReasoningEffort[]): AIModelInfo {
  return {
    id,
    name: id,
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    supportsStreaming: true,
    ...(levels === undefined ? {} : { reasoning: { levels: [...levels] } }),
  };
}

const provider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [model('fake-grounded', ['low', 'high']), model('fake-fast'), model('fake-plain')],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
};

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    documentId: testDocument.id,
    documentHash: testDocument.fileHash,
    title: 'Chat',
    providerId: 'fake',
    modelId: 'fake-grounded',
    reasoningEffort: null,
    messageCount: 0,
    previewText: null,
    isArchived: false,
    compactedThroughOrdinal: null,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

type CreateInput = { documentId: string; providerId: string; modelId?: string | null; reasoningEffort?: ReasoningEffort | null };
type UpdateInput = { sessionId: string; providerId?: string; modelId?: string | null; reasoningEffort?: ReasoningEffort | null };

let chat: ChatStore;
const createSession = vi.fn((input: CreateInput) => Promise.resolve(session({
  id: 'session-new',
  providerId: input.providerId as ChatSession['providerId'],
  modelId: input.modelId ?? null,
  reasoningEffort: input.reasoningEffort ?? null,
})));
const updateSession = vi.fn((input: UpdateInput) => Promise.resolve(session({
  id: input.sessionId,
  modelId: input.modelId ?? null,
  reasoningEffort: input.reasoningEffort ?? null,
})));
const sendMessage = vi.fn(() => Promise.reject(new Error('sendMessage must not be reached')));
const listSessions = vi.fn((): Promise<readonly ChatSession[]> => Promise.resolve([]));

beforeEach(() => {
  chat = createChatStore();
  listSessions.mockResolvedValue([]);
  stubBridge({
    ai: { listProviders: () => Promise.resolve([provider]) },
    chat: {
      listSessions,
      getSession: () => Promise.resolve(null),
      createSession,
      updateSession,
      sendMessage,
      listMessages: () => Promise.resolve([]),
      listContext: () => Promise.resolve([]),
      onStreamEvent: () => () => undefined,
    },
  });
});

afterEach(() => {
  chat.dispose();
  vi.clearAllMocks();
});

describe('draft choice', () => {
  it('creates the conversation with the level chosen alongside its model', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().selectProvider('fake', 'fake-grounded', 'high');
    expect(chat.getState().pendingReasoningEffort).toBe('high');
    await chat.getState().createSession(undefined, undefined);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'fake', modelId: 'fake-grounded', reasoningEffort: 'high' }));
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('never carries a level over to a different model', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().selectProvider('fake', 'fake-grounded', 'high');
    await chat.getState().createSession('fake', 'fake-fast');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'fake-fast', reasoningEffort: null }));
  });

  it('a plain model choice resets the draft level to Default', async () => {
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().selectProvider('fake', 'fake-grounded', 'high');
    await chat.getState().selectModel('fake-plain');
    expect(chat.getState().pendingReasoningEffort).toBeNull();
  });
});

describe('bound conversation', () => {
  it('writes provider, model and level in one update', async () => {
    listSessions.mockResolvedValue([session()]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().selectModel('fake-grounded', 'low');
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', providerId: 'fake', modelId: 'fake-grounded', reasoningEffort: 'low' });
    expect(chat.getState().sessions[0]?.reasoningEffort).toBe('low');
  });

  it('refuses to send on a saved level the model no longer offers, and keeps it', async () => {
    listSessions.mockResolvedValue([session({ reasoningEffort: 'max' })]);
    await chat.getState().initializeDocument(testDocument);
    await chat.getState().sendMessage('Explain');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(chat.getState().error).toBe(staleEffortMessage('max'));
    expect(chat.getState().sessions[0]?.reasoningEffort).toBe('max');
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe('isEffortStale', () => {
  const binding = (modelId: string | null, reasoningEffort: ReasoningEffort | null) => ({ providerId: 'fake' as const, modelId, reasoningEffort });

  it('is false for Default and for an offered level', () => {
    expect(isEffortStale([provider], binding('fake-grounded', null))).toBe(false);
    expect(isEffortStale([provider], binding('fake-grounded', 'high'))).toBe(false);
  });

  it('is true for a level the listed model does not offer, or for a model without levels', () => {
    expect(isEffortStale([provider], binding('fake-grounded', 'max'))).toBe(true);
    expect(isEffortStale([provider], binding('fake-plain', 'low'))).toBe(true);
  });

  it('defers to main for a model this store cannot see', () => {
    expect(publishedReasoning([provider], 'fake', 'vendor/unlisted')).toBeUndefined();
    expect(isEffortStale([provider], binding('vendor/unlisted', 'high'))).toBe(false);
    expect(publishedReasoning([provider], 'fake', 'fake-plain')).toBeNull();
    expect(publishedReasoning([provider], 'fake', null)).toEqual({ levels: ['low', 'high'] });
  });

  it('names the level in the refusal', () => {
    expect(staleEffortMessage('xhigh')).toMatch(/no longer offers the Xhigh reasoning effort/u);
  });
});
