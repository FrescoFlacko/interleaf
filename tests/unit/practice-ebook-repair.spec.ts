import { describe, expect, it } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { AnnotationRepository } from '@main/db/repositories/annotation-repository';
import { PracticeRepository } from '@main/practice/repository';
import type { DocumentAnchor } from '@shared/types/annotation';

for (const format of ['epub', 'mobi'] as const) describe(`${format} practice source repair`, () => {
  it('accepts only a valid progression change and refuses real source changes', () => {
    const db = InterleafDatabase.open(':memory:');
    try {
      runMigrations(db);
      db.raw.prepare(`INSERT INTO documents (id,title,format,file_path,storage_mode,file_size,file_mtime_ms,file_hash)
        VALUES ('doc','Book',?,'/fixture','managed',1,1,'hash')`).run(format);
      const common = { quote: { exact: 'Evidence', prefix: '', suffix: '' }, progression: 0.5, textStart: 10, textEnd: 18 };
      const anchor: DocumentAnchor = format === 'epub'
        ? { ...common, format: 'epub', cfi: 'epubcfi(/6/2!/4/2)', spineHref: 'chapter.xhtml' }
        : { ...common, format: 'mobi', sectionIndex: 1 };
      const annotations = new AnnotationRepository(db);
      const highlight = annotations.create({ documentId: 'doc', type: 'highlight', selectedText: 'Evidence', color: 'yellow', anchor });
      const repo = new PracticeRepository(db);
      const card = repo.createFromHighlight({ documentId: 'doc', annotationId: highlight.id, question: 'Where?' });
      const repair = (next: DocumentAnchor, status: 'anchored' | 'unanchored' = 'anchored') => annotations.repairAnchor({
        documentId: 'doc', id: highlight.id, documentHash: 'hash', anchor: next, status,
      });
      repair({ ...anchor, progression: 1 });
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'available', evidence: 'Evidence', source: card.source, navigation: card.navigation });
      repair({ ...anchor, progression: 1, textStart: 11, textEnd: 19 });
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      repair(format === 'epub' && anchor.format === 'epub' ? { ...anchor, cfi: 'epubcfi(/6/4!/4/2)' }
        : anchor.format === 'mobi' ? { ...anchor, sectionIndex: 2 } : anchor);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET anchor_json = ? WHERE id = ?').run(
        JSON.stringify({ ...anchor, quote: { ...anchor.quote, exact: 'Different' } }), highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET anchor_json = ? WHERE id = ?').run(JSON.stringify(anchor), highlight.id);
      repair(anchor, 'unanchored');
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'unanchored', navigation: null });
      repair(anchor);
      db.raw.prepare('UPDATE annotations SET selected_text = ? WHERE id = ?').run('Different', highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET selected_text = ?, anchor_json = ? WHERE id = ?').run('Evidence', '{', highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET anchor_json = ? WHERE id = ?').run(JSON.stringify({ ...anchor, progression: 2 }), highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET anchor_json = ?, document_hash = ? WHERE id = ?').run(JSON.stringify(anchor), 'different-hash', highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE annotations SET document_hash = ? WHERE id = ?').run('hash', highlight.id);
      db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('different-hash', 'doc');
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'changed', navigation: null });
      db.raw.prepare('UPDATE documents SET file_hash = ? WHERE id = ?').run('hash', 'doc');
      annotations.delete('doc', highlight.id);
      expect(repo.get(card.id)).toMatchObject({ sourceState: 'missing', navigation: null });
    } finally { db.close(); }
  });
});
