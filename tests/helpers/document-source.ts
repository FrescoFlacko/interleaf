import type { DocumentSource, ReflowOptions } from '../../src/renderer/features/reader/types';

/**
 * What the reader store hands an adapter when it opens a document.
 *
 * The store always names the revision, the archived media and the start
 * location, so an adapter test opens with all of them. A case that depends on
 * one of them names it; the rest take the values of a fresh document opened at
 * its beginning.
 */
export function testDocumentSource(
  source: Pick<DocumentSource, 'documentId' | 'assetUrl'> & Partial<DocumentSource>,
): DocumentSource {
  return {
    documentHash: `hash-${source.documentId}`,
    mediaAssets: [],
    initialLocation: null,
    ...source,
  };
}

/** The reader's default reflow settings with the case's own values applied. */
export function testReflowOptions(overrides: Partial<ReflowOptions> = {}): ReflowOptions {
  return {
    lineHeight: 1.65,
    horizontalMarginRem: 2.5,
    fontSize: 1,
    fontFamily: 'system',
    contentWidth: 72,
    paragraphSpacing: 0.8,
    ...overrides,
  };
}
