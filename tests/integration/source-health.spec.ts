import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { StorageManager } from '@main/library/storage-manager';
import { createLogger } from '@main/logging/logger';
import { createSourceHealthCheck } from '@main/app/source-health';

describe('source health at the filesystem boundary', () => {
  it('detects replaced and missing linked files even when size and timestamp are preserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interleaf-source-health-'));
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      const file = join(dir, 'source.md');
      writeFileSync(file, 'original');
      const storage = new StorageManager(join(dir, 'library'), createLogger('library'));
      await storage.initialize();
      const ingested = await storage.ingestFile(file, 'link');
      new DocumentRepository(db).insert({ id: 'doc', title: 'Document', author: null, format: 'markdown', filePath: ingested.finalPath,
        storageMode: 'link', fileSize: ingested.fileSize, fileMtimeMs: ingested.fileMtimeMs, fileHash: ingested.fileHash, pageCount: null });
      const check = createSourceHealthCheck(db, storage);
      expect(await check('doc', ingested.fileHash)).toBe(true);
      const before = statSync(file);
      writeFileSync(file, 'replaced');
      utimesSync(file, before.atime, before.mtime);
      expect(await check('doc', ingested.fileHash)).toBe(false);
      rmSync(file);
      expect(await check('doc', ingested.fileHash)).toBe(false);
      expect(await check('missing', ingested.fileHash)).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
