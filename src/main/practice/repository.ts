import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parsePortableJson } from '@shared/models/portable';
import { documentAnchorSchema } from '@shared/schemas/annotation';
import {
  nativePracticeSourceSchema, practiceCardSchema, practiceCreateImportedSchema, practiceCreateSchema,
  practiceDueSchema, practiceRateSchema, practiceSourceSchema,
  type PracticeCard, type PracticeSource, type PracticeExportDetails,
} from '@shared/schemas/practice';
import { nextSchedule } from './schedule';
import type { InterleafDatabase } from '../db/database';

type Row = {
  id: string; question: string; source_json: string; evidence: string; source_label: string;
  due_at: string; interval_days: number; repetitions: number; lapses: number; revision: number;
};
type NativeRow = { document_hash: string; anchor_json: string; selected_text: string | null; status: string; title: string; file_hash: string };

/** Integration owns the imported record; this resolver must read from the same profile database. */
export type VerifiedPassageResolver = (source: Extract<PracticeSource, { kind: 'native' }>, chunkId: string) => { readonly evidence: string; readonly label: string } | null;
export type ImportedPracticeResolver = (id: string) => { readonly evidence: string; readonly label: string; readonly details: PracticeExportDetails; readonly native: Extract<PracticeSource, { kind: 'native' }> | null } | null;

export class PracticeRepository {
  private readonly db: DatabaseSync;
  constructor(database: InterleafDatabase, private readonly resolveImported: ImportedPracticeResolver = () => null, private readonly now: () => Date = () => new Date(), private readonly resolvePassage: VerifiedPassageResolver = () => null) {
    this.db = database.raw;
  }

  createFromHighlight(input: { documentId: string; annotationId: string; question: string }): PracticeCard {
    const req = practiceCreateSchema.parse(input);
    const row = this.db.prepare(`SELECT a.document_hash, a.anchor_json, a.selected_text, a.status, d.title, d.file_hash
      FROM annotations a JOIN documents d ON d.id = a.document_id
      WHERE a.document_id = ? AND a.id = ? AND a.type = 'highlight'`).get(req.documentId, req.annotationId) as NativeRow | undefined;
    if (!row?.selected_text || row.status !== 'anchored' || row.file_hash !== row.document_hash) {
      throw new InterleafError('validation', 'The highlight is missing or its source needs to be restored.');
    }
    const source = nativePracticeSourceSchema.parse({ kind: 'native', documentId: req.documentId, documentHash: row.document_hash,
      annotationId: req.annotationId, anchor: parsePortableJson(row.anchor_json) });
    if (source.anchor.quote.exact !== row.selected_text) throw new InterleafError('validation', 'The highlight text does not match its saved anchor.');
    return this.insert(req.question, source, row.selected_text, row.title, null);
  }

  createFromImported(input: { importedHighlightId: string; question: string }): PracticeCard {
    const req = practiceCreateImportedSchema.parse(input);
    const record = this.resolveImported(req.importedHighlightId);
    if (!record) throw new InterleafError('validation', 'The imported highlight is unavailable.');
    return this.insert(req.question, { kind: 'imported', importedHighlightId: req.importedHighlightId }, record.evidence, record.label, null);
  }

  /** Called only by main's proposal acceptance while its transaction is active. */
  acceptVerifiedPassage(input: { question: string; source: Extract<PracticeSource, { kind: 'native' }>; chunkId: string; idempotencyKey: string }): PracticeCard {
    const source = nativePracticeSourceSchema.parse({ ...input.source, chunkId: input.chunkId });
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new InterleafError('validation', 'Invalid acceptance key.');
    const prior = this.db.prepare('SELECT * FROM practice_cards WHERE idempotency_key = ?').get(input.idempotencyKey) as Row | undefined;
    if (prior) {
      if (prior.question !== input.question.trim() || prior.source_json !== JSON.stringify(source)) throw new InterleafError('validation', 'The acceptance key belongs to a different card.');
      return this.map(prior);
    }
    if (this.nativeState(source) !== 'available') throw new InterleafError('validation', 'The source passage is unavailable or changed.');
    const resolved = this.resolvePassage(source, input.chunkId);
    if (!resolved) throw new InterleafError('validation', 'The source passage could not be verified.');
    return this.insert(input.question, source, resolved.evidence, resolved.label, input.idempotencyKey);
  }

  due(input: { limit: number }): readonly PracticeCard[] {
    const { limit } = practiceDueSchema.parse(input);
    const rows = this.db.prepare('SELECT * FROM practice_cards WHERE due_at <= ? ORDER BY due_at, id LIMIT ?').all(this.now().toISOString(), limit) as Row[];
    return rows.map((row) => this.map(row));
  }

  get(id: string): PracticeCard | null {
    const row = this.db.prepare('SELECT * FROM practice_cards WHERE id = ?').get(id) as Row | undefined;
    return row ? this.map(row) : null;
  }

  rate(input: { cardId: string; revision: number; rating: 'again' | 'hard' | 'good' | 'easy' }): PracticeCard {
    const req = practiceRateSchema.parse(input);
    const current = this.get(req.cardId);
    if (current?.revision !== req.revision) throw new InterleafError('validation', 'This card has changed. Reload the review queue.');
    const schedule = nextSchedule(current, req.rating);
    const now = this.now();
    const due = new Date(now.getTime() + schedule.intervalDays * 86_400_000).toISOString();
    const result = this.db.prepare(`UPDATE practice_cards SET due_at = ?, interval_days = ?, repetitions = ?, lapses = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(due, schedule.intervalDays, schedule.repetitions, schedule.lapses, now.toISOString(), req.cardId, req.revision);
    if (Number(result.changes) !== 1) throw new InterleafError('validation', 'This card has changed. Reload the review queue.');
    const updated = this.get(req.cardId);
    if (!updated) throw new InterleafError('internal', 'The card could not be loaded.');
    return updated;
  }

  private insert(question: string, source: PracticeSource, evidence: string, label: string, key: string | null): PracticeCard {
    const parsed = practiceCardSchema.omit({ id: true, dueAt: true, intervalDays: true, repetitions: true, lapses: true, revision: true, sourceState: true, navigation: true, exportDetails: true })
      .parse({ question, source, evidence, sourceLabel: label });
    if (key !== null && (key.length === 0 || key.length > 200)) throw new InterleafError('validation', 'Invalid acceptance key.');
    const existing = key === null ? undefined : this.db.prepare('SELECT * FROM practice_cards WHERE idempotency_key = ?').get(key) as Row | undefined;
    if (existing) return this.map(existing);
    const id = randomUUID();
    const now = this.now().toISOString();
    this.db.prepare(`INSERT INTO practice_cards (id, question, source_json, evidence, source_label, due_at, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, parsed.question, JSON.stringify(parsed.source), parsed.evidence, parsed.sourceLabel, now, key, now, now);
    const card = this.get(id);
    if (!card) throw new InterleafError('internal', 'The card could not be loaded.');
    return card;
  }

  private nativeState(source: Extract<PracticeSource, { kind: 'native' }>): PracticeCard['sourceState'] {
    const doc = this.db.prepare('SELECT file_hash FROM documents WHERE id = ?').get(source.documentId) as { file_hash: string } | undefined;
    if (!doc) return 'missing';
    if (doc.file_hash !== source.documentHash) return 'changed';
    if (source.annotationId !== null) {
      const annotation = this.db.prepare('SELECT status, document_hash, anchor_json, selected_text FROM annotations WHERE document_id = ? AND id = ? AND type = ?')
        .get(source.documentId, source.annotationId, 'highlight') as { status: string; document_hash: string; anchor_json: string; selected_text: string | null } | undefined;
      if (!annotation) return 'missing';
      if (annotation.document_hash !== source.documentHash) return 'changed';
      if (annotation.status !== 'anchored') return 'unanchored';
      if (annotation.selected_text !== source.anchor.quote.exact || !samePassageAnchor(annotation.anchor_json, source.anchor)) return 'changed';
    }
    return 'available';
  }

  private map(row: Row): PracticeCard {
    const source = practiceSourceSchema.parse(parsePortableJson(row.source_json));
    const imported = source.kind === 'imported' ? this.resolveImported(source.importedHighlightId) : null;
    const native = source.kind === 'native' ? source : imported?.native ?? null;
    const sourceState = native ? this.nativeState(native) : source.kind === 'imported' && imported ? 'export-only' : 'missing';
    const navigation = sourceState === 'available' ? native : null;
    return practiceCardSchema.parse({ id: row.id, question: row.question, source, evidence: imported?.evidence ?? row.evidence, sourceLabel: imported?.label ?? row.source_label, exportDetails: imported?.details ?? null, navigation,
      dueAt: row.due_at, intervalDays: row.interval_days, repetitions: row.repetitions, lapses: row.lapses, revision: row.revision, sourceState });
  }
}

/** Ebook layout repair may update progression without moving the native passage. */
function samePassageAnchor(raw: string, saved: Extract<PracticeSource, { kind: 'native' }>['anchor']): boolean {
  try {
    const result = documentAnchorSchema.safeParse(parsePortableJson(raw));
    if (!result.success) return false;
    const current = result.data;
    if ((saved.format === 'epub' || saved.format === 'mobi') && current.format === saved.format
      && saved.progression !== undefined && current.progression !== undefined) {
      return JSON.stringify({ ...current, progression: saved.progression }) === JSON.stringify(saved);
    }
    return JSON.stringify(current) === JSON.stringify(saved);
  } catch {
    return false;
  }
}
