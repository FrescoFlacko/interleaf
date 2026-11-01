import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Inputs whose `makePdfFixture` bytes are frozen in `pdf-fixture-bytes.spec.ts`:
 * the default, a small fixture using every option with non-ASCII, astral and
 * lone-surrogate text, a normal 50-page book, and the agent-book case's exact
 * 6,000-page book.
 */
export const PDF_FIXTURE_CASES: readonly (readonly [string, () => Buffer])[] = [
  ['default', () => makePdfFixture()],
  ['every option, non-ASCII', () => makePdfFixture({
    title: 'Café (漢字) \\ 😀',
    author: 'Zoë',
    pages: ['Hello world', 'Ünïcödé 漢字 text', 'Astral 😀 and ABC', 'bad \uD800 surrogate'],
    pageStartPositions: [[72, 720], [80, 700], [90, 690], [72, 600]],
    outline: [{ title: 'One (first)', targetPage: 1 }, { title: 'Zwei ü', targetPage: 3 }],
    mediaBox: [0, 0, 595, 842],
    pageRotations: [0, 90, 180, 270],
    rtlPages: [2],
    ligaturePages: [3],
    markedContentPages: [1],
    links: [
      { pageNumber: 1, rect: [72, 700, 200, 720], url: 'https://example.invalid/a(b)' },
      { pageNumber: 2, rect: [72, 600, 200, 620], targetPage: 4, destMode: 'FitH' },
      { pageNumber: 3, rect: [72, 500, 200, 520], targetPage: 1, destCoords: [10, 20] },
    ],
  })],
  ['normal 50 pages', () => makePdfFixture({
    title: 'Normal Book', author: 'Interleaf',
    pageLines: Array.from({ length: 50 }, (_unused, index) => [`Line one of page ${String(index + 1)}.`, 'Line two.']),
  })],
  ['agent-book 6000 pages', () => makePdfFixture({
    title: 'Agent Long Book', author: 'Interleaf',
    pageLines: Array.from({ length: 6_000 }, (_unused, index) => [`Long book page ${String(index + 1)} text.`]),
  })],
];
