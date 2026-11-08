import type { DocumentAnchor, AnnotationAnchorScope } from '@shared/types/annotation';
import type { DocumentLocation } from '@shared/types/document';

/** Whether an item belongs beside the current native reading region. */
export function learningInScope(anchor: DocumentAnchor, scope: AnnotationAnchorScope | null, location: DocumentLocation | null): boolean {
  if (scope?.format !== anchor.format) return false;
  if (anchor.format === 'pdf' && scope.format === 'pdf') {
    return [anchor, ...(anchor.segments ?? [])].some((part) => part.pageIndex >= scope.pageStart && part.pageIndex <= scope.pageEnd);
  }
  if ((anchor.format === 'docx' || anchor.format === 'pptx') && scope.format === anchor.format) {
    return [anchor, ...(anchor.segments ?? [])].some((part) => part.renderedPageIndex !== undefined
      ? part.renderedPageIndex >= scope.pageStart && part.renderedPageIndex <= scope.pageEnd
      : location?.format === anchor.format && location.paragraphIndex === part.paragraphIndex);
  }
  if (anchor.format === 'markdown' && location?.format === 'markdown') {
    const viewport = document.querySelector('[data-testid="reader-document-region"]')?.getBoundingClientRect();
    if (!viewport) return false;
    return [anchor, ...(anchor.segments ?? [])].some((part) => {
      const element = document.querySelector(`[data-markdown-block="${String(part.blockIndex)}"]`);
      const rect = element?.getBoundingClientRect();
      return rect !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
  }
  if (anchor.format === 'epub' && scope.format === 'epub') {
    return [anchor, ...(anchor.segments ?? [])].some((part) => part.spineHref === scope.spineHref);
  }
  if (anchor.format === 'mobi' && scope.format === 'mobi') {
    return [anchor, ...(anchor.segments ?? [])].some((part) => part.sectionIndex === scope.sectionIndex);
  }
  return false;
}
