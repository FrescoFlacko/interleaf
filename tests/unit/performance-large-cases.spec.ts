import { afterEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { ChatContextBuilder } from '@main/ai/context-builder';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import type {
  AIModelInfo,
  ChatMessage,
  ChatSession,
} from '@shared/types/ai';
import type { ContextDocument } from '@main/ai/context-repository';

describe('Performance & Scalability Bounded Cases (Phase 11)', () => {
  const activeDatabases: InterleafDatabase[] = [];

  afterEach(() => {
    for (const db of activeDatabases) {
      try {
        db.close();
      } catch {
        // Ignored
      }
    }
    activeDatabases.length = 0;
  });

  it('DocumentRepository efficiently indexes 300+ documents and supports bounded pagination without data loss', () => {
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    activeDatabases.push(db);

    const docRepo = new DocumentRepository(db);

    // Insert 300 documents in an explicit transaction
    db.raw.exec('BEGIN');
    for (let i = 1; i <= 300; i++) {
      const format = i % 4 === 0 ? 'pdf' : i % 4 === 1 ? 'epub' : i % 4 === 2 ? 'mobi' : 'docx';
      docRepo.insert({
        id: `doc-bulk-${String(i)}`,
        title: `Bulk Document ${String(i).padStart(3, '0')}`,
        author: `Author ${String(i % 10)}`,
        format,
        filePath: `/library/doc-${String(i)}.${format}`,
        storageMode: 'managed',
        fileSize: 10_000 + i * 100,
        fileMtimeMs: Date.now() - i * 1000,
        fileHash: `hash-bulk-${String(i)}`,
        pageCount: format === 'pdf' ? 10 : null,
      });
    }
    db.raw.exec('COMMIT');

    // 1. Total document count must be exactly 300
    const all = docRepo.list();
    expect(all.length).toBe(300);

    // 2. Paginated fetching: first 50 items
    const page1 = docRepo.list({ limit: 50, offset: 0 });
    expect(page1.length).toBe(50);

    // 3. Paginated fetching: second 50 items
    const page2 = docRepo.list({ limit: 50, offset: 50 });
    expect(page2.length).toBe(50);

    // 4. No overlap between page 1 and page 2
    const page1Ids = new Set(page1.map((d) => d.id));
    for (const doc of page2) {
      expect(page1Ids.has(doc.id)).toBe(false);
    }

    // 5. Filtered pagination by format
    const epubDocs = docRepo.list({ format: 'epub', limit: 50 });
    expect(epubDocs.length).toBe(50);
    for (const doc of epubDocs) {
      expect(doc.format).toBe('epub');
    }
  });

  it('AnnotationRepository indexes 500+ annotations in an explicit transaction and utilizes SQLite indexes in query plan', () => {
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    activeDatabases.push(db);

    const docRepo = new DocumentRepository(db);
    const annoRepo = new AnnotationRepository(db);

    const targetDocId = 'doc-anno-target';
    const otherDocId = 'doc-anno-other';

    docRepo.insert({
      id: targetDocId,
      title: 'Target Document for Annotations',
      author: 'Author A',
      format: 'pdf',
      filePath: '/tmp/target.pdf',
      storageMode: 'managed',
      fileSize: 100_000,
      fileMtimeMs: Date.now(),
      fileHash: 'hash-target',
      pageCount: 500,
    });

    docRepo.insert({
      id: otherDocId,
      title: 'Isolated Other Document',
      author: 'Author B',
      format: 'pdf',
      filePath: '/tmp/other.pdf',
      storageMode: 'managed',
      fileSize: 50_000,
      fileMtimeMs: Date.now(),
      fileHash: 'hash-other',
      pageCount: 10,
    });

    // Insert 500 annotations in a SINGLE explicit transaction
    db.raw.exec('BEGIN');
    for (let i = 1; i <= 500; i++) {
      if (i % 10 === 0) {
        annoRepo.create({
          documentId: targetDocId,
          type: 'bookmark',
          anchor: {
            format: 'pdf',
            pageIndex: i - 1,
            quote: { exact: '', prefix: '', suffix: '' },
          },
          label: `Bookmark at page ${String(i)}`,
        });
      } else if (i % 2 === 0) {
        annoRepo.create({
          documentId: targetDocId,
          type: 'note',
          anchor: {
            format: 'pdf',
            pageIndex: i - 1,
            quote: {
              exact: `Note quote on page ${String(i)}.`,
              prefix: 'Before ',
              suffix: ' After',
            },
          },
          selectedText: `Note quote on page ${String(i)}.`,
          note: `Detailed analysis for page ${String(i)}.`,
        });
      } else {
        annoRepo.create({
          documentId: targetDocId,
          type: 'highlight',
          color: i % 3 === 0 ? 'green' : 'yellow',
          anchor: {
            format: 'pdf',
            pageIndex: i - 1,
            quote: {
              exact: `Highlight quote on page ${String(i)}.`,
              prefix: 'Before ',
              suffix: ' After',
            },
          },
          selectedText: `Highlight quote on page ${String(i)}.`,
        });
      }
    }
    db.raw.exec('COMMIT');

    // 1. Verify exact count via repository page metadata and capped 100-item page list
    const pageResult = annoRepo.page(targetDocId);
    expect(pageResult.total).toBe(500);
    expect(annoRepo.list(targetDocId, { limit: 100 }).length).toBe(100);
    // 2. Verify page-bounded pagination
    const page1 = annoRepo.list(targetDocId, { limit: 50, offset: 0 });
    expect(page1.length).toBe(50);
    const page2 = annoRepo.list(targetDocId, { limit: 50, offset: 50 });
    expect(page2.length).toBe(50);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);

    // 3. Document isolation: other document has 0 annotations
    const otherAnnos = annoRepo.list(otherDocId);
    expect(otherAnnos.length).toBe(0);

    // 4. Verify SQLite Query Plan uses indexes (never unindexed table scans on large sets)
    const planRows = db.raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM annotations
          WHERE document_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(targetDocId, 50, 0) as { detail: string }[];

    const planText = planRows.map((r) => r.detail).join('\n');
    // Invariant: Query plan must use index covering document_id and created_at
    expect(planText).toMatch(/USING INDEX idx_annotations_/u);
  });

  it('SearchRepository indexes 100+ documents into FTS5 and executes bounded ranked queries', () => {
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    activeDatabases.push(db);

    const docRepo = new DocumentRepository(db);
    const searchRepo = new SearchRepository(db);

    // Index 100 documents with search chunks
    for (let d = 1; d <= 100; d++) {
      const docId = `doc-search-${String(d)}`;
      const docHash = `hash-search-${String(d)}`;

      docRepo.insert({
        id: docId,
        title: `Scalable Systems Volume ${String(d)}`,
        author: 'Systems Group',
        format: 'pdf',
        filePath: `/tmp/doc-${String(d)}.pdf`,
        storageMode: 'managed',
        fileSize: 10_000,
        fileMtimeMs: Date.now(),
        fileHash: docHash,
        pageCount: 10,
      });

      const gen = searchRepo.begin(docId, docHash);
      searchRepo.append(docId, docHash, gen.generationId, [
        {
          ordinal: 0,
          text: `Document ${String(d)} discusses distributed consensus algorithms and raft protocols in chapter 1.`,
          location: { format: 'pdf', pageIndex: 0 },
          heading: 'Distributed Consensus',
          pageLabel: '1',
        },
        {
          ordinal: 1,
          text: `Section 2 of document ${String(d)} explains Byzantine fault tolerance and asynchronous networks.`,
          location: { format: 'pdf', pageIndex: 1 },
          heading: 'Byzantine Fault Tolerance',
          pageLabel: '2',
        },
      ]);
      searchRepo.complete(docId, docHash, gen.generationId);
    }

    // Execute library-wide search
    const results = searchRepo.search(undefined, 'consensus', 20);
    expect(results.length).toBe(20);
    for (const hit of results) {
      expect(hit.excerpt).toContain('consensus');
      expect(hit.documentTitle).toContain('Scalable Systems');
    }

    // Scoped single-document search
    const singleDocHits = searchRepo.search('doc-search-42', 'Byzantine', 10);
    expect(singleDocHits.length).toBe(1);
    expect(singleDocHits[0]?.heading).toBe('Byzantine Fault Tolerance');
  });

  it('ChatContextBuilder strictly bounds 60-message conversation to model context token budget without losing pinned context', () => {
    const mockDoc: ContextDocument = {
      id: 'doc-chat-perf',
      title: 'Long Chat Document',
      format: 'pdf',
      documentHash: 'hash-chat-perf',
      pageCount: 100,
    };

    const mockContextRepo = {
      resolveSelectionChunks: () => ({ chunks: [], boundaryOverIncluded: false }),
      getDocument: () => mockDoc,
      getPublishedStats: () => ({ chunkCount: 50, estimatedTokens: 5_000 }),
      listPublishedChunks: () => [
        {
          id: 'chunk-1',
          ordinal: 0,
          text: 'Core architecture overview and fundamental principles.',
          estimatedTokens: 30,
          location: { format: 'pdf' as const, pageIndex: 0 },
          heading: 'Overview',
          pageLabel: '1',
        },
      ],
      retrieve: () => [
        {
          id: 'chunk-1',
          ordinal: 0,
          text: 'Core architecture overview and fundamental principles.',
          estimatedTokens: 30,
          location: { format: 'pdf' as const, pageIndex: 0 },
          heading: 'Overview',
          pageLabel: '1',
        },
      ],
    };

    const builder = new ChatContextBuilder(mockContextRepo);

    const model: AIModelInfo = {
      id: 'constrained-model',
      name: 'Constrained Model',
      contextWindow: 4_000,
      maxOutputTokens: 1_024,
      supportsStreaming: true,
    };

    const session: ChatSession = {
      id: 'sess-chat-perf',
      documentId: 'doc-chat-perf',
      documentHash: 'hash-chat-perf',
      title: 'Long Conversation',
      providerId: 'fake',
      modelId: 'constrained-model',
      reasoningEffort: null,
      messageCount: 60,
      previewText: null,
      isArchived: false,
      compactedThroughOrdinal: null,
      createdAt: '2026-08-24T00:00:00Z',
      updatedAt: '2026-08-24T00:00:00Z',
    };

    // Generate 60 historical messages (totaling ~15,000 text units)
    const longHistory: ChatMessage[] = [];
    for (let i = 1; i <= 60; i++) {
      longHistory.push({
        id: `msg-${String(i)}`,
        sessionId: 'sess-chat-perf',
        role: i % 2 === 1 ? 'user' : 'assistant',
        ordinal: i - 1,
        content: `Message ${String(i)}: This is a detailed technical query with mathematical derivations and analysis regarding distributed consensus and reader architectures. `.repeat(4),
        citations: [],
        status: 'complete',
        requestId: null,
        tokenCount: 100,
        errorMessage: null,
        createdAt: '2026-08-24T00:00:00Z',
        disclosures: [],
        webSources: [],
      });
    }

    const built = builder.build({
      session,
      model,
      question: 'Summarize the latest decisions made in our discussion.',
      messages: longHistory,
      contextItems: [
        {
          id: 'pinned-item-1',
          sessionId: 'sess-chat-perf',
          kind: 'selection',
          sourceRef: {},
          excerptText: 'CRITICAL INVARIANT: Never exceed model context window.',
          excerptHash: 'hash-pinned',
          documentHash: 'hash-chat-perf',
          location: { format: 'pdf', pageIndex: 0 },
          provenance: { heading: 'Invariant', pageLabel: '1' },
          displayLabel: 'Pinned Key Excerpt',
          pinned: true,
          createdAt: '2026-08-24T00:00:00Z',
        },
      ],
    });

    // 1. History is truncated to fit token budget
    expect(built.history.length).toBeLessThan(longHistory.length);
    expect(built.history.length).toBeGreaterThan(0);

    // 2. The latest message is preserved
    const lastIncludedMessage = built.history[built.history.length - 1];
    expect(lastIncludedMessage?.id).toBe('msg-60');

    // 3. Pinned excerpt is preserved
    expect(built.sources.some((s) => s.excerptText.includes('CRITICAL INVARIANT'))).toBe(true);

    // 4. Total estimated tokens is bounded within model context window
    expect(built.estimatedInputTokens).toBeLessThan(model.contextWindow);
  });
});
