import { takeCodePointPrefix } from '@shared/agent-context';
import type {
  Annotation,
  DocumentAnchor,
  DocxAnnotationAnchor,
  EpubAnnotationAnchor,
  MarkdownAnnotationAnchor,
  MobiAnnotationAnchor,
  PdfAnnotationAnchor,
  PptxAnnotationAnchor,
} from '@shared/types/annotation';
import type {
  ChatSelectionDescriptor,
  DocxChatSelectionDescriptor,
  EpubChatSelectionDescriptor,
  MarkdownChatSelectionDescriptor,
  MobiChatSelectionDescriptor,
  PdfChatSelectionDescriptor,
  PptxChatSelectionDescriptor,
} from '@shared/types/document';
import type { ReaderSelection } from '../types';
import { boundedQuoteContext } from './dom-anchors';
import type { RectLike } from './note-pointer';

/**
 * What the floating selection toolbar acts on: a live text selection, or a
 * saved highlight reopened from its painted text.
 *
 * A saved anchor carries everything a selection does except, in one rare
 * case, a chat route: an EPUB anchor recorded without its spine href cannot
 * name the section main resolves the passage from, so its chat descriptor is
 * `null` and Ask AI explains why instead of attaching the wrong text.
 */
export type SelectionActionTarget = Omit<ReaderSelection, 'chatDescriptor'> & {
  readonly chatDescriptor: ChatSelectionDescriptor | null;
};

const SNIPPET_LENGTH = 500;

/** First and last saved segment, or the anchor itself when it has one span. */
function ends<T>(anchor: T & { readonly segments?: readonly T[] }): { readonly first: T; readonly last: T } {
  const segments = anchor.segments ?? [];
  return { first: segments[0] ?? anchor, last: segments[segments.length - 1] ?? anchor };
}

function pdfDescriptor(anchor: PdfAnnotationAnchor, snippet: string): PdfChatSelectionDescriptor {
  const { first, last } = ends<Omit<PdfAnnotationAnchor, 'format' | 'segments'>>(anchor);
  return {
    format: 'pdf',
    startPageIndex: first.pageIndex,
    endPageIndex: last.pageIndex,
    ...(first.pageLabel === undefined ? {} : { startPageLabel: first.pageLabel }),
    ...(last.pageLabel === undefined ? {} : { endPageLabel: last.pageLabel }),
    startQuote: boundedQuoteContext(first.quote),
    endQuote: boundedQuoteContext(last.quote),
    ...(first.textStart === undefined ? {} : { startTextOffset: first.textStart }),
    ...(last.textEnd === undefined ? {} : { endTextOffset: last.textEnd }),
    selectedTextSnippet: snippet,
  };
}

function markdownDescriptor(anchor: MarkdownAnnotationAnchor, snippet: string): MarkdownChatSelectionDescriptor {
  const { first, last } = ends<Omit<MarkdownAnnotationAnchor, 'format' | 'segments'>>(anchor);
  return {
    format: 'markdown',
    startBlockIndex: first.blockIndex,
    endBlockIndex: last.blockIndex,
    ...(first.lineIndex === undefined ? {} : { startLineIndex: first.lineIndex }),
    ...(last.lineIndex === undefined ? {} : { endLineIndex: last.lineIndex }),
    ...(first.headingId === undefined ? {} : { startHeadingId: first.headingId }),
    ...(last.headingId === undefined ? {} : { endHeadingId: last.headingId }),
    startQuote: boundedQuoteContext(first.quote),
    endQuote: boundedQuoteContext(last.quote),
    ...(first.characterStart === undefined ? {} : { startCharacterOffset: first.characterStart }),
    ...(last.characterEnd === undefined ? {} : { endCharacterOffset: last.characterEnd }),
    selectedTextSnippet: snippet,
  };
}

function paragraphDescriptor(
  anchor: DocxAnnotationAnchor | PptxAnnotationAnchor,
  snippet: string
): DocxChatSelectionDescriptor | PptxChatSelectionDescriptor {
  const { first, last } = ends<Omit<DocxAnnotationAnchor, 'format' | 'segments'>>(anchor);
  return {
    format: anchor.format,
    startParagraphIndex: first.paragraphIndex,
    endParagraphIndex: last.paragraphIndex,
    ...(first.renderedPageIndex === undefined ? {} : { startRenderedPageIndex: first.renderedPageIndex }),
    ...(last.renderedPageIndex === undefined ? {} : { endRenderedPageIndex: last.renderedPageIndex }),
    startQuote: boundedQuoteContext(first.quote),
    endQuote: boundedQuoteContext(last.quote),
    ...(first.characterStart === undefined ? {} : { startCharacterOffset: first.characterStart }),
    ...(last.characterEnd === undefined ? {} : { endCharacterOffset: last.characterEnd }),
    selectedTextSnippet: snippet,
  };
}

function epubDescriptor(anchor: EpubAnnotationAnchor, snippet: string): EpubChatSelectionDescriptor | null {
  const { first, last } = ends<Omit<EpubAnnotationAnchor, 'format' | 'segments'>>(anchor);
  // A segment without its own href lies in the anchor's section.
  const startSpineHref = first.spineHref ?? anchor.spineHref;
  const endSpineHref = last.spineHref ?? anchor.spineHref;
  if (startSpineHref === undefined || endSpineHref === undefined) return null;
  return {
    format: 'epub',
    startSpineHref,
    endSpineHref,
    startCfi: first.cfi,
    endCfi: last.cfi,
    ...(first.progression === undefined ? {} : { startProgression: first.progression }),
    ...(last.progression === undefined ? {} : { endProgression: last.progression }),
    startQuote: boundedQuoteContext(first.quote),
    endQuote: boundedQuoteContext(last.quote),
    selectedTextSnippet: snippet,
  };
}

function mobiDescriptor(anchor: MobiAnnotationAnchor, snippet: string): MobiChatSelectionDescriptor {
  const { first, last } = ends<Omit<MobiAnnotationAnchor, 'format' | 'segments'>>(anchor);
  return {
    format: 'mobi',
    startSectionIndex: first.sectionIndex,
    endSectionIndex: last.sectionIndex,
    startQuote: boundedQuoteContext(first.quote),
    endQuote: boundedQuoteContext(last.quote),
    ...(first.textStart === undefined ? {} : { startOffset: first.textStart }),
    ...(last.textEnd === undefined ? {} : { endOffset: last.textEnd }),
    selectedTextSnippet: snippet,
  };
}

/**
 * The chat descriptor a live selection of the same saved passage would have
 * produced, so Ask AI goes through the existing context flow and main
 * resolves the full passage from its own document index — never from the
 * renderer's copy of the text.
 */
export function chatDescriptorFromAnchor(anchor: DocumentAnchor, text: string): ChatSelectionDescriptor | null {
  const snippet = takeCodePointPrefix(text, SNIPPET_LENGTH);
  switch (anchor.format) {
    case 'pdf': return pdfDescriptor(anchor, snippet);
    case 'markdown': return markdownDescriptor(anchor, snippet);
    case 'docx':
    case 'pptx': return paragraphDescriptor(anchor, snippet);
    case 'epub': return epubDescriptor(anchor, snippet);
    case 'mobi': return mobiDescriptor(anchor, snippet);
  }
}

/** The toolbar target for a saved highlight anchored at a painted fragment. */
export function savedHighlightTarget(annotation: Annotation, rect: RectLike): SelectionActionTarget {
  const selectedText = annotation.selectedText ?? annotation.anchor.quote.exact;
  return {
    selectedText,
    totalSelectedLength: selectedText.length,
    chatDescriptor: chatDescriptorFromAnchor(annotation.anchor, selectedText),
    anchor: annotation.anchor,
    clientRect: {
      left: rect.left,
      top: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    },
  };
}
