import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import { appendDocumentIndexRequestSchema, searchRequestSchema } from '@shared/schemas/search';

const chunk = {
  ordinal: 0,
  text: 'bounded searchable text',
  location: { format: 'pdf', pageIndex: 0 },
  heading: null,
  pageLabel: '1',
} as const;

describe('search contracts', () => {
  it('requires document scope only on document search', () => {
    expect(ipcRequestSchemas[IPC.searchDocument].safeParse({ query: 'term' }).success).toBe(false);
    expect(ipcRequestSchemas[IPC.searchDocument].safeParse({ documentId: 'doc', query: 'term' }).success).toBe(true);
    expect('search:library' in ipcRequestSchemas).toBe(false);
  });

  it('strictly bounds batches, chunk text, query text, and generation identifiers', () => {
    const valid = {
      documentId: 'doc',
      documentHash: 'hash',
      generationId: '123e4567-e89b-42d3-a456-426614174000',
      chunks: [chunk],
    };
    expect(appendDocumentIndexRequestSchema.safeParse(valid).success).toBe(true);
    expect(appendDocumentIndexRequestSchema.safeParse({ ...valid, chunks: Array.from({ length: 26 }, () => chunk) }).success).toBe(false);
    expect(appendDocumentIndexRequestSchema.safeParse({
      ...valid,
      chunks: [{ ...chunk, text: 'x'.repeat(256_001) }],
    }).success).toBe(false);
    expect(appendDocumentIndexRequestSchema.safeParse({ ...valid, generationId: 'renderer-chosen-id' }).success).toBe(false);
    expect(appendDocumentIndexRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ query: 'term', limit: 101 }).success).toBe(false);
  });
});
