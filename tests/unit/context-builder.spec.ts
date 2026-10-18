import { describe, expect, it, vi } from 'vitest';
import {
  ChatContextBuilder,
  estimateChatTokens,
  formatSourceLabel,
  type ChatContextSource,
  type ReplayedChatSource,
} from '@main/ai/context-builder';
import { CHAT_REPLAY_MAX_SOURCES } from '@shared/constants/ai';
import type { ContextChunk, ContextDocument } from '@main/ai/context-repository';
import type { DocumentAnchor } from '@shared/types/annotation';
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
  providerId: 'fake',
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

describe('ChatContextBuilder', () => {
  it('estimates chat tokens deterministically using char-based heuristic', () => {
    expect(estimateChatTokens('')).toBe(1);
    expect(estimateChatTokens('a')).toBe(1);
    expect(estimateChatTokens('abcd')).toBe(1);
    expect(estimateChatTokens('abcde')).toBe(2);
    expect(estimateChatTokens('x'.repeat(400))).toBe(100);
  });

  it('formats source labels cleanly for various document formats', () => {
    expect(formatSourceLabel('42', 'Replication', { format: 'pdf', pageIndex: 41 })).toBe(
      'Page 42 · Replication'
    );
    expect(formatSourceLabel(null, 'Intro', { format: 'pdf', pageIndex: 0 })).toBe('Intro');
    expect(formatSourceLabel(null, null, { format: 'docx', paragraphIndex: 3 })).toBe(
      'Paragraph 4'
    );
    expect(formatSourceLabel(null, null, { format: 'epub', cfi: 'epubcfi(/6/2)' })).toBe(
      'Document passage'
    );
  });

  it('builds full document context when chunks fit safely within budget', () => {
    const repo = createMockContextRepo();
    const builder = new ChatContextBuilder(repo);

    const built = builder.build({
      session,
      model,
      question: 'How do storage engines work?',
      messages: [],
      contextItems: [],
    });

    expect(built.systemPrompt).toContain('Interleaf Reader AI');
    expect(built.sources).toHaveLength(2);
    expect(built.sources[0]?.sourceId).toBe('src-1');
    expect(built.sources[1]?.sourceId).toBe('src-2');
    expect(built.contextXml).toContain('title="Architecture Guide"');
    expect(built.contextXml).toContain('format="pdf"');
    expect(built.contextXml).toContain('revision="hash-1"');
    expect(built.contextXml).toContain('id="src-1"');
    expect(built.contextXml).toContain('id="src-2"');
  });

  describe('replaying what earlier turns sent', () => {
    /** A stored snapshot, deliberately absent from the indexed chunks. */
    function priorSource(index: number, text: string, chunkId: string | null = null): ReplayedChatSource {
      return {
        documentId: 'doc-1',
        documentHash: 'hash-1',
        chunkId,
        contextItemId: `ctx-consumed-${String(index)}`,
        location: { format: 'pdf', pageIndex: index },
        excerptText: text,
        excerptHash: `replay-hash-${String(index)}`,
        heading: 'Earlier turn',
        pageLabel: String(index + 1),
        label: `Page ${String(index + 1)} · Earlier turn`,
      };
    }

    /** Retrieval-only repo: the whole document is too large to attach. */
    function retrievalRepo(): ChatContextSource {
      return createMockContextRepo({
        getPublishedStats: vi.fn(() => ({ chunkCount: 2, estimatedTokens: 7_000 })),
        retrieve: vi.fn(() => [chunk1]),
      });
    }

    it('resends prior sources as document context with request-local ids and no draft identity', () => {
      const built = new ChatContextBuilder(retrievalRepo()).build({
        session,
        model,
        question: 'Why does that matter?',
        messages: [],
        contextItems: [],
        priorSources: [priorSource(0, 'Quorum leases were explained earlier.')],
      });

      const replayed = built.sources.find((source) =>
        source.excerptText.includes('Quorum leases were explained earlier.')
      );
      expect(replayed).toBeDefined();
      // The draft it came from is gone; the snapshot is not this turn's chip.
      expect(replayed?.contextItemId).toBeNull();
      expect(replayed?.documentTitle).toBe('Architecture Guide');
      // Ids are numbered for this request only, contiguously and from one.
      expect(built.sources.map((source) => source.sourceId)).toEqual(
        built.sources.map((_, index) => `src-${String(index + 1)}`)
      );
      expect(built.contextXml).toContain('Quorum leases were explained earlier.');
    });

    it('never resends a passage this turn already carries', () => {
      const pinned: ChatContextItem = {
        id: 'ctx-current',
        sessionId: 'session-1',
        kind: 'selection',
        sourceRef: {},
        excerptText: 'Repeated passage about consensus.',
        excerptHash: 'shared-hash',
        documentHash: 'hash-1',
        location: { format: 'pdf', pageIndex: 3 },
        provenance: { pageLabel: '4' },
        displayLabel: 'Repeated passage',
        pinned: true,
        createdAt: '2026-08-24T00:00:00.000Z',
      };

      const built = new ChatContextBuilder(retrievalRepo()).build({
        session,
        model,
        question: 'Say more',
        messages: [],
        contextItems: [pinned],
        priorSources: [
          { ...priorSource(0, 'Repeated passage about consensus.'), excerptHash: 'shared-hash' },
          { ...priorSource(1, 'Chapter 1: Storage engines and logs.', 'c-1') },
          priorSource(2, 'A passage only the earlier turn had.'),
        ],
      });

      const occurrences = (needle: string): number =>
        built.sources.filter((source) => source.excerptText === needle).length;
      expect(occurrences('Repeated passage about consensus.')).toBe(1);
      // Deduplicated by chunk identity as well as by excerpt hash.
      expect(occurrences('Chapter 1: Storage engines and logs.')).toBe(1);
      expect(occurrences('A passage only the earlier turn had.')).toBe(1);
    });

    it('bounds replay by count and by its share of the window', () => {
      const many = Array.from({ length: 12 }, (_, index) =>
        priorSource(index, `Earlier passage number ${String(index)}.`)
      );
      const counted = new ChatContextBuilder(retrievalRepo()).build({
        session,
        model,
        question: 'Continue',
        messages: [],
        contextItems: [],
        priorSources: many,
      });
      expect(
        counted.sources.filter((source) => source.excerptText.startsWith('Earlier passage number')).length
      ).toBe(CHAT_REPLAY_MAX_SOURCES);

      // A single oversized snapshot exceeds the replay share (15% of 10,000
      // tokens) on its own and is left out rather than crowding the request.
      const oversized = new ChatContextBuilder(retrievalRepo()).build({
        session,
        model,
        question: 'Continue',
        messages: [],
        contextItems: [],
        priorSources: [priorSource(0, 'x'.repeat(20_000))],
      });
      expect(oversized.sources.some((source) => source.excerptText.startsWith('xxxx'))).toBe(false);
    });

    it('drops replay when the whole document is included instead', () => {
      const built = new ChatContextBuilder(createMockContextRepo()).build({
        session,
        model,
        question: 'What is this document about?',
        messages: [],
        contextItems: [],
        priorSources: [priorSource(0, 'Quorum leases were explained earlier.')],
      });

      expect(built.fullDocIncluded).toBe(true);
      expect(built.contextXml).not.toContain('Quorum leases were explained earlier.');
      expect(built.sources.map((source) => source.sourceId)).toEqual(['src-1', 'src-2']);
    });
  });

  it('prioritizes explicit pinned context items before retrieval', () => {
    const repo = createMockContextRepo();
    const builder = new ChatContextBuilder(repo);

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

    const built = builder.build({
      session,
      model,
      question: 'Explain this highlight',
      messages: [],
      contextItems: [pinnedItem],
    });

    expect(built.sources[0]?.label).toBe('“User highlighted passage…”');
    expect(built.sources[0]?.excerptText).toBe('User highlighted passage on transactions.');
  });

  it('blocks sending and explains when explicit pinned context exceeds budget', () => {
    const repo = createMockContextRepo();
    const builder = new ChatContextBuilder(repo);

    const hugeItem: ChatContextItem = {
      id: 'ctx-huge',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: {},
      excerptText: 'x'.repeat(40_000), // ~10,000 tokens exceeds remaining
      excerptHash: 'h-huge',
      documentHash: 'hash-1',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: {},
      displayLabel: 'Huge selection',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    expect(() =>
      builder.build({
        session,
        model,
        question: 'Explain this',
        messages: [],
        contextItems: [hugeItem],
      })
    ).toThrow(/Explicit context “Huge selection” does not fit this model/i);
  });

  it('handles XML escaping expansion accurately in token envelope budgeting', () => {
    const safeModel: AIModelInfo = {
      id: 'safe-model',
      name: 'Safe Model',
      contextWindow: 2_000,
      maxOutputTokens: 200,
      supportsStreaming: true,
    };
    const tightModel: AIModelInfo = {
      id: 'tight-model',
      name: 'Tight Model',
      contextWindow: 1_100, // Fixed tokens (~950) + escaped XML (~300) = 1,250 > 1,100
      maxOutputTokens: 200,
      supportsStreaming: true,
    };
    const repo = createMockContextRepo();
    const builder = new ChatContextBuilder(repo);

    // Text containing characters that expand heavily under XML escaping: & -> &amp; (5x expansion)
    const expandingExcerpt = '&'.repeat(200); // 200 raw chars -> 1000 XML chars = 250 tokens
    const expandingItem: ChatContextItem = {
      id: 'ctx-expand',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: {},
      excerptText: expandingExcerpt,
      excerptHash: 'h-exp',
      documentHash: 'hash-1',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: {},
      displayLabel: 'Ampersand text',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    // 1. Fits when model window is sufficient
    const built = builder.build({
      session,
      model: safeModel,
      question: 'Short question',
      messages: [],
      contextItems: [expandingItem],
    });
    expect(built.contextXml).toContain('&amp;&amp;');
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(safeModel.contextWindow);

    // 2. Throws when XML escaping expansion causes the serialized envelope to overflow
    expect(() =>
      builder.build({
        session,
        model: tightModel,
        question: 'Short question',
        messages: [],
        contextItems: [expandingItem],
      })
    ).toThrow(/does not fit this model/i);
  });

  it('selects recent history within budget while skipping streaming/failed messages', () => {
    const repo = createMockContextRepo();
    const builder = new ChatContextBuilder(repo);

    const messages: ChatMessage[] = [
      {
        id: 'm-1',
        sessionId: 'session-1',
        role: 'user',
        ordinal: 0,
        content: 'Turn 1 user',
        citations: [],
        status: 'complete',
        requestId: null,
        tokenCount: 4,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:00.000Z',
        disclosures: [],
        webSources: [],
      },
      {
        id: 'm-2',
        sessionId: 'session-1',
        role: 'assistant',
        ordinal: 1,
        content: 'Turn 1 assistant',
        citations: [],
        status: 'complete',
        requestId: null,
        tokenCount: 4,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:01.000Z',
        disclosures: [],
        webSources: [],
      },
      {
        id: 'm-3',
        sessionId: 'session-1',
        role: 'assistant',
        ordinal: 2,
        content: 'Failed attempt',
        citations: [],
        status: 'failed',
        requestId: null,
        tokenCount: null,
        errorMessage: 'err',
        createdAt: '2026-08-24T00:00:02.000Z',
        disclosures: [],
        webSources: [],
      },
      {
        id: 'm-4',
        sessionId: 'session-1',
        role: 'assistant',
        ordinal: 3,
        content: 'Streaming message',
        citations: [],
        status: 'streaming',
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        tokenCount: null,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:03.000Z',
        disclosures: [],
        webSources: [],
      },
      {
        id: 'm-5',
        sessionId: 'session-1',
        role: 'user',
        ordinal: 4,
        content: 'Turn 2 user',
        citations: [],
        status: 'complete',
        requestId: null,
        tokenCount: 4,
        createdAt: '2026-08-24T00:00:04.000Z',
        errorMessage: null,
        disclosures: [],
        webSources: [],
      },
    ];

    const built = builder.build({
      session,
      model,
      question: 'Turn 3 question',
      messages,
      contextItems: [],
    });

    expect(built.history.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-5']);
  });

  it('throws validation error if document has 0 chunks and no explicit context', () => {
    const repo = createMockContextRepo({
      getPublishedStats: vi.fn(() => ({ chunkCount: 0, estimatedTokens: 0 })),
      listPublishedChunks: vi.fn(() => []),
    });
    const builder = new ChatContextBuilder(repo);

    expect(() =>
      builder.build({
        session,
        model,
        question: 'Question on unindexed document',
        messages: [],
        contextItems: [],
      })
    ).toThrow(/No indexed or explicitly selected document context is available/i);
  });

  it('resolves multi-chunk selection into individual cited sources with exact locations', () => {
    const pdfAnchor: DocumentAnchor = {
      format: 'pdf',
      pageIndex: 0,
      quote: { exact: 'Multi-page passage text', prefix: '', suffix: '' },
      segments: [
        { pageIndex: 0, quote: { exact: 'Page one text', prefix: '', suffix: '' } },
        { pageIndex: 1, quote: { exact: 'Page two text', prefix: '', suffix: '' } },
      ],
    };
    const repo = createMockContextRepo({
      resolveSelectionChunks: vi.fn(() => ({ chunks: [chunk1, chunk2], boundaryOverIncluded: false })),
    });
    const builder = new ChatContextBuilder(repo);

    const selectionItem: ChatContextItem = {
      id: 'ctx-selection-multi',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: { anchor: pdfAnchor },
      excerptText: 'Multi-page passage text',
      excerptHash: 'h-multi',
      documentHash: 'hash-1',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: {},
      displayLabel: '“Multi-page passage…”',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    const built = builder.build({
      session,
      model,
      question: 'Summarize the selection',
      messages: [],
      contextItems: [selectionItem],
    });

    expect(repo.resolveSelectionChunks).toHaveBeenCalledWith('doc-1', 'hash-1', pdfAnchor);
    expect(built.sources).toHaveLength(2);
    expect(built.sources[0]?.contextItemId).toBe('ctx-selection-multi');
    expect(built.sources[0]?.chunkId).toBe('c-1');
    expect(built.sources[0]?.label).toBe('Page 1 · Storage');
    expect(built.sources[1]?.contextItemId).toBe('ctx-selection-multi');
    expect(built.sources[1]?.chunkId).toBe('c-2');
    expect(built.sources[1]?.label).toBe('Page 2 · Replication');
  });

  it('packs as many selected chunks as fit within a constrained model budget', () => {
    const manyChunks: ContextChunk[] = Array.from({ length: 20 }, (_, i) => ({
      id: `chunk-${String(i)}`,
      ordinal: i,
      text: `Paragraph ${String(i)} with detailed content: ${'x'.repeat(400)}`,
      estimatedTokens: 100,
      location: { format: 'markdown', blockIndex: i },
      heading: `Section ${String(i)}`,
      pageLabel: null,
    }));

    const mdAnchor: DocumentAnchor = {
      format: 'markdown',
      blockIndex: 0,
      quote: { exact: 'Large markdown selection', prefix: '', suffix: '' },
    };

    const smallModel: AIModelInfo = {
      id: 'small-model',
      name: 'Small Model',
      contextWindow: 2_000,
      maxOutputTokens: 200,
      supportsStreaming: true,
    };

    const repo = createMockContextRepo({
      getDocument: vi.fn(() => ({ ...docInfo, format: 'markdown' as const })),
      resolveSelectionChunks: vi.fn(() => ({ chunks: manyChunks, boundaryOverIncluded: false })),
    });
    const builder = new ChatContextBuilder(repo);

    const selectionItem: ChatContextItem = {
      id: 'ctx-large-md',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: { anchor: mdAnchor },
      excerptText: 'Large markdown selection',
      excerptHash: 'h-lg',
      documentHash: 'hash-1',
      location: { format: 'markdown', blockIndex: 0 },
      provenance: {},
      displayLabel: 'Large markdown selection',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    const built = builder.build({
      session,
      model: smallModel,
      question: 'Question on large selection',
      messages: [],
      contextItems: [selectionItem],
    });

    expect(built.sources.length).toBeGreaterThan(0);
    expect(built.sources.length).toBeLessThan(20);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(smallModel.contextWindow);
    expect(built.disclosures).toHaveLength(1);
    expect(built.disclosures[0]).toEqual({
      contextItemId: 'ctx-large-md',
      displayLabel: 'Large markdown selection',
      totalChunks: 20,
      includedChunks: 7,
      omittedChunks: 13,
      reason: 'model_context_window',
    });
  });

  it('records truthful disclosure when max sources limit is reached', () => {
    const manyChunks: ContextChunk[] = Array.from({ length: 2_050 }, (_, i) => ({
      id: `chunk-${String(i)}`,
      ordinal: i,
      text: `Brief paragraph ${String(i)}`,
      estimatedTokens: 1,
      location: { format: 'markdown', blockIndex: i },
      heading: `Section ${String(i)}`,
      pageLabel: null,
    }));

    const mdAnchor: DocumentAnchor = {
      format: 'markdown',
      blockIndex: 0,
      quote: { exact: 'Wide selection', prefix: '', suffix: '' },
    };

    const bigModel: AIModelInfo = {
      id: 'big-model',
      name: 'Big Model',
      contextWindow: 10_000_000,
      maxOutputTokens: 200,
      supportsStreaming: true,
    };

    const repo = createMockContextRepo({
      getDocument: vi.fn(() => ({ ...docInfo, format: 'markdown' as const })),
      resolveSelectionChunks: vi.fn(() => ({ chunks: manyChunks, boundaryOverIncluded: false })),
    });
    const builder = new ChatContextBuilder(repo);

    const selectionItem: ChatContextItem = {
      id: 'ctx-sources-limit',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: { anchor: mdAnchor },
      excerptText: 'Wide selection',
      excerptHash: 'h-wide',
      documentHash: 'hash-1',
      location: { format: 'markdown', blockIndex: 0 },
      provenance: {},
      displayLabel: 'Wide selection',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    const built = builder.build({
      session,
      model: bigModel,
      question: 'Question on wide selection',
      messages: [],
      contextItems: [selectionItem],
    });

    expect(built.sources).toHaveLength(2_000); // CHAT_MAX_SOURCES_PER_REQUEST
    expect(built.disclosures).toHaveLength(1);
    expect(built.disclosures[0]).toEqual({
      contextItemId: 'ctx-sources-limit',
      displayLabel: 'Wide selection',
      totalChunks: 2_050,
      includedChunks: 2_000,
      omittedChunks: 50,
      reason: 'max_sources_per_request',
    });
  });

  it('retains both boundary and model clipping disclosures for one selection', () => {
    const manyChunks: ContextChunk[] = Array.from({ length: 20 }, (_, i) => ({
      id: `boundary-chunk-${String(i)}`,
      ordinal: i,
      text: `Boundary paragraph ${String(i)} ${'x'.repeat(400)}`,
      estimatedTokens: 100,
      location: { format: 'markdown', blockIndex: i },
      heading: null,
      pageLabel: null,
    }));
    const repo = createMockContextRepo({
      getDocument: vi.fn(() => ({ ...docInfo, format: 'markdown' as const })),
      resolveSelectionChunks: vi.fn(() => ({ chunks: manyChunks, boundaryOverIncluded: true })),
    });
    const builder = new ChatContextBuilder(repo);
    const item: ChatContextItem = {
      id: 'ctx-boundary-and-budget',
      sessionId: 'session-1',
      kind: 'selection',
      sourceRef: { descriptor: { format: 'markdown', startBlockIndex: 0, endBlockIndex: 19 } },
      excerptText: 'Boundary selection',
      excerptHash: 'h-boundary',
      documentHash: 'hash-1',
      location: { format: 'markdown', blockIndex: 0 },
      provenance: {},
      displayLabel: 'Boundary selection',
      pinned: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };

    const built = builder.build({
      session: { ...session, documentHash: 'hash-1' },
      model: {
        ...model,
        contextWindow: 2_000,
        maxOutputTokens: 200,
      },
      question: 'Explain the boundary selection',
      messages: [],
      contextItems: [item],
    });

    expect(built.sources.length).toBeGreaterThan(0);
    expect(built.sources.length).toBeLessThan(manyChunks.length);
    expect(built.disclosures).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'model_context_window' }),
      expect.objectContaining({ reason: 'boundary_over_inclusion' }),
    ]));
  });

  describe('ADR-0006 Level 2 ratio for automatically attached whole documents', () => {
    /** Reader Chat attached this on the user's behalf; it is not an override. */
    const automaticItem: ChatContextItem = {
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
    /** The same attachment as the user's explicit `+ Entire document`. */
    const explicitItem: ChatContextItem = { ...automaticItem, id: 'ctx-manual-entire', provenance: {} };

    // 7,000 document tokens against a 10,000-token window: over the 60% (6,000)
    // Level-2 threshold, but still small enough for the hard window check that
    // an explicit override applies.
    function oversizedRepo(): ChatContextSource {
      return createMockContextRepo({
        getPublishedStats: vi.fn(() => ({ chunkCount: 2, estimatedTokens: 7_000 })),
      });
    }

    it('does not ingest the whole document past the 60% threshold', () => {
      const repo = oversizedRepo();
      const built = new ChatContextBuilder(repo).build({
        session,
        model,
        question: 'What is this document about?',
        messages: [],
        contextItems: [automaticItem],
      });

      expect(built.fullDocIncluded).toBe(false);
      expect(repo.retrieve).toHaveBeenCalled();
      // The turn discloses that retrieval answered instead of the whole document.
      expect(built.disclosures).toEqual([
        expect.objectContaining({
          contextItemId: 'ctx-auto-entire',
          displayLabel: 'Entire document',
          totalChunks: 2,
          reason: 'model_context_window',
        }),
      ]);
    });

    it('keeps explicit pinned authority for the manual entire-document action', () => {
      const repo = oversizedRepo();
      const built = new ChatContextBuilder(repo).build({
        session,
        model,
        question: 'What is this document about?',
        messages: [],
        contextItems: [explicitItem],
      });

      expect(built.fullDocIncluded).toBe(true);
      expect(repo.retrieve).not.toHaveBeenCalled();
      expect(built.disclosures).toEqual([]);
    });

    it('still ingests an automatically attached document that fits the threshold', () => {
      const repo = createMockContextRepo({
        getPublishedStats: vi.fn(() => ({ chunkCount: 2, estimatedTokens: 5_000 })),
      });
      const built = new ChatContextBuilder(repo).build({
        session,
        model,
        question: 'What is this document about?',
        messages: [],
        contextItems: [automaticItem],
      });

      expect(built.fullDocIncluded).toBe(true);
      expect(built.disclosures).toEqual([]);
    });
  });
});
