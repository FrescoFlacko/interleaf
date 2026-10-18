import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { InterleafDatabase } from '../database';
import { InterleafError } from '@shared/errors/interleaf-error';

export type ReadingPositionRecord = {
  readonly documentId: string;
  readonly locationJson: string;
  readonly progress: number;
  readonly updatedAt: string;
};

type Row = {
  document_id: string;
  location_json: string;
  progress: number;
  updated_at: string;
};

export class ReadingPositionRepository {
  private readonly db: DatabaseSync;
  private readonly upsertStmt: StatementSync;
  private readonly findStmt: StatementSync;
  private readonly deleteStmt: StatementSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO reading_positions (document_id, location_json, progress, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(document_id) DO UPDATE SET
        location_json = excluded.location_json,
        progress = excluded.progress,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING document_id, location_json, progress, updated_at
    `);
    this.findStmt = this.db.prepare(`
      SELECT document_id, location_json, progress, updated_at
      FROM reading_positions
      WHERE document_id = ?
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM reading_positions WHERE document_id = ?
    `);
  }

  upsert(documentId: string, locationJson: string, progress: number): ReadingPositionRecord {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
      throw new InterleafError('validation', 'Reading progress must be between 0 and 1.');
    }
    const row = this.upsertStmt.get(documentId, locationJson, progress) as Row | undefined;
    if (!row) {
      throw new Error(`Failed to upsert reading position for document ${documentId}`);
    }
    return {
      documentId: row.document_id,
      locationJson: row.location_json,
      progress: row.progress,
      updatedAt: row.updated_at,
    };
  }

  findByDocumentId(documentId: string): ReadingPositionRecord | null {
    const row = this.findStmt.get(documentId) as Row | undefined;
    if (!row) return null;
    return {
      documentId: row.document_id,
      locationJson: row.location_json,
      progress: row.progress,
      updatedAt: row.updated_at,
    };
  }

  delete(documentId: string): void {
    this.deleteStmt.run(documentId);
  }
}
