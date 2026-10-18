// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  DocxAdapter,
  MAX_DOCX_SEARCH_RESULTS,
} from '../../src/renderer/features/reader/adapters/docx-adapter';
import {
  DOCX_PARSE_LIMITS,
  parseDocxArchive,
  type ParsedDocxPayload,
} from '../../src/renderer/features/reader/adapters/docx-parse-core';
import { inflateZipArchive } from '../../src/renderer/features/reader/adapters/foliate/zip-inflate-core';
import { makeDocxFixture, strBytes } from '../fixtures/document-fixtures';
import { unzipSync, zipSync } from 'fflate';
import { DOMParser as WorkerDOMParser } from 'linkedom/worker';
import { parseDocumentLocation } from '../../src/shared/schemas/document';
import type { Annotation } from '../../src/shared/types/annotation';
import { testDocumentSource, testReflowOptions } from '../helpers/document-source';

const parseDocxForTesting = (bytes: Uint8Array): Promise<ParsedDocxPayload> =>
  Promise.resolve(parseDocxArchive(bytes));

function docxDataUrl(bytes: Buffer): string {
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${bytes.toString('base64')}`;
}

function duplicateEntryZip(): Uint8Array {
  const name = Buffer.from('duplicate.txt');
  const data = Buffer.from('a');
  const crc = 0xe8b7be43;
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (let index = 0; index < 2; index++) {
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    localRecords.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return new Uint8Array(Buffer.concat([...localRecords, centralDirectory, end]));
}

describe('DOCX semantic reader adapter', () => {
  it('does not mark cached annotations unanchored before the document payload opens', async () => {
    const adapter = new DocxAdapter(parseDocxForTesting);
    const onResolution = vi.fn();
    adapter.setAnnotationResolutionCallback(onResolution);
    const cached: Annotation = {
      id: 'cached-bookmark',
      documentId: 'docx-cached',
      documentHash: 'hash',
      type: 'bookmark',
      anchor: {
        format: 'docx',
        paragraphIndex: 0,
        renderedPageIndex: 0,
        quote: { exact: '', prefix: '', suffix: '' },
      },
      selectedText: null,
      note: null,
      label: null,
      color: null,
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    expect(await adapter.setAnnotations([cached])).toEqual([]);
    expect(onResolution).not.toHaveBeenCalled();
  });

  it('parses qualified OOXML names with the production worker DOM implementation', () => {
    const browserDomParser = globalThis.DOMParser;
    Object.assign(globalThis, { DOMParser: WorkerDOMParser });
    try {
      const payload = parseDocxArchive(makeDocxFixture());
      expect(payload.toc.map((item) => item.title)).toEqual(['DOCX Foundations', 'Second Section']);
      expect(payload.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'DOCX Foundations' });
    } finally {
      Object.assign(globalThis, { DOMParser: browserDomParser });
    }
  });

  it('renders Word structure while keeping paragraph anchors canonical', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new DocxAdapter(parseDocxForTesting);
    await adapter.open(container, testDocumentSource({
      documentId: 'docx-semantic',
      assetUrl: docxDataUrl(makeDocxFixture()),
    }));

    expect(adapter.getPageCount()).toBe(2);
    expect(container.querySelector('[data-testid="docx-page-1"]')).not.toBeNull();
    expect(container.textContent).toContain('DOCX Foundations');
    expect(container.querySelector('strong')?.textContent).toBe('Bold insight');
    expect(container.querySelector('em')?.textContent).toBe('italic context');
    expect(container.querySelector<HTMLElement>('.docx-align-center')?.style.textAlign).toBe('center');
    expect(container.querySelector('ul > li')?.textContent).toContain('Semantic list item');
    expect(container.querySelector('ol > li[value="3"]')?.textContent).toContain('Ordered item three');
    expect(container.querySelector('ol ul > li')?.textContent).toContain('Nested bullet');
    expect(container.querySelector('ol > li[value="4"]')?.textContent).toContain('Ordered item four');
    expect(container.querySelector('ol > li[value="10"]')?.textContent).toContain('Restarted item ten');
    expect(container.querySelector<HTMLElement>('.docx-list-style-lower-roman')?.style.listStyleType).toBe('lower-roman');
    expect(container.querySelector<HTMLElement>('.docx-list-style-upper-alpha')?.style.listStyleType).toBe('upper-alpha');
    expect(container.querySelector('.docx-list-style-upper-alpha')?.textContent).toContain('Alphabetic item');
    expect(container.querySelector('table')?.textContent).toContain('Definition');
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

    const toc = await adapter.getTableOfContents();
    expect(toc.map((item) => item.title)).toEqual(['DOCX Foundations', 'Second Section']);
    expect(toc[0]!.location).toMatchObject({ format: 'docx', paragraphIndex: 0 });

    const onResolution = vi.fn();
    adapter.setAnnotationResolutionCallback(onResolution);
    const titleHighlight: Annotation = {
      id: 'title-highlight',
      documentId: 'docx-semantic',
      documentHash: 'hash',
      type: 'highlight',
      anchor: {
        format: 'docx',
        paragraphIndex: 0,
        characterStart: 1,
        characterEnd: 2,
        renderedPageIndex: 0,
        quote: { exact: 'DOCX Foundations', prefix: '', suffix: '' },
      },
      selectedText: 'DOCX Foundations',
      note: null,
      label: null,
      color: 'blue',
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const resolutions = await adapter.setAnnotations([titleHighlight]);
    expect(resolutions[0]).toMatchObject({
      annotationId: 'title-highlight',
      status: 'anchored',
      stage: 'quote',
      anchor: { characterStart: 0, characterEnd: 16 },
    });
    expect(onResolution).toHaveBeenCalledWith(resolutions[0]);

    const matches = await adapter.search('searchable phrase');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.location).toMatchObject({
      format: 'docx',
      characterStart: 0,
      characterEnd: 17,
      renderedPageIndex: 1,
    });
    await adapter.goToLocation(matches[0]!.location);
    expect(adapter.getCurrentPage()).toBe(2);
    expect(adapter.getReadingLocation().location).toMatchObject({
      format: 'docx',
      paragraphIndex: matches[0]!.location.format === 'docx'
        ? matches[0]!.location.paragraphIndex
        : -1,
      characterStart: 0,
      characterEnd: 17,
    });

    const chunks = [];
    for await (const chunk of adapter.extractText()) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.text === 'Term 1')).toBe(true);
    expect(chunks.at(-1)?.heading).toBe('Second Section');
    const extracted = await adapter.extractLocationText(matches[0]!.location);
    expect(extracted[0]?.text).toContain('Searchable phrase');

    const stableLocation = adapter.getReadingLocation().location;
    await adapter.setZoom(1.75);
    await adapter.setReflowOptions(testReflowOptions({ lineHeight: 2, horizontalMarginRem: 4 }));
    await adapter.goToLocation(stableLocation);
    expect(adapter.getReadingLocation().location.paragraphIndex).toBe(
      stableLocation.paragraphIndex
    );

    await adapter.close();
    document.body.removeChild(container);
  });

  it('does not hard-code a white page: DOCX pages inherit the independent reader pair', async () => {
    const container = document.createElement('div');
    container.style.setProperty('--reader-background-override', '#09090b');
    container.style.setProperty('--reader-foreground-override', '#fafafa');
    const adapter = new DocxAdapter(parseDocxForTesting);
    await adapter.open(container, testDocumentSource({
      documentId: 'docx-reader-theme',
      assetUrl: docxDataUrl(makeDocxFixture()),
    }));
    const page = container.querySelector<HTMLElement>('[data-testid="docx-page-1"]');
    expect(page).not.toBeNull();
    expect(page?.className).not.toContain('bg-white');
    expect(page?.className).not.toContain('text-black');
    expect(page?.style.backgroundColor).toBe('var(--reader-background-override, var(--bg-reader))');
    expect(page?.style.color).toBe('var(--reader-foreground-override, var(--text-primary))');
    await adapter.close();
  });

  it('sanitizes hostile text and never activates external relationships', async () => {
    const actionMarker = '__interleafDocxScriptExecuted';
    Object.defineProperty(window, actionMarker, { configurable: true, writable: true, value: false });
    const bodyText = `<script>window.${actionMarker}=true</script><img src="https://attacker.invalid/pixel">`;
    const adapter = new DocxAdapter(parseDocxForTesting);
    const container = document.createElement('div');
    await adapter.open(container, testDocumentSource({
      documentId: 'docx-hostile',
      assetUrl: docxDataUrl(makeDocxFixture({
        bodyText,
        includeExternalRelationship: true,
        includeExternalImageRelationship: true,
      })),
    }));

    expect(container.textContent).toContain(`<script>window.${actionMarker}=true</script>`);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('attacker.invalid/track');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(window.__interleafDocxScriptExecuted).toBe(false);
    await adapter.close();
    Reflect.deleteProperty(window, actionMarker);
  });

  it('signature-sniffs images and strips disguised active image payloads', async () => {
    const adapter = new DocxAdapter(parseDocxForTesting);
    const container = document.createElement('div');
    await adapter.open(container, testDocumentSource({
      documentId: 'docx-image-signature',
      assetUrl: docxDataUrl(makeDocxFixture({ invalidImageSignature: true })),
    }));
    expect(container.querySelector('img')).toBeNull();
    await adapter.close();

    const geometryAdapter = new DocxAdapter(parseDocxForTesting);
    const geometryContainer = document.createElement('div');
    await geometryAdapter.open(geometryContainer, testDocumentSource({
      documentId: 'docx-image-geometry',
      assetUrl: docxDataUrl(makeDocxFixture({ oversizedImageDimensions: true })),
    }));
    expect(geometryContainer.querySelector('img')).toBeNull();
    await geometryAdapter.close();
  });

  it('rejects macros, embedded objects, traversal, malformed XML, and bounded archive expansion', () => {
    expect(() => parseDocxArchive(makeDocxFixture({ includeMacro: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ encodedMacroContentType: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ includeActiveX: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ includeArbitraryActiveRelationship: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ includeExtensibilityRelationship: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ includeEmbeddedObject: true }))).toThrow(/unsupported active/i);
    expect(() => parseDocxArchive(makeDocxFixture({ includePathTraversalEntry: true }))).toThrow(/unsafe entry path/i);
    expect(() => parseDocxArchive(makeDocxFixture({ malformedDocumentXml: true }))).toThrow(/malformed word\/document\.xml/i);

    const malformedEncodingEntries = unzipSync(makeDocxFixture());
    malformedEncodingEntries['word/document.xml'] = new Uint8Array([0xff, 0xff, 0xff]);
    expect(() => parseDocxArchive(new Uint8Array(zipSync(malformedEncodingEntries)))).toThrow(/malformed text encoding/i);
    expect(() => inflateZipArchive(duplicateEntryZip())).toThrow(/duplicate entry path/i);

    const expanded = new Uint8Array(DOCX_PARSE_LIMITS.maxArchiveUncompressedBytes > 0 ? 2_048 : 0);
    const tinyBomb = new Uint8Array(zipSync({ 'large.bin': expanded }));
    expect(() => inflateZipArchive(tinyBomb, {
      maxEntries: 10,
      maxSingleEntryBytes: 1_024,
      maxTotalUncompressedBytes: 1_024,
    })).toThrow(/maximum uncompressed size|maximum total uncompressed size/i);

    const whitespaceContentTypes = unzipSync(makeDocxFixture());
    whitespaceContentTypes['[Content_Types].xml'] = strBytes('   \n');
    expect(() => parseDocxArchive(new Uint8Array(zipSync(whitespaceContentTypes)))).toThrow(/content_types|content-types/i);

    const whitespaceRelationships = unzipSync(makeDocxFixture());
    whitespaceRelationships['word/_rels/document.xml.rels'] = strBytes('   \n');
    expect(() => parseDocxArchive(new Uint8Array(zipSync(whitespaceRelationships)))).toThrow(/document\.xml\.rels/i);

    const declaredRelationships = unzipSync(makeDocxFixture());
    declaredRelationships['word/_rels/document.xml.rels'] = strBytes(
      '<!DOCTYPE Relationships [<!ENTITY hostile "value">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
    );
    expect(() => parseDocxArchive(new Uint8Array(zipSync(declaredRelationships)))).toThrow(/forbidden declaration/i);
  });

  it('rejects embedded audio and video even when no document element references them', () => {
    const audioEntries = unzipSync(makeDocxFixture());
    audioEntries['word/media/audio.mp3'] = strBytes('not playable');
    expect(() => parseDocxArchive(new Uint8Array(zipSync(audioEntries)))).toThrow(/unsupported active/i);

    const videoContentTypeEntries = unzipSync(makeDocxFixture());
    const contentTypes = new TextDecoder().decode(videoContentTypeEntries['[Content_Types].xml']);
    videoContentTypeEntries['[Content_Types].xml'] = strBytes(
      contentTypes.replace('</Types>', '<Default Extension="mp4" ContentType="video/mp4"/></Types>')
    );
    expect(() => parseDocxArchive(new Uint8Array(zipSync(videoContentTypeEntries)))).toThrow(/unsupported active/i);

    const videoRelationshipEntries = unzipSync(makeDocxFixture());
    const relationships = new TextDecoder().decode(videoRelationshipEntries['word/_rels/document.xml.rels']);
    videoRelationshipEntries['word/_rels/document.xml.rels'] = strBytes(
      relationships.replace(
        '</Relationships>',
        '<Relationship Id="rIdVideo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="media/video.bin"/></Relationships>'
      )
    );
    expect(() => parseDocxArchive(new Uint8Array(zipSync(videoRelationshipEntries)))).toThrow(/unsupported active/i);
  });

  it('bounds page/table work, Unicode-folded offsets, and high-cardinality search results', async () => {
    const tablePayload = parseDocxArchive(makeDocxFixture({ tableRows: 101 }));
    const tableBlocks = tablePayload.blocks.filter((block) => block.kind === 'table');
    expect(tableBlocks.length).toBeGreaterThan(1);
    expect(Math.max(...tableBlocks.map((table) => table.rows.length))).toBeLessThanOrEqual(20);
    expect(() => parseDocxArchive(makeDocxFixture({
      bodyText: 'x'.repeat(DOCX_PARSE_LIMITS.maxParagraphTextBytes + 1),
    }))).toThrow(/paragraph exceeds text safety limit/i);

    const bodyText = `İ prefix AFTER ${'a'.repeat(MAX_DOCX_SEARCH_RESULTS + 500)}`;
    const adapter = new DocxAdapter(parseDocxForTesting);
    await adapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'docx-search-bounds',
      assetUrl: docxDataUrl(makeDocxFixture({ bodyText })),
    }));
    const cancelledSearch = adapter.search('not present');
    const currentSearch = adapter.search('after');
    expect(await cancelledSearch).toEqual([]);
    const unicodeMatch = await currentSearch;
    const expectedStart = bodyText.indexOf('AFTER');
    expect(unicodeMatch[0]?.location).toMatchObject({
      characterStart: expectedStart,
      characterEnd: expectedStart + 5,
    });
    expect(unicodeMatch[0]?.text).toBe('AFTER');
    expect(await adapter.search('a')).toHaveLength(MAX_DOCX_SEARCH_RESULTS);
    await adapter.close();

    const expansionAdapter = new DocxAdapter(parseDocxForTesting);
    await expansionAdapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'docx-search-expansion',
      assetUrl: docxDataUrl(makeDocxFixture({ bodyText: 'ß', includeImage: false })),
    }));
    const expansionMatches = await expansionAdapter.search('s');
    const expansionBodyMatches = expansionMatches.filter(
      (match) => match.location.format === 'docx' && match.location.paragraphIndex === 1
    );
    expect(expansionBodyMatches).toHaveLength(1);
    expect(expansionBodyMatches[0]?.location).toMatchObject({ characterStart: 0, characterEnd: 1 });
    expect(new Set(expansionMatches.map((match) => match.id)).size).toBe(expansionMatches.length);
    await expansionAdapter.close();
  });

  it('yields and cancels absent-query search by bounded text work near the aggregate limit', async () => {
    const paragraphText = 'x'.repeat(127 * 1024);
    const paragraphCount = Math.floor(
      DOCX_PARSE_LIMITS.maxTotalTextBytes / paragraphText.length
    );
    const blocks = Array.from({ length: paragraphCount }, (_, index) => ({
      kind: 'paragraph' as const,
      index,
      text: paragraphText,
      pageIndex: index,
    }));
    const payload: ParsedDocxPayload = { blocks, toc: [], pageCount: paragraphCount };
    const adapter = new DocxAdapter(() => Promise.resolve(payload));
    await adapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'docx-near-limit-search',
      assetUrl: docxDataUrl(makeDocxFixture({ includeImage: false })),
    }));

    let heartbeatRan = false;
    let searchSettled = false;
    let searchWasSettledAtClose = true;
    const search = adapter.search('absent query').finally(() => {
      searchSettled = true;
    });
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(() => {
        heartbeatRan = true;
        searchWasSettledAtClose = searchSettled;
        void adapter.close().then(resolve);
      }, 0);
    });

    expect(heartbeatRan).toBe(true);
    expect(searchWasSettledAtClose).toBe(false);
    expect(await search).toEqual([]);
  });

  it('validates paired, forward DOCX character ranges', () => {
    expect(parseDocumentLocation({ format: 'docx', paragraphIndex: 1, characterStart: 2 })).toBeNull();
    expect(parseDocumentLocation({
      format: 'docx', paragraphIndex: 1, characterStart: 3, characterEnd: 2,
    })).toBeNull();
    expect(parseDocumentLocation({
      format: 'docx', paragraphIndex: 1, characterStart: 2, characterEnd: 3,
    })).toMatchObject({ characterStart: 2, characterEnd: 3 });
  });

  it('aborts superseded parsing and ignores stale results', async () => {
    let calls = 0;
    const firstAborted = vi.fn();
    const parser = (bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocxPayload> => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            firstAborted();
            reject(new DOMException('cancelled', 'AbortError'));
          }, { once: true });
        });
      }
      return Promise.resolve(parseDocxArchive(bytes));
    };
    const adapter = new DocxAdapter(parser);
    const container = document.createElement('div');
    const firstOpen = adapter.open(container, testDocumentSource({
      documentId: 'docx-stale',
      assetUrl: docxDataUrl(makeDocxFixture({ title: 'Stale' })),
    }));
    await Promise.resolve();
    const secondOpen = adapter.open(container, testDocumentSource({
      documentId: 'docx-current',
      assetUrl: docxDataUrl(makeDocxFixture({ bodyText: 'Current document body' })),
    }));
    await Promise.all([firstOpen, secondOpen]);
    expect(firstAborted).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Current document body');
    await adapter.close();
  });
});
