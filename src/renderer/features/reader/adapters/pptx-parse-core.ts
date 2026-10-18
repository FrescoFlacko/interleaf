import type {
  ParsedDocxBlock,
  ParsedDocxImage,
  ParsedDocxList,
  ParsedDocxParagraph,
  ParsedDocxPayload,
  ParsedDocxRun,
} from './docx-parse-core';
import {
  attributeByLocalName,
  directChildrenByLocalName,
  firstDescendant,
  inspectContentTypes,
  normalizedLocalName,
  openOoxmlPackage,
  parseRelationships,
  parseXml,
  readBoundedXml,
  type OoxmlRelationship,
} from './ooxml-package';
import { bytesToBase64, inspectRaster } from './ooxml-raster';

/**
 * Converts a PowerPoint package into the inert paragraph model the DOCX
 * reader renders. Each slide becomes one rendered page; its title comes first,
 * followed by text boxes, tables and pictures in shape-tree order. Speaker
 * notes, layouts, masters, theme styling, positioning, animation, transitions
 * and every kind of media or embedded object are deliberately not read.
 */
const MAX_PART_XML_BYTES = 16 * 1024 * 1024;
const MAX_AUX_XML_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_SINGLE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_SLIDES = 2_000;
const MAX_PARAGRAPHS = 100_000;
const MAX_PARAGRAPH_TEXT = 256 * 1024;
const MAX_RUNS_PER_PARAGRAPH = 2_000;
const MAX_TOTAL_TEXT = 32 * 1024 * 1024;
const MAX_SLIDE_TEXT_BYTES = 512 * 1024;
const MAX_SLIDE_NODES = 10_000;
const MAX_TABLE_CELLS = 100_000;
const MAX_TABLE_CELLS_PER_ROW = 128;
const MAX_GROUP_DEPTH = 32;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DECK_IMAGE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGES = 2_000;

export const PPTX_PARSE_LIMITS = Object.freeze({
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxArchiveUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  maxSlides: MAX_SLIDES,
  maxParagraphs: MAX_PARAGRAPHS,
  maxSlideTextBytes: MAX_SLIDE_TEXT_BYTES,
  maxSlideNodes: MAX_SLIDE_NODES,
  maxTotalTextBytes: MAX_TOTAL_TEXT,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxDeckImageBytes: MAX_DECK_IMAGE_BYTES,
  maxImages: MAX_IMAGES,
});

const PRESENTATION_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrtitle']);
const encoder = new TextEncoder();

type RunStyle = Omit<ParsedDocxRun, 'text'>;
type MutableRun = { text: string } & RunStyle;
type ShapeKind = 'title' | 'bulleted' | 'plain';

type DeckState = {
  paragraphIndex: number;
  totalTextBytes: number;
  tableCells: number;
  imageCount: number;
  imageBytes: number;
};

type SlideContext = {
  readonly slideIndex: number;
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly relationships: ReadonlyMap<string, OoxmlRelationship>;
  readonly deck: DeckState;
  textBytes: number;
  nodes: number;
  shapeOrdinal: number;
};

function directoryOf(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator >= 0 ? path.slice(0, separator) : '';
}

function relationshipsPathFor(part: string): string {
  const directory = directoryOf(part);
  const name = part.slice(directory.length ? directory.length + 1 : 0);
  return `${directory ? `${directory}/` : ''}_rels/${name}.rels`;
}

/** `p:sldId` carries both `id` and `r:id`; only the prefixed one names a relationship. */
function prefixedAttribute(element: Element, localName: string): string {
  const attribute = Array.from(element.attributes).find(
    (candidate) => candidate.name.includes(':') && normalizedLocalName(candidate) === localName
  );
  return attribute?.value ?? '';
}

function packageRelationships(
  entries: ReadonlyMap<string, Uint8Array>,
  part: string
): Map<string, OoxmlRelationship> {
  const path = relationshipsPathFor(part);
  return parseRelationships(readBoundedXml(entries, path, MAX_AUX_XML_BYTES, 'PPTX'), {
    collectDocumentResources: true,
    label: path,
    kind: 'PPTX',
    baseDirectory: directoryOf(part),
    allowRootRelative: true,
  });
}

function booleanAttribute(element: Element | undefined, name: string): boolean {
  const value = attributeByLocalName(element, name).toLowerCase();
  return value === '1' || value === 'true';
}

function hasEnabledValue(element: Element, name: string, disabledValue: string): boolean {
  const value = attributeByLocalName(element, name);
  return value !== '' && value !== disabledValue;
}

function verticalAlign(properties: Element): ParsedDocxRun['verticalAlign'] {
  const baseline = Number.parseInt(attributeByLocalName(properties, 'baseline'), 10);
  if (!Number.isFinite(baseline) || baseline === 0) return undefined;
  return baseline > 0 ? 'superscript' : 'subscript';
}

function runStyle(properties: Element | undefined): RunStyle {
  if (!properties) return {};
  const align = verticalAlign(properties);
  return {
    ...(booleanAttribute(properties, 'b') ? { bold: true } : {}),
    ...(booleanAttribute(properties, 'i') ? { italic: true } : {}),
    ...(hasEnabledValue(properties, 'u', 'none') ? { underline: true } : {}),
    ...(hasEnabledValue(properties, 'strike', 'noStrike') ? { strike: true } : {}),
    ...(align ? { verticalAlign: align } : {}),
  };
}

function styleKey(style: RunStyle): string {
  return `${String(Boolean(style.bold))}:${String(Boolean(style.italic))}:${String(Boolean(style.underline))}:${String(Boolean(style.strike))}:${style.verticalAlign ?? ''}`;
}

const MAX_LINE_BREAKS_PER_PARAGRAPH = 256;
const TEXT_RUN_NAMES: ReadonlySet<string> = new Set(['r', 'fld']);

type RunCollector = {
  text: string;
  breaks: number;
  formatted: boolean;
  overflow: boolean;
  readonly runs: MutableRun[];
};

/** A paragraph child's text and style; line breaks beyond the budget contribute nothing. */
function runSegment(child: Element, collector: RunCollector): { readonly segment: string; readonly style: RunStyle } {
  const name = normalizedLocalName(child);
  if (TEXT_RUN_NAMES.has(name)) {
    return {
      segment: directChildrenByLocalName(child, 't').map((node) => node.textContent).join(''),
      style: runStyle(directChildrenByLocalName(child, 'rPr')[0]),
    };
  }
  const isBreak = name === 'br' && collector.breaks++ < MAX_LINE_BREAKS_PER_PARAGRAPH;
  return { segment: isBreak ? '\n' : '', style: {} };
}

function appendRun(collector: RunCollector, segment: string, style: RunStyle): void {
  collector.text += segment;
  const previous = collector.runs.at(-1);
  if (previous && styleKey(previous) === styleKey(style)) previous.text += segment;
  else if (collector.runs.length < MAX_RUNS_PER_PARAGRAPH) collector.runs.push({ text: segment, ...style });
  else collector.overflow = true;
  if (Object.keys(style).length > 0) collector.formatted = true;
}

function paragraphRuns(paragraph: Element): { readonly text: string; readonly runs?: readonly ParsedDocxRun[] } {
  const collector: RunCollector = { text: '', breaks: 0, formatted: false, overflow: false, runs: [] };
  for (const child of Array.from(paragraph.children)) {
    const { segment, style } = runSegment(child, collector);
    if (segment) appendRun(collector, segment, style);
  }
  const keepRuns = collector.formatted && !collector.overflow;
  return { text: collector.text, ...(keepRuns ? { runs: collector.runs } : {}) };
}

function numberingStyle(type: string): ParsedDocxList['style'] {
  if (type.startsWith('alphaLc')) return 'lower-alpha';
  if (type.startsWith('alphaUc')) return 'upper-alpha';
  if (type.startsWith('romanLc')) return 'lower-roman';
  if (type.startsWith('romanUc')) return 'upper-roman';
  return 'decimal';
}

function chargeSlide(context: SlideContext, textBytes: number, nodes: number): void {
  context.textBytes += textBytes;
  context.nodes += nodes;
  if (context.textBytes > MAX_SLIDE_TEXT_BYTES || context.nodes > MAX_SLIDE_NODES) {
    throw new Error(`Invalid PPTX: slide ${String(context.slideIndex + 1)} exceeds rendering safety limits`);
  }
}

function makeParagraph(
  context: SlideContext,
  content: { readonly text: string; readonly runs?: readonly ParsedDocxRun[] },
  extras: Omit<ParsedDocxParagraph, 'kind' | 'index' | 'text' | 'pageIndex' | 'runs'>
): ParsedDocxParagraph {
  const deck = context.deck;
  if (deck.paragraphIndex >= MAX_PARAGRAPHS) throw new Error('Invalid PPTX: paragraph count exceeds safety limit');
  const textBytes = encoder.encode(content.text).byteLength;
  if (textBytes > MAX_PARAGRAPH_TEXT) throw new Error('Invalid PPTX: paragraph exceeds text safety limit');
  deck.totalTextBytes += textBytes;
  if (deck.totalTextBytes > MAX_TOTAL_TEXT) throw new Error('Invalid PPTX: text exceeds safety limit');
  chargeSlide(context, textBytes, 1 + (content.runs?.length ?? 1) + (extras.images?.length ?? 0));
  return {
    kind: 'paragraph',
    index: deck.paragraphIndex++,
    text: content.text,
    pageIndex: context.slideIndex,
    ...extras,
    ...(content.runs ? { runs: content.runs } : {}),
  };
}

const PARAGRAPH_ALIGNMENTS: ReadonlyMap<string, NonNullable<ParsedDocxParagraph['alignment']>> = new Map([
  ['ctr', 'center'],
  ['r', 'right'],
  ['just', 'justify'],
]);

function paragraphLevel(properties: Element | undefined): number {
  const rawLevel = Number.parseInt(attributeByLocalName(properties, 'lvl'), 10);
  return Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 8 ? rawLevel : 0;
}

function bulletProperty(properties: Element | undefined, localName: string): Element | undefined {
  return properties ? directChildrenByLocalName(properties, localName)[0] : undefined;
}

function autoNumberStart(autoNumber: Element): number {
  const startAt = Number.parseInt(attributeByLocalName(autoNumber, 'startAt'), 10);
  return Number.isInteger(startAt) && startAt > 0 && startAt < 100_000 ? startAt : 1;
}

type ListScope = { readonly id: string; readonly counters: number[] };

function orderedListItem(scope: ListScope, level: number, autoNumber: Element): ParsedDocxList {
  const previous = scope.counters[level];
  const ordinal = previous === undefined ? autoNumberStart(autoNumber) : previous + 1;
  scope.counters[level] = ordinal;
  return { id: scope.id, level, ordered: true, ordinal, style: numberingStyle(attributeByLocalName(autoNumber, 'type')) };
}

/** List membership for one paragraph; numbering counters restart whenever the list is interrupted. */
function paragraphList(scope: ListScope, properties: Element | undefined, level: number, kind: ShapeKind): ParsedDocxList | undefined {
  scope.counters.length = level + 1;
  const listed = kind !== 'title' && !bulletProperty(properties, 'buNone');
  const autoNumber = listed ? bulletProperty(properties, 'buAutoNum') : undefined;
  if (autoNumber) return orderedListItem(scope, level, autoNumber);
  if (listed && (kind === 'bulleted' || bulletProperty(properties, 'buChar'))) {
    scope.counters.length = level;
    return { id: scope.id, level, ordered: false, ordinal: 1, style: 'disc' };
  }
  scope.counters.length = 0;
  return undefined;
}

function textBodyParagraphs(
  context: SlideContext,
  body: Element | undefined,
  kind: ShapeKind
): ParsedDocxParagraph[] {
  if (!body) return [];
  const scope: ListScope = { id: `slide-${String(context.slideIndex)}-shape-${String(context.shapeOrdinal++)}`, counters: [] };
  const paragraphs: ParsedDocxParagraph[] = [];
  for (const paragraph of directChildrenByLocalName(body, 'p')) {
    const content = paragraphRuns(paragraph);
    if (!content.text.trim()) continue;
    const properties = directChildrenByLocalName(paragraph, 'pPr')[0];
    const list = paragraphList(scope, properties, paragraphLevel(properties), kind);
    const alignment = PARAGRAPH_ALIGNMENTS.get(attributeByLocalName(properties, 'algn'));
    paragraphs.push(makeParagraph(context, content, {
      ...(kind === 'title' ? { headingLevel: 2 } : {}),
      ...(list ? { list } : {}),
      ...(alignment ? { alignment } : {}),
    }));
  }
  return paragraphs;
}

function shapeKind(shape: Element): ShapeKind {
  const properties = directChildrenByLocalName(shape, 'nvSpPr')[0];
  const application = properties ? directChildrenByLocalName(properties, 'nvPr')[0] : undefined;
  const placeholder = application ? directChildrenByLocalName(application, 'ph')[0] : undefined;
  if (!placeholder) return 'plain';
  const type = attributeByLocalName(placeholder, 'type').toLowerCase();
  if (TITLE_PLACEHOLDERS.has(type)) return 'title';
  // Untyped placeholders are content ("obj") placeholders, which the default
  // slide masters bullet. Inherited master styling is otherwise not applied.
  return type === '' || type === 'obj' ? 'bulleted' : 'plain';
}

function tableBlock(context: SlideContext, table: Element): ParsedDocxBlock | null {
  const rows: ParsedDocxParagraph[][][] = [];
  for (const row of directChildrenByLocalName(table, 'tr')) {
    const cells: ParsedDocxParagraph[][] = [];
    for (const cell of directChildrenByLocalName(row, 'tc')) {
      if (booleanAttribute(cell, 'hMerge') || booleanAttribute(cell, 'vMerge')) continue;
      if (cells.length >= MAX_TABLE_CELLS_PER_ROW) throw new Error('Invalid PPTX: table row exceeds safety limit');
      context.deck.tableCells += 1;
      if (context.deck.tableCells > MAX_TABLE_CELLS) throw new Error('Invalid PPTX: table cells exceed safety limit');
      chargeSlide(context, 0, 1);
      cells.push(textBodyParagraphs(context, directChildrenByLocalName(cell, 'txBody')[0], 'plain'));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? { kind: 'table', pageIndex: context.slideIndex, rows } : null;
}

/** The package-internal bytes a picture embeds, when they are an admissible image resource. */
function pictureResource(context: SlideContext, picture: Element): Uint8Array | null {
  const fill = directChildrenByLocalName(picture, 'blipFill')[0];
  const blip = fill ? directChildrenByLocalName(fill, 'blip')[0] : undefined;
  if (!blip) return null;
  const relationship = context.relationships.get(prefixedAttribute(blip, 'embed'));
  if (!relationship || relationship.external || !relationship.isImage) return null;
  const resource = context.entries.get(relationship.target.toLowerCase());
  return resource && resource.byteLength <= MAX_IMAGE_BYTES ? resource : null;
}

function pictureAlt(picture: Element): string {
  const properties = firstDescendant(picture, 'cNvPr');
  return (properties?.getAttribute('descr') ?? properties?.getAttribute('name') ?? '').slice(0, 1_024);
}

function pictureImage(context: SlideContext, picture: Element): ParsedDocxImage | null {
  const deck = context.deck;
  if (deck.imageCount >= MAX_IMAGES) return null;
  const resource = pictureResource(context, picture);
  const raster = resource ? inspectRaster(resource) : null;
  if (!resource || !raster || deck.imageBytes + resource.byteLength > MAX_DECK_IMAGE_BYTES) return null;
  deck.imageCount += 1;
  deck.imageBytes += resource.byteLength;
  return { src: `data:${raster.mime};base64,${bytesToBase64(resource)}`, alt: pictureAlt(picture) };
}

const DRAWABLE_SHAPES: ReadonlySet<string> = new Set(['sp', 'graphicFrame', 'pic']);

/** The container whose children a grouping element contributes, or `undefined` when it is not a group. */
function groupContents(element: Element, name: string): Element | undefined {
  if (name === 'grpSp') return element;
  return name === 'AlternateContent' ? directChildrenByLocalName(element, 'Fallback')[0] : undefined;
}

/** Flattens a shape tree into drawable shapes; only the fallback branch of markup-compatibility content is read. */
function collectShapes(container: Element, depth: number, into: Element[]): void {
  if (depth > MAX_GROUP_DEPTH) throw new Error('Invalid PPTX: shape groups are nested too deeply');
  for (const child of Array.from(container.children)) {
    const name = normalizedLocalName(child);
    const group = groupContents(child, name);
    if (group) collectShapes(group, depth + 1, into);
    else if (DRAWABLE_SHAPES.has(name)) into.push(child);
  }
}

type SlideAccumulator = { readonly blocks: ParsedDocxBlock[]; title: string };

function appendTextShape(context: SlideContext, shape: Element, slide: SlideAccumulator): void {
  const kind = shapeKind(shape);
  const paragraphs = textBodyParagraphs(context, directChildrenByLocalName(shape, 'txBody')[0], kind);
  if (kind === 'title' && !slide.title) slide.title = paragraphs.map((paragraph) => paragraph.text.trim()).join(' ');
  slide.blocks.push(...paragraphs);
}

function appendGraphicFrame(context: SlideContext, shape: Element, slide: SlideAccumulator): void {
  const table = firstDescendant(shape, 'tbl');
  const block = table ? tableBlock(context, table) : null;
  if (block) slide.blocks.push(block);
}

function appendPicture(context: SlideContext, shape: Element, slide: SlideAccumulator): void {
  const image = pictureImage(context, shape);
  if (image) slide.blocks.push(makeParagraph(context, { text: '' }, { images: [image] }));
}

const SHAPE_APPENDERS: ReadonlyMap<string, (context: SlideContext, shape: Element, slide: SlideAccumulator) => void> = new Map([
  ['sp', appendTextShape],
  ['graphicFrame', appendGraphicFrame],
  ['pic', appendPicture],
]);

function isTitleShape(shape: Element): boolean {
  return normalizedLocalName(shape) === 'sp' && shapeKind(shape) === 'title';
}

function slideBlocks(context: SlideContext, slide: Document): { blocks: ParsedDocxBlock[]; title: string } {
  const tree = firstDescendant(firstDescendant(slide, 'cSld') ?? slide, 'spTree');
  const shapes: Element[] = [];
  if (tree) collectShapes(tree, 0, shapes);
  const titles = shapes.filter(isTitleShape);
  const ordered = [...titles, ...shapes.filter((shape) => !titles.includes(shape))];
  const accumulator: SlideAccumulator = { blocks: [], title: '' };
  for (const shape of ordered) SHAPE_APPENDERS.get(normalizedLocalName(shape))?.(context, shape, accumulator);
  if (accumulator.blocks.length === 0) accumulator.blocks.push(makeParagraph(context, { text: '' }, {}));
  return { blocks: accumulator.blocks, title: accumulator.title.replace(/\s+/g, ' ').trim().slice(0, 1_024) };
}

function firstParagraphIndex(blocks: readonly ParsedDocxBlock[]): number {
  for (const block of blocks) {
    if (block.kind === 'paragraph') return block.index;
    for (const row of block.rows) for (const cell of row) if (cell[0]) return cell[0].index;
  }
  return 0;
}

function presentationPart(entries: ReadonlyMap<string, Uint8Array>): { readonly part: string; readonly source: string } {
  const rootRelationships = parseRelationships(readBoundedXml(entries, '_rels/.rels', MAX_AUX_XML_BYTES, 'PPTX'), {
    collectDocumentResources: true,
    label: '_rels/.rels',
    kind: 'PPTX',
    baseDirectory: '',
    allowRootRelative: true,
  });
  const main = Array.from(rootRelationships.values()).find(
    (relationship) => !relationship.external && /\/officeDocument$/i.test(relationship.type)
  );
  const source = main ? readBoundedXml(entries, main.target, MAX_AUX_XML_BYTES, 'PPTX') : null;
  if (!main || !source) throw new Error('Invalid PPTX: presentation part is missing');
  return { part: main.target, source };
}

function isSlideRelationship(relationship: OoxmlRelationship | undefined): relationship is OoxmlRelationship {
  return relationship !== undefined && !relationship.external && /\/slide$/i.test(relationship.type);
}

function slidePartsInOrder(entries: ReadonlyMap<string, Uint8Array>): readonly string[] {
  const { part, source } = presentationPart(entries);
  const presentation = parseXml(source, part, 'PPTX');
  const relationships = packageRelationships(entries, part);
  const list = firstDescendant(presentation, 'sldIdLst');
  const slideIds = list ? directChildrenByLocalName(list, 'sldId') : [];
  if (slideIds.length > MAX_SLIDES) throw new Error('Invalid PPTX: slide count exceeds safety limit');
  const parts: string[] = [];
  for (const slideId of slideIds) {
    const relationship = relationships.get(prefixedAttribute(slideId, 'id'));
    if (!isSlideRelationship(relationship)) throw new Error('Invalid PPTX: slide list references a missing slide');
    if (parts.includes(relationship.target)) throw new Error('Invalid PPTX: slide list repeats a slide');
    parts.push(relationship.target);
  }
  return parts;
}

function openPresentationPackage(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const { entries, contentTypes } = openOoxmlPackage(bytes, 'PPTX', {
    maxEntries: MAX_ARCHIVE_ENTRIES,
    maxTotalUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    maxSingleEntryBytes: MAX_SINGLE_ENTRY_BYTES,
    maxContentTypesBytes: MAX_AUX_XML_BYTES,
  });
  if (!contentTypes) throw new Error('Invalid PPTX: required OOXML parts are missing');
  if (!inspectContentTypes(contentTypes, 'PPTX').has(PRESENTATION_MAIN_CONTENT_TYPE)) {
    throw new Error('Invalid PPTX: this package is not a PowerPoint presentation');
  }
  // Every relationship part is screened for active content before any slide is read.
  for (const [path] of entries) {
    if (!path.endsWith('.rels')) continue;
    parseRelationships(readBoundedXml(entries, path, MAX_AUX_XML_BYTES, 'PPTX'), {
      collectDocumentResources: false,
      label: path,
      kind: 'PPTX',
      baseDirectory: '',
    });
  }
  return entries;
}

function slideContext(
  slideIndex: number,
  entries: ReadonlyMap<string, Uint8Array>,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  deck: DeckState
): SlideContext {
  return { slideIndex, entries, relationships, deck, textBytes: 0, nodes: 0, shapeOrdinal: 0 };
}

export function parsePptxArchive(bytes: Uint8Array): ParsedDocxPayload {
  const entries = openPresentationPackage(bytes);
  const deck: DeckState = { paragraphIndex: 0, totalTextBytes: 0, tableCells: 0, imageCount: 0, imageBytes: 0 };
  const blocks: ParsedDocxBlock[] = [];
  const toc: ParsedDocxPayload['toc'][number][] = [];
  const parts = slidePartsInOrder(entries);
  parts.forEach((part, slideIndex) => {
    const source = readBoundedXml(entries, part, MAX_PART_XML_BYTES, 'PPTX');
    if (!source) throw new Error('Invalid PPTX: slide list references a missing slide');
    const context = slideContext(slideIndex, entries, packageRelationships(entries, part), deck);
    const slide = slideBlocks(context, parseXml(source, part, 'PPTX'));
    toc.push({
      title: slide.title || `Slide ${String(slideIndex + 1)}`,
      paragraphIndex: firstParagraphIndex(slide.blocks),
      pageIndex: slideIndex,
      level: 0,
    });
    blocks.push(...slide.blocks);
  });
  if (parts.length === 0) {
    blocks.push(makeParagraph(slideContext(0, entries, new Map(), deck), { text: '' }, {}));
  }
  return { blocks, toc, pageCount: Math.max(1, parts.length) };
}
