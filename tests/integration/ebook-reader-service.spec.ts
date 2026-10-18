import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { StorageManager } from '../../src/main/library/storage-manager';
import { LibraryService } from '../../src/main/library/library-service';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { createMediaProtocolHandler } from '../../src/main/security/protocol-handler';
import { createLogger } from '../../src/main/logging/logger';
import { makeEpubFixture, makeMobiFixture } from '../fixtures/document-fixtures';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';

describe('Ebook Reader Service & Media Protocol Integration (Phase 4 EPUB & MOBI)', () => {
  let tmpDir: string;
  let libraryDir: string;
  let stagingDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let documents: DocumentRepository;
  let folders: FolderRepository;
  let readingPositions: ReadingPositionRepository;
  let assetRegistry: AssetRegistry;
  let libraryService: LibraryService;
  let mediaProtocolHandler: (req: Request) => Promise<Response>;
  const SCOPE_ID = 'test-renderer-scope-ebook';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'interleaf-ebook-reader-test-'));
    libraryDir = join(tmpDir, 'library');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const dbPath = join(tmpDir, 'test.db');

    db = InterleafDatabase.open(dbPath);
    runMigrations(db);

    const logger = createLogger('library');
    storage = new StorageManager(libraryDir, logger);
    await storage.initialize();

    documents = new DocumentRepository(db);
    folders = new FolderRepository(db);
    readingPositions = new ReadingPositionRepository(db);

    assetRegistry = new AssetRegistry([libraryDir, stagingDir]);
    mediaProtocolHandler = createMediaProtocolHandler({
      assetRegistry,
      currentScopeId: () => SCOPE_ID,
      log: logger,
    });

    libraryService = new LibraryService({
      db,
      storage,
      documents,
      folders,
      readingPositions,
      assetRegistry,
      log: logger,
      currentScopeId: () => SCOPE_ID,
      documentAssets: new DocumentAssetRepository(db),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports, opens, streams via interleaf-media, and tracks reading position for EPUB', async () => {
    const epubBuffer = makeEpubFixture({
      title: 'Operating Systems Principles',
      author: 'Andrew Tanenbaum',
      chapters: [
        { title: 'Chapter 1: Processes and Threads', content: '<p>Processes provide memory isolation.</p>' },
        { title: 'Chapter 2: Memory Management', content: '<p>Virtual memory and paging.</p>' },
      ],
    });

    const epubPath = join(tmpDir, 'os.epub');
    writeFileSync(epubPath, epubBuffer);

    const importResult = await libraryService.importFiles([epubPath], { folderId: null, storageMode: 'managed' });
    expect(importResult.imported).toHaveLength(1);
    const importedDoc = importResult.imported[0]!;
    expect(importedDoc.format).toBe('epub');

    const opened = await libraryService.openDocument(importedDoc.id);
    expect(opened.document.id).toBe(importedDoc.id);
    expect(opened.assetUrl).toContain('interleaf-media://');

    // Fetch via media protocol handler
    const response = await mediaProtocolHandler(new Request(opened.assetUrl));
    expect(response.status).toBe(200);
    const streamedBytes = new Uint8Array(await response.arrayBuffer());
    expect(streamedBytes.length).toBe(epubBuffer.length);

    // Update EPUB reading position
    libraryService.updateReadingPosition(
      importedDoc.id,
      {
        format: 'epub',
        cfi: 'epubcfi(/6/4[chapter2]!/4/2)',
        spineHref: 'OEBPS/chapter2.xhtml',
      },
      0.5
    );

    const savedPosition = (await libraryService.getDocument(importedDoc.id))?.readingPosition;
    expect(savedPosition?.progress).toBe(0.5);
    expect(savedPosition?.location.format).toBe('epub');

    const reopened = await libraryService.openDocument(importedDoc.id);
    expect(reopened.document.readingPosition?.progress).toBe(0.5);
    expect(reopened.document.readingPosition?.location.format).toBe('epub');

    await libraryService.closeDocument(importedDoc.id);
  });

  it('imports, opens, streams via interleaf-media, and tracks reading position for MOBI', async () => {
    const mobiBuffer = makeMobiFixture({
      title: 'Database Internals',
      author: 'Alex Petrov',
      chapters: [
        { title: 'Chapter 1: B-Trees', content: '<p>B-Trees organize on-disk pages into balanced trees.</p>' },
        { title: 'Chapter 2: LSM-Trees', content: '<p>LSM-Trees append writes into MemTables and SSTables.</p>' },
      ],
    });

    const mobiPath = join(tmpDir, 'db.mobi');
    writeFileSync(mobiPath, mobiBuffer);

    const importResult = await libraryService.importFiles([mobiPath], { folderId: null, storageMode: 'managed' });
    expect(importResult.imported).toHaveLength(1);
    const importedDoc = importResult.imported[0]!;
    expect(importedDoc.format).toBe('mobi');

    const opened = await libraryService.openDocument(importedDoc.id);
    expect(opened.document.id).toBe(importedDoc.id);
    expect(opened.assetUrl).toContain('interleaf-media://');

    // Fetch via media protocol handler
    const response = await mediaProtocolHandler(new Request(opened.assetUrl));
    expect(response.status).toBe(200);
    const streamedBytes = new Uint8Array(await response.arrayBuffer());
    expect(streamedBytes.length).toBe(mobiBuffer.length);

    // Update MOBI reading position
    libraryService.updateReadingPosition(
      importedDoc.id,
      {
        format: 'mobi',
        sectionIndex: 1,
        byteOffset: 120,
      },
      0.65
    );

    const savedPosition = (await libraryService.getDocument(importedDoc.id))?.readingPosition;
    expect(savedPosition?.progress).toBe(0.65);
    expect(savedPosition?.location.format).toBe('mobi');

    const reopened = await libraryService.openDocument(importedDoc.id);
    expect(reopened.document.readingPosition?.progress).toBe(0.65);
    expect(reopened.document.readingPosition?.location.format).toBe('mobi');

    await libraryService.closeDocument(importedDoc.id);
  });
});
