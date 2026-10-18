import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { LibraryService } from '../../src/main/library/library-service';
import { createLogger } from '../../src/main/logging/logger';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';
import { AssetRegistry } from '../../src/main/security/asset-registry';

describe('LibraryService Markdown Integration', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let docRepo: DocumentRepository;
  let folderRepo: FolderRepository;
  let readingRepo: ReadingPositionRepository;
  let service: LibraryService;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-md-lib-')));
    libraryDir = join(tempDir, 'library');
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    const log = createLogger('library');
    storage = new StorageManager(libraryDir, log);
    await storage.initialize();
    docRepo = new DocumentRepository(db);
    folderRepo = new FolderRepository(db);
    readingRepo = new ReadingPositionRepository(db);
    service = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log,
      documentAssets: new DocumentAssetRepository(db),
      assetRegistry: new AssetRegistry([libraryDir]),
      currentScopeId: () => 'library-test-scope',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('imports a .md file with frontmatter metadata and managed copy', async () => {
    const mdPath = join(tempDir, 'test.md');
    writeFileSync(mdPath, makeMarkdownFixture({
      title: 'Imported Note',
      author: 'Unit Test',
    }));

    const result = await service.importFiles([mdPath], { folderId: null, storageMode: 'managed' });
    expect(result.imported).toHaveLength(1);
    expect(result.failed).toHaveLength(0);

    const imported = result.imported[0]!;
    expect(imported.format).toBe('markdown');
    expect(imported.title).toBe('Imported Note');
    expect(imported.author).toBe('Unit Test');
    expect(imported.storageMode).toBe('managed');
    expect(imported.pageCount).toBeNull();
  });

  test('imports a .markdown file with link storage mode', async () => {
    const mdPath = join(tempDir, 'readme.markdown');
    writeFileSync(mdPath, makeMarkdownFixture({
      title: 'Linked Readme',
      useFrontmatter: false,
    }));

    const result = await service.importFiles([mdPath], { folderId: null, storageMode: 'link' });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.format).toBe('markdown');
    expect(result.imported[0]!.storageMode).toBe('link');
    expect(result.imported[0]!.title).toBe('Linked Readme');
  });

  test('imports markdown with BOM and extracts title correctly', async () => {
    const mdPath = join(tempDir, 'bom.md');
    writeFileSync(mdPath, makeMarkdownFixture({
      title: 'BOM Document',
      bom: true,
    }));

    const result = await service.importFiles([mdPath], { folderId: null, storageMode: 'managed' });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.title).toBe('BOM Document');
  });

  test('rejects binary file with .md extension', async () => {
    const binaryPath = join(tempDir, 'fake.md');
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const result = await service.importFiles([binaryPath]);
    expect(result.failed).toHaveLength(1);
    expect(result.imported).toHaveLength(0);
  });

  test('persists and retrieves markdown document with reading position', async () => {
    const mdPath = join(tempDir, 'persist.md');
    writeFileSync(mdPath, makeMarkdownFixture({ title: 'Position Test' }));

    const importResult = await service.importFiles([mdPath], { folderId: null, storageMode: 'link' });
    const doc = importResult.imported[0]!;

    service.updateReadingPosition(
      doc.id,
      {
        format: 'markdown',
        blockIndex: 5,
        headingId: 'section-2',
        progression: 0.42,
      },
      0.42
    );

    const position = (await service.getDocument(doc.id))?.readingPosition;
    expect(position).toBeDefined();
    expect(position!.location).toMatchObject({
      format: 'markdown',
      blockIndex: 5,
      headingId: 'section-2',
    });
    expect(position!.progress).toBeCloseTo(0.42);
  });
});
