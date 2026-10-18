/**
 * Plain-text diff rendering for an isolated copy, where no Git repository can
 * produce the patch.
 *
 * Every input is bounded: oversized or binary files are named rather than
 * read, and a diff past the line limit is refused instead of rendered.
 */
import { lstat, readFile } from 'node:fs/promises';
import { InterleafError } from '@shared/errors/interleaf-error';

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export function formatMode(mode: number | bigint, directory = false): string {
  return `${directory ? '040' : '100'}${(Number(mode) & 0o777).toString(8).padStart(3, '0')}`;
}

export async function boundedText(path: string): Promise<string> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size > MAX_DIFF_BYTES) return '[binary or oversized file omitted]\n';
    const bytes = await readFile(path);
    if (bytes.includes(0)) return '[binary file omitted]\n';
    return bytes.toString('utf8').slice(0, MAX_DIFF_BYTES);
  } catch { return ''; }
}

export function simpleUnifiedDiff(before: string, after: string): string {
  const a = before.split(/\r?\n/u).filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const b = after.split(/\r?\n/u).filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  if (max > 20_000) throw new InterleafError('validation', 'The generated unified diff exceeds the bounded line limit.');
  for (let index = 0; index < max; index += 1) {
    const beforeLine = a[index];
    const afterLine = b[index];
    if (beforeLine === afterLine) { if (beforeLine !== undefined) lines.push(` ${beforeLine}`); }
    else {
      if (beforeLine !== undefined) lines.push(`-${beforeLine}`);
      if (afterLine !== undefined) lines.push(`+${afterLine}`);
    }
  }
  return `@@ -1,${String(a.length)} +1,${String(b.length)} @@\n${lines.join('\n')}\n`;
}
