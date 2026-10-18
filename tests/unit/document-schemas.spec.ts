import { describe, expect, it } from 'vitest';
import {
  documentPreviewDataSchema,
  documentLocationSchema,
  getDocumentPreviewRequestSchema,
  mediaAssetUrlSchema,
} from '../../src/shared/schemas/document';

describe('Document Preview Schemas & URL Policy', () => {
  it('mediaAssetUrlSchema accepts interleaf-media:// scheme and null', () => {
    expect(mediaAssetUrlSchema.safeParse('interleaf-media://asset-12345').success).toBe(true);
    expect(mediaAssetUrlSchema.safeParse('interleaf-media://covers/doc-1.png').success).toBe(true);
    expect(mediaAssetUrlSchema.safeParse(null).success).toBe(true);
    expect(mediaAssetUrlSchema.safeParse(undefined).success).toBe(false);
  });

  it('mediaAssetUrlSchema rejects data:, file:, http:, and raw filesystem paths', () => {
    expect(mediaAssetUrlSchema.safeParse('data:image/png;base64,iVBORw0KGgo=').success).toBe(false);
    expect(mediaAssetUrlSchema.safeParse('file:///Users/alice/cover.png').success).toBe(false);
    expect(mediaAssetUrlSchema.safeParse('/Users/alice/private/cover.png').success).toBe(false);
    expect(mediaAssetUrlSchema.safeParse('http://example.com/cover.png').success).toBe(false);
    expect(mediaAssetUrlSchema.safeParse('https://example.com/cover.png').success).toBe(false);
  });

  it('documentPreviewDataSchema validates clean preview data and rejects invalid URLs', () => {
    const valid = {
      documentId: 'doc-1',
      format: 'pdf' as const,
      locationLabel: 'Page 3',
      isLastRead: true,
      snippet: 'Valid snippet text',
      coverAssetUrl: null,
      fallback: false,
    };
    expect(documentPreviewDataSchema.safeParse(valid).success).toBe(true);

    const withDataUrl = {
      ...valid,
      coverAssetUrl: 'data:image/png;base64,fake',
    };
    expect(documentPreviewDataSchema.safeParse(withDataUrl).success).toBe(false);

    const withFilePath = {
      ...valid,
      coverAssetUrl: '/var/tmp/cover.jpg',
    };
    expect(documentPreviewDataSchema.safeParse(withFilePath).success).toBe(false);
  });

  it('getDocumentPreviewRequestSchema validates requests with optional location', () => {
    expect(
      getDocumentPreviewRequestSchema.safeParse({
        documentId: 'doc-1',
        location: null,
      }).success
    ).toBe(true);

    expect(
      getDocumentPreviewRequestSchema.safeParse({
        documentId: 'doc-1',
        location: { format: 'pdf', pageIndex: 5 },
      }).success
    ).toBe(true);

    expect(
      getDocumentPreviewRequestSchema.safeParse({
        documentId: '',
      }).success
    ).toBe(false);
  });

  it('accepts bounded native chunk offsets for every supported reader format', () => {
    const locations = [
      { format: 'pdf', pageIndex: 0, textStart: 0, textEnd: 8 },
      { format: 'markdown', blockIndex: 0, characterStart: 0, characterEnd: 8 },
      { format: 'docx', paragraphIndex: 0, characterStart: 0, characterEnd: 8 },
      { format: 'epub', cfi: '/6/2', textStart: 0, textEnd: 8 },
      { format: 'mobi', sectionIndex: 0, textStart: 0, textEnd: 8 },
    ];
    for (const location of locations) expect(documentLocationSchema.safeParse(location).success).toBe(true);
    expect(documentLocationSchema.safeParse({ format: 'epub', cfi: '/6/2', textStart: 8 }).success).toBe(false);
    expect(documentLocationSchema.safeParse({ format: 'pdf', pageIndex: 0, textStart: 8, textEnd: 8 }).success).toBe(false);
  });
});
