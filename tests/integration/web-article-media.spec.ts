import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { AnnotationRepository } from '../../src/main/db/repositories/annotation-repository';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { LibraryService } from '../../src/main/library/library-service';
import { WebArticleImportService } from '../../src/main/library/web-article-import';
import {
  registerWebMediaFixture,
  TestWebMediaTransport,
} from '../../src/main/net/test-web-media-transport';
import type { FetchedWebPage, WebArticleTransport } from '../../src/main/net/web-article-transport';
import type {
  FetchedWebMedia,
  WebMediaTransport,
  WebMediaTransportOptions,
} from '../../src/main/net/web-media-transport';
import { MAX_MEDIA_BYTES } from '../../src/main/net/web-media-fetcher';
import { MAX_TOTAL_MEDIA_BYTES } from '../../src/main/library/article-media';
import { createLogger } from '../../src/main/logging/logger';
import { InterleafError } from '../../src/shared/errors/interleaf-error';
import {
  astraArticleHtml,
  astraMediaFixtures,
  ASTRA_ALT_TEXT,
  ASTRA_ARCHIVED_IMAGE_URLS,
  ASTRA_ARTICLE_URL,
  ASTRA_EXCLUDED_IMAGE_URLS,
  ASTRA_IMAGE_URLS,
} from '../fixtures/astra-article-fixture';
import { makePng, SVG_BYTES } from '../fixtures/raster-fixtures';
import { MAX_ARTICLE_IMAGES } from '../../src/main/library/article-content';
import { CHART_ARTICLE_URL, CHART_URLS, chartArticleHtml, chartMediaFixtures } from '../fixtures/editorial-charts-fixture';

/**
 * Ingestion, storage, capability, and lifecycle behaviour for the images of a
 * captured article.
 *
 * The two transports are fixtures so nothing here opens a socket, but the rest
 * of the stack is the production one: the address policy, the extraction
 * worker, raster admission, content-addressed storage, the database, the asset
 * registry, and the library service. The claims worth proving at this level are
 * the ones no unit test can reach — that a page URL never survives into the
 * snapshot, that a reopen needs no network, and that replacing or deleting a
 * capture removes exactly the files nothing else refers to and no others.
 */

const RENDERER_SCOPE = 'reader-test-scope';
const OTHER_ARTICLE_URL = 'https://example.com/posts/reviewing-astra';
const OVERFLOW_ARTICLE_URL = 'https://example.com/posts/every-bench-photograph';

/**
 * More eligible figures than any saturating count could describe.
 *
 * Every figure is ordinary editorial work, so the only reason any go missing is
 * the archive ceiling. Overflow used to be reported as zero omissions, and the
 * omission count later stopped at four hundred, so a page like this one
 * reported a shortfall smaller than the one the reader actually had: forty
 * archived plus four hundred counted did not add up to what the page offered.
 * The number is deliberately past that point.
 */
const OVERFLOW_FIGURE_COUNT = 480;

function overflowImageUrl(index: number): string {
  return `https://cdn.example.com/every/plate-${String(index)}.png`;
}

function overflowArticleHtml(): string {
  const figures = Array.from({ length: OVERFLOW_FIGURE_COUNT }, (_value, index) => {
    const ordinal = String(index);
    return `<figure><img src="${overflowImageUrl(index)}" width="64" height="48"
        alt="Switch plate number ${ordinal}"><figcaption>Switch plate ${ordinal}.</figcaption></figure>`;
  }).join('');
  return `<!doctype html>
<html><head><title>Every bench photograph</title></head><body>
  <article>
    <p>This paragraph exists so the extraction heuristics have a genuine article
    body to score rather than a fragment, and it is long enough on its own, with
    commas, which the scoring pass reads as evidence of prose.</p>
    ${figures}
    <p>A closing paragraph, with more clauses and more commas, keeps the article
    container clearly ahead of everything around it.</p>
  </article>
</body></html>`;
}

/**
 * Bytes for the archivable prefix only.
 *
 * Nothing past the archive bound is registered, so a request for one of those
 * would fail loudly instead of quietly succeeding: the test proves the overflow
 * is never asked for rather than merely that it was not stored.
 */
function overflowMediaFixtures(): Record<string, { base64: string; contentType: string }> {
  const entries: Record<string, { base64: string; contentType: string }> = {};
  for (let index = 0; index < MAX_ARTICLE_IMAGES; index += 1) {
    entries[overflowImageUrl(index)] = {
      base64: makePng(64, 48, [index * 5, 40, 120]).toString('base64'),
      contentType: 'image/png',
    };
  }
  return entries;
}


/**
 * A second, unrelated article that happens to publish the same editorial image.
 *
 * Two documents sharing one content-addressed file is the case where "delete
 * the superseded images" would otherwise take a live document's picture away.
 */
const SHARED_IMAGE_HTML = `<!doctype html>
<html><head>
  <title>Reviewing Astra</title>
  <meta property="og:site_name" content="Example Review">
</head><body>
  <article>
    <p>We spent a week with the new assistant, and this paragraph exists so the
    extraction heuristics have a genuine article body to score rather than a
    fragment. It is long enough on its own, and it contains commas, which the
    scoring pass treats as evidence of prose.</p>
    <figure>
      <img src="${ASTRA_IMAGE_URLS.comparison}" width="240" height="140"
           alt="${ASTRA_ALT_TEXT.comparison}">
      <figcaption>Borrowed from the announcement post.</figcaption>
    </figure>
    <p>A second paragraph keeps the container clearly ahead of the page chrome,
    with more commas, more clauses, and enough length to matter to the scorer.</p>
  </article>
</body></html>`;

class FixturePageTransport implements WebArticleTransport {
  readonly requested: string[] = [];

  constructor(private pages: Record<string, string>) {}

  setPage(url: string, html: string): void {
    this.pages = { ...this.pages, [url]: html };
  }

  fetchArticleHtml(url: string): Promise<FetchedWebPage> {
    this.requested.push(url);
    const html = this.pages[url];
    if (html === undefined) {
      return Promise.reject(
        new InterleafError('validation', 'Interleaf could not reach that website.')
      );
    }
    return Promise.resolve({ html, finalUrl: url, transferredBytes: Buffer.byteLength(html) });
  }
}

/**
 * The shipped test seam, wrapped so a test can watch it and poison one URL.
 *
 * Delegating to `TestWebMediaTransport` keeps real raster admission — magic
 * bytes, declared type agreement, dimension and pixel bounds — in the path, so
 * a hostile-bytes test fails for the production reason rather than a fixture's
 * private one.
 */
class RecordingMediaTransport implements WebMediaTransport {
  readonly requested: string[] = [];
  readonly allowances: number[] = [];
  private readonly inner = new TestWebMediaTransport();
  private readonly failures = new Map<string, Error>();
  private readonly costs = new Map<string, number>();

  fail(url: string, error: Error): void {
    this.failures.set(url, error);
  }

  /** Fails after moving `wireBytes`, the way an oversized response does. */
  failCostly(url: string, wireBytes: number, error: Error): void {
    this.failures.set(url, error);
    this.costs.set(url, wireBytes);
  }

  reset(): void {
    this.requested.length = 0;
    this.allowances.length = 0;
  }

  fetchImage(url: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia> {
    this.requested.push(url);
    this.allowances.push(options?.maxTransferBytes ?? 0);
    const failure = this.failures.get(url);
    if (failure !== undefined) {
      options?.onWireBytes?.(this.costs.get(url) ?? 0);
      return Promise.reject(failure);
    }
    return this.inner.fetchImage(url, options);
  }
}

describe('web article media integration', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let docRepo: DocumentRepository;
  let assetRepo: DocumentAssetRepository;
  let assetRegistry: AssetRegistry;
  let annotations: AnnotationRepository;
  let service: LibraryService;
  let pages: FixturePageTransport;
  let media: RecordingMediaTransport;

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

  function snapshotText(documentId: string): string {
    const record = docRepo.findById(documentId);
    expect(record).not.toBeNull();
    return readFileSync(record?.filePath ?? '', 'utf8');
  }

  function assetRowCount(): number {
    const row = db.raw.prepare('SELECT COUNT(*) AS n FROM document_assets').get();
    return row && typeof row === 'object' && 'n' in row && typeof row.n === 'number' ? row.n : 0;
  }

  function documentCount(): number {
    const row = db.raw.prepare('SELECT COUNT(*) AS n FROM documents').get();
    return row && typeof row === 'object' && 'n' in row && typeof row.n === 'number' ? row.n : 0;
  }

  beforeEach(async () => {
    for (const [url, fixture] of Object.entries(astraMediaFixtures())) {
      registerWebMediaFixture(url, fixture);
    }
    for (const [url, fixture] of Object.entries(overflowMediaFixtures())) {
      registerWebMediaFixture(url, fixture);
    }

    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-web-media-')));
    libraryDir = join(tempDir, 'library');
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    storage = new StorageManager(libraryDir, createLogger('library'));
    await storage.initialize();
    docRepo = new DocumentRepository(db);
    assetRepo = new DocumentAssetRepository(db);
    assetRegistry = new AssetRegistry([libraryDir]);
    annotations = new AnnotationRepository(db);
    pages = new FixturePageTransport({
      [ASTRA_ARTICLE_URL]: astraArticleHtml(),
      [OTHER_ARTICLE_URL]: SHARED_IMAGE_HTML,
      [OVERFLOW_ARTICLE_URL]: overflowArticleHtml(),
    });
    media = new RecordingMediaTransport();
    const log = createLogger('library');
    service = new LibraryService({
      db,
      storage,
      documents: docRepo,
      documentAssets: assetRepo,
      folders: new FolderRepository(db),
      readingPositions: new ReadingPositionRepository(db),
      assetRegistry,
      currentScopeId: () => RENDERER_SCOPE,
      log,
      webArticles: new WebArticleImportService({ transport: pages, media, log }),
    });
  });

  afterEach(() => {
    assetRegistry.clear();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('archives all twelve image-only editorial figures and reopens local capabilities', async () => {
    pages.setPage(CHART_ARTICLE_URL, chartArticleHtml());
    for (const [url, fixture] of Object.entries(chartMediaFixtures())) registerWebMediaFixture(url, fixture);
    const result = await service.importWebArticle(CHART_ARTICLE_URL);
    expect(media.requested).toEqual(CHART_URLS);
    expect(result.media).toEqual({ archived: 12, omitted: 0 });
    expect(assetRowCount()).toBe(12);
    const snapshot = snapshotText(result.document.id);
    expect(snapshot.match(/interleaf-asset:/g)).toHaveLength(12);
    for (const url of CHART_URLS) expect(snapshot).not.toContain(url);
    media.reset();
    const opened = await service.openDocument(result.document.id);
    expect(opened.mediaAssets).toHaveLength(12);
    expect(media.requested).toEqual([]);
  }, 30000);

  describe('archiving images into managed storage', () => {
    test('fetches exactly the useful images and stores each as a managed file', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(media.requested).toEqual([...ASTRA_ARCHIVED_IMAGE_URLS]);
      for (const excluded of ASTRA_EXCLUDED_IMAGE_URLS) {
        expect(media.requested, `${excluded} must never be fetched`).not.toContain(excluded);
      }

      // A complete capture has nothing to report to the reader.
      expect(result.media).toEqual({
        archived: ASTRA_ARCHIVED_IMAGE_URLS.length,
        omitted: 0,
      });

      const rows = assetRepo.listForDocument(result.document.id);
      expect(rows).toHaveLength(ASTRA_ARCHIVED_IMAGE_URLS.length);
      // One Markdown snapshot plus one file per archived image.
      expect(managedFiles()).toHaveLength(1 + ASTRA_ARCHIVED_IMAGE_URLS.length);

      for (const row of rows) {
        expect(row.reference).toMatch(/^interleaf-asset:[a-f0-9]{64}\.png$/);
        expect(row.mimeType).toBe('image/png');
        expect(row.extension).toBe('.png');
        expect(row.width).toBeGreaterThan(0);
        expect(row.height).toBeGreaterThan(0);
        expect(row.byteSize).toBe(statSync(row.filePath).size);
        // Managed, and unwriteable by anyone once ingested.
        const managed = relative(storage.rootPath, row.filePath);
        expect(managed.startsWith('..') || isAbsolute(managed)).toBe(false);
        expect(statSync(row.filePath).mode & 0o222).toBe(0);
      }
    }, 30000);

    test('records each image in reading order under its own durable reference', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const rows = assetRepo.listForDocument(result.document.id);

      expect(rows.map((row) => row.position)).toEqual([...ASTRA_ARCHIVED_IMAGE_URLS.keys()]);
      expect(new Set(rows.map((row) => row.reference)).size).toBe(rows.length);

      const markdown = snapshotText(result.document.id);
      const referenced = [...markdown.matchAll(/!\[[^\]]*]\((interleaf-asset:[^)]+)\)/g)].map(
        (match) => match[1]
      );
      expect(referenced).toEqual(rows.map((row) => row.reference));
    }, 30000);

    test('the snapshot names only durable identities, never a page URL or a capability', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const markdown = snapshotText(result.document.id);

      for (const url of Object.values(ASTRA_IMAGE_URLS)) {
        expect(markdown, `${url} must not be persisted`).not.toContain(url);
      }
      // A capability is minted per open and would be a dangling string tomorrow.
      expect(markdown).not.toContain('interleaf-media:');
      expect(markdown).toContain('interleaf-asset:');
    }, 30000);

    test('stores identical bytes once and shares the file between documents', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const before = managedFiles().length;
      const second = await service.importWebArticle(OTHER_ARTICLE_URL);

      const shared = assetRepo.listForDocument(second.document.id);
      expect(shared).toHaveLength(1);
      const original = assetRepo
        .listForDocument(first.document.id)
        .find((row) => row.assetHash === shared[0]?.assetHash);
      expect(original?.filePath).toBe(shared[0]?.filePath);
      // Only the second article's Markdown snapshot is new.
      expect(managedFiles()).toHaveLength(before + 1);
    }, 30000);

    test('a rejected image is omitted with its description rather than failing the capture', async () => {
      media.fail(
        ASTRA_IMAGE_URLS.comparison,
        new InterleafError('validation', 'That image was not an archivable raster.')
      );
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(assetRepo.listForDocument(result.document.id)).toHaveLength(
        ASTRA_ARCHIVED_IMAGE_URLS.length - 1
      );
      const markdown = snapshotText(result.document.id);
      expect(markdown).not.toContain(`![${ASTRA_ALT_TEXT.comparison}]`);
      expect(markdown, 'the reader still learns what was there').toContain(
        `*${ASTRA_ALT_TEXT.comparison}*`
      );
      // The figure's caption and the rest of the article are untouched.
      expect(markdown).toContain('Reviewers preferred the Astra transcript');
      expect(markdown).toContain('| Graduate reasoning |');
    }, 30000);

    test('vector bytes served under an image content type are refused by admission', async () => {
      registerWebMediaFixture(ASTRA_IMAGE_URLS.lazy, {
        base64: SVG_BYTES.toString('base64'),
        contentType: 'image/png',
      });
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);

      const rows = assetRepo.listForDocument(result.document.id);
      expect(rows).toHaveLength(ASTRA_ARCHIVED_IMAGE_URLS.length - 1);
      for (const row of rows) {
        expect(readFileSync(row.filePath).subarray(0, 4).toString('latin1')).not.toContain('<');
      }
      expect(snapshotText(result.document.id)).toContain(`*${ASTRA_ALT_TEXT.lazy}*`);
    }, 30000);

    test('repeated oversized responses cannot outspend the article media budget', async () => {
      // Every image answers with a full per-image transfer and then fails. If a
      // failure refunded its reservation, five images could move 40 MB behind a
      // 24 MB claim; charged properly, only three requests fit at all.
      for (const url of ASTRA_ARCHIVED_IMAGE_URLS) {
        media.failCostly(
          url,
          MAX_MEDIA_BYTES,
          new InterleafError('validation', 'That image is too large for Interleaf to store.')
        );
      }
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(media.requested).toHaveLength(
        Math.floor(MAX_TOTAL_MEDIA_BYTES / MAX_MEDIA_BYTES)
      );
      expect(media.allowances.every((allowance) => allowance <= MAX_MEDIA_BYTES)).toBe(true);
      expect(assetRepo.listForDocument(result.document.id)).toHaveLength(0);
      // Every candidate is accounted for: the three that failed and the ones
      // the exhausted budget meant were never asked for.
      expect(result.media).toEqual({
        archived: 0,
        omitted: ASTRA_ARCHIVED_IMAGE_URLS.length,
      });
      // The article is still perfectly readable without any of its pictures.
      const markdown = snapshotText(result.document.id);
      expect(markdown).toContain(`*${ASTRA_ALT_TEXT.comparison}*`);
      expect(markdown).toContain('| Graduate reasoning |');
      expect(managedFiles(), 'only the snapshot was written').toHaveLength(1);
    }, 30000);

    test('a media address violation fails the whole import and leaves nothing behind', async () => {
      media.fail(
        ASTRA_IMAGE_URLS.relative,
        new InterleafError('security-violation', 'That address is not allowed.')
      );

      let thrown: InterleafError | null = null;
      try {
        await service.importWebArticle(ASTRA_ARTICLE_URL);
      } catch (error) {
        if (!(error instanceof InterleafError)) throw error;
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InterleafError);
      expect(thrown!.code).toBe('security-violation');

      expect(documentCount(), 'no document row may survive').toBe(0);
      expect(assetRowCount(), 'no asset row may survive').toBe(0);
      expect(managedFiles(), 'no managed image may survive').toHaveLength(0);
    }, 30000);
  });

  describe('capabilities at open time', () => {
    test('every archived image is offered as an opaque scoped URL', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const opened = await service.openDocument(result.document.id);

      const rows = assetRepo.listForDocument(result.document.id);
      expect(opened.mediaAssets).toHaveLength(rows.length);
      expect(opened.mediaAssets.map((asset) => asset.reference)).toEqual(
        rows.map((row) => row.reference)
      );
      for (const asset of opened.mediaAssets) {
        expect(asset.url).toMatch(/^interleaf-media:\/\/[0-9a-f-]{36}$/);
        expect(asset.url).not.toContain(libraryDir);
        expect(asset.width).toBeGreaterThan(0);
      }
      expect(JSON.stringify(opened.mediaAssets), 'no managed path crosses the boundary').not.toContain(
        libraryDir
      );
    }, 30000);

    test('a capability resolves to the managed file only inside its own scope', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const opened = await service.openDocument(result.document.id);
      const assetId = (opened.mediaAssets[0]?.url ?? '').replace('interleaf-media://', '');

      const resolved = assetRegistry.resolveAsset(assetId, RENDERER_SCOPE);
      expect(resolved?.documentId).toBe(result.document.id);
      expect(resolved?.mimeType).toBe('image/png');
      expect(assetRegistry.resolveAsset(assetId, 'another-window')).toBeNull();
    }, 30000);

    test('closing the document revokes every image capability', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const opened = await service.openDocument(result.document.id);
      const ids = opened.mediaAssets.map((asset) => asset.url.replace('interleaf-media://', ''));

      await service.closeDocument(result.document.id);
      for (const id of ids) {
        expect(assetRegistry.resolveAsset(id, RENDERER_SCOPE)).toBeNull();
      }
    }, 30000);

    test('opening another document revokes the first one capabilities', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const opened = await service.openDocument(first.document.id);
      const staleId = (opened.mediaAssets[0]?.url ?? '').replace('interleaf-media://', '');

      const second = await service.importWebArticle(OTHER_ARTICLE_URL);
      await service.openDocument(second.document.id);

      expect(assetRegistry.resolveAsset(staleId, RENDERER_SCOPE)).toBeNull();
    }, 30000);

    test('reopening with the network gone still yields images and tables', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      await service.openDocument(result.document.id);
      await service.closeDocument(result.document.id);

      // Everything from here on is offline: any fetch would be recorded.
      media.reset();
      pages.requested.length = 0;

      const reopened = await service.openDocument(result.document.id);
      expect(media.requested, 'a reopen must need no network').toHaveLength(0);
      expect(pages.requested).toHaveLength(0);
      expect(reopened.mediaAssets).toHaveLength(ASTRA_ARCHIVED_IMAGE_URLS.length);

      const rows = assetRepo.listForDocument(result.document.id);
      const markdown = snapshotText(result.document.id);
      expect(markdown).toContain('| Graduate reasoning |');
      for (const asset of reopened.mediaAssets) {
        expect(markdown).toContain(`(${asset.reference})`);
        const stored = rows.find((row) => row.reference === asset.reference);
        expect(statSync(stored?.filePath ?? '').size).toBeGreaterThan(0);
      }
    }, 30000);

    test('an image whose file has gone missing is skipped instead of failing the open', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const rows = assetRepo.listForDocument(result.document.id);
      rmSync(rows[0]?.filePath ?? '', { force: true });

      const opened = await service.openDocument(result.document.id);
      expect(opened.mediaAssets).toHaveLength(rows.length - 1);
      expect(opened.mediaAssets.map((asset) => asset.reference)).not.toContain(rows[0]?.reference);
    }, 30000);
  });

  describe('re-importing upgrades the capture in place', () => {
    test('keeps the document identity, folder, and annotations while replacing content', async () => {
      const folders = new FolderRepository(db);
      const folder = folders.create('folder-articles', 'Articles');
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL, { folderId: folder.id });
      const annotation = annotations.create({
        documentId: first.document.id,
        type: 'highlight',
        anchor: {
          format: 'markdown',
          blockIndex: 1,
          quote: { exact: 'Astra is our new generation', prefix: '', suffix: '' },
        },
        selectedText: 'Astra is our new generation',
        color: 'yellow',
      });

      pages.setPage(ASTRA_ARTICLE_URL, astraArticleHtml({ withoutBodyImages: true }));
      const second = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(second.alreadyInLibrary).toBe(true);
      // The summary describes the capture that just ran, not the one it replaced.
      expect(second.media).toEqual({ archived: 1, omitted: 0 });
      expect(second.document.id).toBe(first.document.id);
      expect(second.document.folderId).toBe(folder.id);
      expect(second.document.fileHash).not.toBe(first.document.fileHash);
      expect(documentCount()).toBe(1);

      const survived = annotations.list(first.document.id).find((entry) => entry.id === annotation.id);
      expect(survived?.id).toBe(annotation.id);
      expect(survived?.selectedText).toBe('Astra is our new generation');

      // The capture time advances even though the row is the same one.
      expect(second.document.source?.url).toBe(ASTRA_ARTICLE_URL);
      expect(Date.parse(second.document.source?.capturedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(first.document.source?.capturedAt ?? '')
      );
    }, 30000);

    test('swaps the asset set and deletes only the superseded files nothing refers to', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      // A second document adopts one of the first capture's images.
      await service.importWebArticle(OTHER_ARTICLE_URL);
      const supersededPaths = assetRepo.listForDocument(first.document.id).map((row) => row.filePath);
      const sharedPath = supersededPaths[0] ?? '';
      expect(supersededPaths.every((path) => statSync(path).isFile())).toBe(true);

      pages.setPage(ASTRA_ARTICLE_URL, astraArticleHtml({ withoutBodyImages: true }));
      await service.importWebArticle(ASTRA_ARTICLE_URL);

      const upgraded = assetRepo.listForDocument(first.document.id);
      // The canvas hero page falls back to its Open Graph card, and nothing else.
      expect(upgraded).toHaveLength(1);
      expect(media.requested).toContain(ASTRA_IMAGE_URLS.hero);

      const stillOnDisk = managedFiles();
      expect(stillOnDisk, 'the image the review article uses must survive').toContain(sharedPath);
      for (const path of supersededPaths.slice(1)) {
        expect(stillOnDisk, `${path} is orphaned and must be reclaimed`).not.toContain(path);
      }
      expect(stillOnDisk).toContain(upgraded[0]?.filePath);
    }, 30000);

    test('revokes capabilities the reader held for the replaced content', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const opened = await service.openDocument(first.document.id);
      const staleIds = opened.mediaAssets.map((asset) => asset.url.replace('interleaf-media://', ''));

      pages.setPage(ASTRA_ARTICLE_URL, astraArticleHtml({ withoutBodyImages: true }));
      await service.importWebArticle(ASTRA_ARTICLE_URL);

      for (const id of staleIds) {
        expect(assetRegistry.resolveAsset(id, RENDERER_SCOPE)).toBeNull();
      }
    }, 30000);

    test('converging on an existing snapshot reclaims the images it staged', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const beforeFiles = managedFiles().sort();
      const beforeAssets = assetRepo.listForDocument(first.document.id);
      // The stored capture no longer answers to this URL, so the re-import is a
      // content duplicate rather than an in-place upgrade: the existing row wins
      // and this attempt's freshly staged images belong to nothing.
      db.raw
        .prepare('UPDATE documents SET source_url = ? WHERE id = ?')
        .run('https://mirror.example.com/astra', first.document.id);

      const second = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(second.alreadyInLibrary).toBe(true);
      expect(second.document.id).toBe(first.document.id);
      expect(documentCount()).toBe(1);
      expect(assetRepo.listForDocument(first.document.id)).toEqual(beforeAssets);
      // Content-addressed staging converges on the same files, and every one of
      // them is still referenced, so nothing is added and nothing is taken away.
      expect(managedFiles().sort()).toEqual(beforeFiles);
    }, 30000);

    test('does not swallow unrelated transaction or asset failures when a same-hash row exists', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const firstRow = docRepo.findById(first.document.id);
      if (firstRow === null) throw new Error('expected first document record');

      // A new capture whose content hash is unique so SQLite documents.insert succeeds
      pages.setPage(OTHER_ARTICLE_URL, astraArticleHtml({ withoutBodyImages: true }));

      let findByHashCall = 0;
      const findSpy = vi.spyOn(docRepo, 'findByHash').mockImplementation(() => {
        findByHashCall += 1;
        if (findByHashCall === 1) return []; // initial check before insert in storeWebArticleExclusive
        return [firstRow]; // simulate findByHash finding a same-hash row in catch block
      });

      // When an unrelated failure (e.g. asset error) occurs in insertCapturedArticle,
      // the error must NOT be swallowed as an insert race even though findByHash finds an existing row.
      const replace = vi
        .spyOn(assetRepo, 'replaceForDocument')
        .mockImplementationOnce(() => {
          throw new Error('disk or asset failure during insert');
        });

      await expect(service.importWebArticle(OTHER_ARTICLE_URL)).rejects.toThrow(
        'Interleaf could not import that page safely.'
      );
      replace.mockRestore();
      findSpy.mockRestore();
    }, 30000);

    test('a failed upgrade leaves the previous capture exactly as it was', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const annotation = annotations.create({
        documentId: first.document.id,
        type: 'highlight',
        anchor: {
          format: 'markdown',
          blockIndex: 1,
          quote: { exact: 'Astra is our new generation', prefix: '', suffix: '' },
        },
        selectedText: 'Astra is our new generation',
        color: 'yellow',
      });
      const beforeRow = docRepo.findById(first.document.id);
      const beforeAssets = assetRepo.listForDocument(first.document.id);
      const beforeFiles = managedFiles().sort();
      const beforeSnapshot = snapshotText(first.document.id);

      // The in-place swap fails part way: after the snapshot and new images are
      // already on disk and after replaceCapturedSnapshot has updated the document
      // row in SQLite. Injecting the failure in assetRepo.replaceForDocument proves
      // that the transaction rolls back both mutations: old row, snapshot, assets,
      // annotations, and managed files survive while newly staged files are reclaimed.
      const replace = vi
        .spyOn(assetRepo, 'replaceForDocument')
        .mockImplementationOnce(() => {
          throw new Error('injected upgrade failure');
        });
      pages.setPage(ASTRA_ARTICLE_URL, astraArticleHtml({ withoutBodyImages: true }));
      await expect(service.importWebArticle(ASTRA_ARTICLE_URL)).rejects.toBeInstanceOf(
        InterleafError
      );
      replace.mockRestore();

      expect(documentCount()).toBe(1);
      expect(docRepo.findById(first.document.id)).toEqual(beforeRow);
      expect(assetRepo.listForDocument(first.document.id)).toEqual(beforeAssets);
      expect(annotations.list(first.document.id).find((entry) => entry.id === annotation.id)?.selectedText).toBe(
        'Astra is our new generation'
      );
      expect(snapshotText(first.document.id)).toBe(beforeSnapshot);
      // Every file the capture still needs survived, and the staged replacement
      // was reclaimed rather than left behind as garbage.
      expect(managedFiles().sort()).toEqual(beforeFiles);

      // And the document is still openable, with all of its images.
      const opened = await service.openDocument(first.document.id);
      expect(opened.mediaAssets).toHaveLength(ASTRA_ARCHIVED_IMAGE_URLS.length);
    }, 30000);

    test('an unchanged page refreshes the capture without duplicating anything', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const before = managedFiles().length;
      const second = await service.importWebArticle(ASTRA_ARTICLE_URL);

      expect(second.document.id).toBe(first.document.id);
      expect(second.document.fileHash).toBe(first.document.fileHash);
      expect(documentCount()).toBe(1);
      expect(assetRowCount()).toBe(ASTRA_ARCHIVED_IMAGE_URLS.length);
      expect(managedFiles()).toHaveLength(before);
    }, 30000);
  });

  describe('deletion and reconciliation', () => {
    test('deleting a document reclaims its images but keeps shared ones', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const second = await service.importWebArticle(OTHER_ARTICLE_URL);
      const owned = assetRepo.listForDocument(first.document.id).map((row) => row.filePath);
      const sharedPath = assetRepo.listForDocument(second.document.id)[0]?.filePath ?? '';

      await service.deleteDocument(first.document.id);

      expect(assetRepo.listForDocument(first.document.id)).toHaveLength(0);
      const remaining = managedFiles();
      expect(remaining).toContain(sharedPath);
      for (const path of owned.filter((candidate) => candidate !== sharedPath)) {
        expect(remaining).not.toContain(path);
      }
    }, 30000);

    test('deleting the last document holding an image reclaims it', async () => {
      const first = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const second = await service.importWebArticle(OTHER_ARTICLE_URL);

      await service.deleteDocument(first.document.id);
      await service.deleteDocument(second.document.id);

      expect(assetRowCount()).toBe(0);
      expect(managedFiles()).toHaveLength(0);
    }, 30000);

    test('reconciliation keeps every file the library still refers to', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const before = managedFiles().sort();

      const removed = await service.reconcileManagedStorage(0);

      expect(removed).toBe(0);
      expect(managedFiles().sort()).toEqual(before);
      const opened = await service.openDocument(result.document.id);
      expect(opened.mediaAssets).toHaveLength(ASTRA_ARCHIVED_IMAGE_URLS.length);
    }, 30000);

    test('reconciliation reclaims an image no document row refers to', async () => {
      const result = await service.importWebArticle(ASTRA_ARTICLE_URL);
      const orphanPath = assetRepo.listForDocument(result.document.id)[0]?.filePath ?? '';
      // Simulate a crash between writing the file and committing its row.
      assetRepo.replaceForDocument(
        result.document.id,
        assetRepo.listForDocument(result.document.id).filter((row) => row.filePath !== orphanPath)
      );

      const removed = await service.reconcileManagedStorage(0);

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(managedFiles()).not.toContain(orphanPath);
      // The snapshot and the images it still claims are untouched.
      expect(managedFiles()).toContain(docRepo.findById(result.document.id)?.filePath);
      for (const row of assetRepo.listForDocument(result.document.id)) {
        expect(managedFiles()).toContain(row.filePath);
      }
    }, 30000);
  });

  describe('an article with more figures than a snapshot may hold', () => {
    test('accounts for every figure exactly, however many the page offers', async () => {
      const result = await service.importWebArticle(OVERFLOW_ARTICLE_URL);

      // The whole point: archived plus omitted is the number of pictures the
      // page actually offered, not a ceiling the count stopped at.
      expect(result.media).toEqual({
        archived: MAX_ARTICLE_IMAGES,
        omitted: OVERFLOW_FIGURE_COUNT - MAX_ARTICLE_IMAGES,
      });
      const summary = result.media;
      expect(summary.archived + summary.omitted).toBe(OVERFLOW_FIGURE_COUNT);

      // Bytes exist for the archivable prefix alone, so forty stored rows is
      // also proof that none of the other four hundred and forty was fetched.
      expect(media.requested).toHaveLength(MAX_ARTICLE_IMAGES);
      expect(assetRowCount()).toBe(MAX_ARTICLE_IMAGES);

      const snapshot = snapshotText(result.document.id);
      for (let index = MAX_ARTICLE_IMAGES; index < OVERFLOW_FIGURE_COUNT; index += 1) {
        expect(media.requested).not.toContain(overflowImageUrl(index));
        expect(snapshot).not.toContain(overflowImageUrl(index));
      }
      // Two numbers crossed the boundary and nothing else did.
      expect(Object.keys(summary).sort()).toEqual(['archived', 'omitted']);
    }, 60000);
  });
});
