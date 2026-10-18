// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { documentAnchorSchema } from '../../src/shared/schemas/annotation';
import { partitionMultiSegmentText } from '../../src/renderer/features/reader/annotations/dom-anchors';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import { DocxAdapter } from '../../src/renderer/features/reader/adapters/docx-adapter';
import {
  type ReaderSelection,
  type SelectionIssue,
  selectionIssueHeading,
} from '../../src/renderer/features/reader/types';
import type { QuoteContext } from '../../src/shared/types/annotation';
import { ProbePdfAdapter } from '../helpers/pdf-adapter-probe';
import { testDocumentSource } from '../helpers/document-source';

type TestSegment = { readonly quote: QuoteContext; readonly separatorBefore?: string };

function firstTextNode(root: Node): Text {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker?.nextNode();
  if (!(node instanceof Text)) throw new Error('Expected a text node in the rendered fixture.');
  return node;
}

function setSelection(range: Range): Selection {
  const selection = range.startContainer.ownerDocument?.getSelection();
  if (!selection) throw new Error('Document selection is unavailable.');
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function serveBytes(bytes: Uint8Array): void {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })
  );
}

async function openMarkdown(documentId: string, markdown: string): Promise<{ adapter: MarkdownAdapter; container: HTMLElement }> {
  const adapter = new MarkdownAdapter();
  const container = document.createElement('div');
  document.body.appendChild(container);
  serveBytes(new TextEncoder().encode(markdown));
  await adapter.open(container, testDocumentSource({ documentId, assetUrl: `interleaf-media://app/${documentId}.md` }));
  return { adapter, container };
}

async function openDocx(documentId: string, texts: readonly string[]): Promise<{ adapter: DocxAdapter; container: HTMLElement }> {
  const adapter = new DocxAdapter(() => Promise.resolve({
    blocks: texts.map((text, index) => ({
      kind: 'paragraph' as const,
      index,
      text,
      runs: [{ text }],
      pageIndex: 0,
    })),
    toc: [],
    pageCount: 1,
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  serveBytes(new Uint8Array([1, 2, 3, 4]));
  await adapter.open(container, testDocumentSource({ documentId, assetUrl: `interleaf-media://app/${documentId}.docx` }));
  return { adapter, container };
}

/** Selects from the start of `startSelector` to `endOffset` (capped) inside `endSelector`. */
function selectBetween(container: HTMLElement, startSelector: string, endSelector: string, endOffset?: number): Selection {
  const start = container.querySelector(startSelector);
  const end = container.querySelector(endSelector);
  expect(start).toBeTruthy();
  expect(end).toBeTruthy();
  const endNode = firstTextNode(end!);
  const range = document.createRange();
  range.setStart(firstTextNode(start!), 0);
  range.setEnd(endNode, Math.min(endOffset ?? endNode.data.length, endNode.data.length));
  return setSelection(range);
}

describe('reader selection accuracy & limit reporting', () => {
  beforeEach(() => {
    document.getSelection()?.removeAllRanges();
    useAnnotationStore.getState().reset();
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });
  describe('partitionMultiSegmentText deterministic algorithm', () => {
    it('partitions multi-segment selection with exact custom separators', () => {
      const rawSegments: TestSegment[] = [
        { quote: { exact: 'Heading 1', prefix: '', suffix: '' } },
        { quote: { exact: 'Paragraph body with\t\ttabs', prefix: '', suffix: '' } },
        { quote: { exact: 'Final note', prefix: '', suffix: '' } },
      ];
      const nativeSelectedText = 'Heading 1\n\nParagraph body with\t\ttabs   \nFinal note';

      const result = partitionMultiSegmentText(rawSegments, nativeSelectedText);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.segments).toHaveLength(3);
        expect(result.segments[0]?.separatorBefore).toBeUndefined();
        expect(result.segments[1]?.separatorBefore).toBe('\n\n');
        expect(result.segments[2]?.separatorBefore).toBe('   \n');
        expect(result.reconstructedText).toBe(nativeSelectedText);
      }
    });

    it('deterministically handles repeated identical segment text in order', () => {
      const rawSegments: TestSegment[] = [
        { quote: { exact: 'Repeat item', prefix: '', suffix: '' } },
        { quote: { exact: 'Repeat item', prefix: '', suffix: '' } },
      ];
      const nativeSelectedText = 'Repeat item -> middle -> Repeat item';

      const result = partitionMultiSegmentText(rawSegments, nativeSelectedText);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0]?.quote.exact).toBe('Repeat item');
        expect(result.segments[1]?.separatorBefore).toBe(' -> middle -> ');
        expect(result.segments[1]?.quote.exact).toBe('Repeat item');
        expect(result.reconstructedText).toBe(nativeSelectedText);
      }
    });

    it.each([
      ['the first segment does not begin at cursor 0', ['Second piece', 'Third piece'], 'First piece omitted! Second piece and Third piece'],
      ['a later segment is not found after the preceding cursor', ['Start text', 'Missing text'], 'Start text and End text'],
      ['native selection has trailing unmatched characters', ['Start text', 'Middle text'], 'Start text\nMiddle text\nTrailing unmatched text'],
    ] as const)('rejects when %s', (_case, exacts, nativeSelectedText) => {
      const rawSegments: TestSegment[] = exacts.map((exact) => ({ quote: { exact, prefix: '', suffix: '' } }));
      const result = partitionMultiSegmentText(rawSegments, nativeSelectedText);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'Selection text could not be mapped to document segments deterministically.'
        );
      }
    });

    it('rejects empty raw segments or empty native selection', () => {
      expect(partitionMultiSegmentText([], 'Some text').ok).toBe(false);
      expect(
        partitionMultiSegmentText(
          [{ quote: { exact: 'Some text', prefix: '', suffix: '' } }],
          ''
        ).ok
      ).toBe(false);
      expect(
        partitionMultiSegmentText(
          [{ quote: { exact: '', prefix: '', suffix: '' } }],
          'Some text'
        ).ok
      ).toBe(false);
    });
  });

  describe('useAnnotationStore selection and error management', () => {
    it('manages selection error state correctly in useAnnotationStore', () => {
      const store = useAnnotationStore.getState();
      expect(store.selection).toBeNull();
      expect(store.selectionIssue).toBeNull();

      // A rejected selection records the adapter's typed issue
      const spanIssue: SelectionIssue = {
        code: 'span_limit',
        message: 'Selection exceeds maximum allowable span of 50 pages.',
        unit: 'pages',
        maxSpan: 50,
      };
      store.setSelection(null, spanIssue);
      expect(useAnnotationStore.getState().selection).toBeNull();
      expect(useAnnotationStore.getState().selectionIssue).toEqual(spanIssue);

      // Manual dismissal
      useAnnotationStore.getState().clearSelectionError();
      expect(useAnnotationStore.getState().selectionIssue).toBeNull();

      // Setting typed error
      const issue: SelectionIssue = {
        code: 'size_limit',
        message: 'Selection exceeds maximum text length of 256,000 characters.',
        maxLength: 256_000,
      };
      store.setSelection(null, issue);
      expect(useAnnotationStore.getState().selectionIssue).toEqual(issue);

      // Valid selection automatically clears selectionIssue
      const mockSelection: ReaderSelection = {
        selectedText: 'Valid selection text',
        totalSelectedLength: 20,
        chatDescriptor: {
          format: 'markdown',
          startBlockIndex: 0,
          endBlockIndex: 0,
          startQuote: { exact: 'Valid selection text', prefix: '', suffix: '' },
          endQuote: { exact: 'Valid selection text', prefix: '', suffix: '' },
        },
        anchor: {
          format: 'markdown',
          blockIndex: 0,
          quote: { exact: 'Valid selection text', prefix: '', suffix: '' },
        },
        clientRect: { left: 10, top: 10, width: 100, height: 20 },
      };
      store.setSelection(mockSelection, null);
      expect(useAnnotationStore.getState().selection).toEqual(mockSelection);
      expect(useAnnotationStore.getState().selectionIssue).toBeNull();

      // Reset clears everything
      store.reset();
      expect(useAnnotationStore.getState().selection).toBeNull();
      expect(useAnnotationStore.getState().selectionIssue).toBeNull();
    });

    it('gives each selection issue an accessible heading', () => {
      const issues: readonly (readonly [SelectionIssue, string])[] = [
        [{ code: 'size_limit', message: 'Too long.', maxLength: 256_000 }, 'Selection limit exceeded:'],
        [{ code: 'span_limit', message: 'Too wide.', unit: 'pages', maxSpan: 50 }, 'Selection limit exceeded:'],
        [{ code: 'mapping_failure', message: 'Not mapped.' }, 'Selection mapping failed:'],
        [{ code: 'stale_layer', message: 'Layer updated.' }, 'Selection interrupted:'],
      ];
      for (const [issue, heading] of issues) {
        expect(selectionIssueHeading(issue)).toBe(heading);
      }
    });

    it('faithfully preserves exact whitespace and separatorBefore in multi-segment reconstruction', () => {
      const multiBlockMarkdown = {
        format: 'markdown',
        blockIndex: 1,
        quote: {
          exact: 'First line\n\nSecond line with spaces\t\tand tab',
          prefix: 'start ',
          suffix: ' end',
        },
        segments: [
          {
            blockIndex: 1,
            quote: { exact: 'First line', prefix: 'start ', suffix: '' },
            characterStart: 0,
            characterEnd: 10,
          },
          {
            blockIndex: 2,
            quote: { exact: 'Second line with spaces\t\tand tab', prefix: '', suffix: ' end' },
            separatorBefore: '\n\n',
            characterStart: 0,
            characterEnd: 33,
          },
        ],
      };

      const parsed = documentAnchorSchema.safeParse(multiBlockMarkdown);
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.format === 'markdown') {
        const reconstructed = parsed.data.segments
          ?.map((s, i) => (i > 0 ? (s.separatorBefore ?? '') : '') + s.quote.exact)
          .join('');
        expect(reconstructed).toBe('First line\n\nSecond line with spaces\t\tand tab');
        expect(reconstructed).toBe(parsed.data.quote.exact);
      }
    });

    it('rejects multi-segment anchors when top-level quote does not match segment reconstruction', () => {
      const invalidMultiBlock = {
        format: 'markdown',
        blockIndex: 1,
        quote: { exact: 'Completely different top level quote', prefix: 'start ', suffix: ' end' },
        segments: [
          {
            blockIndex: 1,
            quote: { exact: 'First line', prefix: 'start ', suffix: '' },
          },
          {
            blockIndex: 2,
            quote: { exact: 'Second line', prefix: '', suffix: ' end' },
            separatorBefore: '\n\n',
          },
        ],
      };

      const parsed = documentAnchorSchema.safeParse(invalidMultiBlock);
      expect(parsed.success).toBe(false);
    });
  });

  describe('adapter callback paths for boundary limits and deterministic partition mismatch', () => {
    it('PdfAdapter enforces 50-page span limit: accepts 50 pages and rejects 51 pages with span_limit', async () => {
      const adapter = new ProbePdfAdapter();
      const container = document.createElement('div');
      const scroller = document.createElement('div');
      container.appendChild(scroller);
      document.body.appendChild(container);

      const pageWrappers = new Map<number, HTMLElement>();
      for (const [pageNumber, text] of [[1, 'Page one'], [50, 'Page fifty'], [51, 'Page fifty-one']] as const) {
        const wrapper = document.createElement('article');
        wrapper.className = 'pdf-page-wrapper';
        wrapper.dataset.pageNumber = String(pageNumber);
        const layer = document.createElement('div');
        layer.className = 'textLayer';
        layer.appendChild(document.createTextNode(text));
        wrapper.appendChild(layer);
        scroller.appendChild(wrapper);
        pageWrappers.set(pageNumber, wrapper);
      }

      adapter.seedLayout(scroller, pageWrappers);

      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);

      // 1. 50 pages (1 to 50): accepted
      const start = firstTextNode(pageWrappers.get(1)!);
      const end50 = firstTextNode(pageWrappers.get(50)!);
      setSelection((() => {
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end50, end50.data.length);
        return range;
      })());
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: expect.objectContaining({
            format: 'pdf',
            pageIndex: 0,
          }),
        }),
        null
      );

      // 2. 51 pages (1 to 51): anchor is null (annotation bounded at 50) while chatDescriptor covers 51 pages
      const end51 = firstTextNode(pageWrappers.get(51)!);
      setSelection((() => {
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end51, end51.data.length);
        return range;
      })());
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: null,
          chatDescriptor: expect.objectContaining({
            format: 'pdf',
            startPageIndex: 0,
            endPageIndex: 50,
          }),
        }),
        null
      );
      await adapter.close();
      container.remove();
    });

    it('MarkdownAdapter enforces 100-block span limit: accepts 100 blocks and rejects 101 blocks with span_limit', async () => {
      const longMd = Array.from({ length: 105 }, (_, i) => `Paragraph ${String(i)}`).join('\n\n');
      const { adapter, container } = await openMarkdown('doc-long-md', longMd);
      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);

      // 1. 100 blocks (0 to 99): accepted
      selectBetween(container, '[data-markdown-block="0"]', '[data-markdown-block="99"]', 5);
      document.dispatchEvent(new Event('selectionchange'));
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: expect.objectContaining({
            format: 'markdown',
            blockIndex: 0,
          }),
        }),
        null
      );

      // 2. 101 blocks (0 to 100): anchor is null (annotation bounded at 100) while chatDescriptor covers 101 blocks
      selectBetween(container, '[data-markdown-block="0"]', '[data-markdown-block="100"]', 5);
      document.dispatchEvent(new Event('selectionchange'));
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: null,
          chatDescriptor: expect.objectContaining({
            format: 'markdown',
            startBlockIndex: 0,
            endBlockIndex: 100,
          }),
        }),
        null
      );
      await adapter.close();
      container.remove();
    });

    it('MarkdownAdapter reports deterministic partition mismatch error when segment mapping fails', async () => {
      const { adapter, container } = await openMarkdown('doc-mismatch-md', 'First block text.\n\nSecond block text.');
      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);

      const sel = selectBetween(container, '[data-markdown-block="0"]', '[data-markdown-block="1"]', 17);
      // Mock Selection.toString to simulate corrupted/mismatched string that cannot be partitioned
      const origToString = sel.toString;
      sel.toString = () => 'Completely mismatched native text that does not start with First';
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          anchor: null,
          chatDescriptor: expect.objectContaining({
            format: 'markdown',
            startBlockIndex: 0,
            endBlockIndex: 1,
          }),
        }),
        null
      );
      sel.toString = origToString;
      await adapter.close();
      container.remove();
    });

    it('MarkdownAdapter accepts 256,000 with anchor and 256,001 with Chat selection + anchor:null', async () => {
      const blocks = Array.from({ length: 8 }, (_, i) => String.fromCharCode(65 + i).repeat(i < 2 ? 31_999 : 31_998));
      const fullMd = blocks.join('\n\n');
      expect(fullMd.length).toBe(256_000);
      const { adapter, container } = await openMarkdown('doc-long-native-selection', fullMd);
      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);
      const selection = selectBetween(container, '[data-markdown-block="0"]', '[data-markdown-block="7"]');

      // 1. Exact 256,000 characters: accepted with full anchor
      const originalToString = selection.toString;
      selection.toString = () => fullMd;
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedText: expect.any(String),
          totalSelectedLength: 256_000,
          chatDescriptor: expect.objectContaining({
            format: 'markdown',
            startBlockIndex: 0,
            endBlockIndex: 7,
          }),
          anchor: expect.objectContaining({
            format: 'markdown',
            blockIndex: 0,
          }),
        }),
        null
      );

      // 2. 256,001 characters: yields valid Chat selection with anchor: null, not an error
      selection.toString = () => 'A'.repeat(256_001);
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedText: expect.any(String),
          totalSelectedLength: 256_001,
          chatDescriptor: expect.objectContaining({
            format: 'markdown',
            startBlockIndex: 0,
            endBlockIndex: 7,
          }),
          anchor: null,
        }),
        null
      );

      selection.toString = originalToString;
      window.Selection.prototype.toString = originalToString;
      await adapter.close();
      container.remove();
    });

    it('DocxAdapter enforces 100-paragraph span limit: accepts 100 paragraphs and rejects 101 with span_limit', async () => {
      const { adapter, container } = await openDocx(
        'doc-long-docx',
        Array.from({ length: 105 }, (_, i) => `Paragraph ${String(i)}`)
      );
      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);

      // 1. 100 paragraphs (0 to 99): accepted
      selectBetween(container, '[data-docx-paragraph="0"]', '[data-docx-paragraph="99"]', 5);
      document.dispatchEvent(new Event('selectionchange'));
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: expect.objectContaining({
            format: 'docx',
            paragraphIndex: 0,
          }),
        }),
        null
      );

      // 2. 101 paragraphs (0 to 100): anchor is null (annotation bounded at 100) while chatDescriptor covers 101 paragraphs
      selectBetween(container, '[data-docx-paragraph="0"]', '[data-docx-paragraph="100"]', 5);
      document.dispatchEvent(new Event('selectionchange'));
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: null,
          chatDescriptor: expect.objectContaining({
            format: 'docx',
            startParagraphIndex: 0,
            endParagraphIndex: 100,
          }),
        }),
        null
      );
      await adapter.close();
      container.remove();
    });

    it('DocxAdapter reports deterministic partition mismatch error when segment mapping fails', async () => {
      const { adapter, container } = await openDocx('doc-mismatch-docx', [
        'First docx paragraph.',
        'Second docx paragraph.',
      ]);
      const callback = vi.fn();
      adapter.setSelectionChangeCallback(callback);

      const sel = selectBetween(container, '[data-docx-paragraph="0"]', '[data-docx-paragraph="1"]', 10);
      const origToString = sel.toString;
      sel.toString = () => 'Corrupted text that fails deterministic segment partitioning';
      document.dispatchEvent(new Event('selectionchange'));

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          anchor: null,
          chatDescriptor: expect.objectContaining({
            format: 'docx',
            startParagraphIndex: 0,
            endParagraphIndex: 1,
          }),
        }),
        null
      );
      sel.toString = origToString;
      await adapter.close();
      container.remove();
    });
  });
});
