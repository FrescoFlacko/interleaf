import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { InterleafDatabase } from '../db/database';
import { SearchPreviewChunks } from '../db/repositories/search-preview-chunks';
import type { DocumentRepository } from '../db/repositories/document-repository';
import type { ReadingPositionRepository } from '../db/repositories/reading-position-repository';
import type { Logger } from '../logging/logger';
import type { StorageManager, StorageSourceIdentity, StorageSourceLease } from './storage-manager';
import type { AssetRegistry } from '../security/asset-registry';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parseDocumentLocation } from '@shared/schemas/document';
import { parsePortableJson } from '@shared/models/portable';
import type {
  DocumentLocation,
  DocumentPreviewData,
} from '@shared/types/document';
import { extractPreviewInWorker, MAX_ARCHIVE_BYTES } from '../workers/preview-extract-worker';
import { hasParagraphFormat, type ParagraphFormat } from '@shared/document-format-family';

function sourceIdentityMatches(left: StorageSourceIdentity, right: StorageSourceIdentity): boolean {
  return left.canonicalPath === right.canonicalPath
    && left.fileSize === right.fileSize
    && left.fileMtimeMs === right.fileMtimeMs
    && left.fileCtimeMs === right.fileCtimeMs
    && left.device === right.device
    && left.inode === right.inode;
}

/** Sentinel used to select the source-invalidation cleanup path without a
 * mutable flag whose value is lost to control-flow analysis after rethrows. */
class SourceIdentityInvalidError extends Error {
  constructor() {
    super('The PDF source changed during preview generation.');
    this.name = 'SourceIdentityInvalidError';
  }
}

export type PreviewServiceDeps = {
  readonly db: InterleafDatabase;
  readonly documents: DocumentRepository;
  readonly readingPositions: ReadingPositionRepository;
  readonly log: Logger;
  readonly storage: StorageManager;
  readonly assetRegistry: AssetRegistry;
  readonly currentScopeId: () => string;
};

const DEFAULT_LOCATION_LABELS: ReadonlyMap<string, string> = new Map([
  ['epub', 'Cover'],
  ['mobi', 'Cover'],
  ['pptx', 'Slide 1'],
]);

const FILE_SNIPPET_FORMATS: ReadonlySet<string> = new Set(['pdf', 'epub', 'docx', 'markdown']);

function paragraphLocationLabel(location: Extract<DocumentLocation, { readonly format: ParagraphFormat }>): string {
  return location.format === 'pptx'
    ? `Slide ${String((location.renderedPageIndex ?? 0) + 1)}`
    : `Para ${String(location.paragraphIndex + 1)}`;
}

/** The label for a preview read from an indexed chunk at `location`; only locations a chunk query can match reach here. */
function indexedLocationLabel(location: DocumentLocation, chunkPageLabel: string | null): string {
  if (location.format === 'pdf') return location.pageLabel ?? chunkPageLabel ?? `Page ${String(location.pageIndex + 1)}`;
  if (location.format === 'markdown') return location.headingId ? `# ${location.headingId}` : `Section ${String(location.blockIndex + 1)}`;
  if (hasParagraphFormat(location)) return paragraphLocationLabel(location);
  return location.format === 'epub' && location.spineHref ? `Section ${location.spineHref}` : '';
}

export class PreviewService {
  /** Committed chunk text, read through the search index's own preview query. */
  private readonly indexedChunks: SearchPreviewChunks;
  private readonly documents: DocumentRepository;
  private readonly readingPositions: ReadingPositionRepository;
  private readonly log: Logger;
  private readonly storage: StorageManager;
  private readonly assetRegistry: AssetRegistry;
  private readonly currentScopeId: () => string;

  constructor(deps: PreviewServiceDeps) {
    this.indexedChunks = new SearchPreviewChunks(deps.db);
    this.documents = deps.documents;
    this.readingPositions = deps.readingPositions;
    this.log = deps.log;
    this.storage = deps.storage;
    this.assetRegistry = deps.assetRegistry;
    this.currentScopeId = deps.currentScopeId;
  }

  async getDocumentPreview(
    documentId: string,
    requestedLocation?: DocumentLocation | null
  ): Promise<DocumentPreviewData> {
    const doc = this.documents.findById(documentId);
    if (!doc) {
      throw new InterleafError('media-not-found', `Document '${documentId}' not found.`);
    }

    const readingPos = this.readingPositions.findByDocumentId(documentId);
    let activeLocation: DocumentLocation | null = null;
    if (readingPos) {
      try {
        activeLocation = parseDocumentLocation(parsePortableJson(readingPos.locationJson));
      } catch {
        activeLocation = null;
      }
    }

    const hasReadingProgress = Boolean(readingPos && readingPos.progress > 0 && activeLocation);
    const effectiveLocation =
      requestedLocation ??
      (hasReadingProgress ? activeLocation : null);

    const isRequestedLastRead = Boolean(
      hasReadingProgress &&
      activeLocation &&
      (requestedLocation === undefined || requestedLocation === null || JSON.stringify(requestedLocation) === JSON.stringify(activeLocation))
    );

    const coverAssetUrl = await this.ensurePdfCover(doc);

    // 1. Try the bounded, location-specific indexed lookup when available.
    const indexedResult = this.tryExcerptFromIndexedChunks(doc.id, doc.format, effectiveLocation, isRequestedLastRead);
    if (indexedResult !== null) {
      return {
        documentId: doc.id,
        format: doc.format,
        locationLabel: indexedResult.locationLabel,
        isLastRead: indexedResult.isLastRead,
        snippet: indexedResult.snippet,
        // Covers are not persisted as renderer capabilities.  A media URL is
        // only issued by AssetRegistry for an explicitly opened document; a
        // value in the documents table is never trusted as a capability.
        coverAssetUrl,
        fallback: false,
      };
    }

    // 2. Extract bounded excerpt via isolated worker process
    try {
      const fileResult = await this.extractFileSnippetInWorker(doc.filePath, doc.format, effectiveLocation, isRequestedLastRead);
      if (fileResult !== null) {
        return {
          documentId: doc.id,
          format: doc.format,
          locationLabel: fileResult.locationLabel,
          isLastRead: fileResult.isLastRead,
          snippet: fileResult.snippet,
          coverAssetUrl,
          fallback: false,
        };
      }
    } catch (err) {
      // Redacted logging: never log err.message which might contain local filesystem paths
      this.log.info('Direct preview extraction failed, using fallback summary', {
        documentId: doc.id,
        errorCode: err instanceof InterleafError ? err.code : err instanceof Error ? err.name : 'UnknownError',
      });
    }

    // 3. Fallback preview summary with honest location label
    const defaultLabel = this.resolveDefaultLocationLabel(doc.format);
    const fallbackSnippet = `${doc.title}${doc.author ? ` — ${doc.author}` : ''} (${defaultLabel})`;
    return {
      documentId: doc.id,
      format: doc.format,
      locationLabel: defaultLabel,
      isLastRead: false,
      snippet: fallbackSnippet,
      coverAssetUrl,
      fallback: true,
    };
  }

  private resolveDefaultLocationLabel(format: string): string {
    return DEFAULT_LOCATION_LABELS.get(format) ?? 'Page 1';
  }

  /**
   * Lazily creates and registers a PDF page-one cover. This keeps import fast,
   * while the first visible card deterministically fills the persisted cache.
   */
  private async ensurePdfCover(doc: {
    readonly id: string;
    readonly format: string;
    readonly filePath: string;
    readonly storageMode: 'managed' | 'link';
    readonly fileHash: string;
    readonly fileSize: number;
    readonly fileMtimeMs: number;
  }): Promise<string | null> {
    if (doc.format !== 'pdf') return null;

    const storage = this.storage;
    const assetRegistry = this.assetRegistry;
    let lease: StorageSourceLease | undefined;
    const clearCoverForCurrentHash = async (): Promise<void> => {
      this.documents.updateCoverPath(doc.id, doc.fileHash, null);
      if (!this.documents.findByHash(doc.fileHash).some((record) => record.id !== doc.id)) {
        await storage.removeCoverSnapshot(doc.fileHash);
      }
    };

    try {
      // This is the sole authoritative content-hash pass for a link-in-place
      // preview. Every later source check uses the identity lease instead of
      // hashing the entire linked file again.
      const health = await storage.checkStorageHealth(
        doc.filePath,
        doc.storageMode,
        doc.fileHash,
        doc.fileSize,
        doc.fileMtimeMs,
        false
      );
      if (health.status !== 'ok') {
        // A changed/missing source can never reuse a cover produced from its
        // previous bytes. Retain a shared artifact until its last row is gone.
        await clearCoverForCurrentHash();
        return null;
      }
      if (!health.sourceIdentity) {
        await clearCoverForCurrentHash();
        return null;
      }

      lease = await storage.openSourceLease(doc.filePath);
      if (!sourceIdentityMatches(health.sourceIdentity, lease)) {
        await clearCoverForCurrentHash();
        return null;
      }
      try {
        await lease.assertUnchanged();
      } catch {
        throw new SourceIdentityInvalidError();
      }

      let coverPath = await storage.getCoverSnapshot(doc.fileHash);
      if (coverPath === null) {
        // The renderer worker receives only this main-authorized canonical path
        // and an identity tuple. It fetches 64KiB PDF ranges itself, so a valid
        // 2GiB import never gets copied into main memory or workerData.
        const result = await extractPreviewInWorker(
          {
            format: 'pdf',
            filePath: lease.canonicalPath,
            permittedRoot: dirname(lease.canonicalPath),
            expectedFileSize: lease.fileSize,
            expectedFileMtimeMs: lease.fileMtimeMs,
            expectedFileCtimeMs: lease.fileCtimeMs,
            expectedFileDevice: lease.device,
            expectedFileInode: lease.inode,
            renderCover: true,
          },
          { timeoutMs: 15_000 }
        );
        if (!result.coverPng) return null;
        try {
          await lease.assertUnchanged();
        } catch {
          throw new SourceIdentityInvalidError();
        }
        const beforePersist = this.documents.findById(doc.id);
        if (beforePersist?.fileHash !== doc.fileHash) {
          await clearCoverForCurrentHash();
          return null;
        }
        coverPath = await storage.writeCoverSnapshot(doc.fileHash, result.coverPng);
      }

      // Pre-publish lease validation covers both reused and newly rendered
      // snapshots without another whole-file hash pass.
      try {
        await lease.assertUnchanged();
      } catch {
        throw new SourceIdentityInvalidError();
      }
      // The branch above either returned on an unavailable cover or assigned
      // the string returned by writeCoverSnapshot, so publication has a
      // validated, non-null path at this point.
      const coverPathToPublish: string = coverPath;

      // Persist the canonical path only as main-owned metadata; the renderer
      // receives a newly registered opaque capability below.
      const current = this.documents.findById(doc.id);
      if (current?.fileHash !== doc.fileHash) {
        await clearCoverForCurrentHash();
        return null;
      }
      if (current.coverPath !== coverPathToPublish) {
        this.documents.updateCoverPath(doc.id, doc.fileHash, coverPathToPublish);
      }
      const beforeRegister = this.documents.findById(doc.id);
      if (beforeRegister?.fileHash !== doc.fileHash) {
        await clearCoverForCurrentHash();
        return null;
      }
      try {
        await lease.assertUnchanged();
      } catch {
        throw new SourceIdentityInvalidError();
      }
      const scopeId = this.currentScopeId();
      const registered = await assetRegistry.registerAsset({
        filePath: coverPathToPublish,
        permittedRoot: storage.rootPath,
        documentId: doc.id,
        scopeId,
        kind: 'library-cover',
        ttlMs: 60 * 60 * 1000,
      });
      return registered.mediaUrl;
    } catch (error) {
      if (error instanceof SourceIdentityInvalidError) {
        await clearCoverForCurrentHash().catch(() => undefined);
      }
      this.log.info('PDF cover snapshot unavailable; using text preview', {
        documentId: doc.id,
        errorCode: error instanceof InterleafError ? error.code : error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    } finally {
      await lease?.close();
    }
  }

  private tryExcerptFromIndexedChunks(
    documentId: string,
    format: string,
    location: DocumentLocation | null,
    isRequestedLastRead: boolean
  ): { readonly snippet: string; readonly locationLabel: string; readonly isLastRead: boolean } | null {
    try {
      if (!location) {
        const first = this.indexedChunks.first(documentId);
        if (!first) return null;
        return {
          snippet: this.cleanSnippet(first.text, 240),
          locationLabel: this.resolveDefaultLocationLabel(format),
          isLastRead: false,
        };
      }
      const chunk = this.indexedChunks.at(documentId, location);
      if (!chunk) return null;
      return {
        snippet: this.cleanSnippet(chunk.text, 240),
        locationLabel: indexedLocationLabel(location, chunk.pageLabel),
        isLastRead: isRequestedLastRead,
      };
    } catch {
      return null;
    }
  }

  private async extractFileSnippetInWorker(
    filePath: string,
    format: string,
    location: DocumentLocation | null,
    isRequestedLastRead: boolean
  ): Promise<{ readonly snippet: string; readonly locationLabel: string; readonly isLastRead: boolean } | null> {
    let handle: FileHandle | undefined;
    try {
      // MOBI and PPTX previews come only from indexed chunks.
      if (!FILE_SNIPPET_FORMATS.has(format)) {
        return null;
      }

      const targetPageIndex = location?.format === 'pdf' ? location.pageIndex : undefined;
      const workerResult = format === 'pdf'
        ? await (async () => {
            const requestedPath = resolve(filePath);
            const leaf = await lstat(requestedPath);
            if (leaf.isSymbolicLink() || !leaf.isFile()) return null;
            const canonicalPath = await realpath(requestedPath);
            const stats = await stat(canonicalPath);
            if (!stats.isFile() || stats.size <= 0) return null;
            return extractPreviewInWorker({
              format: 'pdf',
              filePath: canonicalPath,
              permittedRoot: dirname(canonicalPath),
              expectedFileSize: stats.size,
              expectedFileMtimeMs: Math.round(stats.mtimeMs),
              expectedFileCtimeMs: Math.round(stats.ctimeMs),
              expectedFileDevice: stats.dev,
              expectedFileInode: stats.ino,
              targetPageIndex,
            });
          })()
        : await (async () => {
            handle = await open(filePath, 'r');
            const stats = await handle.stat();
            if (stats.size > MAX_ARCHIVE_BYTES) return null;
            const buffer = Buffer.alloc(stats.size);
            const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
            return extractPreviewInWorker({
              format: format as 'epub' | 'docx' | 'markdown' | 'mobi',
              buffer: buffer.subarray(0, bytesRead),
              targetBlockIndex: location?.format === 'markdown' ? location.blockIndex : undefined,
              targetParagraphIndex: location?.format === 'docx' ? location.paragraphIndex : undefined,
              targetSpineHref: location?.format === 'epub' ? location.spineHref : undefined,
            });
          })();

      if (workerResult === null) return null;

      if (!workerResult.snippet) {
        return null;
      }

      if (!location) {
        return {
          snippet: workerResult.snippet,
          locationLabel: this.resolveDefaultLocationLabel(format),
          isLastRead: false,
        };
      }

      // Determine honest location and isLastRead based on worker match
      if (location.format === 'pdf') {
        const isMatched = workerResult.actualPageIndex === location.pageIndex;
        const pageNum = (workerResult.actualPageIndex ?? 0) + 1;
        const label = isMatched && location.pageLabel ? location.pageLabel : `Page ${String(pageNum)}`;
        return {
          snippet: workerResult.snippet,
          locationLabel: label,
          isLastRead: isMatched && isRequestedLastRead,
        };
      }

      if (location.format === 'markdown') {
        const isMatched = workerResult.actualBlockIndex === location.blockIndex;
        const blockNum = (workerResult.actualBlockIndex ?? 0) + 1;
        const label = isMatched && location.headingId ? `# ${location.headingId}` : `Section ${String(blockNum)}`;
        return {
          snippet: workerResult.snippet,
          locationLabel: label,
          isLastRead: isMatched && isRequestedLastRead,
        };
      }

      if (location.format === 'docx') {
        const isMatched = workerResult.actualParagraphIndex === location.paragraphIndex;
        const paraNum = (workerResult.actualParagraphIndex ?? 0) + 1;
        return {
          snippet: workerResult.snippet,
          locationLabel: `Para ${String(paraNum)}`,
          isLastRead: isMatched && isRequestedLastRead,
        };
      }

      if (location.format === 'epub') {
        const isMatched = workerResult.isSpineMatched === true;
        return {
          snippet: workerResult.snippet,
          locationLabel: isMatched ? 'Last Read' : 'Cover',
          isLastRead: isMatched && isRequestedLastRead,
        };
      }

      return {
        snippet: workerResult.snippet,
        locationLabel: this.resolveDefaultLocationLabel(format),
        isLastRead: false,
      };
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  private cleanSnippet(text: string, maxLength: number): string {
    const cleaned = text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, maxLength - 1).trim()}…`;
  }
}
