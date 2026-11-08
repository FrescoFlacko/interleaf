import { z } from 'zod';
import { agentProposalInputSchema } from '@shared/schemas/agent-access';
import { annotationInput, documentInput, historyInput, passageInput, searchInput, type LibraryReader } from './library-reader';
import type { ProposalRepository } from './proposal-repository';
import { makePassageLink } from './passage-link';
import type { PortableValue } from '@shared/models/portable';

const definitions = [
  { name: 'search_library', description: 'Search the published library index and report index coverage.', schema: searchInput },
  { name: 'get_passage', description: 'Read a bounded indexed passage for a document revision.', schema: passageInput },
  { name: 'get_annotations', description: 'List bounded annotations on a document.', schema: annotationInput },
  { name: 'get_reading_position', description: 'Get the most recent reading position.', schema: documentInput },
  { name: 'get_reading_history', description: 'Get prospective reading events; earlier history is unavailable.', schema: historyInput },
  { name: 'submit_proposal', description: 'Submit an inert proposal for local user review, when enabled.', schema: agentProposalInputSchema },
] as const;

export class McpTools {
  constructor(private readonly reader: LibraryReader, private readonly proposals: ProposalRepository,
    private readonly proposalsEnabled: () => boolean,
    private readonly proposalGeneration: () => number,
    private readonly sourceHealthy: (documentId: string, documentHash: string) => Promise<boolean>,
    private readonly isOpen: () => boolean) {}

  list() {
    return definitions.filter((entry) => entry.name !== 'submit_proposal' || this.proposalsEnabled())
      .map((entry) => ({ name: entry.name, description: entry.description, inputSchema: { type: 'object', ...z.toJSONSchema(entry.schema) } }));
  }

  async call(name: string, args: PortableValue) {
    switch (name) {
      case 'search_library': {
        const input = searchInput.parse(args);
        const result = this.reader.searchLibrary(input);
        return { ...result, hits: result.hits.map((hit) => ({ ...hit,
          link: makePassageLink({ documentId: hit.documentId, documentHash: hit.documentHash, chunkId: hit.chunkId, query: input.query }) })) };
      }
      case 'get_passage': {
        const input = passageInput.parse(args);
        if (!(await this.sourceHealthy(input.documentId, input.documentHash)) || !this.isOpen()) throw new Error('Source is unavailable.');
        return this.reader.getPassage(input);
      }
      case 'get_annotations': return this.reader.getAnnotations(annotationInput.parse(args));
      case 'get_reading_position': return this.reader.getReadingPosition(documentInput.parse(args));
      case 'get_reading_history': return this.reader.getReadingHistory(historyInput.parse(args));
      case 'submit_proposal': {
        if (!this.proposalsEnabled()) throw new Error('Proposal submission is disabled.');
        const generation = this.proposalGeneration();
        const input = agentProposalInputSchema.parse(args);
        const sources = input.kind === 'conflict' ? [input.source, input.secondSource] : [input.source];
        for (const source of sources) {
          if (!(await this.sourceHealthy(source.documentId, source.documentHash)) || !this.isOpen() || !this.proposalsEnabled() || this.proposalGeneration() !== generation) throw new Error('Source is unavailable.');
        }
        return this.proposals.submit(input);
      }
      default: throw new Error('Unknown tool.');
    }
  }
}
