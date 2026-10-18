import { expect, test } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchInterleaf, returnToLibrary, type AppHandle } from './helpers';
import {
  ASTRA_ALT_TEXT,
  ASTRA_ARCHIVED_IMAGE_URLS,
  ASTRA_ARTICLE_URL,
  ASTRA_CAPTIONS,
  ASTRA_EXCLUDED_IMAGE_URLS,
  ASTRA_LINKED_CELL,
  ASTRA_TABLES,
  astraArticleHtml,
  astraMediaFixtures,
} from '../fixtures/astra-article-fixture';

/**
 * The rich web-article capture, driven through the real application.
 *
 * Everything here runs against local fixtures registered on the main-process
 * test seam; no test in this file resolves a hostname or opens a socket, and
 * the article it uses is an invented stand-in rather than the page that
 * motivated the feature. What the fixtures cannot fake is the part under test:
 * the extraction worker, the admission checks, managed storage, the capability
 * protocol, and the reader all run exactly as they ship.
 */

/** The installed axe bundle, injected into the window rather than bundled. */
const AXE_SOURCE = join(process.cwd(), 'node_modules/axe-core/axe.min.js');

/** Images the reader is expected to paint, one per archived source. */
const EXPECTED_IMAGE_COUNT = ASTRA_ARCHIVED_IMAGE_URLS.length;

type ImageState = {
  readonly src: string;
  readonly alt: string;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
};

type TableState = {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly headerCellTags: readonly string[];
  readonly wrapperOverflowX: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly tabIndex: number;
  readonly role: string | null;
  readonly ariaLabel: string | null;
};

async function registerArticleFixture(app: AppHandle, url: string, html: string): Promise<void> {
  await app.electronApp.evaluate(
    ({}, payload: { url: string; html: string }) => {
      const scope = globalThis as {
        __interleafWebArticleFixtures?: Record<string, { html: string; finalUrl?: string }>;
      };
      scope.__interleafWebArticleFixtures ??= {};
      scope.__interleafWebArticleFixtures[payload.url] = { html: payload.html, finalUrl: payload.url };
    },
    { url, html }
  );
}

/** Registers the fixture image bytes the media transport will admit. */
async function registerMediaFixtures(
  app: AppHandle,
  media: Record<string, { base64: string; contentType: string }>
): Promise<void> {
  await app.electronApp.evaluate(
    ({}, payload: Record<string, { base64: string; contentType: string }>) => {
      globalThis.__interleafWebMediaFixtures = { ...payload };
    },
    media
  );
}

async function importArticleThroughUi(app: AppHandle, url: string): Promise<string> {
  await app.window.getByTestId('import-options-button').click();
  await expect(app.window.getByTestId('library-import-menu')).toBeVisible();
  await app.window.getByTestId('import-from-web-item').click();
  const modal = app.window.getByTestId('import-web-article-modal');
  await expect(modal).toBeVisible();
  await app.window.getByTestId('web-article-url-input').fill(url);
  await app.window.getByTestId('submit-web-article-button').click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
  const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
  const imported = documents.find((candidate) => candidate.source?.url === url);
  expect(imported, `imported document for ${url}`).toBeDefined();
  return imported!.id;
}

async function openInReader(app: AppHandle, documentId: string): Promise<void> {
  const open = app.window.getByTestId(`read-doc-${documentId}`);
  await expect(open).toBeVisible();
  await open.click();
  await expect(app.window.getByTestId('reader-view')).toBeVisible();
  await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
}

/** Returns to the library so the next open issues a fresh capability set. */
async function backToLibrary(app: AppHandle): Promise<void> {
  await returnToLibrary(app);
  await expect(app.window.getByTestId('reader-view')).toBeHidden();
}

/**
 * Every painted article image, with whatever the compositor actually decoded.
 *
 * `naturalWidth` is the claim that matters: an element with a capability URL
 * that failed to load still reports its `src`, so only decoded pixels prove the
 * protocol handler served real bytes out of managed storage.
 */
async function readImages(app: AppHandle): Promise<readonly ImageState[]> {
  await app.window.waitForFunction(() => {
    const images = [...document.querySelectorAll('img.markdown-image')];
    return images.length > 0 && images.every((img) => (img as HTMLImageElement).complete);
  });
  return await app.window.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('img.markdown-image')].map((img) => ({
      src: img.getAttribute('src') ?? '',
      alt: img.getAttribute('alt') ?? '',
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    }))
  );
}

async function readTables(app: AppHandle): Promise<readonly TableState[]> {
  return await app.window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="markdown-table-"]')].map((wrapper) => {
      const table = wrapper.querySelector('table');
      const text = (cell: Element): string => cell.textContent.replace(/\s+/g, ' ').trim();
      return {
        headers: [...(table?.querySelectorAll('thead th') ?? [])].map(text),
        rows: [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) =>
          [...row.querySelectorAll('td')].map(text)
        ),
        headerCellTags: [...(table?.querySelectorAll('thead tr > *') ?? [])].map((cell) => cell.tagName),
        wrapperOverflowX: window.getComputedStyle(wrapper).overflowX,
        scrollWidth: wrapper.scrollWidth,
        clientWidth: wrapper.clientWidth,
        tabIndex: wrapper.tabIndex,
        role: wrapper.getAttribute('role'),
        ariaLabel: wrapper.getAttribute('aria-label'),
      };
    })
  );
}

/**
 * Proves the first overflowing table can be scrolled sideways from the
 * keyboard alone.
 *
 * A `overflow-x: auto` box is scrolled by the arrow keys only once it holds
 * focus, and only a real layout engine can say whether it does, so this is the
 * check that has to live out here rather than in a jsdom unit test.
 */
async function assertKeyboardScrolling(app: AppHandle): Promise<void> {
  const table = app.window.locator('[data-testid^="markdown-table-"]').first();
  await table.focus();
  expect(
    await table.evaluate((element) => document.activeElement === element),
    'the table takes focus'
  ).toBe(true);

  for (let press = 0; press < 8; press += 1) await app.window.keyboard.press('ArrowRight');
  await app.window.waitForTimeout(300);
  const scrolled = await table.evaluate((element) => element.scrollLeft);
  expect(scrolled, 'the arrow keys scroll the focused table sideways').toBeGreaterThan(0);

  for (let press = 0; press < 12; press += 1) await app.window.keyboard.press('ArrowLeft');
  await app.window.waitForTimeout(300);
  expect(
    await table.evaluate((element) => element.scrollLeft),
    'the arrow keys scroll it back'
  ).toBe(0);
}

async function setWindowSize(app: AppHandle, width: number, height: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, size: { width: number; height: number }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await app.window.waitForTimeout(400);
}

async function setZoomFactor(app: AppHandle, factor: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, value: number) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value);
  }, factor);
  await app.window.waitForTimeout(400);
}

/**
 * Watches for any renderer request that would leave the machine.
 *
 * The reader is only allowed `interleaf-media:` and its own bundle. A single
 * http(s) request from a captured article would mean the snapshot kept a remote
 * URL, which is the failure this whole design exists to prevent.
 */
function watchRemoteRequests(app: AppHandle): { readonly urls: string[] } {
  const urls: string[] = [];
  app.window.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http://') || url.startsWith('https://')) urls.push(url);
  });
  return { urls };
}

/**
 * Runs axe over the rendered article itself.
 *
 * Scoped to the content wrapper on purpose: the surrounding shell is covered by
 * its own accessibility tests, and what is new here is the markup the capture
 * produces — table semantics, header association, and image descriptions.
 */
async function articleViolations(app: AppHandle): Promise<readonly AxeRunViolation[]> {
  // Injected as an evaluated expression rather than a `<script>` tag: the app's
  // own CSP forbids inline script, and that restriction is worth keeping intact
  // while the audit runs against the real page.
  await app.window.evaluate(`(() => { ${readFileSync(AXE_SOURCE, 'utf8')} })()`);
  return await app.window.evaluate(async () => {
    const results = await window.axe.run('[data-testid="markdown-content-wrapper"]', {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes }));
  });
}

/** Text of the whole rendered article, as the reader paints it. */
async function readerText(app: AppHandle): Promise<string> {
  return await app.window.evaluate(
    () => document.querySelector('[data-testid="markdown-content-wrapper"]')?.textContent ?? ''
  );
}

test.describe('Rich web-article capture', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('captures tables and editorial images, and paints them from managed storage', async () => {
    const remote = watchRemoteRequests(app);
    await registerArticleFixture(app, ASTRA_ARTICLE_URL, astraArticleHtml());
    await registerMediaFixtures(app, astraMediaFixtures());

    const documentId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);
    await openInReader(app, documentId);

    // Tables: both variants survive, seven columns wide, in source order.
    const tables = await readTables(app);
    expect(tables).toHaveLength(ASTRA_TABLES.length);
    for (const [index, expected] of ASTRA_TABLES.entries()) {
      const actual = tables[index]!;
      expect(actual.headers, `table ${String(index)} headers`).toEqual([...expected.headers]);
      expect(actual.rows, `table ${String(index)} rows`).toHaveLength(expected.rows.length);
      for (const [rowIndex, row] of expected.rows.entries()) {
        expect(actual.rows[rowIndex], `table ${String(index)} row ${String(rowIndex)}`).toEqual([...row]);
      }
      // Header cells are `th`, which is what names the columns for a screen
      // reader — including the table the page marked up with bold `td`s only.
      expect(new Set(actual.headerCellTags), `table ${String(index)} header cells`).toEqual(new Set(['TH']));
    }
    // The cell containing a literal pipe kept its character and its column.
    expect(tables[1]?.rows[2]?.at(-1)).toBe('Scanned pages | mixed scripts');

    // A link inside a cell survives, marked external and announced actionable.
    const linkedText =
      ASTRA_TABLES[ASTRA_LINKED_CELL.table]?.rows[ASTRA_LINKED_CELL.row]?.[ASTRA_LINKED_CELL.column];
    const cellLink = app.window.locator('td a[data-external-link="true"]').first();
    await expect(cellLink).toHaveText(linkedText!);
    await expect(cellLink).toHaveAttribute('href', ASTRA_LINKED_CELL.href);
    await expect(cellLink).not.toHaveAttribute('aria-disabled');

    // Images: one per archived source, each served through a capability URL and
    // each actually decoded from bytes on disk.
    const images = await readImages(app);
    expect(images).toHaveLength(EXPECTED_IMAGE_COUNT);
    for (const image of images) {
      expect(image.src, 'archived images load through an opaque capability').toMatch(
        /^interleaf-media:\/\//
      );
      expect(image.naturalWidth, `decoded pixels for ${image.alt}`).toBeGreaterThan(0);
      expect(image.naturalHeight, `decoded pixels for ${image.alt}`).toBeGreaterThan(0);
      expect(image.alt.length, 'every archived image keeps its description').toBeGreaterThan(0);
    }
    expect(images.map((image) => image.alt)).toContain(ASTRA_ALT_TEXT.comparison);

    // Captions survive, including for the material that was deliberately not
    // archived: the video and the interactive embed are gone, their meaning is not.
    const text = await readerText(app);
    expect(text).toContain(ASTRA_CAPTIONS.comparison);
    expect(text).toContain(ASTRA_CAPTIONS.video);
    expect(text).toContain(ASTRA_CAPTIONS.interactive);

    // Nothing excluded reached the page, and no remote URL survived anywhere in it.
    const html = await app.window.evaluate(
      () => document.querySelector('[data-testid="markdown-content-wrapper"]')?.innerHTML ?? ''
    );
    for (const excluded of ASTRA_EXCLUDED_IMAGE_URLS) {
      expect(html, `${excluded} must not reach the reader`).not.toContain(excluded);
    }
    expect(html).not.toContain('cdn.example.com');
    expect(html).not.toContain('interleaf-asset:');
    expect(await app.window.locator('img[src^="http"]').count()).toBe(0);
    expect(remote.urls, 'the reader made no outbound request').toEqual([]);

    // The new markup is announced, not merely painted: header cells are `th`,
    // every image carries a description, and axe finds nothing wrong with the
    // article region as a whole.
    for (const [index, table] of tables.entries()) {
      expect(table.headerCellTags, `table ${String(index)} uses header cells`).toEqual(
        Array.from({ length: 7 }, () => 'TH')
      );
    }
    expect(await articleViolations(app)).toEqual([]);
  });

  test('keeps tables reachable at a narrow width and 200% zoom', async () => {
    await registerArticleFixture(app, ASTRA_ARTICLE_URL, astraArticleHtml());
    await registerMediaFixtures(app, astraMediaFixtures());
    const documentId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);
    await openInReader(app, documentId);

    await setWindowSize(app, 720, 900);
    const narrow = await readTables(app);
    for (const [index, table] of narrow.entries()) {
      expect(table.wrapperOverflowX, `table ${String(index)} scrolls itself at 720px`).toBe('auto');
      // Seven columns cannot fit a 720px window, so the table really is wider
      // than its box — which is what makes the scroller load-bearing rather
      // than decorative.
      expect(table.scrollWidth, `table ${String(index)} overflows at 720px`).toBeGreaterThan(
        table.clientWidth
      );
      expect(table.headers, `table ${String(index)} keeps every column at 720px`).toHaveLength(7);
      // A scroller only a pointer can reach hides half the table from everyone
      // else, so an overflowing one is a focusable, named region.
      expect(table.tabIndex, `table ${String(index)} is a tab stop at 720px`).toBe(0);
      expect(table.role, `table ${String(index)} is a region at 720px`).toBe('region');
      expect(table.ariaLabel, `table ${String(index)} is named at 720px`).toMatch(
        /scrollable horizontally$/
      );
    }
    await assertKeyboardScrolling(app);
    // The article itself does not scroll sideways; only the tables do.
    const pageOverflow = await app.window.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
      return { scrollWidth: wrapper?.scrollWidth ?? 0, clientWidth: wrapper?.clientWidth ?? 0 };
    });
    expect(pageOverflow.scrollWidth).toBeLessThanOrEqual(pageOverflow.clientWidth + 1);

    await setZoomFactor(app, 2);
    const zoomed = await readTables(app);
    expect(zoomed).toHaveLength(ASTRA_TABLES.length);
    for (const [index, table] of zoomed.entries()) {
      expect(table.wrapperOverflowX, `table ${String(index)} scrolls itself at 200%`).toBe('auto');
      expect(table.scrollWidth, `table ${String(index)} overflows at 200%`).toBeGreaterThan(
        table.clientWidth
      );
      expect(table.headers, `table ${String(index)} keeps every column at 200%`).toHaveLength(7);
      expect(table.rows[0], `table ${String(index)} keeps its data at 200%`).toHaveLength(7);
    }
    // Images stay inside the reading column rather than forcing the page wide.
    const overflowingImages = await app.window.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
      const limit = wrapper?.getBoundingClientRect().right ?? 0;
      return [...document.querySelectorAll<HTMLImageElement>('img.markdown-image')].filter(
        (img) => img.getBoundingClientRect().right > limit + 1
      ).length;
    });
    expect(overflowingImages, 'no image escapes the reading column at 200%').toBe(0);

    await setZoomFactor(app, 1);
    await setWindowSize(app, 1200, 800);
  });

  test('reopens with its images after a restart with no fixtures registered', async () => {
    await registerArticleFixture(app, ASTRA_ARTICLE_URL, astraArticleHtml());
    await registerMediaFixtures(app, astraMediaFixtures());
    const documentId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);
    await openInReader(app, documentId);
    expect(await readImages(app)).toHaveLength(EXPECTED_IMAGE_COUNT);

    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });

    // The relaunched app registers no page and no image fixture, so its only
    // transports would have to reach the network — and the test seam's registry
    // is empty, so nothing can answer. Whatever the reader paints now came off
    // this machine's disk.
    app = await launchInterleaf({ userDataDir, testSeam: true });
    const remote = watchRemoteRequests(app);
    const registered = await app.electronApp.evaluate(() => {
      return Object.keys(globalThis.__interleafWebMediaFixtures ?? {}).length;
    });
    expect(registered, 'the restarted app knows no image fixtures').toBe(0);

    await openInReader(app, documentId);
    const images = await readImages(app);
    expect(images).toHaveLength(EXPECTED_IMAGE_COUNT);
    for (const image of images) {
      expect(image.src).toMatch(/^interleaf-media:\/\//);
      expect(image.naturalWidth, `offline pixels for ${image.alt}`).toBeGreaterThan(0);
    }
    const tables = await readTables(app);
    expect(tables).toHaveLength(ASTRA_TABLES.length);
    expect(tables[0]?.headers).toHaveLength(7);
    expect(remote.urls, 'reopening a captured article touches no network').toEqual([]);

    // A second open issues a fresh capability set; the stale ones are gone.
    const firstUrls = images.map((image) => image.src);
    await backToLibrary(app);
    await openInReader(app, documentId);
    const reopened = await readImages(app);
    expect(reopened.map((image) => image.src)).not.toEqual(firstUrls);
    for (const image of reopened) expect(image.naturalWidth).toBeGreaterThan(0);
  });

  test('re-importing the same URL upgrades the capture and keeps its annotations', async () => {
    await registerArticleFixture(app, ASTRA_ARTICLE_URL, astraArticleHtml());
    await registerMediaFixtures(app, astraMediaFixtures());
    const documentId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);

    const annotationId = await app.window.evaluate(async (id: string) => {
      const created = await window.interleafAPI.annotations.create({
        documentId: id,
        type: 'note',
        anchor: {
          format: 'markdown',
          blockIndex: 0,
          quote: { exact: 'Astra', prefix: '', suffix: '' },
        },
        selectedText: 'Astra',
        note: 'Check the long-context number against the harness.',
      });
      return created.id;
    }, documentId);

    const before = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    const capturedBefore = before.find((doc) => doc.id === documentId)?.source?.capturedAt;
    expect(capturedBefore).toBeDefined();

    // The publisher edits the page. Same URL, different bytes.
    await app.window.waitForTimeout(1100);
    await registerArticleFixture(
      app,
      ASTRA_ARTICLE_URL,
      astraArticleHtml().replace('<h2>Availability</h2>', '<h2>Availability and pricing</h2>')
    );
    const reimportedId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);

    expect(reimportedId, 'the existing row is upgraded, not duplicated').toBe(documentId);
    const after = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(after).toHaveLength(before.length);
    expect(after.find((doc) => doc.id === documentId)?.source?.capturedAt).not.toBe(capturedBefore);

    const annotations = await app.window.evaluate(
      async (id: string) => window.interleafAPI.annotations.list(id),
      documentId
    );
    expect(annotations.map((annotation) => annotation.id)).toContain(annotationId);

    await openInReader(app, documentId);
    expect(await readerText(app)).toContain('Availability and pricing');
    const images = await readImages(app);
    expect(images).toHaveLength(EXPECTED_IMAGE_COUNT);
    for (const image of images) expect(image.naturalWidth).toBeGreaterThan(0);
    expect((await readTables(app))[0]?.headers).toHaveLength(7);
  });

  test('keeps search, annotation anchoring, and AI context working over the captured tables', async () => {
    await registerArticleFixture(app, ASTRA_ARTICLE_URL, astraArticleHtml());
    await registerMediaFixtures(app, astraMediaFixtures());
    const documentId = await importArticleThroughUi(app, ASTRA_ARTICLE_URL);
    await openInReader(app, documentId);

    // The reader indexes the article it painted. That index is also what the
    // AI context is drawn from, so it has to carry the benchmark numbers now
    // that they live in tables, and it must never carry a per-open capability.
    await expect
      .poll(
        async () =>
          app.window.evaluate(
            async (id: string) =>
              (await window.interleafAPI.search.getIndexState(id))?.status ?? 'missing',
            documentId
          ),
        { timeout: 30_000 }
      )
      .toBe('ready');

    // Table cell text is ordinary searchable prose through the real panel.
    await app.window.getByRole('tab', { name: 'Search' }).click();
    const panel = app.window.getByTestId('search-panel');
    await panel.getByLabel('Search indexed text').fill('Long-context recall');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(
      panel.getByRole('list', { name: 'Search results' }).getByRole('listitem').first()
    ).toBeVisible();

    const hits = await app.window.evaluate(async (id: string) => {
      const search = async (query: string): Promise<readonly string[]> =>
        (await window.interleafAPI.search.searchDocument(id, query)).map((hit) => hit.excerpt);
      return {
        escapedPipe: await search('Scanned pages'),
        linkedCell: await search('Tool use'),
        prose: await search('Reviewers preferred'),
      };
    }, documentId);
    expect(hits.escapedPipe.length, 'a cell containing a pipe is indexed').toBeGreaterThan(0);
    expect(hits.linkedCell.length, 'a linked cell is indexed').toBeGreaterThan(0);
    expect(hits.prose.length, 'a figure caption is indexed').toBeGreaterThan(0);
    for (const excerpt of [...hits.escapedPipe, ...hits.linkedCell, ...hits.prose]) {
      expect(excerpt, 'no expiring capability reaches the index').not.toContain('interleaf-media:');
    }

    // An annotation anchored in a table block round-trips through main.
    const stored = await app.window.evaluate(async (id: string) => {
      const created = await window.interleafAPI.annotations.create({
        documentId: id,
        type: 'highlight',
        anchor: {
          format: 'markdown',
          blockIndex: 4,
          quote: { exact: 'Graduate reasoning', prefix: '', suffix: '' },
        },
        selectedText: 'Graduate reasoning',
        color: 'yellow',
      });
      const list = await window.interleafAPI.annotations.list(id);
      return { createdId: created.id, ids: list.map((annotation) => annotation.id) };
    }, documentId);
    expect(stored.ids).toContain(stored.createdId);
  });
});
