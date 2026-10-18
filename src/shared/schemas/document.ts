import { z } from 'zod';
import type { PortableMember, PortableValue } from '../models/portable';
import type { ChatSelectionDescriptor } from '../types/document';
import {
  MAX_WEB_ARTICLE_BLOCKS,
  MAX_WEB_ARTICLE_IMAGES,
  MAX_WEB_ARTICLE_SITE_NAME_LENGTH,
  MAX_WEB_ARTICLE_URL_LENGTH,
  webArticleProvenanceUrlProblem,
  webArticleUrlProblem,
} from '../constants/web-article';

const identifierSchema = z.string().min(1).max(128);
const hostPathSchema = z.string().min(1).max(4096);

export const documentFormatSchema = z.enum(['pdf', 'epub', 'mobi', 'docx', 'pptx', 'markdown']);

export const storageModeSchema = z.enum(['managed', 'link']);

export const storageHealthSchema = z.enum(['ok', 'missing', 'changed', 'checking']);

export const pdfLocationSchema = z
  .object({
    format: z.literal('pdf'),
    pageIndex: z.number().int().min(0).max(10_000_000),
    pageLabel: z.string().max(256).exactOptional(),
    textStart: z.number().int().min(0).max(10_000_000).exactOptional(),
    textEnd: z.number().int().min(0).max(10_000_000).exactOptional(),
  })
  .strict()
  .superRefine((location, context) => {
    if ((location.textStart === undefined) !== (location.textEnd === undefined)) {
      context.addIssue({ code: 'custom', message: 'PDF text range endpoints must be provided together.', path: ['textEnd'] });
    } else if (location.textStart !== undefined && location.textEnd !== undefined && location.textEnd <= location.textStart) {
      context.addIssue({ code: 'custom', message: 'PDF text range end must be greater than its start.', path: ['textEnd'] });
    }
  });

export const epubLocationSchema = z
  .object({
    format: z.literal('epub'),
    cfi: z.string().min(1).max(8192),
    spineHref: z.string().max(2048).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    textStart: z.number().int().min(0).max(10_000_000).exactOptional(),
    textEnd: z.number().int().min(0).max(10_000_000).exactOptional(),
  })
  .strict()
  .superRefine((location, context) => {
    if ((location.textStart === undefined) !== (location.textEnd === undefined)) {
      context.addIssue({ code: 'custom', message: 'EPUB text range endpoints must be provided together.', path: ['textEnd'] });
    } else if (location.textStart !== undefined && location.textEnd !== undefined && location.textEnd <= location.textStart) {
      context.addIssue({ code: 'custom', message: 'EPUB text range end must be greater than its start.', path: ['textEnd'] });
    }
  });

export const mobiLocationSchema = z
  .object({
    format: z.literal('mobi'),
    sectionIndex: z.number().int().min(0).max(10_000_000),
    byteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
    textStart: z.number().int().min(0).max(10_000_000).exactOptional(),
    textEnd: z.number().int().min(0).max(10_000_000).exactOptional(),
  })
  .strict()
  .superRefine((location, context) => {
    if ((location.textStart === undefined) !== (location.textEnd === undefined)) {
      context.addIssue({ code: 'custom', message: 'MOBI text range endpoints must be provided together.', path: ['textEnd'] });
    } else if (location.textStart !== undefined && location.textEnd !== undefined && location.textEnd <= location.textStart) {
      context.addIssue({ code: 'custom', message: 'MOBI text range end must be greater than its start.', path: ['textEnd'] });
    }
  });

function paragraphLocationSchema<F extends 'docx' | 'pptx'>(format: F, label: string) {
  return z
  .object({
    format: z.literal(format),
    paragraphIndex: z.number().int().min(0).max(10_000_000),
    characterStart: z.number().int().min(0).max(10_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(10_000_000).exactOptional(),
    renderedPageIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
  })
  .strict()
  .superRefine((location, context) => {
    const hasStart = location.characterStart !== undefined;
    const hasEnd = location.characterEnd !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: 'custom',
        message: `${label} character range endpoints must be provided together.`,
        path: hasStart ? ['characterEnd'] : ['characterStart'],
      });
    } else if (
      location.characterStart !== undefined &&
      location.characterEnd !== undefined &&
      location.characterEnd <= location.characterStart
    ) {
      context.addIssue({
        code: 'custom',
        message: `${label} character range end must be greater than its start.`,
        path: ['characterEnd'],
      });
    }
  });
}

export const docxLocationSchema = paragraphLocationSchema('docx', 'DOCX');
export const pptxLocationSchema = paragraphLocationSchema('pptx', 'PPTX');

export const markdownLocationSchema = z
  .object({
    format: z.literal('markdown'),
    blockIndex: z.number().int().min(0).max(10_000_000),
    characterStart: z.number().int().min(0).max(10_000_000).exactOptional(),
    characterEnd: z.number().int().min(0).max(10_000_000).exactOptional(),
    lineIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    headingId: z.string().min(1).max(256).exactOptional(),
    progression: z.number().min(0).max(1).exactOptional(),
  })
  .strict()
  .superRefine((location, context) => {
    const hasStart = location.characterStart !== undefined;
    const hasEnd = location.characterEnd !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: 'custom',
        message: 'Markdown character range endpoints must be provided together.',
        path: hasStart ? ['characterEnd'] : ['characterStart'],
      });
    } else if (
      location.characterStart !== undefined &&
      location.characterEnd !== undefined &&
      location.characterEnd <= location.characterStart
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Markdown character range end must be greater than its start.',
        path: ['characterEnd'],
      });
    }
  });

export const documentLocationSchema = z.discriminatedUnion('format', [
  pdfLocationSchema,
  epubLocationSchema,
  mobiLocationSchema,
  docxLocationSchema,
  pptxLocationSchema,
  markdownLocationSchema,
]);

/** Validates a stored or freshly parsed location. */
export function parseDocumentLocation(
  value: PortableMember | z.output<typeof documentLocationSchema>,
): z.output<typeof documentLocationSchema> | null {
  const parsed = documentLocationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const readingPositionSchema = z
  .object({
    location: documentLocationSchema,
    progress: z.number().min(0).max(1),
    updatedAt: z.string(),
  })
  .strict();

export const documentSortOptionSchema = z.enum([
  'title_asc',
  'title_desc',
  'recent_added',
  'recent_read',
  'author_asc',
]);

export const documentFilterSchema = z
  .object({
    // Absent lists every folder; `null` lists only documents outside any folder.
    folderId: identifierSchema.nullable().exactOptional(),
    searchQuery: z.string().max(200).exactOptional(),
    format: documentFormatSchema.exactOptional(),
    storageMode: storageModeSchema.exactOptional(),
    sort: documentSortOptionSchema.exactOptional(),
    offset: z.number().int().min(0).max(100_000).exactOptional(),
    limit: z.number().int().min(1).max(100).exactOptional(),
  })
  .strict()
  .optional();

export const storageHealthUpdateSchema = z
  .object({
    documentId: identifierSchema,
    storageHealth: storageHealthSchema,
    storageHealthMessage: z.string().max(1024).exactOptional(),
  })
  .strict();

export const documentImportOptionsSchema = z
  .object({
    // Absent means the configured default storage mode.
    storageMode: storageModeSchema.exactOptional(),
    // `null` imports into the library root.
    folderId: identifierSchema.nullable(),
  })
  .strict()
  .optional();

export const importDroppedFilesRequestSchema = z.object({
  filePaths: z.array(hostPathSchema).min(1).max(32),
  options: documentImportOptionsSchema.unwrap().exactOptional(),
}).strict();

/**
 * Structural gate for a submitted URL. This is the *outer* bound only: it
 * rejects obvious junk cheaply so main never parses an unbounded string. Every
 * security decision that matters — scheme, port, credentials, resolved address,
 * and each redirect hop — is made by main's address policy, not here, because a
 * schema cannot see DNS. It shares its rules with the renderer's inline hint so
 * a user gets identical wording without an extra IPC round trip.
 */
const webArticleUrlInputSchema = z
  .string()
  .trim()
  .min(1, 'Enter a web address.')
  .max(MAX_WEB_ARTICLE_URL_LENGTH, 'That web address is too long.')
  .superRefine((value, context) => {
    const problem = webArticleUrlProblem(value);
    if (problem !== null) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });

export const importWebArticleRequestSchema = z
  .object({
    url: webArticleUrlInputSchema,
    options: documentImportOptionsSchema.unwrap().exactOptional(),
  })
  .strict();

/**
 * The image-completeness summary that crosses into the renderer.
 *
 * Strict and numeric on purpose: the bridge accepts two bounded counts and
 * refuses anything else, so no URL, path, host, or failure reason can ride
 * along inside this value even if a future caller tries to attach one.
 *
 * Both ceilings are the real ones rather than a round number. A snapshot cannot
 * hold more images than the archive bound, and archived and omitted together
 * partition the image candidates extraction recognized, so neither can exceed
 * that recognition bound — anything larger is a bug upstream and is refused
 * here rather than shown to a reader.
 */
export const webArticleMediaSummarySchema = z
  .object({
    archived: z.number().int().min(0).max(MAX_WEB_ARTICLE_IMAGES),
    omitted: z
      .number()
      .int()
      .min(0)
      .max(MAX_WEB_ARTICLE_BLOCKS),
  })
  .strict();

/**
 * A stored provenance URL.
 *
 * Deliberately stricter than `webArticleUrlInputSchema`: that one bounds what a
 * user may ask Interleaf to try, this one bounds what Interleaf has already
 * decided to keep. Every boundary that persists or reads a source — the IPC
 * result, the library service, and the document repository — parses through
 * here, so a row can only hold a canonical, credential-free, fragment-free
 * `http`/`https` address.
 */
const webArticleProvenanceUrlSchema = z
  .string()
  .max(MAX_WEB_ARTICLE_URL_LENGTH)
  .superRefine((value, context) => {
    const problem = webArticleProvenanceUrlProblem(value);
    if (problem !== null) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });

const documentWebSourceSchema = z
  .object({
    kind: z.literal('web'),
    url: webArticleProvenanceUrlSchema,
    // A site name is page-supplied text: bounded, single-line, and either
    // absent or actually saying something.
    siteName: z
      .string()
      .min(1)
      .max(MAX_WEB_ARTICLE_SITE_NAME_LENGTH)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Site name contains control characters')
      .refine((value) => value.trim() === value, 'Site name has leading or trailing whitespace')
      .nullable(),
    capturedAt: z.iso.datetime(),
  })
  .strict();

export const documentSourceSchema = z.discriminatedUnion('kind', [
  documentWebSourceSchema,
]);

export const createFolderRequestSchema = z.object({
  name: z.string().trim().min(1, 'Folder name cannot be empty').max(255, 'Folder name too long'),
  // `null` creates a top-level folder.
  parentId: identifierSchema.nullable(),
}).strict();

export const renameFolderRequestSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1, 'Folder name cannot be empty').max(255, 'Folder name too long'),
}).strict();

export const deleteFolderRequestSchema = z.object({
  id: identifierSchema,
}).strict();

export const moveDocumentToFolderRequestSchema = z.object({
  documentId: identifierSchema,
  folderId: identifierSchema.nullable(),
}).strict();

export const deleteDocumentRequestSchema = z.object({
  id: identifierSchema,
}).strict();

export const openDocumentRequestSchema = z.object({
  id: identifierSchema,
}).strict();

export const closeDocumentRequestSchema = z.object({
  id: identifierSchema,
}).strict();

export const updateReadingPositionRequestSchema = z.object({
  documentId: identifierSchema,
  location: documentLocationSchema,
  progress: z.number().min(0).max(1),
}).strict();

export const limitQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).exactOptional(),
  })
  .strict()
  .optional();

export const getDocumentPreviewRequestSchema = z
  .object({
    documentId: identifierSchema,
    // `null` previews the last-read position.
    location: documentLocationSchema.nullable(),
  })
  .strict();

export const mediaAssetUrlSchema = z
  .string()
  .regex(/^interleaf-media:\/\//, 'Media URL must use interleaf-media:// scheme')
  .max(4096)
  .nullable();

export const documentPreviewDataSchema = z
  .object({
    documentId: identifierSchema,
    format: documentFormatSchema,
    locationLabel: z.string().max(256),
    isLastRead: z.boolean(),
    snippet: z.string().max(2048),
    coverAssetUrl: mediaAssetUrlSchema,
    fallback: z.boolean(),
  })
  .strict();


const quoteContextStrictSchema = z
  .object({
    exact: z.string().max(256_000),
    prefix: z.string().max(2_000).default(''),
    suffix: z.string().max(2_000).default(''),
  })
  .strict();

export function parseEpubCfiSpineIndex(cfi: string): number | null {
  const wrapperMatch = /^epubcfi\((.*)\)$/u.exec(cfi);
  const unwrapped = wrapperMatch?.[1] ?? cfi;
  const packagePath = unwrapped.split('!')[0] ?? '';
  const match = /\/6\/(\d+)(?:\[|\/|$)/u.exec(packagePath);
  if (!match?.[1]) return null;
  const step = Number(match[1]);
  if (!Number.isSafeInteger(step) || step < 2 || step % 2 !== 0) return null;
  const index = step / 2 - 1;
  return index >= 0 && index <= 10_000_000 ? index : null;
}

export const pdfChatSelectionDescriptorSchema = z
  .object({
    format: z.literal('pdf'),
    startPageIndex: z.number().int().min(0).max(10_000_000),
    endPageIndex: z.number().int().min(0).max(10_000_000),
    startPageLabel: z.string().max(256).exactOptional(),
    endPageLabel: z.string().max(256).exactOptional(),
    startQuote: quoteContextStrictSchema.exactOptional(),
    endQuote: quoteContextStrictSchema.exactOptional(),
    startTextOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    endTextOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    selectedTextSnippet: z.string().max(4_096).exactOptional(),
  })
  .strict()
  .refine((data) => data.startPageIndex <= data.endPageIndex, {
    message: 'startPageIndex must be less than or equal to endPageIndex',
  })
  .refine(
    (data) =>
      data.startPageIndex !== data.endPageIndex ||
      data.startTextOffset === undefined ||
      data.endTextOffset === undefined ||
      data.startTextOffset <= data.endTextOffset,
    {
      message: 'startTextOffset must be less than or equal to endTextOffset on the same page',
    }
  );

export const markdownChatSelectionDescriptorSchema = z
  .object({
    format: z.literal('markdown'),
    startBlockIndex: z.number().int().min(0).max(10_000_000),
    endBlockIndex: z.number().int().min(0).max(10_000_000),
    startLineIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    endLineIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    startHeadingId: z.string().max(256).exactOptional(),
    endHeadingId: z.string().max(256).exactOptional(),
    startQuote: quoteContextStrictSchema.exactOptional(),
    endQuote: quoteContextStrictSchema.exactOptional(),
    startCharacterOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    endCharacterOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    selectedTextSnippet: z.string().max(4_096).exactOptional(),
  })
  .strict()
  .refine((data) => data.startBlockIndex <= data.endBlockIndex, {
    message: 'startBlockIndex must be less than or equal to endBlockIndex',
  })
  .refine(
    (data) =>
      data.startBlockIndex !== data.endBlockIndex ||
      data.startCharacterOffset === undefined ||
      data.endCharacterOffset === undefined ||
      data.startCharacterOffset <= data.endCharacterOffset,
    {
      message: 'startCharacterOffset must be less than or equal to endCharacterOffset in the same block',
    }
  )
  .refine(
    (data) =>
      data.startLineIndex === undefined ||
      data.endLineIndex === undefined ||
      data.startLineIndex <= data.endLineIndex,
    {
      message: 'startLineIndex must be less than or equal to endLineIndex',
    }
  );

function paragraphSelectionDescriptorSchema<F extends 'docx' | 'pptx'>(format: F) {
  return z
  .object({
    format: z.literal(format),
    startParagraphIndex: z.number().int().min(0).max(10_000_000),
    endParagraphIndex: z.number().int().min(0).max(10_000_000),
    startRenderedPageIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    endRenderedPageIndex: z.number().int().min(0).max(10_000_000).exactOptional(),
    startQuote: quoteContextStrictSchema.exactOptional(),
    endQuote: quoteContextStrictSchema.exactOptional(),
    startCharacterOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    endCharacterOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    selectedTextSnippet: z.string().max(4_096).exactOptional(),
  })
  .strict()
  .refine((data) => data.startParagraphIndex <= data.endParagraphIndex, {
    message: 'startParagraphIndex must be less than or equal to endParagraphIndex',
  })
  .refine(
    (data) =>
      data.startParagraphIndex !== data.endParagraphIndex ||
      data.startCharacterOffset === undefined ||
      data.endCharacterOffset === undefined ||
      data.startCharacterOffset <= data.endCharacterOffset,
    {
      message: 'startCharacterOffset must be less than or equal to endCharacterOffset in the same paragraph',
    }
  );
}

export const docxChatSelectionDescriptorSchema = paragraphSelectionDescriptorSchema('docx');
export const pptxChatSelectionDescriptorSchema = paragraphSelectionDescriptorSchema('pptx');

export const epubChatSelectionDescriptorSchema = z
  .object({
    format: z.literal('epub'),
    startSpineHref: z.string().min(1).max(2048),
    endSpineHref: z.string().min(1).max(2048),
    startCfi: z.string().min(1).max(8192).exactOptional(),
    endCfi: z.string().min(1).max(8192).exactOptional(),
    startProgression: z.number().min(0).max(1).exactOptional(),
    endProgression: z.number().min(0).max(1).exactOptional(),
    startQuote: quoteContextStrictSchema.exactOptional(),
    endQuote: quoteContextStrictSchema.exactOptional(),
    selectedTextSnippet: z.string().max(4_096).exactOptional(),
  })
  .strict()
  .refine(
    (data) => {
      if (!data.startCfi || !data.endCfi) return true;
      const startSpine = parseEpubCfiSpineIndex(data.startCfi);
      const endSpine = parseEpubCfiSpineIndex(data.endCfi);
      if (startSpine === null || endSpine === null) return true;
      return startSpine <= endSpine;
    },
    {
      message: 'startCfi spine index must be less than or equal to endCfi spine index',
    }
  )
  .refine(
    (data) =>
      data.startSpineHref !== data.endSpineHref ||
      data.startProgression === undefined ||
      data.endProgression === undefined ||
      data.startProgression <= data.endProgression,
    {
      message: 'startProgression must be less than or equal to endProgression within the same section',
    }
  );

export const mobiChatSelectionDescriptorSchema = z
  .object({
    format: z.literal('mobi'),
    startSectionIndex: z.number().int().min(0).max(10_000_000),
    endSectionIndex: z.number().int().min(0).max(10_000_000),
    startQuote: quoteContextStrictSchema.exactOptional(),
    endQuote: quoteContextStrictSchema.exactOptional(),
    startOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    endOffset: z.number().int().min(0).max(100_000_000).exactOptional(),
    selectedTextSnippet: z.string().max(4_096).exactOptional(),
  })
  .strict()
  .refine((data) => data.startSectionIndex <= data.endSectionIndex, {
    message: 'startSectionIndex must be less than or equal to endSectionIndex',
  })
  .refine(
    (data) =>
      data.startSectionIndex !== data.endSectionIndex ||
      data.startOffset === undefined ||
      data.endOffset === undefined ||
      data.startOffset <= data.endOffset,
    {
      message: 'startOffset must be less than or equal to endOffset in the same section',
    }
  );

export const chatSelectionDescriptorSchema = z.discriminatedUnion('format', [
  pdfChatSelectionDescriptorSchema,
  markdownChatSelectionDescriptorSchema,
  docxChatSelectionDescriptorSchema,
  pptxChatSelectionDescriptorSchema,
  epubChatSelectionDescriptorSchema,
  mobiChatSelectionDescriptorSchema,
]);

export function parseChatSelectionDescriptor(input: PortableValue): ChatSelectionDescriptor | null {
  const parsed = chatSelectionDescriptorSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
