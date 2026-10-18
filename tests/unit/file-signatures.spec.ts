import { describe, expect, test } from 'vitest';
import {
  normalizeExtension,
  validateFileBufferSignature,
  validateFileSignature,
} from '../../src/main/library/file-signatures';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strBytes, makeDocxFixture, makeEpubFixture } from '../fixtures/document-fixtures';
import { zipSync } from 'fflate';

function mutateCentralEntry(
  archive: Buffer,
  entryName: string,
  mutate: (copy: Buffer, headerOffset: number, nameOffset: number) => void
): Buffer {
  const copy = Buffer.from(archive);
  let offset = 0;
  while ((offset = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset)) !== -1) {
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const nameOffset = offset + 46;
    if (copy.toString('utf8', nameOffset, nameOffset + nameLength) === entryName) {
      mutate(copy, offset, nameOffset);
      return copy;
    }
    offset = nameOffset + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing central-directory fixture entry: ${entryName}`);
}

describe('file-signatures validation', () => {
  test('normalizes supported extensions and rejects unsupported ones', () => {
    expect(normalizeExtension('book.pdf')).toBe('pdf');
    expect(normalizeExtension('BOOK.PDF')).toBe('pdf');
    expect(normalizeExtension('novel.epub')).toBe('epub');
    expect(normalizeExtension('document.mobi')).toBe('mobi');
    expect(normalizeExtension('document.azw')).toBe('mobi');
    expect(normalizeExtension('document.azw3')).toBe('mobi');
    expect(normalizeExtension('paper.docx')).toBe('docx');

    expect(normalizeExtension('script.js')).toBeNull();
    expect(normalizeExtension('image.png')).toBeNull();
    expect(normalizeExtension('data.txt')).toBeNull();
    expect(normalizeExtension('binary.exe')).toBeNull();
  });

  test('validates valid PDF signature (%PDF-)', () => {
    const validPdfHeader = Buffer.from('%PDF-1.7\n%some binary data\n');
    const result = validateFileBufferSignature(validPdfHeader, 'pdf');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe('pdf');
    }
  });

  test('rejects PDF with missing signature', () => {
    const invalidBuffer = Buffer.from('This is not a PDF file at all.');
    const result = validateFileBufferSignature(invalidBuffer, 'pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing %PDF- header signature');
    }
  });

  test('validates EPUB only with its required first mimetype entry', () => {
    const validEpub = makeEpubFixture();
    const result = validateFileBufferSignature(validEpub, 'epub', validEpub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe('epub');
    }
  });

  test('rejects EPUB with invalid signature', () => {
    const invalidBuffer = Buffer.from('Not a zip archive');
    const result = validateFileBufferSignature(invalidBuffer, 'epub');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('container signature');
    }
  });

  test('validates valid MOBI PalmDOC signature at offset 60', () => {
    const mobiBuffer = Buffer.alloc(100);
    mobiBuffer.write('Sample Palm Database Name', 0, 32, 'latin1');
    mobiBuffer.write('BOOKMOBI', 60, 8, 'ascii');
    const result = validateFileBufferSignature(mobiBuffer, 'mobi');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe('mobi');
    }
  });

  test('rejects MOBI with missing BOOKMOBI identifier at offset 60', () => {
    const invalidBuffer = Buffer.alloc(100);
    invalidBuffer.write('Sample Database', 0, 32, 'latin1');
    invalidBuffer.write('NONEXIST', 60, 8, 'ascii');
    const result = validateFileBufferSignature(invalidBuffer, 'mobi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('header signature');
    }
  });

  test('validates DOCX only with mandatory OOXML package entries in central directory', () => {
    const validDocx = makeDocxFixture();
    const result = validateFileBufferSignature(validDocx, 'docx', validDocx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe('docx');
    }
  });

  test('rejects DOCX when mandatory entry is only a substring of another file name', () => {
    const fakeDocx = Buffer.from(
      zipSync({
        'word/document.xml.bak': strBytes('not a document'),
        'prefix_[Content_Types].xml': strBytes('not content types'),
      })
    );
    const result = validateFileBufferSignature(fakeDocx, 'docx', fakeDocx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid DOCX package structure');
    }
  });

  test('rejects DOCX when mandatory entry is missing [Content_Types].xml', () => {
    const missingTypes = Buffer.from(
      zipSync({
        'word/document.xml': strBytes('<w:document/>'),
      })
    );
    const result = validateFileBufferSignature(missingTypes, 'docx', missingTypes);
    expect(result.ok).toBe(false);
  });

  test('rejects DOCX when mandatory entry is missing word/document.xml', () => {
    const missingDoc = Buffer.from(
      zipSync({
        '[Content_Types].xml': strBytes('<Types/>'),
      })
    );
    const result = validateFileBufferSignature(missingDoc, 'docx', missingDoc);
    expect(result.ok).toBe(false);
  });

  test('rejects a forged central-directory name without a matching local entry', () => {
    const forged = mutateCentralEntry(
      Buffer.from(
        zipSync({
          '[Content_Types].xml': strBytes('<Types/>'),
          'word/not-real.xml': strBytes('<not-a-document/>'),
        })
      ),
      'word/not-real.xml',
      (copy, _headerOffset, nameOffset) => {
        Buffer.from('word/document.xml', 'ascii').copy(copy, nameOffset);
      }
    );
    expect(validateFileBufferSignature(forged, 'docx', forged).ok).toBe(false);
  });

  test('rejects encrypted or non-regular required DOCX entries', () => {
    const valid = makeDocxFixture();
    const encrypted = mutateCentralEntry(valid, 'word/document.xml', (copy, headerOffset) => {
      copy.writeUInt16LE(copy.readUInt16LE(headerOffset + 8) | 0x1, headerOffset + 8);
    });
    expect(validateFileBufferSignature(encrypted, 'docx', encrypted).ok).toBe(false);

    const symlink = mutateCentralEntry(valid, 'word/document.xml', (copy, headerOffset) => {
      copy.writeUInt16LE((3 << 8) | 20, headerOffset + 4);
      copy.writeUInt32LE((0xa000 << 16) >>> 0, headerOffset + 38);
    });
    expect(validateFileBufferSignature(symlink, 'docx', symlink).ok).toBe(false);
  });

  test('rejects a generic ZIP renamed to EPUB or DOCX', () => {
    const genericZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(validateFileBufferSignature(genericZip, 'epub').ok).toBe(false);
    expect(validateFileBufferSignature(genericZip, 'docx').ok).toBe(false);
  });
  test('rejects empty buffer (0 bytes)', () => {
    const emptyBuffer = Buffer.alloc(0);
    const result = validateFileBufferSignature(emptyBuffer, 'pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('empty');
    }
  });

  test('validateFileSignature on disk files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sig-test-'));
    try {
      const pdfPath = join(tempDir, 'valid.pdf');
      writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
      const validPdf = await validateFileSignature(pdfPath);
      expect(validPdf.ok).toBe(true);

      const fakePdfPath = join(tempDir, 'fake.pdf');
      writeFileSync(fakePdfPath, 'Hello world not a pdf');
      const fakePdf = await validateFileSignature(fakePdfPath);
      expect(fakePdf.ok).toBe(false);

      const txtPath = join(tempDir, 'file.txt');
      writeFileSync(txtPath, 'text file');
      const txtRes = await validateFileSignature(txtPath);
      expect(txtRes.ok).toBe(false);
      if (!txtRes.ok) {
        expect(txtRes.error).toContain('Unsupported file extension');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
