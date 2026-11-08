import { describe, expect, it } from 'vitest';
import { searchPassageAnchor } from '@main/agent-access/search-passage';
import type { DocumentLocation } from '@shared/types/document';
import type { SearchMatchAnchor } from '@shared/types/search';

function match(location: DocumentLocation): SearchMatchAnchor {
  return { version: 1, documentId: 'doc', documentHash: 'hash', chunkId: 'chunk', location, queryTerms: ['needle'], ranges: [{ start: 4, end: 10, text: 'Needle', queryTermIndex: 0, queryTermIndices: [0] }] };
}

describe('search passage anchors', () => {
  it.each([
    [{ format: 'pdf', pageIndex: 3, textStart: 100, textEnd: 130 }, { pageIndex: 3, textStart: 104, textEnd: 110 }],
    [{ format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'chapter.xhtml', textStart: 100, textEnd: 130 }, { cfi: 'epubcfi(/6/2)', spineHref: 'chapter.xhtml', textStart: 104, textEnd: 110 }],
    [{ format: 'mobi', sectionIndex: 4, textStart: 100, textEnd: 130 }, { sectionIndex: 4, textStart: 104, textEnd: 110 }],
    [{ format: 'docx', paragraphIndex: 5, characterStart: 100, characterEnd: 130 }, { paragraphIndex: 5, characterStart: 104, characterEnd: 110 }],
    [{ format: 'pptx', paragraphIndex: 5, renderedPageIndex: 2, characterStart: 100, characterEnd: 130 }, { paragraphIndex: 5, renderedPageIndex: 2, characterStart: 104, characterEnd: 110 }],
    [{ format: 'markdown', blockIndex: 8, characterStart: 100, characterEnd: 130 }, { blockIndex: 8, characterStart: 104, characterEnd: 110 }],
  ] as const)('preserves native scope and offsets for $0.format', (location, expected) => {
    expect(searchPassageAnchor(match(location))).toMatchObject({ ...expected, format: location.format, quote: { exact: 'Needle' } });
  });
});
