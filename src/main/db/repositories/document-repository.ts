import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import type {
  DocumentFilter,
  DocumentFormat,
  DocumentSource,
  ReadingPosition,
  StorageMode,
} from '@shared/types/document';
import { documentSourceSchema, parseDocumentLocation } from '@shared/schemas/document';
import { parsePortableJson } from '@shared/models/portable';

type DocumentRecord = {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly format: DocumentFormat;
  readonly filePath: string;
  readonly storageMode: StorageMode;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileHash: string;
  readonly pageCount: number | null;
  readonly coverPath: string | null;
  readonly folderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Non-file provenance, or `null` for a document the user imported. */
  readonly source: DocumentSource | null;
};

export type DocumentRecordWithReadingPosition = DocumentRecord & {
  readonly readingPosition: ReadingPosition | null;
};

export type DocumentInsertInput = {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly format: DocumentFormat;
  readonly filePath: string;
  readonly storageMode: StorageMode;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileHash: string;
  readonly pageCount: number | null;
  readonly coverPath?: string | null;
  readonly folderId?: string | null;
  readonly source?: DocumentSource | null;
};

/** The fields a re-capture of the same web page is allowed to replace. */
export type CapturedSnapshotUpdate = {
  readonly title: string;
  readonly author: string | null;
  readonly filePath: string;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileHash: string;
  readonly siteName: string | null;
  readonly capturedAt: string;
};

type Row = {
  id: string;
  title: string;
  author: string | null;
  format: DocumentFormat;
  file_path: string;
  storage_mode: StorageMode;
  file_size: number;
  file_mtime_ms: number;
  file_hash: string;
  page_count: number | null;
  cover_path: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  source_kind?: string | null;
  source_url?: string | null;
  source_site_name?: string | null;
  source_captured_at?: string | null;
  location_json?: string | null;
  progress?: number | null;
  rp_updated_at?: string | null;
};


/**
 * Rebuilds provenance from its columns.
 *
 * The stored values originally came from an untrusted page, so they are parsed
 * through the same schema the rest of the app uses instead of being trusted
 * because they are in the database. Anything that no longer validates degrades
 * to `null` rather than blowing up queries.
 */
function mapSource(r: Row): DocumentSource | null {
  if (r.source_kind !== 'web') return null;
  const parsed = documentSourceSchema.safeParse({
    kind: r.source_kind,
    url: r.source_url,
    siteName: r.source_site_name,
    capturedAt: r.source_captured_at,
  });
  return parsed.success ? parsed.data : null;
}
function mapRow(r: Row): DocumentRecordWithReadingPosition {
  let readingPosition: ReadingPosition | null = null;
  if (r.location_json && r.progress !== null && r.progress !== undefined && r.rp_updated_at) {
    try {
      const location = parseDocumentLocation(parsePortableJson(r.location_json));
      if (location !== null && r.progress >= 0 && r.progress <= 1) {
        readingPosition = {
          location,
          progress: r.progress,
          updatedAt: r.rp_updated_at,
        };
      }
    } catch {
      readingPosition = null;
    }
  }

  return {
    id: r.id,
    title: r.title,
    author: r.author,
    format: r.format,
    filePath: r.file_path,
    storageMode: r.storage_mode,
    fileSize: r.file_size,
    fileMtimeMs: r.file_mtime_ms,
    fileHash: r.file_hash,
    pageCount: r.page_count,
    coverPath: r.cover_path,
    folderId: r.folder_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: mapSource(r),
    readingPosition,
  };
}

export class DocumentRepository {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly findByIdStmt: StatementSync;
  private readonly findByHashStmt: StatementSync;
  private readonly findByHashAndFolderStmt: StatementSync;
  private readonly findBySourceUrlStmt: StatementSync;
  private readonly countByFilePathStmt: StatementSync;
  private readonly moveToFolderStmt: StatementSync;
  private readonly updateStorageReferenceStmt: StatementSync;
  private readonly updateStorageIdentityStmt: StatementSync;
  private readonly replaceCapturedSnapshotStmt: StatementSync;
  private readonly updateCoverPathStmt: StatementSync;
  private readonly deleteStmt: StatementSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.insertStmt = this.db.prepare(`
      INSERT INTO documents (
        id, title, author, format, file_path, storage_mode,
        file_size, file_mtime_ms, file_hash, page_count, cover_path, folder_id,
        source_kind, source_url, source_site_name, source_captured_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      RETURNING *
    `);
    this.findByIdStmt = this.db.prepare(`
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      WHERE d.id = ?
    `);
    this.findByHashStmt = this.db.prepare(`
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      WHERE d.file_hash = ?
    `);
    this.findByHashAndFolderStmt = this.db.prepare(`
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      WHERE d.file_hash = ? AND (d.folder_id = ? OR (d.folder_id IS NULL AND ? IS NULL))
      LIMIT 1
    `);
    this.findBySourceUrlStmt = this.db.prepare(`
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      WHERE d.source_kind = 'web' AND d.source_url = ?
      ORDER BY d.created_at ASC, d.id ASC
      LIMIT 1
    `);
    this.countByFilePathStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM documents WHERE file_path = ?
    `);
    this.moveToFolderStmt = this.db.prepare(`
      UPDATE documents
      SET folder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);
    this.updateStorageReferenceStmt = this.db.prepare(`
      UPDATE documents
      SET file_path = ?, storage_mode = ?, file_size = ?, file_mtime_ms = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);
    this.updateStorageIdentityStmt = this.db.prepare(`
      UPDATE documents SET file_size = ?, file_mtime_ms = ? WHERE id = ?
    `);
    // Re-capturing a page replaces its content and its capture metadata and
    // nothing else. Identity, folder, and everything anchored to the document
    // id — annotations, reading position, chats — stay attached to the row.
    this.replaceCapturedSnapshotStmt = this.db.prepare(`
      UPDATE documents
      SET title = ?, author = ?, file_path = ?, file_size = ?, file_mtime_ms = ?,
          file_hash = ?, source_site_name = ?, source_captured_at = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND source_kind = 'web' AND storage_mode = 'managed'
    `);
    this.updateCoverPathStmt = this.db.prepare(`
      UPDATE documents SET cover_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND file_hash = ?
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM documents WHERE id = ?
    `);
  }

  insert(input: DocumentInsertInput): DocumentRecordWithReadingPosition {
    if (input.source !== null && input.source !== undefined) {
      documentSourceSchema.parse(input.source);
    }
    const row = this.insertStmt.get(
      input.id,
      input.title,
      input.author,
      input.format,
      input.filePath,
      input.storageMode,
      input.fileSize,
      input.fileMtimeMs,
      input.fileHash,
      input.pageCount ?? null,
      input.coverPath ?? null,
      input.folderId ?? null,
      input.source?.kind ?? null,
      input.source?.url ?? null,
      input.source?.siteName ?? null,
      input.source?.capturedAt ?? null
    ) as Row | undefined;

    if (!row) {
      throw new Error(`Failed to insert document record with ID ${input.id}`);
    }
    return mapRow(row);
  }

  findById(id: string): DocumentRecordWithReadingPosition | null {
    const row = this.findByIdStmt.get(id) as Row | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  findByHash(hash: string): readonly DocumentRecordWithReadingPosition[] {
    const rows = this.findByHashStmt.all(hash) as Row[];
    return rows.map(mapRow);
  }

  findByHashAndFolder(
    hash: string,
    folderId: string | null
  ): DocumentRecordWithReadingPosition | null {
    const row = this.findByHashAndFolderStmt.get(hash, folderId, folderId) as Row | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  /**
   * The web document captured from this exact normalized source URL, if any.
   *
   * Re-importing a page has to find its earlier capture to upgrade rather than
   * duplicate it. The oldest row wins so a library that already contains two
   * captures of one URL — possible before this lookup existed — converges on a
   * single one instead of alternating between them.
   */
  findBySourceUrl(url: string): DocumentRecordWithReadingPosition | null {
    const row = this.findBySourceUrlStmt.get(url) as Row | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  countByFilePath(filePath: string): number {
    const result = this.countByFilePathStmt.get(filePath) as { count?: number } | undefined;
    return result?.count ?? 0;
  }

  moveToFolder(documentId: string, folderId: string | null): void {
    this.moveToFolderStmt.run(folderId, documentId);
  }

  updateStorageReference(
    documentId: string,
    filePath: string,
    storageMode: StorageMode,
    fileSize: number,
    fileMtimeMs: number
  ): void {
    this.updateStorageReferenceStmt.run(
      filePath,
      storageMode,
      fileSize,
      fileMtimeMs,
      documentId
    );
  }

  /**
   * Points an existing web document at a fresh capture of the same URL.
   *
   * Returns false when the row is not an upgradable managed web capture, so a
   * caller cannot quietly rewrite a user's own imported file.
   */
  replaceCapturedSnapshot(documentId: string, input: CapturedSnapshotUpdate): boolean {
    const result = this.replaceCapturedSnapshotStmt.run(
      input.title,
      input.author,
      input.filePath,
      input.fileSize,
      input.fileMtimeMs,
      input.fileHash,
      input.siteName,
      input.capturedAt,
      documentId
    );
    return result.changes > 0;
  }

  updateStorageIdentity(documentId: string, fileSize: number, fileMtimeMs: number): void {
    this.updateStorageIdentityStmt.run(fileSize, fileMtimeMs, documentId);
  }

  /** Persists only a main-owned, hash-bound cover metadata path. */
  updateCoverPath(documentId: string, fileHash: string, coverPath: string | null): void {
    this.updateCoverPathStmt.run(coverPath, documentId, fileHash);
  }

  delete(id: string): DocumentRecordWithReadingPosition | null {
    const existing = this.findById(id);
    if (!existing) return null;
    this.deleteStmt.run(id);
    return existing;
  }

  list(filter?: DocumentFilter): readonly DocumentRecordWithReadingPosition[] {
    const whereClauses: string[] = [];
    const params: (string | number | bigint | null | Uint8Array)[] = [];
    if (filter?.folderId !== undefined) {
      if (filter.folderId === null) {
        whereClauses.push('d.folder_id IS NULL');
      } else {
        whereClauses.push('d.folder_id = ?');
        params.push(filter.folderId);
      }
    }

    if (filter?.searchQuery && filter.searchQuery.trim().length > 0) {
      whereClauses.push('(d.title LIKE ? OR (d.author IS NOT NULL AND d.author LIKE ?))');
      const pattern = `%${filter.searchQuery.trim()}%`;
      params.push(pattern, pattern);
    }

    if (filter?.format) {
      whereClauses.push('d.format = ?');
      params.push(filter.format);
    }

    if (filter?.storageMode) {
      whereClauses.push('d.storage_mode = ?');
      params.push(filter.storageMode);
    }

    let orderBy = 'd.created_at DESC';
    switch (filter?.sort) {
      case 'title_asc':
        orderBy = 'd.title COLLATE NOCASE ASC';
        break;
      case 'title_desc':
        orderBy = 'd.title COLLATE NOCASE DESC';
        break;
      case 'author_asc':
        orderBy = 'd.author IS NULL, d.author COLLATE NOCASE ASC, d.title COLLATE NOCASE ASC';
        break;
      case 'recent_read':
        orderBy = 'rp.updated_at IS NULL, rp.updated_at DESC, d.rowid DESC';
        break;
      case 'recent_added':
      default:
        orderBy = 'd.created_at DESC, d.rowid DESC';
        break;
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const hasPagination = filter?.limit !== undefined;
    const limit = hasPagination ? Math.max(1, Math.min(100, filter.limit ?? 50)) : undefined;
    const offset = filter?.offset !== undefined && filter.offset > 0 ? filter.offset : 0;
    if (limit !== undefined) {
      params.push(limit, offset);
    }

    const sql = `
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      ${whereSql}
      ORDER BY ${orderBy}
      ${limit !== undefined ? 'LIMIT ? OFFSET ?' : ''}
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Row[];
    return rows.map(mapRow);
  }

  getContinueReading(limit = 10): readonly DocumentRecordWithReadingPosition[] {
    const clampedLimit = Math.max(1, Math.min(50, limit));
    const sql = `
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      INNER JOIN reading_positions rp ON rp.document_id = d.id
      WHERE rp.progress > 0.0 AND rp.progress < 1.0
      ORDER BY rp.updated_at DESC, d.rowid DESC
      LIMIT ?
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(clampedLimit) as Row[];
    return rows.map(mapRow);
  }

  getRecentlyAdded(limit = 10): readonly DocumentRecordWithReadingPosition[] {
    const clampedLimit = Math.max(1, Math.min(50, limit));
    const sql = `
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      LEFT JOIN reading_positions rp ON rp.document_id = d.id
      ORDER BY d.created_at DESC, d.rowid DESC
      LIMIT ?
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(clampedLimit) as Row[];
    return rows.map(mapRow);
  }

  getRecentlyRead(limit = 10): readonly DocumentRecordWithReadingPosition[] {
    const clampedLimit = Math.max(1, Math.min(50, limit));
    const sql = `
      SELECT d.*, rp.location_json, rp.progress, rp.updated_at AS rp_updated_at
      FROM documents d
      INNER JOIN reading_positions rp ON rp.document_id = d.id
      ORDER BY rp.updated_at DESC, d.rowid DESC
      LIMIT ?
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(clampedLimit) as Row[];
    return rows.map(mapRow);
  }

  getSummaryCounts(): {
    totalDocuments: number;
    formatCounts: Record<DocumentFormat, number>;
    managedCount: number;
    linkCount: number;
    totalFolders: number;
  } {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as
      | { count?: number }
      | undefined;
    const foldersRow = this.db.prepare('SELECT COUNT(*) as count FROM folders').get() as
      | { count?: number }
      | undefined;
    const formatRows = this.db
      .prepare('SELECT format, COUNT(*) as count FROM documents GROUP BY format')
      .all() as { format: DocumentFormat; count: number }[];
    const modeRows = this.db
      .prepare('SELECT storage_mode, COUNT(*) as count FROM documents GROUP BY storage_mode')
      .all() as { storage_mode: StorageMode; count: number }[];
    const formatCounts: Record<DocumentFormat, number> = {
      pdf: 0,
      epub: 0,
      mobi: 0,
      docx: 0,
      pptx: 0,
      markdown: 0,
    };
    for (const r of formatRows) {
      if (r.format in formatCounts) {
        formatCounts[r.format] = r.count;
      }
    }

    let managedCount = 0;
    let linkCount = 0;
    for (const r of modeRows) {
      if (r.storage_mode === 'managed') managedCount = r.count;
      if (r.storage_mode === 'link') linkCount = r.count;
    }

    return {
      totalDocuments: totalRow?.count ?? 0,
      formatCounts,
      managedCount,
      linkCount,
      totalFolders: foldersRow?.count ?? 0,
    };
  }
}
