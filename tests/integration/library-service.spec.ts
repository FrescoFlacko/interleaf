import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { LibraryService } from '../../src/main/library/library-service';
import { createLogger } from '../../src/main/logging/logger';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeDocxFixture,
  makeEpubFixture,
  makeLargeCoverStreamPdfFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';

describe('LibraryService Integration', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let docRepo: DocumentRepository;
  let folderRepo: FolderRepository;
  let readingRepo: ReadingPositionRepository;
  let service: LibraryService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lib-service-test-'));
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
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('imports PDF and EPUB in managed copy mode with metadata and storage health', async () => {
    const pdfPath = join(tempDir, 'Designing_Data_Intensive_Apps.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<< /Title (DDIA) /Author (Martin Kleppmann) >>\nendobj\n');

    const epubPath = join(tempDir, 'Architecture_Patterns.epub');
    writeFileSync(epubPath, makeEpubFixture('Patterns'));

    const pdfDoc = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    expect(pdfDoc.title).toBe('DDIA');
    expect(pdfDoc.author).toBe('Martin Kleppmann');
    expect(pdfDoc.format).toBe('pdf');
    expect(pdfDoc.storageMode).toBe('managed');
    expect(pdfDoc.storageHealth).toBe('ok');

    const epubDoc = await service.importFile(epubPath, { folderId: null, storageMode: 'managed' });
    expect(epubDoc.title).toBe('Patterns');
    expect(epubDoc.format).toBe('epub');
    expect(epubDoc.storageHealth).toBe('ok');

    const allDocs = await service.listDocuments();
    expect(allDocs.length).toBe(2);
  });

  test('authorizes indexing only for the document active in the main-owned renderer scope', async () => {
    const sourcePath = join(tempDir, 'active.pdf');
    writeFileSync(sourcePath, '%PDF-1.4 active document payload\n');
    const imported = await service.importFile(sourcePath, { folderId: null, storageMode: 'managed' });
    const scopedService = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log: createLogger('library'),
      assetRegistry: new AssetRegistry([libraryDir]),
      currentScopeId: () => 'renderer-scope',
      documentAssets: new DocumentAssetRepository(db),
    });

    expect(() => { scopedService.requireDocumentOpen(imported.id); }).toThrow(/active document/i);
    await scopedService.openDocument(imported.id);
    expect(() => { scopedService.requireDocumentOpen(imported.id); }).not.toThrow();
    expect(() => { scopedService.requireDocumentOpen('other-document'); }).toThrow(/active document/i);
    await scopedService.closeDocument(imported.id);
    expect(() => { scopedService.requireDocumentOpen(imported.id); }).toThrow(/active document/i);
  });

  test('deduplicates identical binaries to one logical document and moves its primary folder', async () => {
    const f1 = service.createFolder('Folder 1');
    const f2 = service.createFolder('Folder 2');

    const sourceFile = join(tempDir, 'identical.pdf');
    writeFileSync(sourceFile, '%PDF-1.7 identical book content payload\n');

    // 1. Import into Folder 1
    const doc1 = await service.importFile(sourceFile, { folderId: f1.id });
    expect(doc1.folderId).toBe(f1.id);

    // 2. Re-import into Folder 1 -> returns exact existing document (no duplicate row)
    const doc1Repeat = await service.importFile(sourceFile, { folderId: f1.id });
    expect(doc1Repeat.id).toBe(doc1.id);

    // 3. Import into Folder 2 -> reuses the row and moves its one primary folder
    const doc2 = await service.importFile(sourceFile, { folderId: f2.id });
    expect(doc2.id).toBe(doc1.id);
    expect(doc2.fileHash).toBe(doc1.fileHash);
    expect(doc2.folderId).toBe(f2.id);

    const f1Docs = await service.listDocuments({ folderId: f1.id });
    const f2Docs = await service.listDocuments({ folderId: f2.id });
    expect(f1Docs.length).toBe(0);
    expect(f2Docs.length).toBe(1);
  });

  test('re-importing a binary updates its storage mode without duplicating the logical document', async () => {
    const original = join(tempDir, 'storage-choice.pdf');
    writeFileSync(original, '%PDF-1.7 storage choice payload\n');

    const linked = await service.importFile(original, { folderId: null, storageMode: 'link' });
    expect(linked.storageMode).toBe('link');

    const managed = await service.importFile(original, { folderId: null, storageMode: 'managed' });
    expect(managed.id).toBe(linked.id);
    expect(managed.storageMode).toBe('managed');
    const managedPath = docRepo.findById(managed.id)?.filePath;
    expect(managedPath).toBeDefined();
    expect(managedPath ? existsSync(managedPath) : false).toBe(true);

    const alternateLink = join(tempDir, 'alternate-storage-choice.pdf');
    writeFileSync(alternateLink, '%PDF-1.7 storage choice payload\n');
    const relinked = await service.importFile(alternateLink, { folderId: null, storageMode: 'link' });
    expect(relinked.id).toBe(linked.id);
    expect(relinked.storageMode).toBe('link');
    expect(managedPath ? existsSync(managedPath) : true).toBe(false);
    expect((await service.listDocuments()).length).toBe(1);
  });

  test('rolls back a multi-statement storage and folder reconciliation failure', async () => {
    const firstFolder = service.createFolder('First Folder');
    const secondFolder = service.createFolder('Second Folder');
    const source = join(tempDir, 'transactional-switch.pdf');
    writeFileSync(source, '%PDF-1.7 transactional switch payload\n');
    const original = await service.importFile(source, {
      storageMode: 'link',
      folderId: firstFolder.id,
    });

    vi.spyOn(docRepo, 'moveToFolder').mockImplementationOnce(() => {
      throw new Error('simulated folder update failure');
    });
    await expect(
      service.importFile(source, { storageMode: 'managed', folderId: secondFolder.id })
    ).rejects.toThrow(/simulated/i);

    const persisted = docRepo.findById(original.id);
    expect(persisted?.storageMode).toBe('link');
    expect(persisted?.filePath).toBe(realpathSync(source));
    expect(persisted?.folderId).toBe(firstFolder.id);
  });

  test.each(['link', 'managed'] as const)(
    'concurrent %s imports converge on one logical document',
    async (storageMode) => {
      const source = join(tempDir, `concurrent-${storageMode}.pdf`);
      writeFileSync(source, `%PDF-1.7 concurrent ${storageMode} payload\n`);

      const imported = await Promise.all(
        Array.from({ length: 40 }, () => service.importFile(source, { folderId: null, storageMode }))
      );

      expect(new Set(imported.map((doc) => doc.id)).size).toBe(1);
      expect(docRepo.findByHash(imported[0]!.fileHash)).toHaveLength(1);
      expect((await service.listDocuments()).length).toBe(1);
    }
  );

  test('serializes orphan reconciliation behind the complete import lifecycle', async () => {
    const source = join(tempDir, 'lifecycle-lock.pdf');
    writeFileSync(source, '%PDF-1.7 lifecycle lock payload\n');

    const originalIngest = storage.ingestFile.bind(storage);
    let releaseIngest!: () => void;
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    let placementObserved!: () => void;
    const placement = new Promise<void>((resolve) => {
      placementObserved = resolve;
    });
    vi.spyOn(storage, 'ingestFile').mockImplementationOnce(async (...args) => {
      const result = await originalIngest(...args);
      placementObserved();
      await ingestGate;
      return result;
    });
    const reconcile = vi
      .spyOn(storage, 'reconcileOrphanedManagedFiles')
      .mockResolvedValueOnce(0);

    const importing = service.importFile(source, { folderId: null, storageMode: 'managed' });
    await placement;
    const sweeping = service.reconcileManagedStorage(0);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();

    releaseIngest();
    await importing;
    await sweeping;
    expect(reconcile).toHaveBeenCalledOnce();
    const provider = reconcile.mock.calls[0]?.[0];
    expect(typeof provider).toBe('function');
    if (typeof provider === 'function') {
      expect(await provider()).toHaveLength(1);
    }
  });

  test('moves document between virtual folders', async () => {
    const folderA = service.createFolder('Source Folder');
    const folderB = service.createFolder('Target Folder');

    const docFile = join(tempDir, 'paper.docx');
    writeFileSync(docFile, makeDocxFixture('Paper'));

    const doc = await service.importFile(docFile, { folderId: folderA.id });
    expect(doc.folderId).toBe(folderA.id);

    // Move to Target Folder
    service.moveDocumentToFolder(doc.id, folderB.id);

    const updated = await service.getDocument(doc.id);
    expect(updated?.folderId).toBe(folderB.id);

    // Move to root (null)
    service.moveDocumentToFolder(doc.id, null);
    const rootDoc = await service.getDocument(doc.id);
    expect(rootDoc?.folderId).toBeNull();
  });

  test('tracks reading position and provides continue reading query', async () => {
    const docFile = join(tempDir, 'handbook.pdf');
    writeFileSync(docFile, '%PDF-1.4 handbook content');
    const doc = await service.importFile(docFile);

    // No reading progress initially
    const initContinue = await service.getContinueReading();
    expect(initContinue.length).toBe(0);

    // Update reading position to 45%
    const pos = service.updateReadingPosition(
      doc.id,
      { format: 'pdf', pageIndex: 5, pageLabel: 'Page 5' },
      0.45
    );
    expect(pos.progress).toBe(0.45);

    // Document now appears in Continue Reading
    const continueDocs = await service.getContinueReading();
    expect(continueDocs.length).toBe(1);
    expect(continueDocs[0]?.id).toBe(doc.id);
    expect(continueDocs[0]?.readingPosition?.progress).toBe(0.45);

    // Completed reading (100%) leaves Continue Reading
    service.updateReadingPosition(
      doc.id,
      { format: 'pdf', pageIndex: 10 },
      1.0
    );
    const finishedContinue = await service.getContinueReading();
    expect(finishedContinue.length).toBe(0);
  });

  test('rejects a reading location for the wrong document format', async () => {
    const docFile = join(tempDir, 'format-bound-position.pdf');
    writeFileSync(docFile, '%PDF-1.4 format-bound position');
    const doc = await service.importFile(docFile);

    expect(() =>
      service.updateReadingPosition(
        doc.id,
        { format: 'epub', cfi: 'epubcfi(/6/4)' },
        0.25
      )
    ).toThrow(/does not match/i);
    expect((await service.getDocument(doc.id))?.readingPosition).toBeNull();
  });

  test('batch import handles mixed valid and invalid files without crashing', async () => {
    const validPdf = join(tempDir, 'valid.pdf');
    writeFileSync(validPdf, '%PDF-1.7 valid document');

    const invalidExt = join(tempDir, 'unsupported.exe');
    writeFileSync(invalidExt, 'binary exe');

    const corruptPdf = join(tempDir, 'corrupt.pdf');
    writeFileSync(corruptPdf, 'not a valid pdf header');

    const result = await service.importFiles([validPdf, invalidExt, corruptPdf]);
    expect(result.totalAttempted).toBe(3);
    expect(result.imported.length).toBe(1);
    expect(result.failed.length).toBe(2);

    expect(result.imported[0]?.title).toBe('valid');
    expect(result.failed.some((f) => f.fileName === 'unsupported.exe')).toBe(true);
    expect(result.failed.some((f) => f.fileName === 'corrupt.pdf')).toBe(true);
  });

  test('summary counts and storage health tracking', async () => {
    const pdf = join(tempDir, 'book1.pdf');
    writeFileSync(pdf, '%PDF-1.4 content 1');
    await service.importFile(pdf, { folderId: null, storageMode: 'managed' });

    const linked = join(tempDir, 'linked.epub');
    writeFileSync(linked, makeEpubFixture('Linked'));
    await service.importFile(linked, { folderId: null, storageMode: 'link' });

    service.createFolder('Tech');

    const summary = await service.getSummary();
    expect(summary.totalDocuments).toBe(2);
    expect(summary.managedCount).toBe(1);
    expect(summary.linkCount).toBe(1);
    expect(summary.totalFolders).toBe(1);
    expect(summary.missingCount).toBe(0);
    expect(summary.changedCount).toBe(0);
  });

  test('paginates documents with bounded limits, offsets, and preserved sort order', async () => {
    for (let i = 1; i <= 5; i++) {
      const pdfPath = join(tempDir, `book-${String(i)}.pdf`);
      writeFileSync(
        pdfPath,
        `%PDF-1.4\n1 0 obj\n<< /Title (Book ${String.fromCharCode(64 + i)}) >>\nendobj\n`
      );
      await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    }

    // Page 1 (offset 0, limit 2)
    const page1 = await service.listDocuments({ sort: 'title_asc', offset: 0, limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]?.title).toBe('Book A');
    expect(page1[1]?.title).toBe('Book B');

    // Page 2 (offset 2, limit 2)
    const page2 = await service.listDocuments({ sort: 'title_asc', offset: 2, limit: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0]?.title).toBe('Book C');
    expect(page2[1]?.title).toBe('Book D');

    // Page 3 (offset 4, limit 2)
    const page3 = await service.listDocuments({ sort: 'title_asc', offset: 4, limit: 2 });
    expect(page3).toHaveLength(1);
    expect(page3[0]?.title).toBe('Book E');

    // Page 4 (offset 6, limit 2)
    const page4 = await service.listDocuments({ sort: 'title_asc', offset: 6, limit: 2 });
    expect(page4).toHaveLength(0);

    // Renderer-facing service calls default to a bounded first page, while
    // internal repository consumers (orphan reconciliation) remain complete.
    for (let i = 6; i <= 55; i++) {
      docRepo.insert({
        id: `bulk-${String(i)}`,
        title: `Bulk ${String(i).padStart(2, '0')}`,
        author: null,
        format: 'pdf',
        filePath: join(libraryDir, `bulk-${String(i)}.pdf`),
        storageMode: 'managed',
        fileSize: 1,
        fileMtimeMs: 1,
        fileHash: String(i).padStart(64, '0'),
        pageCount: null,
        coverPath: null,
        folderId: null,
      });
    }
    expect(docRepo.list()).toHaveLength(55);
    expect(await service.listDocuments()).toHaveLength(50);
  });

  test('returns checking health immediately on cold link listDocuments and notifies progress via background scan', async () => {
    const linkedPath = join(tempDir, 'linked-async-test.epub');
    writeFileSync(linkedPath, makeEpubFixture('Async Health'));
    const imported = await service.importFile(linkedPath, { folderId: null, storageMode: 'link' });
    expect(imported.storageHealth).toBe('ok');

    // Fresh storage instance without in-memory cache to simulate cold app launch
    const coldStorage = new StorageManager(libraryDir, createLogger('library'));
    await coldStorage.initialize();
    const coldService = new LibraryService({
      db,
      storage: coldStorage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log: createLogger('library'),
      documentAssets: new DocumentAssetRepository(db),
      assetRegistry: new AssetRegistry([libraryDir]),
      currentScopeId: () => 'library-test-scope',
    });
    const updates: { documentId: string; storageHealth: string }[] = [];
    let resolveUpdate!: () => void;
    const updatePromise = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });

    coldService.onHealthUpdated((update) => {
      updates.push(update);
      if (update.storageHealth === 'ok') {
        resolveUpdate();
      }
    });

    // Immediate list documents returns 'checking' status without blocking on worker hash
    const coldDocs = await coldService.listDocuments();
    expect(coldDocs).toHaveLength(1);
    expect(coldDocs[0]?.storageHealth).toBe('checking');

    // Background scan completes and notifies
    await updatePromise;
    expect(updates.some((u) => u.documentId === imported.id && u.storageHealth === 'ok')).toBe(true);

    // Subsequent listDocuments returns 'ok' from cache
    const warmDocs = await coldService.listDocuments();
    expect(warmDocs[0]?.storageHealth).toBe('ok');
  });

  test('serializes deleteDocument and concurrent same-hash import so managed blob is not lost', async () => {
    const pdfPath = join(tempDir, 'concurrent-delete-import.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<< /Title (Concurrent Test) >>\nendobj\n');

    const doc = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    const managedPath = docRepo.findById(doc.id)?.filePath;
    expect(managedPath).toBeDefined();
    expect(existsSync(managedPath!)).toBe(true);

    // Fire concurrent delete of existing doc and re-import of same file content
    const [deleteResult, importResult] = await Promise.allSettled([
      service.deleteDocument(doc.id),
      service.importFile(pdfPath, { folderId: null, storageMode: 'managed' }),
    ]);

    expect(deleteResult.status).toBe('fulfilled');
    expect(importResult.status).toBe('fulfilled');

    // Exactly one logical document exists with this hash
    const existingDocs = docRepo.findByHash(doc.fileHash);
    expect(existingDocs).toHaveLength(1);

    // The managed blob on disk is guaranteed to exist and not be unlinked/lost
    const survivingDoc = existingDocs[0]!;
    expect(existsSync(survivingDoc.filePath)).toBe(true);
  });

  test('retains shared-hash cover snapshots until the final document is deleted', async () => {
    const pdfPath = join(tempDir, 'shared-cover.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Shared Cover', pageLines: [['Shared cover payload.']] }));
    const first = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    const firstRecord = docRepo.findById(first.id);
    expect(firstRecord).toBeDefined();

    const coverPng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(coverPng, 0);
    coverPng.write('IHDR', 12, 'ascii');
    coverPng.writeUInt32BE(1, 16);
    coverPng.writeUInt32BE(1, 20);
    const coverPath = await storage.writeCoverSnapshot(firstRecord!.fileHash, coverPng);
    const registry = new AssetRegistry([libraryDir]);
    const lifecycleService = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log: createLogger('library'),
      assetRegistry: registry,
      currentScopeId: () => 'shared-cover-scope',
      documentAssets: new DocumentAssetRepository(db),
    });
    const capability = await registry.registerAsset({
      filePath: coverPath,
      permittedRoot: libraryDir,
      documentId: first.id,
      scopeId: 'shared-cover-scope',
      kind: 'library-cover',
    });

    // The schema currently enforces hash uniqueness, but cleanup remains
    // defensive for migrated/legacy records that can share a hash.
    const sharedHash = vi.spyOn(docRepo, 'findByHash').mockImplementation((hash) =>
      hash === firstRecord!.fileHash ? [{ ...firstRecord!, id: 'legacy-shared-row' }] : []
    );
    await lifecycleService.deleteDocument(first.id);
    expect(existsSync(coverPath)).toBe(true);
    expect(registry.resolveAsset(capability.assetId, 'shared-cover-scope')).toBeNull();
    sharedHash.mockRestore();
    await storage.removeCoverSnapshot(firstRecord!.fileHash);
    expect(existsSync(coverPath)).toBe(false);
  });

  test('removes a lone PDF cover snapshot when its document is deleted', async () => {
    const pdfPath = join(tempDir, 'lone-cover.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Lone Cover', pageLines: [['Lone cover payload.']] }));
    const imported = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    const coverPng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(coverPng, 0);
    coverPng.write('IHDR', 12, 'ascii');
    coverPng.writeUInt32BE(1, 16);
    coverPng.writeUInt32BE(1, 20);
    const coverPath = await storage.writeCoverSnapshot(imported.fileHash, coverPng);
    expect(existsSync(coverPath)).toBe(true);
    await service.deleteDocument(imported.id);
    expect(existsSync(coverPath)).toBe(false);
  });

  test('serializes preview cover side effects ahead of document deletion', async () => {
    const pdfPath = join(tempDir, 'preview-delete-race.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Preview Race', pageLines: [['Race-safe cover.']] }));
    const imported = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    const registry = new AssetRegistry([libraryDir]);
    const lifecycleService = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log: createLogger('library'),
      assetRegistry: registry,
      currentScopeId: () => 'preview-race-scope',
      documentAssets: new DocumentAssetRepository(db),
    });

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalWrite = storage.writeCoverSnapshot.bind(storage);
    vi.spyOn(storage, 'writeCoverSnapshot').mockImplementation(async (...args) => {
      entered();
      await gate;
      return originalWrite(...args);
    });

    const previewing = lifecycleService.getDocumentPreview(imported.id);
    await enteredPromise;
    const deleting = lifecycleService.deleteDocument(imported.id);
    await Promise.resolve();
    expect(docRepo.findById(imported.id)).not.toBeNull();

    release();
    const preview = await previewing;
    await deleting;
    expect(preview.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    expect(docRepo.findById(imported.id)).toBeNull();
    expect(registry.size).toBe(0);
  });

  test('an existing PDF import without a cover gains one from its next preview', async () => {
    const pdfPath = join(tempDir, 'large-cover-stream.pdf');
    writeFileSync(pdfPath, makeLargeCoverStreamPdfFixture());
    const imported = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    expect(docRepo.findById(imported.id)?.coverPath).toBeNull();

    const registry = new AssetRegistry([libraryDir]);
    const previewService = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: folderRepo,
      readingPositions: readingRepo,
      log: createLogger('library'),
      assetRegistry: registry,
      currentScopeId: () => 'existing-import-scope',
      documentAssets: new DocumentAssetRepository(db),
    });

    const preview = await previewService.getDocumentPreview(imported.id);
    expect(preview.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    const coverPath = docRepo.findById(imported.id)?.coverPath;
    expect(coverPath).toBe(await storage.getCoverSnapshot(imported.fileHash));
    expect(existsSync(coverPath ?? '')).toBe(true);
    expect(docRepo.findById(imported.id)?.fileHash).toBe(imported.fileHash);
  });

  test('background health scan gracefully recovers when database errors or closes', async () => {
    const pdfPath = join(tempDir, 'health-scan-recovery.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<< /Title (Recovery Test) >>\nendobj\n');
    const doc = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    expect(doc).toBeDefined();

    // Close DB while scheduling a background scan
    db.close();
    expect(() => {
      service.scheduleBackgroundHealthScan(undefined, true);
    }).not.toThrow();
    // Allow microtasks and ensure no unhandled rejections or stack overflows occur
    await new Promise<undefined>((resolve) => {
      setTimeout(() => { resolve(undefined); }, 50);
    });
  });

  test('list, get, and import never expose persisted cover paths as renderer URLs', async () => {
    const pdfPath = join(tempDir, 'cover-boundary.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<< /Title (Cover Boundary) >>\nendobj\n');

    const imported = await service.importFile(pdfPath, { folderId: null, storageMode: 'managed' });
    expect(imported).not.toHaveProperty('coverAssetUrl');

    const persistedValues = [
      '/Users/private/cover.png',
      'data:image/png;base64,AAAA',
      'file:///Users/private/cover.png',
      'https://example.invalid/cover.png',
      'interleaf-media://stale-or-unregistered',
    ];
    for (const coverPath of persistedValues) {
      db.raw.prepare('UPDATE documents SET cover_path = ? WHERE id = ?').run(coverPath, imported.id);
      const listed = await service.listDocuments();
      const fetched = await service.getDocument(imported.id);
      expect(JSON.stringify(listed.find((doc) => doc.id === imported.id))).not.toContain(coverPath);
      expect(JSON.stringify(fetched)).not.toContain(coverPath);
    }
  });
});
