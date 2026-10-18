import { hasParagraphFormat, type ParagraphFormat } from '@shared/document-format-family';
import type { ChatSelectionDescriptor, DocumentLocation } from '@shared/types/document';

type ParagraphDescriptor = Extract<ChatSelectionDescriptor, { readonly format: ParagraphFormat }>;

/** Whether a selection crosses its format's navigation unit (page, paragraph, block, section). */
export function descriptorSpansMultipleUnits(descriptor: ChatSelectionDescriptor): boolean {
  if (descriptor.format === 'pdf') return descriptor.startPageIndex !== descriptor.endPageIndex;
  if (hasParagraphFormat(descriptor)) return descriptor.startParagraphIndex !== descriptor.endParagraphIndex;
  if (descriptor.format === 'markdown') return descriptor.startBlockIndex !== descriptor.endBlockIndex;
  if (descriptor.format === 'mobi') return descriptor.startSectionIndex !== descriptor.endSectionIndex;
  return descriptor.startSpineHref !== descriptor.endSpineHref;
}

function paragraphDisplayLabel(descriptor: ParagraphDescriptor): string {
  if (descriptor.format === 'pptx' && descriptor.startRenderedPageIndex !== undefined) {
    const start = descriptor.startRenderedPageIndex + 1;
    const end = (descriptor.endRenderedPageIndex ?? descriptor.startRenderedPageIndex) + 1;
    return start === end ? `Slide ${String(start)}` : `Slides ${String(start)}–${String(end)}`;
  }
  return descriptor.startParagraphIndex === descriptor.endParagraphIndex
    ? `Paragraph ${String(descriptor.startParagraphIndex + 1)}`
    : `Paragraphs ${String(descriptor.startParagraphIndex + 1)}–${String(descriptor.endParagraphIndex + 1)}`;
}

export function descriptorToLocation(descriptor: ChatSelectionDescriptor): DocumentLocation {
  if (descriptor.format === 'pdf') {
    return {
      format: 'pdf',
      pageIndex: descriptor.startPageIndex,
      ...(descriptor.startPageLabel ? { pageLabel: descriptor.startPageLabel } : {}),
      ...(descriptor.startTextOffset !== undefined && descriptor.endTextOffset !== undefined && descriptor.startPageIndex === descriptor.endPageIndex
        ? { textStart: descriptor.startTextOffset, textEnd: descriptor.endTextOffset }
        : {}),
    };
  }
  if (hasParagraphFormat(descriptor)) {
    return {
      format: descriptor.format,
      paragraphIndex: descriptor.startParagraphIndex,
      ...(descriptor.startCharacterOffset !== undefined ? { characterStart: descriptor.startCharacterOffset } : {}),
      ...(descriptor.endCharacterOffset !== undefined ? { characterEnd: descriptor.endCharacterOffset } : {}),
      ...(descriptor.startRenderedPageIndex !== undefined ? { renderedPageIndex: descriptor.startRenderedPageIndex } : {}),
    };
  }
  if (descriptor.format === 'mobi') {
    return {
      format: 'mobi',
      sectionIndex: descriptor.startSectionIndex,
      ...(descriptor.startOffset !== undefined ? { byteOffset: descriptor.startOffset } : {}),
    };
  }
  if (descriptor.format === 'markdown') {
    return {
      format: 'markdown',
      blockIndex: descriptor.startBlockIndex,
      ...(descriptor.startCharacterOffset !== undefined ? { characterStart: descriptor.startCharacterOffset } : {}),
      ...(descriptor.endCharacterOffset !== undefined ? { characterEnd: descriptor.endCharacterOffset } : {}),
      ...(descriptor.startLineIndex !== undefined ? { lineIndex: descriptor.startLineIndex } : {}),
      ...(descriptor.startHeadingId !== undefined ? { headingId: descriptor.startHeadingId } : {}),
    };
  }
  return {
    format: 'epub',
    cfi: descriptor.startCfi ?? `/6/2[${descriptor.startSpineHref}]!/4/1:0`,
    spineHref: descriptor.startSpineHref,
    ...(descriptor.startProgression !== undefined ? { progression: descriptor.startProgression } : {}),
  };
}

export function descriptorToDisplayLabel(descriptor: ChatSelectionDescriptor): string {
  if (descriptor.format === 'pdf') {
    const start = descriptor.startPageLabel ?? String(descriptor.startPageIndex + 1);
    const end = descriptor.endPageLabel ?? String(descriptor.endPageIndex + 1);
    return descriptor.startPageIndex === descriptor.endPageIndex ? `Page ${start}` : `Pages ${start}–${end}`;
  }
  if (hasParagraphFormat(descriptor)) return paragraphDisplayLabel(descriptor);
  if (descriptor.format === 'markdown') {
    return descriptor.startBlockIndex === descriptor.endBlockIndex
      ? `Block ${String(descriptor.startBlockIndex + 1)}`
      : `Blocks ${String(descriptor.startBlockIndex + 1)}–${String(descriptor.endBlockIndex + 1)}`;
  }
  if (descriptor.format === 'epub') {
    return descriptor.startSpineHref === descriptor.endSpineHref
      ? `Section ${descriptor.startSpineHref}`
      : `Sections ${descriptor.startSpineHref}–${descriptor.endSpineHref}`;
  }
  return descriptor.startSectionIndex === descriptor.endSectionIndex
    ? `Section ${String(descriptor.startSectionIndex + 1)}`
    : `Sections ${String(descriptor.startSectionIndex + 1)}–${String(descriptor.endSectionIndex + 1)}`;
}
