import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { applyMigrations, MIGRATIONS, runMigrations } from '@main/db/migrations';
import { LearningRepository } from '@main/db/repositories/learning-repository';
import { learningContentSchema, type LearningContent } from '@shared/schemas/learning';

const source = (documentId: string) => ({
  documentId, documentHash: `hash-${documentId}`,
  anchor: { format: 'markdown' as const, blockIndex: 1, quote: { exact: 'A passage', prefix: '', suffix: '' } },
});
const content: LearningContent = { kind: 'conflict', title: 'Compare', body: '<script>literal</script>', primary: source('d1'), secondary: source('d2') };

describe('learning persistence boundary', () => {
  it('upgrades the base schema and handles provenance, idempotence and revisions in a caller transaction', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 28));
      runMigrations(db);
      for (const id of ['d1', 'd2']) {
        db.raw.prepare(`INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
          VALUES (?, ?, 'markdown', ?, 'managed', 1, 1, ?)`).run(id, id, id, `hash-${id}`);
      }
      const repo = new LearningRepository(db);
      for (const kind of ['primer', 'question', 'checkpoint'] as const) {
        const manual = repo.create({ kind, primary: source('d1'), title: kind, body: 'Prompt' });
        expect(manual.provenance).toEqual({ kind: 'manual' });
        expect(repo.dismiss('d1', manual.id)?.status).toBe('dismissed');
        expect(repo.remove('d1', manual.id)).toBe(true);
      }
      expect(repo.sourceStatus(source('d2'))).toEqual({ status: 'current', title: 'd2' });
      expect(repo.sourceStatus(source('missing'))).toEqual({ status: 'missing', title: null });
      db.raw.exec('BEGIN IMMEDIATE');
      const saved = repo.acceptProposal('proposal-1', content);
      expect(repo.acceptProposal('proposal-1', content)?.id).toBe(saved?.id);
      db.raw.exec('ROLLBACK');
      expect(repo.list('d1')).toEqual([]);
      const accepted = repo.acceptProposal('proposal-1', content);
      expect(accepted?.provenance).toEqual({ kind: 'proposal', proposalId: 'proposal-1' });
      expect(accepted?.content.body).toBe('<script>literal</script>');
      expect(() => repo.acceptProposal('proposal-1', { ...content, body: 'different' })).toThrow();
      expect(repo.dismiss('d1', accepted!.id)?.status).toBe('dismissed');
      expect(repo.remove('d1', accepted!.id)).toBe(true);
      expect(repo.list('d1')).toEqual([]);
      expect(db.raw.prepare('SELECT content_json FROM learning_items WHERE id = ?').get(accepted!.id)).toMatchObject({ content_json: '{}' });
      expect(repo.acceptProposal('proposal-1', content)).toBeNull();
      db.raw.prepare("UPDATE documents SET file_hash = 'changed' WHERE id = 'd2'").run();
      expect(() => repo.create(content)).toThrow();
    } finally { db.close(); }
  });
  it('requires a second source for conflicts and rejects extra authority fields', () => {
    expect(learningContentSchema.safeParse({ ...content, secondary: undefined }).success).toBe(false);
    expect(learningContentSchema.safeParse({ ...content, verified: true }).success).toBe(false);
  });
});
