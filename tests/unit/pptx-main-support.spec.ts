import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  normalizeExtension,
  validateFileBufferSignature,
  validateFileSignature,
} from '../../src/main/library/file-signatures';
import { ALLOWED_MIME_TYPES } from '../../src/main/security/asset-registry';
import { DOCUMENT_FILE_FILTERS } from '../../src/main/library/document-file-filters';
import { makeDocxFixture } from '../fixtures/document-fixtures';
import { makePptxFixture } from '../fixtures/pptx-fixtures';

describe('PPTX main-process support', () => {
  test('recognizes .pptx case-insensitively and serves the presentation MIME type', () => {
    expect(normalizeExtension('deck.pptx')).toBe('pptx');
    expect(normalizeExtension('DECK.PPTX')).toBe('pptx');
    expect(normalizeExtension('deck.pptm')).toBeNull();
    expect(normalizeExtension('deck.ppt')).toBeNull();
    expect(ALLOWED_MIME_TYPES['.pptx']).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  test('offers PPTX in the native file dialog filters', () => {
    expect(DOCUMENT_FILE_FILTERS[0]?.extensions).toContain('pptx');
    expect(DOCUMENT_FILE_FILTERS.some((filter) => filter.extensions.join() === 'pptx')).toBe(true);
  });

  test('accepts a real presentation package from a buffer and from disk', async () => {
    const deck = makePptxFixture();
    expect(validateFileBufferSignature(deck, 'pptx', deck)).toEqual({ ok: true, format: 'pptx' });
    const dir = mkdtempSync(join(tmpdir(), 'interleaf-pptx-sig-'));
    try {
      const path = join(dir, 'Deck.PPTX');
      writeFileSync(path, deck);
      await expect(validateFileSignature(path)).resolves.toEqual({ ok: true, format: 'pptx' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a Word package renamed to .pptx and a deck renamed to .docx', () => {
    const docx = makeDocxFixture();
    expect(validateFileBufferSignature(docx, 'pptx', docx).ok).toBe(false);
    const deck = makePptxFixture();
    expect(validateFileBufferSignature(deck, 'docx', deck).ok).toBe(false);
  });

  test('rejects non-ZIP and encrypted compound-file input named .pptx', () => {
    const text = Buffer.from('plain text, not a presentation');
    expect(validateFileBufferSignature(text, 'pptx', text).ok).toBe(false);
    const compound = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(compound);
    expect(validateFileBufferSignature(compound, 'pptx', compound).ok).toBe(false);
  });
});
