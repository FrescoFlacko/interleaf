import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import type { PdfAnnotationAnchor } from '@shared/types/annotation';

function locationAnchor(pageIndex = 0): PdfAnnotationAnchor {
  return {
    format: 'pdf',
    pageIndex,
    quote: { exact: '', prefix: '', suffix: '' },
  };
}

function rangeAnchor(text = 'selected text', pageIndex = 0): PdfAnnotationAnchor {
  return {
    format: 'pdf',
    pageIndex,
    quote: { exact: text, prefix: 'before ', suffix: ' after' },
    textStart: 7,
    textEnd: 7 + text.length,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
  };
}

describe('AnnotationRepository', () => {
  let db: InterleafDatabase;
  let documents: DocumentRepository;
  let annotations: AnnotationRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    documents = new DocumentRepository(db);
    annotations = new AnnotationRepository(db);
    documents.insert({
      id: 'doc-pdf',
      title: 'PDF',
      author: null,
      format: 'pdf',
      filePath: '/books/book.pdf',
      storageMode: 'link',
      fileSize: 100,
      fileMtimeMs: 1,
      fileHash: 'hash-v1',
      pageCount: 10,
    });
    documents.insert({
      id: 'doc-epub',
      title: 'EPUB',
      author: null,
      format: 'epub',
      filePath: '/books/book.epub',
      storageMode: 'link',
      fileSize: 200,
      fileMtimeMs: 1,
      fileHash: 'epub-hash',
      pageCount: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('persists normalized highlights with their document revision', () => {
    const created = annotations.create({
      documentId: 'doc-pdf',
      type: 'highlight',
      anchor: rangeAnchor(),
      selectedText: 'selected text',
      note: 'Remember this',
      color: 'yellow',
    });

    expect(created).toMatchObject({
      documentId: 'doc-pdf',
      documentHash: 'hash-v1',
      type: 'highlight',
      selectedText: 'selected text',
      note: 'Remember this',
      color: 'yellow',
      status: 'anchored',
    });
    expect(new AnnotationRepository(db).list('doc-pdf').find((entry) => entry.id === created.id)).toEqual(created);
  });

  it('rejects malformed kinds and anchors for a different document format', () => {
    expect(() =>
      annotations.create({
        documentId: 'doc-pdf',
        type: 'bookmark',
        anchor: rangeAnchor(),
      })
    ).toThrow(/Bookmarks can only carry/i);

    expect(() =>
      annotations.create({
        documentId: 'doc-epub',
        type: 'bookmark',
        anchor: locationAnchor(),
        label: 'Wrong format',
      })
    ).toThrow(/format does not match/i);
  });

  it('binds reads, edits, and deletes to the owning document', () => {
    const bookmark = annotations.create({
      documentId: 'doc-pdf',
      type: 'bookmark',
      anchor: locationAnchor(2),
      label: 'Chapter marker',
    });

    expect(annotations.list('doc-epub').find((entry) => entry.id === bookmark.id)).toBeUndefined();
    expect(annotations.update({ documentId: 'doc-epub', id: bookmark.id, label: 'Hijack' })).toBeNull();
    expect(annotations.delete('doc-epub', bookmark.id)).toBeNull();
    expect(annotations.list('doc-pdf').find((entry) => entry.id === bookmark.id)?.label).toBe('Chapter marker');
  });

  it('permits only fields valid for the persisted annotation kind', () => {
    const highlight = annotations.create({
      documentId: 'doc-pdf',
      type: 'highlight',
      anchor: rangeAnchor('quote'),
      selectedText: 'quote',
      color: 'yellow',
    });
    expect(
      annotations.update({
        documentId: 'doc-pdf',
        id: highlight.id,
        color: 'purple',
        note: 'A highlight note',
      })
    ).toMatchObject({ color: 'purple', note: 'A highlight note' });
    expect(() =>
      annotations.update({ documentId: 'doc-pdf', id: highlight.id, color: null })
    ).toThrow(/non-null color/i);

    const note = annotations.create({
      documentId: 'doc-pdf',
      type: 'note',
      anchor: locationAnchor(3),
      note: 'Location note',
      isLocationNote: true,
    });
    expect(() =>
      annotations.update({ documentId: 'doc-pdf', id: note.id, label: 'Not allowed' })
    ).toThrow(/note-text update/i);
  });

  it('searches note, quote, and label text with SQL wildcard characters treated literally', () => {
    annotations.create({
      documentId: 'doc-pdf',
      type: 'note',
      anchor: locationAnchor(1),
      note: 'A literal 100% marker',
      isLocationNote: true,
    });
    annotations.create({
      documentId: 'doc-pdf',
      type: 'bookmark',
      anchor: locationAnchor(2),
      label: 'Plain marker',
    });

    expect(annotations.list('doc-pdf', { searchQuery: '%' })).toHaveLength(1);
    expect(annotations.list('doc-pdf', { type: 'bookmark' })).toHaveLength(1);
    expect(annotations.list('doc-epub')).toHaveLength(0);
  });

  it('returns authoritative, scoped pages beyond 10,000 records', () => {
    const statement = db.raw.prepare(`
      INSERT INTO annotations (
        id, document_id, document_hash, type, anchor_json, selected_text,
        note, label, color, is_location_note, status, created_at, updated_at
      ) VALUES (?, 'doc-pdf', 'hash-v1', 'bookmark', ?, NULL, NULL, ?, NULL, 0,
                'anchored', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
    `);
    db.raw.exec('BEGIN');
    for (let index = 0; index < 10_001; index++) {
      statement.run(
        `bulk-${String(index).padStart(5, '0')}`,
        JSON.stringify(locationAnchor(index)),
        `Bookmark ${String(index)}`
      );
    }
    db.raw.exec('COMMIT');

    const lastPage = annotations.page('doc-pdf', {
      sort: 'created_asc',
      offset: 10_000,
      limit: 50,
    });
    expect(lastPage.total).toBe(10_001);
    expect(lastPage.items).toHaveLength(1);

    const scoped = annotations.page('doc-pdf', {
      scope: { format: 'pdf', pageStart: 9_999, pageEnd: 10_000 },
      limit: 100,
    });
    expect(scoped.total).toBe(2);
    expect(scoped.items.map((item) => item.anchor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageIndex: 9_999 }),
      expect.objectContaining({ pageIndex: 10_000 }),
    ]));
  });

  it('rejects stale repair writes and atomically records the current revision', () => {
    const highlight = annotations.create({
      documentId: 'doc-pdf',
      type: 'highlight',
      anchor: rangeAnchor('old quote'),
      selectedText: 'old quote',
      color: 'blue',
    });
    db.raw.prepare("UPDATE documents SET file_hash = 'hash-v2' WHERE id = 'doc-pdf'").run();

    expect(() =>
      annotations.repairAnchor({
        documentId: 'doc-pdf',
        id: highlight.id,
        documentHash: 'hash-v1',
        anchor: rangeAnchor('old quote', 4),
        status: 'anchored',
      })
    ).toThrow(/document changed/i);
    expect(annotations.list('doc-pdf').find((entry) => entry.id === highlight.id)?.documentHash).toBe('hash-v1');

    const repaired = annotations.repairAnchor({
      documentId: 'doc-pdf',
      id: highlight.id,
      documentHash: 'hash-v2',
      anchor: rangeAnchor('old quote', 4),
      status: 'anchored',
    });
    expect(repaired).toMatchObject({ documentHash: 'hash-v2', status: 'anchored' });
    expect(repaired?.anchor).toMatchObject({ pageIndex: 4 });
  });

  it('does not let repair requests change annotation kind semantics', () => {
    const bookmark = annotations.create({
      documentId: 'doc-pdf',
      type: 'bookmark',
      anchor: locationAnchor(),
    });
    expect(() =>
      annotations.repairAnchor({
        documentId: 'doc-pdf',
        id: bookmark.id,
        documentHash: 'hash-v1',
        anchor: rangeAnchor('smuggled range'),
        status: 'anchored',
      })
    ).toThrow(/location-only anchor/i);

    const highlight = annotations.create({
      documentId: 'doc-pdf',
      type: 'highlight',
      anchor: rangeAnchor('original'),
      selectedText: 'original',
      color: 'pink',
    });
    expect(() =>
      annotations.repairAnchor({
        documentId: 'doc-pdf',
        id: highlight.id,
        documentHash: 'hash-v1',
        anchor: rangeAnchor('replacement'),
        status: 'anchored',
      })
    ).toThrow(/preserve its selected quote/i);
  });

  it('fails closed when a stored anchor is corrupt and cascades with its document', () => {
    const bookmark = annotations.create({
      documentId: 'doc-pdf',
      type: 'bookmark',
      anchor: locationAnchor(),
    });
    db.raw.prepare("UPDATE annotations SET anchor_json = '{bad' WHERE id = ?").run(bookmark.id);
    expect(() => annotations.list('doc-pdf').find((entry) => entry.id === bookmark.id)).toThrow(/not valid JSON/i);

    documents.delete('doc-pdf');
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM annotations').get()).toMatchObject({ count: 0 });
  });

  it('persists and retrieves multi-segment composite anchors matching any segment scope', () => {
    const multiSegmentAnchor: PdfAnnotationAnchor = {
      format: 'pdf',
      pageIndex: 0,
      pageLabel: '1–2',
      quote: { exact: 'Part one\nPart two', prefix: 'start ', suffix: ' end' },
      segments: [
        {
          pageIndex: 0,
          pageLabel: '1',
          quote: { exact: 'Part one', prefix: 'start ', suffix: '' },
          textStart: 10,
          textEnd: 18,
          rects: [{ x: 0.1, y: 0.8, width: 0.5, height: 0.05 }],
        },
        {
          pageIndex: 1,
          pageLabel: '2',
          quote: { exact: 'Part two', prefix: '', suffix: ' end' },
          separatorBefore: '\n',
          textStart: 0,
          textEnd: 8,
          rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
        },
      ],
    };

    const created = annotations.create({
      documentId: 'doc-pdf',
      type: 'highlight',
      anchor: multiSegmentAnchor,
      selectedText: 'Part one\nPart two',
      color: 'blue',
    });

    expect(created.anchor).toMatchObject({
      format: 'pdf',
      pageIndex: 0,
      segments: expect.arrayContaining([
        expect.objectContaining({ pageIndex: 0, quote: expect.objectContaining({ exact: 'Part one' }) }),
        expect.objectContaining({ pageIndex: 1, quote: expect.objectContaining({ exact: 'Part two' }) }),
      ]),
    });

    // Scope query for page 0 only: should match
    const page0Results = annotations.list('doc-pdf', {
      scope: { format: 'pdf', pageStart: 0, pageEnd: 0 },
    });
    expect(page0Results.some((item) => item.id === created.id)).toBe(true);

    // Scope query for page 1 only: should match via segments
    const page1Results = annotations.list('doc-pdf', {
      scope: { format: 'pdf', pageStart: 1, pageEnd: 1 },
    });
    expect(page1Results.some((item) => item.id === created.id)).toBe(true);

    // Scope query for page 2 only: should NOT match
    const page2Results = annotations.list('doc-pdf', {
      scope: { format: 'pdf', pageStart: 2, pageEnd: 2 },
    });
    expect(page2Results.some((item) => item.id === created.id)).toBe(false);
  });
});
