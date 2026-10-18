import { describe, expect, it, vi } from 'vitest';
import { ChatContextBuilder, type ChatContextSource } from '@main/ai/context-builder';
import { CHAT_EXPLICIT_FULL_DOCUMENT_RATIO, CHAT_MAX_SOURCES_PER_REQUEST } from '@shared/constants/ai';
import type { ContextChunk, ContextDocument } from '@main/ai/context-repository';
import type { AIModelInfo, ChatContextItem, ChatSession } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';

/**
 * An explicitly pinned whole document that cannot fit.
 *
 * Level-1 authority used to mean "whole or nothing": a document larger than the
 * model could hold made the turn fail outright, which is the one outcome a
 * reader cannot act on. It now packs a bounded band of context around where the
 * reader actually is, in document order, and says on the turn that it did.
 */

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
  title: 'Large Document',
  providerId: 'fake',
  modelId: 'test-model',
  reasoningEffort: null,
  messageCount: 0,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

const docInfo: ContextDocument = {
  id: 'doc-1',
  title: 'Architecture Guide',
  format: 'pdf',
  documentHash: 'hash-1',
  pageCount: 20,
};

/** One chunk per page, each large enough that the document cannot fit whole. */
function pdfChunks(pages: number, charsPerChunk: number): readonly ContextChunk[] {
  return Array.from({ length: pages }, (_unused, index) => ({
    id: `c-${String(index)}`,
    ordinal: index,
    text: `Page ${String(index + 1)} body. ${'lorem ipsum '.repeat(Math.ceil(charsPerChunk / 12))}`.slice(
      0,
      charsPerChunk
    ),
    estimatedTokens: Math.ceil(charsPerChunk / 4),
    location: { format: 'pdf' as const, pageIndex: index },
    heading: null,
    pageLabel: `Page ${String(index + 1)}`,
  }));
}

function repoFor(chunks: readonly ContextChunk[]): ChatContextSource {
  const estimatedTokens = chunks.reduce((total, chunk) => total + Math.ceil(chunk.text.length / 4), 0);
  return {
    getDocument: vi.fn(() => docInfo),
    getPublishedStats: vi.fn(() => ({ chunkCount: chunks.length, estimatedTokens })),
    listPublishedChunks: vi.fn(() => chunks),
    retrieve: vi.fn(() => chunks.slice(0, 2)),
    resolveSelectionChunks: vi.fn(() => ({ chunks: [], boundaryOverIncluded: false })),
  };
}

const pinnedWholeDocument: ChatContextItem = {
  id: 'ctx-whole',
  sessionId: session.id,
  documentHash: 'hash-1',
  kind: 'entire_document',
  sourceRef: {},
  excerptText: '',
  excerptHash: 'c'.repeat(64),
  location: { format: 'pdf', pageIndex: 0 },
  provenance: {},
  displayLabel: 'Entire document',
  pinned: true,
  createdAt: '2026-09-12T00:00:00.000Z',
};

function pageIndexesOf(sources: readonly { readonly location: DocumentLocation }[]): number[] {
  return sources.map((source) => (source.location.format === 'pdf' ? source.location.pageIndex : -1));
}

describe('Explicit whole-document context that does not fit', () => {
  it('packs and discloses a bounded band around the current page instead of failing', () => {
    const chunks = pdfChunks(20, 2_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'What does this section argue?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 10 },
    });

    expect(built.fullDocIncluded).toBe(false);
    expect(built.sources.length).toBeGreaterThan(0);
    expect(built.sources.length).toBeLessThan(chunks.length);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(model.contextWindow);

    const pages = pageIndexesOf(built.sources);
    // Document order is preserved in the envelope the model receives.
    expect([...pages].sort((left, right) => left - right)).toEqual(pages);
    // The band is centred on where the reader is, and is contiguous.
    expect(pages).toContain(10);
    expect(pages.at(-1)! - pages[0]!).toBe(pages.length - 1);
    expect(built.sources.map((source) => source.sourceId)).toEqual(
      built.sources.map((_unused, index) => `src-${String(index + 1)}`)
    );

    // The turn discloses that only nearby context was included.
    const disclosure = built.disclosures.find((entry) => entry.contextItemId === pinnedWholeDocument.id);
    expect(disclosure).toBeDefined();
    expect(disclosure).toMatchObject({
      displayLabel: 'Entire document',
      totalChunks: chunks.length,
      includedChunks: built.sources.length,
      omittedChunks: chunks.length - built.sources.length,
      reason: 'nearby_context_only',
    });
  });

  it('counts each included chunk once when a selection overlaps the band', () => {
    const chunks = pdfChunks(20, 2_000);
    // A pinned selection over pages 11 and 12 — chunks the band around page 10
    // packs again. The envelope may carry both statements of them; the
    // disclosure must not claim the document is covered twice over.
    const selected = chunks.slice(10, 12);
    const builder = new ChatContextBuilder({
      ...repoFor(chunks),
      resolveSelectionChunks: vi.fn(() => ({ chunks: selected, boundaryOverIncluded: false })),
    });
    const pinnedSelection: ChatContextItem = {
      ...pinnedWholeDocument,
      id: 'ctx-selection',
      kind: 'selection',
      sourceRef: { descriptor: { kind: 'text', text: 'Page 11 body.' } },
      displayLabel: 'Pages 11–12',
      location: { format: 'pdf', pageIndex: 10 },
    };

    const built = builder.build({
      session,
      model,
      question: 'What does this section argue?',
      messages: [],
      contextItems: [pinnedSelection, pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 10 },
    });

    const disclosure = built.disclosures.find((entry) => entry.reason === 'nearby_context_only');
    expect(disclosure).toBeDefined();
    const uniqueChunkIds = new Set(built.sources.map((source) => source.chunkId));
    expect(uniqueChunkIds.size).toBeLessThan(built.sources.length);
    expect(disclosure).toMatchObject({
      contextItemId: pinnedWholeDocument.id,
      totalChunks: chunks.length,
      includedChunks: uniqueChunkIds.size,
      omittedChunks: chunks.length - uniqueChunkIds.size,
    });
  });

  it('falls back to the attachment location when the send carries none', () => {
    const chunks = pdfChunks(20, 2_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'What does this section argue?',
      messages: [],
      contextItems: [{ ...pinnedWholeDocument, location: { format: 'pdf', pageIndex: 17 } }],
    });

    expect(pageIndexesOf(built.sources)).toContain(17);
  });

  it('uses the same band for a format without pages', () => {
    const markdownDoc: ContextDocument = { ...docInfo, format: 'markdown', pageCount: null };
    const chunks = Array.from({ length: 20 }, (_unused, index) => ({
      id: `m-${String(index)}`,
      ordinal: index,
      text: 'x'.repeat(2_000),
      estimatedTokens: 500,
      location: { format: 'markdown' as const, blockIndex: index },
      heading: null,
      pageLabel: null,
    }));
    const builder = new ChatContextBuilder({
      ...repoFor(chunks),
      getDocument: vi.fn(() => markdownDoc),
    });

    const built = builder.build({
      session,
      model,
      question: 'Summarise the nearby argument.',
      messages: [],
      contextItems: [{
        ...pinnedWholeDocument,
        location: { format: 'markdown', blockIndex: 0 },
      }],
      currentLocation: { format: 'markdown', blockIndex: 12 },
    });

    expect(built.fullDocIncluded).toBe(false);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(model.contextWindow);
    const blocks = built.sources.map((source) =>
      source.location.format === 'markdown' ? source.location.blockIndex : -1
    );
    expect(blocks).toContain(12);
    expect([...blocks].sort((left, right) => left - right)).toEqual(blocks);

    const disclosure = built.disclosures.find((entry) => entry.reason === 'nearby_context_only');
    expect(disclosure).toBeDefined();
    // No member at all, rather than an empty one: Markdown has no pages, and a
    // present-but-blank label would look like an answer to where the band was.
    expect(disclosure).not.toHaveProperty('includedLabel');
  });

  it('uses the band when a document under the threshold still cannot be packed', () => {
    // Under 80% of the window by the indexed estimate, yet the exact packed
    // request — framing, question, reserve and per-source serialization included
    // — does not fit. Many small chunks make the serialization cost the thing
    // that overflows, which the indexed estimate alone does not see.
    const chunks = pdfChunks(200, 160);
    const repo = repoFor(chunks);
    const stats = repo.getPublishedStats('doc-1', 'hash-1');
    expect(stats!.estimatedTokens).toBeLessThanOrEqual(
      Math.floor(model.contextWindow * CHAT_EXPLICIT_FULL_DOCUMENT_RATIO)
    );
    const builder = new ChatContextBuilder(repo);

    const built = builder.build({
      session,
      model,
      question: 'What does this section argue?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 4 },
    });

    expect(built.fullDocIncluded).toBe(false);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(model.contextWindow);
    expect(pageIndexesOf(built.sources)).toContain(4);
  });

  it('sends the whole document when it genuinely fits', () => {
    const chunks = pdfChunks(4, 200);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'Summarise the document.',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 1 },
    });

    expect(built.fullDocIncluded).toBe(true);
    expect(built.sources).toHaveLength(4);
    expect(built.disclosures).toHaveLength(0);
  });

  it('falls back to the band rather than failing on the source-count limit', () => {
    const chunks = Array.from({ length: CHAT_MAX_SOURCES_PER_REQUEST + 1 }, (_unused, index) => ({
      id: `t-${String(index)}`,
      ordinal: index,
      text: 'tiny',
      estimatedTokens: 1,
      location: { format: 'pdf' as const, pageIndex: index },
      heading: null,
      pageLabel: `Page ${String(index + 1)}`,
    }));
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'What is on this page?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 1_500 },
    });

    expect(built.fullDocIncluded).toBe(false);
    expect(built.sources.length).toBeLessThanOrEqual(CHAT_MAX_SOURCES_PER_REQUEST);
    expect(pageIndexesOf(built.sources)).toContain(1_500);
  });
});

/**
 * What the turn tells the reader about the band it sent.
 *
 * "Only context near your current position" is not checkable: a reader cannot
 * hold the answer against the document without knowing which part of it the
 * model saw. For a paginated format the note therefore names the actual pages,
 * read back off the sources the request carries rather than predicted from the
 * anchor, so the disclosure and the envelope cannot disagree.
 */
describe('What the nearby-context disclosure says was sent', () => {
  it('names the surrounding pages a PDF band actually covered', () => {
    const chunks = pdfChunks(20, 2_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'What does this section argue?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 10 },
    });

    const disclosure = built.disclosures.find((entry) => entry.reason === 'nearby_context_only');
    const pages = pageIndexesOf(built.sources).map((index) => index + 1);
    expect(disclosure?.includedLabel).toBe(
      `Pages ${String(pages[0])}–${String(pages.at(-1))}`
    );
    // The named pages are the pages the sources carry, not a wider claim, and
    // they are read from the canonical locations rather than parsed back out of
    // the adapter's display labels.
    expect(built.sources.map((source) => source.pageLabel)).toEqual(
      pages.map((page) => `Page ${String(page)}`)
    );
  });

  it('tells the truth at the first page of the document', () => {
    const chunks = pdfChunks(20, 2_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'How does it open?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 0 },
    });

    const disclosure = built.disclosures.find((entry) => entry.reason === 'nearby_context_only');
    // A band at the edge runs one way only; it must not claim pages before the
    // document starts.
    expect(disclosure?.includedLabel).toMatch(/^Pages 1–/u);
    expect(pageIndexesOf(built.sources)[0]).toBe(0);
  });

  it('tells the truth at the last page of the document', () => {
    const chunks = pdfChunks(20, 2_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const built = builder.build({
      session,
      model,
      question: 'How does it end?',
      messages: [],
      contextItems: [pinnedWholeDocument],
      currentLocation: { format: 'pdf', pageIndex: 19 },
    });

    const disclosure = built.disclosures.find((entry) => entry.reason === 'nearby_context_only');
    expect(disclosure?.includedLabel).toMatch(/–20$/u);
    expect(pageIndexesOf(built.sources).at(-1)).toBe(19);
  });

  it('never refuses the turn over the pinned document not fitting', () => {
    // The former behaviour raised a validation error telling the reader to
    // remove context or pick another model. Nothing on this path may throw it.
    const chunks = pdfChunks(400, 4_000);
    const builder = new ChatContextBuilder(repoFor(chunks));

    const build = () =>
      builder.build({
        session,
        model,
        question: 'What does this section argue?',
        messages: [],
        contextItems: [pinnedWholeDocument],
        currentLocation: { format: 'pdf', pageIndex: 200 },
      });

    expect(build).not.toThrow();
    const built = build();
    expect(built.sources.length).toBeGreaterThan(0);
    expect(built.sources.length).toBeLessThanOrEqual(CHAT_MAX_SOURCES_PER_REQUEST);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(model.contextWindow);
    expect(built.disclosures.some((entry) => entry.reason === 'nearby_context_only')).toBe(true);
  });
});
