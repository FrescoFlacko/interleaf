import type { AgentSource } from '@shared/schemas/agent-access';
import { documentLocationSchema } from '@shared/schemas/document';
import { parsePortableJson } from '@shared/models/portable';
import { sourceRangeMatches } from './source-ranges';

/** A quote must be unique in the actual chunk and belong to the same native scope. */
export function sourceMatchesChunk(source: AgentSource, locationJson: string, text: string): boolean {
  try {
    const location = documentLocationSchema.parse(parsePortableJson(locationJson));
    const anchor = source.anchor;
    const quote = anchor.quote.exact;
    const first = text.indexOf(quote);
    if (!text.includes(quote) || text.includes(quote, first + 1) || anchor.segments !== undefined) return false;
    if (anchor.format === 'pdf' && location.format === 'pdf') return anchor.pageIndex === location.pageIndex && sourceRangeMatches(anchor.textStart, anchor.textEnd, location.textStart, first, quote.length);
    if (anchor.format === 'epub' && location.format === 'epub') return anchor.cfi === location.cfi;
    if (anchor.format === 'mobi' && location.format === 'mobi') return anchor.sectionIndex === location.sectionIndex;
    if (anchor.format === 'docx' && location.format === 'docx') return anchor.paragraphIndex === location.paragraphIndex && sourceRangeMatches(anchor.characterStart, anchor.characterEnd, location.characterStart, first, quote.length);
    if (anchor.format === 'pptx' && location.format === 'pptx') return anchor.paragraphIndex === location.paragraphIndex && sourceRangeMatches(anchor.characterStart, anchor.characterEnd, location.characterStart, first, quote.length);
    if (anchor.format === 'markdown' && location.format === 'markdown') return anchor.blockIndex === location.blockIndex && sourceRangeMatches(anchor.characterStart, anchor.characterEnd, location.characterStart, first, quote.length);
    return false;
  } catch { return false; }
}
