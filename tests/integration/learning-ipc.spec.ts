import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { LearningRepository } from '@main/db/repositories/learning-repository';
import { registerIpcHandlers, type IpcMainLike } from '@main/ipc/dispatcher';
import { makeIpcDeps, testSenderRule } from '../helpers/ipc-deps';
import { IPC } from '@shared/constants/ipc';
import type { CloneableValue } from '@shared/models/portable';

describe('learning IPC', () => {
  it('validates the actual sender and requests before touching the real repository', async () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      db.raw.prepare(`INSERT INTO documents (id, title, format, file_path, storage_mode, file_size, file_mtime_ms, file_hash)
        VALUES ('d1', 'Book', 'markdown', 'fixture', 'managed', 1, 1, 'hash')`).run();
      const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
      registerIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } },
        makeIpcDeps({ learning: new LearningRepository(db) }));
      const valid = { kind: 'question', title: 'Why?', body: '<img src=x>', primary: {
        documentId: 'd1', documentHash: 'hash', anchor: { format: 'markdown', blockIndex: 1, quote: { exact: 'Text', prefix: '', suffix: '' } },
      } } satisfies CloneableValue;
      const handler = handlers.get(IPC.learningCreate);
      expect(handler).toBeDefined();
      if (!handler) throw new Error('Missing handler');
      const trusted = { senderFrame: { url: testSenderRule.allowedProductionFileUrl } };
      const hostile = { senderFrame: { url: 'https://attacker.invalid/' } };
      expect(await handler(hostile, valid)).toMatchObject({ ok: false });
      expect(await handler(trusted, { ...valid, verified: true })).toMatchObject({ ok: false });
      expect(await handler(trusted, valid)).toMatchObject({ ok: true, data: { content: { body: '<img src=x>' } } });
    } finally { db.close(); }
  });
});
