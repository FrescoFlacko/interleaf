import { describe, expect, it } from 'vitest';
import { documentFormatSchema } from '@shared/schemas/document';
import {
  DOCUMENT_EXTENSIONS,
  documentExtensionsFor,
  documentFormatForExtension,
  REFLOWABLE_DOCUMENT_FORMATS,
} from '@shared/constants/document-formats';
import { normalizeExtension, validateFileSignature } from '@main/library/file-signatures';
import { isOpenablePath } from '@main/open-files/open-file-requests';
import { deriveTitleFromFilename } from '@main/library/metadata-extractor';
import { DOCUMENT_FILE_FILTERS } from '@main/library/document-file-filters';

/**
 * The format registry is the one list of extensions Interleaf reads. These pin
 * the lists it replaced, so moving them to one place changed no answer.
 */
describe('document format registry', () => {
  it('keeps the shipped extensions, order and owning formats', () => {
    expect(DOCUMENT_EXTENSIONS).toEqual(['pdf', 'epub', 'mobi', 'azw', 'azw3', 'docx', 'pptx', 'md', 'markdown']);
    expect(documentExtensionsFor('mobi')).toEqual(['mobi', 'azw', 'azw3']);
    expect(documentExtensionsFor('markdown')).toEqual(['md', 'markdown']);
  });

  it('reads every format from at least one extension', () => {
    for (const format of documentFormatSchema.options) {
      expect(documentExtensionsFor(format).length, format).toBeGreaterThan(0);
    }
  });

  it('matches extensions case-insensitively, with or without the dot, and nothing else', () => {
    expect(documentFormatForExtension('.AZW3')).toBe('mobi');
    expect(documentFormatForExtension('Markdown')).toBe('markdown');
    for (const unsupported of ['', '.', '.txt', 'constructor', '__proto__', '.toString', 'pdf.']) {
      expect(documentFormatForExtension(unsupported), unsupported).toBeNull();
    }
  });

  it('answers import, open-with and title derivation from the same list', async () => {
    expect(normalizeExtension('/books/Book.AZW')).toBe('mobi');
    expect(normalizeExtension('/books/notes.txt')).toBeNull();
    expect(normalizeExtension('/books/README')).toBeNull();
    expect(isOpenablePath('/books/Deck.PPTX')).toBe(true);
    expect(isOpenablePath('/books/archive.zip')).toBe(false);
    expect(isOpenablePath('/books/noextension')).toBe(false);
    expect(deriveTitleFromFilename('/books/azw3.azw3')).toBe('Untitled Document');
    expect(deriveTitleFromFilename('/books/Good_Book.pdf')).toBe('Good Book');
    await expect(validateFileSignature('/books/notes.txt')).resolves.toEqual({
      ok: false,
      error: "Unsupported file extension: '.txt'. Supported extensions are .pdf, .epub, .mobi, .azw, .azw3, .docx, .pptx, .md, .markdown.",
    });
  });

  it('keeps the native dialog filters', () => {
    expect(DOCUMENT_FILE_FILTERS.map((filter) => filter.extensions)).toEqual([
      ['pdf', 'epub', 'mobi', 'azw', 'azw3', 'docx', 'pptx', 'md', 'markdown'],
      ['pdf'],
      ['epub'],
      ['mobi', 'azw', 'azw3'],
      ['docx'],
      ['pptx'],
      ['md', 'markdown'],
    ]);
  });

  it('reflows every format but PDF', () => {
    expect(documentFormatSchema.options.filter((format) => !REFLOWABLE_DOCUMENT_FORMATS.has(format))).toEqual(['pdf']);
  });
});
