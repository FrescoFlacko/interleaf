import type { z } from 'zod';
import {
  annotationTypeSchema,
  highlightColorSchema,
  type annotationAnchorScopeSchema,
  type annotationFilterSchema,
  type annotationStatusSchema,
  type createAnnotationRequestSchema,
  type docxAnchorSchema,
  type docxSegmentSchema,
  type documentAnchorSchema,
  type epubAnchorSchema,
  type markdownAnchorSchema,
  type markdownSegmentSchema,
  type mobiAnchorSchema,
  type normalizedRectSchema,
  type pdfAnchorSchema,
  type pdfSegmentSchema,
  type pptxAnchorSchema,
  type quoteContextSchema,
  type repairAnnotationAnchorRequestSchema,
  type updateAnnotationRequestSchema,
} from '../schemas/annotation';

export const HIGHLIGHT_COLORS = highlightColorSchema.options;
export type HighlightColor = z.output<typeof highlightColorSchema>;

export type AnnotationType = z.output<typeof annotationTypeSchema>;

export type AnnotationStatus = z.output<typeof annotationStatusSchema>;

export type NormalizedRect = z.output<typeof normalizedRectSchema>;
export type QuoteContext = z.output<typeof quoteContextSchema>;

export type PdfAnchorSegment = z.output<typeof pdfSegmentSchema>;
export type PdfAnnotationAnchor = z.output<typeof pdfAnchorSchema>;
export type EpubAnnotationAnchor = z.output<typeof epubAnchorSchema>;
export type MobiAnnotationAnchor = z.output<typeof mobiAnchorSchema>;
export type DocxAnchorSegment = z.output<typeof docxSegmentSchema>;
export type DocxAnnotationAnchor = z.output<typeof docxAnchorSchema>;
/** PPTX anchors share the DOCX paragraph model; see `PptxLocation`. */
export type PptxAnnotationAnchor = z.output<typeof pptxAnchorSchema>;
export type MarkdownAnchorSegment = z.output<typeof markdownSegmentSchema>;
export type MarkdownAnnotationAnchor = z.output<typeof markdownAnchorSchema>;
export type DocumentAnchor = z.output<typeof documentAnchorSchema>;

export type Annotation = {
  readonly id: string;
  readonly documentId: string;
  /** Hash of the document revision against which `anchor` was resolved. */
  readonly documentHash: string;
  readonly type: AnnotationType;
  readonly anchor: DocumentAnchor;
  readonly selectedText: string | null;
  readonly note: string | null;
  readonly label: string | null;
  readonly color: HighlightColor | null;
  readonly isLocationNote: boolean;
  readonly status: AnnotationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AnnotationAnchorScope = z.output<typeof annotationAnchorScopeSchema>;
export type AnnotationFilter = z.output<typeof annotationFilterSchema>;
export type AnnotationSort = NonNullable<AnnotationFilter['sort']>;

export type AnnotationPage = {
  readonly items: readonly Annotation[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
};

export type CreateAnnotationInput = z.output<typeof createAnnotationRequestSchema>;
export type UpdateAnnotationInput = z.output<typeof updateAnnotationRequestSchema>;
export type RepairAnnotationAnchorInput = z.output<typeof repairAnnotationAnchorRequestSchema>;
