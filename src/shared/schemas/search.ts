import { z } from 'zod';
import { documentLocationSchema } from './document';
import {
  SEARCH_INDEX_BATCH_MAX_CHUNKS,
  SEARCH_INDEX_BATCH_MAX_TEXT_UNITS,
} from '../constants/search';

const identifierSchema = z.string().min(1).max(128);
const documentHashSchema = z.string().min(1).max(256);
const generationSchema = z.uuid();

export const searchIndexChunkSchema = z.object({
  ordinal: z.number().int().min(0).max(10_000_000),
  text: z.string().min(1).max(256_000),
  location: documentLocationSchema,
  heading: z.string().max(2_000).nullable(),
  pageLabel: z.string().max(256).nullable(),
}).strict();

export const beginDocumentIndexRequestSchema = z.object({
  documentId: identifierSchema,
  documentHash: documentHashSchema,
}).strict();

export const appendDocumentIndexRequestSchema = z.object({
  documentId: identifierSchema,
  documentHash: documentHashSchema,
  generationId: generationSchema,
  chunks: z.array(searchIndexChunkSchema).min(1).max(SEARCH_INDEX_BATCH_MAX_CHUNKS),
}).strict().superRefine((value, context) => {
  const textUnits = value.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  if (textUnits > SEARCH_INDEX_BATCH_MAX_TEXT_UNITS) {
    context.addIssue({ code: 'custom', message: 'Index batch text exceeds the bounded request size.', path: ['chunks'] });
  }
});

export const finishDocumentIndexRequestSchema = z.object({
  documentId: identifierSchema,
  documentHash: documentHashSchema,
  generationId: generationSchema,
}).strict();

export const failDocumentIndexRequestSchema = finishDocumentIndexRequestSchema.extend({
  errorMessage: z.string().min(1).max(1_000),
}).strict();

export const getDocumentIndexStateRequestSchema = z.object({ documentId: identifierSchema }).strict();

export const resolveSearchHitRequestSchema = z.object({
  documentId: identifierSchema,
  documentHash: documentHashSchema,
  chunkId: z.string().min(1).max(256),
  query: z.string().trim().min(1).max(200),
}).strict();

export const searchRequestSchema = z.object({
  documentId: identifierSchema.optional(),
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
