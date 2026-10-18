import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ChatRepository } from '@main/db/repositories/chat-repository';
import { CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS } from '@shared/constants/ai';
import type { ChatSession, ChatSourceEnvelopeItem } from '@shared/types/ai';

describe('ChatRepository', () => {
  let db: InterleafDatabase;
  let chat: ChatRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    new DocumentRepository(db).insert({
      id: 'doc-chat',
      title: 'Grounded Systems',
      author: null,
      format: 'pdf',
      filePath: '/chat.pdf',
      storageMode: 'link',
      fileSize: 10,
      fileMtimeMs: 1,
      fileHash: 'hash-chat',
      pageCount: 2,
    });
    chat = new ChatRepository(db);
  });

  afterEach(() => { db.close(); });

  it('persists sessions, explicit context, contiguous turns, and exact answer sources', () => {
    const session = chat.createSession({
      documentId: 'doc-chat',
      title: 'Replication notes',
      providerId: 'fake',
      modelId: 'fake-grounded',
    });
    expect(session).toMatchObject({ documentHash: 'hash-chat', messageCount: 0 });
    const context = chat.createContext({
      sessionId: session.id,
      documentId: session.documentId,
      documentHash: session.documentHash,
      kind: 'selection',
      sourceRef: { anchor: 'selection' },
      excerptText: 'Leader based replication',
      location: { format: 'pdf', pageIndex: 0 },
      provenance: { pageLabel: '1' },
      displayLabel: 'Leader based replication',
    });
    const source: ChatSourceEnvelopeItem = {
      sourceId: 'src-1',
      documentId: session.documentId,
      documentHash: session.documentHash,
      documentTitle: 'Grounded Systems',
      documentFormat: 'pdf',
      chunkId: null,
      contextItemId: context.id,
      location: { format: 'pdf', pageIndex: 0 },
      excerptText: context.excerptText,
      excerptHash: context.excerptHash,
      heading: 'Replication',
      pageLabel: '1',
      label: 'Page 1 · Replication',
    };
    const first = chat.beginTurn(session.id, 'd2ba94db-41c4-42d0-91ee-e737a907360e', 'Explain this.', [source]);
    expect(first.userMessage.ordinal).toBe(0);
    expect(first.assistantMessage).toMatchObject({ ordinal: 1, status: 'streaming' });
    const completed = chat.finalizeAssistant({
      messageId: first.assistantMessage.id,
      requestId: 'd2ba94db-41c4-42d0-91ee-e737a907360e',
      content: 'Grounded answer [src-1].',
      citations: [{ sourceId: 'src-1', label: source.label, pageLabel: '1', heading: 'Replication' }],
      status: 'complete',
      tokenCount: 4,
    });
    expect(completed).toMatchObject({ status: 'complete', tokenCount: 4 });
    expect(chat.listMessages(session.id).map((message) => message.ordinal)).toEqual([0, 1]);
    expect(chat.resolveCitation(session.id, completed.id, 'src-1')).toMatchObject({
      label: source.label,
      location: { format: 'pdf', pageIndex: 0 },
    });

    chat.removeContext(session.id, context.id);
    expect(chat.resolveCitation(session.id, completed.id, 'src-1')).toMatchObject({
      sourceId: 'src-1',
    });
  });

  it('rejects concurrent turns and stale document revisions', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Chat', providerId: 'fake' });
    chat.beginTurn(session.id, '847d49c0-53eb-46cd-8e15-471ee5a24be3', 'First', []);
    expect(() => chat.beginTurn(session.id, 'f161f673-451c-451d-88f2-b712ad35299f', 'Second', []))
      .toThrow(/already generating/i);
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-chat'").run();
    expect(chat.requireCurrentSession(session.id).isArchived).toBe(true);
    expect(() => chat.requireActiveSession(session.id)).toThrow(/This conversation is archived because the document was updated/i);
  });

  it('recovers abandoned streaming messages as failed on repository startup', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Chat', providerId: 'fake' });
    const turn = chat.beginTurn(session.id, 'b291f6dc-0ec9-4d60-b1a8-0e69c73bc696', 'Question', []);
    chat = new ChatRepository(db);
    expect(chat.listMessages(session.id).find((message) => message.id === turn.assistantMessage.id))
      .toMatchObject({ status: 'failed', errorMessage: 'Generation was interrupted before completion.' });
  });

  it('loads messages written before disclosures and web sources were stored with empty lists', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Legacy', providerId: 'fake' });
    chat.beginTurn(session.id, '5b0c3a1e-7f4d-4e2a-9b61-2d8f0c7a9e13', 'Question', []);
    db.raw.prepare('UPDATE chat_messages SET disclosures_json = NULL, web_sources_json = NULL WHERE session_id = ?').run(session.id);
    const messages = chat.listMessages(session.id);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.disclosures).toEqual([]);
      expect(message.webSources).toEqual([]);
    }
  });

  it('preserves streaming disclosures when finalizing without an override', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Disclosure lifecycle', providerId: 'fake' });
    const disclosures = [{
      contextItemId: 'context-disclosure',
      displayLabel: 'Page 1',
      totalChunks: 1,
      includedChunks: 1,
      omittedChunks: 0,
      reason: 'boundary_over_inclusion' as const,
    }];
    const requestId = 'b6f5bf61-0d5f-4f1d-8b27-8bd57dddb02b';
    const turn = chat.beginTurn(session.id, requestId, 'Question', [], disclosures);

    const failed = chat.finalizeAssistant({
      messageId: turn.assistantMessage.id,
      requestId,
      content: 'Partial answer',
      citations: [],
      status: 'failed',
      errorMessage: 'Provider stopped.',
    });

    expect(failed).toMatchObject({ status: 'failed', disclosures });
    expect(chat.listMessages(session.id).find((message) => message.id === turn.assistantMessage.id))
      .toMatchObject({ status: 'failed', disclosures });
  });

  it('updates and deletes chat sessions', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Old Title', providerId: 'fake' });
    const updated = chat.updateSession({ sessionId: session.id, title: 'New Title', providerId: 'codex' });
    expect(updated.title).toBe('New Title');
    expect(updated.providerId).toBe('codex');
    expect(chat.listSessions('doc-chat')).toHaveLength(1);

    chat.deleteSession(session.id);
    expect(chat.listSessions('doc-chat')).toHaveLength(0);
  });

  it('enforces maximum context items per session (64 items)', () => {
    const session = chat.createSession({ documentId: 'doc-chat', title: 'Context Limit', providerId: 'fake' });
    for (let i = 0; i < 64; i++) {
      chat.createContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        kind: 'selection',
        sourceRef: { index: i },
        excerptText: `Excerpt ${String(i)}`,
        location: { format: 'pdf', pageIndex: 0 },
        provenance: {},
        displayLabel: `Excerpt ${String(i)}`,
      });
    }
    expect(() =>
      chat.createContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        kind: 'selection',
        sourceRef: { index: 64 },
        excerptText: 'Excerpt 64',
        location: { format: 'pdf', pageIndex: 0 },
        provenance: {},
        displayLabel: 'Excerpt 64',
      })
    ).toThrow(/maximum number of context items/i);
  });

  describe('submitted context persists past the turn that sends it', () => {
    const draftFor = (
      session: { id: string; documentId: string; documentHash: string },
      index: number
    ) =>
      chat.createContext({
        sessionId: session.id,
        documentId: session.documentId,
        documentHash: session.documentHash,
        kind: 'selection',
        sourceRef: { index },
        excerptText: `Submitted excerpt ${String(index)}`,
        location: { format: 'pdf', pageIndex: index },
        provenance: { pageLabel: String(index + 1) },
        displayLabel: `Excerpt ${String(index)}`,
      });

    const sourceFor = (
      session: { documentId: string; documentHash: string },
      item: { id: string; excerptText: string; excerptHash: string },
      sourceId: string,
      overrides: Partial<ChatSourceEnvelopeItem> = {}
    ): ChatSourceEnvelopeItem => ({
      sourceId,
      documentId: session.documentId,
      documentHash: session.documentHash,
      documentTitle: 'Grounded Systems',
      documentFormat: 'pdf',
      chunkId: null,
      contextItemId: item.id,
      location: { format: 'pdf', pageIndex: 0 },
      excerptText: item.excerptText,
      excerptHash: item.excerptHash,
      heading: null,
      pageLabel: '1',
      label: `Page 1 · ${sourceId}`,
      ...overrides,
    });

    const contextIds = (sessionId: string): string[] =>
      chat.listContext(sessionId).map((item) => item.id);

    it('keeps every attached item after the turn and records where its sources came from', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Persistence', providerId: 'fake' });
      const sent = draftFor(session, 0);
      const other = draftFor(session, 1);

      const turn = chat.beginTurn(
        session.id,
        '9c1a5d3e-2b4f-4c9a-8f11-6d2f0a4b7c31',
        'Explain the first excerpt.',
        [sourceFor(session, sent, 'src-1')]
      );

      // Attached context is a standing statement about the conversation, so the
      // accepted turn leaves both chips exactly where the reader put them.
      expect(contextIds(session.id).toSorted()).toEqual([sent.id, other.id].toSorted());
      expect(Object.keys(turn).toSorted()).toEqual(['assistantMessage', 'userMessage']);

      expect(chat.resolveCitation(session.id, turn.assistantMessage.id, 'src-1')).toMatchObject({
        sourceId: 'src-1',
        location: { format: 'pdf', pageIndex: 0 },
      });
      const stored = db.raw
        .prepare(
          'SELECT context_item_id, attached_origin, excerpt_text FROM chat_message_sources WHERE message_id = ? AND source_id = ?'
        )
        .get(turn.assistantMessage.id, 'src-1') as {
          context_item_id: string | null;
          attached_origin: number;
          excerpt_text: string;
        };
      expect(stored.excerpt_text).toBe(sent.excerptText);
      expect(stored.context_item_id).toBe(sent.id);
      // Marked as having come from an attachment, so removing that attachment
      // stops the snapshot being replayed while the citation still resolves.
      expect(stored.attached_origin).toBe(1);
    });

    it('leaves every session\'s attached context alone, including its own', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Owner', providerId: 'fake' });
      const other = chat.createSession({ documentId: 'doc-chat', title: 'Bystander', providerId: 'fake' });
      const own = draftFor(session, 0);
      const foreign = draftFor(other, 1);

      chat.beginTurn(session.id, '2f0d8b21-6a4e-4f52-9c8d-3b7a15e0c944', 'Question', []);

      expect(contextIds(session.id)).toEqual([own.id]);
      expect(contextIds(other.id)).toEqual([foreign.id]);
    });

    it('keeps every draft when the turn is rejected', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Rejected', providerId: 'fake' });
      const draft = draftFor(session, 0);
      const mismatched = sourceFor(session, draft, 'src-1', { documentHash: 'hash-v-other' });

      expect(() =>
        chat.beginTurn(session.id, '5b6f2c10-7d3a-4e88-9a20-8c41f6d5b0a2', 'Question', [mismatched])
      ).toThrow(/does not match the chat document revision/i);

      expect(contextIds(session.id)).toEqual([draft.id]);
      expect(chat.listMessages(session.id)).toHaveLength(0);
    });

    it('keeps drafts when a concurrent turn is refused', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Concurrent', providerId: 'fake' });
      chat.beginTurn(session.id, 'a1f4c2d8-5e6b-4a19-8f30-7c2d9b1e4f65', 'First', []);
      const draft = draftFor(session, 0);

      expect(() =>
        chat.beginTurn(session.id, 'c7e3a90b-1d24-4f68-9b52-0a8f3d6c1e77', 'Second', [
          sourceFor(session, draft, 'src-1'),
        ])
      ).toThrow(/already generating/i);

      expect(contextIds(session.id)).toEqual([draft.id]);
    });
  });

  describe('listRecentTurnSources — what earlier turns actually sent', () => {
    const source = (
      session: { documentId: string; documentHash: string },
      overrides: Partial<ChatSourceEnvelopeItem> & { sourceId: string }
    ): ChatSourceEnvelopeItem => ({
      documentId: session.documentId,
      documentHash: session.documentHash,
      documentTitle: 'Grounded Systems',
      documentFormat: 'pdf',
      chunkId: null,
      contextItemId: null,
      location: { format: 'pdf', pageIndex: 0 },
      excerptText: 'Replicated excerpt',
      excerptHash: 'hash-excerpt',
      heading: null,
      pageLabel: '1',
      label: 'Page 1',
      ...overrides,
    });

    const answer = (
      session: { id: string; documentId: string; documentHash: string },
      requestId: string,
      question: string,
      sources: readonly ChatSourceEnvelopeItem[]
    ): void => {
      const turn = chat.beginTurn(session.id, requestId, question, sources);
      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId,
        content: 'Answer.',
        citations: [],
        status: 'complete',
      });
    };

    it('returns the most recent turn first and deduplicates repeated excerpts', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Replay', providerId: 'fake' });
      answer(session, '11111111-1111-4111-8111-111111111111', 'First', [
        source(session, { sourceId: 'src-1', excerptText: 'Oldest', excerptHash: 'hash-old' }),
      ]);
      answer(session, '22222222-2222-4222-8222-222222222222', 'Second', [
        // Same excerpt as the first turn, cited again under a new request-local id.
        source(session, { sourceId: 'src-1', excerptText: 'Oldest', excerptHash: 'hash-old' }),
        source(session, { sourceId: 'src-2', excerptText: 'Newest', excerptHash: 'hash-new' }),
        // A repeat within one turn, identified by chunk rather than by hash.
        source(session, { sourceId: 'src-3', chunkId: 'chunk-a', excerptText: 'Chunked', excerptHash: 'hash-c1' }),
        source(session, { sourceId: 'src-4', chunkId: 'chunk-a', excerptText: 'Chunked', excerptHash: 'hash-c2' }),
      ]);

      const replayed = chat.listRecentTurnSources(session.id, 8);
      expect(replayed.map((item) => item.excerptText)).toEqual(['Oldest', 'Newest', 'Chunked']);
      expect(replayed[0]).toMatchObject({ documentId: 'doc-chat', label: 'Page 1' });
    });

    it('bounds the returned count and treats a non-positive limit as none', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Bounded', providerId: 'fake' });
      answer(session, '33333333-3333-4333-8333-333333333333', 'Question', [
        source(session, { sourceId: 'src-1', excerptHash: 'hash-1' }),
        source(session, { sourceId: 'src-2', excerptHash: 'hash-2' }),
        source(session, { sourceId: 'src-3', excerptHash: 'hash-3' }),
      ]);

      expect(chat.listRecentTurnSources(session.id, 2)).toHaveLength(2);
      expect(chat.listRecentTurnSources(session.id, 0)).toEqual([]);
      expect(chat.listRecentTurnSources(session.id, -5)).toEqual([]);
    });

    it('applies recency, unique-source dedup, and the hard limit over a long history', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Long history', providerId: 'fake' });
      // Twelve turns, each re-citing the carried excerpt and adding a new one,
      // so 24 stored source rows collapse to 13 distinct sources. The dedup,
      // recency order, and limit are evaluated inside SQLite, never by
      // materialising the whole history in JavaScript.
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].forEach((turn) => {
        answer(session, `11111111-2222-4333-8444-${String(turn).padStart(12, '0')}`, 'Question', [
          source(session, {
            sourceId: `src-repeat-${String(turn)}`,
            excerptText: 'Carried',
            excerptHash: 'hash-carried',
          }),
          source(session, {
            sourceId: `src-new-${String(turn)}`,
            excerptText: `Excerpt ${String(turn)}`,
            excerptHash: `hash-${String(turn)}`,
          }),
        ]);
      });
      expect(
        db.raw
          .prepare(
            'SELECT COUNT(*) AS n FROM chat_message_sources s JOIN chat_messages m ON m.id = s.message_id WHERE m.session_id = ?'
          )
          .get(session.id)
      ).toMatchObject({ n: 24 });

      const replayed = chat.listRecentTurnSources(session.id, 10);
      expect(replayed).toHaveLength(10);
      expect(replayed.map((item) => item.excerptText)).toEqual([
        'Carried',
        'Excerpt 11',
        'Excerpt 10',
        'Excerpt 9',
        'Excerpt 8',
        'Excerpt 7',
        'Excerpt 6',
        'Excerpt 5',
        'Excerpt 4',
        'Excerpt 3',
      ]);
      // The most recent citation of the carried excerpt is the newest turn's.
      expect(replayed[0]).toMatchObject({ documentId: 'doc-chat', label: 'Page 1' });
      expect(chat.listRecentTurnSources(session.id, 200)).toHaveLength(13);
    });

    it('replays nothing once the document has changed under the conversation', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Drifted', providerId: 'fake' });
      answer(session, '44444444-4444-4444-8444-444444444444', 'Question', [
        source(session, { sourceId: 'src-1', excerptHash: 'hash-1' }),
      ]);
      expect(chat.listRecentTurnSources(session.id, 8)).toHaveLength(1);

      db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-chat'").run();
      expect(chat.requireCurrentSession(session.id).isArchived).toBe(true);
      expect(chat.listRecentTurnSources(session.id, 8)).toEqual([]);
    });

    it('never returns another session\'s sources', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Mine', providerId: 'fake' });
      const other = chat.createSession({ documentId: 'doc-chat', title: 'Theirs', providerId: 'fake' });
      answer(other, '55555555-5555-4555-8555-555555555555', 'Their question', [
        source(other, { sourceId: 'src-1', excerptText: 'Their excerpt', excerptHash: 'hash-theirs' }),
      ]);

      expect(chat.listRecentTurnSources(session.id, 8)).toEqual([]);
      expect(chat.listRecentTurnSources(other.id, 8)).toHaveLength(1);
    });

    it('skips a snapshot whose stored location is unreadable', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Corrupt', providerId: 'fake' });
      answer(session, '66666666-6666-4666-8666-666666666666', 'Question', [
        source(session, { sourceId: 'src-1', excerptHash: 'hash-good' }),
        source(session, { sourceId: 'src-2', excerptHash: 'hash-bad' }),
      ]);
      db.raw
        .prepare("UPDATE chat_message_sources SET location_json = '{not json' WHERE source_id = 'src-2'")
        .run();

      expect(chat.listRecentTurnSources(session.id, 8).map((item) => item.excerptHash)).toEqual(['hash-good']);
    });

    it('does not replay a removed attachment as a stored turn source', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Removed', providerId: 'fake' });
      const item = chat.createContext({
        sessionId: session.id,
        documentId: 'doc-chat',
        documentHash: session.documentHash,
        kind: 'selection',
        sourceRef: { anchor: 'selection' },
        excerptText: 'Quorum writes',
        location: { format: 'pdf', pageIndex: 0 },
        provenance: { pageLabel: '1' },
        displayLabel: 'Quorum writes',
      });
      const requestId = '22222222-3333-4444-8555-666666666666';
      const turn = chat.beginTurn(session.id, requestId, 'Explain this.', [
        source(session, {
          sourceId: 'src-1',
          contextItemId: item.id,
          excerptText: item.excerptText,
          excerptHash: item.excerptHash,
        }),
      ]);
      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId,
        content: 'Answer [src-1].',
        citations: [{ sourceId: 'src-1', label: 'Page 1', pageLabel: '1', heading: null }],
        status: 'complete',
        tokenCount: 3,
      });

      // While attached, the live item is what supplies the passage, so the
      // snapshot is not replayed on top of it.
      expect(chat.listRecentTurnSources(session.id, 8).map((replayed) => replayed.excerptText))
        .not.toContain(item.excerptText);

      chat.removeContext(session.id, item.id);

      // And after removal it must not come back through the replay path.
      expect(chat.listRecentTurnSources(session.id, 8).map((replayed) => replayed.excerptText))
        .not.toContain(item.excerptText);
      // The snapshot itself stays for citation resolution and audit.
      expect(chat.resolveCitation(session.id, turn.assistantMessage.id, 'src-1')).toMatchObject({
        sourceId: 'src-1',
      });
    });

    it('still replays retrieved chunk snapshots, which no attachment owns', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Retrieved', providerId: 'fake' });
      chat.beginTurn(session.id, '33333333-4444-4555-8666-777777777777', 'Explain this.', [
        source(session, {
          sourceId: 'src-1',
          chunkId: 'chunk-1',
          excerptText: 'Retrieved passage',
          excerptHash: 'b'.repeat(64),
          location: { format: 'pdf', pageIndex: 1 },
        }),
      ]);

      expect(chat.listRecentTurnSources(session.id, 8).map((item) => item.excerptText))
        .toEqual(['Retrieved passage']);
    });
  });

  describe('generateTitle — unique sequential naming', () => {
    it('increments for multiple sessions', () => {
      const s1 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      const s2 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      const s3 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s1.title).toBe('Conversation 1');
      expect(s2.title).toBe('Conversation 2');
      expect(s3.title).toBe('Conversation 3');
    });

    it('fills gaps left by deleted sessions', () => {
      const s1 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      chat.deleteSession(s1.id);
      // Gap at 1 — next creation should reuse "Conversation 1"
      const s3 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s3.title).toBe('Conversation 1');
    });

    it('skips collision with user-renamed session case-insensitively', () => {
      // User renames first session to "conversation 3" (lowercase)
      const s1 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      chat.updateSession({ sessionId: s1.id, title: 'conversation 3' });
      // Taken set: {"conversation 3"}. Next: "Conversation 1" (1 free), then "Conversation 2"
      const s2 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s2.title).toBe('Conversation 1');
      const s3 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s3.title).toBe('Conversation 2');
      // Now taken: {"conversation 3", "conversation 1", "conversation 2"}
      // Next: skip 1,2,3 → "Conversation 4"
      const s4 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s4.title).toBe('Conversation 4');
    });

    it('scopes titles per document', () => {
      db.raw.prepare(`
        INSERT INTO documents (id, title, author, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash, page_count, created_at, updated_at)
        VALUES ('doc-chat-2', 'Another Doc', NULL, 'pdf', '/other.pdf', 'link', 10, 1, 'hash-chat-2', 2,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run();

      chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      // doc-chat-2's first session should be "Conversation 1" regardless
      const other = chat.createSession({ documentId: 'doc-chat-2', providerId: 'fake' });
      expect(other.title).toBe('Conversation 1');
    });

    it('skips archived sessions that occupy a generated title', () => {
      const s1 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s1.title).toBe('Conversation 1');
      // Archive the session by updating the document hash
      db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-chat'").run();
      expect(chat.requireCurrentSession(s1.id).isArchived).toBe(true);
      // New session should get "Conversation 2" since "Conversation 1" is still in the table (archived)
      const s2 = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(s2.title).toBe('Conversation 2');
    });
  });

  /**
   * Conversation cards show an excerpt of the conversation itself. The excerpt is
   * derived from stored messages at read time — nothing is generated, and a
   * session with no usable message text reports `null` instead of a placeholder.
   */
  describe('session previews', () => {
    const REQUEST_ID = 'd2ba94db-41c4-42d0-91ee-e737a907360e';
    let session: ChatSession;

    const reload = (): ChatSession => {
      const listed = chat.listSessions('doc-chat').find((item) => item.id === session.id);
      if (!listed) throw new Error('session missing');
      return listed;
    };

    beforeEach(() => {
      session = chat.createSession({
        documentId: 'doc-chat',
        title: 'Replication notes',
        providerId: 'fake',
        modelId: 'fake-grounded',
      });
    });

    it('reports no preview for a session that has no messages', () => {
      expect(session.previewText).toBeNull();
      expect(session.messageCount).toBe(0);
      expect(reload().previewText).toBeNull();
      expect(chat.getSession(session.id)?.previewText).toBeNull();
      expect(chat.getSessionForDocument(session.id, 'doc-chat')?.previewText).toBeNull();
    });

    it('uses the question while the answer is still empty, then the finished answer', () => {
      const turn = chat.beginTurn(session.id, REQUEST_ID, 'Explain leader\n replication  please', []);
      expect(reload().previewText).toBe('Explain leader replication please');

      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId: REQUEST_ID,
        content: 'Majority overlap guarantees consensus.',
        citations: [],
        status: 'complete',
        tokenCount: 5,
      });
      const updated = reload();
      expect(updated.previewText).toBe('Majority overlap guarantees consensus.');
      expect(updated.messageCount).toBe(2);
    });

    it('bounds the excerpt it sends to the renderer', () => {
      const long = 'consensus '.repeat(120).trim();
      const turn = chat.beginTurn(session.id, REQUEST_ID, 'Explain', []);
      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId: REQUEST_ID,
        content: long,
        citations: [],
        status: 'complete',
        tokenCount: 5,
      });

      const preview = reload().previewText;
      expect(preview).not.toBeNull();
      expect(preview?.length).toBeLessThanOrEqual(CHAT_SESSION_PREVIEW_MAX_TEXT_UNITS);
      expect(preview?.endsWith('…')).toBe(true);
      expect(long.startsWith((preview ?? '').slice(0, 20))).toBe(true);
    });

    it('labels the markers its own citations name and leaves other bracketed text as written', () => {
      const turn = chat.beginTurn(session.id, REQUEST_ID, 'Explain', []);
      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId: REQUEST_ID,
        content: 'Leaders replicate [src-1] and [src-2]; see [note] and `[src-1]`.',
        citations: [
          { sourceId: 'src-1', label: 'Page 4', pageLabel: '4', heading: null },
          { sourceId: 'src-2', label: 'Section', pageLabel: null, heading: 'Quorums' },
        ],
        status: 'complete',
        tokenCount: 5,
      });

      expect(reload().previewText).toBe('Leaders replicate (p. 4) and (Quorums); see [note] and `[src-1]`.');
    });

    it('leaves every marker as written when the message has no citations', () => {
      const turn = chat.beginTurn(session.id, REQUEST_ID, 'Explain', []);
      chat.finalizeAssistant({
        messageId: turn.assistantMessage.id,
        requestId: REQUEST_ID,
        content: 'Literal [src-1] text.',
        citations: [],
        status: 'complete',
        tokenCount: 5,
      });

      expect(reload().previewText).toBe('Literal [src-1] text.');
    });

    it('falls back to the previous message when the latest turn failed with no text', () => {
      const first = chat.beginTurn(session.id, REQUEST_ID, 'Explain quorum', []);
      chat.finalizeAssistant({
        messageId: first.assistantMessage.id,
        requestId: REQUEST_ID,
        content: 'Quorum requires a majority.',
        citations: [],
        status: 'complete',
        tokenCount: 4,
      });
      const second = chat.beginTurn(session.id, '3f6ec7c9-2f0e-4c17-9a09-6d1ab5f1f0c1', 'And partitions?', []);
      chat.finalizeAssistant({
        messageId: second.assistantMessage.id,
        requestId: '3f6ec7c9-2f0e-4c17-9a09-6d1ab5f1f0c1',
        content: '',
        citations: [],
        status: 'failed',
        errorMessage: 'Provider error',
      });

      expect(reload().previewText).toBe('And partitions?');
    });
  });

  describe('document-scoped detail hydration', () => {
    beforeEach(() => {
      new DocumentRepository(db).insert({
        id: 'doc-other',
        title: 'Unrelated Document',
        author: null,
        format: 'pdf',
        filePath: '/other.pdf',
        storageMode: 'link',
        fileSize: 10,
        fileMtimeMs: 1,
        fileHash: 'hash-other',
        pageCount: 2,
      });
    });

    it('returns the session when the document ID owns it', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Owned', providerId: 'fake' });
      const found = chat.getSessionForDocument(session.id, 'doc-chat');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(session.id);
      expect(found?.documentId).toBe('doc-chat');
    });

    it('does not return a session belonging to another document', () => {
      const session = chat.createSession({ documentId: 'doc-chat', title: 'Private', providerId: 'fake' });
      // The unscoped selector still finds it; the scoped selector must not.
      expect(chat.getSession(session.id)).not.toBeNull();
      expect(chat.getSessionForDocument(session.id, 'doc-other')).toBeNull();
    });

    it('is indistinguishable from a missing session for an unknown document', () => {
      const session = chat.createSession({ documentId: 'doc-chat', providerId: 'fake' });
      expect(chat.getSessionForDocument(session.id, 'doc-does-not-exist')).toBeNull();
      expect(chat.getSessionForDocument('session-does-not-exist', 'doc-chat')).toBeNull();
    });
  });
});
