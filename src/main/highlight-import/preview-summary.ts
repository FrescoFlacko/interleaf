import { sourceKey } from './source-key';
import type { ExternalHighlightRepository } from '../db/repositories/external-highlight-repository';
import type { ImportedSource } from './parser';
import type { ImportPreview } from '@shared/types/imported-highlight';
export function summarizeImport(records: readonly ImportedSource[], repository: ExternalHighlightRepository): Pick<ImportPreview, 'duplicates' | 'titles' | 'samples'> {
  const groups = new Map<string, { key: string; title: string; author: string | null; count: number }>();
  const seen = new Set<string>();
  let duplicates = 0;
  for (const record of records) {
    const identity = JSON.stringify(record);
    if (seen.has(identity) || repository.has(record)) duplicates += 1;
    seen.add(identity);
    const key = sourceKey(record);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { key, title: record.title, author: record.author, count: 1 });
  }
  return { duplicates, samples: records.slice(0, 20).map(({ title, quote, location }) => ({ title, quote, location })), titles: [...groups.values()] };
}
