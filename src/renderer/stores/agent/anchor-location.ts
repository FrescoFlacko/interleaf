import type {
  DocumentAnchor,
  DocxAnnotationAnchor,
  EpubAnnotationAnchor,
  MarkdownAnnotationAnchor,
  MobiAnnotationAnchor,
  PdfAnnotationAnchor,
  PptxAnnotationAnchor,
  QuoteContext,
} from '@shared/types/annotation';
import type {
  DocumentFormat,
  DocumentLocation,
  DocxLocation,
  EpubLocation,
  MarkdownLocation,
  MobiLocation,
  PdfLocation,
  PptxLocation,
} from '@shared/types/document';
import { InterleafError } from '@shared/errors/interleaf-error';

type TextRange = { readonly textStart: number; readonly textEnd: number };
type NoTextRange = { readonly textStart?: never; readonly textEnd?: never };
type CharacterRange = { readonly characterStart: number; readonly characterEnd: number };
type NoCharacterRange = { readonly characterStart?: never; readonly characterEnd?: never };

function textRange(value: { readonly textStart?: number; readonly textEnd?: number }): TextRange | NoTextRange {
  return value.textStart !== undefined && value.textEnd !== undefined
    ? { textStart: value.textStart, textEnd: value.textEnd }
    : {};
}

function characterRange(value: { readonly characterStart?: number; readonly characterEnd?: number }): CharacterRange | NoCharacterRange {
  return value.characterStart !== undefined && value.characterEnd !== undefined
    ? { characterStart: value.characterStart, characterEnd: value.characterEnd }
    : {};
}

function pdfAnchor(location: PdfLocation, quote: QuoteContext): PdfAnnotationAnchor {
  return {
    format: 'pdf',
    quote,
    pageIndex: location.pageIndex,
    ...(location.pageLabel !== undefined ? { pageLabel: location.pageLabel } : {}),
    ...textRange(location),
  };
}

function markdownAnchor(location: MarkdownLocation, quote: QuoteContext): MarkdownAnnotationAnchor {
  return {
    format: 'markdown',
    quote,
    blockIndex: location.blockIndex,
    ...characterRange(location),
    ...(location.lineIndex !== undefined ? { lineIndex: location.lineIndex } : {}),
    ...(location.headingId !== undefined ? { headingId: location.headingId } : {}),
  };
}

function epubAnchor(location: EpubLocation, quote: QuoteContext): EpubAnnotationAnchor {
  return {
    format: 'epub',
    quote,
    cfi: location.cfi,
    ...(location.spineHref !== undefined ? { spineHref: location.spineHref } : {}),
    ...(location.progression !== undefined ? { progression: location.progression } : {}),
    ...textRange(location),
  };
}

function paragraphAnchor(location: DocxLocation | PptxLocation, quote: QuoteContext): DocxAnnotationAnchor | PptxAnnotationAnchor {
  return {
    format: location.format,
    quote,
    paragraphIndex: location.paragraphIndex,
    ...characterRange(location),
    ...(location.renderedPageIndex !== undefined ? { renderedPageIndex: location.renderedPageIndex } : {}),
  };
}

function mobiAnchor(location: MobiLocation, quote: QuoteContext): MobiAnnotationAnchor {
  return {
    format: 'mobi',
    quote,
    sectionIndex: location.sectionIndex,
    ...(location.byteOffset !== undefined ? { byteOffset: location.byteOffset } : {}),
    ...(location.progression !== undefined ? { progression: location.progression } : {}),
    ...textRange(location),
  };
}

function anchorForLocation(location: DocumentLocation, quote: QuoteContext): DocumentAnchor {
  switch (location.format) {
    case 'pdf': return pdfAnchor(location, quote);
    case 'markdown': return markdownAnchor(location, quote);
    case 'epub': return epubAnchor(location, quote);
    case 'mobi': return mobiAnchor(location, quote);
    default: return paragraphAnchor(location, quote);
  }
}

/** Builds the anchor for agent context that has a reader location but no live selection anchor. */
export function buildFallbackAnchor(format: DocumentFormat, location: DocumentLocation, text: string, includeQuoteText = true): DocumentAnchor {
  if (format !== location.format) {
    throw new InterleafError('validation', 'Agent context anchor and location formats must match.');
  }
  const quote = includeQuoteText
    ? { exact: text || 'Document context', prefix: '', suffix: '' }
    : { exact: '', prefix: '', suffix: '' };
  return anchorForLocation(location, quote);
}

function markdownLocation(anchor: MarkdownAnnotationAnchor): MarkdownLocation {
  return {
    format: 'markdown',
    blockIndex: anchor.blockIndex,
    ...(anchor.characterStart !== undefined ? { characterStart: anchor.characterStart } : {}),
    ...(anchor.characterEnd !== undefined ? { characterEnd: anchor.characterEnd } : {}),
    ...(anchor.lineIndex !== undefined ? { lineIndex: anchor.lineIndex } : {}),
    ...(anchor.headingId !== undefined ? { headingId: anchor.headingId } : {}),
  };
}

function epubLocation(anchor: EpubAnnotationAnchor): EpubLocation {
  return {
    format: 'epub',
    cfi: anchor.cfi,
    ...(anchor.spineHref !== undefined ? { spineHref: anchor.spineHref } : {}),
    ...(anchor.progression !== undefined ? { progression: anchor.progression } : {}),
  };
}

function mobiLocation(anchor: MobiAnnotationAnchor): MobiLocation {
  return {
    format: 'mobi',
    sectionIndex: anchor.sectionIndex,
    ...(anchor.byteOffset !== undefined ? { byteOffset: anchor.byteOffset } : {}),
    ...(anchor.progression !== undefined ? { progression: anchor.progression } : {}),
  };
}

/** Recovers the navigable reader location an agent context anchor points at. */
export function anchorToLocation(anchor: DocumentAnchor): DocumentLocation {
  switch (anchor.format) {
    case 'pdf': return { format: 'pdf', pageIndex: anchor.pageIndex, ...(anchor.pageLabel !== undefined ? { pageLabel: anchor.pageLabel } : {}) };
    case 'epub': return epubLocation(anchor);
    case 'mobi': return mobiLocation(anchor);
    case 'markdown': return markdownLocation(anchor);
    default: return { format: anchor.format, paragraphIndex: anchor.paragraphIndex, ...(anchor.renderedPageIndex !== undefined ? { renderedPageIndex: anchor.renderedPageIndex } : {}) };
  }
}
