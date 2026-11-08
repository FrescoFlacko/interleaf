import { z } from 'zod';
import { documentAnchorSchema } from './annotation';

const id = z.string().min(1).max(128);
const revision = z.string().min(1).max(256);
const agentSourceSchema = z.object({
  documentId: id,
  documentHash: revision,
  chunkId: id,
  anchor: documentAnchorSchema,
}).strict().refine((source) => source.anchor.quote.exact.length > 0 && source.anchor.quote.exact.length <= 4_000 && JSON.stringify(source).length <= 16_000, 'Source must be bounded with a non-empty quote.');
const base = {
  source: agentSourceSchema,
  text: z.string().trim().min(1).max(4_000),
};
export const agentProposalInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('annotation'), ...base }).strict(),
  z.object({ kind: z.literal('primer'), ...base }).strict(),
  z.object({ kind: z.literal('question'), ...base }).strict(),
  z.object({ kind: z.literal('checkpoint'), ...base }).strict(),
  z.object({ kind: z.literal('conflict'), ...base, secondSource: agentSourceSchema }).strict(),
  z.object({ kind: z.literal('card'), ...base, text: z.string().trim().min(1).max(2_000) }).strict(),
]);
export type AgentSource = z.output<typeof agentSourceSchema>;
export type AgentProposalInput = z.output<typeof agentProposalInputSchema>;
