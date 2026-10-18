import { describe, expect, it, vi } from 'vitest';
import type { TableOfContentsItem } from '@shared/types/document';
import type { PdfDestinationMember } from '../../src/renderer/features/reader/adapters/pdf-link-service';
import type { PdfTextContentEntry } from '../../src/renderer/features/reader/adapters/pdf-text-space';
import { mapPdfOutline, type PdfOutlineDocument, type PdfOutlineNode } from '../../src/renderer/features/reader/adapters/pdf-outline';
import { deriveTocContextRange, tocContextUnavailableMessage } from '../../src/renderer/features/reader/toc-context-range';

const PAGE_COUNT = 400;

/**
 * The destination shapes recorded from the reported document (`gebbdoom.pdf`).
 * Most outline entries name a destination that the document's name tree
 * resolves to a page reference; `section.2.3` ("Hidden improvements") and
 * `section.2.4` ("Sound System") name destinations the document does not
 * define at all, which is what used to be shown as page 1.
 */
const NAMED_DESTINATIONS: Readonly<Record<string, readonly PdfDestinationMember[]>> = {
  'section.2.2': [{ num: 230, gen: 0 }, { name: 'XYZ' }, 72, 594, null],
  'subsection.2.3.1': [{ num: 301, gen: 0 }, { name: 'XYZ' }, 72, 247.195, null],
  'subsection.2.4.2': [{ num: 339, gen: 0 }, { name: 'XYZ' }, 72, 206.242, null],
  'section.2.5': [{ num: 358, gen: 0 }, { name: 'XYZ' }, 72, 310.368, null],
};

const PAGE_INDEX_BY_REF: Readonly<Record<number, number>> = {
  230: 55,
  301: 59,
  339: 66,
  358: 70,
};

/**
 * Page text as the book actually reads around these two sections, recorded from
 * the same document. Every page of a section repeats its title in the running
 * header, so the page a section *starts* on is the first page in the interval
 * whose text mentions it — which is what the recovery pass relies on, and why
 * it also has to check the page before the interval.
 */
const PAGE_TEXT: Readonly<Record<number, string>> = {
  55: '2.2 Video System CHAPTER 2. IBM PC 2.2 Video System At first glance the video output system',
  56: 'CHAPTER 2. IBM PC 2.2 Video System Figure 2.25: notice how the first pixel is stored in bank',
  57: '2.2 Video System CHAPTER 2. IBM PC Figure 2.26: another difficulty came from the differing',
  58: 'CHAPTER 2. IBM PC 2.3 Hidden improvements Figure 2.28 shows how the same framebuffer',
  59: '2.3 Hidden improvements CHAPTER 2. IBM PC Despite its simple interface, Windows 3.1 640x480',
  60: 'CHAPTER 2. IBM PC 2.3 Hidden improvements One optimization among many others was to leverage',
  61: '2.3 Hidden improvements CHAPTER 2. IBM PC 2.3.2 VL-Bus As much as the video card manufacturers',
  62: 'CHAPTER 2. IBM PC 2.3 Hidden improvements VESA VL-Bus Figure 2.32: VL-Bus a.k.a VESA Local Bus',
  63: '2.3 Hidden improvements CHAPTER 2. IBM PC were introduced. This was a recipe for compatibility',
  64: 'CHAPTER 2. IBM PC 2.3 Hidden improvements 65',
  65: '2.4 Sound System CHAPTER 2. IBM PC 2.4 Sound System PCs were equipped with a PC speaker',
  66: 'CHAPTER 2. IBM PC 2.4 Sound System were made but consumers remained deaf to the melody',
  67: '2.4 Sound System CHAPTER 2. IBM PC The Gravis UltraSound Pro 1.2 SIMM slots allowing up to',
  70: 'CHAPTER 2. IBM PC 2.5 Network The modem was the first way two players could meet',
};

/** One text run as pdf.js reports it; only its string matters here. */
function textItem(str: string): PdfTextContentEntry {
  return { str, dir: 'ltr', transform: [], width: 0, height: 0, fontName: '', hasEOL: false };
}

function recordedDocument(pageText: Readonly<Record<number, string>> = PAGE_TEXT): PdfOutlineDocument {
  return {
    getDestination: vi.fn(async (name: string) => {
      await Promise.resolve();
      return NAMED_DESTINATIONS[name] ?? null;
    }),
    getPageIndex: vi.fn(async (ref: Parameters<PdfOutlineDocument['getPageIndex']>[0]) => {
      await Promise.resolve();
      const pageIndex = PAGE_INDEX_BY_REF[ref.num];
      if (pageIndex === undefined) throw new Error('Ref is not a page reference');
      return pageIndex;
    }),
    getPage: vi.fn(async (pageNumber: number) => {
      await Promise.resolve();
      const text = pageText[pageNumber - 1] ?? '';
      return {
        getTextContent: () => Promise.resolve({ items: text.split(' ').map((str) => textItem(str)) }),
      };
    }),
  } as PdfOutlineDocument;
}

/** The reported fragment of the book's outline, in document order. */
const RECORDED_OUTLINE: readonly PdfOutlineNode[] = [
  { title: 'Video System', dest: 'section.2.2' },
  { title: 'Hidden improvements', dest: 'section.2.3', items: [{ title: 'VGA Chip manufacturers', dest: 'subsection.2.3.1' }] },
  { title: 'Sound System', dest: 'section.2.4', items: [{ title: 'Gravis UltraSound', dest: 'subsection.2.4.2' }] },
  { title: 'Network', dest: 'section.2.5' },
];

/** The page an entry points at, for the PDF locations this suite produces. */
function pageIndexOf(item: TableOfContentsItem): number | null {
  return item.location?.format === 'pdf' ? item.location.pageIndex : null;
}

function byTitle(items: readonly TableOfContentsItem[], title: string): TableOfContentsItem {
  const found = items.find((item) => item.title === title);
  if (!found) throw new Error(`No outline entry titled ${title}`);
  return found;
}

describe('PDF outline destination resolution', () => {
  it('resolves reference destinations to their real page and never falls back to page 1', async () => {
    const items = await mapPdfOutline(recordedDocument(), RECORDED_OUTLINE, PAGE_COUNT);

    expect(byTitle(items, 'Video System').location).toEqual({ format: 'pdf', pageIndex: 55 });
    expect(byTitle(items, 'Network').location).toEqual({ format: 'pdf', pageIndex: 70 });

    // The reported defect: both of these used to report page 1. Their named
    // destinations are still missing from the document, so the page comes from
    // the bounded search of the pages their resolved neighbours enclose —
    // physical page 59 and physical page 66, as the book reads.
    const hidden = byTitle(items, 'Hidden improvements');
    const sound = byTitle(items, 'Sound System');
    expect(hidden.location).toEqual({ format: 'pdf', pageIndex: 58 });
    expect(sound.location).toEqual({ format: 'pdf', pageIndex: 65 });
    expect(pageIndexOf(hidden)).not.toBe(0);
    expect(pageIndexOf(sound)).not.toBe(0);

    // Their children still resolve, so the entries keep their real structure.
    expect(byTitle(hidden.children, 'VGA Chip manufacturers').location).toEqual({ format: 'pdf', pageIndex: 59 });
    expect(byTitle(sound.children, 'Gravis UltraSound').location).toEqual({ format: 'pdf', pageIndex: 66 });
  });

  it('resolves an integer destination as a zero-based page index', async () => {
    const items = await mapPdfOutline(
      recordedDocument(),
      [{ title: 'Appendix', dest: [137, { name: 'FitH' }, 700] }],
      PAGE_COUNT,
    );

    expect(byTitle(items, 'Appendix').location).toEqual({ format: 'pdf', pageIndex: 137 });
  });

  it('reports no location for absent, malformed and out-of-range destinations', async () => {
    const items = await mapPdfOutline(
      recordedDocument(),
      [
        { title: 'No destination' },
        { title: 'Empty array', dest: [] },
        { title: 'Non-reference first element', dest: ['not-a-ref', { name: 'XYZ' }] },
        { title: 'Past the last page', dest: [PAGE_COUNT, { name: 'XYZ' }] },
        { title: 'Negative page', dest: [-1, { name: 'XYZ' }] },
        { title: 'Unknown reference', dest: [{ num: 9999, gen: 0 }, { name: 'XYZ' }] },
      ],
      PAGE_COUNT,
    );

    expect(items.map((item) => item.location)).toEqual([null, null, null, null, null, null]);
    expect(items.every((item) => item.id.endsWith('unresolved'))).toBe(true);
  });

  it('does not attach a section whose own or whose following destination is unresolved', async () => {
    // A document whose pages say nothing: recovery finds no evidence, so the
    // entries stay unresolved and the ranges around them fail closed.
    const items = await mapPdfOutline(recordedDocument({}), RECORDED_OUTLINE, PAGE_COUNT);
    const hidden = byTitle(items, 'Hidden improvements');
    const video = byTitle(items, 'Video System');
    expect(hidden.location).toBeNull();

    expect(deriveTocContextRange(items, hidden.id, PAGE_COUNT)).toBeNull();
    expect(tocContextUnavailableMessage(items, hidden.id)).toContain('no usable destination');

    // "Video System" is bounded by the unresolved "Hidden improvements", so its
    // end is unknown and it fails closed instead of running on to "Network".
    expect(deriveTocContextRange(items, video.id, PAGE_COUNT)).toBeNull();
    expect(tocContextUnavailableMessage(items, video.id)).toContain('where this section ends is unknown');
  });

  it('still derives a range when both boundaries resolve', async () => {
    const items = await mapPdfOutline(
      recordedDocument(),
      [{ title: 'Video System', dest: 'section.2.2' }, { title: 'Network', dest: 'section.2.5' }],
      PAGE_COUNT,
    );

    expect(deriveTocContextRange(items, byTitle(items, 'Video System').id, PAGE_COUNT)?.pageRange)
      .toEqual({ start: 56, end: 70 });
  });
});

describe('bounded recovery of an unresolved outline destination', () => {
  /** "Hidden improvements", with its bounding pages replaced. */
  async function hiddenImprovementsPage(
    pageText: Readonly<Record<number, string>>,
    outline: readonly PdfOutlineNode[] = RECORDED_OUTLINE,
  ): Promise<number | null> {
    const items = await mapPdfOutline(recordedDocument(pageText), outline, PAGE_COUNT);
    return pageIndexOf(byTitle(items, 'Hidden improvements'));
  }

  it('takes the first page in the interval that names the section', async () => {
    expect(await hiddenImprovementsPage(PAGE_TEXT)).toBe(58);
  });

  it('reports nothing when no page in the interval names the section', async () => {
    const silent = { ...PAGE_TEXT, 56: 'unrelated', 57: 'unrelated', 58: 'unrelated', 59: 'unrelated' };
    expect(await hiddenImprovementsPage(silent)).toBeNull();
  });

  it('reports nothing when the page before the interval already names the section', async () => {
    // The phrase is not introduced inside the interval, so the first hit there
    // is a running header or a common phrase rather than the section opening.
    const ambiguous = { ...PAGE_TEXT, 55: 'CHAPTER 2. IBM PC 2.3 Hidden improvements are discussed later' };
    expect(await hiddenImprovementsPage(ambiguous)).toBeNull();
  });

  it('reports nothing when the neighbours bound more pages than the cap allows', async () => {
    // The child moves far past the section, so the outline no longer says where
    // to look and the search is not attempted.
    const distant: readonly PdfOutlineNode[] = [
      { title: 'Video System', dest: 'section.2.2' },
      { title: 'Hidden improvements', dest: 'section.2.3', items: [{ title: 'Network', dest: 'section.2.5' }] },
    ];
    expect(await hiddenImprovementsPage(PAGE_TEXT, distant)).toBeNull();
  });

  it('reports nothing without a resolved neighbour on each side', async () => {
    const unbounded: readonly PdfOutlineNode[] = [
      { title: 'Hidden improvements', dest: 'section.2.3' },
      { title: 'Network', dest: 'section.2.5' },
    ];
    expect(await hiddenImprovementsPage(PAGE_TEXT, unbounded)).toBeNull();
  });

  it('leaves an entry with no destination at all alone', async () => {
    // Nothing was lost, so there is nothing to recover and no page to search
    // for: an outline entry that is only a grouping label stays a label.
    const grouping: readonly PdfOutlineNode[] = [
      { title: 'Video System', dest: 'section.2.2' },
      { title: 'Hidden improvements' },
      { title: 'Network', dest: 'section.2.5' },
    ];
    expect(await hiddenImprovementsPage(PAGE_TEXT, grouping)).toBeNull();
  });

  it('does not use a recovered page as the bound for the next recovery', async () => {
    const items = await mapPdfOutline(recordedDocument(), RECORDED_OUTLINE, PAGE_COUNT);
    const sound = byTitle(items, 'Sound System');
    // "Sound System" is bounded by "VGA Chip manufacturers" (59) and its own
    // child "Gravis UltraSound" (66), both of which resolved from the document.
    expect(sound.location).toEqual({ format: 'pdf', pageIndex: 65 });
  });

  it('matches a title whose numbering and spacing differ from the page text', async () => {
    const spaced = {
      ...PAGE_TEXT,
      58: 'CHAPTER  2.  IBM   PC — 2.3  HIDDEN\nIMPROVEMENTS — figure 2.28',
    };
    expect(await hiddenImprovementsPage(spaced)).toBe(58);
  });

  it('reports nothing for a title too short to identify a section', async () => {
    const short: readonly PdfOutlineNode[] = [
      { title: 'Video System', dest: 'section.2.2' },
      { title: 'PC', dest: 'section.2.3' },
      { title: 'Gravis UltraSound', dest: 'subsection.2.4.2' },
    ];
    const items = await mapPdfOutline(recordedDocument(), short, PAGE_COUNT);
    expect(byTitle(items, 'PC').location).toBeNull();
  });
});
