import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PortableRecord } from '@shared/models/portable';

const PROMPT_FILE_PATTERN = /^[a-f0-9-]{36}\.prompt$/iu;
const MAX_PROMPT_FILES_PER_SWEEP = 512;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Remove only stale, regular prompt files from the app-owned directory. This
 * is deliberately bounded and symlink-aware so a crash cannot leave prompt
 * contents indefinitely while a malicious filesystem entry cannot redirect a
 * cleanup operation outside the directory.
 */
export type StoredPromptCleanupLogger = {
  warn(message: string, context?: PortableRecord): void;
};

export function cleanupStalePromptFiles(
  root: string,
  logger: StoredPromptCleanupLogger,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  unlinkFile: (path: string) => void = unlinkSync,
): number {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Custom prompt storage is not a private directory.');
  let removed = 0;
  for (const name of readdirSync(root, { encoding: 'utf8' }).slice(0, MAX_PROMPT_FILES_PER_SWEEP)) {
    if (!PROMPT_FILE_PATTERN.test(name)) continue;
    const file = join(root, name);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue;
      unlinkFile(file);
      removed += 1;
    } catch (error) {
      logger.warn('stale prompt file cleanup failed', { errorType: error instanceof Error ? error.name : typeof error });
    }
  }
  return removed;
}

export function assertPromptStorageAvailable(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Custom prompt storage is not a private directory.');
}

