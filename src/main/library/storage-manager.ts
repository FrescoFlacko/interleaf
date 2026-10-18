import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DocumentFormat, StorageHealth, StorageMode } from '@shared/types/document';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import { hashFileInWorker } from '../workers/hash-file-worker';
import { isStrictlyInside } from '../security/path-guard';

export type IngestResult = {
  readonly finalPath: string;
  readonly fileHash: string;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly isDeduplicated: boolean;
};

export type StorageHealthResult = {
  readonly status: StorageHealth;
  readonly message?: string;
  readonly updatedSize?: number;
  readonly updatedMtimeMs?: number;
  readonly sourceIdentity?: StorageSourceIdentity;
};


/**
 * Extensions Interleaf may create itself; user files keep their own extension.
 *
 * The rasters are article images archived beside a web-article snapshot. They
 * are admitted by signature before they reach storage, so this list only has to
 * stay in step with what the reader can display and with the managed-file name
 * pattern below.
 */
const GENERATED_CONTENT_EXTENSIONS: Record<string, true> = {
  '.md': true,
  '.png': true,
  '.jpg': true,
  '.gif': true,
  '.webp': true,
  '.avif': true,
};
/**
 * Names reconciliation is willing to consider for deletion.
 *
 * Anything else in the managed tree is left alone: an unexpected file is far
 * more likely to be someone else's than a leaked one of ours.
 */
const MANAGED_FILE_NAME =
  /^[a-f0-9]{64}\.(pdf|epub|mobi|azw|azw3|docx|pptx|md|markdown|png|jpg|gif|webp|avif)$/;
/** Maximum persisted cover size accepted from the raster worker. */
const MAX_COVER_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_COVER_DIMENSION = 2048;

export type StorageSourceIdentity = {
  readonly canonicalPath: string;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileCtimeMs: number;
  readonly device: number;
  readonly inode: number;
};

type StableSource = StorageSourceIdentity & {
  readonly handle: FileHandle;
};

export type StorageSourceLease = StorageSourceIdentity & {
  readonly assertUnchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
};

function isSafePngSnapshot(data: Uint8Array): boolean {
  if (data.byteLength < 24 || data.byteLength > MAX_COVER_SNAPSHOT_BYTES) return false;
  if (!Buffer.from(data.subarray(0, 8)).equals(PNG_SIGNATURE)) return false;
  // PNG's first chunk is IHDR and stores dimensions at fixed offsets.
  if (Buffer.from(data.subarray(12, 16)).toString('ascii') !== 'IHDR') return false;
  const width = Buffer.from(data).readUInt32BE(16);
  const height = Buffer.from(data).readUInt32BE(20);
  return width > 0 && height > 0 && width <= MAX_COVER_DIMENSION && height <= MAX_COVER_DIMENSION;
}

export type ReferencedPathProvider =
  | readonly string[]
  | (() => readonly string[] | Promise<readonly string[]>);

export type ReferencedHashProvider =
  | readonly string[]
  | (() => readonly string[] | Promise<readonly string[]>);

export class StorageManager {
  private static readonly LINK_HEALTH_CACHE_MS = 5_000;
  private readonly libraryRoot: string;
  private readonly tempDir: string;
  private readonly log: Logger;
  private readonly inFlightManagedFiles = new Set<string>();
  private readonly inFlightHealthChecks = new Map<
    string,
    Promise<StorageHealthResult>
  >();
  private readonly inFlightCoverWrites = new Map<string, Promise<string>>();
  private readonly linkHealthCache = new Map<
    string,
    { readonly checkedAt: number; readonly result: StorageHealthResult }
  >();
  constructor(libraryRoot: string, log: Logger) {
    this.libraryRoot = resolve(libraryRoot);
    this.tempDir = join(this.libraryRoot, '.tmp');
    this.log = log;
  }

  get rootPath(): string {
    return this.libraryRoot;
  }

  get tempDirPath(): string {
    return this.tempDir;
  }

  /**
   * Initializes library storage and reconciles any abandoned temp files on startup.
   */
  async initialize(): Promise<void> {
    await mkdir(this.libraryRoot, { recursive: true });
    await this.assertManagedRoot();
    await mkdir(this.tempDir, { recursive: true });
    await this.assertManagedDirectory(this.tempDir);
    const coverDir = join(this.libraryRoot, '.covers');
    await mkdir(coverDir, { recursive: true });
    await this.assertManagedDirectory(coverDir);
    await this.reconcileAbandonedTempFiles();
  }

  /**
   * Returns the verified, deterministic page-one cover path for a document.
   * The caller must still verify that the document's current content matches
   * the hash before issuing a renderer capability for this file.
   */
  async getCoverSnapshot(fileHash: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/i.test(fileHash)) return null;
    const coverDir = join(this.libraryRoot, '.covers');
    let canonicalDir: string;
    try {
      canonicalDir = await this.assertManagedDirectory(coverDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const target = join(canonicalDir, `${fileHash.toLowerCase()}.png`);
    try {
      const leaf = await lstat(target);
      if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.size > MAX_COVER_SNAPSHOT_BYTES) return null;
      const canonicalTarget = await realpath(target);
      if (!isStrictlyInside(canonicalDir, canonicalTarget)) return null;
      const data = await readFile(canonicalTarget);
      return isSafePngSnapshot(data) ? canonicalTarget : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.log.warn('Failed to inspect persisted PDF cover', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Atomically persists a worker-produced PNG under the hash-derived cover
   * path. Existing valid snapshots are reused, making retries idempotent.
   */
  async writeCoverSnapshot(fileHash: string, png: Uint8Array): Promise<string> {
    if (!/^[a-f0-9]{64}$/i.test(fileHash) || !isSafePngSnapshot(png)) {
      throw new InterleafError('validation', 'The PDF cover snapshot is invalid.');
    }
    const normalizedHash = fileHash.toLowerCase();
    const inFlight = this.inFlightCoverWrites.get(normalizedHash);
    if (inFlight !== undefined) return inFlight;
    const write = this.writeCoverSnapshotExclusive(normalizedHash, png);
    this.inFlightCoverWrites.set(normalizedHash, write);
    try {
      return await write;
    } finally {
      if (this.inFlightCoverWrites.get(normalizedHash) === write) {
        this.inFlightCoverWrites.delete(normalizedHash);
      }
    }
  }

  private async writeCoverSnapshotExclusive(fileHash: string, png: Uint8Array): Promise<string> {
    const coverDir = join(this.libraryRoot, '.covers');
    await mkdir(coverDir, { recursive: true });
    const canonicalDir = await this.assertManagedDirectory(coverDir);
    const target = join(canonicalDir, `${fileHash}.png`);
    const existing = await this.getCoverSnapshot(fileHash);
    if (existing !== null) return existing;

    try {
      const leaf = await lstat(target);
      if (leaf.isSymbolicLink()) {
        throw new InterleafError('security-violation', 'The PDF cover path is a symbolic link.');
      }
      if (!leaf.isFile()) {
        throw new InterleafError('security-violation', 'The PDF cover path is not a regular file.');
      }
      // An incomplete/corrupt regular snapshot is safe to replace after the
      // identity check above; symlink targets are never removed.
      const current = await this.getCoverSnapshot(fileHash);
      if (current !== null) return current;
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const tempPath = join(this.tempDir, `cover-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, Buffer.from(png), { flag: 'wx', mode: 0o600 });
      try {
        await rename(tempPath, target);
      } catch (error) {
        // Another process may have won the atomic replacement on platforms
        // where rename refuses an existing destination. Reuse only a verified
        // winner; never return an unvalidated path.
        const winner = await this.getCoverSnapshot(fileHash);
        if (winner !== null) return winner;
        throw error;
      }
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }

    const persisted = await this.getCoverSnapshot(fileHash);
    if (persisted === null) {
      throw new InterleafError('internal', 'The persisted PDF cover failed verification.');
    }
    return persisted;
  }

  /** Removes only the hash-derived cover owned by this application. */
  async removeCoverSnapshot(fileHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/i.test(fileHash)) return false;
    const coverDir = join(this.libraryRoot, '.covers');
    let canonicalDir: string;
    try {
      canonicalDir = await this.assertManagedDirectory(coverDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const target = join(canonicalDir, `${fileHash.toLowerCase()}.png`);
    try {
      const leaf = await lstat(target);
      if (leaf.isSymbolicLink() || !leaf.isFile()) return false;
      const canonicalTarget = await realpath(target);
      if (!isStrictlyInside(canonicalDir, canonicalTarget)) return false;
      await unlink(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      this.log.warn('Failed to remove persisted PDF cover', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  /**
   * Reconciles abandoned temporary files in the exact .tmp directory.
   */
  async reconcileAbandonedTempFiles(): Promise<number> {
    let cleanedCount = 0;
    try {
      await mkdir(this.tempDir, { recursive: true });
      const canonicalTemp = await this.assertManagedDirectory(this.tempDir);
      const entries = await readdir(canonicalTemp, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.tmp')) {
          const target = join(canonicalTemp, entry.name);
          try {
            await unlink(target);
            cleanedCount++;
          } catch (err) {
            this.log.warn('Failed to remove abandoned temp file', {
              errorType: err instanceof Error ? err.name : typeof err,
            });
          }
        }
      }
      if (cleanedCount > 0) {
        this.log.info(`Reconciled ${String(cleanedCount)} abandoned temp files.`);
      }
    } catch (err) {
      this.log.warn('Error during temp file reconciliation', {
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
    return cleanedCount;
  }

  /** Removes hash-shaped reader staging copies that have no live capability. */
  async reconcileUnusedStagedFiles(retainedPaths: ReadonlySet<string>): Promise<number> {
    const stagedDir = join(this.libraryRoot, '.staged');
    let canonicalStagedDir: string;
    try {
      canonicalStagedDir = await this.assertManagedDirectory(stagedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    let removed = 0;
    const entries = await readdir(canonicalStagedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!MANAGED_FILE_NAME.test(entry.name)) {
        continue;
      }
      const candidate = join(canonicalStagedDir, entry.name);
      try {
        const leaf = await lstat(candidate);
        if (leaf.isSymbolicLink()) {
          await unlink(candidate);
          removed += 1;
          continue;
        }
        if (!leaf.isFile()) continue;
        const canonicalCandidate = await realpath(candidate);
        if (!isStrictlyInside(canonicalStagedDir, canonicalCandidate)) {
          continue;
        }
        if (!retainedPaths.has(canonicalCandidate)) {
          const currentLeaf = await lstat(candidate);
          const currentPath = await realpath(candidate);
          if (
            currentLeaf.isSymbolicLink() ||
            !currentLeaf.isFile() ||
            currentLeaf.dev !== leaf.dev ||
            currentLeaf.ino !== leaf.ino ||
            currentPath !== canonicalCandidate ||
            !isStrictlyInside(canonicalStagedDir, currentPath)
          ) {
            continue;
          }
          // Unlink the contained directory entry, never a resolved target.
          await unlink(candidate);
          removed += 1;
        }
      } catch (error) {
        this.log.warn('Failed to reconcile a staged reader asset', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    if (removed > 0) {
      this.log.info('Reconciled unused staged reader assets', { removed });
    }
    return removed;
  }

  /**
   * Removes old, hash-shaped managed blobs that no database row references.
   * A grace period avoids racing a current import and makes crash recovery
   * conservative. Symlinks and unexpected directory entries are never followed.
   */
  async reconcileOrphanedManagedFiles(
    referencedPaths: ReferencedPathProvider,
    minimumAgeMs = 10 * 60 * 1000
  ): Promise<number> {
    const canonicalRoot = await this.assertManagedRoot();
    const getFreshReferencedSet = async (): Promise<Set<string>> => {
      const paths =
        typeof referencedPaths === 'function'
          ? await referencedPaths()
          : referencedPaths;
      return new Set(paths.map((path) => resolve(path)));
    };
    const referenced = await getFreshReferencedSet();
    const cutoff = Date.now() - Math.max(0, minimumAgeMs);
    let removed = 0;
    const prefixes = await readdir(canonicalRoot, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixPath = join(canonicalRoot, prefix.name);
      const canonicalPrefix = await this.assertManagedDirectory(prefixPath);
      const entries = await readdir(canonicalPrefix, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !MANAGED_FILE_NAME.test(entry.name)) {
          continue;
        }
        const candidate = join(canonicalPrefix, entry.name);
        if (referenced.has(candidate) || this.inFlightManagedFiles.has(candidate)) {
          continue;
        }
        try {
          const [leaf, canonicalCandidate] = await Promise.all([
            lstat(candidate),
            realpath(candidate),
          ]);
          if (
            leaf.isSymbolicLink() ||
            !leaf.isFile() ||
            !isStrictlyInside(canonicalRoot, canonicalCandidate) ||
            leaf.mtimeMs > cutoff ||
            this.inFlightManagedFiles.has(canonicalCandidate)
          ) {
            continue;
          }
          if (typeof referencedPaths === 'function') {
            const freshReferenced = await getFreshReferencedSet();
            if (
              freshReferenced.has(candidate) ||
              freshReferenced.has(canonicalCandidate) ||
              this.inFlightManagedFiles.has(canonicalCandidate)
            ) {
              continue;
            }
          }
          await unlink(canonicalCandidate);
          removed += 1;
        } catch (error) {
          this.log.warn('Failed to reconcile an orphaned managed file', {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    }
    if (removed > 0) {
      this.log.info('Reconciled orphaned managed files', { removed });
    }
    return removed;
  }

  /**
   * Computes SHA-256 hash of a file by streaming its contents.
   */
  async computeFileHash(filePath: string): Promise<string> {
    const source = await this.openStableSource(filePath);
    try {
      const digest = await this.hashStableSource(source);
      await this.assertSourceUnchanged(source);
      return digest;
    } finally {
      await source.handle.close().catch(() => undefined);
    }
  }

  /**
   * Opens a main-owned source identity lease for bounded downstream reads.
   * The handle remains private to this process; callers receive only the
   * canonical path and an assertion/close pair for lifecycle checks.
   */
  async openSourceLease(filePath: string): Promise<StorageSourceLease> {
    const source = await this.openStableSource(filePath);
    let closed = false;
    return {
      canonicalPath: source.canonicalPath,
      fileSize: source.fileSize,
      fileMtimeMs: source.fileMtimeMs,
      fileCtimeMs: source.fileCtimeMs,
      device: source.device,
      inode: source.inode,
      assertUnchanged: async () => {
        if (closed) {
          throw new InterleafError('validation', 'The source identity lease is closed.');
        }
        await this.assertSourceUnchanged(source);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await source.handle.close().catch(() => undefined);
      },
    };
  }

  /**
   * Ingests a file in either 'managed' or 'link' mode.
   */
  async ingestFile(sourcePath: string, mode: StorageMode): Promise<IngestResult> {
    const source = await this.openStableSource(sourcePath);

    if (mode === 'link') {
      try {
        const fileHash = await this.hashStableSource(source);
        await this.assertSourceUnchanged(source);
        const cacheKey = `${source.canonicalPath}\0${fileHash}\0${String(source.fileSize)}\0${String(source.fileMtimeMs)}`;
        this.linkHealthCache.set(cacheKey, {
          checkedAt: Date.now(),
          result: { status: 'ok', sourceIdentity: this.toSourceIdentity(source) },
        });
        return {
          finalPath: source.canonicalPath,
          fileHash,
          fileSize: source.fileSize,
          fileMtimeMs: source.fileMtimeMs,
          isDeduplicated: false,
        };
      } finally {
        await source.handle.close().catch(() => undefined);
      }
    }

    // Managed Copy Mode:
    // 1. Stream to .tmp with SHA-256 computation. The source handle is owned
    // from this point forward, including failures while preparing .tmp.
    let tempFile: string | undefined;
    try {
      await mkdir(this.tempDir, { recursive: true });
      const canonicalTemp = await this.assertManagedDirectory(this.tempDir);
      tempFile = join(canonicalTemp, `import-${randomUUID()}.tmp`);
      const readStream = source.handle.createReadStream({
        start: 0,
        autoClose: false,
        highWaterMark: 64 * 1024,
      });
      const writeStream = createWriteStream(tempFile, { flags: 'wx', mode: 0o600 });
      await pipeline(readStream, writeStream);
      await this.assertSourceUnchanged(source);

      const fileHash = await this.computeFileHash(tempFile);
      const ext = extname(source.canonicalPath).toLowerCase();
      return await this.placeManagedFile(tempFile, fileHash, ext);
    } catch (err) {
      if (err instanceof InterleafError) {
        throw err;
      }
      throw new InterleafError('internal', 'Failed to copy the selected file into managed storage.');
    } finally {
      await source.handle.close().catch(() => undefined);
      if (tempFile !== undefined) {
        await unlink(tempFile).catch(() => undefined);
      }
    }
  }

  /**
   * Ingests content Interleaf generated itself, such as a web-article snapshot.
   *
   * There is no source file to lease or re-verify here, so this path skips the
   * symlink and identity checks that only make sense for user-chosen paths, and
   * keeps everything else identical: the bytes are staged under the swept
   * `import-*.tmp` name, hashed from disk rather than from memory, and placed
   * atomically at the same content-addressed location. A crash before placement
   * therefore leaves a temp file that startup reconciliation removes.
   */
  async ingestGeneratedContent(content: Buffer, extension: string): Promise<IngestResult> {
    if (GENERATED_CONTENT_EXTENSIONS[extension] !== true) {
      throw new InterleafError('internal', 'Unsupported generated content extension.');
    }
    let tempFile: string | undefined;
    try {
      await mkdir(this.tempDir, { recursive: true });
      const canonicalTemp = await this.assertManagedDirectory(this.tempDir);
      tempFile = join(canonicalTemp, `import-${randomUUID()}.tmp`);
      await writeFile(tempFile, content, { flag: 'wx', mode: 0o600 });
      const fileHash = await this.computeFileHash(tempFile);
      return await this.placeManagedFile(tempFile, fileHash, extension);
    } catch (err) {
      if (err instanceof InterleafError) {
        throw err;
      }
      throw new InterleafError('internal', 'Failed to save the article into managed storage.');
    } finally {
      if (tempFile !== undefined) {
        await unlink(tempFile).catch(() => undefined);
      }
    }
  }

  /**
   * Moves a staged temp file to its content-addressed home.
   *
   * Placement is a hard link, which is atomic and never replaces an existing
   * target, so two concurrent imports of the same bytes converge on one file
   * instead of racing. Whenever a file already exists at the hash path its
   * contents are re-hashed before being reused, so a collision or a corrupted
   * managed file is refused rather than silently adopted.
   */
  private async placeManagedFile(
    tempFile: string,
    fileHash: string,
    ext: string
  ): Promise<IngestResult> {
    const prefixDir = join(this.libraryRoot, fileHash.slice(0, 2));
    await mkdir(prefixDir, { recursive: true });
    const canonicalPrefix = await this.assertManagedDirectory(prefixDir);
    const finalPath = join(canonicalPrefix, `${fileHash}${ext}`);
    this.inFlightManagedFiles.add(finalPath);
    try {
      const existing = await this.reuseExistingManagedFile(finalPath, fileHash);
      if (existing !== null) {
        await unlink(tempFile).catch(() => undefined);
        return existing;
      }

      try {
        // Hard-link creation is atomic and never replaces an existing target.
        // The temp and final paths are deliberately on the same volume.
        await link(tempFile, finalPath);
        await chmod(finalPath, 0o400).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const existingHash = await this.computeFileHash(finalPath);
        if (existingHash !== fileHash) {
          throw new InterleafError(
            'security-violation',
            'A concurrent managed-library placement failed content verification.'
          );
        }
      }
      await unlink(tempFile).catch(() => undefined);
      const placedStat = await stat(finalPath);

      return {
        finalPath,
        fileHash,
        fileSize: placedStat.size,
        fileMtimeMs: Math.round(placedStat.mtimeMs),
        isDeduplicated: false,
      };
    } finally {
      this.inFlightManagedFiles.delete(finalPath);
    }
  }

  /** Returns a reusable ingest result when the hash path already holds these bytes. */
  private async reuseExistingManagedFile(
    finalPath: string,
    fileHash: string
  ): Promise<IngestResult | null> {
    let destStat;
    try {
      destStat = await stat(finalPath);
    } catch {
      return null;
    }
    if (!destStat.isFile()) return null;
    const existingHash = await this.computeFileHash(finalPath);
    if (existingHash !== fileHash) {
      throw new InterleafError(
        'security-violation',
        'A managed-library hash path failed content verification.'
      );
    }
    return {
      finalPath,
      fileHash,
      fileSize: destStat.size,
      fileMtimeMs: Math.round(destStat.mtimeMs),
      isDeduplicated: true,
    };
  }
  /**
   * Returns cached storage health immediately without blocking on worker hashing.
   * Returns 'checking' for unverified linked files.
   */
  checkStorageHealthImmediate(
    filePath: string,
    mode: StorageMode,
    expectedHash: string,
    expectedSize: number,
    expectedMtimeMs: number
  ): StorageHealthResult {
    const cacheKey = `${filePath}\0${expectedHash}\0${String(expectedSize)}\0${String(expectedMtimeMs)}`;
    const cached = this.linkHealthCache.get(cacheKey);
    if (
      cached !== undefined &&
      Date.now() - cached.checkedAt < StorageManager.LINK_HEALTH_CACHE_MS
    ) {
      return cached.result;
    }
    if (mode === 'link') {
      return { status: 'checking' };
    }
    return { status: 'ok' };
  }


  /**
   * Evaluates storage health for a document without exposing its host path.
   */
  async checkStorageHealth(
    filePath: string,
    mode: StorageMode,
    expectedHash: string,
    expectedSize: number,
    expectedMtimeMs: number,
    allowCached = false
  ): Promise<StorageHealthResult> {
    const cacheKey = `${filePath}\0${expectedHash}\0${String(expectedSize)}\0${String(expectedMtimeMs)}`;
    if (mode === 'link' && allowCached) {
      const cached = this.linkHealthCache.get(cacheKey);
      if (
        cached !== undefined &&
        Date.now() - cached.checkedAt < StorageManager.LINK_HEALTH_CACHE_MS
      ) {
        return cached.result;
      }
      const inFlight = this.inFlightHealthChecks.get(cacheKey);
      if (inFlight !== undefined) {
        return await inFlight;
      }
    }

    const executeCheck = async (): Promise<StorageHealthResult> => {
      try {
        const source = await this.openStableSource(filePath);
        try {
          const fileSize = source.fileSize;
          const currentMtime = source.fileMtimeMs;

          // Managed copies are app-owned and immutable after placement, so a
          // stable stat tuple is a sufficient fast path. Linked files remain
          // user-controlled and must be rehashed even when a sync/restore tool
          // preserves their size and timestamp.
          if (
            mode === 'managed' &&
            fileSize === expectedSize &&
            currentMtime === expectedMtimeMs
          ) {
            return { status: 'ok', sourceIdentity: this.toSourceIdentity(source) };
          }

          const currentHash = await this.hashStableSource(source);
          await this.assertSourceUnchanged(source);
          if (currentHash === expectedHash) {
            const identityChanged =
              fileSize !== expectedSize || currentMtime !== expectedMtimeMs;
            const result: StorageHealthResult = {
              status: 'ok',
              sourceIdentity: this.toSourceIdentity(source),
              ...(identityChanged
                ? { updatedSize: fileSize, updatedMtimeMs: currentMtime }
                : {}),
            };
            if (mode === 'link') {
              this.linkHealthCache.set(cacheKey, { checkedAt: Date.now(), result });
            }
            return result;
          }

          const result: StorageHealthResult = {
            status: 'changed',
            message:
              mode === 'managed'
                ? 'The managed copy no longer matches the imported document.'
                : 'The linked file content has changed since import.',
          };
          if (mode === 'link') {
            this.linkHealthCache.set(cacheKey, { checkedAt: Date.now(), result });
          }
          return result;
        } finally {
          await source.handle.close().catch(() => undefined);
        }
      } catch {
        const result: StorageHealthResult = {
          status: 'missing',
          message: 'File is not accessible or has been moved/deleted.',
        };
        if (mode === 'link') {
          this.linkHealthCache.set(cacheKey, { checkedAt: Date.now(), result });
        }
        return result;
      }
    };

    if (mode === 'link') {
      const checkPromise = executeCheck();
      this.inFlightHealthChecks.set(cacheKey, checkPromise);
      try {
        return await checkPromise;
      } finally {
        this.inFlightHealthChecks.delete(cacheKey);
      }
    }

    return await executeCheck();
  }
  /**
   * Stages a linked file into managed storage under .staged/ so it can be safely
   * registered with AssetRegistry and streamed via interleaf-media:// without exposing
   * external roots.
   */
  async stageLinkedFile(
    sourcePath: string,
    expectedHash: string,
    format: DocumentFormat
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new InterleafError('validation', 'The linked document hash is invalid.');
    }
    const stagedDir = join(this.libraryRoot, '.staged');
    await mkdir(stagedDir, { recursive: true });
    const canonicalStagedDir = await this.assertManagedDirectory(stagedDir);
    const ext = `.${format}`;
    const stagedPath = join(canonicalStagedDir, `${expectedHash}${ext}`);

    try {
      const existingStat = await lstat(stagedPath);
      if (existingStat.isSymbolicLink()) {
        await unlink(stagedPath);
      } else if (existingStat.isFile()) {
        const hash = await this.computeFileHash(stagedPath);
        if (hash === expectedHash) {
          return stagedPath;
        }
        await unlink(stagedPath);
      } else {
        throw new InterleafError(
          'security-violation',
          'The staged reader asset path is not a regular file.'
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const source = await this.openStableSource(sourcePath);
    try {
      const sourceHash = await this.hashStableSource(source);
      await this.assertSourceUnchanged(source);
      if (sourceHash !== expectedHash) {
        throw new InterleafError(
          'validation',
          'The linked file content has changed and does not match its expected hash.'
        );
      }

      await mkdir(this.tempDir, { recursive: true });
      const canonicalTemp = await this.assertManagedDirectory(this.tempDir);
      const tempFile = join(canonicalTemp, `stage-${randomUUID()}.tmp`);
      try {
        const readStream = source.handle.createReadStream({
          start: 0,
          autoClose: false,
          highWaterMark: 64 * 1024,
        });
        const writeStream = createWriteStream(tempFile, { flags: 'wx', mode: 0o600 });
        await pipeline(readStream, writeStream);
        await this.assertSourceUnchanged(source);
        const stagedHash = await this.computeFileHash(tempFile);
        if (stagedHash !== expectedHash) {
          throw new InterleafError(
            'validation',
            'The linked file changed while Interleaf was staging it.'
          );
        }

        try {
          await link(tempFile, stagedPath);
          await chmod(stagedPath, 0o400).catch(() => undefined);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
      } finally {
        await unlink(tempFile).catch(() => undefined);
      }

      const placedHash = await this.computeFileHash(stagedPath);
      if (placedHash !== expectedHash) {
        throw new InterleafError(
          'security-violation',
          'The staged reader asset failed content verification.'
        );
      }

      return stagedPath;
    } finally {
      await source.handle.close().catch(() => undefined);
    }
  }

  /**
   * Safely removes a managed document binary if no other database record references it.
   */
  async deleteManagedFileIfOrphaned(
    filePath: string,
    isReferencedElsewhere: boolean | (() => boolean | Promise<boolean>)
  ): Promise<boolean> {
    const referenced =
      typeof isReferencedElsewhere === 'function'
        ? await isReferencedElsewhere()
        : isReferencedElsewhere;
    if (referenced) {
      return false;
    }

    try {
      const canonical = await realpath(filePath);
      const canonicalRoot = await realpath(this.libraryRoot);
      if (isStrictlyInside(canonicalRoot, canonical)) {
        if (typeof isReferencedElsewhere === 'function') {
          const stillReferenced = await isReferencedElsewhere();
          if (stillReferenced) {
            return false;
          }
        }
        await unlink(canonical);
        return true;
      }
    } catch (err) {
      this.log.warn('Failed to delete orphaned managed file', {
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
    return false;
  }

  /** Removes aged hash-derived cover files that no remaining document uses. */
  async reconcileOrphanedCoverSnapshots(
    referencedHashes: ReferencedHashProvider,
    minimumAgeMs = 10 * 60 * 1000
  ): Promise<number> {
    const coverDir = join(this.libraryRoot, '.covers');
    let canonicalDir: string;
    try {
      canonicalDir = await this.assertManagedDirectory(coverDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const hashes = typeof referencedHashes === 'function'
      ? await referencedHashes()
      : referencedHashes;
    const referenced = new Set(hashes.map((hash) => hash.toLowerCase()));
    const cutoff = Date.now() - Math.max(0, minimumAgeMs);
    let removed = 0;
    for (const entry of await readdir(canonicalDir, { withFileTypes: true })) {
      const match = /^([a-f0-9]{64})\.png$/i.exec(entry.name);
      const hash = match?.[1];
      if (hash === undefined || referenced.has(hash.toLowerCase())) continue;
      const candidate = join(canonicalDir, entry.name);
      try {
        const leaf = await lstat(candidate);
        if (leaf.isSymbolicLink()) {
          await unlink(candidate);
          removed++;
          continue;
        }
        if (!leaf.isFile() || leaf.mtimeMs > cutoff) continue;
        const canonicalCandidate = await realpath(candidate);
        if (!isStrictlyInside(canonicalDir, canonicalCandidate)) continue;
        const currentLeaf = await lstat(candidate);
        const currentPath = await realpath(candidate);
        if (
          currentLeaf.isSymbolicLink() ||
          !currentLeaf.isFile() ||
          currentLeaf.dev !== leaf.dev ||
          currentLeaf.ino !== leaf.ino ||
          currentPath !== canonicalCandidate ||
          currentLeaf.mtimeMs > cutoff
        ) continue;
        await unlink(candidate);
        removed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log.warn('Failed to reconcile an orphaned PDF cover', {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    }
    return removed;
  }

  private async openStableSource(sourcePath: string): Promise<StableSource> {
    const requestedPath = resolve(sourcePath);
    let requestedLeaf;
    try {
      requestedLeaf = await lstat(requestedPath);
    } catch {
      throw new InterleafError('validation', 'The selected file is unavailable or inaccessible.');
    }
    if (requestedLeaf.isSymbolicLink() || !requestedLeaf.isFile()) {
      throw new InterleafError(
        'validation',
        'Symbolic links and non-regular files cannot be imported.'
      );
    }

    const canonicalPath = await realpath(requestedPath);
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    try {
      const [opened, current, currentLeaf, currentPath] = await Promise.all([
        handle.stat(),
        stat(canonicalPath),
        lstat(canonicalPath),
        realpath(canonicalPath),
      ]);
      if (
        !opened.isFile() ||
        currentLeaf.isSymbolicLink() ||
        currentPath !== canonicalPath ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        opened.size !== current.size ||
        Math.round(opened.mtimeMs) !== Math.round(current.mtimeMs) ||
        Math.round(opened.ctimeMs) !== Math.round(current.ctimeMs)
      ) {
        throw new InterleafError('validation', 'The selected file changed while it was opened.');
      }
      return {
        handle,
        canonicalPath,
        fileSize: opened.size,
        fileMtimeMs: Math.round(opened.mtimeMs),
        fileCtimeMs: Math.round(opened.ctimeMs),
        device: opened.dev,
        inode: opened.ino,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async hashStableSource(source: StableSource): Promise<string> {
    return hashFileInWorker(source.canonicalPath, {
      device: source.device,
      inode: source.inode,
      fileSize: source.fileSize,
      fileMtimeMs: source.fileMtimeMs,
      fileCtimeMs: source.fileCtimeMs,
    });
  }

  private async assertSourceUnchanged(source: StableSource): Promise<void> {
    const [opened, current, currentLeaf, currentPath] = await Promise.all([
      source.handle.stat(),
      stat(source.canonicalPath),
      lstat(source.canonicalPath),
      realpath(source.canonicalPath),
    ]);
    if (
      !opened.isFile() ||
      currentLeaf.isSymbolicLink() ||
      currentPath !== source.canonicalPath ||
      opened.dev !== source.device ||
      opened.ino !== source.inode ||
      current.dev !== source.device ||
      current.ino !== source.inode ||
      opened.size !== source.fileSize ||
      Math.round(opened.mtimeMs) !== source.fileMtimeMs ||
      Math.round(opened.ctimeMs) !== source.fileCtimeMs ||
      Math.round(current.mtimeMs) !== source.fileMtimeMs ||
      Math.round(current.ctimeMs) !== source.fileCtimeMs
    ) {
      throw new InterleafError('validation', 'The selected file changed during import.');
    }
  }

  private toSourceIdentity(source: StableSource): StorageSourceIdentity {
    return {
      canonicalPath: source.canonicalPath,
      fileSize: source.fileSize,
      fileMtimeMs: source.fileMtimeMs,
      fileCtimeMs: source.fileCtimeMs,
      device: source.device,
      inode: source.inode,
    };
  }

  private async assertManagedRoot(): Promise<string> {
    const leaf = await lstat(this.libraryRoot);
    const canonicalRoot = await realpath(this.libraryRoot);
    if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
      throw new InterleafError(
        'security-violation',
        'The managed library root failed identity validation.'
      );
    }
    return canonicalRoot;
  }

  private async assertManagedDirectory(directoryPath: string): Promise<string> {
    const canonicalRoot = await this.assertManagedRoot();
    const [leaf, canonicalDirectory] = await Promise.all([
      lstat(directoryPath),
      realpath(directoryPath),
    ]);
    if (
      leaf.isSymbolicLink() ||
      !leaf.isDirectory() ||
      !isStrictlyInside(canonicalRoot, canonicalDirectory)
    ) {
      throw new InterleafError(
        'security-violation',
        'A managed library directory failed containment validation.'
      );
    }
    return canonicalDirectory;
  }
}
