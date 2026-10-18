import { describe, expect, test } from 'vitest';
import {
  deriveTitleFromFilename,
  extractDocumentMetadata,
} from '../../src/main/library/metadata-extractor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeDocxFixture, makeEpubFixture } from '../fixtures/document-fixtures';

describe('metadata-extractor', () => {
  test('deriveTitleFromFilename cleans up underscores and dashes', () => {
    expect(deriveTitleFromFilename('/path/to/Design_Patterns_Gang_of_Four.pdf')).toBe(
      'Design Patterns Gang of Four'
    );
    expect(deriveTitleFromFilename('C:\\books\\The-Rust-Programming-Language.epub')).toBe(
      'The Rust Programming Language'
    );
    expect(deriveTitleFromFilename('clean-title.docx')).toBe('clean title');
    expect(deriveTitleFromFilename('.pdf')).toBe('Untitled Document');
  });

  test('extracts title and author from PDF Info dictionary', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    try {
      const pdfPath = join(tempDir, 'sample_book.pdf');
      const pdfContent = `%PDF-1.4
1 0 obj
<<
  /Title (Distributed Systems Concepts)
  /Author (Leslie Lamport)
  /Count 42
>>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
      writeFileSync(pdfPath, pdfContent);

      const metadata = await extractDocumentMetadata(pdfPath, 'pdf');
      expect(metadata.title).toBe('Distributed Systems Concepts');
      expect(metadata.author).toBe('Leslie Lamport');
      expect(metadata.pageCount).toBe(42);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back safely to filename if PDF metadata is missing or corrupted', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    try {
      const pdfPath = join(tempDir, 'My_Special_Report.pdf');
      writeFileSync(pdfPath, '%PDF-1.4\nraw binary without title dictionary\n');

      const metadata = await extractDocumentMetadata(pdfPath, 'pdf');
      expect(metadata.title).toBe('My Special Report');
      expect(metadata.author).toBeNull();
      expect(metadata.pageCount).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('extracts metadata from EPUB xml tags', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    try {
      const epubPath = join(tempDir, 'novel.epub');
      writeFileSync(epubPath, makeEpubFixture('Clean Architecture', 'Robert C. Martin'));

      const metadata = await extractDocumentMetadata(epubPath, 'epub');
      expect(metadata.title).toBe('Clean Architecture');
      expect(metadata.author).toBe('Robert C. Martin');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('bounds oversized persisted title and author metadata', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-bounds-test-'));
    try {
      const epubPath = join(tempDir, 'oversized.epub');
      writeFileSync(epubPath, makeEpubFixture('T'.repeat(20_000), 'A'.repeat(20_000)));

      const metadata = await extractDocumentMetadata(epubPath, 'epub');
      expect(metadata.title).toHaveLength(512);
      expect(metadata.title.endsWith('…')).toBe(true);
      expect(metadata.author).toHaveLength(256);
      expect(metadata.author?.endsWith('…')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('extracts metadata from MOBI header', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    try {
      const mobiPath = join(tempDir, 'ebook.mobi');
      const mobiBuffer = Buffer.alloc(200);
      mobiBuffer.write('Structure and Interpretation', 0, 32, 'latin1');
      mobiBuffer.write('BOOKMOBI', 60, 8, 'ascii');
      writeFileSync(mobiPath, mobiBuffer);

      const metadata = await extractDocumentMetadata(mobiPath, 'mobi');
      expect(metadata.title).toBe('Structure and Interpretation');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('extracts metadata from DOCX xml tags', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    try {
      const docxPath = join(tempDir, 'spec.docx');
      writeFileSync(docxPath, makeDocxFixture('System Architecture Spec', 'Principal Architect'));

      const metadata = await extractDocumentMetadata(docxPath, 'docx');
      expect(metadata.title).toBe('System Architecture Spec');
      expect(metadata.author).toBe('Principal Architect');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
