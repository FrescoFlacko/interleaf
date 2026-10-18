import { randomUUID } from 'node:crypto';
import { DOCUMENT_FILE_FILTERS } from './document-file-filters';
import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import type { InterleafDatabase } from '../db/database';
import type { IngestResult, StorageManager } from './storage-manager';
import type { DocumentRecordWithReadingPosition, DocumentRepository } from '../db/repositories/document-repository';
import type {
  DocumentAssetRecord,
  DocumentAssetRepository,
  NewDocumentAsset,
} from '../db/repositories/document-asset-repository';
import type { FolderRepository } from '../db/repositories/folder-repository';
import type { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import type { Logger } from '../logging/logger';
import { safeWebArticleError, type PreparedWebArticle, type WebArticleImportService } from './web-article-import';
import { validateFileSignature } from './file-signatures';
import { extractDocumentMetadata } from './metadata-extractor';
import { PreviewService } from './preview-service';
import type {
  BatchImportResult,
  DocumentFilter,
  DocumentImportOptions,
  DocumentLocation,
  DocumentMetadata,
  Folder,
  FolderTree,
  ImportFileError,
  LibrarySummary,
  DocumentMediaAsset,
  OpenedDocument,
  ReadingPosition,
  StorageHealthUpdate,
  StorageMode,
  DocumentPreviewData,
  WebArticleImportResult,
} from '@shared/types/document';
import type { AssetRegistry } from '../security/asset-registry';
import { InterleafError } from '@shared/errors/interleaf-error';
import { documentSourceSchema } from '@shared/schemas/document';
import { isUniqueFileHashConstraintError, safeImportError } from './import-errors';
import { WorkAdmission } from '../app/work-admission';

export type LibraryServiceDeps = {
  readonly db: InterleafDatabase;
  readonly storage: StorageManager;
  readonly documents: DocumentRepository;
  readonly folders: FolderRepository;
  readonly readingPositions: ReadingPositionRepository;
  readonly log: Logger;
  readonly documentAssets: DocumentAssetRepository;
  readonly assetRegistry: AssetRegistry;
  readonly currentScopeId: () => string;
  /** Present when web-article import is available in this build. */
  readonly webArticles?: WebArticleImportService | undefined;
};

export class LibraryService {
  private static readonly MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024 * 1024;
  private readonly db: InterleafDatabase;
  private readonly storage: StorageManager;
  private readonly documents: DocumentRepository;
  private readonly folders: FolderRepository;
  private readonly readingPositions: ReadingPositionRepository;
  private readonly log: Logger;
  private readonly documentAssets: DocumentAssetRepository;
  private readonly assetRegistry: AssetRegistry;
  private readonly currentScopeId: () => string;
  private readonly webArticles: WebArticleImportService | undefined;
  private readonly previewService: PreviewService;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private onHealthUpdatedCallback?: ((update: StorageHealthUpdate) => void) | undefined;
  private isBackgroundScanRunning = false;
  private readonly pendingHealthScanDocIds = new Set<string>();
  private fullHealthScanOffset: number | null = null;
  private lastFullHealthScanAt = 0;
  private readonly knownHealthByDocumentId = new Map<string, StorageHealthUpdate['storageHealth']>();
  /** Imports in flight; an update restart waits for them and closes admission. */
  readonly importAdmission = new WorkAdmission();

  constructor(deps: LibraryServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.documents = deps.documents;
    this.folders = deps.folders;
    this.readingPositions = deps.readingPositions;
    this.log = deps.log;
    this.documentAssets = deps.documentAssets;
    this.assetRegistry = deps.assetRegistry;
    this.webArticles = deps.webArticles;
    this.currentScopeId = deps.currentScopeId;
    this.previewService = new PreviewService({
      db: this.db,
      documents: this.documents,
      readingPositions: this.readingPositions,
      log: this.log,
      storage: this.storage,
      assetRegistry: this.assetRegistry,
      currentScopeId: this.currentScopeId,
    });
  }

  onHealthUpdated(callback: (update: StorageHealthUpdate) => void): () => void {
    this.onHealthUpdatedCallback = callback;
    return () => {
      if (this.onHealthUpdatedCallback === callback) {
        this.onHealthUpdatedCallback = undefined;
      }
    };
  }

  requireDocumentOpen(documentId: string): void {
    if (!this.assetRegistry.isDocumentActive(this.currentScopeId(), documentId)) {
      throw new InterleafError('validation', 'Search indexing is limited to the active document.');
    }
  }

  private mapToDocumentMetadataFast(record: DocumentRecordWithReadingPosition): DocumentMetadata {
    const health = this.storage.checkStorageHealthImmediate(
      record.filePath,
      record.storageMode,
      record.fileHash,
      record.fileSize,
      record.fileMtimeMs
    );
    if (health.status !== 'checking') {
      this.knownHealthByDocumentId.set(record.id, health.status);
    }
    return {
      id: record.id,
      title: record.title,
      author: record.author,
      format: record.format,
      storageMode: record.storageMode,
      fileSize: record.fileSize,
      fileMtimeMs: record.fileMtimeMs,
      fileHash: record.fileHash,
      pageCount: record.pageCount,
      folderId: record.folderId,
      storageHealth: health.status,
      source: record.source,
      readingPosition: record.readingPosition,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(health.message !== undefined ? { storageHealthMessage: health.message } : {}),
    };
  }

  scheduleBackgroundHealthScan(
    priorityDocIds?: readonly string[],
    includeEntireLibrary = false
  ): void {
    if (priorityDocIds) {
      for (const id of priorityDocIds) {
        this.pendingHealthScanDocIds.add(id);
      }
    }
    if (
      includeEntireLibrary &&
      this.fullHealthScanOffset === null &&
      Date.now() - this.lastFullHealthScanAt >= 5 * 60 * 1000
    ) {
      this.fullHealthScanOffset = 0;
    }
    if (
      this.isBackgroundScanRunning ||
      (this.pendingHealthScanDocIds.size === 0 && this.fullHealthScanOffset === null)
    ) {
      return;
    }
    void this.runBackgroundHealthScan();
  }

  private async runBackgroundHealthScan(): Promise<void> {
    this.isBackgroundScanRunning = true;
    try {
      while (this.pendingHealthScanDocIds.size > 0 || this.fullHealthScanOffset !== null) {
        if (this.pendingHealthScanDocIds.size === 0 && this.fullHealthScanOffset !== null) {
          const page = this.documents.list({
            offset: this.fullHealthScanOffset,
            limit: 50,
            sort: 'recent_added',
          });
          if (page.length === 0) {
            this.fullHealthScanOffset = null;
            this.lastFullHealthScanAt = Date.now();
            continue;
          }
          this.fullHealthScanOffset += page.length;
          for (const record of page) {
            this.pendingHealthScanDocIds.add(record.id);
          }
        }
        const batch = Array.from(this.pendingHealthScanDocIds).slice(0, 16);
        for (const id of batch) {
          this.pendingHealthScanDocIds.delete(id);
        }
        const records = batch
          .map((id) => this.documents.findById(id))
          .filter((r): r is DocumentRecordWithReadingPosition => r !== null);

        await this.mapConcurrent(records, 2, async (record) => {
          const health = await this.storage.checkStorageHealth(
            record.filePath,
            record.storageMode,
            record.fileHash,
            record.fileSize,
            record.fileMtimeMs,
            false
          );
          if (health.updatedSize !== undefined && health.updatedMtimeMs !== undefined) {
            this.documents.updateStorageIdentity(record.id, health.updatedSize, health.updatedMtimeMs);
          }
          this.knownHealthByDocumentId.set(record.id, health.status);
          if (this.onHealthUpdatedCallback) {
            this.onHealthUpdatedCallback({
              documentId: record.id,
              storageHealth: health.status,
              ...(health.message !== undefined ? { storageHealthMessage: health.message } : {}),
            });
          }
        });
      }
    } catch (err) {
      this.log.warn('Background health scan interrupted', { error: err instanceof Error ? err.message : String(err) });
      this.fullHealthScanOffset = null;
      this.pendingHealthScanDocIds.clear();
    } finally {
      this.isBackgroundScanRunning = false;
      if (this.pendingHealthScanDocIds.size > 0 || this.fullHealthScanOffset !== null) {
        void this.runBackgroundHealthScan();
      }
    }
  }

  private async mapToDocumentMetadata(
    record: DocumentRecordWithReadingPosition,
    forceHealthVerification = false
  ): Promise<DocumentMetadata> {
    const health = await this.storage.checkStorageHealth(
      record.filePath,
      record.storageMode,
      record.fileHash,
      record.fileSize,
      record.fileMtimeMs,
      !forceHealthVerification
    );
    this.knownHealthByDocumentId.set(record.id, health.status);
    if (health.updatedSize !== undefined && health.updatedMtimeMs !== undefined) {
      this.documents.updateStorageIdentity(record.id, health.updatedSize, health.updatedMtimeMs);
    }

    const base: DocumentMetadata = {
      id: record.id,
      title: record.title,
      author: record.author,
      format: record.format,
      storageMode: record.storageMode,
      fileSize: health.updatedSize ?? record.fileSize,
      fileMtimeMs: health.updatedMtimeMs ?? record.fileMtimeMs,
      fileHash: record.fileHash,
      pageCount: record.pageCount,
      folderId: record.folderId,
      storageHealth: health.status,
      source: record.source,
      readingPosition: record.readingPosition,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(health.message !== undefined ? { storageHealthMessage: health.message } : {}),
    };

    return base;
  }

  async importFile(filePath: string, options?: DocumentImportOptions): Promise<DocumentMetadata> {
    return this.importAdmission.run(() => this.runLifecycleExclusive(() => this.importFileExclusive(filePath, options)));
  }

  /**
   * Serializes managed-blob reconciliation with the complete import lifecycle,
   * including the database commit that makes a newly placed blob authoritative.
   */
  async reconcileManagedStorage(minimumAgeMs?: number): Promise<number> {
    return this.runLifecycleExclusive(async () => {
      const managedRemoved = await this.storage.reconcileOrphanedManagedFiles(
        () => [
          ...this.documents
            .list()
            .filter((document) => document.storageMode === 'managed')
            .map((document) => document.filePath),
          // Archived article images live in the same content-addressed tree
          // and are referenced by rows rather than by a document's own
          // file_path, so reconciliation has to be told about them or it would
          // treat every picture in the library as an orphan.
          ...this.documentAssets.listAllPaths(),
        ],
        minimumAgeMs
      );
      const removedCovers = await this.storage.reconcileOrphanedCoverSnapshots(
        () => this.documents.list()
          .filter((document) => document.format === 'pdf')
          .map((document) => document.fileHash),
        minimumAgeMs
      );
      await this.reconcileStagedReaderAssets();
      return managedRemoved + removedCovers;
    });
  }

  private async runLifecycleExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async validateImportFileStat(filePath: string): Promise<void> {
    try {
      const selected = await lstat(filePath);
      if (selected.isSymbolicLink() || !selected.isFile()) {
        throw new InterleafError(
          'validation',
          'Symbolic links and non-regular files cannot be imported.'
        );
      }
      if (selected.size > LibraryService.MAX_IMPORT_FILE_BYTES) {
        throw new InterleafError(
          'validation',
          'The selected document exceeds the 2 GiB import limit.'
        );
      }
    } catch (err) {
      if (err instanceof InterleafError) throw err;
      throw new InterleafError('validation', 'The selected file is unavailable or inaccessible.');
    }
  }

  private async importFileExclusive(
    filePath: string,
    options?: DocumentImportOptions
  ): Promise<DocumentMetadata> {
    await this.validateImportFileStat(filePath);

    // Validate target folder if provided
    const targetFolderId = options?.folderId && options.folderId.trim().length > 0 ? options.folderId.trim() : null;
    if (targetFolderId !== null) {
      const folder = this.folders.findById(targetFolderId);
      if (!folder) {
        throw new InterleafError('validation', `Target folder '${targetFolderId}' does not exist.`);
      }
    }

    const storageMode = options?.storageMode ?? 'managed';

    // Ingest into storage (managed copy with SHA-256 hash or link in place)
    const ingestResult = await this.storage.ingestFile(filePath, storageMode);

    // Validate the exact managed snapshot (or the identity-checked linked file),
    // never an earlier pathname view that could change before ingestion.
    const sigValidation = await validateFileSignature(ingestResult.finalPath);
    if (!sigValidation.ok) {
      if (storageMode === 'managed' && !ingestResult.isDeduplicated) {
        await this.storage.deleteManagedFileIfOrphaned(ingestResult.finalPath, false);
      }
      throw new InterleafError('validation', sigValidation.error);
    }
    const format = sigValidation.format;

    // MVP has one primary folder per logical document: a binary hash maps to
    // one document row globally, not one duplicate row per folder.
    const existing = this.documents.findByHash(ingestResult.fileHash)[0];
    if (existing) {
      if (storageMode === 'link') {
        await this.assertLinkedFileStillMatches(ingestResult);
      }
      return this.reconcileExistingImport(existing, ingestResult, storageMode, targetFolderId);
    }

    const extracted = await extractDocumentMetadata(
      ingestResult.finalPath,
      format,
      filePath
    );
    if (storageMode === 'link') {
      await this.assertLinkedFileStillMatches(ingestResult);
    }

    let inserted: DocumentRecordWithReadingPosition;
    try {
      inserted = this.documents.insert({
        id: randomUUID(),
        title: extracted.title,
        author: extracted.author,
        format,
        filePath: ingestResult.finalPath,
        storageMode,
        fileSize: ingestResult.fileSize,
        fileMtimeMs: ingestResult.fileMtimeMs,
        fileHash: ingestResult.fileHash,
        pageCount: extracted.pageCount,
        coverPath: null,
        folderId: targetFolderId,
      });
    } catch (error) {
      // A concurrent import may have inserted this hash after our initial
      // lookup. The database uniqueness constraint is authoritative; converge
      // on that row and apply this import's explicit folder/storage choice.
      const raced = this.racedImport(error instanceof Error ? error : null, ingestResult.fileHash);
      if (raced !== undefined) {
        return this.reconcileExistingImport(raced, ingestResult, storageMode, targetFolderId);
      }
      if (storageMode === 'managed' && !ingestResult.isDeduplicated) {
        await this.storage.deleteManagedFileIfOrphaned(ingestResult.finalPath, false);
      }
      throw error;
    }

    this.log.info('Successfully imported document', {
      id: inserted.id,
      format: inserted.format,
      mode: inserted.storageMode,
      deduplicated: ingestResult.isDeduplicated,
    });

    return this.mapToDocumentMetadata(inserted);
  }

  /**
   * Captures a public web article as a managed Markdown document.
   *
   * Network work happens *outside* the lifecycle lock so a slow page cannot
   * block unrelated library operations, and only the short storage-and-insert
   * step is serialized with other imports. Nothing is written until a complete
   * snapshot exists, and any failure after staging removes the managed blob
   * before the error propagates, so no orphan file or row can survive.
   */
  importWebArticle(url: string, options?: DocumentImportOptions): Promise<WebArticleImportResult> {
    return this.importAdmission.run(() => this.captureWebArticle(url, options));
  }

  private async captureWebArticle(url: string, options?: DocumentImportOptions): Promise<WebArticleImportResult> {
    if (this.webArticles === undefined) {
      throw new InterleafError('internal', 'Web article import is unavailable.');
    }
    let prepared: PreparedWebArticle;
    try {
      prepared = await this.webArticles.prepare(url);
    } catch (error) {
      this.log.warn('Web article import failed before storage', {
        errorType: error instanceof Error ? error.name : typeof error,
        errorCode: error instanceof InterleafError ? error.code : 'unknown',
      });
      throw safeWebArticleError(error instanceof Error ? error : null);
    }

    // Provenance is validated here as well as at the repository, so a defective
    // capture is refused before anything is staged on disk rather than after.
    const source = documentSourceSchema.safeParse(prepared.source);
    if (!source.success) {
      this.log.warn('Web article import produced unusable provenance', {
        issues: source.error.issues.length,
      });
      throw safeWebArticleError(
        new InterleafError('internal', 'The captured article had unusable provenance.'),
      );
    }
    const validated: PreparedWebArticle = { ...prepared, source: source.data };
    return this.runLifecycleExclusive(() => this.storeWebArticleExclusive(validated, options));
  }

  private async storeWebArticleExclusive(
    prepared: PreparedWebArticle,
    options?: DocumentImportOptions
  ): Promise<WebArticleImportResult> {
    const targetFolderId = this.resolveTargetFolderId(options);
    // Images land in managed storage before the snapshot does, so the snapshot
    // is only ever committed once everything it refers to already exists. Media
    // that ends up unused is reclaimable garbage; a snapshot pointing at
    // missing files would be a broken document.
    const assets = await this.storeArticleMedia(prepared);
    let ingestResult: IngestResult;
    try {
      ingestResult = await this.storage.ingestGeneratedContent(
        Buffer.from(prepared.markdown, 'utf8'),
        '.md'
      );
    } catch (error) {
      await this.discardUnreferencedMedia(assets);
      throw safeWebArticleError(error instanceof Error ? error : null);
    }

    try {
      // The generated snapshot goes through the same signature validation as a
      // user file, so a bug in generation cannot smuggle a non-Markdown blob
      // into the managed library.
      const sigValidation = await validateFileSignature(ingestResult.finalPath);
      if (!sigValidation.ok || sigValidation.format !== 'markdown') {
        throw new InterleafError('internal', 'The captured article was not a valid Markdown snapshot.');
      }

      // Re-importing a page it already holds upgrades that capture in place.
      // This runs before the content-hash check so an unchanged page refreshes
      // its capture time rather than looking like an unrelated duplicate.
      const captured = this.documents.findBySourceUrl(prepared.source.url);
      if (captured) {
        const document = await this.upgradeCapturedArticle(captured, prepared, ingestResult, assets);
        return { document, alreadyInLibrary: true, media: prepared.mediaSummary };
      }

      // An identical snapshot hashes identically, so re-importing content the
      // library already holds under another URL converges on the existing row
      // under the normal content-hash rules. Nothing adopts the images staged
      // for this attempt, so they are reclaimed here rather than left for the
      // next reconciliation pass.
      const existing = this.documents.findByHash(ingestResult.fileHash)[0];
      if (existing) {
        const document = await this.reconcileExistingImport(
          existing,
          ingestResult,
          'managed',
          targetFolderId
        );
        await this.discardUnreferencedMedia(assets);
        return { document, alreadyInLibrary: true, media: prepared.mediaSummary };
      }

      return await this.insertCapturedArticle(prepared, ingestResult, assets, targetFolderId);
    } catch (error) {
      // Everything that reaches here failed for its own reason — a rejected
      // snapshot, an upgrade whose transaction rolled back — and none of it is
      // a lost race. Treating it as one would reconcile this import against
      // whichever unrelated document happens to share the content hash.
      await this.discardFailedCapture(ingestResult, assets);
      throw safeWebArticleError(error instanceof Error ? error : null);
    }
  }

  /**
   * Inserts a brand-new capture, converging if another import won the race.
   *
   * The race is narrow and specific: two imports of the same bytes reaching the
   * insert at once, where the loser's unique-hash constraint fires. It is
   * recognised only here, so a failure anywhere else in the capture cannot be
   * mistaken for one and silently reconciled against a stranger's row.
   */
  private async insertCapturedArticle(
    prepared: PreparedWebArticle,
    ingestResult: IngestResult,
    assets: readonly NewDocumentAsset[],
    targetFolderId: string | null
  ): Promise<WebArticleImportResult> {
    try {
      const inserted = this.withTransaction(() => {
        const record = this.documents.insert({
          id: randomUUID(),
          title: prepared.title,
          author: prepared.author,
          format: 'markdown',
          filePath: ingestResult.finalPath,
          storageMode: 'managed',
          fileSize: ingestResult.fileSize,
          fileMtimeMs: ingestResult.fileMtimeMs,
          fileHash: ingestResult.fileHash,
          pageCount: null,
          coverPath: null,
          folderId: targetFolderId,
          source: prepared.source,
        });
        this.documentAssets.replaceForDocument(record.id, assets);
        return record;
      });
      this.log.info('Successfully imported web article', {
        id: inserted.id,
        images: assets.length,
      });
      return {
        document: await this.mapToDocumentMetadata(inserted),
        alreadyInLibrary: false,
        media: prepared.mediaSummary,
      };
    } catch (error) {
      const raced = this.racedImport(error instanceof Error ? error : null, ingestResult.fileHash);
      if (raced !== undefined) {
        const document = await this.reconcileExistingImport(raced, ingestResult, 'managed', targetFolderId);
        // The winner already holds its own copies of these images; this attempt's
        // rolled-back asset rows leave the staged files referring to nothing.
        await this.discardUnreferencedMedia(assets);
        return { document, alreadyInLibrary: true, media: prepared.mediaSummary };
      }
      throw error;
    }
  }

  /**
   * Reclaims what a failed capture staged, and nothing else.
   *
   * Both the snapshot and the images are checked for references first, so an
   * import that failed after converging on bytes another document already holds
   * cannot take that document's files with it.
   */
  private async discardFailedCapture(
    ingestResult: IngestResult,
    assets: readonly NewDocumentAsset[]
  ): Promise<void> {
    if (!ingestResult.isDeduplicated) {
      await this.storage.deleteManagedFileIfOrphaned(
        ingestResult.finalPath,
        () => this.documents.countByFilePath(ingestResult.finalPath) > 0
      );
    }
    await this.discardUnreferencedMedia(assets);
  }

  /**
   * Writes the capture's admitted images into managed storage.
   *
   * Identical bytes converge on one content-addressed file, so an image shared
   * between two articles — or repeated within one — is stored once.
   */
  private async storeArticleMedia(
    prepared: PreparedWebArticle
  ): Promise<readonly NewDocumentAsset[]> {
    if (prepared.media.length === 0) return [];
    const stored: NewDocumentAsset[] = [];
    try {
      for (const asset of prepared.media) {
        const result = await this.storage.ingestGeneratedContent(asset.bytes, asset.extension);
        stored.push({
          reference: asset.reference,
          assetHash: asset.hash,
          extension: asset.extension,
          mimeType: asset.mimeType,
          filePath: result.finalPath,
          byteSize: asset.bytes.byteLength,
          width: asset.width,
          height: asset.height,
        });
      }
    } catch (error) {
      await this.discardUnreferencedMedia(stored);
      throw safeWebArticleError(error instanceof Error ? error : null);
    }
    return stored;
  }

  /**
   * Removes managed image files that no document row refers to.
   *
   * The reference check is what makes this safe to call on any failed or
   * superseded capture: a file that another document — or the same document's
   * surviving rows — still points at is left alone, and anything genuinely
   * unreferenced that this misses is still collected by reconciliation later.
   */
  private async discardUnreferencedMedia(
    assets: readonly { readonly filePath: string }[]
  ): Promise<void> {
    if (assets.length === 0) return;
    for (const asset of assets) {
      await this.storage.deleteManagedFileIfOrphaned(asset.filePath, () =>
        this.documentAssets.listAllPaths().includes(asset.filePath)
      );
    }
  }

  /**
   * Points an existing capture at fresh content without disturbing its identity.
   *
   * The row swap and the asset swap commit together, so the document is never
   * described by one capture's Markdown and another's images. Superseded files
   * are removed only afterwards and only once nothing refers to them, which
   * makes a failure here a no-op rather than a document with missing content.
   * Every capability the previous content had is revoked, since a stale image
   * URL must not survive into the new snapshot's reader.
   */
  private async upgradeCapturedArticle(
    existing: DocumentRecordWithReadingPosition,
    prepared: PreparedWebArticle,
    ingestResult: IngestResult,
    assets: readonly NewDocumentAsset[]
  ): Promise<DocumentMetadata> {
    const supersededPath = existing.filePath;
    const supersededAssets: readonly DocumentAssetRecord[] =
      this.documentAssets.listForDocument(existing.id);

    const updated = this.withTransaction(() => {
      const replaced = this.documents.replaceCapturedSnapshot(existing.id, {
        title: prepared.title,
        author: prepared.author,
        filePath: ingestResult.finalPath,
        fileSize: ingestResult.fileSize,
        fileMtimeMs: ingestResult.fileMtimeMs,
        fileHash: ingestResult.fileHash,
        siteName: prepared.source.siteName,
        capturedAt: prepared.source.capturedAt,
      });
      if (!replaced) {
        throw new InterleafError('internal', 'That article could not be updated in place.');
      }
      this.documentAssets.replaceForDocument(existing.id, assets);
      const record = this.documents.findById(existing.id);
      if (record === null) {
        throw new InterleafError('internal', 'That article could not be updated in place.');
      }
      return record;
    });

    // The reader is holding capabilities for content that no longer exists.
    this.assetRegistry.unregisterDocument(existing.id);
    this.knownHealthByDocumentId.delete(existing.id);

    if (supersededPath !== ingestResult.finalPath) {
      await this.storage.deleteManagedFileIfOrphaned(
        supersededPath,
        () => this.documents.countByFilePath(supersededPath) > 0
      );
    }
    await this.discardUnreferencedMedia(supersededAssets);

    this.log.info('Upgraded web article capture in place', {
      id: existing.id,
      images: assets.length,
    });
    return this.mapToDocumentMetadata(updated);
  }

  /** Resolves and validates the requested destination folder. */
  private resolveTargetFolderId(options?: DocumentImportOptions): string | null {
    const requested =
      options?.folderId && options.folderId.trim().length > 0 ? options.folderId.trim() : null;
    if (requested !== null && !this.folders.findById(requested)) {
      throw new InterleafError('validation', 'That folder no longer exists.');
    }
    return requested;
  }

  private async assertLinkedFileStillMatches(ingestResult: IngestResult): Promise<void> {
    const verifiedHash = await this.storage.computeFileHash(ingestResult.finalPath);
    if (verifiedHash !== ingestResult.fileHash) {
      throw new InterleafError(
        'validation',
        'The linked file changed while Interleaf was inspecting it.'
      );
    }
  }

  /**
   * The document a concurrent import already inserted for this hash.
   *
   * The database uniqueness constraint is the authority on that race, so only
   * the constraint failure is treated as one; every other insert failure keeps
   * its own meaning and is rethrown by the caller.
   */
  private racedImport(
    caught: Error | null,
    fileHash: string,
  ): DocumentRecordWithReadingPosition | undefined {
    if (!isUniqueFileHashConstraintError(caught)) return undefined;
    return this.documents.findByHash(fileHash)[0];
  }

  private async reconcileExistingImport(
    existing: DocumentRecordWithReadingPosition,
    ingestResult: IngestResult,
    storageMode: StorageMode,
    targetFolderId: string | null
  ): Promise<DocumentMetadata> {
    const storageChanged =
      existing.storageMode !== storageMode || existing.filePath !== ingestResult.finalPath;
    try {
      this.withTransaction(() => {
        if (storageChanged) {
          this.documents.updateStorageReference(
            existing.id,
            ingestResult.finalPath,
            storageMode,
            ingestResult.fileSize,
            ingestResult.fileMtimeMs
          );
        }
        if (existing.folderId !== targetFolderId) {
          this.documents.moveToFolder(existing.id, targetFolderId);
        }
      });
    } catch (error) {
      if (
        storageMode === 'managed' &&
        !ingestResult.isDeduplicated &&
        existing.filePath !== ingestResult.finalPath
      ) {
        await this.storage.deleteManagedFileIfOrphaned(ingestResult.finalPath, false);
      }
      throw error;
    }

    if (
      storageChanged &&
      existing.storageMode === 'managed' &&
      existing.filePath !== ingestResult.finalPath
    ) {
      const stillReferenced = this.documents.countByFilePath(existing.filePath) > 0;
      await this.storage.deleteManagedFileIfOrphaned(existing.filePath, stillReferenced);
    }
    const current = this.documents.findById(existing.id) ?? existing;
    this.log.info('Document binary already exists, reusing logical record', {
      id: existing.id,
    });
    return this.mapToDocumentMetadata(current);
  }

  async importFiles(
    filePaths: readonly string[],
    options?: DocumentImportOptions
  ): Promise<BatchImportResult> {
    if (filePaths.length > 32) {
      throw new InterleafError('validation', 'A maximum of 32 documents can be imported at once.');
    }
    const uniquePaths = [...new Set(filePaths)];
    const imported: DocumentMetadata[] = [];
    const failed: ImportFileError[] = [];

    for (const p of uniquePaths) {
      try {
        const doc = await this.importFile(p, options);
        imported.push(doc);
      } catch (err) {
        const message = safeImportError(err instanceof Error ? err : null);
        this.log.warn('Failed to import document', {
          errorType: err instanceof Error ? err.name : typeof err,
          errorCode: err instanceof InterleafError ? err.code : 'unknown',
        });
        failed.push({
          fileName: basename(p),
          error: message,
        });
      }
    }

    return {
      imported,
      failed,
      totalAttempted: uniquePaths.length,
    };
  }

  async openFileDialog(
    options: DocumentImportOptions | undefined,
    parentWindow: BrowserWindow | null
  ): Promise<BatchImportResult> {
    const dialogOptions: OpenDialogOptions = {
      title: 'Import Documents to Interleaf',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: DOCUMENT_FILE_FILTERS,
    };
    const dialogResult = await (parentWindow !== null
      ? dialog.showOpenDialog(parentWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions));

    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { imported: [], failed: [], totalAttempted: 0 };
    }

    return this.importFiles(dialogResult.filePaths, options);
  }

  private async mapConcurrent<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await fn(item);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  listDocuments(filter?: DocumentFilter): Promise<readonly DocumentMetadata[]> {
    const records = this.documents.list({
      ...filter,
      limit: filter?.limit ?? 50,
      offset: filter?.offset ?? 0,
    });
    const docs = records.map((r) => this.mapToDocumentMetadataFast(r));
    const checkingIds = docs.filter((d) => d.storageHealth === 'checking').map((d) => d.id);
    if (checkingIds.length > 0) {
      this.scheduleBackgroundHealthScan(checkingIds);
    }
    return Promise.resolve(docs);
  }

  async getDocument(id: string): Promise<DocumentMetadata | null> {
    const record = this.documents.findById(id);
    if (!record) return null;
    return this.mapToDocumentMetadata(record, true);
  }
  async openDocument(id: string): Promise<OpenedDocument> {
    return this.runLifecycleExclusive(() => this.openDocumentExclusive(id));
  }

  private async openDocumentExclusive(id: string): Promise<OpenedDocument> {
    const record = this.documents.findById(id);
    if (!record) {
      throw new InterleafError('media-not-found', `Document '${id}' not found.`);
    }

    const health = await this.storage.checkStorageHealth(
      record.filePath,
      record.storageMode,
      record.fileHash,
      record.fileSize,
      record.fileMtimeMs,
      false
    );
    if (health.status !== 'ok') {
      throw new InterleafError(
        health.status === 'missing' ? 'media-not-found' : 'validation',
        health.message ?? 'The document no longer matches the imported content.'
      );
    }

    const doc = await this.mapToDocumentMetadata(record);
    const effectiveScopeId = this.currentScopeId();
    let assetFilePath = record.filePath;
    const permittedRoot = this.storage.rootPath;

    if (record.storageMode === 'link') {
      assetFilePath = await this.storage.stageLinkedFile(
        record.filePath,
        record.fileHash,
        record.format
      );
    }

    this.assetRegistry.activateDocument(effectiveScopeId, record.id);
    let mediaUrl: string;
    try {
      ({ mediaUrl } = await this.assetRegistry.registerAsset({
        filePath: assetFilePath,
        permittedRoot,
        documentId: record.id,
        scopeId: effectiveScopeId,
        ttlMs: 60 * 60 * 1000,
      }));
    } finally {
      await this.reconcileStagedReaderAssets();
    }

    const mediaAssets = await this.registerDocumentMedia(record.id, effectiveScopeId);

    this.log.info('Opened document for reading', {
      id: record.id,
      format: record.format,
      mediaAssets: mediaAssets.length,
    });
    return {
      document: doc,
      assetUrl: mediaUrl,
      mediaAssets,
    };
  }

  /**
   * Issues one short-lived capability per archived image of an open document.
   *
   * The renderer only ever learns the pairing of a durable reference to an
   * opaque URL; the managed path stays in main. Capabilities are bound to this
   * document in this scope, so closing the document, switching to another, or
   * deleting it stops every one of them resolving. An image whose file has gone
   * missing is skipped rather than failing the open — the article still reads.
   */
  private async registerDocumentMedia(
    documentId: string,
    scopeId: string
  ): Promise<readonly DocumentMediaAsset[]> {
    const records = this.documentAssets.listForDocument(documentId);
    if (records.length === 0) return [];

    const registry = this.assetRegistry;
    const permittedRoot = this.storage.rootPath;
    const registered: DocumentMediaAsset[] = [];
    for (const record of records) {
      try {
        const { mediaUrl } = await registry.registerAsset({
          filePath: record.filePath,
          permittedRoot,
          documentId,
          scopeId,
          ttlMs: 60 * 60 * 1000,
        });
        registered.push({
          reference: record.reference,
          url: mediaUrl,
          width: record.width,
          height: record.height,
        });
      } catch (error) {
        this.log.warn('Skipped an archived article image', {
          id: documentId,
          errorCode: error instanceof InterleafError ? error.code : 'unknown',
        });
      }
    }
    return registered;
  }

  closeDocument(id: string): Promise<void> {
    return this.runLifecycleExclusive(async () => {
      this.assetRegistry.unregisterDocumentInScope(id, this.currentScopeId());
      await this.reconcileStagedReaderAssets();
    });
  }

  private async reconcileStagedReaderAssets(): Promise<void> {
    await this.storage.reconcileUnusedStagedFiles(
      this.assetRegistry.getRegisteredCanonicalPaths()
    );
  }


  async deleteDocument(id: string): Promise<void> {
    return this.runLifecycleExclusive(() => this.deleteDocumentExclusive(id));
  }

  private async deleteDocumentExclusive(id: string): Promise<void> {
    // Read before the delete: the asset rows cascade away with the document,
    // and without their paths its images would only be reclaimed by the next
    // reconciliation pass instead of now.
    const ownedMedia = this.documentAssets.listForDocument(id);
    const record = this.withTransaction(() => {
      const deleted = this.documents.delete(id);
      this.readingPositions.delete(id);
      return deleted;
    });
    if (!record) return;
    await this.discardUnreferencedMedia(ownedMedia);

    if (record.storageMode === 'managed') {
      await this.storage.deleteManagedFileIfOrphaned(
        record.filePath,
        () => this.documents.countByFilePath(record.filePath) > 0
      );
    }
    // Revoke every renderer capability immediately, including library-cover
    // URLs issued to cards in other scopes. The persisted PNG itself is
    // content-addressed and may still be needed by another document row.
    this.assetRegistry.unregisterDocument(record.id);
    if (record.format === 'pdf' && this.documents.findByHash(record.fileHash).length === 0) {
      await this.storage.removeCoverSnapshot(record.fileHash);
    }
    this.knownHealthByDocumentId.delete(id);
    this.log.info('Deleted document from library', { id });
  }

  getContinueReading(limit?: number): Promise<readonly DocumentMetadata[]> {
    const records = this.documents.getContinueReading(limit);
    const docs = records.map((r) => this.mapToDocumentMetadataFast(r));
    const checkingIds = docs.filter((d) => d.storageHealth === 'checking').map((d) => d.id);
    if (checkingIds.length > 0) {
      this.scheduleBackgroundHealthScan(checkingIds);
    }
    return Promise.resolve(docs);
  }

  getRecentlyAdded(limit?: number): Promise<readonly DocumentMetadata[]> {
    const records = this.documents.getRecentlyAdded(limit);
    const docs = records.map((r) => this.mapToDocumentMetadataFast(r));
    const checkingIds = docs.filter((d) => d.storageHealth === 'checking').map((d) => d.id);
    if (checkingIds.length > 0) {
      this.scheduleBackgroundHealthScan(checkingIds);
    }
    return Promise.resolve(docs);
  }

  getRecentlyRead(limit?: number): Promise<readonly DocumentMetadata[]> {
    const records = this.documents.getRecentlyRead(limit);
    const docs = records.map((r) => this.mapToDocumentMetadataFast(r));
    const checkingIds = docs.filter((d) => d.storageHealth === 'checking').map((d) => d.id);
    if (checkingIds.length > 0) {
      this.scheduleBackgroundHealthScan(checkingIds);
    }
    return Promise.resolve(docs);
  }

  getSummary(): Promise<LibrarySummary> {
    const counts = this.documents.getSummaryCounts();
    this.scheduleBackgroundHealthScan(undefined, true);
    let missingCount = 0;
    let changedCount = 0;

    for (const health of this.knownHealthByDocumentId.values()) {
      if (health === 'missing') missingCount++;
      if (health === 'changed') changedCount++;
    }

    return Promise.resolve({
      totalDocuments: counts.totalDocuments,
      formatCounts: counts.formatCounts,
      managedCount: counts.managedCount,
      linkCount: counts.linkCount,
      missingCount,
      changedCount,
      totalFolders: counts.totalFolders,
    });
  }

  createFolder(name: string, parentId?: string | null): Folder {
    const id = randomUUID();
    const created = this.folders.create(id, name, parentId);
    this.log.info('Created folder', { id: created.id });
    return created;
  }

  renameFolder(id: string, name: string): Folder {
    const updated = this.folders.rename(id, name);
    this.log.info('Renamed folder', { id: updated.id });
    return updated;
  }

  deleteFolder(id: string): void {
    this.folders.delete(id);
    this.log.info('Deleted folder', { id });
  }

  listFolders(): readonly Folder[] {
    return this.folders.list();
  }

  getFolderTree(): readonly FolderTree[] {
    return this.folders.getTree();
  }

  moveDocumentToFolder(documentId: string, folderId: string | null): void {
    const doc = this.documents.findById(documentId);
    if (!doc) {
      throw new InterleafError('validation', `Document with ID '${documentId}' not found.`);
    }

    if (folderId !== null && folderId.trim().length > 0) {
      const folder = this.folders.findById(folderId.trim());
      if (!folder) {
        throw new InterleafError('validation', `Target folder '${folderId}' not found.`);
      }
    }

    this.documents.moveToFolder(documentId, folderId);
    this.log.info('Moved document to folder', { documentId, folderId });
  }

  updateReadingPosition(
    documentId: string,
    location: DocumentLocation,
    progress: number
  ): ReadingPosition {
    const doc = this.documents.findById(documentId);
    if (!doc) {
      throw new InterleafError('validation', `Document with ID '${documentId}' not found.`);
    }
    if (location.format !== doc.format) {
      throw new InterleafError(
        'validation',
        'The reading location format does not match the document format.'
      );
    }

    const locationJson = JSON.stringify(location);
    const updated = this.readingPositions.upsert(documentId, locationJson, progress);
    return {
      location,
      progress: updated.progress,
      updatedAt: updated.updatedAt,
    };
  }

  getDocumentPreview(
    documentId: string,
    location?: DocumentLocation | null
  ): Promise<DocumentPreviewData> {
    // Preview generation can create persisted cover artifacts and renderer
    // capabilities. Keep it in the same lifecycle queue as delete/import so
    // a document cannot be deleted halfway through those side effects.
    return this.runLifecycleExclusive(() => this.previewService.getDocumentPreview(documentId, location));
  }
  private withTransaction<T>(operation: () => T): T {
    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.raw.exec('ROLLBACK');
      throw error;
    }
  }
}
