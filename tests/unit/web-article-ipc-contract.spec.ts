import { describe, expect, test } from 'vitest';
import { ipcRequestSchemas } from '../../src/shared/schemas/ipc';
import { IPC } from '../../src/shared/constants/ipc';

describe('IPC Web Article Contract Schemas', () => {
  test('validates the web article import payload and rejects invalid inputs', () => {
    const schema = ipcRequestSchemas[IPC.libraryImportWebArticle];
    expect(schema).toBeDefined();

    const validPayload = {
      url: 'https://example.com/article',
      options: { folderId: 'f1' },
    };
    const parsed = schema.safeParse(validPayload);
    expect(parsed.success).toBe(true);

    // Rejects missing/empty URL
    expect(schema.safeParse({ url: '' }).success).toBe(false);
    expect(schema.safeParse({ url: '   ' }).success).toBe(false);

    // Rejects non-HTTP schemes
    expect(schema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(schema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(schema.safeParse({ url: 'data:text/html,test' }).success).toBe(false);

    // Rejects oversized URLs
    expect(schema.safeParse({ url: `https://example.com/${'a'.repeat(2100)}` }).success).toBe(false);

    // Rejects unknown fields
    expect(
      schema.safeParse({
        ...validPayload,
        unexpected: 'property',
      }).success
    ).toBe(false);
  });
});
