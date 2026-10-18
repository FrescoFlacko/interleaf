// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { StorageManager } from '../../src/main/library/storage-manager';
import { DocumentRepository } from '../../src/main/db/repositories/document-repository';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { ReadingPositionRepository } from '../../src/main/db/repositories/reading-position-repository';
import { AnnotationRepository } from '../../src/main/db/repositories/annotation-repository';
import { SearchRepository } from '../../src/main/db/repositories/search-repository';
import { AIContextRepository } from '../../src/main/ai/context-repository';
import { ChatContextBuilder } from '../../src/main/ai/context-builder';
import { AssetRegistry } from '../../src/main/security/asset-registry';
import { LibraryService } from '../../src/main/library/library-service';
import { WebArticleImportService } from '../../src/main/library/web-article-import';
import { createSenderRule } from '../../src/main/ipc/sender-validation';
import { registerIpcHandlers, type IpcMainLike } from '../../src/main/ipc/dispatcher';
import { makeIpcDeps } from '../helpers/ipc-deps';
import type { CloneableValue } from '@shared/models/portable';
import { createLogger } from '../../src/main/logging/logger';
import { InterleafError } from '../../src/shared/errors/interleaf-error';
import { IPC_CHANNELS, type IpcChannel } from '../../src/shared/constants/ipc';
import type { IpcResultEnvelope } from '../../src/shared/schemas/ipc';
import type { FetchedWebPage, WebArticleTransport } from '../../src/main/net/web-article-transport';
import type {
  DocumentIndexState,
  IndexGeneration,
  SearchHit,
  SearchIndexChunkInput,
  SearchMatchAnchor,
} from '../../src/shared/types/search';
import type { Annotation, AnnotationAnchorScope, AnnotationFilter, CreateAnnotationInput } from '../../src/shared/types/annotation';
import type { AnnotationPage } from '../../src/shared/types/annotation';
import type { DocumentImportOptions, DocumentLocation, DocumentMetadata, OpenedDocument, ReadingPosition } from '../../src/shared/types/document';
import type { WebArticleImportResult } from '../../src/shared/types/document';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import type { ReaderSelection } from '../../src/renderer/features/reader/types';
import { useSearchStore } from '../../src/renderer/stores/use-search-store';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { stubBridge, testBridge } from '../helpers/interleaf-api';
import { TestWebMediaTransport } from '../../src/main/net/test-web-media-transport';
import { DocumentAssetRepository } from '../../src/main/db/repositories/document-asset-repository';
import { testReaderSession } from '../helpers/reader-session';
import { testDocumentSource } from '../helpers/document-source';

/**
 * Acceptance coverage for an imported web article across the subsystems a
 * reader actually uses.
 *
 * Nothing here stands in for the code under test. The import runs through the
 * real IPC channel, the snapshot is fetched through the real asset capability,
 * the reader is the real Markdown adapter, indexing is driven by the real
 * search store through the real IPC handlers into the real repository, the
 * annotation is produced by a real DOM selection and persisted through the real
 * annotation channel, the reading position is persisted by the real reader
 * store, and the AI context comes from the real context builder reading the
 * chunks that indexing actually wrote. The only substitutes are the ones a test
 * must have: the network transport is a local fixture, the renderer's `fetch`
 * resolves an asset handle the way main's protocol handler does, and the CSS
 * Custom Highlight registry is stubbed because jsdom has none. No provider is
 * contacted at any point.
 */

const ARTICLE_URL = 'https://example.com/posts/the-margin';
const SEARCH_TERM = 'marginalia';

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
    <p>Careful ${SEARCH_TERM} outlives the book it was written in, because a note
    in the margin records what one particular reader thought, on one particular
    afternoon, about one particular sentence.</p>
    <p>A third paragraph keeps the container clearly ahead of the page chrome,
    with more commas, more clauses, and enough length to matter.</p>
  </article>
  <footer>Copyright</footer>
</body></html>`;

class FixtureTransport implements WebArticleTransport {
  fetchArticleHtml(url: string): Promise<FetchedWebPage> {
    if (url !== ARTICLE_URL) {
      return Promise.reject(new InterleafError('validation', 'Interleaf could not reach that website.'));
    }
    return Promise.resolve({
      html: ARTICLE_HTML,
      finalUrl: ARTICLE_URL,
      transferredBytes: Buffer.byteLength(ARTICLE_HTML, 'utf8'),
    });
  }
}

class TestHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const RENDERER_SCOPE = 'renderer-acceptance-scope';

describe('web article subsystem acceptance', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: InterleafDatabase;
  let storage: StorageManager;
  let docRepo: DocumentRepository;
  let searchRepo: SearchRepository;
  let assetRegistry: AssetRegistry;
  let service: LibraryService;
  let container: HTMLElement;
  let scrolledInto: HTMLElement[];
  let highlightRegistry: Map<string, TestHighlight>;
  let handlers: Map<string, Parameters<IpcMainLike['handle']>[1]>;

  const originalFetch = globalThis.fetch;
  const originalCss = Reflect.get(window, 'CSS');
  const originalHighlight = Reflect.get(window, 'Highlight');
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalRangeRect: Range['getBoundingClientRect'] = Range.prototype.getBoundingClientRect;

  /**
   * The renderer holds an opaque handle, so resolving it has to go back through
   * the registry that issued it — the same capability check main's protocol
   * handler performs before it reads a byte.
   */
  function requestedUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
  }

  function assetFetch(input: RequestInfo | URL): Promise<Response> {
    const assetId = requestedUrl(input).replace('interleaf-media://', '');
    const asset = assetRegistry.resolveAsset(assetId, RENDERER_SCOPE);
    if (asset === null) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    const bytes = readFileSync(asset.canonicalPath);
    return Promise.resolve(
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    );
  }

  /** One IPC round trip, unwrapped exactly the way the preload bridge does. */
  async function invoke<T>(channel: IpcChannel, payload?: CloneableValue): Promise<T> {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Channel ${channel} is not registered.`);
    const indexHtmlPath = join(tempDir, 'index.html');
    const event = { senderFrame: { url: pathToFileURL(indexHtmlPath).href } };
    const envelope = (await handler(event, payload)) as IpcResultEnvelope<T>;
    if (!envelope.ok) {
      throw new InterleafError(envelope.error.code, envelope.error.message);
    }
    return envelope.data;
  }

  function installBridge(): void {
    const bridge = {
      library: {
        importWebArticle: (url: string, options?: DocumentImportOptions) =>
          invoke<WebArticleImportResult>('library:import-web-article', {
            url,
            ...(options !== undefined ? { options } : {}),
          }),
        openDocument: (id: string) => invoke<OpenedDocument>('library:open-document', { id }),
        updateReadingPosition: (documentId: string, location: DocumentLocation, progress: number) =>
          invoke<ReadingPosition>('library:update-reading-position', { documentId, location, progress }),
      },
      search: {
        beginIndex: (documentId: string, documentHash: string) =>
          invoke<IndexGeneration>('search:begin-index', { documentId, documentHash }),
        appendIndex: (
          documentId: string,
          documentHash: string,
          generationId: string,
          chunks: readonly SearchIndexChunkInput[]
        ) => invoke<DocumentIndexState>('search:append-index', { documentId, documentHash, generationId, chunks }),
        completeIndex: (documentId: string, documentHash: string, generationId: string) =>
          invoke<DocumentIndexState>('search:complete-index', { documentId, documentHash, generationId }),
        failIndex: (documentId: string, documentHash: string, generationId: string, errorMessage: string) =>
          invoke<DocumentIndexState>('search:fail-index', { documentId, documentHash, generationId, errorMessage }),
        getIndexState: (documentId: string) =>
          invoke<DocumentIndexState | null>('search:get-index-state', { documentId }),
        searchDocument: (documentId: string, query: string) =>
          invoke<readonly SearchHit[]>('search:document', { documentId, query }),
        resolveHit: (documentId: string, documentHash: string, chunkId: string, query: string) =>
          invoke<SearchMatchAnchor | null>('search:resolve-hit', { documentId, documentHash, chunkId, query }),
      },
      annotations: {
        create: (input: CreateAnnotationInput) => invoke<Annotation>('annotations:create', input),
        page: (documentId: string, filter?: AnnotationFilter) =>
          invoke<AnnotationPage>('annotations:page', { documentId, filter }),
      },
    };
    stubBridge(bridge);
  }

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'interleaf-web-subsystems-')));
    libraryDir = join(tempDir, 'library');
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    storage = new StorageManager(libraryDir, createLogger('library'));
    await storage.initialize();
    docRepo = new DocumentRepository(db);
    searchRepo = new SearchRepository(db);
    assetRegistry = new AssetRegistry([libraryDir]);
    const log = createLogger('library');
    service = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: new FolderRepository(db),
      readingPositions: new ReadingPositionRepository(db),
      assetRegistry,
      currentScopeId: () => RENDERER_SCOPE,
      log,
      webArticles: new WebArticleImportService({ media: new TestWebMediaTransport(), transport: new FixtureTransport(), log }),
      documentAssets: new DocumentAssetRepository(db),
    });

    handlers = new Map();
    const deps = makeIpcDeps({
      library: service,
      annotations: new AnnotationRepository(db),
      search: searchRepo,
      senderRule: createSenderRule({ indexHtmlPath: join(tempDir, 'index.html') }),
      log,
    });
    registerIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      deps
    );
    expect(handlers.size).toBe(IPC_CHANNELS.length);

    installBridge();
    globalThis.fetch = assetFetch;

    highlightRegistry = new Map<string, TestHighlight>();
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          set: (name: string, value: TestHighlight) => { highlightRegistry.set(name, value); },
          get: (name: string) => highlightRegistry.get(name),
          delete: (name: string) => highlightRegistry.delete(name),
          has: (name: string) => highlightRegistry.has(name),
        },
      },
    });
    Object.defineProperty(window, 'Highlight', { configurable: true, value: TestHighlight });

    scrolledInto = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewStub(this: HTMLElement): void {
      scrolledInto.push(this);
    };
    // jsdom has no layout engine. The reader asks a selection for its rectangle
    // only to place the popover, which nothing here asserts, so an empty rect is
    // the honest answer rather than an invented geometry.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }),
    });

    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    useSearchStore.getState().reset();
    useAnnotationStore.getState().reset();
    useReaderStore.setState({ session: null});
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalRangeRect,
    });
    Object.defineProperty(window, 'CSS', { configurable: true, value: originalCss });
    Object.defineProperty(window, 'Highlight', { configurable: true, value: originalHighlight });
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Imports the fixture article and mounts it in a real Markdown reader. */
  async function importAndOpen(): Promise<{
    readonly document: DocumentMetadata;
    readonly adapter: MarkdownAdapter;
  }> {
    const api = testBridge;
    const imported = await api.library.importWebArticle(ARTICLE_URL);
    const opened = await api.library.openDocument(imported.document.id);
    const adapter = new MarkdownAdapter();
    await adapter.open(container, testDocumentSource({
      documentId: opened.document.id,
      documentHash: opened.document.fileHash,
      assetUrl: opened.assetUrl,
    }));
    return { document: opened.document, adapter };
  }

  function blockElementContaining(root: HTMLElement, needle: string): HTMLElement {
    const blocks = root.querySelectorAll<HTMLElement>('[data-markdown-block]');
    for (const block of blocks) {
      if (block.textContent.includes(needle)) return block;
    }
    throw new Error(`No rendered block contains ${needle}.`);
  }

  function textNodeContaining(root: Node, needle: string): Text {
    const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker?.nextNode();
    while (node) {
      if (node instanceof Text && node.data.includes(needle)) return node;
      node = walker?.nextNode() ?? null;
    }
    throw new Error(`No text node contains ${needle}.`);
  }

  test('the snapshot renders in the real Markdown reader from its asset handle', async () => {
    const { document: doc, adapter } = await importAndOpen();

    expect(doc.format).toBe('markdown');
    expect(doc.source?.kind).toBe('web');
    expect(container.textContent).toContain('Why margins matter');
    expect(container.textContent).toContain(SEARCH_TERM);
    // The snapshot is inert: no image, script, or iframe reaches the reader.
    expect(container.querySelectorAll('img, script, iframe')).toHaveLength(0);

    await adapter.close();
  });

  test('production indexing makes the article searchable and search navigation reaches it', async () => {
    const { document: doc, adapter } = await importAndOpen();
    const api = testBridge;

    // Indexing is driven by the renderer's own store over the real channels;
    // nothing in this test writes to the search repository directly.
    await useSearchStore
      .getState()
      .indexDocument(doc, adapter, new AbortController().signal);

    const state = useSearchStore.getState().indexStates[doc.id];
    expect(state?.status).toBe('ready');
    expect(state?.documentHash).toBe(doc.fileHash);
    expect(state?.totalChunks ?? 0).toBeGreaterThan(0);

    const hits = await api.search.searchDocument(doc.id, SEARCH_TERM);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    if (!hit) throw new Error('Expected a search hit.');
    expect(hit.documentId).toBe(doc.id);
    expect(hit.excerpt.toLowerCase()).toContain(SEARCH_TERM);

    // The SearchPanel's navigation: resolve the hit, move the reader to it, and
    // paint the transient range.
    const anchor = await api.search.resolveHit(doc.id, doc.fileHash, hit.chunkId, SEARCH_TERM);
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    expect(anchor.queryTerms).toContain(SEARCH_TERM);
    expect(anchor.location.format).toBe('markdown');

    await adapter.goToLocation(anchor.location);
    const result = await adapter.applySearchHighlight({
      requestId: 1,
      documentId: doc.id,
      documentHash: doc.fileHash,
      query: SEARCH_TERM,
      location: anchor.location,
      anchor,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('applied');
    expect(result.rangeCount).toBeGreaterThan(0);
    expect(result.text?.toLowerCase()).toContain(SEARCH_TERM);
    // The reader actually moved to the block holding the term.
    if (anchor.location.format !== 'markdown') throw new Error('Expected a Markdown location.');
    const target = container.querySelector<HTMLElement>(
      `[data-markdown-block="${String(anchor.location.blockIndex)}"]`
    );
    expect(target?.textContent).toContain(SEARCH_TERM);
    expect(scrolledInto).toContain(target);

    await adapter.close();
  });

  test('a selection in the reader becomes an annotation that survives a reload and repaints', async () => {
    const { document: doc, adapter } = await importAndOpen();

    const captured: (ReaderSelection | null)[] = [];
    adapter.setSelectionChangeCallback((selection) => { captured.push(selection); });

    const block = blockElementContaining(container, SEARCH_TERM);
    const textNode = textNodeContaining(block, SEARCH_TERM);
    const start = textNode.data.indexOf('Careful');
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + `Careful ${SEARCH_TERM}`.length);
    const selection = document.getSelection();
    if (!selection) throw new Error('Document selection is unavailable.');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const readerSelection = captured[captured.length - 1] ?? null;
    expect(readerSelection).not.toBeNull();
    if (!readerSelection?.anchor) throw new Error('The reader produced no annotation anchor.');
    expect(readerSelection.selectedText).toBe(`Careful ${SEARCH_TERM}`);

    const created = await useAnnotationStore.getState().create({
      documentId: doc.id,
      type: 'highlight',
      color: 'yellow',
      selectedText: readerSelection.selectedText,
      anchor: readerSelection.anchor,
    });
    expect(created).not.toBeNull();
    expect(useAnnotationStore.getState().error).toBeNull();

    // Reload: a fresh reader over a fresh container, told nothing but the
    // document identity, has to find the annotation and repaint it.
    await adapter.close();
    useAnnotationStore.getState().reset();
    container.remove();
    container = document.createElement('div');
    document.body.append(container);

    const api = testBridge;
    const reopened = await api.library.openDocument(doc.id);
    const reloaded = new MarkdownAdapter();
    await reloaded.open(container, testDocumentSource({
      documentId: reopened.document.id,
      documentHash: reopened.document.fileHash,
      assetUrl: reopened.assetUrl,
    }));

    const scope: AnnotationAnchorScope | null = reloaded.getAnnotationScope();
    expect(scope).not.toBeNull();
    if (!scope) return;
    await useAnnotationStore.getState().load(doc.id, scope, reopened.document.fileHash);
    const loaded = useAnnotationStore.getState().annotations;
    expect(loaded.map((item) => item.id)).toEqual([created?.id]);

    const resolutions = await reloaded.setAnnotations(loaded);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.status).toBe('anchored');

    const painted = highlightRegistry.get('interleaf-yellow');
    expect(painted, 'the reloaded annotation must be painted').toBeDefined();
    expect(painted?.ranges.map((item) => item.toString())).toEqual([`Careful ${SEARCH_TERM}`]);

    await reloaded.close();
  });

  test('the reading position is persisted by the reader store and restored on reopen', async () => {
    const { document: doc, adapter } = await importAndOpen();
    const api = testBridge;

    // The reader store owns persistence; the adapter only reports movement.
    useReaderStore.setState({ session: testReaderSession(doc, { adapter })});
    adapter.setLocationChangeCallback((location, progress) => {
      useReaderStore.getState().onLocationUpdate(location, progress);
    });

    const target = blockElementContaining(container, SEARCH_TERM);
    const blockIndex = Number(target.dataset.markdownBlock);
    expect(Number.isInteger(blockIndex)).toBe(true);
    // An explicit navigation, the same call the outline and a search result use.
    await useReaderStore.getState().goToLocation({ format: 'markdown', blockIndex });
    await useReaderStore.getState().flushPendingReadingPosition();
    expect(scrolledInto).toContain(target);

    // Restart: new asset registry, new service, nothing carried over but the
    // database and the files on disk.
    await adapter.close();
    assetRegistry = new AssetRegistry([libraryDir]);
    const log = createLogger('library');
    service = new LibraryService({
      db,
      storage,
      documents: docRepo,
      folders: new FolderRepository(db),
      readingPositions: new ReadingPositionRepository(db),
      assetRegistry,
      currentScopeId: () => RENDERER_SCOPE,
      log,
      webArticles: new WebArticleImportService({ media: new TestWebMediaTransport(), transport: new FixtureTransport(), log }),
      documentAssets: new DocumentAssetRepository(db),
    });
    handlers = new Map();
    registerIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      makeIpcDeps({
        library: service,
        annotations: new AnnotationRepository(db),
        search: searchRepo,
        senderRule: createSenderRule({ indexHtmlPath: join(tempDir, 'index.html') }),
        log,
      })
    );

    const reopened = await api.library.openDocument(doc.id);
    expect(reopened.document.readingPosition?.location).toEqual(
      expect.objectContaining({ format: 'markdown', blockIndex })
    );

    // And the restored location is what the reader actually opens on.
    container.remove();
    container = document.createElement('div');
    document.body.append(container);
    scrolledInto = [];
    const restored = new MarkdownAdapter();
    await restored.open(container, testDocumentSource({
      documentId: reopened.document.id,
      documentHash: reopened.document.fileHash,
      assetUrl: reopened.assetUrl,
      ...(reopened.document.readingPosition
        ? { initialLocation: reopened.document.readingPosition.location }
        : {}),
    }));
    const restoredBlock = container.querySelector<HTMLElement>(
      `[data-markdown-block="${String(blockIndex)}"]`
    );
    expect(restoredBlock?.textContent).toContain(SEARCH_TERM);
    expect(scrolledInto).toContain(restoredBlock);

    await restored.close();
  });

  test('AI context is built from the indexed article without contacting a provider', async () => {
    const { document: doc, adapter } = await importAndOpen();
    await useSearchStore.getState().indexDocument(doc, adapter, new AbortController().signal);
    await adapter.close();

    const builder = new ChatContextBuilder(new AIContextRepository(db));
    const now = new Date().toISOString();
    const built = builder.build({
      session: {
        id: 'session-acceptance',
        documentId: doc.id,
        documentHash: doc.fileHash,
        providerId: 'fake',
        modelId: 'fake-local-model',
        title: 'Acceptance Session',
        reasoningEffort: null,
        messageCount: 0,
        previewText: null,
        isArchived: false,
        compactedThroughOrdinal: null,
        createdAt: now,
        updatedAt: now,
      },
      model: {
        id: 'fake-local-model',
        name: 'Fake Local Model',
        contextWindow: 32_000,
        maxOutputTokens: 2_048,
        supportsStreaming: true,
      },
      question: `What does the article say about ${SEARCH_TERM}?`,
      messages: [],
      contextItems: [],
    });

    expect(built.sources.length).toBeGreaterThan(0);
    // A phrase that exists only in the captured article body, so the context
    // can only have come from the chunks indexing actually wrote.
    expect(built.contextXml).toContain('outlives the book it was written in');
    expect(built.contextXml).toContain('The Margin');
    expect(built.estimatedInputTokens).toBeGreaterThan(0);
  });
});
