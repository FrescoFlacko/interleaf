import { describe, expect, test } from 'vitest';
import { ipcRequestSchemas } from '../../src/shared/schemas/ipc';
import {
  closeDocumentRequestSchema,
  openDocumentRequestSchema,
  storageHealthSchema,
  storageHealthUpdateSchema,
} from '../../src/shared/schemas/document';
import { IPC } from '../../src/shared/constants/ipc';

describe('IPC Library Contract Schemas', () => {
  test('validates open and close document requests and wires them to the dispatcher contract map', () => {
    const parsed = openDocumentRequestSchema.safeParse({ id: 'doc-uuid-12345' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe('doc-uuid-12345');
    }
    expect(openDocumentRequestSchema.safeParse({}).success).toBe(false);
    expect(openDocumentRequestSchema.safeParse({ id: '' }).success).toBe(false);
    expect(openDocumentRequestSchema.safeParse({ id: 123 }).success).toBe(false);
    expect(openDocumentRequestSchema.safeParse({ id: 'doc-123', extraField: 'evil' }).success).toBe(false);

    expect(closeDocumentRequestSchema.safeParse({ id: 'doc-close-1' }).success).toBe(true);
    expect(closeDocumentRequestSchema.safeParse({ id: '' }).success).toBe(false);
    expect(closeDocumentRequestSchema.safeParse({}).success).toBe(false);

    expect(ipcRequestSchemas[IPC.libraryOpenDocument]).toBe(openDocumentRequestSchema);
    expect(ipcRequestSchemas[IPC.libraryCloseDocument]).toBe(closeDocumentRequestSchema);
  });

  test('validates the preload-internal dropped-file import payload', () => {
    const schema = ipcRequestSchemas[IPC.libraryImportDroppedFiles];
    expect(schema).toBeDefined();

    const validPayload = {
      filePaths: ['/path/to/book.pdf', '/path/to/paper.epub'],
      options: { storageMode: 'managed', folderId: 'f1' },
    };
    const parsed = schema.safeParse(validPayload);
    expect(parsed.success).toBe(true);

    // Rejects empty filePaths array
    const emptyPayload = { filePaths: [] };
    expect(schema.safeParse(emptyPayload).success).toBe(false);
    expect(
      schema.safeParse({ filePaths: Array.from({ length: 33 }, (_, index) => `/book-${String(index)}.pdf`) }).success
    ).toBe(false);
    expect(schema.safeParse({ filePaths: ['x'.repeat(4097)] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...validPayload,
        destinationPath: '/unexpected/export',
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        ...validPayload,
        options: { ...validPayload.options, sourcePath: '/unexpected/source' },
      }).success
    ).toBe(false);
  });

  test('validates valid library:create-folder payload and rejects invalid names', () => {
    const schema = ipcRequestSchemas[IPC.libraryCreateFolder];
    expect(schema).toBeDefined();

    expect(schema.safeParse({ name: 'Valid Folder', parentId: null }).success).toBe(true);
    expect(schema.safeParse({ name: 'Valid Folder' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Valid Folder', parentId: 'parent-123' }).success).toBe(true);

    // Rejects empty string or whitespace-only
    expect(schema.safeParse({ name: '', parentId: null }).success).toBe(false);
    expect(schema.safeParse({ name: '   ', parentId: null }).success).toBe(false);
    expect(schema.safeParse({ name: 'Valid Folder', parentId: null, sql: 'DROP TABLE folders' }).success).toBe(false);
  });

  test('validates valid library:update-reading-position and rejects invalid locations/progress', () => {
    const schema = ipcRequestSchemas[IPC.libraryUpdateReadingPosition];
    expect(schema).toBeDefined();

    const validPdf = {
      documentId: 'doc-1',
      location: { format: 'pdf', pageIndex: 5 },
      progress: 0.5,
    };
    expect(schema.safeParse(validPdf).success).toBe(true);
    expect(
      schema.safeParse({
        ...validPdf,
        location: { ...validPdf.location, filePath: '/unexpected/path' },
      }).success
    ).toBe(false);

    const validEpub = {
      documentId: 'doc-2',
      location: { format: 'epub', cfi: 'epubcfi(/6/4)' },
      progress: 0.25,
    };
    expect(schema.safeParse(validEpub).success).toBe(true);
    expect(
      schema.safeParse({
        ...validEpub,
        location: { format: 'epub', cfi: 'x'.repeat(8193) },
      }).success
    ).toBe(false);

    // Rejects negative progress or progress > 1
    expect(
      schema.safeParse({
        documentId: 'doc-1',
        location: { format: 'pdf', pageIndex: 0 },
        progress: -0.1,
      }).success
    ).toBe(false);

    expect(
      schema.safeParse({
        documentId: 'doc-1',
        location: { format: 'pdf', pageIndex: 0 },
        progress: 1.1,
      }).success
    ).toBe(false);

    // Rejects invalid location format
    expect(
      schema.safeParse({
        documentId: 'doc-1',
        location: { format: 'unknown_format' },
        progress: 0.5,
      }).success
    ).toBe(false);
  });

  test('validates library:list-documents filter options', () => {
    const schema = ipcRequestSchemas[IPC.libraryListDocuments];
    expect(schema).toBeDefined();

    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ format: 'pdf', storageMode: 'managed' }).success).toBe(true);
    expect(schema.safeParse({ searchQuery: 'distributed', sort: 'title_asc' }).success).toBe(true);
    expect(schema.safeParse({ offset: 0, limit: 50 }).success).toBe(true);
    expect(schema.safeParse({ offset: 100, limit: 100 }).success).toBe(true);

    // Rejects invalid format or sort
    expect(schema.safeParse({ format: 'invalid_format' }).success).toBe(false);
    expect(schema.safeParse({ sort: 'invalid_sort' }).success).toBe(false);
    expect(schema.safeParse({ destinationPath: '/unexpected/export' }).success).toBe(false);

    // Rejects unbounded or invalid pagination
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ limit: -1 }).success).toBe(false);
    expect(schema.safeParse({ offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ offset: 1.5 }).success).toBe(false);
  });

  test('validates storageHealthSchema and storageHealthUpdateSchema', () => {
    for (const health of ['ok', 'missing', 'changed', 'checking']) {
      expect(storageHealthSchema.safeParse(health).success).toBe(true);
    }
    expect(storageHealthSchema.safeParse('unknown').success).toBe(false);

    expect(
      storageHealthUpdateSchema.safeParse({
        documentId: 'doc-123',
        storageHealth: 'ok',
      }).success
    ).toBe(true);

    expect(
      storageHealthUpdateSchema.safeParse({
        documentId: 'doc-123',
        storageHealth: 'changed',
        storageHealthMessage: 'File modified on disk',
      }).success
    ).toBe(true);

    expect(
      storageHealthUpdateSchema.safeParse({
        documentId: '',
        storageHealth: 'ok',
      }).success
    ).toBe(false);

    expect(
      storageHealthUpdateSchema.safeParse({
        documentId: 'doc-123',
        storageHealth: 'invalid',
      }).success
    ).toBe(false);
  });
});
