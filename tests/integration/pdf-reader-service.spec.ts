import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { makePdfFixture } from '../fixtures/document-fixtures';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';

describe('PDF Reader Service & Media Protocol Integration (Phases 3 & 4)', () => {
  let tmpDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let documents: DocumentRepository;
  let folders: FolderRepository;
  let readingPositions: ReadingPositionRepository;
  let assetRegistry: AssetRegistry;
  let libraryService: LibraryService;
  let mediaProtocolHandler: (req: Request) => Promise<Response>;
  const SCOPE_ID = 'test-renderer-scope-1';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'interleaf-pdf-reader-test-'));
    libraryDir = join(tmpDir, 'library');
    const dbPath = join(tmpDir, 'test.db');

    db = InterleafDatabase.open(dbPath);
    runMigrations(db);

    const logger = createLogger('library');
    storage = new StorageManager(libraryDir, logger);
    await storage.initialize();

    documents = new DocumentRepository(db);
    folders = new FolderRepository(db);
    readingPositions = new ReadingPositionRepository(db);

    assetRegistry = new AssetRegistry([libraryDir]);
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
      log: logger,
      assetRegistry,
      currentScopeId: () => SCOPE_ID,
      documentAssets: new DocumentAssetRepository(db),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports, opens, streams via interleaf-media, and tracks reading position', async () => {
    const pdfBytes = makePdfFixture({
      pages: [
        'Page 1: Architecture of Interleaf.',
        'Page 2: Security Boundaries and Protocol Capabilities.',
        'Page 3: Bounded Lazy Virtualization.',
      ],
      outline: [
        { title: 'Section 1', targetPage: 1 },
        { title: 'Section 2', targetPage: 2 },
        { title: 'Section 3', targetPage: 3 },
      ],
    });

    const sourceFile = join(tmpDir, 'sample-book.pdf');
    writeFileSync(sourceFile, pdfBytes);

    // 1. Import document into managed storage
    const imported = await libraryService.importFile(sourceFile, { folderId: null, storageMode: 'managed' });
    expect(imported.format).toBe('pdf');
    expect(imported.storageMode).toBe('managed');

    // 2. Open document for reading via LibraryService
    const opened = await libraryService.openDocument(imported.id);
    expect(opened.document.id).toBe(imported.id);
    expect(opened.assetUrl).toMatch(/^interleaf-media:\/\/[a-f0-9-]+$/);

    // 3. Stream document via interleaf-media protocol handler
    const fullResponse = await mediaProtocolHandler(new Request(opened.assetUrl));
    expect(fullResponse.status).toBe(200);
    expect(fullResponse.headers.get('content-type')).toBe('application/pdf');
    const streamedText = await fullResponse.text();
    expect(streamedText).toContain('%PDF-1.4');

    // 4. Test Range request streaming
    const rangeResponse = await mediaProtocolHandler(
      new Request(opened.assetUrl, { headers: { Range: 'bytes=0-15' } })
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toMatch(/^bytes 0-15\//);

    // 5. Update Reading Position
    libraryService.updateReadingPosition(
      imported.id,
      { format: 'pdf', pageIndex: 1 },
      2 / 3
    );

    const savedPosition = (await libraryService.getDocument(imported.id))?.readingPosition;
    expect(savedPosition).not.toBeNull();
    expect(savedPosition?.location).toEqual({ format: 'pdf', pageIndex: 1 });
    expect(savedPosition?.progress).toBeCloseTo(2 / 3);

    // 6. Reopen document and verify persisted position is returned
    const reopened = await libraryService.openDocument(imported.id);
    expect(reopened.document.readingPosition?.location).toEqual({ format: 'pdf', pageIndex: 1 });
  });

  it('revokes media capability when switching documents in the same renderer scope', async () => {
    const pdf1Bytes = makePdfFixture({ pages: ['Doc 1 Page 1'] });
    const pdf2Bytes = makePdfFixture({ pages: ['Doc 2 Page 1'] });

    const file1 = join(tmpDir, 'doc1.pdf');
    const file2 = join(tmpDir, 'doc2.pdf');
    writeFileSync(file1, pdf1Bytes);
    writeFileSync(file2, pdf2Bytes);

    const doc1 = await libraryService.importFile(file1, { folderId: null, storageMode: 'managed' });
    const doc2 = await libraryService.importFile(file2, { folderId: null, storageMode: 'managed' });

    // Open doc1
    const opened1 = await libraryService.openDocument(doc1.id);
    const resp1 = await mediaProtocolHandler(new Request(opened1.assetUrl));
    expect(resp1.status).toBe(200);

    // Switch to doc2 in same scope
    const opened2 = await libraryService.openDocument(doc2.id);
    const resp2 = await mediaProtocolHandler(new Request(opened2.assetUrl));
    expect(resp2.status).toBe(200);

    // Attempting to access doc1's asset URL now fails with 404 because capability was revoked
    const revokedResp1 = await mediaProtocolHandler(new Request(opened1.assetUrl));
    expect(revokedResp1.status).toBe(404);
  });

  it('stages linked PDF files into managed storage before capability registration', async () => {
    const pdfBytes = makePdfFixture({ pages: ['Linked External PDF Content'] });
    const externalFile = join(tmpDir, 'external-doc.pdf');
    writeFileSync(externalFile, pdfBytes);

    const linkedDoc = await libraryService.importFile(externalFile, { folderId: null, storageMode: 'link' });
    expect(linkedDoc.storageMode).toBe('link');

    const opened = await libraryService.openDocument(linkedDoc.id);
    expect(opened.assetUrl).toMatch(/^interleaf-media:\/\/[a-f0-9-]+$/);

    const response = await mediaProtocolHandler(new Request(opened.assetUrl));
    expect(response.status).toBe(200);
    const content = await response.text();
    expect(content).toContain('Linked External PDF Content');

    const stagedFilesBeforeClose = readdirSync(join(libraryDir, '.staged'));
    expect(stagedFilesBeforeClose).toHaveLength(1);
    await libraryService.closeDocument(linkedDoc.id);
    const stagedFilesAfterClose = readdirSync(join(libraryDir, '.staged'));
    expect(stagedFilesAfterClose).toHaveLength(0);
  });
});
