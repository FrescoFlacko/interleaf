import { describe, expect, it } from 'vitest';
import { decodeImport, parseCsv, parseKindle, parseReadwise, MAX_IMPORT_BYTES } from '../../src/main/highlight-import/parser';

describe('highlight import parsing', () => {
  it('decodes UTF-8 and BOM-marked UTF-16 strictly and bounds bytes', () => {
    expect(decodeImport(new Uint8Array([0xef, 0xbb, 0xbf, 65]))).toBe('A');
    expect(decodeImport(new Uint8Array([0xff, 0xfe, 65, 0]))).toBe('A');
    expect(() => decodeImport(new Uint8Array([0xff]))).toThrow();
    expect(() => decodeImport(new Uint8Array(MAX_IMPORT_BYTES + 1))).toThrow();
  });
  it('parses quoted newlines and escaped quotes and rejects broken quoting', () => {
    expect(parseCsv('a,b\r\n"one\ntwo","say ""hi"""')).toEqual([['a', 'b'], ['one\ntwo', 'say "hi"']]);
    expect(() => parseCsv('a\n"unfinished')).toThrow();
    expect(() => parseCsv('a\n"finished"x')).toThrow();
  });
  it('keeps literal formula-like content and reports malformed rows', () => {
    const result = parseReadwise('Title,Highlight,Note,Location\nBook,"=1+1","two\nlines",12\nMissing,,x,2\n');
    expect(result.records[0]).toMatchObject({ quote: '=1+1', note: 'two\nlines', location: '12' });
    expect(result.warnings).toHaveLength(1);
    expect(() => parseReadwise('Title,Author,URL\nBook,Author,example')).toThrow(/Reader library metadata/);
  });
  it('reports over-limit highlights instead of truncating them', () => {
    const result = parseReadwise(`Title,Highlight\nBook,${'x'.repeat(20001)}`);
    expect(result.records).toEqual([]);
    expect(result.warnings[0]).toContain('20,000');
  });
  it('reports notes and malformed clippings instead of silently dropping them', () => {
    const result = parseKindle('Book (Author)\n- Your Highlight on page 1 | Added today\n\nQuote\n==========\nBook (Author)\n- Your Note on page 1\n\nNote\n==========\nBad\n==========');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ title: 'Book', author: 'Author', quote: 'Quote', location: 'Your Highlight on page 1' });
    expect(result.warnings).toHaveLength(2);
  });
});
