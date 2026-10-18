import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { MIGRATIONS, applyMigrations, runMigrations } from '@main/db/migrations';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS } from '@shared/constants/ai';

/**
 * Migration 23 — conversation compaction state.
 *
 * The columns are additive and nullable, so a library that has never been
 * compacted upgrades to "never compacted" without rewriting a row. Every earlier
 * migration is checksum-protected, so this one has to be the forward-only step
 * after v22 rather than an edit to anything before it.
 */

const COMPACTION_VERSION = 23;

function columnsOf(db: InterleafDatabase, table: string): readonly string[] {
  return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[]).map(
    (row) => row.name
  );
}

function seedDocument(db: InterleafDatabase, id: string, hash: string): void {
  new DocumentRepository(db).insert({
    id,
    title: `Document ${id}`,
    author: null,
    format: 'pdf',
    filePath: `/tmp/${id}.pdf`,
    storageMode: 'managed',
    fileSize: 1024,
    fileMtimeMs: 1_000,
    fileHash: hash,
    pageCount: 4,
  });
}

describe('chat context compaction migration', () => {
  let db: InterleafDatabase;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
  });

  afterEach(() => { db.close(); });

  it('keeps its checksum-protected position as later migrations are appended', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    // The step itself never moves; only strictly later versions may be added.
    expect(MIGRATIONS[COMPACTION_VERSION - 1]?.version).toBe(COMPACTION_VERSION);
    expect(MIGRATIONS[COMPACTION_VERSION - 1]?.name).toBe('chat_context_compaction');
    expect(versions.slice(0, COMPACTION_VERSION)).toEqual(
      Array.from({ length: COMPACTION_VERSION }, (_unused, index) => index + 1)
    );
    // Strictly increasing, so no earlier applied checksum can shift.
    expect(versions).toEqual([...versions].toSorted((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('upgrades an existing library without rewriting its conversations', () => {
    applyMigrations(db, MIGRATIONS.slice(0, COMPACTION_VERSION - 1));
    expect(columnsOf(db, 'chat_sessions')).not.toContain('context_summary');

    seedDocument(db, 'doc-old', 'hash-old');
    db.raw.prepare(`
      INSERT INTO chat_sessions (id, document_id, title, provider_id, model_id, document_hash)
      VALUES ('session-old', 'doc-old', 'Existing chat', 'openrouter', 'model-x', 'hash-old')
    `).run();
    db.raw.prepare(`
      INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
      VALUES ('msg-user', 'session-old', 'user', 0, 'Old question', 'complete'),
             ('msg-answer', 'session-old', 'assistant', 1, 'Old answer', 'complete')
    `).run();
    db.raw.prepare(`
      INSERT INTO chat_context_items (
        id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash, document_hash,
        anchor_json, provenance_json, display_label
      ) VALUES ('ctx-old', 'session-old', 'location', '{}', 'text', 'x', 'hash-old',
                '{"format":"pdf","pageIndex":0}', '{}', 'Page 1')
    `).run();
    db.raw.prepare(`
      INSERT INTO chat_message_sources (
        message_id, source_id, ordinal, document_id, document_hash, chunk_id, context_item_id,
        location_json, excerpt_text, excerpt_hash, display_label
      ) VALUES
        ('msg-answer', 'src-1', 0, 'doc-old', 'hash-old', NULL, 'ctx-old',
         '{"format":"pdf","pageIndex":0}', 'attached passage', 'a', 'Page 1'),
        ('msg-answer', 'src-2', 1, 'doc-old', 'hash-old', 'chunk-1', NULL,
         '{"format":"pdf","pageIndex":1}', 'retrieved passage', 'b', 'Page 2')
    `).run();

    expect(runMigrations(db)).toBe(MIGRATIONS.length - (COMPACTION_VERSION - 1));

    const session = db.raw.prepare(`
      SELECT context_summary, context_summary_updated_at, compacted_through_ordinal, title
        FROM chat_sessions WHERE id = 'session-old'
    `).get() as {
      readonly context_summary: string | null;
      readonly context_summary_updated_at: string | null;
      readonly compacted_through_ordinal: number | null;
      readonly title: string;
    };
    expect(session).toEqual({
      context_summary: null,
      context_summary_updated_at: null,
      compacted_through_ordinal: null,
      title: 'Existing chat',
    });
    // Nothing is compacted away, so every stored message still replays.
    expect(new ChatRepository(db).listReplayableMessages('session-old')).toHaveLength(2);

    // A source stored against a surviving context item was an attached one; a
    // retrieved source was not, and keeps replaying as it does today.
    const origins = db.raw.prepare(`
      SELECT source_id, attached_origin FROM chat_message_sources
       WHERE message_id = 'msg-answer' ORDER BY ordinal ASC
    `).all();
    expect(origins).toEqual([
      { source_id: 'src-1', attached_origin: 1 },
      { source_id: 'src-2', attached_origin: 0 },
    ]);
  });

  describe('stored compaction state', () => {
    let chat: ChatRepository;

    beforeEach(() => {
      runMigrations(db);
      seedDocument(db, 'doc-a', 'hash-a');
      seedDocument(db, 'doc-b', 'hash-b');
      chat = new ChatRepository(db);
    });

    /** A session with `count` complete turns and one attached context item. */
    function seedSession(documentId: string, hash: string, title: string, turns = 2): string {
      const session = chat.createSession({ documentId, title, providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' });
      for (let ordinal = 0; ordinal < turns; ordinal += 1) {
        db.raw.prepare(`
          INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
          VALUES (?, ?, ?, ?, ?, 'complete')
        `).run(
          `${session.id}-m${String(ordinal)}`,
          session.id,
          ordinal % 2 === 0 ? 'user' : 'assistant',
          ordinal,
          `Turn ${String(ordinal)} of ${title}`
        );
      }
      db.raw.prepare(`
        INSERT INTO chat_context_items (
          id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash, document_hash,
          anchor_json, provenance_json, display_label
        ) VALUES (?, ?, 'location', '{}', 'text', 'x', ?, '{"format":"pdf","pageIndex":0}', '{}', 'Page 1')
      `).run(`${session.id}-ctx`, session.id, hash);
      return session.id;
    }

    /**
     * Compaction commits against the revision it summarised, so these storage
     * tests capture the current revision the way the service does before its call.
     */
    function compact(input: {
      readonly sessionId: string;
      readonly summary: string;
      readonly compactedThroughOrdinal: number;
    }): { readonly clearedContextItemIds: readonly string[] } {
      return chat.applyContextCompaction({
        ...input,
        expectedRevision: chat.compactionRevision(input.sessionId),
      });
    }

    it('keeps one session’s compaction out of every other session and document', () => {
      const first = seedSession('doc-a', 'hash-a', 'First');
      const sibling = seedSession('doc-a', 'hash-a', 'Sibling');
      const other = seedSession('doc-b', 'hash-b', 'Other document');

      const cleared = compact({
        sessionId: first,
        summary: 'Summary of the first conversation.',
        compactedThroughOrdinal: 1,
      });

      expect(cleared.clearedContextItemIds).toEqual([`${first}-ctx`]);
      expect(chat.getCompactionState(sibling)).toEqual({ summary: null, compactedThroughOrdinal: null });
      expect(chat.getCompactionState(other)).toEqual({ summary: null, compactedThroughOrdinal: null });
      expect(chat.listContext(sibling)).toHaveLength(1);
      expect(chat.listContext(other)).toHaveLength(1);
      // Compaction changes what replays, never what is stored.
      expect(chat.listMessages(first)).toHaveLength(2);
      expect(chat.listReplayableMessages(first)).toHaveLength(0);
      expect(chat.listReplayableMessages(sibling)).toHaveLength(2);
    });

    it('lands the summary, the boundary and the context clearing together or not at all', () => {
      const sessionId = seedSession('doc-a', 'hash-a', 'Atomic');

      // A boundary past the end of the conversation is rejected, and rejection
      // leaves the attached context and the absent summary exactly as they were.
      expect(() =>
        compact({
          sessionId,
          summary: 'Summary that must not land.',
          compactedThroughOrdinal: 99,
        })
      ).toThrow(/changed while/iu);
      expect(chat.getCompactionState(sessionId)).toEqual({ summary: null, compactedThroughOrdinal: null });
      expect(chat.listContext(sessionId)).toHaveLength(1);

      // An out-of-bound summary is refused before anything is written.
      expect(() =>
        compact({
          sessionId,
          summary: 'z'.repeat(CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS + 1),
          compactedThroughOrdinal: 1,
        })
      ).toThrow(/bound/iu);
      expect(() =>
        compact({ sessionId, summary: '   ', compactedThroughOrdinal: 1 })
      ).toThrow(/bound/iu);
      expect(chat.listContext(sessionId)).toHaveLength(1);

      const cleared = compact({
        sessionId,
        summary: 'Summary that lands.',
        compactedThroughOrdinal: 1,
      });
      expect(cleared.clearedContextItemIds).toHaveLength(1);
      expect(chat.getCompactionState(sessionId)).toEqual({
        summary: 'Summary that lands.',
        compactedThroughOrdinal: 1,
      });
      expect(chat.listContext(sessionId)).toEqual([]);
    });

    it('refuses a summary whose session changed after the revision was captured', () => {
      const sessionId = seedSession('doc-a', 'hash-a', 'Rebound');
      const expectedRevision = chat.compactionRevision(sessionId);

      // Rebinding the session's model after the summary was planned changes what
      // the summary was written for, so the commit is refused.
      db.raw.prepare("UPDATE chat_sessions SET model_id = 'other-model' WHERE id = ?").run(sessionId);
      expect(() =>
        chat.applyContextCompaction({
          sessionId,
          summary: 'Summary from the old binding.',
          compactedThroughOrdinal: 1,
          expectedRevision,
        })
      ).toThrow(/changed while/iu);
      expect(chat.getCompactionState(sessionId)).toEqual({ summary: null, compactedThroughOrdinal: null });
      expect(chat.listContext(sessionId)).toHaveLength(1);

      // A transcript that grew underneath the summary is refused on the same terms.
      const grown = chat.compactionRevision(sessionId);
      db.raw.prepare(`
        INSERT INTO chat_messages (id, session_id, role, ordinal, content, status)
        VALUES (?, ?, 'user', 2, 'Added after planning', 'complete')
      `).run(`${sessionId}-late`, sessionId);
      expect(() =>
        chat.applyContextCompaction({
          sessionId,
          summary: 'Summary from the old transcript.',
          compactedThroughOrdinal: 1,
          expectedRevision: grown,
        })
      ).toThrow(/changed while/iu);
      expect(chat.getCompactionState(sessionId).summary).toBeNull();
    });

    it('drops compaction state with the session and with the document', () => {
      const sessionId = seedSession('doc-a', 'hash-a', 'Deleted session');
      const survivor = seedSession('doc-b', 'hash-b', 'Survivor');
      compact({ sessionId, summary: 'Doomed summary.', compactedThroughOrdinal: 1 });
      compact({ sessionId: survivor, summary: 'Kept summary.', compactedThroughOrdinal: 1 });

      chat.deleteSession(sessionId);
      expect(
        db.raw.prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE id = ?').get(sessionId)
      ).toEqual({ count: 0 });
      expect(chat.getCompactionState(survivor).summary).toBe('Kept summary.');

      new DocumentRepository(db).delete('doc-b');
      expect(
        db.raw.prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE document_id = ?').get('doc-b')
      ).toEqual({ count: 0 });
      expect(
        db.raw.prepare('SELECT COUNT(*) AS count FROM chat_context_items').get()
      ).toEqual({ count: 0 });
    });
  });
});
