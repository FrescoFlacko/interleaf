import type { LearningSource } from '@shared/schemas/learning';
import { documentAnchorSchema } from '@shared/schemas/annotation';
import type { Annotation, DocumentAnchor } from '@shared/types/annotation';
import type { DocumentAdapter } from './types';
import { anchorToLocation } from './annotations/dom-anchors';
import { confirmPdfLearningRange } from './pdf-learning-navigation';

/** Verify every named segment before moving the reader. */
export async function navigateLearningSource(adapter: DocumentAdapter, source: LearningSource): Promise<boolean> {
  const anchor = source.anchor;
  if (adapter.format !== anchor.format || anchor.quote.exact.length === 0) return false;
  const candidates = segmentAnchors(anchor);
  if (candidates.length === 0) return false;
  let first: DocumentAnchor | null = null;
  for (const candidate of candidates) {
    const resolved = await resolveExact(adapter, candidate);
    if (!resolved) return false;
    first ??= resolved;
  }
  if (!first) return false;
  // Rectangles are not evidence of a passage: the PDF adapter's legacy
  // fallback must not scroll to one when its text layer cannot resolve.
  const target: DocumentAnchor = first.format === 'pdf'
    ? { format: 'pdf', pageIndex: first.pageIndex, quote: first.quote,
        ...(first.textStart !== undefined ? { textStart: first.textStart } : {}),
        ...(first.textEnd !== undefined ? { textEnd: first.textEnd } : {}) }
    : first;
  const annotation: Annotation = {
    id: 'learning-source', documentId: source.documentId, documentHash: source.documentHash,
    type: 'bookmark', anchor: target, selectedText: null, note: null, label: null,
    color: null, isLocationNote: false, status: 'anchored', createdAt: '', updatedAt: '',
  };
  if (first.format === 'markdown') {
    const location = anchorToLocation(first);
    if (location.format !== 'markdown') return false;
    await adapter.goToLocation({ format: 'markdown', blockIndex: location.blockIndex,
      ...(location.characterStart !== undefined ? { characterStart: location.characterStart } : {}),
      ...(location.characterEnd !== undefined ? { characterEnd: location.characterEnd } : {}) });
  } else {
    await adapter.goToAnnotation(annotation);
    if (target.format === 'pdf') return confirmPdfLearningRange(target);
  }
  return true;
}

function segmentAnchors(anchor: DocumentAnchor): readonly DocumentAnchor[] {
  if (!anchor.segments) return [anchor];
  const { segments, ...base } = anchor;
  const result: DocumentAnchor[] = [];
  for (const segment of segments) {
    const part = Object.fromEntries(Object.entries(segment).filter(([key]) => key !== 'separatorBefore'));
    const parsed = documentAnchorSchema.safeParse({ ...base, ...part });
    if (!parsed.success) return [];
    result.push(parsed.data);
  }
  return result;
}

async function resolveExact(adapter: DocumentAdapter, anchor: DocumentAnchor): Promise<DocumentAnchor | null> {
  if ((anchor.format === 'epub' || anchor.format === 'mobi') && !adapter.verifyLearningAnchor?.(anchor)) return null;
  const chunks = await adapter.extractLocationText(anchorToLocation(anchor));
  if (chunks.length !== 1) return null;
  const text = chunks[0]?.text ?? '';
  const quote = anchor.quote.exact;
  if (!quote) return null;
  const nativeStart = 'characterStart' in anchor ? anchor.characterStart : 'textStart' in anchor ? anchor.textStart : undefined;
  const nativeEnd = 'characterEnd' in anchor ? anchor.characterEnd : 'textEnd' in anchor ? anchor.textEnd : undefined;
  const nativeMatches = nativeStart !== undefined && nativeEnd !== undefined && text.slice(nativeStart, nativeEnd) === quote;
  const start = nativeMatches ? nativeStart : text.indexOf(quote);
  if (start < 0 || (!nativeMatches && text.slice(start + 1).includes(quote))) return null;
  const end = start + quote.length;
  if (anchor.format === 'markdown' || anchor.format === 'docx' || anchor.format === 'pptx') {
    return { ...anchor, characterStart: start, characterEnd: end };
  }
  return { ...anchor, textStart: start, textEnd: end };
}
