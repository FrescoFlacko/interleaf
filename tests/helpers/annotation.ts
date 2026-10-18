import type { Annotation, DocumentAnchor } from '@shared/types/annotation';
import type { LoadedAnnotationDocument } from '../../src/renderer/stores/use-annotation-store';

/**
 * A complete annotation record.
 *
 * Annotations reach the UI from the database with every column populated, so a
 * test double that omits members describes a row that cannot exist. Building
 * the whole contract here means a required addition to `Annotation` breaks the
 * fixture once, in one place, instead of passing silently through an assertion
 * at each callsite.
 */

const MARKDOWN_ANCHOR: DocumentAnchor = {
  format: 'markdown',
  quote: { exact: 'selected quote', prefix: 'before ', suffix: ' after' },
  blockIndex: 1,
};

const TIMESTAMP = '2026-08-27T00:00:00.000Z';

export function testAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    documentHash: 'hash-v1',
    type: 'highlight',
    anchor: MARKDOWN_ANCHOR,
    selectedText: 'selected quote',
    note: null,
    label: null,
    color: 'yellow',
    isLocationNote: false,
    status: 'anchored',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

/**
 * The record a reader load leaves in the annotation store.
 *
 * A load always names the document, its revision and the mounted region
 * together; the default region is a short Markdown document's whole body.
 */
export function testLoadedAnnotations(
  documentId: string,
  overrides: Partial<Omit<LoadedAnnotationDocument, 'documentId'>> = {},
): LoadedAnnotationDocument {
  return {
    documentId,
    documentHash: 'hash-v1',
    scope: { format: 'markdown', blockStart: 0, blockEnd: 0 },
    ...overrides,
  };
}
