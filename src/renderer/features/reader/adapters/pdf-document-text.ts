import type * as pdfjsLib from 'pdfjs-dist';
import type { NormalizedTextChunk } from '@shared/types/document';
import type { TextExtractionOptions } from '../types';
import { pdfIndexedPageText, pdfTextItemStrings } from './pdf-text-space';

/**
 * The indexed text of every page of a PDF that has any, in page order, one
 * chunk per page; nothing before a document is open. `shouldStop` is checked before each page and text request,
 * so a caller that stops wanting the text is not walked through a run of pages
 * with no text. A request already sent to pdf.js is awaited; it is never
 * claimed to be interrupted.
 */
export async function* pdfDocumentText(
  document: Pick<pdfjsLib.PDFDocumentProxy, 'getPage'> | null,
  pageCount: number,
  documentId: string,
  options: TextExtractionOptions = {},
): AsyncIterable<NormalizedTextChunk> {
  if (document === null) return;
  const stopped = (): boolean => options.shouldStop?.() === true;
  let ordinal = 0;
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    if (stopped()) return;
    const page = await document.getPage(pageNum);
    if (stopped()) return;
    const text = pdfIndexedPageText(pdfTextItemStrings((await page.getTextContent()).items));
    if (text.length === 0) continue;
    yield {
      id: `chunk-${documentId}-p${String(pageNum)}`,
      documentId,
      ordinal: ordinal++,
      text,
      tokenCount: Math.ceil(text.length / 4),
      location: { format: 'pdf', pageIndex: pageNum - 1 },
      heading: null,
      pageLabel: `Page ${String(pageNum)}`,
    };
  }
}
