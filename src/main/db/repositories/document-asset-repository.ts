import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';

/**
 * The managed images each captured document refers to.
 *
 * Reads here answer three questions, and it is worth being explicit about
 * which: what a document needs at open time, what the whole library still
 * references before storage deletes anything, and what one document owned
 * before a re-import replaced it. The last two are why this is a table rather
 * than something parsed out of the snapshot on demand — reconciliation must not
 * have to read every article to learn whether a file is garbage.
 */

export type DocumentAssetRecord = {
  readonly documentId: string;
  /** Durable `interleaf-asset:<sha256><ext>` identity used inside the snapshot. */
  readonly reference: string;
  readonly assetHash: string;
  readonly extension: string;
  readonly mimeType: string;
  /** Managed absolute path; never crosses IPC. */
  readonly filePath: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly position: number;
};

export type NewDocumentAsset = Omit<DocumentAssetRecord, 'documentId' | 'position'>;

type Row = {
  document_id: string;
  reference: string;
  asset_hash: string;
  extension: string;
  mime_type: string;
  file_path: string;
  byte_size: number;
  width: number;
  height: number;
  position: number;
};

function toRecord(row: Row): DocumentAssetRecord {
  return {
    documentId: row.document_id,
    reference: row.reference,
    assetHash: row.asset_hash,
    extension: row.extension,
    mimeType: row.mime_type,
    filePath: row.file_path,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    position: row.position,
  };
}

const SELECT_COLUMNS = `document_id, reference, asset_hash, extension, mime_type,
         file_path, byte_size, width, height, position`;

export class DocumentAssetRepository {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly deleteForDocumentStmt: StatementSync;
  private readonly listForDocumentStmt: StatementSync;
  private readonly listAllPathsStmt: StatementSync;
  private readonly countForPathStmt: StatementSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.insertStmt = this.db.prepare(`
      INSERT INTO document_assets (
        document_id, reference, asset_hash, extension, mime_type,
        file_path, byte_size, width, height, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteForDocumentStmt = this.db.prepare(`
      DELETE FROM document_assets WHERE document_id = ?
    `);
    this.listForDocumentStmt = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM document_assets
      WHERE document_id = ?
      ORDER BY position ASC
    `);
    this.listAllPathsStmt = this.db.prepare(`
      SELECT DISTINCT file_path FROM document_assets
    `);
    this.countForPathStmt = this.db.prepare(`
      SELECT COUNT(*) AS count FROM document_assets
      WHERE file_path = ? AND document_id <> ?
    `);
  }

  /**
   * Makes the given list the document's complete asset set.
   *
   * Callers run this inside the same transaction as the snapshot swap, so a
   * document is never briefly described by one capture's Markdown and another
   * capture's images.
   */
  replaceForDocument(documentId: string, assets: readonly NewDocumentAsset[]): void {
    this.deleteForDocumentStmt.run(documentId);
    let position = 0;
    for (const asset of assets) {
      this.insertStmt.run(
        documentId,
        asset.reference,
        asset.assetHash,
        asset.extension,
        asset.mimeType,
        asset.filePath,
        asset.byteSize,
        asset.width,
        asset.height,
        position
      );
      position += 1;
    }
  }

  listForDocument(documentId: string): readonly DocumentAssetRecord[] {
    const rows = this.listForDocumentStmt.all(documentId) as Row[];
    return rows.map(toRecord);
  }

  /** Every managed media path the library still refers to. */
  listAllPaths(): readonly string[] {
    const rows = this.listAllPathsStmt.all() as { file_path: string }[];
    return rows.map((row) => row.file_path);
  }

  /** True when some other document still refers to this managed file. */
  isReferencedByOtherDocument(filePath: string, documentId: string): boolean {
    const row = this.countForPathStmt.get(filePath, documentId) as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  deleteForDocument(documentId: string): void {
    this.deleteForDocumentStmt.run(documentId);
  }
}
