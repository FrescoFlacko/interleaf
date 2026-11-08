import { randomUUID } from 'node:crypto';
import type { InterleafDatabase } from '../db/database';
import { InterleafError } from '@shared/errors/interleaf-error';
import { agentProposalInputSchema, type AgentProposalInput, type AgentSource } from '@shared/schemas/agent-access';
import { parsePortableJson } from '@shared/models/portable';
import { sourceMatchesChunk } from './source-validation';

export type Proposal = {
  readonly id: string;
  readonly input: AgentProposalInput;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resultId: string | null;
};
type Row = {
  id: string; payload_json: string; status: Proposal['status']; created_at: string;
  resolved_at: string | null; result_id: string | null;
};
/** All handlers run synchronously in the same main-owned SQLite transaction. */
type ProposalContext = { readonly proposalId: string };
export type ProposalAcceptHandlers = {
  readonly annotation: (input: Extract<AgentProposalInput, { kind: 'annotation' }>, context: ProposalContext) => string;
  readonly learning?: (input: Extract<AgentProposalInput, { kind: 'primer' | 'question' | 'checkpoint' | 'conflict' }>, context: ProposalContext) => string;
  readonly card?: (input: Extract<AgentProposalInput, { kind: 'card' }>, context: ProposalContext) => string;
};

function map(row: Row): Proposal {
  return { id: row.id, input: agentProposalInputSchema.parse(parsePortableJson(row.payload_json)),
    status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at, resultId: row.result_id };
}

export class ProposalRepository {
  constructor(private readonly database: InterleafDatabase, private readonly handlers: ProposalAcceptHandlers) {}

  validateSource(source: AgentSource): void {
    const row = this.database.raw.prepare(`SELECT d.format, c.text, c.location_json FROM documents d
      JOIN document_index_state s ON s.document_id = d.id
      JOIN document_text_chunks c ON c.document_id = d.id
      WHERE d.id = ? AND d.file_hash = ? AND s.published_document_hash = d.file_hash AND c.id = ?`)
      .get(source.documentId, source.documentHash, source.chunkId) as { format: string; text: string; location_json: string } | undefined;
    if (row?.format !== source.anchor.format || !sourceMatchesChunk(source, row.location_json, row.text)) {
      throw new InterleafError('validation', 'Source is unavailable, stale, or does not contain the quoted text.');
    }
  }

  submit(input: AgentProposalInput): Proposal {
    const proposal = agentProposalInputSchema.parse(input);
    const pending = this.database.raw.prepare("SELECT COUNT(*) AS count FROM agent_proposals WHERE status = 'pending'").get() as { count: number };
    if (pending.count >= 1000) throw new InterleafError('validation', 'Proposal inbox is full.');
    this.validateSource(proposal.source);
    if (proposal.kind === 'conflict') this.validateSource(proposal.secondSource);
    const id = randomUUID();
    const row = this.database.raw.prepare(`INSERT INTO agent_proposals
      (id, document_id, document_hash, kind, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
      .get(id, proposal.source.documentId, proposal.source.documentHash, proposal.kind, JSON.stringify(proposal)) as Row;
    return map(row);
  }

  canAccept(kind: AgentProposalInput['kind']): boolean {
    if (kind === 'annotation') return true;
    return kind === 'card' ? this.handlers.card !== undefined : this.handlers.learning !== undefined;
  }

  sourceTitle(documentId: string): string {
    const row = this.database.raw.prepare('SELECT title FROM documents WHERE id = ?').get(documentId) as { title: string } | undefined;
    return row?.title.slice(0, 200) ?? 'Document unavailable';
  }

  list(): readonly Proposal[] {
    return (this.database.raw.prepare("SELECT * FROM agent_proposals WHERE status = 'pending' ORDER BY created_at, id LIMIT 100")
      .all() as Row[]).map(map);
  }

  resolve(id: string, action: 'accept' | 'reject'): Proposal {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new InterleafError('validation', 'Invalid proposal identifier.');
    const db = this.database.raw;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id) as Row | undefined;
      if (!row) throw new InterleafError('validation', 'Proposal not found.');
      const proposal = map(row);
      if (proposal.status !== 'pending') {
        if (proposal.status !== (action === 'accept' ? 'accepted' : 'rejected')) throw new InterleafError('validation', 'Proposal has already been resolved.');
        db.exec('COMMIT');
        return proposal;
      }
      let resultId: string | null = null;
      if (action === 'accept') {
        this.validateSource(proposal.input.source);
        if (proposal.input.kind === 'conflict') this.validateSource(proposal.input.secondSource);
        if (proposal.input.kind === 'annotation') resultId = this.handlers.annotation(proposal.input, { proposalId: proposal.id });
        else if (proposal.input.kind === 'card') {
          if (!this.handlers.card) throw new InterleafError('validation', 'Card acceptance is not available yet.');
          resultId = this.handlers.card(proposal.input, { proposalId: proposal.id });
        } else {
          if (!this.handlers.learning) throw new InterleafError('validation', 'Learning item acceptance is not available yet.');
          resultId = this.handlers.learning(proposal.input, { proposalId: proposal.id });
        }
      }
      const updated = db.prepare(`UPDATE agent_proposals SET status = ?, result_id = ?,
        resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending' RETURNING *`)
        .get(action === 'accept' ? 'accepted' : 'rejected', resultId, id) as Row;
      db.exec('COMMIT');
      return map(updated);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
