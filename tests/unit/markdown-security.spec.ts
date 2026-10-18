import { describe, expect, it } from 'vitest';
import {
  normalizeExtension,
  validateFileBufferSignature,
} from '../../src/main/library/file-signatures';
import { extractDocumentMetadata } from '../../src/main/library/metadata-extractor';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('markdown security boundaries', () => {
  describe('file-signatures: markdown validation', () => {
    it('normalizes .md and .markdown extensions', () => {
      expect(normalizeExtension('notes.md')).toBe('markdown');
      expect(normalizeExtension('notes.MARKDOWN')).toBe('markdown');
      expect(normalizeExtension('README.Md')).toBe('markdown');
      expect(normalizeExtension('doc.MD')).toBe('markdown');
    });

    it('accepts valid UTF-8 text as markdown', () => {
      const valid = Buffer.from('# Hello\n\nSome text with émojis 🎉', 'utf-8');
      expect(validateFileBufferSignature(valid, 'markdown')).toEqual({ ok: true, format: 'markdown' });
    });

    it('rejects binary files containing null bytes', () => {
      const binary = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]);
      const result = validateFileBufferSignature(binary, 'markdown');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('binary');
    });

    it('rejects invalid UTF-8 bytes deep in payload', () => {
      const validPrefix = Buffer.alloc(5000, 0x61); // 5000 'a's
      const invalidSuffix = Buffer.from([0xff, 0xfe]);
      const combined = Buffer.concat([validPrefix, invalidSuffix]);
      const result = validateFileBufferSignature(combined, 'markdown');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('UTF-8');
    });

    it('rejects empty buffer', () => {
      const result = validateFileBufferSignature(Buffer.alloc(0), 'markdown');
      expect(result.ok).toBe(false);
    });

    it('accepts UTF-8 with BOM', () => {
      const withBom = Buffer.from('\uFEFF# Title', 'utf-8');
      expect(validateFileBufferSignature(withBom, 'markdown')).toEqual({ ok: true, format: 'markdown' });
    });
  });

  describe('metadata-extractor: markdown', () => {
    const extractFrom = async (fileName: string, content: string) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'interleaf-md-meta-'));
      try {
        const mdPath = join(tempDir, fileName);
        writeFileSync(mdPath, content);
        return await extractDocumentMetadata(mdPath, 'markdown');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    };

    it('extracts title from frontmatter', async () => {
      const meta = await extractFrom('doc.md', '---\ntitle: "My Doc"\nauthor: "Jane Doe"\n---\n\n# H1');
      expect(meta.title).toBe('My Doc');
      expect(meta.author).toBe('Jane Doe');
      expect(meta.pageCount).toBeNull();
    });

    it('extracts title from first H1 heading when no frontmatter', async () => {
      const meta = await extractFrom('readme.md', '# Project README\n\nSome content');
      expect(meta.title).toBe('Project README');
      expect(meta.author).toBeNull();
    });

    it('extracts title from Setext H1 heading when no frontmatter', async () => {
      const meta = await extractFrom('setext.md', 'Setext Title Document\n=====================\n\nSome paragraph');
      expect(meta.title).toBe('Setext Title Document');
      expect(meta.author).toBeNull();
    });

    it('falls back to filename-derived title', async () => {
      const meta = await extractFrom('my-notes.md', 'No heading here, just text content');
      expect(meta.title).toBe('my notes');
    });
  });
});
