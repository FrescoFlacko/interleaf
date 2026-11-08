import { z } from 'zod';
export const importCommitSchema = z.object({
  token: z.uuid(),
  choices: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), documentId: z.uuid().nullable() }).strict()).max(10000),
}).strict();
export const importListSchema = z.object({ offset: z.number().int().min(0).max(1000000) }).strict();
export type ImportCommitInput = z.output<typeof importCommitSchema>;

export const importAssociateSchema = z.object({ id: z.uuid(), documentId: z.uuid().nullable() }).strict();
