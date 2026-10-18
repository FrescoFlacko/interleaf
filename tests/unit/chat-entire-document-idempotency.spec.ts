import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { AIContextRepository } from '@main/ai/context-repository';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { ChatService } from '@main/ai/chat-service';
import { CHAT_MAX_CONTEXT_ITEMS } from '@shared/constants/ai';
import type { Logger } from '@main/logging/logger';
import type { ChatContextItem, ChatSession } from '@shared/types/ai';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * The whole document may be attached to a session revision at most once, and
 * the rule belongs to the main process: the renderer's already-added state is a
 * mirror of it, not the enforcement point. These cases therefore drive
 * `ChatService.attachContext`, the boundary every renderer request goes
 * through.
 */
describe('whole-document attachment idempotency at the main boundary', () => {
  let db: InterleafDatabase;
  let chatRepo: ChatRepository;
  let chatService: ChatService;
  let session: ChatSession;

  const attachWholeDocument = (pageIndex: number): ChatContextItem =>
    chatService.attachContext({
      sessionId: session.id,
      documentId: session.documentId,
      documentHash: session.documentHash,
      input: { kind: 'entire_document', location: { format: 'pdf', pageIndex } },
    });

  const wholeDocumentRows = (): number => {
    const row = db.raw.prepare(
      "SELECT COUNT(*) AS count FROM chat_context_items WHERE session_id = ? AND kind = 'entire_document'"
    ).get(session.id) as { count: number };
    return row.count;
  };

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-whole',
      title: 'Distributed Systems',
      author: 'Martin',
      format: 'pdf',
      filePath: '/whole.pdf',
      storageMode: 'link',
      fileSize: 1024,
      fileMtimeMs: 1,
      fileHash: 'hash-whole',
      pageCount: 2,
    });
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES
        ('w1', 'doc-whole', 0, 'Replication log and leader consensus mechanism.', 6, '{"format":"pdf","pageIndex":0}', 'Replication', '1'),
        ('w2', 'doc-whole', 1, 'Followers replicate state machine writes.', 5, '{"format":"pdf","pageIndex":1}', 'State Machine', '2')
    `).run();
    db.raw.prepare(`
      INSERT INTO document_index_state (document_id, status, total_chunks, indexed_chunks, document_hash, published_document_hash, published_total_chunks)
      VALUES ('doc-whole', 'ready', 2, 2, 'hash-whole', 'hash-whole', 2)
    `).run();

    chatRepo = new ChatRepository(db);
    chatService = new ChatService({
      resolveOpenRouterModelId: () => Promise.resolve(null),
      chat: chatRepo,
      context: new AIContextRepository(db),
      providers: new AIProviderRegistry(testAIProviderRegistryInput()),
      requireDocumentOpen: () => undefined,
      log: logger,
    });
    // Sessions are created through storage: provider startup is irrelevant to
    // the attachment rule under test.
    session = chatRepo.createSession({
      documentId: 'doc-whole',
      title: 'Whole document notes',
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
  });

  afterEach(() => { db.close(); });

  it('returns the same stored attachment for repeated requests from different reading locations', () => {
    const first = attachWholeDocument(0);
    const second = attachWholeDocument(1);
    const third = attachWholeDocument(0);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(wholeDocumentRows()).toBe(1);
    expect(chatService.listContext(session.id)).toHaveLength(1);
  });

  it('collapses concurrent requests onto one attachment', async () => {
    const results = await Promise.all(
      [0, 1, 0, 1].map((pageIndex) => Promise.resolve().then(() => attachWholeDocument(pageIndex)))
    );

    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(wholeDocumentRows()).toBe(1);
  });

  it('heals a session that already holds duplicate whole-document rows without touching other context', () => {
    const kept = attachWholeDocument(0);
    const unrelated = chatService.attachContext({
      sessionId: session.id,
      documentId: session.documentId,
      documentHash: session.documentHash,
      input: { kind: 'location', location: { format: 'pdf', pageIndex: 1 } },
    });
    // Reproduce the state earlier builds could persist: extra whole-document
    // rows written straight to storage, bypassing the current guard.
    const insert = db.raw.prepare(`
      INSERT INTO chat_context_items (
        id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash,
        document_hash, anchor_json, provenance_json, display_label, pinned, created_at
      ) VALUES (?, ?, 'entire_document', '{}', 'stale duplicate', 'hash-dup', ?, '{"format":"pdf","pageIndex":0}', '{}', 'Entire document', 1, ?)
    `);
    insert.run('dup-1', session.id, session.documentHash, '2099-01-01T00:00:00.000Z');
    insert.run('dup-2', session.id, session.documentHash, '2099-01-02T00:00:00.000Z');
    expect(wholeDocumentRows()).toBe(3);

    const resolved = attachWholeDocument(1);

    expect(resolved.id).toBe(kept.id);
    expect(wholeDocumentRows()).toBe(1);
    const remaining = chatService.listContext(session.id);
    expect(remaining.map((item) => item.id).sort()).toEqual([kept.id, unrelated.id].sort());
  });

  it('converges duplicates a legacy conversation holds when it is merely read again', () => {
    // No attach happens in this case: reopening the conversation is the only
    // action, exactly as it is for a session stored by an earlier build.
    const insert = db.raw.prepare(`
      INSERT INTO chat_context_items (
        id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash,
        document_hash, anchor_json, provenance_json, display_label, pinned, created_at
      ) VALUES (?, ?, ?, '{}', 'legacy row', ?, ?, '{"format":"pdf","pageIndex":0}', '{}', ?, 1, ?)
    `);
    insert.run('legacy-1', session.id, 'entire_document', 'hash-legacy-1', session.documentHash, 'Entire document', '2026-01-01T00:00:00.000Z');
    insert.run('legacy-2', session.id, 'entire_document', 'hash-legacy-2', session.documentHash, 'Entire document', '2026-01-02T00:00:00.000Z');
    insert.run('legacy-3', session.id, 'entire_document', 'hash-legacy-3', session.documentHash, 'Entire document', '2026-01-03T00:00:00.000Z');
    // An older document revision keeps its own single attachment, and other
    // kinds are never in scope.
    insert.run('legacy-old-revision', session.id, 'entire_document', 'hash-legacy-old', 'hash-whole-v0', 'Entire document', '2025-12-01T00:00:00.000Z');
    insert.run('legacy-selection', session.id, 'selection', 'hash-legacy-sel', session.documentHash, 'A quoted passage', '2026-01-01T00:00:00.000Z');

    const hydrated = chatService.listContext(session.id);

    expect(hydrated.map((item) => item.id)).toEqual(['legacy-old-revision', 'legacy-1', 'legacy-selection']);
    expect(wholeDocumentRows()).toBe(2);
    // Reading again is stable, and a later attach still resolves to the kept row.
    expect(chatService.listContext(session.id).map((item) => item.id)).toEqual(hydrated.map((item) => item.id));
    expect(attachWholeDocument(1).id).toBe('legacy-1');
  });

  it('stays idempotent for a session that already holds the maximum number of context items', () => {
    const kept = attachWholeDocument(0);
    const insert = db.raw.prepare(`
      INSERT INTO chat_context_items (
        id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash,
        document_hash, anchor_json, provenance_json, display_label, pinned, created_at
      ) VALUES (?, ?, 'location', '{}', 'filler', 'hash-filler', ?, '{"format":"pdf","pageIndex":0}', '{}', 'Filler', 1, '2026-01-01T00:00:00.000Z')
    `);
    for (let index = 1; index < CHAT_MAX_CONTEXT_ITEMS; index += 1) {
      insert.run(`filler-${String(index)}`, session.id, session.documentHash);
    }
    expect(chatService.listContext(session.id)).toHaveLength(CHAT_MAX_CONTEXT_ITEMS);

    // The repeat resolves to the stored attachment instead of failing the
    // capacity check for an item the session already owns.
    expect(attachWholeDocument(1).id).toBe(kept.id);
    expect(chatService.listContext(session.id)).toHaveLength(CHAT_MAX_CONTEXT_ITEMS);
  });

  it('records how the one stored attachment was made, and upgrades it when the user pins it', () => {
    const attachAutomatically = (): ChatContextItem =>
      chatService.attachContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        input: { kind: 'entire_document', location: { format: 'pdf', pageIndex: 0 }, automatic: true },
      });

    const automatic = attachAutomatically();
    expect(automatic.provenance).toMatchObject({ attachment: 'automatic' });

    // The user then pins the document themselves: same row, but no longer an
    // attachment made on their behalf.
    const promoted = attachWholeDocument(1);
    expect(promoted.id).toBe(automatic.id);
    expect(promoted.provenance).toEqual({});
    expect(chatService.listContext(session.id)[0]?.provenance).toEqual({});
    expect(wholeDocumentRows()).toBe(1);

    // A later automatic attach cannot downgrade what the user pinned.
    expect(attachAutomatically().provenance).toEqual({});
  });

  it('allows re-adding the whole document after it is removed', () => {
    const first = attachWholeDocument(0);
    chatService.removeContext(session.id, first.id);
    expect(wholeDocumentRows()).toBe(0);

    const second = attachWholeDocument(0);
    expect(second.id).not.toBe(first.id);
    expect(wholeDocumentRows()).toBe(1);
  });

  it('keeps other context kinds repeatable and scopes the rule to one session', () => {
    attachWholeDocument(0);
    const range = () =>
      chatService.attachContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        input: { kind: 'range', format: 'pdf', pageStart: 1, pageEnd: 2 },
      });
    const firstRange = range();
    const secondRange = range();
    expect(secondRange.id).not.toBe(firstRange.id);

    const other = chatRepo.createSession({
      documentId: 'doc-whole',
      title: 'Second conversation',
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
    const otherWhole = chatService.attachContext({
      sessionId: other.id,
      documentId: other.documentId,
      documentHash: other.documentHash,
      input: { kind: 'entire_document', location: { format: 'pdf', pageIndex: 0 } },
    });

    expect(chatService.listContext(other.id).map((item) => item.id)).toEqual([otherWhole.id]);
    expect(wholeDocumentRows()).toBe(1);
    expect(chatService.listContext(session.id)).toHaveLength(3);
  });
});
