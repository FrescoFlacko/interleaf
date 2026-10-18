import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/constants/ipc';
import { ipcRequestSchemas } from '@shared/schemas/ipc';
import { createAnnotationRequestSchema, documentAnchorSchema } from '@shared/schemas/annotation';

const rangeAnchor = {
  format: 'pdf',
  pageIndex: 1,
  quote: { exact: 'quote', prefix: 'before', suffix: 'after' },
  textStart: 10,
  textEnd: 15,
  rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
} as const;

describe('annotation contracts', () => {
  it('accepts each supported annotation kind and rejects cross-kind fields', () => {
    expect(
      createAnnotationRequestSchema.safeParse({
        documentId: 'doc',
        type: 'highlight',
        anchor: rangeAnchor,
        selectedText: 'quote',
        color: 'green',
      }).success
    ).toBe(true);
    expect(
      createAnnotationRequestSchema.safeParse({
        documentId: 'doc',
        type: 'note',
        anchor: { format: 'pdf', pageIndex: 2, quote: { exact: '', prefix: '', suffix: '' } },
        selectedText: 'phantom selection',
        note: 'Location note',
        isLocationNote: true,
      }).success
    ).toBe(false);
    expect(
      createAnnotationRequestSchema.safeParse({
        documentId: 'doc',
        type: 'note',
        anchor: { ...rangeAnchor, quote: { ...rangeAnchor.quote, exact: 'note quote' } },
        selectedText: 'note quote',
        note: 'My note',
      }).success
    ).toBe(true);
    expect(
      createAnnotationRequestSchema.safeParse({
        documentId: 'doc',
        type: 'bookmark',
        anchor: { format: 'pdf', pageIndex: 2, quote: { exact: '', prefix: '', suffix: '' } },
        label: 'Later',
      }).success
    ).toBe(true);
    expect(
      createAnnotationRequestSchema.safeParse({
        documentId: 'doc',
        type: 'bookmark',
        anchor: { format: 'pdf', pageIndex: 2, quote: { exact: '', prefix: '', suffix: '' } },
        color: 'yellow',
      }).success
    ).toBe(false);
  });

  it('bounds anchor geometry, quote sizes, and paired offsets', () => {
    expect(documentAnchorSchema.safeParse({ ...rangeAnchor, textEnd: undefined }).success).toBe(false);
    expect(
      documentAnchorSchema.safeParse({
        ...rangeAnchor,
        rects: [{ x: 0.9, y: 0.1, width: 0.2, height: 0.1 }],
      }).success
    ).toBe(false);
    expect(
      documentAnchorSchema.safeParse({
        ...rangeAnchor,
        quote: { exact: 'x'.repeat(256_001), prefix: '', suffix: '' },
      }).success
    ).toBe(false);
  });

  it('registers strict, bounded schemas for every annotation IPC channel', () => {
    expect(ipcRequestSchemas[IPC.annotationsCreate]).toBe(createAnnotationRequestSchema);
    expect(ipcRequestSchemas[IPC.annotationsPage]).toBe(ipcRequestSchemas[IPC.annotationsList]);
    expect(
      ipcRequestSchemas[IPC.annotationsList].safeParse({
        documentId: 'doc',
        filter: { limit: 100, offset: 0, searchQuery: 'quote', sort: 'updated_desc' },
      }).success
    ).toBe(true);
    expect(
      ipcRequestSchemas[IPC.annotationsList].safeParse({
        documentId: 'doc',
        filter: { limit: 101 },
      }).success
    ).toBe(false);
    expect(
      ipcRequestSchemas[IPC.annotationsPage].safeParse({
        documentId: 'doc',
        filter: { scope: { format: 'pdf', pageStart: 3, pageEnd: 1 } },
      }).success
    ).toBe(false);
    expect(
      ipcRequestSchemas[IPC.annotationsRepairAnchor].safeParse({
        documentId: 'doc',
        id: 'annotation',
        documentHash: '',
        anchor: rangeAnchor,
        status: 'anchored',
      }).success
    ).toBe(false);
    expect(
      ipcRequestSchemas[IPC.annotationsDelete].safeParse({
        documentId: 'doc',
        id: 'annotation',
        extra: true,
      }).success
    ).toBe(false);
  });

  it('validates multi-segment anchors across formats and enforces segment limits', () => {
    const validMultiPdf = {
      format: 'pdf',
      pageIndex: 0,
      quote: { exact: 'Line 1\nLine 2', prefix: 'pre ', suffix: ' post' },
      segments: [
        {
          pageIndex: 0,
          quote: { exact: 'Line 1', prefix: 'pre ', suffix: '' },
          textStart: 0,
          textEnd: 6,
        },
        {
          pageIndex: 1,
          quote: { exact: 'Line 2', prefix: '', suffix: ' post' },
          separatorBefore: '\n',
          textStart: 0,
          textEnd: 6,
        },
      ],
    };
    expect(documentAnchorSchema.safeParse(validMultiPdf).success).toBe(true);

    // Rejection if leading segment has a non-empty separatorBefore
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      segments: [
        { ...validMultiPdf.segments[0], separatorBefore: '\n' },
        validMultiPdf.segments[1],
      ],
    }).success).toBe(false);

    // Rejection if top-level quote exact does not match reconstructed segment text
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      quote: { ...validMultiPdf.quote, exact: 'Line 1 WITHOUT Line 2' },
    }).success).toBe(false);

    // Rejection of single-item segments (< 2)
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      segments: [validMultiPdf.segments[0]],
    }).success).toBe(false);

    // Rejection of unordered segments (pageIndex: 1 before pageIndex: 0)
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      segments: [validMultiPdf.segments[1], validMultiPdf.segments[0]],
    }).success).toBe(false);

    // Rejection of duplicate segment pageIndex (0, 0)
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      segments: [validMultiPdf.segments[0], { ...validMultiPdf.segments[0], quote: { exact: 'dup', prefix: '', suffix: '' }, separatorBefore: ' ' }],
    }).success).toBe(false);

    // Rejection of empty segment quote
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      segments: [validMultiPdf.segments[0], { ...validMultiPdf.segments[1], quote: { exact: '   ', prefix: '', suffix: '' } }],
    }).success).toBe(false);

    // Rejection of mismatched top-level pageIndex
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      pageIndex: 5,
    }).success).toBe(false);

    // Rejection of mismatched top-level prefix
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      quote: { ...validMultiPdf.quote, prefix: 'mismatched' },
    }).success).toBe(false);

    // Rejection of mismatched top-level suffix
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      quote: { ...validMultiPdf.quote, suffix: 'mismatched' },
    }).success).toBe(false);

    // Too many segments (max 100)
    const excessiveSegments = Array.from({ length: 101 }, (_, i) => ({
      pageIndex: i,
      quote: { exact: `p${String(i)}`, prefix: i === 0 ? 'pre ' : '', suffix: i === 100 ? ' post' : '' },
      ...(i > 0 ? { separatorBefore: ' ' } : {}),
    }));
    const reconstructedExcessive = excessiveSegments.map((s, i) => (i > 0 ? ' ' : '') + s.quote.exact).join('');
    expect(documentAnchorSchema.safeParse({
      ...validMultiPdf,
      quote: { exact: reconstructedExcessive, prefix: 'pre ', suffix: ' post' },
      segments: excessiveSegments,
    }).success).toBe(false);

    // Valid markdown multi-segment with exact whitespace / newline reconstruction
    const validMultiMarkdown = {
      format: 'markdown',
      blockIndex: 0,
      quote: { exact: 'Heading\n\nParagraph text', prefix: 'pre ', suffix: ' post' },
      segments: [
        { blockIndex: 0, quote: { exact: 'Heading', prefix: 'pre ', suffix: '' }, characterStart: 0, characterEnd: 7 },
        { blockIndex: 1, quote: { exact: 'Paragraph text', prefix: '', suffix: ' post' }, separatorBefore: '\n\n', characterStart: 0, characterEnd: 14 },
      ],
    };
    expect(documentAnchorSchema.safeParse(validMultiMarkdown).success).toBe(true);

    // Custom whitespace separator (tab + double space)
    const validCustomWhitespace = {
      format: 'markdown',
      blockIndex: 0,
      quote: { exact: 'Heading\t  Paragraph text', prefix: 'pre ', suffix: ' post' },
      segments: [
        { blockIndex: 0, quote: { exact: 'Heading', prefix: 'pre ', suffix: '' }, characterStart: 0, characterEnd: 7 },
        { blockIndex: 1, quote: { exact: 'Paragraph text', prefix: '', suffix: ' post' }, separatorBefore: '\t  ', characterStart: 0, characterEnd: 14 },
      ],
    };
    expect(documentAnchorSchema.safeParse(validCustomWhitespace).success).toBe(true);

    // Rejection of unordered markdown segments
    expect(documentAnchorSchema.safeParse({
      ...validMultiMarkdown,
      segments: [validMultiMarkdown.segments[1], validMultiMarkdown.segments[0]],
    }).success).toBe(false);

    // Valid docx multi-segment
    const validMultiDocx = {
      format: 'docx',
      paragraphIndex: 0,
      quote: { exact: 'Para 1\nPara 2', prefix: 'pre ', suffix: ' post' },
      segments: [
        { paragraphIndex: 0, quote: { exact: 'Para 1', prefix: 'pre ', suffix: '' }, characterStart: 0, characterEnd: 6 },
        { paragraphIndex: 1, quote: { exact: 'Para 2', prefix: '', suffix: ' post' }, separatorBefore: '\n', characterStart: 0, characterEnd: 6 },
      ],
    };
    expect(documentAnchorSchema.safeParse(validMultiDocx).success).toBe(true);

    // Rejection of unordered docx segments
    expect(documentAnchorSchema.safeParse({
      ...validMultiDocx,
      segments: [validMultiDocx.segments[1], validMultiDocx.segments[0]],
    }).success).toBe(false);

    // Valid epub multi-segment
    const validMultiEpub = {
      format: 'epub',
      cfi: 'epubcfi(/6/4!/4/2/1:0)',
      quote: { exact: 'Sec 1\nSec 2', prefix: 'pre ', suffix: ' post' },
      segments: [
        { cfi: 'epubcfi(/6/4!/4/2/1:0)', quote: { exact: 'Sec 1', prefix: 'pre ', suffix: '' } },
        { cfi: 'epubcfi(/6/4!/4/2/3:0)', quote: { exact: 'Sec 2', prefix: '', suffix: ' post' }, separatorBefore: '\n' },
      ],
    };
    expect(documentAnchorSchema.safeParse(validMultiEpub).success).toBe(true);

    // Valid mobi multi-segment
    const validMultiMobi = {
      format: 'mobi',
      sectionIndex: 0,
      quote: { exact: 'Sec 1\nSec 2', prefix: 'pre ', suffix: ' post' },
      segments: [
        { sectionIndex: 0, quote: { exact: 'Sec 1', prefix: 'pre ', suffix: '' } },
        { sectionIndex: 1, quote: { exact: 'Sec 2', prefix: '', suffix: ' post' }, separatorBefore: '\n' },
      ],
    };
    expect(documentAnchorSchema.safeParse(validMultiMobi).success).toBe(true);

    // Legacy backward compatibility: single anchors with NO segments continue to validate cleanly
    expect(documentAnchorSchema.safeParse(rangeAnchor).success).toBe(true);
    expect(documentAnchorSchema.safeParse({
      format: 'markdown',
      blockIndex: 3,
      quote: { exact: 'Legacy heading', prefix: '', suffix: '' },
      characterStart: 0,
      characterEnd: 14,
    }).success).toBe(true);
    expect(documentAnchorSchema.safeParse({
      format: 'docx',
      paragraphIndex: 2,
      quote: { exact: 'Legacy para', prefix: '', suffix: '' },
      characterStart: 0,
      characterEnd: 11,
    }).success).toBe(true);
    expect(documentAnchorSchema.safeParse({
      format: 'epub',
      cfi: 'epubcfi(/6/2[cover]!/4/2/1:0)',
      quote: { exact: 'Legacy epub quote', prefix: '', suffix: '' },
    }).success).toBe(true);
  });
});
