// @vitest-environment jsdom
import * as pdfjsLib from 'pdfjs-dist';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF_FIXTURE_CASES } from './pdf-fixture-cases';

/**
 * `makePdfFixture` must keep producing exactly the bytes it always has: the
 * hashes below were taken from the generator before its byte accounting was
 * made incremental, for every case in `pdf-fixture-cases.ts`. Building a book
 * must also cost work in proportion to its size: the byte length of what has
 * been written is counted as it grows, never re-measured from the start for
 * every object, which made a 6,000-page book cost billions of string reads.
 */
const FROZEN: Readonly<Record<string, { readonly length: number; readonly sha256: string }>> = {
  default: { length: 2867, sha256: '541c46efcf301cc1b1d35106bf085513e18f010dc76baa757e7fea27ab4031a5' },
  'every option, non-ASCII': { length: 3259, sha256: '01c011077c98f717954408e4c111cd5962b03e75b1fe46f2c4c2571078e694e5' },
  'normal 50 pages': { length: 17994, sha256: '9715f2c0f18d5842b42f0d757ad7b901c311f6c947765f8e180a6ec3d4b1321b' },
  'agent-book 6000 pages': { length: 1910508, sha256: 'e8ebbda2a8bd4209ac6d2b1ce26ae1afd0a235b23b048337f758469004488abd' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function caseNamed(name: string): () => Buffer {
  const found = PDF_FIXTURE_CASES.find(([caseName]) => caseName === name);
  if (found === undefined) throw new Error(`No fixture case ${name}.`);
  return found[1];
}

describe('makePdfFixture bytes', () => {
  for (const [name, make] of PDF_FIXTURE_CASES) {
    it(`builds exactly the frozen bytes: ${name}`, () => {
      const bytes = make();
      expect({ length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }).toEqual(FROZEN[name]);
    }, 60_000);
  }

  it('measures each part once: total byte-length work stays proportional to the book', () => {
    // A counting wrapper that keeps only a running total: a spy would retain every measured string.
    let measured = 0;
    const real = Buffer.byteLength;
    const counting: typeof Buffer.byteLength = (value, encoding) => {
      if (typeof value === 'string') measured += value.length;
      return real.call(Buffer, value, encoding);
    };
    Buffer.byteLength = counting;
    let length = 0;
    try {
      length = caseNamed('agent-book 6000 pages')().length;
    } finally {
      Buffer.byteLength = real;
    }
    expect(measured).toBeLessThanOrEqual(4 * length);
  }, 60_000);

  it('every xref offset points at its object, and pdf.js reads the same pages', async () => {
    const bytes = caseNamed('agent-book 6000 pages')();
    const text = bytes.toString('latin1');
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 5)).toBe('xref\n');
    const entries = text.slice(startxref).split('\n').slice(3).filter((line) => line.endsWith(' 00000 n '));
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${String(index + 1)} 0 obj`.length)).toBe(`${String(index + 1)} 0 obj`);
    });

    const loading = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
    const document = await loading.promise;
    try {
      expect(document.numPages).toBe(6_000);
      for (const pageNumber of [1, 2, 3_001, 6_000]) {
        const content = await (await document.getPage(pageNumber)).getTextContent();
        const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join('');
        expect(pageText).toBe(`Long book page ${String(pageNumber)} text.`);
      }
    } finally {
      await loading.destroy();
    }
  }, 120_000);

  it('a non-ASCII book keeps its offsets in bytes, not characters', () => {
    const bytes = caseNamed('every option, non-ASCII')();
    const text = bytes.toString('latin1');
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(text)?.[1]);
    const entries = text.slice(startxref).split('\n').slice(3).filter((line) => line.endsWith(' 00000 n '));
    expect(entries.length).toBeGreaterThan(10);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${String(index + 1)} 0 obj`.length)).toBe(`${String(index + 1)} 0 obj`);
    });
  });
});
