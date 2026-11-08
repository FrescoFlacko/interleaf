import type { DocumentAnchor } from '@shared/types/annotation';
import type { DocumentAdapter } from './types';
import { anchorToLocation, rangeFromOffsets } from './annotations/dom-anchors';
import { confirmPdfLearningRange } from './pdf-learning-navigation';
import { positionEbookLearningRange, positionLearningRange } from './learning-range-position';

/** Attach a source-only navigation capability without changing ordinary annotation behavior. */
export function withLearningNavigation(adapter: DocumentAdapter): DocumentAdapter {
  return Object.assign(adapter, {
    navigateLearningAnchor: (anchor: DocumentAnchor, isCurrent: () => boolean) =>
      navigateMountedLearningAnchor(adapter, anchor, isCurrent),
  });
}

async function navigateMountedLearningAnchor(adapter: DocumentAdapter, anchor: DocumentAnchor, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  if (anchor.format === 'pdf') {
    await adapter.goToLocation(anchorToLocation(anchor));
    return isCurrent() && confirmPdfLearningRange(anchor, isCurrent);
  }
  const location = anchorToLocation(anchor);
  if (location.format === 'markdown') {
    await adapter.goToLocation({ format: 'markdown', blockIndex: location.blockIndex });
  } else {
    await adapter.goToLocation(location);
  }
  if (!isCurrent()) return false;
  if (anchor.format === 'epub' || anchor.format === 'mobi') return positionEbook(adapter, anchor, isCurrent);
  return positionDocument(anchor, isCurrent);
}

function positionDocument(anchor: DocumentAnchor, isCurrent: () => boolean): boolean {
  if (anchor.format !== 'markdown' && anchor.format !== 'docx' && anchor.format !== 'pptx') return false;
  const markdown = anchor.format === 'markdown';
  const selector = markdown ? `[data-markdown-block="${String(anchor.blockIndex)}"]` : `[data-docx-paragraph="${String(anchor.paragraphIndex)}"]`;
  const block = document.querySelector<HTMLElement>(selector);
  const scroller = document.querySelector<HTMLElement>(markdown ? '[data-testid="markdown-scroll-container"]' : '[data-testid="docx-scroll-container"]');
  if (!block || !scroller) return false;
  const roots = block.querySelectorAll<HTMLElement>(markdown ? '.markdown-block-content' : '.docx-paragraph-content');
  const root = roots.length === 1 ? roots[0] : block;
  if (!root || anchor.characterStart === undefined || anchor.characterEnd === undefined) return false;
  const range = rangeFromOffsets(root, { start: anchor.characterStart, end: anchor.characterEnd });
  return !!range && range.toString() === anchor.quote.exact && positionLearningRange(range, scroller, isCurrent);
}

function positionEbook(adapter: DocumentAdapter, anchor: DocumentAnchor, isCurrent: () => boolean): boolean {
  if (anchor.format !== 'epub' && anchor.format !== 'mobi') return false;
  const scope = adapter.getAnnotationScope();
  if (anchor.format === 'mobi' && (scope?.format !== 'mobi' || scope.sectionIndex !== anchor.sectionIndex)) return false;
  if (anchor.format === 'epub' && anchor.spineHref && (scope?.format !== 'epub' || scope.spineHref !== anchor.spineHref)) return false;
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Ebook Content"]');
  const doc = frame?.contentDocument;
  if (!doc || anchor.textStart === undefined || anchor.textEnd === undefined) return false;
  const range = rangeFromOffsets(doc.body, { start: anchor.textStart, end: anchor.textEnd });
  return !!range && range.toString() === anchor.quote.exact && positionEbookLearningRange(range, frame, isCurrent);
}
