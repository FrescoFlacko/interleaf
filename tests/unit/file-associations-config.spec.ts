import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENT_EXTENSIONS } from '../../src/shared/constants/document-formats';

/**
 * The document types the packaged application registers with the operating
 * system must be exactly the ones main accepts from `open-file`, argv and
 * `second-instance`, and Interleaf must register them as a viewer that never
 * takes a type over from the user's editor. Read as text, like the Linux
 * packaging spec, so no YAML dependency is added.
 */

const configText = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');

type Association = { readonly exts: readonly string[]; readonly fields: ReadonlyMap<string, string> };

function associationBlock(text: string): string[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
  const start = lines.indexOf('fileAssociations:');
  expect(start, 'expected a top-level fileAssociations block').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && !line.startsWith(' '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function parseExtensions(value: string): string[] {
  const list = /^\[(.*)\]$/.exec(value);
  return (list?.[1] ?? value).split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function associations(text: string): Association[] {
  const entries: Map<string, string>[] = [];
  for (const line of associationBlock(text)) {
    const field = /^\s*(-\s+)?(\w+):\s*(.*)$/.exec(line);
    if (field === null) continue;
    if (field[1] !== undefined) entries.push(new Map());
    entries.at(-1)?.set(field[2] ?? '', field[3] ?? '');
  }
  return entries.map((fields) => ({ exts: parseExtensions(fields.get('ext') ?? ''), fields }));
}

describe('electron-builder file associations', () => {
  const declared = associations(configText);

  it('registers exactly the extensions main accepts from the operating system', () => {
    const extensions = declared.flatMap((entry) => entry.exts).map((ext) => `.${ext}`).sort();
    expect(extensions).toEqual(DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).sort());
  });

  it('registers every type as a named, non-preferred viewer with a MIME type', () => {
    expect(declared.length).toBeGreaterThan(0);
    for (const entry of declared) {
      expect(entry.fields.get('role'), entry.exts.join(',')).toBe('Viewer');
      expect(entry.fields.get('rank'), entry.exts.join(',')).toBe('Alternate');
      expect(entry.fields.get('name')?.length ?? 0, entry.exts.join(',')).toBeGreaterThan(0);
      expect(entry.fields.get('mimeType') ?? '', entry.exts.join(',')).toMatch(/^[a-z]+\/[\w.+-]+$/);
    }
  });
});
