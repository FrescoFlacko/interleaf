import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { normalizeFolderNameKey, type InterleafDatabase } from '../database';
import type { Folder, FolderTree } from '@shared/types/document';
import { InterleafError } from '@shared/errors/interleaf-error';

export type FolderRecord = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly documentCount: number;
};

type Row = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  doc_count: number;
};

export class FolderRepository {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly renameStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly findByIdStmt: StatementSync;
  private readonly listStmt: StatementSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.insertStmt = this.db.prepare(`
      INSERT INTO folders (id, name, name_key, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      RETURNING id, name, parent_id, created_at, updated_at
    `);
    this.renameStmt = this.db.prepare(`
      UPDATE folders
      SET name = ?, name_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING id, name, parent_id, created_at, updated_at
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM folders WHERE id = ?
    `);
    this.findByIdStmt = this.db.prepare(`
      SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at,
             COUNT(d.id) AS doc_count
      FROM folders f
      LEFT JOIN documents d ON d.folder_id = f.id
      WHERE f.id = ?
      GROUP BY f.id
    `);
    this.listStmt = this.db.prepare(`
      SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at,
             COUNT(d.id) AS doc_count
      FROM folders f
      LEFT JOIN documents d ON d.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.name COLLATE NOCASE ASC
    `);
  }

  validateName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new InterleafError('validation', 'Folder name cannot be empty.');
    }
    if (trimmed.length > 255) {
      throw new InterleafError('validation', 'Folder name cannot exceed 255 characters.');
    }
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
      throw new InterleafError('validation', 'Folder name contains invalid control characters.');
    }
    return trimmed;
  }

  create(id: string, rawName: string, parentId?: string | null): FolderRecord {
    const name = this.validateName(rawName);
    const normalizedParent = parentId && parentId.trim().length > 0 ? parentId.trim() : null;

    if (normalizedParent !== null) {
      const parent = this.findById(normalizedParent);
      if (!parent) {
        throw new InterleafError('validation', `Parent folder with ID '${normalizedParent}' does not exist.`);
      }
    }
    this.assertSiblingNameAvailable(name, normalizedParent);

    const row = this.insertStmt.get(
      id,
      name,
      normalizeFolderNameKey(name),
      normalizedParent
    ) as Row | undefined;
    if (!row) {
      throw new InterleafError('internal', 'Failed to insert folder record.');
    }
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documentCount: 0,
    };
  }

  rename(id: string, rawName: string): FolderRecord {
    const name = this.validateName(rawName);
    const existing = this.findById(id);
    if (!existing) {
      throw new InterleafError('validation', `Folder with ID '${id}' not found.`);
    }
    this.assertSiblingNameAvailable(name, existing.parentId, id);

    const row = this.renameStmt.get(name, normalizeFolderNameKey(name), id) as Row | undefined;
    if (!row) {
      throw new InterleafError('internal', `Failed to rename folder '${id}'.`);
    }
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documentCount: existing.documentCount,
    };
  }

  delete(id: string): void {
    const existing = this.findById(id);
    if (!existing) {
      return;
    }
    this.deleteStmt.run(id);
  }

  findById(id: string): FolderRecord | null {
    const row = this.findByIdStmt.get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documentCount: row.doc_count,
    };
  }

  list(): readonly FolderRecord[] {
    const rows = this.listStmt.all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      documentCount: r.doc_count,
    }));
  }

  /**
   * Validates that setting targetParentId as the parent of folderId will not create a cycle.
   */
  validateNoCycle(folderId: string, targetParentId: string | null): void {
    if (targetParentId === null) {
      return;
    }
    if (folderId === targetParentId) {
      throw new InterleafError('validation', 'A folder cannot be its own parent.');
    }

    let currentParentId: string | null = targetParentId;
    const visited = new Set<string>();

    while (currentParentId !== null) {
      if (currentParentId === folderId) {
        throw new InterleafError('validation', 'Cannot move a folder into one of its descendants.');
      }
      if (visited.has(currentParentId)) {
        throw new InterleafError('validation', 'Cycle detected in folder hierarchy.');
      }
      visited.add(currentParentId);

      const parent = this.findById(currentParentId);
      currentParentId = parent?.parentId ?? null;
    }
  }

  private assertSiblingNameAvailable(
    name: string,
    parentId: string | null,
    excludeId?: string
  ): void {
    const row = this.db
      .prepare(`
        SELECT id FROM folders
        WHERE name_key = ?
          AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
          AND (? IS NULL OR id <> ?)
        LIMIT 1
      `)
      .get(
        normalizeFolderNameKey(name),
        parentId,
        parentId,
        excludeId ?? null,
        excludeId ?? null
      );
    if (row !== undefined) {
      throw new InterleafError(
        'validation',
        'A folder with this name already exists at the selected level.'
      );
    }
  }

  getTree(): readonly FolderTree[] {
    const allFolders = this.list();
    const folderMap = new Map<string, Folder & { children: FolderTree[] }>();

    for (const f of allFolders) {
      folderMap.set(f.id, {
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        documentCount: f.documentCount,
        children: [],
      });
    }

    const roots: FolderTree[] = [];
    for (const f of allFolders) {
      const node = folderMap.get(f.id);
      if (!node) continue;
      if (f.parentId) {
        const parentNode = folderMap.get(f.parentId);
        if (parentNode) {
          parentNode.children.push(node);
          continue;
        }
      }
      roots.push(node);
    }

    return roots;
  }
}
