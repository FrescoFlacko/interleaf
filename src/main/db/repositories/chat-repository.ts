import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS,
  CHAT_CONTEXT_ITEM_MAX_TEXT_UNITS,
  CHAT_MAX_CONTEXT_ITEMS,
  CHAT_RESPONSE_MAX_TEXT_UNITS,
} from '@shared/constants/ai';
import {
  createChatSessionRequestSchema,
  storedChatContextTextSchema,
  updateChatSessionRequestSchema,
} from '@shared/schemas/ai';
import { parseDocumentLocation } from '@shared/schemas/document';
import { isAutomaticProvenance } from '../../ai/whole-document-intent';
import { serializeWebSources } from './chat-web-sources';
import { SESSION_SUMMARY_COLUMNS } from './chat-session-summary';
import { mapContext, mapMessage, mapSession, type ContextRow, type MessageRow, type SessionRow } from './chat-row-mappers';
import { mapTurnSourceRows, type StoredTurnSource, type TurnSourceRow } from './chat-turn-sources';
import type {
  AIProviderId,
  ChatCitation,
  ChatContextDisclosure,
  ChatContextItem,
  ChatContextKind,
  ChatMessage,
  ChatMessageStatus,
  ChatSession,
  ChatSourceEnvelopeItem,
  ChatWebSource,
  CitationTarget,
  ReasoningEffort,
} from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';
import { type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';

export type { StoredTurnSource };

type CurrentSessionRow = SessionRow & {
  current_document_hash: string;
  document_format: ChatSourceEnvelopeItem['documentFormat'];
  document_title: string;
};

export type CreateStoredContextInput = {
  readonly sessionId: string;
  readonly documentId: string;
  readonly documentHash: string;
  readonly kind: Exclude<ChatContextKind, 'retrieved_chunk'>;
  readonly sourceRef: PortableRecord;
  readonly excerptText: string;
  readonly location: DocumentLocation;
  readonly provenance: PortableRecord;
  readonly displayLabel: string;
};

export type BegunChatTurn = {
  readonly userMessage: ChatMessage;
  readonly assistantMessage: ChatMessage;
};

/** Per-session conversation compaction state, as `Clean Context` left it. */
export type ChatCompactionState = {
  /** Bounded model-authored summary of everything up to the boundary. */
  readonly summary: string | null;
  /** Ordinal of the last message the summary covers. */
  readonly compactedThroughOrdinal: number | null;
};

/**
 * The session state a compaction was planned against, captured before the
 * provider call and required again before the commit.
 */
export type ChatCompactionRevision = {
  readonly documentHash: string;
  readonly providerId: AIProviderId;
  readonly modelId: string | null;
  /** The summary the new one replaces, so a racing compaction cannot be lost. */
  readonly contextSummary: string | null;
  /** Digest of every stored message: identity, order, status and content. */
  readonly transcriptDigest: string;
};

/**
 * The summary a compaction is allowed to store, and the boundary it claims.
 *
 * Both are bounded before any transaction opens: a summary is model output, so
 * its length is enforced here rather than trusted, and a boundary that is not a
 * real message ordinal would silently hide the conversation's past.
 */
function requireStorableSummary(summary: string, compactedThroughOrdinal: number): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0 || trimmed.length > CHAT_COMPACTION_MAX_SUMMARY_TEXT_UNITS) {
    throw new InterleafError('internal', 'Conversation summary is not within the stored bound.');
  }
  if (!Number.isSafeInteger(compactedThroughOrdinal) || compactedThroughOrdinal < 0) {
    throw new InterleafError('internal', 'Compaction boundary is invalid.');
  }
  return trimmed;
}

/**
 * Refuses a commit whose planning state is no longer the session's state.
 *
 * A summary describes one transcript, written by one provider and model. If any
 * of that moved while the provider was answering, the safe outcome is to change
 * nothing: the alternative is an old-provider summary overwriting a newer one, or
 * a boundary covering messages the summary never saw.
 */
function requireUnchangedRevision(expected: ChatCompactionRevision, current: ChatCompactionRevision): void {
  const unchanged =
    expected.documentHash === current.documentHash &&
    expected.providerId === current.providerId &&
    expected.modelId === current.modelId &&
    expected.contextSummary === current.contextSummary &&
    expected.transcriptDigest === current.transcriptDigest;
  if (!unchanged) {
    throw new InterleafError('validation', 'The conversation changed while it was being cleaned, so nothing was changed.');
  }
}

/**
 * The level one binding write stores. A model change that names no level is a
 * choice of Default, never a carried-over level the new model may lack.
 */
function boundEffort(requested: ReasoningEffort | null | undefined, rebinds: boolean, stored: string | null): string | null {
  if (requested !== undefined) return requested;
  return rebinds ? null : stored;
}

/**
 * Whether a stored snapshot came from an attached context item.
 *
 * Attached context persists, so the live item is what supplies its passage on
 * later turns. Marking the origin keeps the replay path from sending the
 * snapshot too — and keeps it from resurrecting the passage once the reader
 * removes the item.
 */
function attachedOriginFlag(contextItemId: string | null): number {
  return contextItemId === null ? 0 : 1;
}

export class ChatRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.db.prepare(`
      UPDATE chat_messages
         SET status = 'failed', error_message = 'Generation was interrupted before completion.'
       WHERE status = 'streaming'
    `).run();
  }

  /**
   * "Conversation N" for a new conversation of this document, skipping any
   * number an existing (active or archived) session's title already holds,
   * compared case-insensitively. A deleted session's title is free again.
   * Explicit titles are stored as `manual`; this placeholder as `default`.
   */
  generateTitle(documentId: string): string {
    const rows = this.db.prepare(
      'SELECT title FROM chat_sessions WHERE document_id = ?'
    ).all(documentId) as { readonly title: string }[];
    const taken = new Set(rows.map((r) => r.title.toLowerCase()));
    let n = 1;
    while (taken.has(`conversation ${String(n)}`)) {
      n++;
    }
    return `Conversation ${String(n)}`;
  }

  createSession(input: {
    readonly documentId: string;
    readonly title?: string;
    readonly providerId: AIProviderId;
    readonly modelId?: string | null;
    readonly reasoningEffort?: ReasoningEffort | null;
  }): ChatSession {
    const trimmed = input.title?.trim();
    const title = trimmed && trimmed.length > 0 ? trimmed : this.generateTitle(input.documentId);
    // The deterministic provider is a unit-test double only. It remains
    // usable by direct repository tests under Vitest, while the shared schema
    // still rejects it at the renderer/main IPC boundary.
    const request = input.providerId === 'fake' && process.env.NODE_ENV === 'test'
      ? { ...input, title }
      : createChatSessionRequestSchema.parse({ ...input, title });
    const document = this.requireDocument(request.documentId);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO chat_sessions (
        id, document_id, document_hash, title, provider_id, model_id,
        reasoning_effort, title_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(id, request.documentId, document.file_hash, title, request.providerId, request.modelId ?? null,
      request.reasoningEffort ?? null, title === trimmed ? 'manual' : 'default');
    return this.requireSession(id);
  }

  getSession(sessionId: string): ChatSession | null {
    const row = this.selectSession().get(sessionId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  /**
   * Document-scoped detail lookup for the renderer-facing `chat:get-session`
   * channel. The document predicate is applied in SQL so a session belonging to
   * another document is not merely hidden by a caller-side check: it is never
   * selected. A mismatched document ID is indistinguishable from a missing
   * session by design.
   */
  getSessionForDocument(sessionId: string, documentId: string): ChatSession | null {
    const row = this.db.prepare(`
      SELECT s.*,${SESSION_SUMMARY_COLUMNS},
             d.file_hash AS current_document_hash
        FROM chat_sessions s
        JOIN documents d ON d.id = s.document_id
       WHERE s.id = ? AND s.document_id = ?
    `).get(sessionId, documentId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getCurrentSession(sessionId: string): CurrentSessionRow {
    const row = this.db.prepare(`
      SELECT s.*,${SESSION_SUMMARY_COLUMNS},
             d.file_hash AS current_document_hash,
             d.format AS document_format,
             d.title AS document_title
        FROM chat_sessions s
        JOIN documents d ON d.id = s.document_id
       WHERE s.id = ?
    `).get(sessionId) as CurrentSessionRow | undefined;
    if (!row) throw new InterleafError('validation', 'Chat session was not found.');
    return row;
  }

  requireCurrentSession(sessionId: string): ChatSession {
    return mapSession(this.getCurrentSession(sessionId));
  }

  requireActiveSession(sessionId: string): CurrentSessionRow {
    const current = this.getCurrentSession(sessionId);
    if (current.document_hash !== current.current_document_hash) {
      throw new InterleafError(
        'validation',
        'This conversation is archived because the document was updated to a new revision. Start a new chat to ask questions about the current document.'
      );
    }
    return current;
  }

  listSessions(documentId: string): readonly ChatSession[] {
    const rows = this.db.prepare(`
      SELECT s.*,${SESSION_SUMMARY_COLUMNS},
             d.file_hash AS current_document_hash
        FROM chat_sessions s
        JOIN documents d ON d.id = s.document_id
       WHERE s.document_id = ?
       ORDER BY s.updated_at DESC, s.id ASC
    `).all(documentId) as SessionRow[];
    return rows.map(mapSession);
  }

  updateSession(input: {
    readonly sessionId: string;
    readonly title?: string;
    readonly providerId?: AIProviderId;
    readonly modelId?: string | null;
    readonly reasoningEffort?: ReasoningEffort | null;
  }): ChatSession {
    const request = input.providerId === 'fake' && process.env.NODE_ENV === 'test'
      ? input
      : updateChatSessionRequestSchema.parse(input);
    const current = this.getCurrentSession(request.sessionId);
    const isArchived = current.document_hash !== current.current_document_hash;
    const rebinds = request.providerId !== undefined || request.modelId !== undefined;
    if (isArchived && (rebinds || request.reasoningEffort !== undefined)) {
      throw new InterleafError(
        'validation',
        'Provider or model cannot be changed for an archived conversation.'
      );
    }
    const title = request.title ?? current.title;
    const providerId = request.providerId ?? current.provider_id;
    const modelId = request.modelId === undefined ? current.model_id : request.modelId;
    const effort = boundEffort(request.reasoningEffort, rebinds, current.reasoning_effort ?? null);
    this.db.prepare(`
      UPDATE chat_sessions
         SET title = ?, provider_id = ?, model_id = ?, reasoning_effort = ?,
             title_state = CASE WHEN ? = 1 THEN 'manual' ELSE title_state END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
    `).run(title, providerId, modelId, effort, request.title === undefined ? 0 : 1, request.sessionId);
    return this.requireSession(request.sessionId);
  }

  deleteSession(sessionId: string): void {
    const result = this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    if (result.changes === 0) throw new InterleafError('validation', 'Chat session was not found.');
  }

  listMessages(sessionId: string): readonly ChatMessage[] {
    this.requireSession(sessionId);
    const rows = this.db.prepare(`
      SELECT * FROM chat_messages WHERE session_id = ? ORDER BY ordinal ASC
    `).all(sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }

  /**
   * The messages a later request may replay as conversation history.
   *
   * After a `Clean Context` compaction that is the tail of the transcript: the
   * stored summary stands for everything up to and including the boundary, so
   * replaying those messages too would resend what the summary already carries.
   * The transcript view is unaffected — `listMessages` still returns all of it,
   * because compaction shortens the model's context, not the reader's record.
   */
  listReplayableMessages(sessionId: string): readonly ChatMessage[] {
    this.requireSession(sessionId);
    const rows = this.db.prepare(`
      SELECT * FROM chat_messages
       WHERE session_id = ?
         AND ordinal > COALESCE(
           (SELECT compacted_through_ordinal FROM chat_sessions WHERE id = ?),
           -1
         )
       ORDER BY ordinal ASC
    `).all(sessionId, sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** What `Clean Context` last stored for this session, if anything. */
  getCompactionState(sessionId: string): ChatCompactionState {
    this.requireSession(sessionId);
    const row = this.db.prepare(`
      SELECT context_summary, compacted_through_ordinal
        FROM chat_sessions WHERE id = ?
    `).get(sessionId) as {
      readonly context_summary: string | null;
      readonly compacted_through_ordinal: number | null;
    };
    return {
      summary: row.context_summary,
      compactedThroughOrdinal: row.compacted_through_ordinal,
    };
  }

  /**
   * The session state one compaction was planned against.
   *
   * A compaction summarises a specific transcript with a specific provider and
   * model, and the call takes time. Capturing that state before the call and
   * requiring it again inside the commit is what stops a summary written from an
   * old transcript, or by a provider the session has since been rebound away
   * from, from overwriting newer state. The transcript is reduced to a digest:
   * the check needs to detect change, not carry the conversation around.
   */
  compactionRevision(sessionId: string): ChatCompactionRevision {
    const session = this.getCurrentSession(sessionId);
    const rows = this.db.prepare(`
      SELECT id, ordinal, role, status, content FROM chat_messages
       WHERE session_id = ? ORDER BY ordinal ASC
    `).all(sessionId) as {
      readonly id: string;
      readonly ordinal: number;
      readonly role: string;
      readonly status: string;
      readonly content: string;
    }[];
    const digest = createHash('sha256');
    for (const row of rows) {
      digest.update(`${row.id}|${String(row.ordinal)}|${row.role}|${row.status}|`);
      digest.update(row.content);
      digest.update('|');
    }
    return {
      documentHash: session.document_hash,
      providerId: session.provider_id,
      modelId: session.model_id,
      contextSummary: this.getCompactionState(sessionId).summary,
      transcriptDigest: digest.digest('hex'),
    };
  }

  /**
   * Commits one compaction: the summary, the boundary it covers, and the removal
   * of every attached context item, in a single transaction.
   *
   * All three move together or none do. A summary stored without its boundary
   * would be replayed beside the messages it already summarises, and a boundary
   * stored without its summary would silently drop the conversation's past, so
   * neither half is allowed to land alone. The messages themselves are untouched.
   *
   * `expectedRevision` is the state the summary was written from. It is checked
   * inside the transaction, so a session rebound to another provider or model, a
   * transcript that gained or lost a message, or a second compaction that landed
   * first makes this one fail rather than overwrite what is now current.
   */
  applyContextCompaction(input: {
    readonly sessionId: string;
    readonly summary: string;
    readonly compactedThroughOrdinal: number;
    readonly expectedRevision: ChatCompactionRevision;
  }): { readonly clearedContextItemIds: readonly string[] } {
    const summary = requireStorableSummary(input.summary, input.compactedThroughOrdinal);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.requireActiveSession(input.sessionId);
      this.requireCompactableConversation(input.sessionId, input.compactedThroughOrdinal);
      requireUnchangedRevision(input.expectedRevision, this.compactionRevision(input.sessionId));
      const cleared = this.db.prepare(
        'SELECT id FROM chat_context_items WHERE session_id = ? ORDER BY created_at ASC, id ASC'
      ).all(input.sessionId) as { readonly id: string }[];
      this.db.prepare('DELETE FROM chat_context_items WHERE session_id = ?').run(input.sessionId);
      this.db.prepare(`
        UPDATE chat_sessions
           SET context_summary = ?,
               context_summary_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               compacted_through_ordinal = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND document_hash = ?
      `).run(summary, input.compactedThroughOrdinal, input.sessionId, session.document_hash);
      this.db.exec('COMMIT');
      return { clearedContextItemIds: cleared.map((row) => row.id) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * The two conditions a compaction must still find true inside its own
   * transaction: nothing is generating into this conversation, and the boundary
   * the caller summarised through is one this conversation actually reached.
   */
  private requireCompactableConversation(sessionId: string, compactedThroughOrdinal: number): void {
    const streaming = this.db.prepare(`
      SELECT 1 AS active FROM chat_messages
       WHERE session_id = ? AND status = 'streaming' LIMIT 1
    `).get(sessionId);
    if (streaming) {
      throw new InterleafError('validation', 'This chat is already generating a response.');
    }
    const boundaryRow = this.db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS last_ordinal
        FROM chat_messages WHERE session_id = ?
    `).get(sessionId) as { readonly last_ordinal: number };
    if (compactedThroughOrdinal > boundaryRow.last_ordinal) {
      throw new InterleafError('validation', 'The conversation changed while it was being cleaned.');
    }
  }

  listContext(sessionId: string): readonly ChatContextItem[] {
    this.requireSession(sessionId);
    // Ordinary hydration is where a conversation stored by an earlier build is
    // first read again, so whole-document duplicates converge here rather than
    // waiting for the user to attach the document once more.
    this.collapseEntireDocumentDuplicates(sessionId);
    const rows = this.db.prepare(`
      SELECT * FROM chat_context_items
       WHERE session_id = ?
       ORDER BY pinned DESC, created_at ASC, id ASC
    `).all(sessionId) as ContextRow[];
    return rows.map(mapContext);
  }

  createContext(input: CreateStoredContextInput): ChatContextItem {
    storedChatContextTextSchema.parse(input.excerptText);
    if (input.excerptText.length > CHAT_CONTEXT_ITEM_MAX_TEXT_UNITS) {
      throw new InterleafError('validation', 'The selected AI context is too large.');
    }
    const session = this.getCurrentSession(input.sessionId);
    if (session.document_id !== input.documentId || session.document_hash !== input.documentHash) {
      throw new InterleafError('validation', 'Chat context does not match the active session revision.');
    }
    if (input.kind === 'entire_document') {
      const existing = this.existingEntireDocument(input.sessionId, input.documentHash);
      if (existing) return this.reconcileWholeDocumentIntent(existing, input.provenance);
    }
    const count = this.db.prepare(
      'SELECT COUNT(*) AS count FROM chat_context_items WHERE session_id = ?'
    ).get(input.sessionId) as { count: number };
    if (count.count >= CHAT_MAX_CONTEXT_ITEMS) {
      throw new InterleafError('validation', 'This chat already has the maximum number of context items.');
    }
    const id = randomUUID();
    const excerptHash = createHash('sha256').update(input.excerptText, 'utf8').digest('hex');
    this.db.prepare(`
      INSERT INTO chat_context_items (
        id, session_id, kind, source_ref_json, excerpt_text, excerpt_hash,
        document_hash, anchor_json, provenance_json, display_label, pinned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      id,
      input.sessionId,
      input.kind,
      JSON.stringify(input.sourceRef),
      input.excerptText,
      excerptHash,
      input.documentHash,
      JSON.stringify(input.location),
      JSON.stringify(input.provenance),
      input.displayLabel
    );
    const row = this.db.prepare('SELECT * FROM chat_context_items WHERE id = ?').get(id) as ContextRow | undefined;
    if (!row) throw new InterleafError('internal', 'Failed to create chat context.');
    return mapContext(row);
  }

  /**
   * Resolves the single whole-document attachment a session revision may hold.
   *
   * Whole-document context is a property of the (session, document revision)
   * pair rather than of an event, so the reading location a request happens to
   * carry cannot make a second attachment meaningful. `DatabaseSync` statements
   * run synchronously on the single main thread, so this lookup and the insert
   * that follows it in `createContext` cannot interleave with a competing
   * attach: repeated and concurrent requests all resolve to the same stored
   * row.
   */
  private existingEntireDocument(sessionId: string, documentHash: string): ChatContextItem | null {
    this.collapseEntireDocumentDuplicates(sessionId);
    const row = this.db.prepare(`
      SELECT * FROM chat_context_items
       WHERE session_id = ? AND kind = 'entire_document' AND document_hash = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1
    `).get(sessionId, documentHash) as ContextRow | undefined;
    return row ? mapContext(row) : null;
  }

  /**
   * Upgrades the one stored whole-document attachment when the user pins the
   * document themselves after Reader Chat had attached it automatically.
   *
   * The row keeps its identity — one attachment per session revision, existing
   * citations still resolve — and only records that the attachment is now an
   * explicit override. The reverse never happens: an automatic attach cannot
   * downgrade something the user pinned.
   */
  private reconcileWholeDocumentIntent(
    existing: ChatContextItem,
    provenance: PortableRecord
  ): ChatContextItem {
    if (!isAutomaticProvenance(existing.provenance) || isAutomaticProvenance(provenance)) return existing;
    this.db.prepare('UPDATE chat_context_items SET provenance_json = ? WHERE id = ?').run(
      JSON.stringify(provenance),
      existing.id
    );
    return { ...existing, provenance };
  }

  /**
   * Keeps at most one whole-document attachment per (session, document
   * revision), the oldest one, so identity survives and citations that already
   * reference it stay valid. Each revision is collapsed on its own and every
   * other context kind is left exactly as stored.
   */
  private collapseEntireDocumentDuplicates(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM chat_context_items
       WHERE session_id = ? AND kind = 'entire_document'
         AND id <> (
           SELECT keep.id FROM chat_context_items AS keep
            WHERE keep.session_id = chat_context_items.session_id
              AND keep.kind = 'entire_document'
              AND keep.document_hash = chat_context_items.document_hash
            ORDER BY keep.created_at ASC, keep.id ASC
            LIMIT 1
         )
    `).run(sessionId);
  }

  removeContext(sessionId: string, contextItemId: string): void {
    const result = this.db.prepare(
      'DELETE FROM chat_context_items WHERE id = ? AND session_id = ?'
    ).run(contextItemId, sessionId);
    if (result.changes === 0) throw new InterleafError('validation', 'Chat context item was not found.');
  }

  /**
   * The document sources earlier accepted turns in this session were actually
   * sent, most recent first.
   *
   * These are stored snapshots, not live context items, and only the ones no
   * attachment ever owned: attached context persists, so the live item supplies
   * its own passage and a removed item must not come back through here. Only
   * snapshots matching the session's current document revision are returned, so
   * a document that changed under the conversation cannot replay text that no
   * longer exists in it, and each distinct excerpt is returned once even when
   * several turns cited it.
   */
  listRecentTurnSources(sessionId: string, limit: number): readonly StoredTurnSource[] {
    this.requireSession(sessionId);
    const boundedLimit = Math.max(0, Math.min(200, Math.trunc(limit)));
    if (boundedLimit === 0) return [];
    // SQLite owns the replay: recency order, one row per distinct source
    // (by chunk, else by excerpt hash), and the hard limit are all applied
    // inside the query, so no read path materialises a session's whole
    // source history to trim it in JavaScript.
    const rows = this.db.prepare(`
      SELECT document_id, document_hash, chunk_id, context_item_id, location_json,
             excerpt_text, excerpt_hash, heading, page_label, display_label,
             message_ordinal, source_ordinal
        FROM (
          SELECT s.document_id AS document_id, s.document_hash AS document_hash,
                 s.chunk_id AS chunk_id, s.context_item_id AS context_item_id,
                 s.location_json AS location_json, s.excerpt_text AS excerpt_text,
                 s.excerpt_hash AS excerpt_hash, s.heading AS heading,
                 s.page_label AS page_label, s.display_label AS display_label,
                 m.ordinal AS message_ordinal, s.ordinal AS source_ordinal,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(s.chunk_id, 'hash:' || s.excerpt_hash)
                   ORDER BY m.ordinal DESC, s.ordinal ASC
                 ) AS source_rank
            FROM chat_message_sources s
            JOIN chat_messages m ON m.id = s.message_id
            JOIN chat_sessions cs ON cs.id = m.session_id
            JOIN documents d ON d.id = cs.document_id
           WHERE cs.id = ?
             AND cs.document_hash = d.file_hash
             AND s.document_id = cs.document_id
             AND s.document_hash = cs.document_hash
             AND s.attached_origin = 0
        )
       WHERE source_rank = 1
       ORDER BY message_ordinal DESC, source_ordinal ASC
       LIMIT ?
    `).all(sessionId, boundedLimit) as TurnSourceRow[];
    return mapTurnSourceRows(rows);
  }

  beginTurn(
    sessionId: string,
    requestId: string,
    content: string,
    sources: readonly ChatSourceEnvelopeItem[],
    disclosures?: readonly ChatContextDisclosure[]
  ): BegunChatTurn {
    if (content.trim().length === 0 || content.length > 100_000) {
      throw new InterleafError('validation', 'Chat message text is invalid.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.requireActiveSession(sessionId);
      const active = this.db.prepare(`
        SELECT 1 AS active FROM chat_messages
         WHERE session_id = ? AND status = 'streaming' LIMIT 1
      `).get(sessionId);
      if (active) throw new InterleafError('validation', 'This chat is already generating a response.');
      for (const source of sources) {
        if (source.documentId !== session.document_id || source.documentHash !== session.document_hash) {
          throw new InterleafError('validation', 'A context source does not match the chat document revision.');
        }
      }
      const ordinalRow = this.db.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
          FROM chat_messages WHERE session_id = ?
      `).get(sessionId) as { next_ordinal: number };
      const userId = randomUUID();
      const assistantId = randomUUID();
      const insert = this.db.prepare(`
        INSERT INTO chat_messages (
          id, session_id, role, ordinal, content, citation_json, disclosures_json, status,
          request_id, token_count, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, NULL, NULL,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `);
      const disclosuresJson = disclosures && disclosures.length > 0
        ? JSON.stringify(disclosures)
        : null;
      insert.run(userId, sessionId, 'user', ordinalRow.next_ordinal, content.trim(), null, 'complete', null);
      insert.run(assistantId, sessionId, 'assistant', ordinalRow.next_ordinal + 1, '', disclosuresJson, 'streaming', requestId);
      const insertSource = this.db.prepare(`
        INSERT INTO chat_message_sources (
          message_id, source_id, ordinal, document_id, document_hash, chunk_id,
          context_item_id, location_json, excerpt_text, excerpt_hash, heading,
          page_label, display_label, attached_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [ordinal, source] of sources.entries()) {
        insertSource.run(
          assistantId,
          source.sourceId,
          ordinal,
          source.documentId,
          source.documentHash,
          source.chunkId,
          source.contextItemId,
          JSON.stringify(source.location),
          source.excerptText,
          source.excerptHash,
          source.heading,
          source.pageLabel,
          source.label,
          attachedOriginFlag(source.contextItemId)
        );
      }
      this.touchSession(sessionId);
      const userMessage = this.requireMessage(userId);
      const assistantMessage = this.requireMessage(assistantId);
      this.db.exec('COMMIT');
      return { userMessage, assistantMessage };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finalizeAssistant(input: {
    readonly messageId: string;
    readonly requestId: string;
    readonly content: string;
    readonly citations: readonly ChatCitation[];
    readonly disclosures?: readonly ChatContextDisclosure[] | undefined;
    /** Provider search metadata; stored beside the answer, never inside it. */
    readonly webSources?: readonly ChatWebSource[] | undefined;
    readonly status: Exclude<ChatMessageStatus, 'streaming'>;
    readonly tokenCount?: number | null | undefined;
    readonly errorMessage?: string | null | undefined;
  }): ChatMessage {
    if (input.content.length > CHAT_RESPONSE_MAX_TEXT_UNITS) {
      throw new InterleafError('validation', 'AI response exceeded the safe storage limit.');
    }
    const disclosuresJson = input.disclosures !== undefined
      ? (input.disclosures.length > 0 ? JSON.stringify(input.disclosures) : null)
      : undefined;
    const webSourcesJson = serializeWebSources(input.webSources);
    const result = disclosuresJson !== undefined
      ? this.db.prepare(`
          UPDATE chat_messages
             SET content = ?, citation_json = ?, disclosures_json = ?, web_sources_json = ?, status = ?, token_count = ?, error_message = ?
           WHERE id = ? AND request_id = ? AND status = 'streaming'
        `).run(
          input.content,
          JSON.stringify(input.citations),
          disclosuresJson,
          webSourcesJson,
          input.status,
          input.tokenCount ?? null,
          input.errorMessage ?? null,
          input.messageId,
          input.requestId
        )
      : this.db.prepare(`
          UPDATE chat_messages
             SET content = ?, citation_json = ?, web_sources_json = ?, status = ?, token_count = ?, error_message = ?
           WHERE id = ? AND request_id = ? AND status = 'streaming'
        `).run(
          input.content,
          JSON.stringify(input.citations),
          webSourcesJson,
          input.status,
          input.tokenCount ?? null,
          input.errorMessage ?? null,
          input.messageId,
          input.requestId
        );
    if (result.changes === 0) {
      const existing = this.requireMessage(input.messageId);
      if (existing.requestId === input.requestId && existing.status !== 'streaming') return existing;
      throw new InterleafError('validation', 'The chat request is no longer active.');
    }
    const message = this.requireMessage(input.messageId);
    this.touchSession(message.sessionId);
    return message;
  }

  resolveCitation(sessionId: string, messageId: string, sourceId: string): CitationTarget | null {
    const row = this.db.prepare(`
      SELECT s.document_id, s.document_hash, s.source_id, s.display_label, s.location_json
        FROM chat_message_sources s
        JOIN chat_messages m ON m.id = s.message_id
        JOIN chat_sessions cs ON cs.id = m.session_id
        JOIN documents d ON d.id = s.document_id
       WHERE cs.id = ? AND m.id = ? AND m.role = 'assistant' AND s.source_id = ?
         AND cs.document_id = s.document_id
         AND cs.document_hash = d.file_hash
         AND s.document_hash = d.file_hash
         AND (
           s.chunk_id IS NULL OR EXISTS (
             SELECT 1
               FROM document_text_chunks c
               JOIN document_index_state i ON i.document_id = c.document_id
              WHERE c.id = s.chunk_id
                AND c.document_id = s.document_id
                AND i.published_document_hash = s.document_hash
           )
         )
    `).get(sessionId, messageId, sourceId) as {
      document_id: string;
      document_hash: string;
      source_id: string;
      display_label: string;
      location_json: string;
    } | undefined;
    if (!row) return null;
    let rawLocation: PortableValue;
    try {
      rawLocation = parsePortableJson(row.location_json);
    } catch {
      return null;
    }
    const location = parseDocumentLocation(rawLocation);
    if (!location) return null;
    return {
      documentId: row.document_id,
      documentHash: row.document_hash,
      sourceId: row.source_id,
      label: row.display_label,
      location,
    };
  }

  resolveCitationForMessage(
    messageId: string,
    sourceId: string
  ): { readonly label: string; readonly pageLabel: string | null; readonly heading: string | null } | null {
    const row = this.db.prepare(`
      SELECT display_label, page_label, heading
        FROM chat_message_sources
       WHERE message_id = ? AND source_id = ?
    `).get(messageId, sourceId) as {
      display_label: string;
      page_label: string | null;
      heading: string | null;
    } | undefined;
    return row
      ? { label: row.display_label, pageLabel: row.page_label, heading: row.heading }
      : null;
  }

  private requireDocument(documentId: string): { readonly file_hash: string } {
    const row = this.db.prepare('SELECT file_hash FROM documents WHERE id = ?').get(documentId) as
      | { file_hash: string }
      | undefined;
    if (!row) throw new InterleafError('validation', 'Document was not found.');
    return row;
  }

  private selectSession() {
    return this.db.prepare(`
      SELECT s.*,${SESSION_SUMMARY_COLUMNS},
             d.file_hash AS current_document_hash
        FROM chat_sessions s
        JOIN documents d ON d.id = s.document_id
       WHERE s.id = ?
    `);
  }
  private requireSession(sessionId: string): ChatSession {
    const session = this.getSession(sessionId);
    if (!session) throw new InterleafError('validation', 'Chat session was not found.');
    return session;
  }

  private requireMessage(messageId: string): ChatMessage {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    if (!row) throw new InterleafError('internal', 'Stored chat message was not found.');
    return mapMessage(row);
  }

  private touchSession(sessionId: string): void {
    this.db.prepare(`
      UPDATE chat_sessions
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
    `).run(sessionId);
  }
}
