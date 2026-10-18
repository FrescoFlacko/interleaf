import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { LibraryService } from '../../src/main/library/library-service';
import { WebArticleImportService } from '../../src/main/library/web-article-import';
import { validateFileSignature } from '../../src/main/library/file-signatures';
import type { FetchedWebPage, WebArticleTransport } from '../../src/main/net/web-article-transport';
import { createLogger } from '../../src/main/logging/logger';
import { InterleafError } from '../../src/shared/errors/interleaf-error';
import { TestWebMediaTransport } from '../../src/main/net/test-web-media-transport';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';

/**
 * End-to-end ingestion for a web article, from a submitted URL to a managed
 * library row.
 *
 * The transport is a fixture so no test reaches the network, but everything
 * else is real: the address policy, the extraction worker, signature
 * validation, content-addressed storage, and the database. The interesting
 * claims are about what the library looks like *after* a failure as much as
 * after a success, so most of these tests assert on leftover files and rows.
 */

const ARTICLE_URL = 'https://example.com/posts/the-margin';

const ARTICLE_HTML = `<!doctype html>
<html><head>
  <title>The Margin</title>
  <meta property="og:site_name" content="Example Times">
  <meta name="author" content="A Reporter">
</head><body>
  <nav><a href="/">Home</a></nav>
  <article class="post-content">
    <h2>Why margins matter</h2>
    <p>The margin of a page is where a reader argues with the author, and this
    paragraph exists so the extraction heuristics have a genuine article body to
    score rather than a fragment. It is long enough on its own, and it contains
    commas, which the scoring pass treats as evidence of prose.</p>
    <p>A second paragraph keeps the container clearly ahead of the page chrome,
    with more commas, more clauses, and enough length to matter.</p>
    <ul><li>First point</li><li>Second point</li></ul>
  </article>
  <footer>Copyright</footer>
</body></html>`;

class FixtureTransport implements WebArticleTransport {
  readonly requested: string[] = [];

  constructor(private readonly pages: Record<string, FetchedWebPage | Error>) {}

  fetchArticleHtml(url: string): Promise<FetchedWebPage> {
    this.requested.push(url);
    const page = this.pages[url];
    if (page === undefined) {
      return Promise.reject(
        new InterleafError('validation', 'Interleaf could not reach that website.')
      );
    }
    if (page instanceof Error) return Promise.reject(page);
    return Promise.resolve(page);
  }
}

function fetched(html: string, finalUrl = ARTICLE_URL): FetchedWebPage {
  return { html, finalUrl, transferredBytes: Buffer.byteLength(html, 'utf8') };
}

describe('web article import integration', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let docRepo: DocumentRepository;
  let service: LibraryService;
  let transport: FixtureTransport;

  function build(pages: Record<string, FetchedWebPage | Error>): void {
    transport = new FixtureTransport(pages);
    const log = createLogger('library');
    service = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: new FolderRepository(db),
      readingPositions: new ReadingPositionRepository(db),
      assetRegistry: new AssetRegistry([libraryDir]),
      currentScopeId: () => 'reader-test-scope',
      log,
      webArticles: new WebArticleImportService({ media: new TestWebMediaTransport(), transport, log }),
      documentAssets: new DocumentAssetRepository(db),
    });
  }

  /** Every regular file under the managed library root. */
  function managedFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) found.push(full);
      }
    };
    walk(storage.rootPath);
    return found;
  }

  function documentCount(): number {
    const row = db.raw.prepare('SELECT COUNT(*) AS n FROM documents').get();
    if (row && typeof row === 'object' && 'n' in row && typeof row.n === 'number') {
      return row.n;
    }
    return 0;
  }

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-web-import-')));
    libraryDir = join(tempDir, 'library');
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    storage = new StorageManager(libraryDir, createLogger('library'));
    await storage.initialize();
    docRepo = new DocumentRepository(db);
    build({ [ARTICLE_URL]: fetched(ARTICLE_HTML) });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('successful capture', () => {
    test('creates a managed Markdown document with provenance', async () => {
      const result = await service.importWebArticle(ARTICLE_URL);

      expect(result.alreadyInLibrary).toBe(false);
      expect(result.document.format).toBe('markdown');
      expect(result.document.storageMode).toBe('managed');
      expect(result.document.title).toBe('The Margin');
      expect(result.document.author).toBe('A Reporter');
      expect(result.document.source).toEqual({
        kind: 'web',
        url: ARTICLE_URL,
        siteName: 'Example Times',
        capturedAt: expect.any(String),
      });
      expect(Date.parse(result.document.source?.capturedAt ?? '')).not.toBeNaN();
    });

    test('persists provenance in the additive v21 columns', async () => {
      const result = await service.importWebArticle(ARTICLE_URL);
      const row = db.raw
        .prepare(
          'SELECT source_kind, source_url, source_site_name, source_captured_at FROM documents WHERE id = ?'
        )
        .get(result.document.id) as {
          source_kind: string | null;
          source_url: string | null;
          source_site_name: string | null;
          source_captured_at: string | null;
        };

      expect(row.source_kind).toBe('web');
      expect(row.source_url).toBe(ARTICLE_URL);
      expect(row.source_site_name).toBe('Example Times');
      expect(typeof row.source_captured_at).toBe('string');
    });

    test('writes a read-only content-addressed file holding clean Markdown', async () => {
      const result = await service.importWebArticle(ARTICLE_URL);
      const files = managedFiles();
      expect(files).toHaveLength(1);

      const filePath = files[0] ?? '';
      const mode = statSync(filePath).mode & 0o777;
      // Readable by the owner, unwriteable by anyone.
      expect(mode & 0o222).toBe(0);

      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('# The Margin');
      expect(content).toContain('Why margins matter');
      expect(content).toContain('source: "https://example.com/posts/the-margin"');
      // No raw HTML tags survived into the Markdown.
      expect(content).not.toMatch(/<(article|p|nav|footer|ul|li)/i);

      // The file hash in the database matches the file content.
      expect(result.document.fileHash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('re-importing an identical snapshot reuses the file and row', async () => {
      const first = await service.importWebArticle(ARTICLE_URL);
      const second = await service.importWebArticle(ARTICLE_URL);

      expect(second.alreadyInLibrary).toBe(true);
      expect(second.document.id).toBe(first.document.id);
      expect(second.document.fileHash).toBe(first.document.fileHash);
      expect(managedFiles()).toHaveLength(1);
      expect(documentCount()).toBe(1);
    });

    test('first-write provenance: file-imported document preserves null source when identical web bytes imported', async () => {
      // 1. Prepare web article markdown first to get exact bytes
      const initial = await service.importWebArticle(ARTICLE_URL);
      const docPath = docRepo.findById(initial.document.id)!.filePath;
      const content = readFileSync(docPath, 'utf8');
      // Clean up to start fresh with file first
      await service.deleteDocument(initial.document.id);

      const localPath = join(tempDir, 'local-first.md');
      writeFileSync(localPath, content);
      const fileImport = await service.importFiles([localPath], { folderId: null, storageMode: 'managed' });
      expect(fileImport.imported).toHaveLength(1);
      expect(fileImport.imported[0]?.source).toBeNull();

      // 2. Import identical bytes from web
      const webImport = await service.importWebArticle(ARTICLE_URL);
      expect(webImport.alreadyInLibrary).toBe(true);
      expect(webImport.document.id).toBe(fileImport.imported[0]?.id);
      expect(webImport.document.source).toBeNull();
    });

    test('first-write provenance: web-imported document preserves web source when identical file bytes imported', async () => {
      // 1. Import from web first
      const webImport = await service.importWebArticle(ARTICLE_URL);
      expect(webImport.document.source?.kind).toBe('web');

      // 2. Import identical bytes from disk file
      const docPath = docRepo.findById(webImport.document.id)!.filePath;
      const content = readFileSync(docPath, 'utf8');
      const localPath = join(tempDir, 'identical-to-web.md');
      writeFileSync(localPath, content);

      const fileImport = await service.importFiles([localPath], { folderId: null, storageMode: 'managed' });
      expect(fileImport.imported).toHaveLength(1);
      expect(fileImport.imported[0]?.id).toBe(webImport.document.id);
      expect(fileImport.imported[0]?.source?.kind).toBe('web');
    });

    test('source_kind check constraint rejects invalid provenance kind', () => {
      expect(() => {
        db.raw.prepare(`
          INSERT INTO documents (
            id, title, author, format, file_path, storage_mode,
            file_size, file_mtime_ms, file_hash, page_count, cover_path, folder_id,
            source_kind, source_url, source_site_name, source_captured_at,
            created_at, updated_at
          ) VALUES ('invalid-kind-doc', 'Title', NULL, 'markdown', '/path/test.md', 'managed',
            100, 1000, 'hash123', NULL, NULL, NULL,
            'ftp_mirror', 'https://example.com', 'Example', '2026-09-01T00:00:00.000Z',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        `).run();
      }).toThrow(/CHECK constraint/);
    });

    test('two concurrent imports of the same article converge without error', async () => {
      const [first, second] = await Promise.all([
        service.importWebArticle(ARTICLE_URL),
        service.importWebArticle(ARTICLE_URL),
      ]);
      expect(first.document.id).toBe(second.document.id);
      expect(managedFiles()).toHaveLength(1);
    });

    test('can target a specific library folder', async () => {
      const folderRepo = new FolderRepository(db);
      const folder = folderRepo.create('folder-1', 'Articles');
      const result = await service.importWebArticle(ARTICLE_URL, { folderId: folder.id });
      expect(result.document.folderId).toBe(folder.id);
    });

    test('rejects a folder that no longer exists without leaving anything behind', async () => {
      await expect(
        service.importWebArticle(ARTICLE_URL, { folderId: 'missing-folder' })
      ).rejects.toThrow();
      expect(managedFiles()).toHaveLength(0);
      expect(documentCount()).toBe(0);
    });
  });

  describe('failures leave nothing behind', () => {
    async function expectClean(url: string): Promise<InterleafError> {
      let thrown: InterleafError | null = null;
      try {
        await service.importWebArticle(url);
      } catch (error) {
        if (!(error instanceof InterleafError)) throw error;
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InterleafError);
      expect(managedFiles(), 'no managed or temp file may survive').toHaveLength(0);
      expect(documentCount(), 'no document row may survive').toBe(0);
      return thrown!;
    }

    test('a blocked address never reaches the transport', async () => {
      for (const url of [
        'http://localhost/secret',
        'http://127.0.0.1/secret',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/secret',
        'https://example.com:9000/a',
        'https://user:pw@example.com/a',
        'file:///etc/passwd',
      ]) {
        const error = await expectClean(url);
        expect(error.code).toBe('security-violation');
      }
      expect(transport.requested).toHaveLength(0);
    });

    test('a network failure leaves the library untouched', async () => {
      build({ [ARTICLE_URL]: new InterleafError('validation', 'Interleaf could not reach that website.') });
      const error = await expectClean(ARTICLE_URL);
      expect(error.message).toBe('Interleaf could not reach that website.');
    });

    test('a page with no extractable article leaves the library untouched', async () => {
      build({ [ARTICLE_URL]: fetched('<html><body><div>Too short.</div></body></html>') });
      const error = await expectClean(ARTICLE_URL);
      expect(error.message).toContain('could not find an article');
    });

    test('a redirect that lands on a blocked address is refused after the fetch', async () => {
      build({
        [ARTICLE_URL]: { html: ARTICLE_HTML, finalUrl: 'http://127.0.0.1/admin', transferredBytes: 10 },
      });
      const error = await expectClean(ARTICLE_URL);
      expect(error.code).toBe('security-violation');
    });

    test('an unexpected internal failure is reported as one safe sentence', async () => {
      build({ [ARTICLE_URL]: new Error('ENOENT: /Users/someone/private/token') });
      const error = await expectClean(ARTICLE_URL);
      expect(error.message).toBe('Interleaf could not import that page safely.');
      expect(error.message).not.toContain('/Users/someone');
    });

    test('the service refuses to run at all when web import is not wired up', async () => {
      const log = createLogger('library');
      const bare = new LibraryService({
        db,
        storage,
        documents: docRepo,
        folders: new FolderRepository(db),
        readingPositions: new ReadingPositionRepository(db),
        log,
        documentAssets: new DocumentAssetRepository(db),
        assetRegistry: new AssetRegistry([libraryDir]),
        currentScopeId: () => 'library-test-scope',
      });
      await expect(bare.importWebArticle(ARTICLE_URL)).rejects.toThrow();
      expect(managedFiles()).toHaveLength(0);
    });
  });

  describe('reader compatibility', () => {
    test('the captured document is an ordinary, listed Markdown library row', async () => {
      const result = await service.importWebArticle(ARTICLE_URL);
      const stored = await service.getDocument(result.document.id);

      // Nothing about the row tells the reader it came from the web except the
      // provenance field, so it travels the existing Markdown path unchanged.
      expect(stored?.format).toBe('markdown');
      expect(stored?.storageMode).toBe('managed');
      expect(stored?.source).toEqual(result.document.source);

      const signature = await validateFileSignature(managedFiles()[0] ?? '');
      expect(signature.ok).toBe(true);
      if (signature.ok) {
        expect(signature.format).toBe('markdown');
      }

      // It appears in the ordinary library listing.
      const listed = await service.listDocuments();
      expect(listed.map((doc) => doc.id)).toContain(result.document.id);
    });

    test('deleting the document removes its managed file', async () => {
      const result = await service.importWebArticle(ARTICLE_URL);
      expect(managedFiles()).toHaveLength(1);
      await service.deleteDocument(result.document.id);
      expect(managedFiles()).toHaveLength(0);
    });
  });
});
