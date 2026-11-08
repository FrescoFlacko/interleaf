import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { DocumentRepository } from '@main/db/repositories/document-repository';
import { ExternalHighlightRepository } from '@main/db/repositories/external-highlight-repository';
import { HighlightImportService } from '@main/highlight-import/import-service';

describe('native highlight import boundary', () => {
  let db: InterleafDatabase;
  let directory: string;
  beforeEach(async () => { db = InterleafDatabase.open(':memory:'); runMigrations(db); directory = await mkdtemp(join(tmpdir(), 'highlight-import-')); });
  afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  it('previews and commits a chosen file once; unmatched source survives', async () => {
    const file = join(directory, 'My Clippings.txt');
    await writeFile(file, 'Book (Author)\n- Your Highlight on page 2 | Added today\n\nA quote\n==========\nBook (Author)\n- Your Highlight on page 2 | Added today\n\nA quote\n==========');
    const repository = new ExternalHighlightRepository(db);
    const service = new HighlightImportService(repository, () => Promise.resolve({ canceled: false, filePaths: [file] }));
    const preview = await service.preview(1, null);
    expect(preview).toMatchObject({ count: 2, duplicates: 1, provider: 'kindle' });
    expect(repository.list(0)).toEqual([]);
    expect(() => service.commit(2, { token: preview!.token, choices: [] })).toThrow();
    const next = await service.preview(1, null);
    expect(service.commit(1, { token: next!.token, choices: [] })).toEqual({ inserted: 1, duplicates: 1 });
    const saved = repository.list(0)[0];
    expect(saved).toMatchObject({ quote: 'A quote', documentId: null, verifiedAnchor: null, verifiedDocumentHash: null });
    expect(repository.resolveSource(saved!.id)).toEqual(saved);
    const repeat = await service.preview(1, null);
    expect(repeat?.duplicates).toBe(2);
    expect(service.commit(1, { token: repeat!.token, choices: [] })).toEqual({ inserted: 0, duplicates: 2 });
  });
  it('requires a real document for association and retains the source when it is deleted', () => {
    const repository = new ExternalHighlightRepository(db);
    const source = { provider: 'readwise' as const, title: 'Book', author: null, quote: 'A quote', note: 'A note', location: 'Page 7', date: null };
    expect(repository.commit([source], new Map())).toEqual({ inserted: 1, duplicates: 0 });
    const record = repository.list(0)[0]!;
    expect(() => repository.associate(record.id, 'missing')).toThrow(/no longer available/);
    const documents = new DocumentRepository(db);
    documents.insert({ id: 'document', title: 'Book', author: null, format: 'pdf', filePath: '/fixture.pdf',
      storageMode: 'link', fileSize: 10, fileMtimeMs: 1, fileHash: 'fixture-hash', pageCount: 1 });
    expect(repository.associate(record.id, 'document')).toMatchObject({ documentId: 'document', verifiedAnchor: null, verifiedDocumentHash: null, location: 'Page 7' });
    db.raw.prepare('DELETE FROM documents WHERE id = ?').run('document');
    expect(repository.resolveSource(record.id)).toMatchObject({ documentId: null, quote: 'A quote', note: 'A note' });
  });
  it('handles cancel and refuses reader metadata CSV', async () => {
    const repository = new ExternalHighlightRepository(db);
    const cancelled = new HighlightImportService(repository, () => Promise.resolve({ canceled: true, filePaths: [] }));
    expect(await cancelled.preview(1, null)).toBeNull();
    const file = join(directory, 'reader.csv');
    await writeFile(file, 'Title,Author,URL\nBook,Writer,https://example.com');
    const service = new HighlightImportService(repository, () => Promise.resolve({ canceled: false, filePaths: [file] }));
    await expect(service.preview(1, null)).rejects.toThrow(/Reader library metadata/);
    expect(repository.list(0)).toEqual([]);
  });
});

describe('highlight import lifecycle', () => {
  it('counts the native dialog, refuses new work at shutdown and waits for the dialog', async () => {
    const db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    let finish: (value: { canceled: boolean; filePaths: string[] }) => void = () => undefined;
    const selected = new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => { finish = resolve; });
    const service = new HighlightImportService(new ExternalHighlightRepository(db), () => selected);
    const preview = service.preview(1, null);
    expect(service.admission.liveWork()).toBe(1);
    let closed = false;
    const shutdown = service.shutdown().then(() => { closed = true; });
    expect(closed).toBe(false);
    await expect(service.preview(1, null)).rejects.toThrow(/shutting down/);
    expect(() => service.list(0)).toThrow(/shutting down/);
    finish({ canceled: true, filePaths: [] });
    expect(await preview).toBeNull();
    await shutdown;
    expect(closed).toBe(true);
    expect(service.admission.liveWork()).toBe(0);
    db.close();
  });
});
