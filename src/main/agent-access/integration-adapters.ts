import { InterleafError } from '@shared/errors/interleaf-error';
import type { AgentSource } from '@shared/schemas/agent-access';
import type { LearningContent, LearningSource } from '@shared/schemas/learning';
import type { InterleafDatabase } from '../db/database';
import type { ExternalHighlightRepository } from '../db/repositories/external-highlight-repository';
import type { LearningRepository } from '../db/repositories/learning-repository';
import type { ImportedPracticeResolver, VerifiedPassageResolver, PracticeRepository } from '../practice/repository';
import type { ProposalAcceptHandlers } from './proposal-repository';
import { sourceMatchesChunk } from './source-validation';

/** Resolve only from the currently published index of the claimed revision. */
export function indexedPracticeResolver(database: InterleafDatabase): VerifiedPassageResolver {
  return (source, chunkId) => {
    const row = database.raw.prepare(`SELECT d.title, d.format, c.text, c.location_json FROM documents d
      JOIN document_index_state s ON s.document_id = d.id
      JOIN document_text_chunks c ON c.document_id = d.id
      WHERE d.id = ? AND d.file_hash = ? AND s.published_document_hash = d.file_hash AND c.id = ?`)
      .get(source.documentId, source.documentHash, chunkId) as { title: string; format: string; text: string; location_json: string } | undefined;
    const candidate: AgentSource = { documentId: source.documentId, documentHash: source.documentHash, chunkId, anchor: source.anchor };
    if (row?.format !== source.anchor.format || !sourceMatchesChunk(candidate, row.location_json, row.text)) return null;
    return { evidence: source.anchor.quote.exact, label: row.title.slice(0, 500) };
  };
}

/** Imported evidence stays an export even when a user associated a book. */
export function importedPracticeResolver(repository: ExternalHighlightRepository): ImportedPracticeResolver {
  return (id) => {
    const record = repository.resolveSource(id);
    if (!record) return null;
    return { evidence: record.quote, label: `${record.provider === 'kindle' ? 'Kindle' : 'Readwise'}: ${record.title}${record.author ? ` — ${record.author}` : ''}`,
      details: { provider: record.provider, title: record.title, author: record.author, location: record.location, date: record.date, note: record.note }, native: repository.resolveNativeSource(id) };
  };
}

function learningSource(source: AgentSource): LearningSource {
  return { documentId: source.documentId, documentHash: source.documentHash, anchor: source.anchor };
}

/** Called from ProposalRepository's existing transaction; never starts another. */
export function proposalIntegrationHandlers(database: InterleafDatabase, learning: LearningRepository, practice: PracticeRepository): Pick<ProposalAcceptHandlers, 'learning' | 'card' | 'verifyAccepted'> {
  return {
    verifyAccepted: (proposal) => {
      if (!proposal.resultId) return false;
      if (proposal.input.kind === 'annotation') return database.raw.prepare('SELECT 1 FROM annotations WHERE id = ? AND document_id = ?').get(proposal.resultId, proposal.input.source.documentId) !== undefined;
      if (proposal.input.kind === 'card') return database.raw.prepare('SELECT 1 FROM practice_cards WHERE id = ? AND idempotency_key = ?').get(proposal.resultId, proposal.id) !== undefined;
      return database.raw.prepare("SELECT 1 FROM learning_items WHERE id = ? AND proposal_id = ? AND status != 'removed'").get(proposal.resultId, proposal.id) !== undefined;
    },
    learning: (input, context) => {
      const common = { title: input.kind === 'question' ? 'Question' : input.kind === 'checkpoint' ? 'Checkpoint' : input.kind === 'conflict' ? 'Compare passages' : 'Primer',
        body: input.text, primary: learningSource(input.source) };
      const content: LearningContent = input.kind === 'conflict'
        ? { ...common, kind: 'conflict', secondary: learningSource(input.secondSource) }
        : { ...common, kind: input.kind };
      const item = learning.acceptProposal(context.proposalId, content);
      if (!item) throw new InterleafError('validation', 'The accepted learning item was removed.');
      return item.id;
    },
    card: (input, context) => practice.acceptVerifiedPassage({ question: input.text, chunkId: input.source.chunkId, idempotencyKey: context.proposalId,
      source: { kind: 'native', documentId: input.source.documentId, documentHash: input.source.documentHash, anchor: input.source.anchor, annotationId: null } }).id,
  };
}
