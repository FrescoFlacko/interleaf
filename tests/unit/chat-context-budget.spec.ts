import { describe, expect, it, vi } from 'vitest';
import {
  PackedRequestBudgets,
  declaredContextWindow,
  packedRequestBudget,
} from '@main/ai/context-budget';
import { ChatContextBuilder, type ChatContextSource } from '@main/ai/context-builder';
import type { ContextChunk, ContextDocument } from '@main/ai/context-repository';
import { chatContextBudgetReplySchema, chatContextBudgetSchema } from '@shared/schemas/ai';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import type { AIModelInfo, ChatContextItem, ChatMessage, ChatSession } from '@shared/types/ai';

const model: AIModelInfo = {
  id: 'test-model',
  name: 'Test Model',
  contextWindow: 10_000,
  maxOutputTokens: 1_000,
  supportsStreaming: true,
};

const session: ChatSession = {
  id: 'session-1',
  documentId: 'doc-1',
  documentHash: 'hash-1',
  title: 'Test Session',
  providerId: 'openrouter',
  modelId: 'test-model',
  reasoningEffort: null,
  messageCount: 0,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const docInfo: ContextDocument = {
  id: 'doc-1',
  title: 'Architecture Guide',
  format: 'pdf',
  documentHash: 'hash-1',
  pageCount: 2,
};

const chunk1: ContextChunk = {
  id: 'c-1',
  ordinal: 0,
  text: 'Chapter 1: Storage engines and logs.',
  estimatedTokens: 8,
  location: { format: 'pdf', pageIndex: 0 },
  heading: 'Storage',
  pageLabel: '1',
};

const chunk2: ContextChunk = {
  id: 'c-2',
  ordinal: 1,
  text: 'Chapter 2: Replication & consensus.',
  estimatedTokens: 8,
  location: { format: 'pdf', pageIndex: 1 },
  heading: 'Replication',
  pageLabel: '2',
};

function createMockContextRepo(overrides: Partial<ChatContextSource> = {}): ChatContextSource {
  return {
    getDocument: vi.fn(() => docInfo),
    getPublishedStats: vi.fn(() => ({ chunkCount: 2, estimatedTokens: 16 })),
    listPublishedChunks: vi.fn(() => [chunk1, chunk2]),
    retrieve: vi.fn(() => [chunk1, chunk2]),
    resolveSelectionChunks: vi.fn(() => ({ chunks: [], boundaryOverIncluded: false })),
    ...overrides,
  };
}

function message(id: string, ordinal: number, content: string): ChatMessage {
  return {
    id,
    sessionId: 'session-1',
    role: ordinal % 2 === 0 ? 'user' : 'assistant',
    ordinal,
    content,
    citations: [],
    status: 'complete',
    requestId: null,
    tokenCount: null,
    errorMessage: null,
    createdAt: `2026-08-24T00:00:${String(ordinal).padStart(2, '0')}.000Z`,
    disclosures: [],
    webSources: [],
  };
}

const pinnedItem: ChatContextItem = {
  id: 'ctx-manual',
  sessionId: 'session-1',
  kind: 'selection',
  sourceRef: {},
  excerptText: 'User highlighted passage on transactions.',
  excerptHash: 'h-1',
  documentHash: 'hash-1',
  location: { format: 'pdf', pageIndex: 5 },
  provenance: { pageLabel: '6', heading: 'Transactions' },
  displayLabel: '“User highlighted passage…”',
  pinned: true,
  createdAt: '2026-08-24T00:00:00.000Z',
};

const entireDocumentItem: ChatContextItem = {
  id: 'ctx-auto-entire',
  sessionId: 'session-1',
  kind: 'entire_document',
  sourceRef: {},
  excerptText: '',
  excerptHash: 'empty',
  documentHash: 'hash-1',
  location: { format: 'pdf', pageIndex: 0 },
  provenance: { attachment: 'automatic' },
  displayLabel: 'Entire document',
  pinned: true,
  createdAt: '2026-08-24T00:00:00.000Z',
};

type PackInput = {
  readonly question: string;
  readonly messages?: readonly ChatMessage[];
  readonly contextItems?: readonly ChatContextItem[];
  readonly repo?: ChatContextSource;
  readonly model?: AIModelInfo;
};

/** Packs a request exactly as the send path does, then publishes that packing. */
function pack(input: PackInput) {
  const usedModel = input.model ?? model;
  const built = new ChatContextBuilder(input.repo ?? createMockContextRepo()).build({
    session,
    model: usedModel,
    question: input.question,
    messages: input.messages ?? [],
    contextItems: input.contextItems ?? [],
  });
  return {
    built,
    budget: packedRequestBudget({
      sessionId: session.id,
      providerId: session.providerId,
      model: usedModel,
      built,
    }),
  };
}

describe('packed-request context budget (main-owned)', () => {
  it('reports a total only when the model declares a usable window', () => {
    expect(declaredContextWindow(model)).toBe(10_000);
    expect(declaredContextWindow({ ...model, contextWindow: 0 })).toBeNull();
    expect(declaredContextWindow({ ...model, contextWindow: -1 })).toBeNull();
    expect(declaredContextWindow({ ...model, contextWindow: 1.5 })).toBeNull();
    expect(declaredContextWindow({ ...model, contextWindow: Number.NaN })).toBeNull();
    expect(declaredContextWindow({ ...model, contextWindow: Number.POSITIVE_INFINITY })).toBeNull();
    expect(declaredContextWindow({ ...model, contextWindow: 1e12 })).toBeNull();
  });

  it('publishes the builder’s own estimate for the request that was packed', () => {
    const { built, budget } = pack({ question: 'How do storage engines work?' });

    expect(budget.usedTokens).toBe(built.estimatedInputTokens);
    expect(budget.sourceCount).toBe(built.sources.length);
    expect(budget.totalTokens).toBe(10_000);
    expect(budget.reservedOutputTokens).toBe(1_000);
    expect(budget.accuracy).toBe('estimated');
    expect(budget.sessionId).toBe('session-1');
    expect(budget.providerId).toBe('openrouter');
    expect(budget.modelId).toBe('test-model');
  });

  it('counts only the history suffix the builder kept, not every stored row', () => {
    const long = Array.from({ length: 40 }, (_, i) => message(`m-${String(i)}`, i, 'x'.repeat(400)));
    const { built, budget } = pack({ question: 'Summarise the thread', messages: long });

    expect(built.history.length).toBeLessThan(long.length);
    expect(budget.usedTokens).toBe(built.estimatedInputTokens);

    // The figure follows the truncated suffix: re-packing only the kept messages
    // reproduces it exactly, while a sum over all stored rows would not.
    const kept = pack({ question: 'Summarise the thread', messages: built.history });
    expect(kept.budget.usedTokens).toBe(budget.usedTokens);

    const everyRowTokens = long.reduce((total, m) => total + Math.ceil(m.content.length / 4), 0);
    expect(budget.usedTokens).toBeLessThan(everyRowTokens);
  });

  it('follows whichever of whole-document or retrieval the builder chose', () => {
    const ingested = pack({
      question: 'What is this document about?',
      contextItems: [entireDocumentItem],
    });
    expect(ingested.built.fullDocIncluded).toBe(true);
    expect(ingested.budget.usedTokens).toBe(ingested.built.estimatedInputTokens);

    // Past the Level-2 threshold the builder retrieves instead of ingesting, and
    // the published figure describes that smaller packing.
    const retrieved = pack({
      question: 'What is this document about?',
      contextItems: [entireDocumentItem],
      repo: createMockContextRepo({
        getPublishedStats: vi.fn(() => ({ chunkCount: 2, estimatedTokens: 7_000 })),
        retrieve: vi.fn(() => [chunk1]),
      }),
    });
    expect(retrieved.built.fullDocIncluded).toBe(false);
    expect(retrieved.budget.usedTokens).toBe(retrieved.built.estimatedInputTokens);
    expect(retrieved.budget.usedTokens).toBeLessThan(ingested.budget.usedTokens);
  });

  it('never infers a total the provider layer did not supply', () => {
    // A window past the reportable ceiling is not a usable denominator.
    const { budget } = pack({ question: 'Anything', model: { ...model, contextWindow: 1e12 } });
    expect(budget.totalTokens).toBeNull();
    expect(budget.usedTokens).toBeGreaterThan(0);
    expect(budget.accuracy).toBe('estimated');
  });

  it('caps an implausible charge so the renderer cannot display a runaway figure', () => {
    const { built } = pack({ question: 'Anything' });
    const budget = packedRequestBudget({
      sessionId: session.id,
      providerId: session.providerId,
      model,
      built: {
        ...built,
        breakdown: { ...built.breakdown, documentContextTokens: 5_000_000_000 },
      },
    });
    // The ceiling still holds for the aggregate, and the itemisation still adds
    // up to it, so a clamped figure cannot be shown alongside an unclamped one.
    expect(budget.usedTokens).toBe(100_000_000);
    expect(budget.breakdown.safetyHeadroomTokens).toBe(0);
    expect(budget.breakdown.reservedResponseTokens).toBe(0);
    expect(budget.reservedOutputTokens).toBe(0);
    expect(chatContextBudgetSchema.safeParse(budget).success).toBe(true);
  });

  it('publishes an itemisation that adds up to the aggregate for every packed request', () => {
    const cases = [
      pack({ question: 'Short?' }),
      pack({ question: 'Longer question about replication.', messages: [message('m-1', 0, 'earlier turn')] }),
      pack({ question: 'Pinned?', contextItems: [pinnedItem] }),
    ];
    for (const { budget, built } of cases) {
      expect(chatContextBudgetSchema.safeParse(budget).success).toBe(true);
      expect(budget.usedTokens).toBe(built.estimatedInputTokens);
      expect(
        budget.breakdown.systemPromptTokens +
          budget.breakdown.userPromptTokens +
          budget.breakdown.historyTokens +
          budget.breakdown.documentContextTokens +
          budget.breakdown.safetyHeadroomTokens +
          budget.breakdown.reservedResponseTokens
      ).toBe(budget.usedTokens);
      // The framing is part of the envelope it frames, never an extra charge.
      expect(budget.breakdown.documentSerializationTokens)
        .toBeLessThanOrEqual(budget.breakdown.documentContextTokens);
      expect(budget.breakdown.documentSerializationTokens).toBeGreaterThan(0);
      expect(budget.breakdown.reservedResponseTokens).toBe(model.maxOutputTokens);
      expect(budget.breakdown.userPromptTokens).toBeGreaterThan(0);
    }
  });

  it('rejects a breakdown that does not add up before it can reach a surface', () => {
    const { budget } = pack({ question: 'Anything' });
    const inflated = {
      ...budget,
      breakdown: { ...budget.breakdown, historyTokens: budget.breakdown.historyTokens + 1 },
    };
    expect(chatContextBudgetSchema.safeParse(inflated).success).toBe(false);
    // And a reserve band that disagrees with the reserved allowance beside it.
    expect(chatContextBudgetSchema.safeParse({ ...budget, reservedOutputTokens: 7 }).success).toBe(false);
  });
});

describe('PackedRequestBudgets', () => {
  const budget = pack({ question: 'How do storage engines work?' }).budget;

  it('returns a record only for the binding it was packed under', () => {
    const budgets = new PackedRequestBudgets();
    budgets.record(budget);

    expect(budgets.forBinding('session-1', 'openrouter', model)).toEqual(budget);
    expect(budgets.forBinding('session-2', 'openrouter', model)).toBeNull();
    // Same model id, different provider: a different binding entirely.
    expect(budgets.forBinding('session-1', 'claude', model)).toBeNull();
    expect(budgets.forBinding('session-1', 'openrouter', { ...model, id: 'other' })).toBeNull();
  });

  it('replaces a session’s record and forgets it on request', () => {
    const budgets = new PackedRequestBudgets();
    budgets.record(budget);
    budgets.record({ ...budget, usedTokens: budget.usedTokens + 100 });
    expect(budgets.forBinding('session-1', 'openrouter', model)?.usedTokens).toBe(budget.usedTokens + 100);

    budgets.forget('session-1');
    expect(budgets.forBinding('session-1', 'openrouter', model)).toBeNull();
  });

  it('bounds how many sessions it tracks, evicting the oldest first', () => {
    const budgets = new PackedRequestBudgets();
    for (let i = 0; i < 70; i += 1) budgets.record({ ...budget, sessionId: `s-${String(i)}` });

    expect(budgets.forBinding('s-0', 'openrouter', model)).toBeNull();
    expect(budgets.forBinding('s-5', 'openrouter', model)).toBeNull();
    expect(budgets.forBinding('s-6', 'openrouter', model)).not.toBeNull();
    expect(budgets.forBinding('s-69', 'openrouter', model)).not.toBeNull();
  });
});

describe('context budget boundary contract', () => {
  it('is validated at the boundary in both directions', () => {
    const requestSchema = ipcRequestSchemas[IPC.chatGetContextBudget];
    expect(requestSchema).toBeDefined();
    expect(requestSchema.safeParse({ sessionId: '' }).success).toBe(false);
    expect(requestSchema.safeParse({ sessionId: 's-1' }).success).toBe(true);

    const valid = pack({ question: 'How do storage engines work?' }).budget;
    expect(chatContextBudgetSchema.safeParse(valid).success).toBe(true);
    expect(chatContextBudgetSchema.safeParse({ ...valid, usedTokens: -1 }).success).toBe(false);
    expect(chatContextBudgetSchema.safeParse({ ...valid, totalTokens: 0 }).success).toBe(false);
    expect(chatContextBudgetSchema.safeParse({ ...valid, accuracy: 'measured' }).success).toBe(false);
    expect(chatContextBudgetSchema.safeParse({ ...valid, providerId: 'nope' }).success).toBe(false);
    expect(chatContextBudgetSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('accepts “no packed request” as a valid reply', () => {
    expect(chatContextBudgetReplySchema.safeParse(null).success).toBe(true);
    expect(chatContextBudgetReplySchema.safeParse(undefined).success).toBe(false);
  });
});
