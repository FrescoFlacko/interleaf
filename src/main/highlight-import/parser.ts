/** Parsing is limited before any file data is accepted into memory or storage. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_FIELD = 32000;
const MAX_QUOTE = 20000;
const MAX_TITLE = 250;
const MAX_AUTHOR = 150;
const MAX_COLUMNS = 64;

export type ImportedSource = {
  readonly provider: 'kindle' | 'readwise';
  readonly title: string;
  readonly author: string | null;
  readonly quote: string;
  readonly note: string | null;
  readonly location: string | null;
  readonly date: string | null;
};
export type ParsedImport = { readonly records: readonly ImportedSource[]; readonly warnings: readonly string[] };

export function decodeImport(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('The import file exceeds the 5 MB limit.');
  let encoding = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start)); }
  catch { throw new Error('The file must be UTF-8 or BOM-marked UTF-16.'); }
}

/** Strict RFC 4180-style rows, including escaped quotes and embedded line breaks. */
export function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  function pushField(): void {
    if (field.length > MAX_FIELD || row.length >= MAX_COLUMNS) throw new Error('A CSV field or row exceeds the import limit.');
    row.push(field); field = ''; closed = false;
  }
  function pushRow(): void {
    pushField();
    if (rows.length >= MAX_RECORDS + 1) throw new Error('The CSV contains too many rows.');
    rows.push(row); row = [];
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"' && field.length === 0 && !closed) quoted = true;
    else if (ch === ',') pushField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
    } else if (closed || ch === '"') throw new Error('The CSV contains malformed quoted fields.');
    else field += ch;
    if (field.length > MAX_FIELD) throw new Error('A CSV field exceeds the import limit.');
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (field.length > 0 || row.length > 0 || closed) pushRow();
  return rows;
}

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === '' ? null : (trimmed ?? null);
}

export function parseReadwise(text: string): ParsedImport {
  const rows = parseCsv(text);
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const title = header.includes('book title') ? header.indexOf('book title') : header.indexOf('title');
  const quote = header.indexOf('highlight');
  if (title < 0 || quote < 0) throw new Error('Expected a Readwise Highlights bulk CSV with Book Title (or Title) and Highlight columns. Reader library metadata exports are not supported.');
  const author = header.includes('book author') ? header.indexOf('book author') : header.indexOf('author');
  const note = header.indexOf('note');
  const location = header.indexOf('location');
  const date = header.indexOf('highlighted at');
  const records: ImportedSource[] = [];
  let rejected = 0;
  for (const row of rows.slice(1)) {
    if (row.every((value) => value.trim() === '')) continue;
    const sourceTitle = row[title]?.trim();
    const sourceQuote = row[quote]?.trim();
    if (row.length !== header.length || !sourceTitle || !sourceQuote || sourceTitle.length > MAX_TITLE || sourceQuote.length > MAX_QUOTE || (row[author]?.trim().length ?? 0) > MAX_AUTHOR) { rejected += 1; continue; }
    records.push({ provider: 'readwise', title: sourceTitle, author: nonempty(row[author]),
      quote: sourceQuote, note: nonempty(row[note]), location: nonempty(row[location]),
      date: nonempty(row[date]) });
  }
  return { records, warnings: rejected ? [`${String(rejected)} malformed, incomplete, or over-limit CSV rows were skipped (title 250, author 150, highlight 20,000 characters).`] : [] };
}

export function parseKindle(text: string): ParsedImport {
  const entries = text.replace(/\r\n?/g, '\n').split(/^==========\s*$/m);
  if (entries.length > MAX_RECORDS + 1) throw new Error('The clippings file contains too many entries.');
  const records: ImportedSource[] = [];
  let unsupported = 0;
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const lines = entry.replace(/^\n+|\n+$/g, '').split('\n');
    const heading = lines[0]?.trim();
    const metadata = lines[1]?.trim();
    if (!heading || !metadata?.startsWith('- ')) { malformed += 1; continue; }
    if (!/\bhighlight\b/i.test(metadata)) { unsupported += 1; continue; }
    const content = lines.slice(2).join('\n').trim();
    if (!content || content.length > MAX_QUOTE || heading.length > MAX_TITLE + MAX_AUTHOR + 3 || metadata.length > MAX_FIELD) { malformed += 1; continue; }
    const match = /^(.*?)\s+\(([^()]*)\)$/.exec(heading);
    if ((match?.[1]?.trim().length ?? heading.length) > MAX_TITLE || (match?.[2]?.trim().length ?? 0) > MAX_AUTHOR) { malformed += 1; continue; }
    const parts = metadata.slice(2).split('|').map((part) => part.trim());
    records.push({ provider: 'kindle', title: nonempty(match?.[1]) ?? heading, author: nonempty(match?.[2]),
      quote: content, note: null, location: nonempty(parts[0]), date: nonempty(parts.slice(1).join(' | ')) });
  }
  const warnings: string[] = [];
  if (unsupported) warnings.push(`${String(unsupported)} notes, bookmarks, or unrecognized clipping types were not imported.`);
  if (malformed) warnings.push(`${String(malformed)} malformed or over-limit clippings were skipped (title 250, author 150, highlight 20,000 characters).`);
  return { records, warnings };
}
