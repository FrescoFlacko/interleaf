import { createHash } from 'node:crypto';
import type { ImportedSource } from './parser';
/** A grouping handle for the exact title/author pair, not proof of a match. */
export function sourceKey(source: ImportedSource): string {
  return createHash('sha256').update(JSON.stringify([source.title, source.author])).digest('hex');
}
