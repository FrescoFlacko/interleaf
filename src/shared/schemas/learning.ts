import { z } from 'zod';
import { documentAnchorSchema } from './annotation';

const identifier = z.string().min(1).max(128);
const learningSourceSchema = z.object({
  documentId: identifier,
  documentHash: z.string().min(1).max(256),
  anchor: documentAnchorSchema,
}).strict()
  .refine((source) => source.anchor.quote.exact.length > 0, 'A source requires an exact passage.')
  .refine((source) => JSON.stringify(source.anchor).length <= 32_000, 'Source anchor exceeds the size limit.');

const common = {
  primary: learningSourceSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(12_000),
};
export const learningContentSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('primer') }).strict(),
  z.object({ ...common, kind: z.literal('question') }).strict(),
  z.object({ ...common, kind: z.literal('checkpoint') }).strict(),
  z.object({ ...common, kind: z.literal('conflict'), secondary: learningSourceSchema }).strict(),
]);
export const listLearningRequestSchema = z.object({ documentId: identifier }).strict();
export const learningSourceStatusSchema = z.object({ status: z.enum(['current', 'missing', 'stale']), title: z.string().max(500).nullable() }).strict();
export const sourceLearningRequestSchema = z.object({ documentId: identifier, source: learningSourceSchema }).strict();
export const changeLearningRequestSchema = z.object({ documentId: identifier, id: identifier }).strict();
export const learningItemSchema = z.object({
  id: identifier,
  content: learningContentSchema,
  provenance: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }).strict(),
    z.object({ kind: z.literal('proposal'), proposalId: identifier }).strict(),
  ]),
  status: z.enum(['active', 'dismissed']),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type LearningSourceStatus = z.output<typeof learningSourceStatusSchema>;
export type LearningSource = z.output<typeof learningSourceSchema>;
export type LearningContent = z.output<typeof learningContentSchema>;
export type LearningItem = z.output<typeof learningItemSchema>;
