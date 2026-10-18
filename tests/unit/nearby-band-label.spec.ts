import { describe, expect, it } from 'vitest';
import { adoptedBandLabel, bandLabelMember, nearbyBandLabel } from '@main/ai/nearby-band-label';
import type { ChatSourceEnvelopeItem } from '@shared/types/ai';
import type { DocumentLocation } from '@shared/types/document';

/**
 * What the nearby-context disclosure is allowed to claim about where the turn
 * was answered from.
 *
 * The labels below are the ones the real adapters write onto indexed chunks:
 * `Page 148` from the PDF adapter, a heading or `Block N` from Markdown,
 * `Section N` from the EPUB/MOBI base adapter, `Rendered page N` from DOCX.
 * Reading numbers out of any of them would let a spine section or a heading be
 * reported to the reader as a page of a document that has no pages, so the
 * label has to come from the canonical location instead. These hold that line.
 */

function source(location: DocumentLocation, pageLabel: string | null): ChatSourceEnvelopeItem {
  return {
    sourceId: `src-${pageLabel ?? 'none'}`,
    documentId: 'doc-1',
    documentHash: 'a'.repeat(64),
    documentTitle: 'Document',
    documentFormat: location.format,
    chunkId: 'chunk-1',
    contextItemId: null,
    location,
    excerptText: 'text',
    excerptHash: 'b'.repeat(64),
    heading: null,
    pageLabel,
    label: pageLabel ?? 'Document passage',
  };
}

/** Indexed PDF chunks, exactly as the PDF adapter labels them. */
function pdfBand(firstPage: number, lastPage: number): ChatSourceEnvelopeItem[] {
  const sources: ChatSourceEnvelopeItem[] = [];
  for (let page = firstPage; page <= lastPage; page += 1) {
    sources.push(source({ format: 'pdf', pageIndex: page - 1 }, `Page ${String(page)}`));
  }
  return sources;
}

describe('naming where a nearby band came from', () => {
  describe('a PDF, which has pages', () => {
    it('reports the pages the band actually covered', () => {
      expect(nearbyBandLabel(pdfBand(148, 159))).toBe('Pages 148–159');
    });

    it('reports a single page as one page', () => {
      expect(nearbyBandLabel(pdfBand(7, 7))).toBe('Page 7');
      // Several chunks from one page still name that page once.
      expect(nearbyBandLabel([...pdfBand(7, 7), ...pdfBand(7, 7)])).toBe('Page 7');
    });

    it('lists a band with a gap rather than smoothing it into a range', () => {
      const band = [...pdfBand(3, 4), ...pdfBand(9, 10)];
      expect(nearbyBandLabel(band)).toBe('Pages 3, 4, 9, 10');
    });

    it('reads the page from the location, not from the adapter’s display text', () => {
      // A capture whose display labels are front-matter numerals still has
      // canonical page indexes, and those are what was sent to the model.
      const band = [
        source({ format: 'pdf', pageIndex: 0 }, 'Page i'),
        source({ format: 'pdf', pageIndex: 1 }, 'Page ii'),
      ];
      expect(nearbyBandLabel(band)).toBe('Pages 1–2');
    });
  });

  describe('formats that have no pages', () => {
    it('claims nothing for Markdown blocks and headings', () => {
      const band = [
        source({ format: 'markdown', blockIndex: 11 }, 'Architectural observations'),
        source({ format: 'markdown', blockIndex: 12 }, 'Block 13'),
      ];
      expect(nearbyBandLabel(band)).toBeNull();
    });

    it('claims nothing for DOCX, whose rendered pages are a layout artifact', () => {
      // `Rendered page 4` names a page of one rendering, not of the document.
      const band = [
        source({ format: 'docx', paragraphIndex: 40, renderedPageIndex: 3 }, 'Rendered page 4'),
        source({ format: 'docx', paragraphIndex: 41, renderedPageIndex: 4 }, 'Rendered page 5'),
      ];
      expect(nearbyBandLabel(band)).toBeNull();
    });
  });

  it('withholds the whole label when any source in the band is not a PDF page', () => {
    // A range built from the rest would describe part of what was sent as if it
    // were all of it.
    const band = [...pdfBand(3, 4), source({ format: 'markdown', blockIndex: 9 }, 'Block 10')];
    expect(nearbyBandLabel(band)).toBeNull();
  });

  it('claims nothing for an empty band', () => {
    expect(nearbyBandLabel([])).toBeNull();
  });

  describe('what reaches the disclosure', () => {
    it('says nothing about a document that fitted whole, or an envelope not adopted', () => {
      const sources = pdfBand(1, 4);
      expect(adoptedBandLabel({ adopted: true, fullDocIncluded: true, sources, explicitCount: 0 })).toBeNull();
      expect(adoptedBandLabel({ adopted: false, fullDocIncluded: false, sources, explicitCount: 0 })).toBeNull();
    });

    it('describes only the band, not the reader’s own explicit selections in front of it', () => {
      const sources = pdfBand(1, 6);
      expect(
        adoptedBandLabel({ adopted: true, fullDocIncluded: false, sources, explicitCount: 2 })
      ).toBe('Pages 3–6');
    });

    it('omits the member entirely when there is nothing truthful to put in it', () => {
      expect(bandLabelMember(null)).toEqual({});
      expect(bandLabelMember('Pages 3–6')).toEqual({ includedLabel: 'Pages 3–6' });
    });
  });
});
