import { describe, expect, test } from 'vitest';
import { StorageManager } from '../../src/main/library/storage-manager';
import { createLogger } from '../../src/main/logging/logger';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

async function withStorage(
  prefix: string,
  use: (context: { tempDir: string; libraryDir: string; storage: StorageManager }) => Promise<void>
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const libraryDir = join(tempDir, 'library');
  const storage = new StorageManager(libraryDir, createLogger('library'));
  await storage.initialize();
  try {
    await use({ tempDir, libraryDir, storage });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Smallest PNG header the cover snapshot writer accepts: a 1×1 IHDR. */
function minimalPng(): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  return png;
}

describe('StorageManager', () => {
  test('ingestFile in managed copy mode places file at hash-addressed path and deduplicates', async () => {
    await withStorage('storage-test-', async ({ tempDir, libraryDir, storage }) => {
      const sourceDir = join(tempDir, 'source');
      mkdirSync(sourceDir);
      const sourceFile = join(sourceDir, 'sample.pdf');
      const content = '%PDF-1.7 sample document binary payload';
      writeFileSync(sourceFile, content);

      const expectedHash = sha256(content).toLowerCase();

      // First ingestion
      const result1 = await storage.ingestFile(sourceFile, 'managed');
      expect(result1.fileHash).toBe(expectedHash);
      expect(result1.isDeduplicated).toBe(false);
      expect(existsSync(result1.finalPath)).toBe(true);

      const prefix = expectedHash.slice(0, 2);
      expect(result1.finalPath).toContain(join(libraryDir, prefix, `${expectedHash}.pdf`));
      expect(readFileSync(result1.finalPath, 'utf8')).toBe(content);

      // Second ingestion of identical content (from another source file)
      const anotherSource = join(sourceDir, 'duplicate.pdf');
      writeFileSync(anotherSource, content);

      const result2 = await storage.ingestFile(anotherSource, 'managed');
      expect(result2.fileHash).toBe(expectedHash);
      expect(result2.finalPath).toBe(result1.finalPath);
      expect(result2.isDeduplicated).toBe(true);
    });
  });

  test('ingestFile in link-in-place mode retains original path without copying', async () => {
    await withStorage('storage-link-test-', async ({ tempDir, storage }) => {
      const sourceFile = join(tempDir, 'linked.epub');
      const content = 'PK\x03\x04 epub content';
      writeFileSync(sourceFile, content);

      const expectedHash = sha256(content).toLowerCase();
      const stats = statSync(sourceFile);

      const result = await storage.ingestFile(sourceFile, 'link');
      expect(result.finalPath).toBe(realpathSync(sourceFile));
      expect(result.fileHash).toBe(expectedHash);
      expect(result.fileSize).toBe(stats.size);
      expect(result.isDeduplicated).toBe(false);
    });
  });

  test('detects link health status correctly (ok, changed, missing)', async () => {
    await withStorage('storage-health-test-', async ({ tempDir, storage }) => {
      const linkedFile = join(tempDir, 'active.pdf');
      const originalContent = '%PDF-1.4 original content';
      writeFileSync(linkedFile, originalContent);

      const originalHash = sha256(originalContent).toLowerCase();
      const stats = statSync(linkedFile);
      const checkHealth = () =>
        storage.checkStorageHealth(linkedFile, 'link', originalHash, stats.size, Math.round(stats.mtimeMs));

      // 1. Check unchanged file -> 'ok'
      expect((await checkHealth()).status).toBe('ok');

      // 2. Modify file content -> 'changed'
      writeFileSync(linkedFile, '%PDF-1.4 modified new content');
      const health2 = await checkHealth();
      expect(health2.status).toBe('changed');
      expect(health2.message).toContain('changed');

      // A sync/restore tool may preserve both size and timestamp. Link mode
      // still verifies content rather than trusting that stat tuple.
      const sameLengthReplacement = originalContent.replace('original', 'replaced');
      expect(Buffer.byteLength(sameLengthReplacement)).toBe(Buffer.byteLength(originalContent));
      writeFileSync(linkedFile, sameLengthReplacement);
      utimesSync(linkedFile, stats.atime, stats.mtime);
      expect((await checkHealth()).status).toBe('changed');

      // 3. Delete file -> 'missing'
      rmSync(linkedFile);
      const health3 = await checkHealth();
      expect(health3.status).toBe('missing');
      expect(health3.message).toContain('moved/deleted');
    });
  });

  test.skipIf(process.platform === 'win32')('rejects a selected symbolic-link source', async () => {
    await withStorage('storage-symlink-test-', async ({ tempDir, storage }) => {
      const target = join(tempDir, 'target.pdf');
      const selectedLink = join(tempDir, 'selected.pdf');
      writeFileSync(target, '%PDF-1.4 target');
      symlinkSync(target, selectedLink);
      await expect(storage.ingestFile(selectedLink, 'managed')).rejects.toThrow(/symbolic links/i);
    });
  });

  test.skipIf(process.platform === 'win32')('rejects a symlinked managed hash directory', async () => {
    await withStorage('storage-managed-symlink-test-', async ({ tempDir, libraryDir, storage }) => {
      const content = '%PDF-1.4 managed containment';
      const source = join(tempDir, 'source.pdf');
      writeFileSync(source, content);
      const prefix = sha256(content).slice(0, 2);
      const outside = join(tempDir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(libraryDir, prefix), 'dir');

      await expect(storage.ingestFile(source, 'managed')).rejects.toThrow(/containment/i);
      expect(existsSync(join(outside, `${sha256(content)}.pdf`))).toBe(false);
    });
  });

  test('reconcileAbandonedTempFiles removes stray .tmp files on startup', async () => {
    await withStorage('storage-reconcile-test-', async ({ storage }) => {
      const stray1 = join(storage.tempDirPath, 'abandoned-1.tmp');
      const stray2 = join(storage.tempDirPath, 'abandoned-2.tmp');
      const keeper = join(storage.tempDirPath, 'not-a-temp-file.txt');

      writeFileSync(stray1, 'partial content 1');
      writeFileSync(stray2, 'partial content 2');
      writeFileSync(keeper, 'do not delete');

      const cleaned = await storage.reconcileAbandonedTempFiles();
      expect(cleaned).toBe(2);
      expect(existsSync(stray1)).toBe(false);
      expect(existsSync(stray2)).toBe(false);
      expect(existsSync(keeper)).toBe(true);
    });
  });

  test('stages a linked reader asset under its verified hash and replaces corrupt cache data', async () => {
    await withStorage('storage-stage-test-', async ({ tempDir, storage }) => {
      const content = '%PDF-1.7 linked reader asset';
      const source = join(tempDir, 'linked.pdf');
      writeFileSync(source, content);
      const hash = sha256(content);

      const staged = await storage.stageLinkedFile(source, hash, 'pdf');
      expect(staged).toBe(realpathSync(join(storage.rootPath, '.staged', `${hash}.pdf`)));
      expect(readFileSync(staged, 'utf8')).toBe(content);

      rmSync(staged);
      writeFileSync(staged, 'corrupt cache entry');
      const restaged = await storage.stageLinkedFile(source, hash, 'pdf');
      expect(restaged).toBe(staged);
      expect(readFileSync(restaged, 'utf8')).toBe(content);
    });
  });

  test.skipIf(process.platform === 'win32')(
    'replaces a staged-path symlink without touching its target',
    async () => {
      await withStorage('storage-stage-symlink-test-', async ({ tempDir, storage }) => {
        const content = '%PDF-1.7 safe linked reader asset';
        const source = join(tempDir, 'linked.pdf');
        const outside = join(tempDir, 'outside.pdf');
        writeFileSync(source, content);
        writeFileSync(outside, 'outside must remain unchanged');
        const hash = sha256(content);
        const stagedDir = join(storage.rootPath, '.staged');
        mkdirSync(stagedDir);
        const staged = join(stagedDir, `${hash}.pdf`);
        symlinkSync(outside, staged);

        const result = await storage.stageLinkedFile(source, hash, 'pdf');
        expect(result).toBe(realpathSync(staged));
        expect(readFileSync(staged, 'utf8')).toBe(content);
        expect(readFileSync(outside, 'utf8')).toBe('outside must remain unchanged');
      });
    }
  );

  test('reconciles staged reader assets while retaining live capability paths', async () => {
    await withStorage('storage-stage-reconcile-test-', async ({ storage }) => {
      const stagedDir = join(storage.rootPath, '.staged');
      mkdirSync(stagedDir);
      const retained = join(stagedDir, `${'a'.repeat(64)}.pdf`);
      const orphan = join(stagedDir, `${'b'.repeat(64)}.epub`);
      const unrelated = join(stagedDir, 'keep-unexpected.txt');
      writeFileSync(retained, 'retained');
      writeFileSync(orphan, 'orphan');
      writeFileSync(unrelated, 'unexpected');

      const removed = await storage.reconcileUnusedStagedFiles(
        new Set([realpathSync(retained)])
      );
      expect(removed).toBe(1);
      expect(existsSync(retained)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    });
  });

  test('reconciles only old, unreferenced hash-shaped managed blobs', async () => {
    await withStorage('storage-orphan-reconcile-test-', async ({ tempDir, storage }) => {
      const retainedSource = join(tempDir, 'retained.pdf');
      const orphanSource = join(tempDir, 'orphan.pdf');
      writeFileSync(retainedSource, '%PDF-1.4 retained managed content');
      writeFileSync(orphanSource, '%PDF-1.4 orphaned managed content');
      const retained = await storage.ingestFile(retainedSource, 'managed');
      const orphan = await storage.ingestFile(orphanSource, 'managed');

      const old = new Date(Date.now() - 60_000);
      utimesSync(retained.finalPath, old, old);
      utimesSync(orphan.finalPath, old, old);
      const removed = await storage.reconcileOrphanedManagedFiles([retained.finalPath], 1);

      expect(removed).toBe(1);
      expect(existsSync(retained.finalPath)).toBe(true);
      expect(existsSync(orphan.finalPath)).toBe(false);
    });
  });

  test('reconcileOrphanedManagedFiles evaluates dynamic reference provider right before unlinking', async () => {
    await withStorage('storage-orphan-dynamic-test-', async ({ tempDir, storage }) => {
      const docSource = join(tempDir, 'doc.pdf');
      writeFileSync(docSource, '%PDF-1.4 dynamic referenced managed content');
      const ingested = await storage.ingestFile(docSource, 'managed');

      const old = new Date(Date.now() - 60_000);
      utimesSync(ingested.finalPath, old, old);

      // Initially provider has no references, but when queried before deletion it returns the path
      let queriedCount = 0;
      const dynamicProvider = () => {
        queriedCount++;
        return queriedCount > 1 ? [ingested.finalPath] : [];
      };

      const removed = await storage.reconcileOrphanedManagedFiles(dynamicProvider, 1);
      expect(removed).toBe(0);
      expect(existsSync(ingested.finalPath)).toBe(true);
    });
  });

  test('checkStorageHealth deduplicates concurrent in-flight checks for linked files', async () => {
    await withStorage('storage-dedup-health-test-', async ({ tempDir, storage }) => {
      const sourceFile = join(tempDir, 'linked.pdf');
      writeFileSync(sourceFile, '%PDF-1.4 linked book content payload');
      const ingest = await storage.ingestFile(sourceFile, 'link');

      // Fire 5 concurrent health checks simultaneously
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          storage.checkStorageHealth(ingest.finalPath, 'link', ingest.fileHash, ingest.fileSize, ingest.fileMtimeMs)
        )
      );

      expect(results.every((r) => r.status === 'ok')).toBe(true);
    });
  });

  test('deleteManagedFileIfOrphaned safely removes managed binaries', async () => {
    await withStorage('storage-delete-test-', async ({ tempDir, storage }) => {
      const sourceFile = join(tempDir, 'book.docx');
      writeFileSync(sourceFile, 'PK\x03\x04 word doc');
      const ingest = await storage.ingestFile(sourceFile, 'managed');

      expect(existsSync(ingest.finalPath)).toBe(true);

      // If referenced elsewhere -> not deleted
      const kept = await storage.deleteManagedFileIfOrphaned(ingest.finalPath, true);
      expect(kept).toBe(false);
      expect(existsSync(ingest.finalPath)).toBe(true);

      // If orphaned -> deleted
      const deleted = await storage.deleteManagedFileIfOrphaned(ingest.finalPath, false);
      expect(deleted).toBe(true);
      expect(existsSync(ingest.finalPath)).toBe(false);
    });
  });

  test('converges concurrent cover writes on one verified hash artifact', async () => {
    await withStorage('storage-cover-write-test-', async ({ storage }) => {
      const hash = 'a'.repeat(64);
      const png = minimalPng();
      const paths = await Promise.all(
        Array.from({ length: 8 }, () => storage.writeCoverSnapshot(hash, png))
      );
      expect(new Set(paths).size).toBe(1);
      expect(await storage.getCoverSnapshot(hash)).toBe(paths[0]);
    });
  });

  test('reconciles aged orphaned cover snapshots without touching referenced hashes', async () => {
    await withStorage('storage-cover-reconcile-test-', async ({ storage }) => {
      const orphanHash = 'b'.repeat(64);
      const retainedHash = 'c'.repeat(64);
      const png = minimalPng();
      const orphanPath = await storage.writeCoverSnapshot(orphanHash, png);
      const retainedPath = await storage.writeCoverSnapshot(retainedHash, png);
      const old = new Date(Date.now() - 60_000);
      utimesSync(orphanPath, old, old);
      utimesSync(retainedPath, old, old);

      expect(await storage.reconcileOrphanedCoverSnapshots([retainedHash], 1)).toBe(1);
      expect(existsSync(orphanPath)).toBe(false);
      expect(existsSync(retainedPath)).toBe(true);
    });
  });
});
