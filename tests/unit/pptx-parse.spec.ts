// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parsePptxArchive, PPTX_PARSE_LIMITS } from '../../src/renderer/features/reader/adapters/pptx-parse-core';
import type { ParsedDocxParagraph, ParsedDocxPayload } from '../../src/renderer/features/reader/adapters/docx-parse-core';
import { PptxAdapter } from '../../src/renderer/features/reader/adapters/pptx-adapter';
import { createDocumentAdapter } from '../../src/renderer/features/reader/adapters/adapter-factory';
import { parseDocumentLocation } from '../../src/shared/schemas/document';
import { makePptxFixture } from '../fixtures/pptx-fixtures';
import { testDocumentSource } from '../helpers/document-source';

function parse(bytes: Buffer): ParsedDocxPayload {
  return parsePptxArchive(new Uint8Array(bytes));
}

function paragraphs(payload: ParsedDocxPayload): ParsedDocxParagraph[] {
  const result: ParsedDocxParagraph[] = [];
  for (const block of payload.blocks) {
    if (block.kind === 'paragraph') result.push(block);
    else for (const row of block.rows) for (const cell of row) result.push(...cell);
  }
  return result.sort((a, b) => a.index - b.index);
}

const parsePptxForTesting = (bytes: Uint8Array): Promise<ParsedDocxPayload> =>
  Promise.resolve(parsePptxArchive(bytes));

function pptxDataUrl(bytes: Buffer): string {
  return `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${bytes.toString('base64')}`;
}

describe('PPTX package parser', () => {
  it('reads slides in presentation order with the title first, then shapes in tree order', () => {
    const payload = parse(makePptxFixture());
    expect(payload.pageCount).toBe(3);
    expect(payload.toc).toEqual([
      { title: 'Quarterly Research Review', paragraphIndex: 0, pageIndex: 0, level: 0 },
      expect.objectContaining({ title: 'Findings Table', pageIndex: 1, level: 0 }),
      expect.objectContaining({ title: 'Next Steps', pageIndex: 2, level: 0 }),
    ]);
    const all = paragraphs(payload);
    expect(all.map((paragraph) => [paragraph.pageIndex, paragraph.text])).toEqual([
      [0, 'Quarterly Research Review'],
      [0, 'Signals from the field'],
      [0, 'Retention improved'],
      [0, 'Nested evidence point'],
      [0, ''],
      [1, 'Findings Table'],
      [1, 'Metric'],
      [1, 'Value'],
      [1, 'Readers'],
      [1, '42'],
      [1, 'Citations'],
      [1, '7'],
      [2, 'Next Steps'],
      [2, 'Draft the synthesis'],
      [2, 'Share with reviewers'],
      [2, 'Bold and distinctive closing remark'],
    ]);
    expect(all.map((paragraph) => paragraph.index)).toEqual(all.map((_, index) => index));
    expect(all[0]).toMatchObject({ headingLevel: 2 });
    expect(all[1]?.list).toMatchObject({ ordered: false, level: 0, style: 'disc' });
    expect(all[3]?.list).toMatchObject({ ordered: false, level: 1 });
    expect(all[13]?.list).toMatchObject({ ordered: true, ordinal: 1, style: 'decimal' });
    expect(all[14]?.list).toMatchObject({ ordered: true, ordinal: 2 });
    expect(all[15]?.runs).toEqual([
      { text: 'Bold', bold: true },
      { text: ' and ' },
      { text: 'distinctive closing remark', italic: true },
    ]);
    expect(all[4]?.images?.[0]).toMatchObject({ alt: 'Synthetic chart 1' });
    expect(all[4]?.images?.[0]?.src).toMatch(/^data:image\/png;base64,/);
    const table = payload.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows.length : 0).toBe(3);
    // Speaker notes are never read into the reading text.
    expect(JSON.stringify(payload)).not.toContain('Speaker-only note');
  });

  it('follows sldIdLst order rather than slide file names', () => {
    const payload = parse(makePptxFixture({ order: [2, 0, 1] }));
    expect(payload.toc.map((item) => item.title)).toEqual(['Next Steps', 'Quarterly Research Review', 'Findings Table']);
    expect(payload.toc.map((item) => item.pageIndex)).toEqual([0, 1, 2]);
  });

  it('labels untitled slides and keeps empty slides navigable', () => {
    const payload = parse(makePptxFixture({ slides: [{}, { textBox: 'loose words' }] }));
    expect(payload.toc.map((item) => item.title)).toEqual(['Slide 1', 'Slide 2']);
    expect(payload.toc[0]?.paragraphIndex).toBe(0);
    expect(paragraphs(payload)[0]).toMatchObject({ text: '', pageIndex: 0 });
  });

  it('skips external images instead of fetching them', () => {
    const payload = parse(makePptxFixture({ includeExternalImage: true }));
    expect(paragraphs(payload).some((paragraph) => paragraph.images)).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('attacker.invalid');
  });

  it.each([
    ['a macro project', { includeMacro: true }],
    ['a macro-enabled main part', { macroContentType: true }],
    ['video media', { includeVideo: true }],
    ['an OLE object', { includeOleObject: true }],
    ['an ActiveX control', { includeActiveXControl: true }],
  ])('fails closed on %s', (_label, options) => {
    expect(() => parse(makePptxFixture(options))).toThrow('This PPTX contains unsupported active or embedded content.');
  });

  it('rejects unsafe XML, non-presentation packages, broken slide lists and non-ZIP input', () => {
    expect(() => parse(makePptxFixture({ includeDoctype: true }))).toThrow(/Invalid PPTX: forbidden declaration/);
    expect(() => parse(makePptxFixture({ wordprocessingMainType: true }))).toThrow(/not a PowerPoint presentation/);
    expect(() => parse(makePptxFixture({ missingSlide: true }))).toThrow(/missing slide/);
    // An encrypted Office file is an OLE compound file, not a ZIP package.
    const compound = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(compound);
    expect(() => parse(compound)).toThrow();
    expect(() => parse(Buffer.from('not a zip'))).toThrow();
  });

  it('refuses slides beyond the rendering budget', () => {
    const huge = 'x'.repeat(200 * 1024);
    expect(() => parse(makePptxFixture({ slides: [{ bullets: [huge, huge, huge] }] }))).toThrow(/slide 1 exceeds rendering safety limits/);
    expect(PPTX_PARSE_LIMITS.maxSlides).toBe(2_000);
  });
});

describe('PPTX reader adapter', () => {
  it('is created for the pptx format', () => {
    expect(createDocumentAdapter('pptx')).toBeInstanceOf(PptxAdapter);
    expect(createDocumentAdapter('pptx').format).toBe('pptx');
  });

  it('renders one page per slide with slide navigation, search and pptx locations', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new PptxAdapter(parsePptxForTesting);
    const changes: string[] = [];
    adapter.setLocationChangeCallback((location) => changes.push(location.format));
    await adapter.open(container, testDocumentSource({ documentId: 'deck', assetUrl: pptxDataUrl(makePptxFixture()) }));

    expect(adapter.getPageCount()).toBe(3);
    expect(container.querySelector('[data-testid="docx-page-1"]')?.getAttribute('aria-label')).toBe('Slide 1');
    expect(container.querySelector('h2')?.textContent).toBe('Quarterly Research Review');
    expect(container.querySelector('ul > li')?.textContent).toContain('Signals from the field');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Synthetic chart 1');

    const toc = await adapter.getTableOfContents();
    expect(toc.map((item) => item.title)).toEqual(['Quarterly Research Review', 'Findings Table', 'Next Steps']);
    expect(toc[1]?.location).toMatchObject({ format: 'pptx', renderedPageIndex: 1 });
    expect(parseDocumentLocation(toc[1]?.location)).toMatchObject({ format: 'pptx' });

    await adapter.goToPage(3);
    expect(adapter.getCurrentPage()).toBe(3);
    expect(adapter.getReadingLocation().location).toMatchObject({ format: 'pptx', renderedPageIndex: 2 });
    expect(changes.at(-1)).toBe('pptx');

    const matches = await adapter.search('distinctive');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.location).toMatchObject({ format: 'pptx', renderedPageIndex: 2 });
    await adapter.goToLocation(matches[0]!.location);
    expect(adapter.getCurrentPage()).toBe(3);

    // A Word location never drives a slide deck.
    await adapter.goToLocation({ format: 'docx', paragraphIndex: 0 });
    expect(adapter.getCurrentPage()).toBe(3);

    const chunks = [];
    for await (const chunk of adapter.extractText()) chunks.push(chunk);
    expect(chunks.every((chunk) => chunk.location.format === 'pptx')).toBe(true);
    expect(chunks.find((chunk) => chunk.text === '42')).toMatchObject({ heading: 'Findings Table', pageLabel: 'Slide 2' });
    expect(adapter.getAnnotationScope()).toMatchObject({ format: 'pptx' });

    await adapter.close();
    container.remove();
  });
});
