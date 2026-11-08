import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parsePortableJson } from '@shared/models/portable';
import { learningContentSchema, type LearningContent, type LearningItem, type LearningSource, type LearningSourceStatus } from '@shared/schemas/learning';
import type { InterleafDatabase } from '../database';

type Row = {
  id: string;
  content_json: string;
  content_hash: string;
  proposal_id: string | null;
  status: 'active' | 'dismissed' | 'removed';
  created_at: string;
  updated_at: string;
};

function item(row: Row): LearningItem {
  if (row.status === 'removed') throw new InterleafError('validation', 'This learning item was removed.');
  return {
    id: row.id,
    content: learningContentSchema.parse(parsePortableJson(row.content_json)),
    provenance: row.proposal_id === null ? { kind: 'manual' } : { kind: 'proposal', proposalId: row.proposal_id },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Main-owned operations; acceptProposal does not start a transaction so an inbox can call it within its own. */
export class LearningRepository {
  private readonly db: DatabaseSync;
  constructor(database: InterleafDatabase) { this.db = database.raw; }

  sourceStatus(source: LearningSource): LearningSourceStatus {
    const row = this.db.prepare('SELECT file_hash, format, title FROM documents WHERE id = ?').get(source.documentId) as
      { file_hash: string; format: string; title: string } | undefined;
    if (!row) return { status: 'missing', title: null };
    return { status: row.file_hash === source.documentHash && row.format === source.anchor.format ? 'current' : 'stale', title: row.title.slice(0, 500) };
  }

  private validateSource(source: LearningSource): void {
    if (this.sourceStatus(source).status !== 'current') {
      throw new InterleafError('validation', 'The source document is missing or has changed.');
    }
  }

  private insert(content: LearningContent, proposalId: string | null): LearningItem {
    const parsed = learningContentSchema.parse(content);
    const count = this.db.prepare("SELECT count(*) AS total FROM learning_items WHERE document_id = ? AND status != 'removed'").get(parsed.primary.documentId) as { total: number };
    if (count.total >= 250) throw new InterleafError('validation', 'This document has reached the learning item limit.');
    this.validateSource(parsed.primary);
    if (parsed.kind === 'conflict') this.validateSource(parsed.secondary);
    const serialized = JSON.stringify(parsed);
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    const row = this.db.prepare(`INSERT INTO learning_items
      (id, document_id, content_json, content_hash, proposal_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      RETURNING *`).get(randomUUID(), parsed.primary.documentId, serialized, fingerprint, proposalId) as Row | undefined;
    if (!row) throw new InterleafError('internal', 'Could not save the learning item.');
    return item(row);
  }

  create(content: LearningContent): LearningItem { return this.insert(content, null); }

  /** Only a trusted local acceptance service should invoke this, in the inbox transaction. */
  acceptProposal(proposalId: string, content: LearningContent): LearningItem | null {
    if (proposalId.length < 1 || proposalId.length > 128) throw new InterleafError('validation', 'Invalid proposal identifier.');
    const parsed = learningContentSchema.parse(content);
    const existing = this.db.prepare('SELECT * FROM learning_items WHERE proposal_id = ?').get(proposalId) as Row | undefined;
    if (existing) {
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
      if (existing.content_hash !== fingerprint) {
        throw new InterleafError('validation', 'Proposal identity already belongs to different content.');
      }
      return existing.status === 'removed' ? null : item(existing);
    }
    return this.insert(parsed, proposalId);
  }

  list(documentId: string): readonly LearningItem[] {
    const rows = this.db.prepare(`SELECT * FROM learning_items WHERE document_id = ? AND status != 'removed'
      ORDER BY created_at, id LIMIT 250`).all(documentId) as Row[];
    return rows.map(item);
  }

  dismiss(documentId: string, id: string): LearningItem | null {
    const row = this.db.prepare(`UPDATE learning_items SET status = 'dismissed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE document_id = ? AND id = ? AND status != 'removed' RETURNING *`).get(documentId, id) as Row | undefined;
    return row ? item(row) : null;
  }

  remove(documentId: string, id: string): boolean {
    const result = this.db.prepare(`UPDATE learning_items SET status = 'removed', content_json = '{}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE document_id = ? AND id = ? AND status != 'removed'`).run(documentId, id);
    return result.changes > 0;
  }
}
