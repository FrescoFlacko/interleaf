import type { z } from 'zod';
import type {
  chatSelectionDescriptorSchema,
  docxChatSelectionDescriptorSchema,
  docxLocationSchema,
  documentFilterSchema,
  documentFormatSchema,
  documentImportOptionsSchema,
  documentLocationSchema,
  documentPreviewDataSchema,
  documentSortOptionSchema,
  documentSourceSchema,
  epubChatSelectionDescriptorSchema,
  epubLocationSchema,
  markdownChatSelectionDescriptorSchema,
  markdownLocationSchema,
  mobiChatSelectionDescriptorSchema,
  mobiLocationSchema,
  pdfChatSelectionDescriptorSchema,
  pdfLocationSchema,
  pptxChatSelectionDescriptorSchema,
  pptxLocationSchema,
  readingPositionSchema,
  storageHealthSchema,
  storageHealthUpdateSchema,
  storageModeSchema,
  webArticleMediaSummarySchema,
} from '../schemas/document';

export type DocumentFormat = z.output<typeof documentFormatSchema>;
export type StorageMode = z.output<typeof storageModeSchema>;
export type StorageHealth = z.output<typeof storageHealthSchema>;

export type PdfLocation = z.output<typeof pdfLocationSchema>;
export type EpubLocation = z.output<typeof epubLocationSchema>;
export type MobiLocation = z.output<typeof mobiLocationSchema>;
export type DocxLocation = z.output<typeof docxLocationSchema>;
/**
 * A PPTX location shares the DOCX paragraph model: `paragraphIndex` counts
 * paragraphs across the whole deck in slide order and `renderedPageIndex` is
 * the zero-based slide index.
 */
export type PptxLocation = z.output<typeof pptxLocationSchema>;
export type MarkdownLocation = z.output<typeof markdownLocationSchema>;
export type DocumentLocation = z.output<typeof documentLocationSchema>;

export type ReadingPosition = z.output<typeof readingPositionSchema>;

/**
 * Where a managed document came from, when that is not the user's own file.
 *
 * This is deliberately a small closed union rather than free-form metadata: it
 * is persisted from untrusted network input, so every member is bounded and
 * carries no host path, no credential, and no fragment of the original page.
 */
export type DocumentSource = z.output<typeof documentSourceSchema>;

export type DocumentMetadata = {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly format: DocumentFormat;
  readonly storageMode: StorageMode;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileHash: string;
  readonly pageCount: number | null;
  readonly folderId: string | null;
  readonly storageHealth: StorageHealth;
  readonly storageHealthMessage?: string;
  readonly readingPosition: ReadingPosition | null;
  /** Non-file provenance, or `null` for documents the user imported themselves. */
  readonly source: DocumentSource | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DocumentPreviewData = z.output<typeof documentPreviewDataSchema>;

export type Folder = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly documentCount: number;
};

export type FolderTree = Folder & {
  readonly children: readonly FolderTree[];
};

export type DocumentSortOption = z.output<typeof documentSortOptionSchema>;
export type DocumentFilter = NonNullable<z.input<typeof documentFilterSchema>>;
export type StorageHealthUpdate = z.output<typeof storageHealthUpdateSchema>;

export type LibrarySummary = {
  readonly totalDocuments: number;
  readonly formatCounts: Readonly<Record<DocumentFormat, number>>;
  readonly managedCount: number;
  readonly linkCount: number;
  readonly missingCount: number;
  readonly changedCount: number;
  readonly totalFolders: number;
};

export type DocumentImportOptions = NonNullable<z.input<typeof documentImportOptionsSchema>>;

export type ImportFileError = {
  readonly fileName: string;
  readonly error: string;
};

export type BatchImportResult = {
  readonly imported: readonly DocumentMetadata[];
  readonly failed: readonly ImportFileError[];
  readonly totalAttempted: number;
};

/**
 * How much of an article's imagery the snapshot actually kept.
 *
 * Two counts and nothing else. The renderer is told that some pictures are
 * missing and how many, which is all a reader needs to judge the snapshot; it
 * is never told which images, from where, or why, because every available
 * reason — an address the fetcher refused, a host that timed out, a payload
 * that failed decoding — describes Interleaf's network and security behavior to
 * untrusted UI.
 */
export type WebArticleMediaSummary = z.output<typeof webArticleMediaSummarySchema>;

/** Renderer-visible outcome of a single web-article import. */
export type WebArticleImportResult = {
  readonly document: DocumentMetadata;
  /** True when an identical snapshot already existed and was reused. */
  readonly alreadyInLibrary: boolean;
  readonly media: WebArticleMediaSummary;
};

/**
 * The import result as the preload bridge hands it to the renderer.
 *
 * The bridge re-checks the media summary rather than trusting it; a summary
 * that fails that check is `null`, so an unverifiable count is never shown as
 * a real one.
 */
export type WebArticleImportOutcome = Omit<WebArticleImportResult, 'media'> & {
  readonly media: WebArticleMediaSummary | null;
};

export type TableOfContentsItem = {
  readonly id: string;
  readonly title: string;
  /**
   * `null` when the source document's destination for this entry cannot be
   * resolved to a real location — a named PDF destination missing from the
   * document, or a malformed/out-of-range one. The entry still belongs in the
   * outline, but it has no page to show and nowhere to navigate: adapters must
   * report the absence rather than substitute a plausible location.
   */
  readonly location: DocumentLocation | null;
  readonly level: number;
  /** Empty for a leaf entry. */
  readonly children: readonly TableOfContentsItem[];
};

export type SearchMatch = {
  readonly id: string;
  readonly location: DocumentLocation;
  readonly text: string;
  /** UTF-16 offsets in the native location text used to resolve the exact range. */
  readonly textStart?: number;
  readonly textEnd?: number;
  readonly prefix: string;
  readonly suffix: string;
};

export type NormalizedTextChunk = {
  readonly id: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly tokenCount: number;
  readonly location: DocumentLocation;
  readonly heading: string | null;
  readonly pageLabel: string | null;
};

/**
 * One archived image an open document may display.
 *
 * `reference` is the durable identity written into the snapshot itself; `url`
 * is a short-lived capability that main issued for this open document in this
 * renderer scope. The renderer is given the pairing and never a path, and the
 * capability stops resolving as soon as the document closes.
 */
export type DocumentMediaAsset = {
  readonly reference: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
};

export type OpenedDocument = {
  readonly document: DocumentMetadata;
  readonly assetUrl: string;
  /** Empty for documents that archived no images. */
  readonly mediaAssets: readonly DocumentMediaAsset[];
};

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

export type PdfChatSelectionDescriptor = z.output<typeof pdfChatSelectionDescriptorSchema>;
export type MarkdownChatSelectionDescriptor = z.output<typeof markdownChatSelectionDescriptorSchema>;
export type DocxChatSelectionDescriptor = z.output<typeof docxChatSelectionDescriptorSchema>;
/** Same shape as DOCX; rendered page indices are slide indices. */
export type PptxChatSelectionDescriptor = z.output<typeof pptxChatSelectionDescriptorSchema>;
export type EpubChatSelectionDescriptor = z.output<typeof epubChatSelectionDescriptorSchema>;
export type MobiChatSelectionDescriptor = z.output<typeof mobiChatSelectionDescriptorSchema>;
export type ChatSelectionDescriptor = z.output<typeof chatSelectionDescriptorSchema>;
