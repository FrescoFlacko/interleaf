import type { DocumentAnchor } from '@shared/types/annotation';

/** The saved native coordinate is provenance; opening it still resolves its quote. */
export function practiceSourceLocation(anchor: DocumentAnchor): string {
  switch (anchor.format) {
    case 'pdf': return `Page ${anchor.pageLabel ?? String(anchor.pageIndex + 1)}`;
    case 'markdown': return `Block ${String(anchor.blockIndex + 1)}`;
    case 'docx':
    case 'pptx': return `Paragraph ${String(anchor.paragraphIndex + 1)}`;
    case 'mobi': return `Section ${String(anchor.sectionIndex + 1)}`;
    case 'epub': return anchor.spineHref ? `Section ${anchor.spineHref}` : 'EPUB location';
  }
}
