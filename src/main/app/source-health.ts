import type { InterleafDatabase } from '../db/database';
import type { StorageManager } from '../library/storage-manager';

/** Check the actual source without handing its path to a caller or renderer. */
export function createSourceHealthCheck(database: InterleafDatabase, storage: StorageManager) {
  return async (documentId: string, expectedHash: string): Promise<boolean> => {
    const row = database.raw.prepare(`SELECT file_path, storage_mode, file_hash, file_size, file_mtime_ms
      FROM documents WHERE id = ?`).get(documentId) as {
        file_path: string; storage_mode: 'managed' | 'link'; file_hash: string; file_size: number; file_mtime_ms: number;
      } | undefined;
    if (row?.file_hash !== expectedHash) return false;
    const health = await storage.checkStorageHealth(row.file_path, row.storage_mode, row.file_hash, row.file_size, row.file_mtime_ms, false);
    return health.status === 'ok';
  };
}
