import { z } from 'zod';
import { documentAnchorSchema } from './annotation';
import { aiProviderIdSchema, modelIdSchema } from './ai';

const id = z.string().min(1).max(128);
const question = z.string().trim().min(1).max(2000);
const practiceRatingSchema = z.enum(['again', 'hard', 'good', 'easy']);
export const nativePracticeSourceSchema = z.object({
  kind: z.literal('native'), documentId: id, documentHash: z.string().min(1).max(128),
  anchor: documentAnchorSchema, annotationId: id.nullable(), chunkId: id.nullable().optional(),
}).strict();
const importedPracticeSourceSchema = z.object({ kind: z.literal('imported'), importedHighlightId: id }).strict();
export const practiceSourceSchema = z.discriminatedUnion('kind', [nativePracticeSourceSchema, importedPracticeSourceSchema]);
export const practiceCreateSchema = z.object({ documentId: id, annotationId: id, question }).strict();
export const practiceCreateImportedSchema = z.object({ importedHighlightId: id, question }).strict();
export const practiceDueSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict();
export const practiceRateSchema = z.object({ cardId: id, revision: z.number().int().nonnegative(), rating: practiceRatingSchema }).strict();
export const practiceCardIdSchema = z.object({ cardId: id }).strict();
const exportedDetailsSchema = z.object({ provider: z.enum(['kindle', 'readwise']), title: z.string().max(250), author: z.string().max(150).nullable(), location: z.string().max(32000).nullable(), date: z.string().max(32000).nullable(), note: z.string().max(32000).nullable() }).strict();
export type PracticeExportDetails = z.output<typeof exportedDetailsSchema>;
export const practiceCardSchema = z.object({
  id, question, source: practiceSourceSchema, evidence: z.string().min(1).max(20000),
  sourceLabel: z.string().max(500), exportDetails: exportedDetailsSchema.nullable(), navigation: nativePracticeSourceSchema.nullable(), dueAt: z.string(), intervalDays: z.number().nonnegative(),
  repetitions: z.number().int().nonnegative(), lapses: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  sourceState: z.enum(['available', 'missing', 'changed', 'unanchored', 'export-only']),
}).strict();
export type PracticeCard = z.output<typeof practiceCardSchema>;
export type PracticeSource = z.output<typeof practiceSourceSchema>;
export type PracticeRating = z.output<typeof practiceRatingSchema>;

export const practiceCheckSchema = z.object({ cardId: id, answer: z.string().trim().min(1).max(4000), providerId: aiProviderIdSchema, modelId: modelIdSchema }).strict();
