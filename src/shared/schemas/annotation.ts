import { z } from 'zod';
import type { PortableValue } from '../models/portable';
import type { DocumentAnchor } from '../types/annotation';

const identifierSchema = z.string().min(1).max(128);
const documentHashSchema = z.string().min(1).max(256);
const MAX_SELECTED_TEXT_LENGTH = 256_000;
const selectedTextSchema = z.string().min(1).max(MAX_SELECTED_TEXT_LENGTH);
const noteSchema = z.string().trim().min(1).max(100_000);
const labelSchema = z.string().trim().min(1).max(500);
export const quoteContextSchema = z
  .object({
    exact: z.string().max(256_000),
    prefix: z.string().max(2_000),
    suffix: z.string().max(2_000),
  })
  .strict();

export const highlightColorSchema = z.enum(['yellow', 'blue', 'green', 'pink', 'purple']);
export const annotationTypeSchema = z.enum(['highlight', 'note', 'bookmark']);
export const annotationStatusSchema = z.enum(['anchored', 'unanchored']);

export const annotationAnchorScopeSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('pdf'),
    pageStart: z.number().int().min(0).max(10_000_000),
    pageEnd: z.number().int().min(0).max(10_000_000),
  }).strict().refine((scope) => scope.pageEnd >= scope.pageStart, 'Page range is reversed.'),
  z.object({
    format: z.literal('docx'),
    pageStart: z.number().int().min(0).max(10_000_000),
    pageEnd: z.number().int().min(0).max(10_000_000),
  }).strict().refine((scope) => scope.pageEnd >= scope.pageStart, 'Page range is reversed.'),
  z.object({
    format: z.literal('pptx'),
    pageStart: z.number().int().min(0).max(10_000_000),
    pageEnd: z.number().int().min(0).max(10_000_000),
  }).strict().refine((scope) => scope.pageEnd >= scope.pageStart, 'Page range is reversed.'),
  z.object({ format: z.literal('epub'), spineHref: z.string().min(1).max(2_048) }).strict(),
  z.object({
    format: z.literal('mobi'),
    sectionIndex: z.number().int().min(0).max(10_000_000),
  }).strict(),
  z.object({
    format: z.literal('markdown'),
    blockStart: z.number().int().min(0).max(10_000_000),
    blockEnd: z.number().int().min(0).max(10_000_000),
  }).strict().refine((scope) => scope.blockEnd >= scope.blockStart, 'Block range is reversed.'),
]);

export const normalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1.000_001) {
      context.addIssue({ code: 'custom', message: 'Rectangle exceeds page width.', path: ['width'] });
    }
    if (rect.y + rect.height > 1.000_001) {
      context.addIssue({ code: 'custom', message: 'Rectangle exceeds page height.', path: ['height'] });
    }
  });

const textRangeShape = {
  textStart: z.number().int().min(0).max(100_000_000).exactOptional(),
  textEnd: z.number().int().min(0).max(100_000_000).exactOptional(),
};

function validateOptionalRange(
  start: number | undefined,
  end: number | undefined,
  context: z.RefinementCtx,
  startKey = 'textStart',
  endKey = 'textEnd'
): void {
  const hasStart = start !== undefined;
  const hasEnd = end !== undefined;
  if (hasStart !== hasEnd) {
    context.addIssue({
      code: 'custom',
      message: 'Text range endpoints must be provided together.',
      path: hasStart ? [endKey] : [startKey],
    });
  } else if (start !== undefined && end !== undefined && end <= start) {
    context.addIssue({
      code: 'custom',
      message: 'Text range end must be greater than its start.',
      path: [endKey],
    });
  }
}
function validateCompositeSegments<T extends { readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string }; readonly separatorBefore?: string | undefined }>(
  segments: readonly T[],
  formatName: string,
  getOrderKey: (seg: T) => number,
  orderKeyName: string,
  anchorQuoteExact: string,
  context: z.RefinementCtx
): void {
  if (segments.length < 2) {
    context.addIssue({
      code: 'custom',
      message: `Composite ${formatName} anchors must contain at least 2 segments.`,
      path: ['segments'],
    });
  }
  if (segments[0]?.separatorBefore !== undefined && segments[0].separatorBefore.length > 0) {
    context.addIssue({
      code: 'custom',
      message: 'Leading segment cannot have separatorBefore.',
      path: ['segments', 0, 'separatorBefore'],
    });
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const curr = segments[i];
    const next = segments[i + 1];
    if (curr && next && getOrderKey(next) <= getOrderKey(curr)) {
      context.addIssue({
        code: 'custom',
        message: `${formatName} anchor segments must be strictly ordered by increasing ${orderKeyName} with no duplicates.`,
        path: ['segments', i + 1, orderKeyName],
      });
    }
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && !seg.quote.exact.trim()) {
      context.addIssue({
        code: 'custom',
        message: 'Segment quote exact text cannot be empty.',
        path: ['segments', i, 'quote', 'exact'],
      });
    }
  }
  const reconstructedExact = segments
    .map((s, i) => (i > 0 ? (s.separatorBefore ?? '') : '') + s.quote.exact)
    .join('');
  if (reconstructedExact.length > MAX_SELECTED_TEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `Composite ${formatName} anchor text exceeds the maximum selected text length.`,
      path: ['quote', 'exact'],
    });
  }
  if (anchorQuoteExact !== reconstructedExact) {
    context.addIssue({
      code: 'custom',
      message: 'Top-level quote exact text must match the reconstructed text from segments.',
      path: ['quote', 'exact'],
    });
  }
}

export const pdfSegmentSchema = z
  .object({
    pageIndex: z.number().int().min(0).max(10_000_000),
    quote: quoteContextSchema,
    pageLabel: z.string().max(256).exactOptional(),
    rects: z.array(normalizedRectSchema).min(1).max(256).exactOptional(),
    separatorBefore: z.string().max(10_000).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((segment, context) => {
    validateOptionalRange(segment.textStart, segment.textEnd, context);
  });

export const pdfAnchorSchema = z
  .object({
    format: z.literal('pdf'),
    quote: quoteContextSchema,
    pageIndex: z.number().int().min(0).max(10_000_000),
    pageLabel: z.string().max(256).exactOptional(),
    rects: z.array(normalizedRectSchema).min(1).max(256).exactOptional(),
    segments: z.array(pdfSegmentSchema).min(2).max(100).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((anchor, context) => {
    validateOptionalRange(anchor.textStart, anchor.textEnd, context);
    if (anchor.segments && anchor.segments.length > 0) {
      validateCompositeSegments(anchor.segments, 'PDF', (s) => s.pageIndex, 'pageIndex', anchor.quote.exact, context);
      const firstSegment = anchor.segments[0];
      const lastSegment = anchor.segments[anchor.segments.length - 1];
      if (firstSegment && lastSegment) {
        if (anchor.pageIndex !== firstSegment.pageIndex) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level pageIndex must match leading segment pageIndex.',
            path: ['pageIndex'],
          });
        }
        if (anchor.quote.prefix !== firstSegment.quote.prefix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote prefix must match leading segment quote prefix.',
            path: ['quote', 'prefix'],
          });
        }
        if (anchor.quote.suffix !== lastSegment.quote.suffix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote suffix must match trailing segment quote suffix.',
            path: ['quote', 'suffix'],
          });
        }
      }
    }
  });

const epubSegmentSchema = z
  .object({
    cfi: z.string().min(1).max(8_192),
    quote: quoteContextSchema,
    spineHref: z.string().min(1).max(2_048).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    separatorBefore: z.string().max(10_000).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((segment, context) => {
    validateOptionalRange(segment.textStart, segment.textEnd, context);
  });

export const epubAnchorSchema = z
  .object({
    format: z.literal('epub'),
    quote: quoteContextSchema,
    cfi: z.string().min(1).max(8_192),
    spineHref: z.string().min(1).max(2_048).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    segments: z.array(epubSegmentSchema).min(2).max(100).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((anchor, context) => {
    validateOptionalRange(anchor.textStart, anchor.textEnd, context);
    if (anchor.segments && anchor.segments.length > 0) {
      if (anchor.segments.length < 2) {
        context.addIssue({
          code: 'custom',
          message: 'Composite EPUB anchors must contain at least 2 segments.',
          path: ['segments'],
        });
      }
      if (anchor.segments[0]?.separatorBefore !== undefined && anchor.segments[0].separatorBefore.length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'Leading segment cannot have separatorBefore.',
          path: ['segments', 0, 'separatorBefore'],
        });
      }
      for (let i = 0; i < anchor.segments.length; i++) {
        const seg = anchor.segments[i];
        if (seg && !seg.quote.exact.trim()) {
          context.addIssue({
            code: 'custom',
            message: 'Segment quote exact text cannot be empty.',
            path: ['segments', i, 'quote', 'exact'],
          });
        }
      }
      const reconstructedExact = anchor.segments
        .map((s, i) => (i > 0 ? (s.separatorBefore ?? '') : '') + s.quote.exact)
        .join('');
      if (reconstructedExact.length > MAX_SELECTED_TEXT_LENGTH) {
        context.addIssue({
          code: 'custom',
          message: 'Composite EPUB anchor text exceeds the maximum selected text length.',
          path: ['quote', 'exact'],
        });
      }
      if (anchor.quote.exact !== reconstructedExact) {
        context.addIssue({
          code: 'custom',
          message: 'Top-level quote exact text must match the reconstructed text from segments.',
          path: ['quote', 'exact'],
        });
      }
      const firstSegment = anchor.segments[0];
      const lastSegment = anchor.segments[anchor.segments.length - 1];
      if (firstSegment && lastSegment) {
        if (anchor.cfi !== firstSegment.cfi) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level cfi must match leading segment cfi.',
            path: ['cfi'],
          });
        }
        if (anchor.quote.prefix !== firstSegment.quote.prefix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote prefix must match leading segment quote prefix.',
            path: ['quote', 'prefix'],
          });
        }
        if (anchor.quote.suffix !== lastSegment.quote.suffix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote suffix must match trailing segment quote suffix.',
            path: ['quote', 'suffix'],
          });
        }
      }
    }
  });

const mobiSegmentSchema = z
  .object({
    sectionIndex: z.number().int().min(0).max(10_000_000),
    quote: quoteContextSchema,
    byteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    separatorBefore: z.string().max(10_000).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((segment, context) => {
    validateOptionalRange(segment.textStart, segment.textEnd, context);
  });

export const mobiAnchorSchema = z
  .object({
    format: z.literal('mobi'),
    quote: quoteContextSchema,
    sectionIndex: z.number().int().min(0).max(10_000_000),
    byteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    segments: z.array(mobiSegmentSchema).min(2).max(100).exactOptional(),
    ...textRangeShape,
  })
  .strict()
  .superRefine((anchor, context) => {
    validateOptionalRange(anchor.textStart, anchor.textEnd, context);
    if (anchor.segments && anchor.segments.length > 0) {
      validateCompositeSegments(anchor.segments, 'MOBI', (s) => s.sectionIndex, 'sectionIndex', anchor.quote.exact, context);
      const firstSegment = anchor.segments[0];
      const lastSegment = anchor.segments[anchor.segments.length - 1];
      if (firstSegment && lastSegment) {
        if (anchor.sectionIndex !== firstSegment.sectionIndex) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level sectionIndex must match leading segment sectionIndex.',
            path: ['sectionIndex'],
          });
        }
        if (anchor.quote.prefix !== firstSegment.quote.prefix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote prefix must match leading segment quote prefix.',
            path: ['quote', 'prefix'],
          });
        }
        if (anchor.quote.suffix !== lastSegment.quote.suffix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote suffix must match trailing segment quote suffix.',
            path: ['quote', 'suffix'],
          });
        }
      }
    }
  });

export const docxSegmentSchema = z
  .object({
    paragraphIndex: z.number().int().min(0).max(10_000_000),
    quote: quoteContextSchema,
    characterStart: z.number().int().min(0).max(100_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(100_000_000).exactOptional(),
    renderedPageIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    separatorBefore: z.string().max(10_000).exactOptional(),
  })
  .strict()
  .superRefine((segment, context) => {
    validateOptionalRange(
      segment.characterStart,
      segment.characterEnd,
      context,
      'characterStart',
      'characterEnd'
    );
  });

function paragraphAnchorSchema<F extends 'docx' | 'pptx'>(format: F, label: string) {
  return z
  .object({
    format: z.literal(format),
    quote: quoteContextSchema,
    paragraphIndex: z.number().int().min(0).max(10_000_000),
    characterStart: z.number().int().min(0).max(100_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(100_000_000).exactOptional(),
    renderedPageIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    segments: z.array(docxSegmentSchema).min(2).max(100).exactOptional(),
  })
  .strict()
  .superRefine((anchor, context) => {
    validateOptionalRange(
      anchor.characterStart,
      anchor.characterEnd,
      context,
      'characterStart',
      'characterEnd'
    );
    if (anchor.segments && anchor.segments.length > 0) {
      validateCompositeSegments(anchor.segments, label, (s) => s.paragraphIndex, 'paragraphIndex', anchor.quote.exact, context);
      const firstSegment = anchor.segments[0];
      const lastSegment = anchor.segments[anchor.segments.length - 1];
      if (firstSegment && lastSegment) {
        if (anchor.paragraphIndex !== firstSegment.paragraphIndex) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level paragraphIndex must match leading segment paragraphIndex.',
            path: ['paragraphIndex'],
          });
        }
        if (anchor.quote.prefix !== firstSegment.quote.prefix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote prefix must match leading segment quote prefix.',
            path: ['quote', 'prefix'],
          });
        }
        if (anchor.quote.suffix !== lastSegment.quote.suffix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote suffix must match trailing segment quote suffix.',
            path: ['quote', 'suffix'],
          });
        }
      }
    }
  });
}

export const docxAnchorSchema = paragraphAnchorSchema('docx', 'DOCX');
export const pptxAnchorSchema = paragraphAnchorSchema('pptx', 'PPTX');

export const markdownSegmentSchema = z
  .object({
    blockIndex: z.number().int().min(0).max(10_000_000),
    quote: quoteContextSchema,
    characterStart: z.number().int().min(0).max(100_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(100_000_000).exactOptional(),
    lineIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    headingId: z.string().min(1).max(256).exactOptional(),
    separatorBefore: z.string().max(10_000).exactOptional(),
  })
  .strict()
  .superRefine((segment, context) => {
    validateOptionalRange(
      segment.characterStart,
      segment.characterEnd,
      context,
      'characterStart',
      'characterEnd'
    );
  });

export const markdownAnchorSchema = z
  .object({
    format: z.literal('markdown'),
    quote: quoteContextSchema,
    blockIndex: z.number().int().min(0).max(10_000_000),
    characterStart: z.number().int().min(0).max(100_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(100_000_000).exactOptional(),
    lineIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    headingId: z.string().min(1).max(256).exactOptional(),
    segments: z.array(markdownSegmentSchema).min(2).max(100).exactOptional(),
  })
  .strict()
  .superRefine((anchor, context) => {
    validateOptionalRange(
      anchor.characterStart,
      anchor.characterEnd,
      context,
      'characterStart',
      'characterEnd'
    );
    if (anchor.segments && anchor.segments.length > 0) {
      validateCompositeSegments(anchor.segments, 'Markdown', (s) => s.blockIndex, 'blockIndex', anchor.quote.exact, context);
      const firstSegment = anchor.segments[0];
      const lastSegment = anchor.segments[anchor.segments.length - 1];
      if (firstSegment && lastSegment) {
        if (anchor.blockIndex !== firstSegment.blockIndex) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level blockIndex must match leading segment blockIndex.',
            path: ['blockIndex'],
          });
        }
        if (anchor.quote.prefix !== firstSegment.quote.prefix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote prefix must match leading segment quote prefix.',
            path: ['quote', 'prefix'],
          });
        }
        if (anchor.quote.suffix !== lastSegment.quote.suffix) {
          context.addIssue({
            code: 'custom',
            message: 'Top-level quote suffix must match trailing segment quote suffix.',
            path: ['quote', 'suffix'],
          });
        }
      }
    }
  });
export const documentAnchorSchema = z.discriminatedUnion('format', [
  pdfAnchorSchema,
  epubAnchorSchema,
  mobiAnchorSchema,
  docxAnchorSchema,
  pptxAnchorSchema,
  markdownAnchorSchema,
]);
const createAnnotationBaseSchema = z
  .object({
    documentId: identifierSchema,
    type: annotationTypeSchema,
    anchor: documentAnchorSchema,
    // Each member applies only to some annotation types; absent means the
    // created annotation stores `null` (or `false`) for it.
    selectedText: selectedTextSchema.exactOptional(),
    note: noteSchema.exactOptional(),
    label: labelSchema.exactOptional(),
    color: highlightColorSchema.exactOptional(),
    isLocationNote: z.boolean().exactOptional(),
  })
  .strict();

export const createAnnotationRequestSchema = createAnnotationBaseSchema.superRefine((value, context) => {
  const selectedText = value.selectedText ?? null;
  const note = value.note ?? null;
  const label = value.label ?? null;
  const color = value.color ?? null;
  const isLocationNote = value.isLocationNote ?? false;
  const hasRange = value.anchor.quote.exact.length > 0;

  if (value.type === 'highlight') {
    if (selectedText === null || !hasRange) {
      context.addIssue({ code: 'custom', message: 'Highlights require selected text and an exact quote.' });
    }
    if (color === null) {
      context.addIssue({ code: 'custom', message: 'Highlights require a color.', path: ['color'] });
    }
    if (isLocationNote || label !== null) {
      context.addIssue({ code: 'custom', message: 'Highlights cannot be location notes or bookmarks.' });
    }
    if (selectedText !== null && value.anchor.quote.exact !== selectedText) {
      context.addIssue({ code: 'custom', message: 'Selected text must match the anchor quote.', path: ['selectedText'] });
    }
  } else if (value.type === 'note') {
    if (note === null) {
      context.addIssue({ code: 'custom', message: 'Notes require note text.', path: ['note'] });
    }
    if (isLocationNote === hasRange) {
      context.addIssue({
        code: 'custom',
        message: 'A note must be attached to either a text range or a location, but not both.',
      });
    }
    if (!isLocationNote && selectedText === null) {
      context.addIssue({ code: 'custom', message: 'Range notes require selected text.', path: ['selectedText'] });
    }
    if (isLocationNote && selectedText !== null) {
      context.addIssue({ code: 'custom', message: 'Location notes cannot have selected text.', path: ['selectedText'] });
    }
    if (!isLocationNote && selectedText !== null && value.anchor.quote.exact !== selectedText) {
      context.addIssue({ code: 'custom', message: 'Selected text must match the anchor quote.', path: ['selectedText'] });
    }
    if (color !== null || label !== null) {
      context.addIssue({ code: 'custom', message: 'Notes cannot carry a highlight color or bookmark label.' });
    }
  } else if (
    selectedText !== null ||
    note !== null ||
    color !== null ||
    isLocationNote ||
    hasRange
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Bookmarks can only carry a location anchor and an optional label.',
    });
  }
});

export const updateAnnotationRequestSchema = z
  .object({
    documentId: identifierSchema,
    id: identifierSchema,
    // Patch semantics: absent leaves the field unchanged, `null` clears it.
    note: noteSchema.nullable().exactOptional(),
    label: labelSchema.nullable().exactOptional(),
    color: highlightColorSchema.nullable().exactOptional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.note === undefined && value.label === undefined && value.color === undefined) {
      context.addIssue({ code: 'custom', message: 'At least one annotation field must be updated.' });
    }
  });

export const annotationFilterSchema = z
  .object({
    type: annotationTypeSchema.exactOptional(),
    searchQuery: z.string().max(200).exactOptional(),
    sort: z.enum(['updated_desc', 'created_desc', 'created_asc']).exactOptional(),
    offset: z.number().int().min(0).max(10_000_000).exactOptional(),
    limit: z.number().int().min(1).max(100).exactOptional(),
    scope: annotationAnchorScopeSchema.exactOptional(),
    documentHashNot: documentHashSchema.exactOptional(),
  })
  .strict();

export const listAnnotationsRequestSchema = z
  .object({
    documentId: identifierSchema,
    filter: annotationFilterSchema.exactOptional(),
  })
  .strict();

export const deleteAnnotationRequestSchema = z.object({ documentId: identifierSchema, id: identifierSchema }).strict();

export const repairAnnotationAnchorRequestSchema = z
  .object({
    documentId: identifierSchema,
    id: identifierSchema,
    documentHash: documentHashSchema,
    anchor: documentAnchorSchema,
    status: annotationStatusSchema,
  })
  .strict();

export function parseDocumentAnchor(value: PortableValue): DocumentAnchor | null {
  const parsed = documentAnchorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
