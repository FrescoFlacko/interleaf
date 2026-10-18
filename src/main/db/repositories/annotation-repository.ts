import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { InterleafDatabase } from '../database';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  createAnnotationRequestSchema,
  parseDocumentAnchor,
  repairAnnotationAnchorRequestSchema,
  updateAnnotationRequestSchema,
} from '@shared/schemas/annotation';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationPage,
  AnnotationStatus,
  CreateAnnotationInput,
  HighlightColor,
  RepairAnnotationAnchorInput,
  UpdateAnnotationInput,
} from '@shared/types/annotation';
import type { DocumentFormat } from '@shared/types/document';
import { type PortableValue, parsePortableJson } from '@shared/models/portable';
import { hasParagraphFormat } from '@shared/document-format-family';

type AnnotationRow = {
  id: string;
  document_id: string;
  document_hash: string;
  type: Annotation['type'];
  anchor_json: string;
  selected_text: string | null;
  note: string | null;
  label: string | null;
  color: HighlightColor | null;
  is_location_note: number;
  status: AnnotationStatus;
  created_at: string;
  updated_at: string;
};

type DocumentIdentityRow = { file_hash: string; format: DocumentFormat };

function mapRow(row: AnnotationRow): Annotation {
  let parsed: PortableValue;
  try {
    parsed = parsePortableJson(row.anchor_json);
  } catch (error) {
    throw new InterleafError('internal', 'Stored annotation anchor is not valid JSON.', { cause: error instanceof Error ? error : null });
  }
  const anchor = parseDocumentAnchor(parsed);
  if (anchor === null) {
    throw new InterleafError('internal', 'Stored annotation anchor failed validation.');
  }
  return {
    id: row.id,
    documentId: row.document_id,
    documentHash: row.document_hash,
    type: row.type,
    anchor,
    selectedText: row.selected_text,
    note: row.note,
    label: row.label,
    color: row.color,
    isLocationNote: row.is_location_note === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class AnnotationRepository {
  private readonly db: DatabaseSync;
  private readonly documentIdentityStmt: StatementSync;
  private readonly insertStmt: StatementSync;
  private readonly findStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly repairStmt: StatementSync;

  constructor(database: InterleafDatabase) {
    this.db = database.raw;
    this.documentIdentityStmt = this.db.prepare(`
      SELECT file_hash, format FROM documents WHERE id = ?
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO annotations (
        id, document_id, document_hash, type, anchor_json, selected_text,
        note, label, color, is_location_note, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'anchored',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      RETURNING *
    `);
    this.findStmt = this.db.prepare(`
      SELECT * FROM annotations WHERE document_id = ? AND id = ?
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM annotations WHERE document_id = ? AND id = ? RETURNING *
    `);
    this.repairStmt = this.db.prepare(`
      UPDATE annotations
         SET anchor_json = ?, status = ?, document_hash = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE document_id = ? AND id = ?
      RETURNING *
    `);
  }

  create(input: CreateAnnotationInput): Annotation {
    const validated = createAnnotationRequestSchema.parse(input);
    const document = this.requireDocumentIdentity(validated.documentId);
    if (validated.anchor.format !== document.format) {
      throw new InterleafError('validation', 'Annotation anchor format does not match the document format.');
    }
    const row = this.insertStmt.get(
      randomUUID(),
      validated.documentId,
      document.file_hash,
      validated.type,
      JSON.stringify(validated.anchor),
      validated.selectedText ?? null,
      validated.note ?? null,
      validated.label ?? null,
      validated.color ?? null,
      validated.isLocationNote === true ? 1 : 0
    ) as AnnotationRow | undefined;
    if (!row) throw new Error('Failed to create annotation.');
    return mapRow(row);
  }

  private get(documentId: string, id: string): Annotation | null {
    const row = this.findStmt.get(documentId, id) as AnnotationRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(documentId: string, filter?: AnnotationFilter): readonly Annotation[] {
    return this.page(documentId, filter).items;
  }

  page(documentId: string, filter?: AnnotationFilter): AnnotationPage {
    const { clauses, params } = this.buildListWhere(documentId, filter);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM annotations WHERE ${clauses.join(' AND ')}`)
      .get(...params) as { total: number };
    const listParams = [...params];
    const orderBy =
      filter?.sort === 'created_asc'
        ? 'created_at ASC, id ASC'
        : filter?.sort === 'created_desc'
          ? 'created_at DESC, id DESC'
          : 'updated_at DESC, id DESC';
    const limit = Math.max(1, Math.min(100, filter?.limit ?? 50));
    const offset = Math.max(0, Math.min(10_000_000, filter?.offset ?? 0));
    listParams.push(limit, offset);
    const rows = this.db
      .prepare(`
        SELECT * FROM annotations
         WHERE ${clauses.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?
      `)
      .all(...listParams) as AnnotationRow[];
    return { items: rows.map(mapRow), total: countRow.total, offset, limit };
  }

  private buildListWhere(
    documentId: string,
    filter?: AnnotationFilter
  ): { readonly clauses: string[]; readonly params: (string | number)[] } {
    const clauses = ['document_id = ?'];
    const params: (string | number)[] = [documentId];
    if (filter?.type !== undefined) {
      clauses.push('type = ?');
      params.push(filter.type);
    }
    if (filter?.documentHashNot !== undefined) {
      clauses.push('document_hash <> ?');
      params.push(filter.documentHashNot);
    }
    const query = filter?.searchQuery?.slice(0, 200).trim();
    if (query) {
      const pattern = `%${escapeLike(query)}%`;
      clauses.push(`(
        COALESCE(selected_text, '') LIKE ? ESCAPE '\\' OR
        COALESCE(note, '') LIKE ? ESCAPE '\\' OR
        COALESCE(label, '') LIKE ? ESCAPE '\\'
      )`);
      params.push(pattern, pattern, pattern);
    }
    const scope = filter?.scope;
    if (scope?.format === 'pdf') {
      clauses.push("json_extract(anchor_json, '$.format') = 'pdf'");
      clauses.push(`(
        CAST(json_extract(anchor_json, '$.pageIndex') AS INTEGER) BETWEEN ? AND ?
        OR (
          json_type(anchor_json, '$.segments') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(anchor_json, '$.segments')
            WHERE CAST(json_extract(value, '$.pageIndex') AS INTEGER) BETWEEN ? AND ?
          )
        )
      )`);
      params.push(scope.pageStart, scope.pageEnd, scope.pageStart, scope.pageEnd);
    } else if (scope !== undefined && hasParagraphFormat(scope)) {
      clauses.push("json_extract(anchor_json, '$.format') = ?");
      params.push(scope.format);
      clauses.push(`(
        CAST(json_extract(anchor_json, '$.renderedPageIndex') AS INTEGER) BETWEEN ? AND ?
        OR (
          json_type(anchor_json, '$.segments') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(anchor_json, '$.segments')
            WHERE CAST(json_extract(value, '$.renderedPageIndex') AS INTEGER) BETWEEN ? AND ?
          )
        )
      )`);
      params.push(scope.pageStart, scope.pageEnd, scope.pageStart, scope.pageEnd);
    } else if (scope?.format === 'epub') {
      clauses.push("json_extract(anchor_json, '$.format') = 'epub'");
      clauses.push(`(
        json_extract(anchor_json, '$.spineHref') = ?
        OR (
          json_type(anchor_json, '$.segments') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(anchor_json, '$.segments')
            WHERE json_extract(value, '$.spineHref') = ?
          )
        )
      )`);
      params.push(scope.spineHref, scope.spineHref);
    } else if (scope?.format === 'mobi') {
      clauses.push("json_extract(anchor_json, '$.format') = 'mobi'");
      clauses.push(`(
        CAST(json_extract(anchor_json, '$.sectionIndex') AS INTEGER) = ?
        OR (
          json_type(anchor_json, '$.segments') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(anchor_json, '$.segments')
            WHERE CAST(json_extract(value, '$.sectionIndex') AS INTEGER) = ?
          )
        )
      )`);
      params.push(scope.sectionIndex, scope.sectionIndex);
    } else if (scope?.format === 'markdown') {
      clauses.push("json_extract(anchor_json, '$.format') = 'markdown'");
      clauses.push(`(
        CAST(json_extract(anchor_json, '$.blockIndex') AS INTEGER) BETWEEN ? AND ?
        OR (
          json_type(anchor_json, '$.segments') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(anchor_json, '$.segments')
            WHERE CAST(json_extract(value, '$.blockIndex') AS INTEGER) BETWEEN ? AND ?
          )
        )
      )`);
      params.push(scope.blockStart, scope.blockEnd, scope.blockStart, scope.blockEnd);
    }
    return { clauses, params };
  }

  update(input: UpdateAnnotationInput): Annotation | null {
    const validated = updateAnnotationRequestSchema.parse(input);
    const existing = this.get(validated.documentId, validated.id);
    if (existing === null) return null;
    this.assertValidUpdate(existing, validated);

    const assignments: string[] = [];
    const params: (string | null)[] = [];
    if (validated.note !== undefined) {
      assignments.push('note = ?');
      params.push(validated.note);
    }
    if (validated.label !== undefined) {
      assignments.push('label = ?');
      params.push(validated.label);
    }
    if (validated.color !== undefined) {
      assignments.push('color = ?');
      params.push(validated.color);
    }
    assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    params.push(validated.documentId, validated.id);
    const row = this.db
      .prepare(`
        UPDATE annotations SET ${assignments.join(', ')}
         WHERE document_id = ? AND id = ?
        RETURNING *
      `)
      .get(...params) as AnnotationRow | undefined;
    if (!row) throw new Error('Failed to update annotation.');
    return mapRow(row);
  }

  delete(documentId: string, id: string): Annotation | null {
    const row = this.deleteStmt.get(documentId, id) as AnnotationRow | undefined;
    return row ? mapRow(row) : null;
  }

  repairAnchor(input: RepairAnnotationAnchorInput): Annotation | null {
    const validated = repairAnnotationAnchorRequestSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(validated.documentId, validated.id);
      if (existing === null) {
        this.db.exec('COMMIT');
        return null;
      }
      const document = this.requireDocumentIdentity(validated.documentId);
      if (document.file_hash !== validated.documentHash) {
        throw new InterleafError('validation', 'The document changed before the anchor repair could be saved.');
      }
      if (document.format !== validated.anchor.format) {
        throw new InterleafError('validation', 'Annotation anchor format does not match the document format.');
      }
      this.assertValidRepairedAnchor(existing, validated.anchor);
      const row = this.repairStmt.get(
        JSON.stringify(validated.anchor),
        validated.status,
        document.file_hash,
        validated.documentId,
        validated.id
      ) as AnnotationRow | undefined;
      if (!row) throw new Error('Failed to repair annotation anchor.');
      const annotation = mapRow(row);
      this.db.exec('COMMIT');
      return annotation;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireDocumentIdentity(documentId: string): DocumentIdentityRow {
    const document = this.documentIdentityStmt.get(documentId) as DocumentIdentityRow | undefined;
    if (!document) {
      throw new InterleafError('validation', 'The annotation document does not exist.');
    }
    return document;
  }

  private assertValidUpdate(existing: Annotation, input: UpdateAnnotationInput): void {
    if (existing.type === 'highlight') {
      if (input.label !== undefined || input.color === null) {
        throw new InterleafError('validation', 'A highlight only permits note and non-null color updates.');
      }
      return;
    }
    if (existing.type === 'note') {
      if (input.label !== undefined || input.color !== undefined || input.note === null) {
        throw new InterleafError('validation', 'A note only permits a non-null note-text update.');
      }
      return;
    }
    if (input.note !== undefined || input.color !== undefined) {
      throw new InterleafError('validation', 'A bookmark only permits label updates.');
    }
  }

  private assertValidRepairedAnchor(existing: Annotation, anchor: Annotation['anchor']): void {
    const hasRange = anchor.quote.exact.length > 0;
    if (existing.type === 'highlight') {
      if (!hasRange || existing.selectedText !== anchor.quote.exact) {
        throw new InterleafError('validation', 'A highlight repair must preserve its selected quote.');
      }
      return;
    }
    if (existing.type === 'note') {
      if (existing.isLocationNote === hasRange) {
        throw new InterleafError('validation', 'A note repair cannot change between range and location semantics.');
      }
      if (!existing.isLocationNote && existing.selectedText !== anchor.quote.exact) {
        throw new InterleafError('validation', 'A range-note repair must preserve its selected quote.');
      }
      return;
    }
    if (hasRange) {
      throw new InterleafError('validation', 'A bookmark repair must preserve a location-only anchor.');
    }
  }
}
