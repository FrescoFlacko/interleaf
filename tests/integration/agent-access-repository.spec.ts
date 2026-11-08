import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ReadingPositionRepository } from '@main/db/repositories/reading-position-repository';
import { SearchRepository } from '@main/db/repositories/search-repository';
import { ProposalRepository } from '@main/agent-access/proposal-repository';
import { agentProposalInputSchema } from '@shared/schemas/agent-access';
import type { AgentProposalInput } from '@shared/schemas/agent-access';

function setup(): InterleafDatabase {
  const db = InterleafDatabase.open(':memory:');
  runMigrations(db);
  new DocumentRepository(db).insert({ id: 'doc', title: 'Fixture', author: null, format: 'pdf',
    filePath: '/fixture.pdf', storageMode: 'link', fileSize: 1, fileMtimeMs: 1, fileHash: 'hash', pageCount: 1 });
  const search = new SearchRepository(db);
  const generation = search.begin('doc', 'hash');
  search.append('doc', 'hash', generation.generationId, [{ ordinal: 0, text: 'The chosen source passage.',
    location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: null }]);
  search.complete('doc', 'hash', generation.generationId);
  return db;
}

function proposal(db: InterleafDatabase): AgentProposalInput {
  const hit = new SearchRepository(db).search('doc', 'chosen')[0];
  if (!hit) throw new Error('fixture search missing');
  return { kind: 'annotation', text: 'A note', source: { documentId: 'doc', documentHash: 'hash', chunkId: hit.chunkId,
    anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'chosen', prefix: '', suffix: '' },
      textStart: 4, textEnd: 10, rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }] } } };
}

describe('agent access persistence', () => {
  it('records only future reading position writes and cascades with the document', () => {
    const db = setup();
    try {
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM reading_history').get()).toMatchObject({ count: 0 });
      const positions = new ReadingPositionRepository(db);
      positions.upsert('doc', JSON.stringify({ format: 'pdf', pageIndex: 0 }), 0.1);
      positions.upsert('doc', JSON.stringify({ format: 'pdf', pageIndex: 0 }), 0.5);
      expect(db.raw.prepare('SELECT document_hash, progress FROM reading_history ORDER BY id').all())
        .toEqual([{ document_hash: 'hash', progress: 0.1 }, { document_hash: 'hash', progress: 0.5 }]);
      db.raw.prepare('DELETE FROM documents WHERE id = ?').run('doc');
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM reading_history').get()).toMatchObject({ count: 0 });
    } finally { db.close(); }
  });

  it('rejects stale and mismatched sources and refuses oversized cards', () => {
    const db = setup();
    try {
      const repo = new ProposalRepository(db, { annotation: () => 'unused' });
      const valid = proposal(db);
      const wrong = { ...valid, source: { ...valid.source, anchor: { ...valid.source.anchor, pageIndex: 1 } } };
      expect(() => repo.submit(wrong as AgentProposalInput)).toThrow();
      expect(agentProposalInputSchema.safeParse({ ...valid, kind: 'card', text: 'x'.repeat(2001) }).success).toBe(false);
      db.raw.prepare("UPDATE documents SET file_hash = 'changed' WHERE id = 'doc'").run();
      expect(() => repo.submit(valid)).toThrow(/stale/);
    } finally { db.close(); }
  });

  it('keeps unsupported kinds pending and allows explicit rejection', () => {
    const db = setup();
    try {
      const repo = new ProposalRepository(db, { annotation: () => 'unused' });
      expect(repo.canAccept('annotation')).toBe(true);
      expect(repo.canAccept('question')).toBe(false);
      expect(repo.canAccept('card')).toBe(false);
      const input = { ...proposal(db), kind: 'question' as const };
      const pending = repo.submit(input);
      expect(() => repo.resolve(pending.id, 'accept')).toThrow(/not available/);
      expect(repo.list()).toHaveLength(1);
      expect(repo.resolve(pending.id, 'reject').status).toBe('rejected');
      expect(repo.resolve(pending.id, 'reject').status).toBe('rejected');
    } finally { db.close(); }
  });

  it('rolls back a failed handler, retries once, and makes acceptance idempotent', () => {
    const db = setup();
    try {
      let calls = 0;
      let receivedId = '';
      const repo = new ProposalRepository(db, { annotation: (_input, context) => {
        receivedId = context.proposalId;
        calls += 1;
        db.raw.prepare("INSERT INTO settings(key, value_json) VALUES ('proposal-test', '{}')").run();
        if (calls === 1) throw new Error('fixture failure');
        return 'artifact';
      } });
      const pending = repo.submit(proposal(db));
      expect(() => repo.resolve(pending.id, 'accept')).toThrow('fixture failure');
      expect(repo.list()).toHaveLength(1);
      expect(db.raw.prepare("SELECT key FROM settings WHERE key = 'proposal-test'").get()).toBeUndefined();
      expect(repo.resolve(pending.id, 'accept')).toMatchObject({ status: 'accepted', resultId: 'artifact' });
      expect(repo.resolve(pending.id, 'accept')).toMatchObject({ status: 'accepted', resultId: 'artifact' });
      expect(calls).toBe(2);
      expect(receivedId).toBe(pending.id);
      expect(() => repo.resolve(pending.id, 'reject')).toThrow(/already been resolved/);
    } finally { db.close(); }
  });
});
