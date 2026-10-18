import PptxParseWorker from './pptx-parse.worker?worker';
import { DocxAdapter, type DocxParse } from './docx-adapter';
import type { ParsedDocxPayload } from './docx-parse-core';
import { parseOoxmlInWorker } from './ooxml-worker-pool';

function parsePptxInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<ParsedDocxPayload> {
  return parseOoxmlInWorker(() => new PptxParseWorker(), 'PPTX', bytes, signal);
}

/**
 * Slides render through the DOCX paragraph reader: one widescreen page per
 * slide, with `pptx` locations, anchors and citations so a deck's records never
 * mix with a Word document's.
 */
export class PptxAdapter extends DocxAdapter {
  constructor(parsePptx: DocxParse = parsePptxInWorker) {
    super(parsePptx, 'pptx');
  }
}
