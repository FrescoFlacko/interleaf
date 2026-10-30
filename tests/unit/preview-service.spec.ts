import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { DocumentRepository, type DocumentInsertInput } from '../../src/main/db/repositories/document-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { PreviewService } from '../../src/main/library/preview-service';
import { StorageManager } from '../../src/main/library/storage-manager';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import * as hashFileWorker from '../../src/main/workers/hash-file-worker';
import { createLogger, type Logger } from '../../src/main/logging/logger';
import type { PortableRecord } from '@shared/models/portable';
import {
  makeEpubFixture,
  makeDocxFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';

describe('PreviewService', () => {
  let tmpDir: string;
  let db: InterleafDatabase;
  let docRepo: DocumentRepository;
  let posRepo: ReadingPositionRepository;
  let service: PreviewService;
  let loggedEvents: { message: string; meta?: PortableRecord }[];
  let log: Logger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'preview-service-test-'));
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    docRepo = new DocumentRepository(db);
    posRepo = new ReadingPositionRepository(db);
    loggedEvents = [];

    const baseLog = createLogger('library');
    log = {
      ...baseLog,
      info: (message: string, meta?: PortableRecord) => {
        loggedEvents.push(meta !== undefined ? { message, meta } : { message });
        baseLog.info(message, meta);
      },
      warn: (message: string, meta?: PortableRecord) => {
        loggedEvents.push(meta !== undefined ? { message, meta } : { message });
        baseLog.warn(message, meta);
      },
      error: (message: string, meta?: PortableRecord) => {
        loggedEvents.push(meta !== undefined ? { message, meta } : { message });
        baseLog.error(message, meta);
      },
    };

    const libraryRoot = join(tmpDir, 'default-library');
    service = new PreviewService({
      db,
      documents: docRepo,
      readingPositions: posRepo,
      log,
      storage: new StorageManager(libraryRoot, log),
      assetRegistry: new AssetRegistry([libraryRoot]),
      currentScopeId: () => 'default',
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const insertDoc = (
    input: Pick<DocumentInsertInput, 'id' | 'title' | 'format' | 'filePath'> & Partial<DocumentInsertInput>
  ) =>
    docRepo.insert({
      author: null,
      storageMode: 'managed',
      fileSize: 100,
      fileMtimeMs: Date.now(),
      fileHash: `${input.id}-hash`,
      pageCount: null,
      coverPath: null,
      folderId: null,
      ...input,
    });

  const createCoverService = async (dirName: string, scopeId: string) => {
    const libraryDir = join(tmpDir, dirName);
    const storage = new StorageManager(libraryDir, log);
    await storage.initialize();
    const registry = new AssetRegistry([libraryDir]);
    const coverService = new PreviewService({
      db,
      documents: docRepo,
      readingPositions: posRepo,
      log,
      storage,
      assetRegistry: registry,
      currentScopeId: () => scopeId,
    });
    return { libraryDir, storage, registry, coverService };
  };

  /** Inserts a one-page PDF whose recorded size, mtime and hash match the bytes on disk. */
  const insertVerifiedPdf = async (
    storage: StorageManager,
    id: string,
    filePath: string,
    storageMode: DocumentInsertInput['storageMode'] = 'managed'
  ) => {
    const fileStats = await stat(filePath);
    const fileHash = await storage.computeFileHash(filePath);
    const record = insertDoc({
      id,
      title: id,
      format: 'pdf',
      storageMode,
      filePath,
      fileSize: fileStats.size,
      fileMtimeMs: Math.round(fileStats.mtimeMs),
      fileHash,
      pageCount: 1,
    });
    return { record, fileHash };
  };

  it('extracts Markdown preview snippet and strips frontmatter', async () => {
    const mdPath = join(tmpDir, 'test.md');
    const mdContent = `---
title: Sample Post
author: Tester
---

# Introduction to Algorithms

Algorithms are step-by-step procedures for calculations and data processing.
`;
    await writeFile(mdPath, mdContent, 'utf-8');
    const record = insertDoc({ id: 'doc-md-1', title: 'Sample Markdown', format: 'markdown', filePath: mdPath });

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.format).toBe('markdown');
    expect(preview.locationLabel).toBe('Page 1');
    expect(preview.isLastRead).toBe(false);
    expect(preview.fallback).toBe(false);
    expect(preview.snippet).toContain('Introduction to Algorithms');
    expect(preview.snippet).not.toContain('title: Sample Post');
  });

  it('extracts PDF page 1 snippet from content streams using worker pdfjs', async () => {
    const pdfPath = join(tmpDir, 'test.pdf');
    await writeFile(pdfPath, makePdfFixture({
      title: 'Distributed Systems Guide',
      author: 'Architect',
      pageLines: [
        ['Distributed systems require robust fault tolerance and consensus protocols.'],
        ['Chapter 2: Data Models and Query Languages.'],
      ],
    }));
    const record = insertDoc({ id: 'doc-pdf-1', title: 'Distributed Systems Guide', format: 'pdf', filePath: pdfPath, pageCount: 2 });

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.format).toBe('pdf');
    expect(preview.locationLabel).toBe('Page 1');
    expect(preview.isLastRead).toBe(false);
    expect(preview.snippet).toContain('Distributed systems require robust fault tolerance');
  });

  it('persists and registers an actual PDF page-one cover snapshot idempotently', async () => {
    const { libraryDir, storage, registry, coverService } = await createCoverService('library', 'preview-scope');
    const pdfPath = join(libraryDir, 'cover.pdf');
    await writeFile(pdfPath, makePdfFixture({
      title: 'Persisted Cover',
      author: 'Tester',
      pageLines: [['A real first page cover is rendered in a bounded worker.']],
    }));
    const { record } = await insertVerifiedPdf(storage, 'doc-pdf-cover', pdfPath);

    const first = await coverService.getDocumentPreview(record.id);
    expect(first.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    const persisted = docRepo.findById(record.id);
    expect(persisted?.coverPath).toBeTruthy();
    expect(existsSync(persisted!.coverPath!)).toBe(true);
    expect(registry.resolveAsset(first.coverAssetUrl!.slice('interleaf-media://'.length), 'preview-scope')).not.toBeNull();

    const second = await coverService.getDocumentPreview(record.id);
    expect(second.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    expect(docRepo.findById(record.id)?.coverPath).toBe(persisted?.coverPath);
  });

  it('invalidates a persisted cover when the source bytes change or disappear', async () => {
    const { libraryDir, storage, coverService } = await createCoverService('library-health', 'preview-health-scope');
    const pdfPath = join(libraryDir, 'changing-cover.pdf');
    const original = makePdfFixture({ title: 'Changing Cover', pageLines: [['Original page one.']] });
    await writeFile(pdfPath, original);
    const { record, fileHash } = await insertVerifiedPdf(storage, 'doc-pdf-changing-cover', pdfPath);

    const first = await coverService.getDocumentPreview(record.id);
    const persisted = docRepo.findById(record.id);
    expect(first.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    expect(persisted?.coverPath).toBeTruthy();
    expect(existsSync(persisted!.coverPath!)).toBe(true);

    await writeFile(pdfPath, Buffer.concat([original, Buffer.from('\nchanged')]));
    const changed = await coverService.getDocumentPreview(record.id);
    expect(changed.coverAssetUrl).toBeNull();
    expect(docRepo.findById(record.id)?.coverPath).toBeNull();
    expect(existsSync(persisted!.coverPath!)).toBe(false);

    await writeFile(pdfPath, original);
    const restoredStats = await stat(pdfPath);
    db.raw.prepare('UPDATE documents SET file_size = ?, file_mtime_ms = ?, file_hash = ? WHERE id = ?')
      .run(restoredStats.size, Math.round(restoredStats.mtimeMs), fileHash, record.id);
    await unlink(pdfPath);
    const missing = await coverService.getDocumentPreview(record.id);
    expect(missing.coverAssetUrl).toBeNull();
    expect(docRepo.findById(record.id)?.coverPath).toBeNull();
  });

  it('hashes a large linked PDF once, then uses an identity lease for cover rendering', async () => {
    const { storage, coverService } = await createCoverService('library-linked-large', 'preview-large-linked-scope');
    const pdfPath = join(tmpDir, 'large-linked.pdf');
    const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const objects = [
      Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n'),
      Buffer.from('4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'),
      Buffer.concat([
        Buffer.from('5 0 obj\n<< /Length 53477376 >>\nstream\n'),
        Buffer.alloc(51 * 1024 * 1024, 0x78),
        Buffer.from('\nendstream\nendobj\n'),
      ]),
    ];
    const offsets: number[] = [0];
    let cursor = header.length;
    for (const object of objects) {
      offsets.push(cursor);
      cursor += object.length;
    }
    const xrefOffset = cursor;
    const xref = Buffer.from(
      `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`,
    );
    const trailer = Buffer.from(`trailer\n<< /Root 1 0 R /Size ${String(objects.length + 1)} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`);
    await writeFile(pdfPath, Buffer.concat([header, ...objects, xref, trailer]));
    const { record } = await insertVerifiedPdf(storage, 'doc-pdf-large-linked', pdfPath, 'link');

    const healthSpy = vi.spyOn(storage, 'checkStorageHealth');
    const hashWorkerSpy = vi.spyOn(hashFileWorker, 'hashFileInWorker');
    const preview = await coverService.getDocumentPreview(record.id);

    expect(preview.coverAssetUrl).toMatch(/^interleaf-media:\/\//);
    expect(healthSpy).toHaveBeenCalledTimes(1);
    expect(hashWorkerSpy).toHaveBeenCalledTimes(1);
    expect(hashWorkerSpy.mock.calls[0]?.[1].fileSize).toBeGreaterThan(50 * 1024 * 1024);
    expect(docRepo.findById(record.id)?.coverPath).toBeTruthy();
  }, 20_000);

  it('extracts PDF last-read page snippet when reading position exists', async () => {
    const pdfPath = join(tmpDir, 'test-pos.pdf');
    await writeFile(pdfPath, makePdfFixture({
      title: 'Distributed Systems Guide',
      author: 'Architect',
      pageLines: [
        ['Page 1 introductory text on distributed computing fundamentals.'],
        ['Page 2 in-depth discussion on Byzantine fault tolerance and Paxos.'],
      ],
    }));
    const record = insertDoc({ id: 'doc-pdf-pos', title: 'Distributed Systems Guide', format: 'pdf', filePath: pdfPath, pageCount: 2 });
    posRepo.upsert(record.id, JSON.stringify({ format: 'pdf', pageIndex: 1 }), 0.5);

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.format).toBe('pdf');
    expect(preview.locationLabel).toBe('Page 2');
    expect(preview.isLastRead).toBe(true);
    expect(preview.snippet).toContain('Byzantine fault tolerance and Paxos');
  });

  it('extracts DOCX paragraph snippet', async () => {
    const docxPath = join(tmpDir, 'test.docx');
    await writeFile(docxPath, makeDocxFixture({
      title: 'Engineering Specifications',
      author: 'Lead Engineer',
      bodyText: 'System architecture overview for the desktop platform.',
    }));
    const record = insertDoc({ id: 'doc-docx-1', title: 'Engineering Specifications', format: 'docx', filePath: docxPath });

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.format).toBe('docx');
    expect(preview.locationLabel).toBe('Page 1');
    expect(preview.snippet).toContain('DOCX Foundations');
  });

  it('extracts EPUB chapter snippet and sets location label to Cover initially', async () => {
    const epubPath = join(tmpDir, 'test.epub');
    await writeFile(epubPath, makeEpubFixture({
      title: 'Refactoring Patterns',
      author: 'Martin Fowler',
      chapters: [
        {
          title: 'Chapter 1',
          content: '<p>Refactoring is a disciplined technique for restructuring code.</p>',
        },
      ],
    }));
    const record = insertDoc({ id: 'doc-epub-1', title: 'Refactoring Patterns', format: 'epub', filePath: epubPath });

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.format).toBe('epub');
    expect(preview.locationLabel).toBe('Cover');
    expect(preview.snippet).toContain('Refactoring is a disciplined technique');
  });

  it('stress test: queries deterministically across 2,000 chunks with LIMIT 1 without materializing all rows', async () => {
    const mdPath = join(tmpDir, 'test-2000-chunks.md');
    await writeFile(mdPath, '# Big Book\nLots of text...', 'utf-8');
    const record = insertDoc({ id: 'doc-huge-index', title: 'Massive Handbook', format: 'markdown', filePath: mdPath });

    db.raw.exec('BEGIN TRANSACTION');
    const insertStmt = db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading)
      VALUES (?, ?, ?, ?, 10, ?, ?)
    `);
    for (let i = 0; i < 2000; i++) {
      insertStmt.run(
        `chunk-${String(i)}`,
        record.id,
        i,
        `Chunk content at ordinal ${String(i)} with deep research notes.`,
        JSON.stringify({ format: 'markdown', blockIndex: i }),
        `Section ${String(i + 1)}`
      );
    }
    db.raw.exec('COMMIT');
    posRepo.upsert(record.id, JSON.stringify({ format: 'markdown', blockIndex: 1850 }), 0.92);

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.isLastRead).toBe(true);
    expect(preview.locationLabel).toBe('Section 1851');
    expect(preview.snippet).toBe('Chunk content at ordinal 1850 with deep research notes.');
  });

  it.each([
    ['pdf', { format: 'pdf', pageIndex: 3 }, { format: 'pdf', pageIndex: 3 }, 'iv'],
    ['pdf', { format: 'pdf', pageIndex: 3, pageLabel: 'Front' }, { format: 'pdf', pageIndex: 3 }, 'Front'],
    ['markdown', { format: 'markdown', blockIndex: 2, headingId: 'intro' }, { format: 'markdown', blockIndex: 9, headingId: 'intro' }, '# intro'],
    ['markdown', { format: 'markdown', blockIndex: 2 }, { format: 'markdown', blockIndex: 2 }, 'Section 3'],
    ['docx', { format: 'docx', paragraphIndex: 4 }, { format: 'docx', paragraphIndex: 4 }, 'Para 5'],
    ['pptx', { format: 'pptx', paragraphIndex: 1, renderedPageIndex: 2 }, { format: 'pptx', paragraphIndex: 1 }, 'Slide 3'],
    ['epub', { format: 'epub', cfi: 'epubcfi(/6/4)', spineHref: 'ch2.xhtml' }, { format: 'epub', cfi: 'epubcfi(/6/4)', spineHref: 'ch2.xhtml' }, 'Section ch2.xhtml'],
  ] as const)('reads a %s preview from the indexed chunk at the requested location', async (format, requested, indexed, label) => {
    const record = insertDoc({ id: `doc-indexed-${format}-${label}`, title: 'Indexed', format, filePath: join(tmpDir, 'missing.bin') });
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json, heading, page_label)
      VALUES ('other', ?, 0, 'Somewhere else entirely.', 3, ?, NULL, NULL), ('match', ?, 1, 'The indexed passage.', 3, ?, NULL, 'iv')
    `).run(record.id, JSON.stringify({ format: 'pdf', pageIndex: 999 }), record.id, JSON.stringify(indexed));

    const preview = await service.getDocumentPreview(record.id, requested);
    expect(preview).toMatchObject({ locationLabel: label, snippet: 'The indexed passage.', fallback: false });
  });

  it('reads the first indexed chunk with the format default label when no location is known', async () => {
    const record = insertDoc({ id: 'doc-indexed-first', title: 'Deck', format: 'pptx', filePath: join(tmpDir, 'missing.pptx') });
    db.raw.prepare(`
      INSERT INTO document_text_chunks (id, document_id, ordinal, text, token_count, location_json)
      VALUES ('second', ?, 1, 'Second slide.', 2, '{"format":"pptx","paragraphIndex":1}'),
             ('first', ?, 0, 'Title slide.', 2, '{"format":"pptx","paragraphIndex":0}')
    `).run(record.id, record.id);

    const preview = await service.getDocumentPreview(record.id);
    expect(preview).toMatchObject({ locationLabel: 'Slide 1', snippet: 'Title slide.', isLastRead: false, fallback: false });
  });

  it('provides honest fallback and redaction when file is missing on disk', async () => {
    const record = insertDoc({
      id: 'doc-missing',
      title: 'Missing Whitepaper',
      author: 'Researcher',
      format: 'pdf',
      storageMode: 'link',
      filePath: join(tmpDir, 'missing-secret-path-untracked.pdf'),
      pageCount: 10,
    });

    const preview = await service.getDocumentPreview(record.id);
    expect(preview.documentId).toBe(record.id);
    expect(preview.fallback).toBe(true);
    expect(preview.locationLabel).toBe('Page 1');
    expect(preview.isLastRead).toBe(false);
    expect(preview.snippet).toBe('Missing Whitepaper — Researcher (Page 1)');

    // Ensure logger was called with redacted code and NOT leaking local filesystem path
    const fallbackLog = loggedEvents.find((e) => e.message.includes('fallback summary'));
    expect(fallbackLog).toBeDefined();
    expect(JSON.stringify(fallbackLog)).not.toContain('missing-secret-path-untracked.pdf');
    expect(fallbackLog?.meta?.errorCode).toBeDefined();
  });

  it('LibraryService metadata mapping strictly sanitizes coverAssetUrl across raw paths, data:, file:, and http:', async () => {
    const rawCoverPaths = [
      '/Users/alice/workspace/cover.png',
      'file:///Users/alice/cover.png',
      'http://cdn.example.com/cover.png',
      'https://cdn.example.com/cover.png',
      'data:image/png;base64,iVBORw0KGgo=',
      // A persisted URL is not proof of an active AssetRegistry capability.
      'interleaf-media://covers/doc-1.png',
      null,
    ];

    for (const [i, coverPath] of rawCoverPaths.entries()) {
      const doc = insertDoc({
        id: `doc-meta-test-${String(i)}`,
        title: `Doc ${String(i)}`,
        format: 'pdf',
        filePath: join(tmpDir, `test-${String(i)}.pdf`),
        pageCount: 1,
        coverPath,
      });

      const preview = await service.getDocumentPreview(doc.id);
      expect(preview.coverAssetUrl).toBeNull();
    }
  });
});
