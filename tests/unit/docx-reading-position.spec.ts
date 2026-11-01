// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocxAdapter } from '../../src/renderer/features/reader/adapters/docx-adapter';
import { parseDocxArchive, type ParsedDocxPayload } from '../../src/renderer/features/reader/adapters/docx-parse-core';
import { makeDocxFixture } from '../fixtures/document-fixtures';
import { testDocumentSource } from '../helpers/document-source';

/**
 * The reading position a scroll reports belongs to the page under the reading
 * probe (one third down the viewport). A paragraph can overflow its page and
 * still measure at the probe while the next page paints over it; that hidden
 * overflow must not win, or the reader settles on page 10 and reports page 9.
 *
 * The geometry here is the one measured in the real app after a jump to page
 * 10: scroller top 99, height 774 (probe 357), previous page [-981, 75] with
 * an overflowing paragraph at [352.1875, 378.578125], target page [99, 1155]
 * with its paragraph at [334.9375, 361.328125] — same height, both under the
 * probe. jsdom has no layout, so each element reports that measured rectangle.
 */

const parse = (bytes: Uint8Array): Promise<ParsedDocxPayload> => Promise.resolve(parseDocxArchive(bytes));

type Box = readonly [top: number, bottom: number];

function place(element: Element, [top, bottom]: Box): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 800, bottom - top));
}

let container: HTMLElement;
let adapter: DocxAdapter;

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { callback(0); return 1; });
  // jsdom has no caret hit-testing; no character offset is found at the probe.
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => null });
  container = document.createElement('div');
  document.body.appendChild(container);
  adapter = new DocxAdapter(parse);
  await adapter.open(container, testDocumentSource({
    documentId: 'docx-reading-position',
    assetUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${makeDocxFixture({ includeImage: false, extraParagraphs: 60 }).toString('base64')}`,
  }));
  await adapter.goToPage(2);
});

afterEach(async () => {
  await adapter.close();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scroller(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="docx-scroll-container"]')!;
}

function page(number: number): { readonly wrapper: HTMLElement; readonly paragraphs: HTMLElement[] } {
  const wrapper = container.querySelector<HTMLElement>(`[data-testid="docx-page-${String(number)}"]`)!;
  return { wrapper, paragraphs: [...wrapper.querySelectorAll<HTMLElement>('[data-docx-paragraph]')] };
}

/** Lays out the scroller and two pages as measured, then lets the scroll report where the reader is. */
function settle(layout: { readonly first: Box; readonly second: Box; readonly firstParagraphs: (index: number, count: number) => Box; readonly secondParagraphs: (index: number) => Box }): void {
  const view = scroller();
  place(view, [99, 873]);
  Object.defineProperty(view, 'clientHeight', { configurable: true, value: 774 });
  const first = page(1);
  const second = page(2);
  place(first.wrapper, layout.first);
  place(second.wrapper, layout.second);
  first.paragraphs.forEach((element, index) => { place(element, layout.firstParagraphs(index, first.paragraphs.length)); });
  second.paragraphs.forEach((element, index) => { place(element, layout.secondParagraphs(index)); });
  // Any other rendered page lies well below the viewport.
  for (const wrapper of view.querySelectorAll<HTMLElement>('[data-docx-page]')) {
    if (wrapper === first.wrapper || wrapper === second.wrapper) continue;
    const below = 10_000 + Number(wrapper.dataset.docxPage) * 1_100;
    place(wrapper, [below, below + 1_056]);
    for (const element of wrapper.querySelectorAll('[data-docx-paragraph]')) place(element, rowOf(below + 10));
  }
  view.dispatchEvent(new Event('scroll'));
}

const rowOf = (top: number): Box => [top, top + 26.390625];
const overflowAtProbe: Box = [352.1875, 378.578125];
const targetAtProbe: Box = [334.9375, 361.328125];

describe('DOCX reading position after a scroll', () => {
  it('has both pages rendered with paragraphs to measure', () => {
    expect(page(1).paragraphs.length).toBeGreaterThan(1);
    expect(page(2).paragraphs.length).toBeGreaterThan(1);
  });

  it('reports the page under the probe, not a previous page whose hidden overflow ties with it', () => {
    settle({
      first: [-981, 75],
      second: [99, 1155],
      firstParagraphs: (index, count) => (index === count - 1 ? overflowAtProbe : rowOf(-960 + index * 10)),
      secondParagraphs: (index) => (index === 0 ? targetAtProbe : rowOf(400 + index * 30)),
    });
    expect(adapter.getCurrentPage()).toBe(2);
    const location = adapter.getReadingLocation().location;
    expect(location.format === 'docx' ? location.paragraphIndex : -1).toBe(Number(page(2).paragraphs[0]!.dataset.docxParagraph));
  });

  it('reports the first page while the probe is on it', () => {
    settle({
      first: [99, 1155],
      second: [1179, 2235],
      firstParagraphs: (index) => (index === 3 ? targetAtProbe : rowOf(500 + index * 30)),
      secondParagraphs: (index) => rowOf(1200 + index * 30),
    });
    expect(adapter.getCurrentPage()).toBe(1);
  });

  it('reports the nearest paragraph, as before, when the probe falls in the gap between two pages', () => {
    settle({
      first: [-700, 350],
      second: [370, 1426],
      firstParagraphs: (index, count) => (index === count - 1 ? rowOf(320) : rowOf(-690 + index * 10)),
      secondParagraphs: (index) => rowOf(380 + index * 30),
    });
    expect(adapter.getCurrentPage()).toBe(1);
  });

  it('keeps reporting a long paragraph that overflows its page where no page box is under the probe', () => {
    const overflowing = (): HTMLElement => page(1).paragraphs.at(-1)!;
    settle({
      first: [-30_000, -28_944],
      second: [13_200, 14_256],
      firstParagraphs: (index, count) => (index === count - 1 ? [-29_000, 13_100] : rowOf(-29_990 + index * 10)),
      secondParagraphs: (index) => rowOf(13_210 + index * 30),
    });
    expect(adapter.getCurrentPage()).toBe(1);
    const location = adapter.getReadingLocation().location;
    expect(location.format === 'docx' ? location.paragraphIndex : -1).toBe(Number(overflowing().dataset.docxParagraph));
  });

  it('reports the last page when the scroller ends with the probe below it', () => {
    settle({
      first: [-1800, -744],
      second: [-720, 300],
      firstParagraphs: (index) => rowOf(-1790 + index * 10),
      secondParagraphs: (index) => rowOf(-700 + index * 10),
    });
    expect(adapter.getCurrentPage()).toBe(2);
  });
});
