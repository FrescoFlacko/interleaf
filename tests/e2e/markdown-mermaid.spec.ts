import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureWindowPng,
  launchInterleaf,
  returnToLibrary,
  stubOpenDialog,
  type AppHandle,
} from './helpers';
import { choosePalette } from './listbox';

/**
 * Fenced `mermaid` diagrams in the real application.
 *
 * The unit suites already pin the source policy, the isolated renderer's
 * session, the output guard, and the reader's anchoring. What only a real
 * Electron run can show is the whole path at once: an offline renderer in its
 * own process, a drawing that arrives as an inert image, a document whose
 * blocks, search text, and stored annotation anchors did not move when the
 * pictures appeared, and a hostile source that produces neither script nor a
 * single request leaving the machine.
 */

/**
 * Evidence never lands in the repository.
 *
 * Screenshots from this spec are a record of a run, not a checked-in
 * reference, so they go where the run is collected — or to a temporary
 * directory — and the worktree stays clean either way.
 */
const SHOT_DIR = join(
  process.env.INTERLEAF_EVIDENCE_DIR === undefined || process.env.INTERLEAF_EVIDENCE_DIR.length === 0
    ? mkdtempSync(join(tmpdir(), 'interleaf-mermaid-evidence-'))
    : process.env.INTERLEAF_EVIDENCE_DIR,
  'mermaid'
);
mkdirSync(SHOT_DIR, { recursive: true });

function fence(source: string): string {
  return ['```mermaid', source, '```'].join('\n');
}

/** A long left-to-right chain, which is how a diagram outgrows the measure. */
const WIDE_SOURCE = `flowchart LR\n${Array.from(
  { length: 14 },
  (_unused, index) =>
    `  S${String(index)}[Stage ${String(index)} of the ingest pipeline] --> S${String(index + 1)}[Stage ${String(index + 1)} of the ingest pipeline]`
).join('\n')}`;

/**
 * A source that asks for every active feature Mermaid can be talked into: an
 * HTML label, a `javascript:` click, an external link target, and a directive
 * that tries to unlock the first three.
 */
const HOSTILE_SOURCE = `%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}} }%%
flowchart TD
  A["<img src=x onerror=alert(1)>"] --> B["plain label"]
  click A "javascript:alert(1)"
  click B href "https://evil.example/pixel.png" _blank`;

const DOCUMENT_BODY = `# Diagram Gallery

An introductory paragraph holding one unique searchable phrase for the indexer.

## Flowchart

${fence(`flowchart LR
  Ingest[Ingest document] --> Parse[Parse blocks]
  Parse --> Render[Render reader]
  Render --> Annotate[Annotate passage]`)}

## Sequence

${fence(`sequenceDiagram
  participant Reader
  participant Main
  Reader->>Main: request diagram
  Main-->>Reader: inert drawing`)}

## Class

${fence(`classDiagram
  class Document {
    +String identifier
    +open()
  }
  class Annotation {
    +String anchor
  }
  Document <|-- Annotation`)}

## State

${fence(`stateDiagram-v2
  [*] --> Closed
  Closed --> Open: open document
  Open --> Closed: return to library`)}

## Entity relationship

${fence(`erDiagram
  DOCUMENT ||--o{ ANNOTATION : carries
  DOCUMENT {
    string identifier
    string title
  }`)}

## Not a diagram

${fence(`totallyNotADiagramKeyword
  ??? --> !!!`)}

## Hostile

${fence(HOSTILE_SOURCE)}

## Wide

${fence(WIDE_SOURCE)}

## After the diagrams

A closing paragraph so the reader has ordinary text on both sides of the
illustrations.

\`\`\`js
const notADiagram = 'this fence keeps its ordinary treatment';
\`\`\`
`;

/**
 * The fences in document order.
 *
 * Addressed by position among the diagrams rather than by block index: the
 * block index counts every block in the document, and a spec that hard-codes
 * it would break the moment a paragraph is added to the fixture.
 */
const FIGURES = {
  flowchart: 0,
  sequence: 1,
  classDiagram: 2,
  state: 3,
  er: 4,
  invalid: 5,
  hostile: 6,
  wide: 7,
} as const;

let app: AppHandle;
let fixtureDir: string;
let documentPath: string;

/**
 * Records anything the isolated renderer's session actually sends.
 *
 * Deliberately `onBeforeSendHeaders` rather than `onBeforeRequest`: the
 * application owns the latter and uses it to cancel, and a test must not
 * displace the policy it is checking. A request that survives the block
 * reaches this event, so an empty (or file-only) record is evidence that
 * nothing left the machine.
 */
async function recordSandboxRequests(handle: AppHandle): Promise<void> {
  await handle.electronApp.evaluate(({ session }) => {
    const sandbox = session.fromPartition('mermaid-sandbox');
    const seen: string[] = [];
    (globalThis as { __mermaidRequests?: string[] }).__mermaidRequests = seen;
    sandbox.webRequest.onBeforeSendHeaders((details, callback) => {
      seen.push(details.url);
      callback({ cancel: false });
    });
  });
}

async function sandboxRequests(handle: AppHandle): Promise<readonly string[]> {
  return handle.electronApp.evaluate(
    () => (globalThis as { __mermaidRequests?: string[] }).__mermaidRequests ?? []
  );
}

/** Imports the gallery and opens it, answering the document's id. */
async function openGallery(): Promise<string> {
  await stubOpenDialog(app, [documentPath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const [document] = await app.window.evaluate(async () =>
    window.interleafAPI.library.listDocuments()
  );
  await app.window.getByTestId(`read-doc-${document!.id}`).click();
  await expect(app.window.getByTestId('reader-view')).toBeVisible();
  return document!.id;
}

function figure(ordinal: number) {
  return app.window.locator('figure.markdown-mermaid').nth(ordinal);
}

function diagram(ordinal: number) {
  return app.window.locator('[data-testid^="markdown-mermaid-diagram-"]').nth(ordinal);
}

function note(ordinal: number) {
  return app.window.locator('[data-testid^="markdown-mermaid-note-"]').nth(ordinal);
}

/** The colour the first diagram card is painted in. */
async function cardBackground(): Promise<string> {
  return diagram(0).evaluate((element) => window.getComputedStyle(element).backgroundColor);
}

/** The colour the page behind the diagrams is painted in. */
async function pageBackground(): Promise<string> {
  return app.window
    .getByTestId('markdown-content-wrapper')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor);
}

/** The drawing a figure is showing, decoded back to markup. */
async function drawnMarkup(index: number): Promise<string> {
  const source = await diagram(index).locator('img').getAttribute('src');
  expect(source).toMatch(/^data:image\/svg\+xml;base64,/u);
  return Buffer.from(source!.split(',')[1]!, 'base64').toString('utf8');
}

test.describe('Fenced mermaid diagrams', () => {
  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-mermaid-e2e-'));
    documentPath = join(fixtureDir, 'Diagram_Gallery.md');
    writeFileSync(documentPath, DOCUMENT_BODY, 'utf8');
    app = await launchInterleaf();
    await recordSandboxRequests(app);
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('draws the common diagram types offline as inert images beside their source', async () => {
    await openGallery();

    // The drawn token is one word because the renderer lays a label out across
    // `<tspan>` rows; the source phrase is the whole thing the author wrote.
    const expectations: readonly (readonly [number, string, string, string])[] = [
      [FIGURES.flowchart, 'Flowchart', 'Annotate', 'Ingest document'],
      [FIGURES.sequence, 'Sequence diagram', 'Reader', 'request diagram'],
      [FIGURES.classDiagram, 'Class diagram', 'Annotation', 'String anchor'],
      [FIGURES.state, 'State diagram', 'Closed', 'open document'],
      [FIGURES.er, 'Entity relationship diagram', 'ANNOTATION', 'string title'],
    ];

    for (const [index, kind, drawnToken, sourceText] of expectations) {
      const image = diagram(index).locator('img');
      await expect(image).toBeVisible({ timeout: 30_000 });
      await expect(image).toHaveAttribute('alt', `${kind}. The diagram source is shown below.`);
      // A drawing at a readable size, not a placeholder.
      const box = await image.boundingBox();
      expect(box!.width).toBeGreaterThan(80);
      expect(box!.height).toBeGreaterThan(30);
      // The labels the author wrote are in the picture, rendered as text.
      expect(await drawnMarkup(index)).toContain(drawnToken);
      // The fenced source is still on the page, unchanged.
      await expect(figure(index).locator('pre')).toContainText(sourceText);
    }

    // No drawing is ever inserted into the reader's own document, and an
    // ordinary fence keeps its ordinary treatment.
    const reader = app.window.getByTestId('markdown-content-wrapper');
    expect(await reader.locator('svg').count()).toBe(0);
    expect(await reader.locator('script').count()).toBe(0);
    await expect(reader).toContainText('this fence keeps its ordinary treatment');
    expect(await reader.locator('[data-testid^="markdown-mermaid-diagram-"]').count()).toBe(
      Object.keys(FIGURES).length
    );

    // Nothing was fetched from anywhere: the renderer is offline.
    for (const url of await sandboxRequests(app)) expect(url.startsWith('file://')).toBe(true);
  });

  test('shows the source and one sentence when a diagram cannot be drawn', async () => {
    await openGallery();

    await expect(note(FIGURES.invalid)).toBeVisible({ timeout: 30_000 });
    await expect(note(FIGURES.invalid)).toHaveText(/\./u);
    await expect(diagram(FIGURES.invalid)).toBeHidden();
    await expect(figure(FIGURES.invalid).locator('pre')).toContainText('totallyNotADiagramKeyword');

    // One undrawable diagram does not cost the document or its neighbours.
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible();
    await expect(diagram(FIGURES.wide).locator('img')).toBeVisible();
    await expect(
      app.window.getByTestId('markdown-content-wrapper').getByRole('heading', { level: 1, name: 'Diagram Gallery' })
    ).toBeVisible();
  });

  test('neutralizes an HTML label, a javascript: click, and an external target', async () => {
    await openGallery();

    await expect(figure(FIGURES.hostile)).toBeVisible();
    // Either outcome is safe: a drawing with the active parts removed, or the
    // fail-closed fallback to the source. Both are asserted the same way.
    const settled = async (): Promise<'drawn' | 'explained' | 'pending'> => {
      if ((await diagram(FIGURES.hostile).locator('img').count()) === 1) return 'drawn';
      if (await note(FIGURES.hostile).isVisible()) return 'explained';
      return 'pending';
    };
    await expect.poll(settled, { timeout: 30_000 }).not.toBe('pending');

    if ((await diagram(FIGURES.hostile).locator('img').count()) === 1) {
      const markup = await drawnMarkup(FIGURES.hostile);
      expect(markup).not.toMatch(/<script|<foreignObject|javascript:|onerror/iu);
      expect(markup).not.toContain('evil.example');
      expect(markup).not.toMatch(/<a[\s>]/u);
    }

    // The reader's document never carries the active forms either, and the
    // hostile directive did not unlock anything: nothing was requested.
    const reader = app.window.getByTestId('markdown-content-wrapper');
    expect(await reader.locator('script').count()).toBe(0);
    expect(await reader.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await reader.locator('img[onerror]').count()).toBe(0);
    expect(await reader.locator('svg').count()).toBe(0);
    for (const url of await sandboxRequests(app)) {
      expect(url).not.toContain('evil.example');
      expect(url.startsWith('file://')).toBe(true);
    }
    // A dialog from an executed label would have blocked the run; the page is
    // still answering, which is the observable form of "nothing ran".
    expect(await app.window.evaluate(() => document.readyState)).toBe('complete');
  });

  test('scrolls an oversized diagram locally and reaches it from the keyboard', async () => {
    await openGallery();
    const region = diagram(FIGURES.wide);
    await expect(region.locator('img')).toBeVisible({ timeout: 30_000 });

    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region).toHaveAttribute('role', 'region');
    await expect(region).toHaveAttribute('aria-label', /scrollable$/u);

    const scroller = app.window.getByTestId('markdown-scroll-container');
    const documentTopBefore = await scroller.evaluate((element) => element.scrollTop);
    const moved = await region.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return { left: element.scrollLeft, overflow: element.scrollWidth - element.clientWidth };
    });
    expect(moved.overflow).toBeGreaterThan(0);
    expect(moved.left).toBeGreaterThan(0);
    // Only the diagram moved; the document stayed where the reader left it.
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(documentTopBefore);

    // A diagram that fits is not a tab stop announcing scrolling it cannot do.
    await expect(diagram(FIGURES.sequence)).not.toHaveAttribute('tabindex', '0');
  });

  test('leaves block indexes, search text, and annotation anchors where they were', async () => {
    const documentId = await openGallery();
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible({ timeout: 30_000 });

    // Exactly one block element per index, with the figure standing in for the
    // fence rather than doubling it.
    const blocks = await app.window.evaluate(() => {
      const elements = [...document.querySelectorAll('[data-markdown-block]')];
      const indexes = elements.map((element) => element.getAttribute('data-markdown-block'));
      return { total: indexes.length, distinct: new Set(indexes).size };
    });
    expect(blocks.distinct).toBe(blocks.total);

    await expect
      .poll(async () =>
        app.window.evaluate(
          async (id) => (await window.interleafAPI.search.getIndexState(id))?.status,
          documentId
        )
      )
      .toBe('ready');

    // The diagram source is still the document's text: it is searchable, and
    // so is the prose around it.
    const prose = await app.window.evaluate(
      async (id) => window.interleafAPI.search.searchDocument(id, 'unique searchable phrase'),
      documentId
    );
    expect(prose.length).toBeGreaterThan(0);
    const inSource = await app.window.evaluate(
      async (id) => window.interleafAPI.search.searchDocument(id, 'Ingest document'),
      documentId
    );
    expect(inSource.length).toBeGreaterThan(0);

    // A highlight over the fenced source resolves again after a reopen, which
    // only an anchor that still means what it meant can do.
    const selected = await app.window.evaluate(() => {
      const first = document.querySelector('figure.markdown-mermaid')!;
      const text = first.querySelector('.markdown-block-content')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 12);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    });
    expect(selected.length).toBeGreaterThan(0);

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect
      .poll(async () =>
        app.window.evaluate(
          async (id) => (await window.interleafAPI.annotations.list(id)).length,
          documentId
        )
      )
      .toBe(1);

    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () =>
        app.window.evaluate(async (id) => {
          const [annotation] = await window.interleafAPI.annotations.list(id);
          return annotation!.status;
        }, documentId)
      )
      .toBe('anchored');
  });

  test('a close mid-render leaves nothing behind and a reopen draws once', async () => {
    const documentId = await openGallery();

    // Straight back out while the diagrams are still being drawn: the results
    // in flight belong to a reader that no longer exists.
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    expect(await app.window.locator('[data-testid^="markdown-mermaid-"]').count()).toBe(0);

    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible({ timeout: 30_000 });

    // One picture per figure, in the document that is actually open.
    expect(await app.window.locator('.markdown-mermaid-image').count()).toBeLessThanOrEqual(
      Object.keys(FIGURES).length
    );
    expect(await diagram(FIGURES.flowchart).locator('img').count()).toBe(1);
    // The reader is intact: no error surface, and the text still reads.
    await expect(
      app.window.getByTestId('markdown-content-wrapper').getByRole('heading', { level: 1, name: 'Diagram Gallery' })
    ).toBeVisible();
    expect(await app.window.getByTestId('reader-error').count()).toBe(0);
  });

  test('stays readable in a light and a dark surface, at 200% zoom, at the minimum window', async () => {
    await openGallery();
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible({ timeout: 30_000 });
    const light = await drawnMarkup(FIGURES.flowchart);
    const lightCard = await cardBackground();
    const lightPage = await pageBackground();
    await captureWindowPng(app, join(SHOT_DIR, 'diagrams-light.png'));

    // A dark palette takes the diagram card dark with it, and the card is the
    // surface a drawing is actually read against.
    await choosePalette(app.window, 'midnight');
    await expect
      .poll(async () => cardBackground(), { timeout: 10_000 })
      .not.toBe(lightCard);
    // The drawing is redrawn for the new surface rather than left dark-on-dark.
    await expect.poll(async () => drawnMarkup(FIGURES.flowchart), { timeout: 30_000 }).not.toBe(light);
    // Captured only once the crossfade has finished, so the evidence is of a
    // settled reader rather than a frame in the middle of a transition.
    await expect.poll(async () => pageBackground(), { timeout: 10_000 }).not.toBe(lightPage);
    await app.window.waitForFunction(
      () =>
        document.getAnimations().every((animation) => animation.playState !== 'running'),
      undefined,
      { timeout: 10_000 }
    );
    await captureWindowPng(app, join(SHOT_DIR, 'diagrams-dark.png'));

    const window200 = await app.electronApp.browserWindow(app.window);
    await window200.evaluate((win) => {
      win.webContents.setZoomFactor(2);
    });
    await expect(diagram(FIGURES.flowchart).locator('img')).toBeVisible();
    await captureWindowPng(app, join(SHOT_DIR, 'diagrams-zoom-200.png'));
    await window200.evaluate((win) => {
      win.webContents.setZoomFactor(1);
    });

    // The minimum window the application allows: the diagram box has to stay
    // inside the reading column and scroll rather than push the layout open.
    await window200.evaluate((win) => {
      win.setSize(960, 600);
    });
    await expect(diagram(FIGURES.wide).locator('img')).toBeVisible();
    const fits = await app.window.evaluate((ordinal) => {
      const region = document.querySelectorAll('[data-testid^="markdown-mermaid-diagram-"]')[ordinal]!;
      const scroller = document.querySelector('[data-testid="markdown-scroll-container"]')!;
      return {
        regionRight: Math.round(region.getBoundingClientRect().right),
        scrollerRight: Math.round(scroller.getBoundingClientRect().right),
        documentOverflow: scroller.scrollWidth - scroller.clientWidth,
      };
    }, FIGURES.wide);
    expect(fits.regionRight).toBeLessThanOrEqual(fits.scrollerRight + 1);
    expect(fits.documentOverflow).toBeLessThanOrEqual(1);
    await captureWindowPng(app, join(SHOT_DIR, 'diagrams-minimum-window.png'));
  });
});
