import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { documentAnchorSchema } from '@shared/schemas/annotation';
import { chatSelectionDescriptorSchema } from '@shared/schemas/document';
import type { DocumentAnchor } from '@shared/types/annotation';
import {
  chatDescriptorFromAnchor,
  savedHighlightTarget,
} from '../../src/renderer/features/reader/annotations/saved-highlight-target';
import { testAnnotation } from '../helpers/annotation';

/* A reopened highlight asks AI through the same descriptor a live selection
   of that passage would send, so every saved anchor main accepts must map to a
   descriptor main accepts too. */

const QUOTE = { exact: 'alpha beta', prefix: 'before ', suffix: ' after' };

function anchor(input: z.input<typeof documentAnchorSchema>): DocumentAnchor {
  return documentAnchorSchema.parse(input);
}

function descriptorFor(saved: DocumentAnchor, text = QUOTE.exact) {
  const descriptor = chatDescriptorFromAnchor(saved, text);
  expect(descriptor).not.toBeNull();
  return chatSelectionDescriptorSchema.parse(descriptor);
}

describe('chatDescriptorFromAnchor', () => {
  it('maps a single-page PDF anchor with its text offsets', () => {
    const descriptor = descriptorFor(anchor({
      format: 'pdf', quote: QUOTE, pageIndex: 3, pageLabel: 'iv', textStart: 7, textEnd: 17,
    }));
    expect(descriptor).toEqual({
      format: 'pdf',
      startPageIndex: 3,
      endPageIndex: 3,
      startPageLabel: 'iv',
      endPageLabel: 'iv',
      startQuote: QUOTE,
      endQuote: QUOTE,
      startTextOffset: 7,
      endTextOffset: 17,
      selectedTextSnippet: 'alpha beta',
    });
  });

  it('spans a cross-page PDF anchor from its first to its last segment', () => {
    const first = { exact: 'alpha', prefix: 'before ', suffix: '' };
    const last = { exact: 'beta', prefix: '', suffix: ' after' };
    const descriptor = descriptorFor(anchor({
      format: 'pdf',
      quote: QUOTE,
      pageIndex: 1,
      segments: [
        { pageIndex: 1, quote: first, textStart: 40, textEnd: 45 },
        { pageIndex: 2, quote: last, separatorBefore: ' ', textStart: 0, textEnd: 4 },
      ],
    }));
    expect(descriptor).toMatchObject({
      startPageIndex: 1,
      endPageIndex: 2,
      startQuote: first,
      endQuote: last,
      startTextOffset: 40,
      endTextOffset: 4,
    });
  });

  it('maps a Markdown anchor with its block, line, heading and character range', () => {
    const descriptor = descriptorFor(anchor({
      format: 'markdown', quote: QUOTE, blockIndex: 4, lineIndex: 2, headingId: 'intro', characterStart: 3, characterEnd: 13,
    }));
    expect(descriptor).toMatchObject({
      format: 'markdown',
      startBlockIndex: 4,
      endBlockIndex: 4,
      startLineIndex: 2,
      endLineIndex: 2,
      startHeadingId: 'intro',
      endHeadingId: 'intro',
      startCharacterOffset: 3,
      endCharacterOffset: 13,
    });
  });

  it.each(['docx', 'pptx'] as const)('maps a %s paragraph anchor', (format) => {
    const descriptor = descriptorFor(anchor({
      format, quote: QUOTE, paragraphIndex: 5, renderedPageIndex: 1, characterStart: 0, characterEnd: 10,
    }));
    expect(descriptor).toMatchObject({
      format,
      startParagraphIndex: 5,
      endParagraphIndex: 5,
      startRenderedPageIndex: 1,
      endRenderedPageIndex: 1,
      startCharacterOffset: 0,
      endCharacterOffset: 10,
    });
  });

  it('maps an EPUB anchor to its section and CFIs', () => {
    const descriptor = descriptorFor(anchor({
      format: 'epub', quote: QUOTE, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)', spineHref: 'ch1.xhtml', progression: 0.25,
    }));
    expect(descriptor).toMatchObject({
      format: 'epub',
      startSpineHref: 'ch1.xhtml',
      endSpineHref: 'ch1.xhtml',
      startCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)',
      endCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)',
      startProgression: 0.25,
    });
  });

  it('has no chat route for an EPUB anchor saved without its section', () => {
    const saved = anchor({ format: 'epub', quote: QUOTE, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)' });
    expect(chatDescriptorFromAnchor(saved, QUOTE.exact)).toBeNull();
  });

  it('maps a MOBI anchor with its section and text offsets', () => {
    const descriptor = descriptorFor(anchor({
      format: 'mobi', quote: QUOTE, sectionIndex: 2, textStart: 100, textEnd: 110,
    }));
    expect(descriptor).toMatchObject({
      format: 'mobi',
      startSectionIndex: 2,
      endSectionIndex: 2,
      startOffset: 100,
      endOffset: 110,
    });
  });

  it('bounds the snippet as live selections do, never splitting a surrogate pair', () => {
    const long = `${'a'.repeat(499)}😀tail`;
    const descriptor = descriptorFor(anchor({ format: 'markdown', quote: QUOTE, blockIndex: 0 }), long);
    // 500 code units would end inside the emoji, so it is left out whole.
    expect(descriptor.selectedTextSnippet).toBe('a'.repeat(499));
  });
});

describe('savedHighlightTarget', () => {
  it('acts on the full saved passage at the clicked fragment', () => {
    const annotation = testAnnotation({ selectedText: 'selected quote' });
    const target = savedHighlightTarget(annotation, { left: 10, top: 40, right: 210, bottom: 60 });
    expect(target).toMatchObject({
      selectedText: 'selected quote',
      totalSelectedLength: 14,
      anchor: annotation.anchor,
      clientRect: { left: 10, top: 40, width: 200, height: 20 },
    });
  });

  it('falls back to the anchored quote when no selected text was stored', () => {
    const target = savedHighlightTarget(testAnnotation({ selectedText: null }), { left: 0, top: 0, right: 1, bottom: 1 });
    expect(target.selectedText).toBe('selected quote');
  });
});
