import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launchInterleaf, type AppHandle } from './helpers';

const ARTICLE_URL = 'https://example.com/modern-microprocessors';

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Understanding Modern Microprocessors</title>
  <meta name="author" content="Dr. Jane Doe">
  <meta property="og:site_name" content="Computer Architecture Journal">
</head>
<body>
  <header>
    <nav><a href="/">Home</a> · <a href="/archive">Archive</a></nav>
  </header>
  <article>
    <h1>Understanding Modern Microprocessors</h1>
    <p class="byline">By Dr. Jane Doe</p>
    <p>Modern microprocessors employ sophisticated branch prediction, out-of-order execution, and multi-level caching to achieve high performance while conserving energy.</p>
    <h2>Branch Prediction Mechanisms</h2>
    <p>Predicting the outcome of conditional branches before they are evaluated allows instruction pipelines to remain full, minimizing pipeline bubbles and stalls.</p>
    <blockquote>
      <p>Accurate branch prediction is the single most critical factor in superscalar efficiency.</p>
    </blockquote>
    <h3>Key Architectural Strategies</h3>
    <ul>
      <li>Static branch prediction based on branch direction</li>
      <li>Two-level adaptive branch predictors with global history</li>
      <li>Neural and perceptron-based branch predictors</li>
    </ul>
    <p>For official microarchitecture whitepapers, consult <a href="https://example.com/whitepapers">the technical repository</a>.</p>
  </article>
  <footer>
    <p>© 2026 Computer Architecture Journal. All rights reserved.</p>
  </footer>
</body>
</html>`;

/**
 * Exactly the longest site name the extractor will ever hand the library
 * (`MAX_ARTICLE_SITE_NAME_LENGTH`). A page declares `og:site_name` freely, so
 * the library layout has to hold at that boundary rather than only for the
 * short names a well-behaved publisher happens to use.
 */
const LONG_SITE_NAME =
  'The Extraordinarily Verbose Quarterly Review of Distributed Systems, Compilers and Adjacent Engineering Practices Weekly';

const LONG_SITE_URL = 'https://example.com/verbose-publisher/essay';

const LONG_SITE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Notes on Layout Under Pressure</title>
  <meta property="og:site_name" content="${LONG_SITE_NAME}">
</head>
<body>
  <article>
    <h1>Notes on Layout Under Pressure</h1>
    <p>A library card has to survive metadata it did not choose, including a publisher name far longer than any column reserved for it.</p>
    <p>Truncation is the contract: the full name stays available to assistive technology and the pointer tooltip, while the painted badge stays inside the card that owns it.</p>
  </article>
</body>
</html>`;

/** The comparison case: an ordinary short publisher name in the same layout. */
const SHORT_SITE_NAME = 'Tiny Press';

const SHORT_SITE_URL = 'https://example.com/tiny-press/note';

const SHORT_SITE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>A Short Note</title>
  <meta property="og:site_name" content="${SHORT_SITE_NAME}">
</head>
<body>
  <article>
    <h1>A Short Note</h1>
    <p>A modest publisher name occupies the same badge slot as an immodest one, which makes this document the baseline that the long name is measured against.</p>
    <p>Reader View needs a real article to work with, so this note carries enough prose to be extracted rather than dismissed as boilerplate around an empty page.</p>
    <p>The layout question is narrow: two rows differing only in how many characters the publisher put in its own name should differ in width by no more than the badge is allowed to occupy.</p>
    <p>Everything else on the row — the format chip, the title, the progress, size, and date columns — is identical between the two, which is what makes the comparison meaningful.</p>
  </article>
</body>
</html>`;

type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
};

type ElementMetrics = {
  readonly box: Box;
  readonly scrollWidth: number;
  readonly clientWidth: number;
};

type ClipMetrics = {
  readonly box: Box;
  readonly overflowX: string;
  readonly textOverflow: string;
  readonly whiteSpace: string;
  readonly overflowingBy: number;
};

type ContainmentReport = {
  readonly badge: ElementMetrics;
  readonly container: ElementMetrics;
  readonly clip: ClipMetrics | null;
  readonly badgeText: string;
  readonly viewportWidth: number;
};

/**
 * Reads the painted geometry of the provenance badge and of the surface that
 * owns it, plus the element that actually truncates the name.
 *
 * All of it comes from one evaluation so the rectangles describe the same
 * frame. The clipping element is found by behaviour rather than by class name:
 * whichever element in the badge is styled to end in an ellipsis is the one
 * responsible for keeping a long name inside the box. `scrollWidth` is a
 * containment signal only for the surfaces that do not clip; on the truncating
 * element itself it reports the unpainted text and is recorded, not asserted.
 */
async function measureBadgeContainment(
  app: AppHandle,
  containerTestId: string,
  badgeTestId: string
): Promise<ContainmentReport> {
  return await app.window.evaluate(
    ({ containerId, badgeId }) => {
      const boxOf = (element: HTMLElement): Box => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
        };
      };
      const read = (element: HTMLElement): ElementMetrics => ({
        box: boxOf(element),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      });
      const container = document.querySelector<HTMLElement>(`[data-testid="${containerId}"]`);
      if (!container) throw new Error(`No element for data-testid="${containerId}"`);
      const badge = container.querySelector<HTMLElement>(`[data-testid="${badgeId}"]`);
      if (!badge) throw new Error(`No badge for data-testid="${badgeId}" inside ${containerId}`);

      const candidates = [badge, ...badge.querySelectorAll<HTMLElement>('*')];
      const truncating = candidates.find(
        (element) => window.getComputedStyle(element).textOverflow === 'ellipsis'
      );
      const clip: ClipMetrics | null =
        truncating === undefined
          ? null
          : (() => {
              const style = window.getComputedStyle(truncating);
              return {
                box: boxOf(truncating),
                overflowX: style.overflowX,
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
                overflowingBy: truncating.scrollWidth - truncating.clientWidth,
              };
            })();

      return {
        badge: read(badge),
        container: read(container),
        clip,
        badgeText: badge.textContent,
        viewportWidth: window.innerWidth,
      };
    },
    { containerId: containerTestId, badgeId: badgeTestId }
  );
}

/** Sub-pixel rounding is ordinary; a badge that escapes its card misses by more than a pixel. */
const CONTAINMENT_TOLERANCE_PX = 1;

/**
 * The actual containment claim: the badge is painted, it stays inside the
 * surface that owns it, it stays inside the viewport, and it absorbs the long
 * name by truncating rather than by growing or spilling.
 */
function expectBadgeContained(label: string, report: ContainmentReport, maxBadgeWidth: number): void {
  const { badge, container } = report;
  expect(badge.box.width, `${label}: badge is painted`).toBeGreaterThan(0);
  expect(badge.box.left, `${label}: badge left inside container`).toBeGreaterThanOrEqual(
    container.box.left - CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.right, `${label}: badge right inside container`).toBeLessThanOrEqual(
    container.box.right + CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.top, `${label}: badge top inside container`).toBeGreaterThanOrEqual(
    container.box.top - CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.bottom, `${label}: badge bottom inside container`).toBeLessThanOrEqual(
    container.box.bottom + CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.left, `${label}: badge inside viewport (left)`).toBeGreaterThanOrEqual(
    -CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.right, `${label}: badge inside viewport (right)`).toBeLessThanOrEqual(
    report.viewportWidth + CONTAINMENT_TOLERANCE_PX
  );
  expect(badge.box.width, `${label}: badge stays within its declared bound`).toBeLessThanOrEqual(
    maxBadgeWidth + CONTAINMENT_TOLERANCE_PX
  );
  expect(report.badgeText, `${label}: full site name remains in the accessible name`).toContain(
    LONG_SITE_NAME
  );

  // A 120-character name cannot fit any of these badges, so containment holds
  // only because something clips it. Prove that element exists, that it is the
  // one under pressure, and that its own box is inside the badge.
  const { clip } = report;
  expect(clip, `${label}: the name is truncated by a real clipping box`).not.toBeNull();
  expect(clip!.overflowX, `${label}: clipping box hides the overflow`).toBe('hidden');
  expect(clip!.textOverflow, `${label}: clipping box ends in an ellipsis`).toBe('ellipsis');
  expect(clip!.whiteSpace, `${label}: clipped name stays on one line`).toBe('nowrap');
  expect(clip!.overflowingBy, `${label}: the long name really is longer than its box`).toBeGreaterThan(0);
  expect(clip!.box.right, `${label}: clipping box inside badge`).toBeLessThanOrEqual(
    badge.box.right + CONTAINMENT_TOLERANCE_PX
  );
  expect(clip!.box.left, `${label}: clipping box inside badge`).toBeGreaterThanOrEqual(
    badge.box.left - CONTAINMENT_TOLERANCE_PX
  );

}

type AttributionReport = {
  readonly attribution: { readonly left: number; readonly right: number; readonly width: number };
  readonly card: { readonly left: number; readonly right: number };
  readonly overflowingBy: number;
  readonly textOverflow: string;
  readonly text: string;
  readonly viewportWidth: number;
};

/**
 * The generated cover's attribution line is where a web article names its site
 * now that the grid card carries no badge. It faces the same pressure the badge
 * did — a publisher-supplied name of any length — so it is measured the same
 * way: painted inside the card it belongs to, truncated by a real clipping box.
 */
async function measureCoverAttribution(app: AppHandle, docId: string): Promise<AttributionReport> {
  return await app.window.evaluate((id) => {
    const card = document.querySelector<HTMLElement>(`[data-testid="document-card-${id}"]`);
    const cover = document.querySelector<HTMLElement>(`[data-testid="generated-cover-${id}"]`);
    if (!card || !cover) throw new Error(`No generated cover for ${id}`);
    const attribution = cover.lastElementChild;
    if (!(attribution instanceof HTMLElement)) throw new Error(`No attribution line for ${id}`);
    const attributionRect = attribution.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      attribution: { left: attributionRect.left, right: attributionRect.right, width: attributionRect.width },
      card: { left: cardRect.left, right: cardRect.right },
      overflowingBy: attribution.scrollWidth - attribution.clientWidth,
      textOverflow: window.getComputedStyle(attribution).textOverflow,
      text: attribution.textContent,
      viewportWidth: window.innerWidth,
    };
  }, docId);
}

function expectAttributionContained(label: string, report: AttributionReport): void {
  const { attribution, card } = report;
  expect(attribution.width, `${label}: attribution is painted`).toBeGreaterThan(0);
  expect(attribution.left, `${label}: attribution inside the card`).toBeGreaterThanOrEqual(
    card.left - CONTAINMENT_TOLERANCE_PX
  );
  expect(attribution.right, `${label}: attribution inside the card`).toBeLessThanOrEqual(
    card.right + CONTAINMENT_TOLERANCE_PX
  );
  expect(attribution.right, `${label}: attribution inside viewport`).toBeLessThanOrEqual(
    report.viewportWidth + CONTAINMENT_TOLERANCE_PX
  );
  // A 120-character name cannot fit the cover, so containment holds only
  // because the line clips it.
  expect(report.textOverflow, `${label}: attribution ends in an ellipsis`).toBe('ellipsis');
  expect(report.overflowingBy, `${label}: the long name really overflows its box`).toBeGreaterThan(
    0
  );
  expect(report.text, `${label}: the full site name is still rendered`).toContain(LONG_SITE_NAME);
}

/** Horizontal overflow of a surface, in CSS pixels. */
async function readOverflow(
  app: AppHandle,
  containerTestId: string
): Promise<{ scrollWidth: number; clientWidth: number }> {
  return await app.window.evaluate((containerId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${containerId}"]`);
    if (!element) throw new Error(`No element for data-testid="${containerId}"`);
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  }, containerTestId);
}

/** Fails if a surface has to scroll sideways to show what the badge put in it. */
async function expectNoHorizontalOverflow(
  app: AppHandle,
  containerTestId: string,
  label: string
): Promise<void> {
  const metrics = await readOverflow(app, containerTestId);
  expect(metrics.scrollWidth, `${label}: no horizontal overflow`).toBeLessThanOrEqual(
    metrics.clientWidth + CONTAINMENT_TOLERANCE_PX
  );
}

/**
 * The list row already packs fixed-width columns that do not all fit a narrow
 * window, which is true of every document and has nothing to do with where one
 * came from. What this work must not do is let the row's width grow with a
 * publisher's chosen name, so the claim is a comparison: a 120-character name
 * costs no more row width than the badge's own cap.
 */
async function expectRowWidthIndependentOfSiteName(
  app: AppHandle,
  label: string,
  longDocId: string,
  shortDocId: string,
  badgeCapPx: number
): Promise<void> {
  const longRow = await readOverflow(app, `document-row-${longDocId}`);
  const shortRow = await readOverflow(app, `document-row-${shortDocId}`);
  expect(
    longRow.scrollWidth - shortRow.scrollWidth,
    `${label}: long site name costs no more than the badge cap`
  ).toBeLessThanOrEqual(badgeCapPx + CONTAINMENT_TOLERANCE_PX);
}

/** Registers one fixture page for the main-process test transport. */
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

/** Drives the real import UI end to end and returns the created document id. */
async function importArticleThroughUi(app: AppHandle, url: string): Promise<string> {
  await app.window.getByTestId('import-options-button').click();
  await expect(app.window.getByTestId('library-import-menu')).toBeVisible();
  await app.window.getByTestId('import-from-web-item').click();
  const modal = app.window.getByTestId('import-web-article-modal');
  await expect(modal).toBeVisible();
  await app.window.getByTestId('web-article-url-input').fill(url);
  await app.window.getByTestId('submit-web-article-button').click();
  await expect(modal).toBeHidden();
  const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
  const imported = documents.find((candidate) => candidate.source?.url === url);
  expect(imported, `imported document for ${url}`).toBeDefined();
  return imported!.id;
}

/** Puts the surface under test on screen so a window capture actually shows it. */
async function scrollIntoView(app: AppHandle, testId: string): Promise<void> {
  await app.window.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.scrollIntoView({ block: 'center' });
  }, testId);
  await app.window.waitForTimeout(200);
}

async function setWindowSize(app: AppHandle, width: number, height: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, size: { width: number; height: number }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await app.window.waitForTimeout(300);
}

async function setZoomFactor(app: AppHandle, factor: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, value: number) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value);
  }, factor);
  await app.window.waitForTimeout(300);
}

test.describe('Web Article Import End-to-End Workflow', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('imports web article, attributes its site on the generated cover, and reads via markdown reader', async () => {
    // 1. Register the fixture for the test transport in the main process
    await app.electronApp.evaluate(
      ({}, payload: { url: string; html: string }) => {
        const scope = globalThis as {
          __interleafWebArticleFixtures?: Record<string, { html: string; finalUrl?: string }>;
        };
        scope.__interleafWebArticleFixtures ??= {};
        scope.__interleafWebArticleFixtures[payload.url] = { html: payload.html, finalUrl: payload.url };
      },
      { url: ARTICLE_URL, html: ARTICLE_HTML }
    );

    // 2. Open import web article modal via the dropzone / action menu
    const optionsButton = app.window.getByTestId('import-options-button');
    await optionsButton.click();
    const menu = app.window.getByTestId('library-import-menu');
    await expect(menu).toBeVisible();

    // Click "From web URL…" to open the modal
    await app.window.getByTestId('import-from-web-item').click();

    const modal = app.window.getByTestId('import-web-article-modal');
    await expect(modal).toBeVisible();

    // 3. Fill in the article URL and submit
    const urlInput = app.window.getByTestId('web-article-url-input');
    await urlInput.fill(ARTICLE_URL);
    await app.window.getByTestId('submit-web-article-button').click();

    // 4. Verify modal closes on success
    await expect(modal).toBeHidden();

    // 5. Verify the new document appears in the library with web provenance
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(documents).toHaveLength(1);
    const doc = documents[0]!;
    expect(doc.format).toBe('markdown');
    expect(doc.source?.kind).toBe('web');
    expect(doc.source?.url).toBe(ARTICLE_URL);

    // 6. Verify the library card carries provenance on the generated cover
    // rather than an emblem badge, which the grid no longer shows.
    const card = app.window.getByTestId(`document-card-${doc.id}`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId(`source-badge-${doc.id}`)).toHaveCount(0);
    const generatedCover = card.getByTestId(`generated-cover-${doc.id}`);
    await expect(generatedCover).toBeVisible();
    await expect(generatedCover).toContainText('Web article');
    await expect(generatedCover).toContainText('Computer Architecture Journal');

    // 6a. Switch to list view and verify provenance badge layout
    await app.window.getByTestId('list-view-toggle').click();
    const listItem = app.window.getByTestId(`document-row-${doc.id}`);
    await expect(listItem).toBeVisible();
    const listBadge = listItem.getByTestId(`source-badge-${doc.id}`);
    await expect(listBadge).toBeVisible();
    await expect(listBadge).toContainText('Computer Architecture Journal');
    await app.window.getByTestId('grid-view-toggle').click();
    await expect(card).toBeVisible();

    // 7. Click the document card to open in the Markdown reader
    await card.click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // The header no longer carries a format badge; the Markdown content
    // wrapper below is the evidence that the article opened as Markdown.

    // 8. Verify the extracted article content in Markdown reader
    const content = app.window.getByTestId('markdown-content-wrapper');
    await expect(content).toBeVisible();
    await expect(content.getByRole('heading', { level: 1, name: 'Understanding Modern Microprocessors' }).first()).toBeVisible();
    await expect(content.getByRole('heading', { level: 2, name: 'Branch Prediction Mechanisms' })).toBeVisible();
    await expect(content.getByRole('heading', { level: 3, name: 'Key Architectural Strategies' })).toBeVisible();
    await expect(content.getByText('Modern microprocessors employ sophisticated branch prediction')).toBeVisible();
  });

  test('a 120-character site name stays contained at narrow width and 200% zoom', async () => {
    expect(LONG_SITE_NAME).toHaveLength(120);
    await registerArticleFixture(app, SHORT_SITE_URL, SHORT_SITE_HTML);
    await registerArticleFixture(app, LONG_SITE_URL, LONG_SITE_HTML);
    const shortDocId = await importArticleThroughUi(app, SHORT_SITE_URL);
    const docId = await importArticleThroughUi(app, LONG_SITE_URL);

    // The whole name is stored and rendered; only its painted width is bounded.
    const stored = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(stored.find((doc) => doc.id === docId)?.source?.siteName).toBe(LONG_SITE_NAME);

    const card = app.window.getByTestId(`document-card-${docId}`);
    await expect(card).toBeVisible();

    // The grid card shows no provenance badge at all now, so what has to hold
    // the long name is the generated cover's own attribution line.
    await expect(card.getByTestId(`source-badge-${docId}`)).toHaveCount(0);
    const gridDefault = await measureCoverAttribution(app, docId);
    expectAttributionContained('grid card at default width', gridDefault);

    // Narrow window: one grid column, so the card is as tight as the layout gets.
    await setWindowSize(app, 720, 540);
    const gridNarrow = await measureCoverAttribution(app, docId);
    expectAttributionContained('grid card at 720px', gridNarrow);
    await expectNoHorizontalOverflow(app, 'document-grid', 'grid at 720px');

    // 200% zoom halves the usable CSS width again. The window grows taller only
    // so a whole card fits; width — the dimension under test — stays at 720.
    await setWindowSize(app, 720, 900);
    await setZoomFactor(app, 2.0);
    await scrollIntoView(app, `generated-cover-${docId}`);
    const gridZoomed = await measureCoverAttribution(app, docId);
    expect(gridZoomed.viewportWidth, 'zoom halves the CSS viewport').toBeLessThan(
      gridNarrow.viewportWidth
    );
    expectAttributionContained('grid card at 200% zoom', gridZoomed);
    await expectNoHorizontalOverflow(app, 'document-grid', 'grid at 200% zoom');

    // The list row packs the badge against fixed-width columns, so it gets the
    // same treatment at both pressures.
    await setZoomFactor(app, 1.0);
    await app.window.getByTestId('list-view-toggle').click();
    const row = app.window.getByTestId(`document-row-${docId}`);
    await expect(row).toBeVisible();
    const rowNarrow = await measureBadgeContainment(app, `document-row-${docId}`, `source-badge-${docId}`);
    expectBadgeContained('list row at 720px', rowNarrow, 140);
    await expectRowWidthIndependentOfSiteName(app, 'list row at 720px', docId, shortDocId, 140);

    await setZoomFactor(app, 2.0);
    await scrollIntoView(app, `source-badge-${docId}`);
    const rowZoomed = await measureBadgeContainment(app, `document-row-${docId}`, `source-badge-${docId}`);
    expectBadgeContained('list row at 200% zoom', rowZoomed, 140);
    await expectRowWidthIndependentOfSiteName(app, 'list row at 200% zoom', docId, shortDocId, 140);

    await setZoomFactor(app, 1.0);
    await setWindowSize(app, 1200, 800);
    await app.window.getByTestId('grid-view-toggle').click();
  });
});
