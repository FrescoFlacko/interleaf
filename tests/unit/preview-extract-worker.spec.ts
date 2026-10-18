import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractPreviewInWorker,
  MAX_PDF_SOURCE_BYTES,
  MAX_ARCHIVE_BYTES,
} from '../../src/main/workers/preview-extract-worker';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  makeDocxFixture,
  makeEpubFixture,
  makeLargeCoverStreamPdfFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';

/** Assembles numbered PDF objects behind a header, with a valid xref table and trailer. */
function assemblePdf(objects: readonly Buffer[], trailerEntries = ''): Buffer {
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`,
  );
  const trailer = Buffer.from(
    `trailer\n<< /Root 1 0 R${trailerEntries} /Size ${String(objects.length + 1)} >>\nstartxref\n${String(cursor)}\n%%EOF\n`,
  );
  return Buffer.concat([header, ...objects, xref, trailer]);
}

describe('preview-extract-worker', () => {
  it('renders a bounded PNG snapshot of PDF page one in the worker', async () => {
    const buffer = makePdfFixture({
      title: 'Cover PDF',
      author: 'Tester',
      pageLines: [['The first page is the persisted cover snapshot.']],
    });

    const result = await extractPreviewInWorker({
      format: 'pdf',
      buffer,
      renderCover: true,
    });

    expect(result.coverPng).toBeInstanceOf(Uint8Array);
    expect(result.coverPng?.subarray(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(result.snippet).toBeNull();
  });

  it('renders a large PDF from a canonical file path using bounded range reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'interleaf-preview-range-'));
    try {
      // Keep a valid xref at the tail while placing the >50 MiB payload in an
      // unreachable stream. PDF.js can therefore prove it only needs the
      // page-one ranges rather than ingesting the whole source into main.
      const padded = assemblePdf([
        Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
        Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
        Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000000 1000000000] /Resources << >> /Contents 4 0 R >>\nendobj\n'),
        Buffer.from('4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'),
        Buffer.concat([
          Buffer.from('5 0 obj\n<< /Length 52428800 >>\nstream\n'),
          Buffer.alloc(50 * 1024 * 1024, 0x78),
          Buffer.from('\nendstream\nendobj\n'),
        ]),
      ]);
      const filePath = join(root, 'large.pdf');
      writeFileSync(filePath, padded);
      const stats = statSync(filePath);
      const result = await extractPreviewInWorker({
        format: 'pdf',
        filePath: realpathSync(filePath),
        permittedRoot: dirname(realpathSync(filePath)),
        expectedFileSize: stats.size,
        expectedFileMtimeMs: Math.round(stats.mtimeMs),
        expectedFileDevice: stats.dev,
        expectedFileInode: stats.ino,
        renderCover: true,
      }, { timeoutMs: 15_000 });

      expect(result.coverPng?.subarray(0, 8)).toEqual(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      expect(result.sourceBytesRead).toBeLessThan(1024 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('renders page-one artwork whose contiguous range exceeds one bounded read', async () => {
    // PDF.js requests every missing chunk of a stream as one contiguous range.
    // A real cover's image stream (Designing Data-Intensive Applications) needed
    // 320 KiB in one request and the worker rejected it as an invalid range,
    // so the library card never received a cover.
    const root = mkdtempSync(join(tmpdir(), 'interleaf-preview-contiguous-'));
    try {
      const filePath = join(root, 'large-stream.pdf');
      writeFileSync(filePath, makeLargeCoverStreamPdfFixture());
      const canonicalPath = realpathSync(filePath);
      const stats = statSync(canonicalPath);
      const result = await extractPreviewInWorker({
        format: 'pdf',
        filePath: canonicalPath,
        permittedRoot: dirname(canonicalPath),
        expectedFileSize: stats.size,
        expectedFileMtimeMs: Math.round(stats.mtimeMs),
        expectedFileCtimeMs: Math.round(stats.ctimeMs),
        expectedFileDevice: stats.dev,
        expectedFileInode: stats.ino,
        renderCover: true,
      }, { timeoutMs: 15_000 });

      expect(result.rangeFailureReason).toBeUndefined();
      expect(result.coverPng).toBeInstanceOf(Uint8Array);
      expect(result.sourceBytesRead).toBeLessThanOrEqual(stats.size);

      // A PNG header alone does not prove artwork: the rectangle drawn after
      // the padding must be red, and the page outside it must stay white.
      const image = await loadImage(Buffer.from(result.coverPng ?? new Uint8Array()));
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const scale = image.width / 612;
      const pixel = (x: number, y: number): number[] =>
        Array.from(context.getImageData(Math.round(x * scale), Math.round((792 - y) * scale), 1, 1).data);
      expect(pixel(300, 400)).toEqual([255, 0, 0, 255]);
      expect(pixel(50, 750)).toEqual([255, 255, 255, 255]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a file-backed PDF range workload once the cumulative read budget is exhausted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'interleaf-preview-budget-'));
    try {
      const streamPayloadBytes = 200 * 1024;
      const streamCount = Math.ceil(MAX_PDF_SOURCE_BYTES / streamPayloadBytes) + 2;
      const contentRefs = Array.from({ length: streamCount }, (_, index) => `${String(index + 4)} 0 R`).join(' ');
      const pdf = assemblePdf([
        Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
        Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
        Buffer.from(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents [${contentRefs}] >>\nendobj\n`),
        ...Array.from({ length: streamCount }, (_, index) => Buffer.concat([
          Buffer.from(`${String(index + 4)} 0 obj\n<< /Length ${String(streamPayloadBytes)} >>\nstream\n`),
          Buffer.alloc(streamPayloadBytes, 0x20),
          Buffer.from('\nendstream\nendobj\n'),
        ])),
      ]);
      const filePath = join(root, 'budget.pdf');
      writeFileSync(filePath, pdf);
      const stats = statSync(filePath);
      const canonicalPath = realpathSync(filePath);
      const result = await extractPreviewInWorker({
        format: 'pdf',
        filePath: canonicalPath,
        permittedRoot: dirname(canonicalPath),
        expectedFileSize: stats.size,
        expectedFileMtimeMs: Math.round(stats.mtimeMs),
        expectedFileDevice: stats.dev,
        expectedFileInode: stats.ino,
        renderCover: true,
      }, { timeoutMs: 20_000 });

      expect(result.coverPng).toBeUndefined();
      expect(result.rangeFailureReason).toBe('source-byte-budget');
      expect(result.sourceBytesRead).toBeLessThanOrEqual(MAX_PDF_SOURCE_BYTES - 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('fails closed for an encrypted PDF instead of attempting to render protected content', async () => {
    const encrypted = assemblePdf([
      Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n'),
      Buffer.from('4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'),
      Buffer.from('5 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000> /P -4 >>\nendobj\n'),
    ], ' /Encrypt 5 0 R');

    const result = await extractPreviewInWorker({
      format: 'pdf',
      buffer: encrypted,
      renderCover: true,
    });

    expect(result.coverPng).toBeUndefined();
    expect(result.snippet).toBeNull();
  });

  it('extracts text from requested PDF page using pdfjs', async () => {
    const buffer = makePdfFixture({
      title: 'PDF Test',
      author: 'Tester',
      pageLines: [
        ['Page 1: Introduction to distributed algorithms and data structures.'],
        ['Page 2: Consensus protocols including Paxos and Raft mechanisms.'],
      ],
    });

    const result = await extractPreviewInWorker({
      format: 'pdf',
      buffer,
      targetPageIndex: 1,
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('Consensus protocols including Paxos');
    expect(result.actualPageIndex).toBe(1);
  });

  it('clamps PDF page index when requested page exceeds document pageCount', async () => {
    const buffer = makePdfFixture({
      title: 'PDF Test',
      author: 'Tester',
      pageLines: [
        ['Only page content in a single page PDF.'],
      ],
    });

    const result = await extractPreviewInWorker({
      format: 'pdf',
      buffer,
      targetPageIndex: 10,
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('Only page content');
    expect(result.actualPageIndex).toBe(0);
  });

  it('extracts Markdown blocks and strips frontmatter and formatting tokens', async () => {
    const md = `---
title: Post
date: 2026-01-01
---

# Architecture Overview

Interleaf runs with strict process isolation.

## Security Controls

All untrusted documents are sanitized.
`;
    const buffer = Buffer.from(md, 'utf-8');

    const result = await extractPreviewInWorker({
      format: 'markdown',
      buffer,
      targetBlockIndex: 1,
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('Interleaf runs with strict process isolation.');
    expect(result.snippet).not.toContain('title: Post');
    expect(result.actualBlockIndex).toBe(1);
  });

  it('extracts DOCX paragraphs matching requested paragraph index', async () => {
    const buffer = makeDocxFixture({
      title: 'DOCX Document',
      author: 'Engineer',
      bodyText: 'High performance desktop document reader.',
    });

    const result = await extractPreviewInWorker({
      format: 'docx',
      buffer,
      targetParagraphIndex: 0,
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('DOCX Foundations');
    expect(result.actualParagraphIndex).toBe(0);
  });

  it('extracts EPUB chapter text and matches target spine href', async () => {
    const buffer = makeEpubFixture({
      title: 'EPUB Book',
      author: 'Author',
      chapters: [
        { title: 'Chapter 1', content: '<p>Chapter 1 introductory text.</p>' },
        { title: 'Chapter 2', content: '<p>Chapter 2 deep technical content.</p>' },
      ],
    });

    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer,
      targetSpineHref: 'chapter2.xhtml',
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('Chapter 2 deep technical content.');
    expect(result.isSpineMatched).toBe(true);
  });

  it('extracts EPUB with >20 chapters where target is beyond entry 16 and OPF has reordered attributes and namespaces', async () => {
    // Build 25 chapters
    const chapters = Array.from({ length: 25 }, (_, i) => ({
      title: `Chapter ${String(i + 1)}`,
      content: `<p>This is detailed content for chapter ${String(i + 1)} with unique token XYZ_${String(i + 1)}.</p>`,
    }));

    // Build custom zip with reordered attributes: <opf:item href="chapter22.xhtml" id="c22" ...>
    const zipEntries: Record<string, Uint8Array> = {
      'mimetype': Buffer.from('application/epub+zip', 'utf-8'),
      'META-INF/container.xml': Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'utf-8'
      ),
    };

    const manifestItems = chapters.map(
      (_c, i) => `<opf:item href="text/ch_${String(i + 1)}.xhtml" id="ch_id_${String(i + 1)}" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const spineRefs = chapters.map(
      (_, i) => `<opf:itemref idref="ch_id_${String(i + 1)}"/>`
    ).join('\n');

    // Place more than eight decoy OPFs before the declared package in ZIP
    // order. The container-declared OPF must still be selected exactly.
    for (let i = 0; i < 12; i++) {
      zipEntries[`OEBPS/decoy-${String(i + 1)}.opf`] = Buffer.from('<package><manifest/></package>', 'utf-8');
    }

    zipEntries['OEBPS/package.opf'] = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`, 'utf-8');

    for (let i = 0; i < chapters.length; i++) {
      zipEntries[`OEBPS/text/ch_${String(i + 1)}.xhtml`] = Buffer.from(
        `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${chapters[i]!.title}</h1>${chapters[i]!.content}</body></html>`,
        'utf-8'
      );
    }

    const epubBuffer = Buffer.from(zipSync(zipEntries));

    // Request chapter 22 (entry index > 16)
    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer: epubBuffer,
      targetSpineHref: 'text/ch_22.xhtml',
    });

    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain('XYZ_22');
    expect(result.isSpineMatched).toBe(true);
  });

  it('rejects EPUB spine traversal that escapes the archive root', async () => {
    const zipEntries: Record<string, Uint8Array> = {
      'mimetype': Buffer.from('application/epub+zip', 'utf-8'),
      'META-INF/container.xml': Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'utf-8'
      ),
      'OEBPS/content.opf': Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="c1" href="../../escape.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>`, 'utf-8'),
      'escape.xhtml': Buffer.from('<html><body>Traversed file content</body></html>', 'utf-8'),
    };

    const epubBuffer = Buffer.from(zipSync(zipEntries));

    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer: epubBuffer,
      targetSpineHref: '../../escape.xhtml',
    });

    // Traversal must be rejected, resulting in null snippet (no escaped content extracted)
    expect(result.snippet).toBeNull();
    expect(result.isSpineMatched).toBeFalsy();
  });

  it('matches percent-encoded relative EPUB spine paths without decompressing unrelated chapters', async () => {
    const zipEntries: Record<string, Uint8Array> = {
      mimetype: Buffer.from('application/epub+zip'),
      'META-INF/container.xml': Buffer.from(
        '<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="OEBPS/content.opf"/></rootfiles></container>',
        'utf-8'
      ),
      'OEBPS/content.opf': Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item media-type="application/xhtml+xml" href="nested/ch%202.xhtml" id="chapter-two"/></manifest>
  <spine><itemref idref="chapter-two"/></spine>
</package>`, 'utf-8'),
      'OEBPS/nested/ch 2.xhtml': Buffer.from('<html><body><p>Percent encoded target chapter.</p></body></html>', 'utf-8'),
    };

    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer: Buffer.from(zipSync(zipEntries)),
      targetSpineHref: 'nested/ch%202.xhtml',
    });

    expect(result.snippet).toContain('Percent encoded target chapter.');
    expect(result.isSpineMatched).toBe(true);
  });

  it('resolves legitimate parent segments from a nested OPF while staying root-bounded', async () => {
    const zipEntries: Record<string, Uint8Array> = {
      mimetype: Buffer.from('application/epub+zip'),
      'META-INF/container.xml': Buffer.from(
        '<container><rootfiles><rootfile full-path="OPS/nested/package.opf"/></rootfiles></container>',
        'utf-8'
      ),
      'OPS/nested/package.opf': Buffer.from(`
        <package xmlns="http://www.idpf.org/2007/opf"><manifest>
          <item id="chapter" href="../Text/chapter.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="chapter"/></spine></package>`, 'utf-8'),
      'OPS/Text/chapter.xhtml': Buffer.from('<html><body><p>Nested OPF parent reference is safe.</p></body></html>', 'utf-8'),
    };

    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer: Buffer.from(zipSync(zipEntries)),
      targetSpineHref: '../Text/chapter.xhtml',
    });

    expect(result.snippet).toContain('Nested OPF parent reference is safe.');
    expect(result.isSpineMatched).toBe(true);
  });

  it('rejects percent-encoded traversal that escapes the EPUB root', async () => {
    const zipEntries: Record<string, Uint8Array> = {
      mimetype: Buffer.from('application/epub+zip'),
      'META-INF/container.xml': Buffer.from(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        'utf-8'
      ),
      'OEBPS/content.opf': Buffer.from(`
        <package xmlns="http://www.idpf.org/2007/opf"><manifest>
          <item id="escape" href="%2e%2e/%2e%2e/escape.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="escape"/></spine></package>`, 'utf-8'),
      'escape.xhtml': Buffer.from('<html><body>Should never be read.</body></html>', 'utf-8'),
    };

    const result = await extractPreviewInWorker({
      format: 'epub',
      buffer: Buffer.from(zipSync(zipEntries)),
      targetSpineHref: '%2e%2e/%2e%2e/escape.xhtml',
    });

    expect(result.snippet).toBeNull();
    expect(result.isSpineMatched).toBeFalsy();
  });

  it('reports unsupported for MOBI format honestly', async () => {
    const buffer = Buffer.from('FAKE MOBI DATA');
    const result = await extractPreviewInWorker({
      format: 'mobi',
      buffer,
    });

    expect(result.unsupported).toBe(true);
    expect(result.snippet).toBeNull();
  });

  it('rejects archives exceeding the compressed byte cap (>50MB)', async () => {
    const oversizedBuffer = Buffer.alloc(MAX_ARCHIVE_BYTES + 1024);

    await expect(
      extractPreviewInWorker({
        format: 'docx',
        buffer: oversizedBuffer,
      })
    ).rejects.toThrow('Archive exceeds preview extraction byte limit.');
  });

  it('safely caps decompressed bytes on zip-bomb proxy archives without crashing', async () => {
    // Generate a zip with an entry claiming huge uncompressed size or multiple large entries
    const largeText = 'A'.repeat(5 * 1024 * 1024); // 5MB uncompressed
    const zipBytes = zipSync({
      'word/document.xml': Buffer.from(largeText, 'utf-8'),
    });

    // Should not crash the process; filter ignores oversized entry >2MB
    const result = await extractPreviewInWorker({
      format: 'docx',
      buffer: Buffer.from(zipBytes),
    });

    expect(result.snippet).toBeNull();
  });

  it('handles malformed archives gracefully without crashing worker or leaking paths', async () => {
    const corruptBuffer = Buffer.from('PK\x03\x04CORRUPT_HEADER_BYTES_12345');

    const result = await extractPreviewInWorker({
      format: 'docx',
      buffer: corruptBuffer,
    });

    expect(result.snippet).toBeNull();
  });

  it('terminates workers that exceed the timeout limit', async () => {
    // A corrupted buffer that stalls or with short timeout
    const buffer = Buffer.from('%PDF-1.4\n' + '0'.repeat(1000));

    await expect(
      extractPreviewInWorker(
        {
          format: 'pdf',
          buffer,
        },
        { timeoutMs: 1 } // Immediate 1ms timeout
      )
    ).rejects.toThrow(/timed out/i);
  });
});
