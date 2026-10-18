import type { DatabaseSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';

/** What one successful claim hands to the naming call, and nothing more. */
export type AutomaticTitleClaim = {
  readonly documentId: string;
  /** A bounded excerpt of the conversation's first question. */
  readonly question: string;
};

/**
 * Title ownership for automatic Reader Chat naming (migration v27).
 *
 * Every transition is one conditional statement, so a claim and a commit are
 * atomic against each other and against every other writer on this database:
 * a manual rename (even to identical text) moves the row to `manual`, deletion
 * removes it, and a document revision changes the current file hash — and each
 * of those makes a later commit match no row instead of overwriting or
 * resurrecting it.
 */
export class ChatTitleRepository {
  private readonly db: DatabaseSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    // A claim cannot survive a restart: its call is gone, and retrying could
    // bill the reader twice. The default title stays.
    this.db.prepare(`
      UPDATE chat_sessions SET title_state = 'failed', title_claim_id = NULL
       WHERE title_state = 'generating'
    `).run();
  }

  /**
   * Claims a session's one automatic title, or returns `null` when it is not
   * eligible: its title is not the untouched default, it is archived, or it does
   * not hold exactly one successfully completed answer.
   */
  claim(sessionId: string, claimId: string, maxQuestionUnits: number): AutomaticTitleClaim | null {
    const claimed = this.db.prepare(`
      UPDATE chat_sessions SET title_state = 'generating', title_claim_id = ?
       WHERE id = ? AND title_state = 'default'
         AND document_hash = (SELECT file_hash FROM documents WHERE documents.id = chat_sessions.document_id)
         AND (SELECT COUNT(*) FROM chat_messages m
               WHERE m.session_id = chat_sessions.id AND m.role = 'assistant' AND m.status = 'complete') = 1
    `).run(claimId, sessionId);
    if (claimed.changes !== 1) return null;
    const row = this.db.prepare(`
      SELECT s.document_id AS document_id, m.content AS content
        FROM chat_sessions s
        JOIN chat_messages m ON m.session_id = s.id AND m.role = 'user'
       WHERE s.id = ?
       ORDER BY m.ordinal ASC
       LIMIT 1
    `).get(sessionId) as { readonly document_id: string; readonly content: string } | undefined;
    const question = row ? boundedExcerpt(row.content, maxQuestionUnits) : '';
    if (!row || question.length === 0) {
      this.fail(sessionId, claimId);
      return null;
    }
    return { documentId: row.document_id, question };
  }

  /**
   * Stores the title only if this claim still owns the row and the session is
   * still on the document's current revision. Returns whether it was stored.
   */
  commit(sessionId: string, claimId: string, title: string): boolean {
    const result = this.db.prepare(`
      UPDATE chat_sessions SET title = ?, title_state = 'generated', title_claim_id = NULL
       WHERE id = ? AND title_state = 'generating' AND title_claim_id = ?
         AND document_hash = (SELECT file_hash FROM documents WHERE documents.id = chat_sessions.document_id)
    `).run(title, sessionId, claimId);
    return result.changes === 1;
  }

  /** Ends this claim without a title; the default title is left as it was. */
  fail(sessionId: string, claimId: string): void {
    this.db.prepare(`
      UPDATE chat_sessions SET title_state = 'failed', title_claim_id = NULL
       WHERE id = ? AND title_state = 'generating' AND title_claim_id = ?
    `).run(sessionId, claimId);
  }
}

/** The first `maxUnits` UTF-16 units, never ending on half a surrogate pair. */
function boundedExcerpt(text: string, maxUnits: number): string {
  let excerpt = text.slice(0, maxUnits);
  const last = excerpt.charCodeAt(excerpt.length - 1);
  if (excerpt.length > 0 && last >= 0xd800 && last <= 0xdbff) excerpt = excerpt.slice(0, -1);
  return excerpt.trim();
}
