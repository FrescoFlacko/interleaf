import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isStrictlyInside } from './path-guard';

export const ALLOWED_MIME_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw': 'application/vnd.amazon.ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const DEFAULT_ASSET_TTL_MS = 15 * 60 * 1000;
const MAX_ASSET_TTL_MS = 60 * 60 * 1000;
const MAX_LIBRARY_COVER_ASSETS = 512;

export type RegisteredAsset = {
  readonly assetId: string;
  readonly canonicalPath: string;
  readonly permittedRoot: string;
  readonly mimeType: string;
  readonly documentId: string;
  readonly scopeId: string;
  readonly kind: 'reader' | 'library-cover';
  readonly expiresAt: number;
};

export type RegisterAssetOptions = {
  readonly filePath: string;
  readonly permittedRoot: string;
  readonly documentId: string;
  readonly scopeId: string;
  /** Library covers are scoped to the renderer but do not require an open reader document. */
  readonly kind?: 'reader' | 'library-cover';
  readonly ttlMs?: number;
};

/**
 * The file and its permitted root, canonicalized together.
 *
 * Either path failing to resolve means the same thing to a caller: there is no
 * asset to hand out a handle for.
 */
async function canonicalizeAssetPaths(
  filePath: string,
  permittedRoot: string,
): Promise<readonly [string, string]> {
  try {
    return await Promise.all([realpath(filePath), realpath(permittedRoot)]);
  } catch (error) {
    throw new InterleafError('media-not-found', 'The requested asset could not be resolved.', {
      cause: error instanceof Error ? error : null,
    });
  }
}

export class AssetRegistry {
  private readonly assets = new Map<string, RegisteredAsset>();
  private readonly libraryCoverByKey = new Map<string, string>();
  private readonly activeDocumentByScope = new Map<string, string>();

  constructor(private readonly managedRoots: readonly string[]) {
    if (managedRoots.length === 0) {
      throw new Error('AssetRegistry requires at least one app-managed root.');
    }
  }

  /**
   * Registers a file within a permitted root and returns an opaque asset handle.
   * Path canonicalization and boundary containment are strictly verified before registration.
   */
  async registerAsset(options: RegisterAssetOptions): Promise<{ assetId: string; mediaUrl: string }> {
    const { filePath, permittedRoot, documentId, scopeId } = options;

    if (!filePath || !permittedRoot) {
      throw new InterleafError('validation', 'filePath and permittedRoot are required');
    }

    const resolvedFilePath = resolve(filePath);
    const resolvedPermittedRoot = resolve(permittedRoot);

    const [canonicalPath, canonicalRoot] = await canonicalizeAssetPaths(resolvedFilePath, resolvedPermittedRoot);

    const canonicalManagedRoots = await Promise.all(
      this.managedRoots.map(async (root) => realpath(resolve(root)))
    );
    if (!canonicalManagedRoots.some((root) => root === canonicalRoot || isStrictlyInside(root, canonicalRoot))) {
      throw new InterleafError(
        'media-forbidden',
        'Assets must be staged beneath an application-managed media root.'
      );
    }

    if (!isStrictlyInside(canonicalRoot, canonicalPath)) {
      throw new InterleafError(
        'media-forbidden',
        'Asset path must reside within the permitted root directory'
      );
    }

    // Verify it is a regular file
    const fileStat = await stat(canonicalPath);
    if (!fileStat.isFile()) {
      throw new InterleafError('media-forbidden', 'Asset must be a regular file');
    }

    const extension = extname(canonicalPath).toLowerCase();
    const mimeType = ALLOWED_MIME_TYPES[extension];
    if (mimeType === undefined) {
      throw new InterleafError('media-forbidden', 'The asset type is not allowlisted.');
    }

    const ttlMs = options.ttlMs ?? DEFAULT_ASSET_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ASSET_TTL_MS) {
      throw new InterleafError('validation', 'The asset expiry is outside the allowed range.');
    }

    const assetId = randomUUID();
    const kind = options.kind ?? 'reader';
    const coverKey = kind === 'library-cover'
      ? `${scopeId}\0${documentId}\0${canonicalPath}`
      : undefined;
    if (coverKey !== undefined) {
      this.sweepExpired();
      const existingId = this.libraryCoverByKey.get(coverKey);
      if (existingId !== undefined) {
        const existing = this.assets.get(existingId);
        if (existing !== undefined && existing.expiresAt > Date.now()) {
          // Keep the stable opaque URL while renewing its lease. The renderer
          // refreshes before the one-hour upper bound; returning the old
          // expiry here would make a freshly issued cache entry expire early.
          this.assets.set(existingId, {
            ...existing,
            expiresAt: Date.now() + ttlMs,
          });
          return {
            assetId: existing.assetId,
            mediaUrl: `interleaf-media://${existing.assetId}`,
          };
        }
        this.removeAsset(existingId);
      }
      while (this.libraryCoverByKey.size >= MAX_LIBRARY_COVER_ASSETS) {
        const oldest = this.libraryCoverByKey.entries().next().value;
        if (oldest === undefined) break;
        this.removeAsset(oldest[1]);
      }
    }
    const expiresAt = Date.now() + ttlMs;

    const asset: RegisteredAsset = {
      assetId,
      canonicalPath,
      permittedRoot: canonicalRoot,
      mimeType,
      documentId,
      scopeId,
      kind,
      expiresAt,
    };

    this.assets.set(assetId, asset);
    if (coverKey !== undefined) {
      this.libraryCoverByKey.set(coverKey, assetId);
    }

    return {
      assetId,
      mediaUrl: `interleaf-media://${assetId}`,
    };
  }

  /**
   * Resolves a registered asset by opaque asset ID. Checks expiration and cleans up stale records.
   */
  resolveAsset(assetId: string, scopeId: string): RegisteredAsset | null {
    const asset = this.assets.get(assetId);
    if (!asset) {
      return null;
    }

    if (Date.now() > asset.expiresAt) {
      this.removeAsset(assetId);
      return null;
    }

    if (asset.scopeId !== scopeId) {
      return null;
    }
    if (asset.kind === 'reader' && this.activeDocumentByScope.get(scopeId) !== asset.documentId) {
      return null;
    }

    return asset;
  }

  /**
   * Activates one document for a renderer scope and revokes capabilities from
   * the previously active document. Main calls this on every document switch.
   */
  activateDocument(scopeId: string, documentId: string): number {
    const previousDocumentId = this.activeDocumentByScope.get(scopeId);
    this.activeDocumentByScope.set(scopeId, documentId);
    if (previousDocumentId === undefined) {
      return 0;
    }

    let count = 0;
    for (const [id, asset] of this.assets.entries()) {
      // Reader capabilities are tied to the active document. Library-cover
      // capabilities are intentionally scoped to the renderer instead, so a
      // library card remains usable while the reader switches documents.
      if (
        asset.kind === 'reader' &&
        asset.scopeId === scopeId &&
        asset.documentId === previousDocumentId
      ) {
        this.removeAsset(id);
        count += 1;
      }
    }
    return count;
  }

  isDocumentActive(scopeId: string, documentId: string): boolean {
    return this.activeDocumentByScope.get(scopeId) === documentId;
  }

  getRegisteredCanonicalPaths(now = Date.now()): ReadonlySet<string> {
    this.sweepExpired(now);
    return new Set(Array.from(this.assets.values(), (asset) => asset.canonicalPath));
  }

  /**
   * Unregisters an asset by ID.
   */
  unregisterAsset(assetId: string): boolean {
    return this.removeAsset(assetId);
  }

  /**
   * Unregisters all assets associated with a specific document ID.
   */
  unregisterDocument(documentId: string): number {
    let count = 0;
    for (const [id, asset] of this.assets.entries()) {
      if (asset.documentId === documentId) {
        this.removeAsset(id);
        count += 1;
      }
    }
    return count;
  }

  /** Revokes a document only within its renderer scope. */
  unregisterDocumentInScope(documentId: string, scopeId: string): number {
    let count = 0;
    for (const [id, asset] of this.assets.entries()) {
      // Closing a reader revokes reader capabilities in this scope. Covers
      // belong to library cards and remain valid until the document is
      // deleted or their TTL expires.
      if (
        asset.kind === 'reader' &&
        asset.documentId === documentId &&
        asset.scopeId === scopeId
      ) {
        this.removeAsset(id);
        count += 1;
      }
    }
    if (this.activeDocumentByScope.get(scopeId) === documentId) {
      this.activeDocumentByScope.delete(scopeId);
    }
    return count;
  }

  unregisterScope(scopeId: string): number {
    this.activeDocumentByScope.delete(scopeId);
    let count = 0;
    for (const [id, asset] of this.assets.entries()) {
      if (asset.scopeId === scopeId) {
        this.removeAsset(id);
        count += 1;
      }
    }
    return count;
  }

  sweepExpired(now = Date.now()): number {
    let count = 0;
    for (const [id, asset] of this.assets.entries()) {
      if (asset.expiresAt < now) {
        this.removeAsset(id);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Clears all registered assets.
   */
  clear(): void {
    this.assets.clear();
    this.libraryCoverByKey.clear();
    this.activeDocumentByScope.clear();
  }

  /**
   * Returns current active asset count.
   */
  get size(): number {
    return this.assets.size;
  }

  private removeAsset(assetId: string): boolean {
    const asset = this.assets.get(assetId);
    if (asset === undefined) return false;
    if (asset.kind === 'library-cover') {
      const coverKey = `${asset.scopeId}\0${asset.documentId}\0${asset.canonicalPath}`;
      if (this.libraryCoverByKey.get(coverKey) === assetId) {
        this.libraryCoverByKey.delete(coverKey);
      }
    }
    return this.assets.delete(assetId);
  }
}
