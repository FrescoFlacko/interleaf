import { describe, expect, test } from 'vitest';
import type { TableOfContentsItem } from '@shared/types/document';
import {
  deriveTocContextRange,
  flattenTableOfContents,
  tocRangeToChatDescriptor,
} from '../../src/renderer/features/reader/toc-context-range';

const pdf = (id: string, pageIndex: number, children: TableOfContentsItem[] = []): TableOfContentsItem => ({
  id,
  title: id,
  level: 0,
  location: { format: 'pdf', pageIndex },
  children,
});

describe('TOC context range derivation', () => {
  test('flattens nested headings in depth-first document order', () => {
    const items = [pdf('one', 0, [pdf('one-a', 2), pdf('one-b', 4)]), pdf('two', 6)];
    expect(flattenTableOfContents(items).map(({ item }) => item.id)).toEqual(['one', 'one-a', 'one-b', 'two']);
    expect(flattenTableOfContents(items).map(({ depth }) => depth)).toEqual([0, 1, 1, 0]);
  });

  test('honors flat DOCX adapter levels while deriving a parent boundary', () => {
    // This is the exact shape emitted by DocxAdapter.getTableOfContents(): a
    // flat array with zero-based heading levels and no children arrays.
    const realDocxToc: TableOfContentsItem[] = [
      { id: 'docx-h1-a', title: 'H1 A', level: 0, location: { format: 'docx', paragraphIndex: 0, renderedPageIndex: 0 }, children: [] },
      { id: 'docx-h2-a', title: 'H2 A', level: 1, location: { format: 'docx', paragraphIndex: 2, renderedPageIndex: 0 }, children: [] },
      { id: 'docx-h2-b', title: 'H2 B', level: 1, location: { format: 'docx', paragraphIndex: 5, renderedPageIndex: 1 }, children: [] },
      { id: 'docx-h1-b', title: 'H1 B', level: 0, location: { format: 'docx', paragraphIndex: 8, renderedPageIndex: 2 }, children: [] },
    ];
    expect(flattenTableOfContents(realDocxToc).map(({ depth }) => depth)).toEqual([0, 1, 1, 0]);
    const range = deriveTocContextRange(realDocxToc, 'docx-h1-a');
    expect(range?.nextItem?.id).toBe('docx-h1-b');
    expect(tocRangeToChatDescriptor(range!, 10)).toEqual({
      format: 'docx', startParagraphIndex: 0, endParagraphIndex: 7, startRenderedPageIndex: 0,
    });
  });

  test('includes descendants and ends before the next heading at the selected depth', () => {
    const items = [pdf('one', 0, [pdf('one-a', 2), pdf('one-b', 4)]), pdf('two', 6)];
    expect(deriveTocContextRange(items, 'one', 10)?.pageRange).toEqual({ start: 1, end: 6 });
    expect(deriveTocContextRange(items, 'one-a', 10)?.pageRange).toEqual({ start: 3, end: 4 });
    expect(deriveTocContextRange(items, 'one-b', 10)?.pageRange).toEqual({ start: 5, end: 6 });
    expect(deriveTocContextRange(items, 'one')?.nextItem?.id).toBe('two');
  });

  test('keeps duplicate page headings valid and clamps the final section', () => {
    const items = [pdf('first', 2), pdf('duplicate', 2), pdf('last', 99)];
    expect(deriveTocContextRange(items, 'first', 5)?.pageRange).toEqual({ start: 3, end: 3 });
    expect(deriveTocContextRange(items, 'duplicate', 5)?.pageRange).toEqual({ start: 3, end: 4 });
    expect(deriveTocContextRange(items, 'last', 5)?.pageRange).toEqual({ start: 5, end: 5 });
  });

  test('rejects invalid selection pages and missing headings', () => {
    const items = [pdf('invalid', -1), pdf('valid', 1)];
    expect(deriveTocContextRange(items, 'missing', 4)).toBeNull();
    expect(deriveTocContextRange(items, 'invalid', 4)).toBeNull();
    expect(deriveTocContextRange([pdf('valid', 1)], 'valid', 0)).toBeNull();
    expect(deriveTocContextRange([pdf('valid', 1), pdf('bad-boundary', -1)], 'valid', 4)).toBeNull();
    expect(deriveTocContextRange([pdf('valid', 3), pdf('descending', 1)], 'valid', 6)).toBeNull();
  });

  test('rejects descending native destinations for every numeric adapter unit', () => {
    const cases: TableOfContentsItem[][] = [
      [
        { id: 'mobi-start', title: 'Start', level: 0, location: { format: 'mobi', sectionIndex: 4 }, children: [] },
        { id: 'mobi-next', title: 'Next', level: 0, location: { format: 'mobi', sectionIndex: 2 }, children: [] },
      ],
      [
        { id: 'docx-start', title: 'Start', level: 0, location: { format: 'docx', paragraphIndex: 4 }, children: [] },
        { id: 'docx-next', title: 'Next', level: 0, location: { format: 'docx', paragraphIndex: 2 }, children: [] },
      ],
      [
        { id: 'markdown-start', title: 'Start', level: 0, location: { format: 'markdown', blockIndex: 4 }, children: [] },
        { id: 'markdown-next', title: 'Next', level: 0, location: { format: 'markdown', blockIndex: 2 }, children: [] },
      ],
      [
        { id: 'epub-start', title: 'Start', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/8)', spineHref: 'OPS/a.xhtml' }, children: [] },
        { id: 'epub-next', title: 'Next', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/4)', spineHref: 'OPS/b.xhtml' }, children: [] },
      ],
    ];
    for (const items of cases) expect(deriveTocContextRange(items, items[0]!.id)).toBeNull();
  });

  test('preserves native non-PDF units without inventing page numbers', () => {
    const items: TableOfContentsItem[] = [
      { id: 'intro', title: 'Intro', level: 0, location: { format: 'markdown', blockIndex: 2, lineIndex: 10, headingId: 'intro' }, children: [] },
      { id: 'next', title: 'Next', level: 0, location: { format: 'markdown', blockIndex: 5, lineIndex: 20, headingId: 'next' }, children: [] },
    ];
    const range = deriveTocContextRange(items, 'intro');
    expect(range?.pageRange).toBeNull();
    expect(tocRangeToChatDescriptor(range!, 8)).toMatchObject({
      format: 'markdown',
      startBlockIndex: 2,
      endBlockIndex: 4,
      startHeadingId: 'intro',
    });
    expect(tocRangeToChatDescriptor(range!, 8)).not.toHaveProperty('endLineIndex');
    expect(tocRangeToChatDescriptor(range!, 8)).not.toHaveProperty('endHeadingId');
  });

  test('rejects a corrupt mixed-format boundary instead of coercing it', () => {
    const items: TableOfContentsItem[] = [
      { id: 'epub', title: 'EPUB', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'a.xhtml' }, children: [] },
      { id: 'pdf', title: 'PDF', level: 0, location: { format: 'pdf', pageIndex: 2 }, children: [] },
    ];
    expect(deriveTocContextRange(items, 'epub')).toBeNull();
    expect(deriveTocContextRange([
      { id: 'pdf', title: 'PDF', level: 0, location: { format: 'pdf', pageIndex: 2 }, children: [] },
      { id: 'markdown', title: 'Markdown', level: 0, location: { format: 'markdown', blockIndex: 3 }, children: [] },
    ], 'pdf', 10)).toBeNull();
  });

  test('derives exhaustive native descriptors without misleading exclusive endpoint metadata', () => {
    const markdownRange = deriveTocContextRange([
      { id: 'md-a', title: 'A', level: 0, location: { format: 'markdown', blockIndex: 3, lineIndex: 11, headingId: 'a' }, children: [] },
      { id: 'md-b', title: 'B', level: 0, location: { format: 'markdown', blockIndex: 7, lineIndex: 30, headingId: 'b' }, children: [] },
    ], 'md-a');
    expect(tocRangeToChatDescriptor(markdownRange!, 12)).toEqual({
      format: 'markdown', startBlockIndex: 3, endBlockIndex: 6, startLineIndex: 11, startHeadingId: 'a',
    });

    const docxRange = deriveTocContextRange([
      { id: 'docx-a', title: 'A', level: 0, location: { format: 'docx', paragraphIndex: 2, renderedPageIndex: 1 }, children: [] },
      { id: 'docx-b', title: 'B', level: 0, location: { format: 'docx', paragraphIndex: 5, renderedPageIndex: 3 }, children: [] },
    ], 'docx-a');
    expect(tocRangeToChatDescriptor(docxRange!)).toEqual({
      format: 'docx', startParagraphIndex: 2, endParagraphIndex: 4, startRenderedPageIndex: 1,
    });

    const mobiRange = deriveTocContextRange([
      { id: 'mobi-a', title: 'A', level: 0, location: { format: 'mobi', sectionIndex: 1 }, children: [] },
      { id: 'mobi-b', title: 'B', level: 0, location: { format: 'mobi', sectionIndex: 4 }, children: [] },
    ], 'mobi-a');
    expect(tocRangeToChatDescriptor(mobiRange!)).toEqual({
      format: 'mobi', startSectionIndex: 1, endSectionIndex: 3,
    });
  });

  test('derives EPUB next and final boundaries with inclusive endpoint CFIs and labels', () => {
    const items: TableOfContentsItem[] = [
      { id: 'chapter-a', title: 'A', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2!/4/2)', spineHref: 'a.xhtml' }, children: [] },
      { id: 'chapter-b', title: 'B', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/8!/4/2)', spineHref: 'b.xhtml' }, children: [] },
    ];
    const actualSpineHrefs = new Map([
      [0, 'OPS/chapter-1.xhtml'],
      [2, 'OPS/chapter-3.xhtml'],
      [3, 'OPS/chapter-4.xhtml'],
      [4, 'OPS/chapter-5.xhtml'],
    ]);
    const nextRange = deriveTocContextRange(items, 'chapter-a');
    expect(tocRangeToChatDescriptor(nextRange!, 5, actualSpineHrefs)).toEqual({
      format: 'epub',
      startSpineHref: 'OPS/chapter-1.xhtml',
      endSpineHref: 'OPS/chapter-3.xhtml',
      startCfi: 'epubcfi(/6/2!/4/2)',
      endCfi: 'epubcfi(/6/6)',
    });

    const finalRange = deriveTocContextRange(items, 'chapter-b');
    expect(tocRangeToChatDescriptor(finalRange!, 5, actualSpineHrefs)).toEqual({
      format: 'epub',
      startSpineHref: 'OPS/chapter-4.xhtml',
      endSpineHref: 'OPS/chapter-5.xhtml',
      startCfi: 'epubcfi(/6/8!/4/2)',
      endCfi: 'epubcfi(/6/10)',
    });
    expect(tocRangeToChatDescriptor(finalRange!)).toEqual({
      format: 'epub',
      startSpineHref: 'b.xhtml',
      endSpineHref: 'b.xhtml',
      startCfi: 'epubcfi(/6/8!/4/2)',
      endCfi: 'epubcfi(/6/8!/4/2)',
    });
    expect(tocRangeToChatDescriptor(nextRange!, 5)).toBeNull();
  });

  test('fails closed for EPUB headings without trustworthy within-spine boundaries', () => {
    expect(deriveTocContextRange([
      { id: 'one', title: 'One', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'OPS/chapter.xhtml' }, children: [] },
      { id: 'two', title: 'Two', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'OPS/chapter.xhtml' }, children: [] },
    ], 'one')).toBeNull();
    expect(deriveTocContextRange([
      { id: 'fragment', title: 'Fragment', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'OPS/chapter.xhtml#fragment' }, children: [] },
    ], 'fragment')).toBeNull();
  });

  test('fails closed for malformed and duplicate native locations', () => {
    const malformedEpub = deriveTocContextRange([
      { id: 'bad', title: 'Bad', level: 0, location: { format: 'epub', cfi: 'not-a-cfi' }, children: [] },
    ], 'bad');
    expect(malformedEpub).toBeNull();

    const duplicateMobi = deriveTocContextRange([
      { id: 'first', title: 'First', level: 0, location: { format: 'mobi', sectionIndex: 2 }, children: [] },
      { id: 'same', title: 'Same', level: 0, location: { format: 'mobi', sectionIndex: 2 }, children: [] },
    ], 'first');
    expect(tocRangeToChatDescriptor(duplicateMobi!)).toEqual({
      format: 'mobi', startSectionIndex: 2, endSectionIndex: 2,
    });

    expect(deriveTocContextRange([
      { id: 'bad-mobi', title: 'Bad MOBI', level: 0, location: { format: 'mobi', sectionIndex: -1 }, children: [] },
    ], 'bad-mobi')).toBeNull();
    expect(deriveTocContextRange([
      { id: 'bad-docx', title: 'Bad DOCX', level: 0, location: { format: 'docx', paragraphIndex: -1 }, children: [] },
    ], 'bad-docx')).toBeNull();
    expect(deriveTocContextRange([
      { id: 'bad-markdown', title: 'Bad Markdown', level: 0, location: { format: 'markdown', blockIndex: -1 }, children: [] },
    ], 'bad-markdown')).toBeNull();
  });
});
