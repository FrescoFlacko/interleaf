import { describe, expect, test, beforeEach } from 'vitest';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';

describe('ReadingPositionRepository', () => {
  let db: InterleafDatabase;
  let docRepo: DocumentRepository;
  let readingRepo: ReadingPositionRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    docRepo = new DocumentRepository(db);
    readingRepo = new ReadingPositionRepository(db);

    docRepo.insert({
      id: 'doc-1',
      title: 'Sample PDF',
      author: 'Author',
      format: 'pdf',
      filePath: '/path/to/doc.pdf',
      storageMode: 'managed',
      fileSize: 1000,
      fileMtimeMs: Date.now(),
      fileHash: 'abcdef',
      pageCount: 10,
    });
  });

  test('upserts reading position and rejects progress outside [0, 1]', () => {
    const loc1 = JSON.stringify({ format: 'pdf', pageIndex: 3 });
    const pos1 = readingRepo.upsert('doc-1', loc1, 0.35);

    expect(pos1.documentId).toBe('doc-1');
    expect(pos1.progress).toBe(0.35);
    expect(pos1.locationJson).toBe(loc1);

    // Update existing document position
    const loc2 = JSON.stringify({ format: 'pdf', pageIndex: 7 });
    const pos2 = readingRepo.upsert('doc-1', loc2, 1.0);
    expect(pos2.progress).toBe(1.0);
    expect(pos2.locationJson).toBe(loc2);

    expect(() => readingRepo.upsert('doc-1', loc2, -0.2)).toThrow(/between 0 and 1/);
    expect(() => readingRepo.upsert('doc-1', loc2, 1.5)).toThrow(/between 0 and 1/);
  });

  test('retrieves and deletes reading position', () => {
    const loc = JSON.stringify({ format: 'epub', cfi: 'epubcfi(/6/2)' });
    readingRepo.upsert('doc-1', loc, 0.42);

    const found = readingRepo.findByDocumentId('doc-1');
    expect(found).not.toBeNull();
    expect(found?.progress).toBe(0.42);

    readingRepo.delete('doc-1');
    expect(readingRepo.findByDocumentId('doc-1')).toBeNull();
  });
});
