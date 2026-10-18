import {
  attributeByLocalName,
  directChildrenByLocalName,
  elementsByLocalName,
  firstDescendant,
  inspectContentTypes,
  normalizedLocalName,
  openOoxmlPackage,
  parseRelationships,
  parseXml as parseOoxml,
  readBoundedXml as readOoxmlPart,
  type OoxmlRelationship,
} from './ooxml-package';
import { OOXML_MAX_IMAGE_DIMENSION, OOXML_MAX_IMAGE_PIXELS, bytesToBase64, inspectRaster } from './ooxml-raster';

const MAX_DOCUMENT_XML_BYTES = 32 * 1024 * 1024;
const MAX_AUX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_PARAGRAPHS = 100_000;
const MAX_PARAGRAPH_TEXT = 256 * 1024;
const MAX_RUNS_PER_PARAGRAPH = 2_000;
const MAX_TOTAL_TEXT = 32 * 1024 * 1024;
const MAX_TABLES = 10_000;
const MAX_TABLE_CELLS = 100_000;
const MAX_TABLE_CELLS_PER_ROW = 128;
const MAX_TABLE_PARAGRAPHS_PER_ROW = 200;
const MAX_TABLE_ROWS_PER_PAGE = 100;
const MAX_PARAGRAPHS_PER_PAGE_HINT = 40;
const MAX_RENDERED_PAGE_TEXT_BYTES = 512 * 1024;
const MAX_RENDERED_PAGE_NODES = 10_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BOOK_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 1_000;
const MAX_IMAGE_DIMENSION = OOXML_MAX_IMAGE_DIMENSION;
const MAX_IMAGE_PIXELS = OOXML_MAX_IMAGE_PIXELS;

export const DOCX_PARSE_LIMITS = Object.freeze({
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxArchiveUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  maxParagraphs: MAX_PARAGRAPHS,
  maxParagraphTextBytes: MAX_PARAGRAPH_TEXT,
  maxRunsPerParagraph: MAX_RUNS_PER_PARAGRAPH,
  maxRenderedPageTextBytes: MAX_RENDERED_PAGE_TEXT_BYTES,
  maxRenderedPageNodes: MAX_RENDERED_PAGE_NODES,
  maxTotalTextBytes: MAX_TOTAL_TEXT,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxBookImageBytes: MAX_BOOK_IMAGE_BYTES,
  maxImages: MAX_IMAGES,
  maxImageDimension: MAX_IMAGE_DIMENSION,
  maxImagePixels: MAX_IMAGE_PIXELS,
});

export type ParsedDocxImage = {
  readonly src: string;
  readonly alt: string;
};

export type ParsedDocxRun = {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly verticalAlign?: 'subscript' | 'superscript';
};

export type ParsedDocxList = {
  readonly id: string;
  readonly level: number;
  readonly ordered: boolean;
  readonly ordinal: number;
  readonly style: 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman' | 'disc' | 'none';
};

export type ParsedDocxParagraph = {
  readonly kind: 'paragraph';
  readonly index: number;
  readonly text: string;
  readonly pageIndex: number;
  readonly headingLevel?: number;
  readonly list?: ParsedDocxList;
  readonly alignment?: 'center' | 'right' | 'justify';
  readonly runs?: readonly ParsedDocxRun[];
  readonly images?: readonly ParsedDocxImage[];
};

export type ParsedDocxTable = {
  readonly kind: 'table';
  readonly pageIndex: number;
  readonly rows: readonly (readonly (readonly ParsedDocxParagraph[])[])[];
};

export type ParsedDocxBlock = ParsedDocxParagraph | ParsedDocxTable;

export type ParsedDocxPayload = {
  readonly blocks: readonly ParsedDocxBlock[];
  readonly toc: readonly {
    readonly title: string;
    readonly paragraphIndex: number;
    readonly pageIndex: number;
    readonly level: number;
  }[];
  readonly pageCount: number;
};

type StyleInfo = {
  readonly headingLevel?: number;
};

type Relationship = OoxmlRelationship;

const encoder = new TextEncoder();

function parseXml(source: string, label: string): Document {
  return parseOoxml(source, label, 'DOCX');
}

function readBoundedXml(entries: ReadonlyMap<string, Uint8Array>, path: string, maxBytes: number): string | null {
  return readOoxmlPart(entries, path, maxBytes, 'DOCX');
}

function parseStyles(source: string | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!source) return styles;
  const unresolved = new Map<string, { readonly headingLevel?: number; readonly basedOn?: string }>();
  const document = parseXml(source, 'styles.xml');
  for (const style of elementsByLocalName(document, 'style')) {
    const type = attributeByLocalName(style, 'type');
    const id = attributeByLocalName(style, 'styleId');
    if (type !== 'paragraph' || !id) continue;
    const name = attributeByLocalName(firstDescendant(style, 'name'), 'val');
    const basedOn = attributeByLocalName(firstDescendant(style, 'basedOn'), 'val');
    const outlineRaw = attributeByLocalName(firstDescendant(style, 'outlineLvl'), 'val');
    const namedHeading = /heading\s*([1-6])/i.exec(`${id} ${name}`)?.[1];
    const outline = Number.parseInt(outlineRaw, 10);
    const headingLevel = namedHeading
      ? Number.parseInt(namedHeading, 10)
      : Number.isInteger(outline) && outline >= 0 && outline < 6
        ? outline + 1
        : undefined;
    unresolved.set(id, {
      ...(headingLevel ? { headingLevel } : {}),
      ...(basedOn ? { basedOn } : {}),
    });
  }
  const resolveStyle = (id: string, seen = new Set<string>()): StyleInfo => {
    const existing = styles.get(id);
    if (existing) return existing;
    const current = unresolved.get(id);
    if (!current || seen.has(id) || seen.size >= 32) return {};
    seen.add(id);
    const inherited = current.basedOn ? resolveStyle(current.basedOn, seen) : {};
    const resolved = current.headingLevel ? { headingLevel: current.headingLevel } : inherited;
    styles.set(id, resolved);
    return resolved;
  }
  for (const id of unresolved.keys()) resolveStyle(id);
  return styles;
}

type NumberingLevel = {
  readonly ordered: boolean;
  readonly start: number;
  readonly style: ParsedDocxList['style'];
};

function normalizeNumberingStyle(format: string): ParsedDocxList['style'] {
  switch (format.toLowerCase()) {
    case 'bullet': return 'disc';
    case 'none': return 'none';
    case 'lowerletter': return 'lower-alpha';
    case 'upperletter': return 'upper-alpha';
    case 'lowerroman': return 'lower-roman';
    case 'upperroman': return 'upper-roman';
    default: return 'decimal';
  }
}

function parseNumbering(source: string | null): Map<string, ReadonlyMap<number, NumberingLevel>> {
  const numbering = new Map<string, ReadonlyMap<number, NumberingLevel>>();
  if (!source) return numbering;
  const document = parseXml(source, 'numbering.xml');
  const abstracts = new Map<string, Map<number, NumberingLevel>>();
  for (const abstract of elementsByLocalName(document, 'abstractNum')) {
    const id = attributeByLocalName(abstract, 'abstractNumId');
    if (!id || abstracts.has(id)) throw new Error('Invalid DOCX: duplicate abstract numbering identifier');
    const levels = new Map<number, NumberingLevel>();
    for (const level of directChildrenByLocalName(abstract, 'lvl')) {
      const index = Number.parseInt(attributeByLocalName(level, 'ilvl'), 10);
      if (!Number.isInteger(index) || index < 0 || index > 8 || levels.has(index)) {
        throw new Error('Invalid DOCX: malformed numbering level');
      }
      const format = attributeByLocalName(firstDescendant(level, 'numFmt'), 'val').toLowerCase();
      const rawStart = Number.parseInt(attributeByLocalName(firstDescendant(level, 'start'), 'val'), 10);
      const style = normalizeNumberingStyle(format);
      levels.set(index, {
        ordered: style !== 'disc' && style !== 'none',
        start: Number.isSafeInteger(rawStart) && rawStart > 0 ? rawStart : 1,
        style,
      });
    }
    abstracts.set(id, levels);
  }
  for (const instance of elementsByLocalName(document, 'num')) {
    const id = attributeByLocalName(instance, 'numId');
    const abstractId = attributeByLocalName(firstDescendant(instance, 'abstractNumId'), 'val');
    if (!id || !abstractId || numbering.has(id)) throw new Error('Invalid DOCX: malformed numbering instance');
    const sourceLevels = abstracts.get(abstractId);
    if (!sourceLevels) throw new Error('Invalid DOCX: numbering instance references a missing definition');
    const levels = new Map(sourceLevels);
    for (const override of directChildrenByLocalName(instance, 'lvlOverride')) {
      const level = Number.parseInt(attributeByLocalName(override, 'ilvl'), 10);
      const start = Number.parseInt(attributeByLocalName(firstDescendant(override, 'startOverride'), 'val'), 10);
      const existing = levels.get(level);
      if (existing && Number.isSafeInteger(start) && start > 0) {
        levels.set(level, { ...existing, start });
      }
    }
    numbering.set(id, levels);
  }
  return numbering;
}

type ParsedRunStyle = Omit<ParsedDocxRun, 'text'> & { readonly hidden?: boolean };
type MutableParsedDocxRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  verticalAlign?: 'subscript' | 'superscript';
};

function wordPropertyEnabled(element: Element | undefined): boolean {
  if (!element) return false;
  const value = attributeByLocalName(element, 'val').toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no' && value !== 'none';
}

function paragraphContent(paragraph: Element): {
  readonly text: string;
  readonly runs?: readonly ParsedDocxRun[];
} {
  let text = '';
  let controlCharacters = 0;
  let hasFormatting = false;
  let runsOverflow = false;
  const runs: MutableParsedDocxRun[] = [];
  const styleCache = new WeakMap<Element, ParsedRunStyle>();

  const styleForElement = (element: Element): ParsedRunStyle => {
    let run = element.parentElement;
    while (run && run !== paragraph && normalizedLocalName(run) !== 'r') run = run.parentElement;
    if (!run || run === paragraph) return {};
    const cached = styleCache.get(run);
    if (cached) return cached;
    const properties = directChildrenByLocalName(run, 'rPr')[0];
    const verticalValue = attributeByLocalName(
      properties ? firstDescendant(properties, 'vertAlign') : undefined,
      'val'
    ).toLowerCase();
    const verticalAlign = verticalValue === 'subscript' || verticalValue === 'superscript'
      ? verticalValue
      : undefined;
    const style: ParsedRunStyle = {
      ...(wordPropertyEnabled(properties ? firstDescendant(properties, 'b') : undefined) ? { bold: true } : {}),
      ...(wordPropertyEnabled(properties ? firstDescendant(properties, 'i') : undefined) ? { italic: true } : {}),
      ...(wordPropertyEnabled(properties ? firstDescendant(properties, 'u') : undefined) ? { underline: true } : {}),
      ...(wordPropertyEnabled(properties ? firstDescendant(properties, 'strike') : undefined) ? { strike: true } : {}),
      ...(verticalAlign ? { verticalAlign } : {}),
      ...(wordPropertyEnabled(properties ? firstDescendant(properties, 'vanish') : undefined) ? { hidden: true } : {}),
    };
    styleCache.set(run, style);
    return style;
  };

  for (const element of Array.from(paragraph.querySelectorAll('*'))) {
    const localName = normalizedLocalName(element);
    let segment = '';
    if (localName === 't') segment = element.textContent;
    else if (localName === 'tab' && controlCharacters++ < 256) segment = '\t';
    else if (
      localName === 'br' &&
      attributeByLocalName(element, 'type') !== 'page' &&
      controlCharacters++ < 256
    ) segment = '\n';
    if (!segment) continue;
    const { hidden, ...style } = styleForElement(element);
    if (hidden) continue;
    text += segment;
    const styleKey = `${String(Boolean(style.bold))}:${String(Boolean(style.italic))}:${String(Boolean(style.underline))}:${String(Boolean(style.strike))}:${style.verticalAlign ?? ''}`;
    const previous = runs.at(-1);
    const previousKey = previous
      ? `${String(Boolean(previous.bold))}:${String(Boolean(previous.italic))}:${String(Boolean(previous.underline))}:${String(Boolean(previous.strike))}:${previous.verticalAlign ?? ''}`
      : '';
    if (previous && previousKey === styleKey) previous.text += segment;
    else if (runs.length < MAX_RUNS_PER_PARAGRAPH) runs.push({ text: segment, ...style });
    else runsOverflow = true;
    if (Object.keys(style).length > 0) hasFormatting = true;
  }
  return {
    text,
    ...(hasFormatting && !runsOverflow ? { runs } : {}),
  };
}

export function parseDocxArchive(bytes: Uint8Array): ParsedDocxPayload {
  const { entries, contentTypes } = openOoxmlPackage(bytes, 'DOCX', {
    maxEntries: MAX_ARCHIVE_ENTRIES,
    maxTotalUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    maxSingleEntryBytes: MAX_DOCUMENT_XML_BYTES,
    maxContentTypesBytes: MAX_AUX_XML_BYTES,
  });

  const documentSource = readBoundedXml(entries, 'word/document.xml', MAX_DOCUMENT_XML_BYTES);
  if (!contentTypes || !documentSource) throw new Error('Invalid DOCX: required OOXML parts are missing');
  inspectContentTypes(contentTypes, 'DOCX');
  let relationships = new Map<string, Relationship>();
  for (const [path] of entries) {
    if (!path.endsWith('.rels')) continue;
    const source = readBoundedXml(entries, path, MAX_AUX_XML_BYTES);
    const collectDocumentResources = path === 'word/_rels/document.xml.rels';
    const parsedRelationships = parseRelationships(source, {
      collectDocumentResources,
      label: path,
      kind: 'DOCX',
      baseDirectory: 'word',
    });
    if (collectDocumentResources) relationships = parsedRelationships;
  }
  const document = parseXml(documentSource, 'word/document.xml');
  const body = firstDescendant(document, 'body');
  if (!body) throw new Error('Invalid DOCX: document body is missing');

  const styles = parseStyles(readBoundedXml(entries, 'word/styles.xml', MAX_AUX_XML_BYTES));
  const numbering = parseNumbering(readBoundedXml(entries, 'word/numbering.xml', MAX_AUX_XML_BYTES));
  const listCounters = new Map<string, number[]>();
  const blocks: ParsedDocxBlock[] = [];
  const toc: ParsedDocxPayload['toc'][number][] = [];
  let paragraphIndex = 0;
  let totalTextBytes = 0;
  let pageIndex = 0;
  let paragraphsOnPage = 0;
  let pageTextBytes = 0;
  let pageNodeEstimate = 0;
  let tableCount = 0;
  let tableCellCount = 0;
  let imageCount = 0;
  let imageBytes = 0;

  const parseParagraph = (paragraph: Element, fixedPage?: number): ParsedDocxParagraph => {
    if (paragraphIndex >= MAX_PARAGRAPHS) throw new Error('DOCX paragraph count exceeds safety limit');
    const content = paragraphContent(paragraph);
    const text = content.text;
    const textBytes = encoder.encode(text).byteLength;
    if (textBytes > MAX_PARAGRAPH_TEXT) throw new Error('DOCX paragraph exceeds text safety limit');
    totalTextBytes += textBytes;
    if (totalTextBytes > MAX_TOTAL_TEXT) throw new Error('DOCX text exceeds safety limit');

    const pPr = firstDescendant(paragraph, 'pPr');
    const pageBreakBefore = Boolean(pPr && firstDescendant(pPr, 'pageBreakBefore'));
    let leadingPageBreak = false;
    if (fixedPage === undefined) {
      for (const element of Array.from(paragraph.querySelectorAll('*'))) {
        const name = normalizedLocalName(element);
        if (name === 't' && element.textContent.length > 0) break;
        if (name === 'br' && attributeByLocalName(element, 'type') === 'page') {
          leadingPageBreak = true;
          break;
        }
      }
    }
    const paragraphNodeEstimate = 1 + (content.runs?.length ?? 1);
    if (fixedPage === undefined && (
      pageBreakBefore ||
      leadingPageBreak ||
      paragraphsOnPage >= MAX_PARAGRAPHS_PER_PAGE_HINT ||
      (paragraphsOnPage > 0 && pageTextBytes + textBytes > MAX_RENDERED_PAGE_TEXT_BYTES) ||
      (paragraphsOnPage > 0 && pageNodeEstimate + paragraphNodeEstimate > MAX_RENDERED_PAGE_NODES)
    )) {
      pageIndex += 1;
      paragraphsOnPage = 0;
      pageTextBytes = 0;
      pageNodeEstimate = 0;
    }
    const resolvedPage = fixedPage ?? pageIndex;
    const styleId = attributeByLocalName(pPr ? firstDescendant(pPr, 'pStyle') : undefined, 'val');
    const directOutline = Number.parseInt(
      attributeByLocalName(pPr ? firstDescendant(pPr, 'outlineLvl') : undefined, 'val'),
      10
    );
    const headingLevel =
      Number.isInteger(directOutline) && directOutline >= 0 && directOutline < 6
        ? directOutline + 1
        : styles.get(styleId)?.headingLevel;
    let list: ParsedDocxList | undefined;
    const numPr = pPr ? firstDescendant(pPr, 'numPr') : undefined;
    if (numPr) {
      const id = attributeByLocalName(firstDescendant(numPr, 'numId'), 'val');
      const rawLevel = Number.parseInt(attributeByLocalName(firstDescendant(numPr, 'ilvl'), 'val'), 10);
      const level = Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 8 ? rawLevel : 0;
      const definition = numbering.get(id)?.get(level);
      if (id && id !== '0' && definition) {
        const counters = listCounters.get(id) ?? [];
        counters.length = level + 1;
        const ordinal = counters[level] === undefined ? definition.start : (counters[level] ?? 0) + 1;
        counters[level] = ordinal;
        listCounters.set(id, counters);
        list = { id, level, ordered: definition.ordered, ordinal, style: definition.style };
      }
    }
    const rawAlignment = attributeByLocalName(
      pPr ? firstDescendant(pPr, 'jc') : undefined,
      'val'
    ).toLowerCase();
    const alignment = rawAlignment === 'center' || rawAlignment === 'right' || rawAlignment === 'both'
      ? rawAlignment === 'both' ? 'justify' : rawAlignment
      : undefined;
    const images: ParsedDocxImage[] = [];
    for (const blip of elementsByLocalName(paragraph, 'blip')) {
      if (imageCount >= MAX_IMAGES) break;
      const relationshipId = attributeByLocalName(blip, 'embed');
      const relationship = relationships.get(relationshipId);
      if (!relationship || relationship.external || !relationship.isImage) continue;
      const resource = entries.get(relationship.target.toLowerCase());
      if (!resource || resource.byteLength > MAX_IMAGE_BYTES) continue;
      const raster = inspectRaster(resource);
      if (!raster || imageBytes + resource.byteLength > MAX_BOOK_IMAGE_BYTES) continue;
      imageCount += 1;
      imageBytes += resource.byteLength;
      let drawing = blip.parentElement;
      while (drawing && drawing !== paragraph && normalizedLocalName(drawing) !== 'drawing') {
        drawing = drawing.parentElement;
      }
      const docProperties = drawing ? firstDescendant(drawing, 'docPr') : undefined;
      const alt = docProperties?.getAttribute('descr') ?? docProperties?.getAttribute('name') ?? '';
      images.push({ src: `data:${raster.mime};base64,${bytesToBase64(resource)}`, alt: alt.slice(0, 1_024) });
    }
    const parsed: ParsedDocxParagraph = {
      kind: 'paragraph',
      index: paragraphIndex++,
      text,
      pageIndex: resolvedPage,
      ...(headingLevel ? { headingLevel } : {}),
      ...(list ? { list } : {}),
      ...(alignment ? { alignment } : {}),
      ...(content.runs ? { runs: content.runs } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    if (headingLevel && text.trim()) {
      toc.push({ title: text.trim().slice(0, 1_024), paragraphIndex: parsed.index, pageIndex: resolvedPage, level: headingLevel - 1 });
    }
    if (fixedPage === undefined) {
      paragraphsOnPage += 1;
      pageTextBytes += textBytes;
      pageNodeEstimate += paragraphNodeEstimate + images.length;
      const hasPageBreak = elementsByLocalName(paragraph, 'br').some(
        (element) => attributeByLocalName(element, 'type') === 'page'
      );
      if (hasPageBreak && !leadingPageBreak) {
        pageIndex += 1;
        paragraphsOnPage = 0;
        pageTextBytes = 0;
        pageNodeEstimate = 0;
      }
    }
    return parsed;
  };

  const parseTable = (table: Element): ParsedDocxTable[] => {
    tableCount += 1;
    if (tableCount > MAX_TABLES) throw new Error('DOCX table count exceeds safety limit');
    const tables: ParsedDocxTable[] = [];
    let tablePage = pageIndex;
    let rows: ParsedDocxParagraph[][][] = [];
    const flushRows = (): void => {
      if (rows.length === 0) return;
      tables.push({ kind: 'table', pageIndex: tablePage, rows });
      rows = [];
    };
    for (const row of directChildrenByLocalName(table, 'tr')) {
      const rowCells = directChildrenByLocalName(row, 'tc');
      if (rowCells.length > MAX_TABLE_CELLS_PER_ROW) {
        throw new Error('DOCX table row exceeds cell safety limit');
      }
      const rowParagraphCount = elementsByLocalName(row, 'p').length;
      if (rowParagraphCount > MAX_TABLE_PARAGRAPHS_PER_ROW) {
        throw new Error('DOCX table row exceeds paragraph safety limit');
      }
      const rowTextBytes = encoder.encode(row.textContent).byteLength;
      const rowNodeEstimate = row.querySelectorAll('*').length;
      if (rowTextBytes > MAX_RENDERED_PAGE_TEXT_BYTES || rowNodeEstimate > MAX_RENDERED_PAGE_NODES) {
        throw new Error('DOCX table row exceeds rendered-page safety limit');
      }
      if (
        (rows.length > 0 && (
          rows.length >= MAX_TABLE_ROWS_PER_PAGE ||
          pageTextBytes + rowTextBytes > MAX_RENDERED_PAGE_TEXT_BYTES ||
          pageNodeEstimate + rowNodeEstimate > MAX_RENDERED_PAGE_NODES ||
          paragraphsOnPage + rowParagraphCount > MAX_PARAGRAPHS_PER_PAGE_HINT
        )) ||
        (rows.length === 0 && paragraphsOnPage > 0 && (
          pageTextBytes + rowTextBytes > MAX_RENDERED_PAGE_TEXT_BYTES ||
          pageNodeEstimate + rowNodeEstimate > MAX_RENDERED_PAGE_NODES ||
          paragraphsOnPage + rowParagraphCount > MAX_PARAGRAPHS_PER_PAGE_HINT
        ))
      ) {
        flushRows();
        pageIndex += 1;
        tablePage = pageIndex;
        paragraphsOnPage = 0;
        pageTextBytes = 0;
        pageNodeEstimate = 0;
      }
      const cells: ParsedDocxParagraph[][] = [];
      for (const cell of rowCells) {
        tableCellCount += 1;
        if (tableCellCount > MAX_TABLE_CELLS) throw new Error('DOCX table cells exceed safety limit');
        const paragraphs: ParsedDocxParagraph[] = [];
        const visitCell = (element: Element): void => {
          if (normalizedLocalName(element) === 'p') {
            paragraphs.push(parseParagraph(element, tablePage));
            return;
          }
          for (const child of Array.from(element.children)) visitCell(child);
        };
        for (const child of Array.from(cell.children)) visitCell(child);
        cells.push(paragraphs);
      }
      rows.push(cells);
      paragraphsOnPage += Math.max(1, rowParagraphCount);
      pageTextBytes += rowTextBytes;
      pageNodeEstimate += rowNodeEstimate;
    }
    flushRows();
    return tables;
  };

  const visitBody = (element: Element): void => {
    const name = normalizedLocalName(element);
    if (name === 'p') {
      blocks.push(parseParagraph(element));
      return;
    }
    if (name === 'tbl') {
      blocks.push(...parseTable(element));
      return;
    }
    for (const child of Array.from(element.children)) visitBody(child);
  };
  for (const child of Array.from(body.children)) visitBody(child);

  return {
    blocks,
    toc,
    pageCount: Math.max(1, pageIndex + 1),
  };
}
