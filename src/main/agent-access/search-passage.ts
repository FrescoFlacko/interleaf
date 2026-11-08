import { documentAnchorSchema } from '@shared/schemas/annotation';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { DocumentAnchor } from '@shared/types/annotation';
import type { SearchMatchAnchor } from '@shared/types/search';

/** Convert the first main-resolved search token to a native, revision-bound text range. */
export function searchPassageAnchor(match: SearchMatchAnchor): DocumentAnchor {
  const range = match.ranges[0];
  if (!range || range.end <= range.start || !range.text.trim()) throw new InterleafError('validation', 'The exact passage could not be resolved.');
  const quote = { exact: range.text, prefix: '', suffix: '' };
  const location = match.location;
  let anchor: DocumentAnchor;
  switch (location.format) {
    case 'markdown':
      anchor = { format: location.format, blockIndex: location.blockIndex, quote,
        characterStart: (location.characterStart ?? 0) + range.start, characterEnd: (location.characterStart ?? 0) + range.end,
        ...(location.lineIndex === undefined ? {} : { lineIndex: location.lineIndex }),
        ...(location.headingId === undefined ? {} : { headingId: location.headingId }) }; break;
    case 'docx': case 'pptx':
      anchor = { format: location.format, paragraphIndex: location.paragraphIndex, quote,
        characterStart: (location.characterStart ?? 0) + range.start, characterEnd: (location.characterStart ?? 0) + range.end,
        ...(location.renderedPageIndex === undefined ? {} : { renderedPageIndex: location.renderedPageIndex }) }; break;
    case 'pdf':
      anchor = { format: location.format, pageIndex: location.pageIndex, quote,
        textStart: (location.textStart ?? 0) + range.start, textEnd: (location.textStart ?? 0) + range.end }; break;
    case 'epub':
      anchor = { format: location.format, cfi: location.cfi, quote,
        ...(location.spineHref ? { spineHref: location.spineHref } : {}),
        textStart: (location.textStart ?? 0) + range.start, textEnd: (location.textStart ?? 0) + range.end }; break;
    case 'mobi':
      anchor = { format: location.format, sectionIndex: location.sectionIndex, quote,
        textStart: (location.textStart ?? 0) + range.start, textEnd: (location.textStart ?? 0) + range.end }; break;
  }
  const parsed = documentAnchorSchema.safeParse(anchor);
  if (!parsed.success) throw new InterleafError('validation', 'The exact passage could not be resolved.');
  return parsed.data;
}
