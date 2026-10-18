// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import type { ReaderSelection, SelectionIssue } from '../../src/renderer/features/reader/types';
import type { Annotation, MarkdownAnnotationAnchor } from '@shared/types/annotation';
import { testDocumentSource, testReflowOptions } from '../helpers/document-source';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serves the document body from `fetch`, with a fresh body per call so a reopen works. */
function serveMarkdown(content: string | Uint8Array): void {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  globalThis.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(bytes.buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    )
  );
}

async function openMarkdown(
  documentId: string,
  markdown: string
): Promise<{ adapter: MarkdownAdapter; container: HTMLElement }> {
  const adapter = new MarkdownAdapter();
  const container = document.createElement('div');
  serveMarkdown(markdown);
  await adapter.open(container, testDocumentSource({ documentId, assetUrl: `test://${documentId}.md` }));
  return { adapter, container };
}

describe('MarkdownAdapter', () => {
  it('reports a single-page reflowable document with empty state before opening', async () => {
    const adapter = new MarkdownAdapter();
    expect(adapter.getPageCount()).toBe(1);
    expect(adapter.getCurrentPage()).toBe(1);
    expect(adapter.getZoom()).toBe(1);
    expect(adapter.getZoomMode()).toBe('fit-width');
    expect(await adapter.getTableOfContents()).toEqual([]);
    expect(adapter.getProgress()).toBe(0);
    const loc = adapter.getReadingLocation();
    expect(loc.location.format).toBe('markdown');
    expect(loc.location.blockIndex).toBe(0);
    expect(loc.progress).toBe(0);
    expect(await adapter.search('test')).toEqual([]);
    expect(adapter.getAnnotationScope()).toBeNull();
    expect(await adapter.setAnnotations([])).toEqual([]);
    await expect(adapter.setReflowOptions({
      lineHeight: 1.8,
      horizontalMarginRem: 3,
      fontSize: 1.2,
      fontFamily: 'serif',
      contentWidth: 60,
      paragraphSpacing: 1.0,
    })).resolves.toBeUndefined();
    // close is idempotent
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it('clamps custom zoom within bounds and reverts to 1 for fit-width', async () => {
    const adapter = new MarkdownAdapter();
    await adapter.setZoom(10);
    expect(adapter.getZoom()).toBe(4);
    await adapter.setZoom(0.1);
    expect(adapter.getZoom()).toBe(0.25);
    await adapter.setZoom(2);
    expect(adapter.getZoom()).toBe(2);
    await adapter.setZoom('fit-width');
    expect(adapter.getZoom()).toBe(1);
    expect(adapter.getZoomMode()).toBe('fit-width');
  });

  describe('document lifecycle, decoding, and DOM rendering', () => {
    it('sizes headings, code, tables and image alt text relative to the reader text size', async () => {
      const { adapter, container } = await openMarkdown(
        'doc-em-sizes',
        '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n' +
          '```\ncode\n```\n\n| A |\n| - |\n| b |\n\n![alt text](missing.png)\n'
      );
      await adapter.setReflowOptions(testReflowOptions({ lineHeight: 1.6, horizontalMarginRem: 2, fontSize: 1.5 }));

      // The text size is applied to the wrapper; rem-based sizes would ignore it.
      const scaled = container.querySelectorAll('.markdown-heading, .markdown-code-block, .markdown-table, .markdown-image-alt');
      expect(scaled.length).toBeGreaterThanOrEqual(8);
      for (const element of scaled) {
        expect(element.className).toMatch(/\btext-\[[\d.]+em\]/);
        expect(element.className).not.toMatch(/\btext-(xs|sm|base|lg|xl|\dxl)\b/);
      }
    });

    it('rejects invalid UTF-8 payload with descriptive error', async () => {
      const adapter = new MarkdownAdapter();
      const container = document.createElement('div');
      // Invalid UTF-8 sequence (0xff, 0xfe)
      serveMarkdown(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x80]));

      await expect(
        adapter.open(container, testDocumentSource({ documentId: 'doc-invalid-utf8', assetUrl: 'test://invalid.md' }))
      ).rejects.toThrow('Invalid Markdown document: file contains invalid UTF-8 encoding.');
    });

    it('opens document and builds TOC with Setext and ATX headings', async () => {
      const { adapter } = await openMarkdown(
        'doc-setext',
        '# Main Title\n\nIntro paragraph.\n\nSub Section\n-----------\n\nBody text.'
      );

      const toc = await adapter.getTableOfContents();
      expect(toc).toHaveLength(1);
      expect(toc[0]?.title).toBe('Main Title');
      expect(toc[0]?.children).toHaveLength(1);
      expect(toc[0]?.children[0]?.title).toBe('Sub Section');

      const scope = adapter.getAnnotationScope();
      expect(scope).toEqual({ format: 'markdown', blockStart: 0, blockEnd: 3 });
    });

    it('re-anchors annotation across blocks when an inserted paragraph shifts block index', async () => {
      // Document with prepended paragraph shifting target to blockIndex 2
      const { adapter } = await openMarkdown(
        'doc-shift',
        'Prepended paragraph.\n\nFirst paragraph.\n\nTarget paragraph with unique passage to annotate.'
      );

      // Annotation was previously recorded at blockIndex 1 (before shift)
      const annotation: Annotation = {
        id: 'ann-1',
        documentId: 'doc-shift',
        type: 'highlight',
        color: 'yellow',
        selectedText: 'Target paragraph with unique passage',
        note: null,
        label: null,
        isLocationNote: false,
        status: 'anchored',
        anchor: {
          format: 'markdown',
          blockIndex: 1, // original stale index
          quote: {
            exact: 'Target paragraph with unique passage',
            prefix: '',
            suffix: ' to annotate.',
          },
          characterStart: 0,
          characterEnd: 36,
        },
        documentHash: 'hash',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const resolutions = await adapter.setAnnotations([annotation]);
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]?.status).toBe('anchored');
      expect(resolutions[0]?.anchor.format).toBe('markdown');
      if (resolutions[0]?.anchor.format === 'markdown') {
        expect(resolutions[0].anchor.blockIndex).toBe(2); // re-anchored to block 2
      }
    });

    it('renders only main-resolved image capabilities and reduces every direct source to alt text', async () => {
      const adapter = new MarkdownAdapter();
      const container = document.createElement('div');
      serveMarkdown([
        '![Remote Image](https://example.com/pic.png)',
        '![Direct Capability](interleaf-media://untrusted/pic.png)',
        '![Data SVG](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
        '![Blob Image](blob:https://example.com/untrusted)',
        '![Archived Image](interleaf-asset:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)',
      ].join('\n\n'));

      await adapter.open(container, testDocumentSource({
        documentId: 'doc-img',
        assetUrl: 'test://img.md',
        mediaAssets: [{
          reference: 'interleaf-asset:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
          url: 'interleaf-media://asset-123/pic.png',
          width: 640,
          height: 360,
        }],
      }));

      // Remote, direct-capability, data, and blob sources are never rendered.
      expect(container.querySelector('img[src^="https://"]')).toBeNull();
      expect(container.querySelector('img[src^="data:"]')).toBeNull();
      expect(container.querySelector('img[src^="blob:"]')).toBeNull();
      expect(container.querySelector('.markdown-image-alt')?.textContent).toContain('Remote Image');

      // Only a durable reference resolved by main may become an image.
      const localImg = container.querySelector<HTMLImageElement>('img[src^="interleaf-media://"]');
      expect(localImg).not.toBeNull();
      expect(localImg?.getAttribute('alt')).toBe('Archived Image');
      expect(localImg?.width).toBe(640);
      expect(localImg?.height).toBe(360);
      expect(container.querySelectorAll('.markdown-image-alt')).toHaveLength(4);
    });

    it('renders a snapshot captured before the Interleaf rename and keeps its reference out of extracted text', async () => {
      // A pre-rebrand snapshot spells the durable citation `marginlab-asset:`
      // and `document_assets.reference` stores the same string, so the two
      // still match. Only the text-extraction strip needs the legacy prefix.
      const legacyReference =
        'marginlab-asset:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png';
      const adapter = new MarkdownAdapter();
      const container = document.createElement('div');
      serveMarkdown(`Before the picture.\n\n![Legacy Archived Image](${legacyReference})\n\nAfter the picture.`);

      await adapter.open(container, testDocumentSource({
        documentId: 'doc-legacy-img',
        assetUrl: 'test://legacy.md',
        mediaAssets: [{
          reference: legacyReference,
          url: 'interleaf-media://asset-legacy/pic.png',
          width: 320,
          height: 200,
        }],
      }));

      const image = container.querySelector<HTMLImageElement>('img[src^="interleaf-media://"]');
      expect(image).not.toBeNull();
      expect(image?.getAttribute('alt')).toBe('Legacy Archived Image');

      const chunks: string[] = [];
      for await (const chunk of adapter.extractText()) chunks.push(chunk.text);
      const joined = chunks.join('\n');
      expect(joined).not.toContain('marginlab-asset:');
      expect(joined).toContain('Legacy Archived Image');
    });

    it('renders interactive media markup only as inert text', async () => {
      const { adapter, container } = await openMarkdown('doc-interactive-media', [
        '<audio controls src="interleaf-media://asset/audio.mp3">Audio transcript</audio>',
        '<video controls src="interleaf-media://asset/video.mp4">Video transcript</video>',
        '<iframe src="https://example.com/embed">Frame description</iframe>',
        '<object data="https://example.com/object">Object description</object>',
        '<embed src="https://example.com/embed">',
        '<canvas>Canvas description</canvas>',
      ].join('\n\n'));

      expect(container.querySelector('audio, video, iframe, object, embed, canvas')).toBeNull();
      expect(container.textContent).toContain('<audio');
      expect(container.textContent).toContain('<video');
      await adapter.close();
    });

    /**
     * Following a link out of a captured article.
     *
     * The adapter never navigates and never opens a window. It reports one
     * canonical http/https target to whoever mounted it, and that host is the
     * only party that can ask main to open it. Anything else a document names —
     * an in-page anchor, a `mailto:`, a relative path — is not reported at all.
     */
    async function openWithLinks(markdown: string) {
      const adapter = new MarkdownAdapter();
      const container = document.createElement('div');
      serveMarkdown(markdown);
      const onExternalLink = vi.fn();
      adapter.setExternalLinkCallback(onExternalLink);
      await adapter.open(container, testDocumentSource({ documentId: 'doc-external', assetUrl: 'test://ext.md' }));
      return { adapter, container, onExternalLink };
    }

    it('reports a clicked http link to the host instead of navigating', async () => {
      const { container, onExternalLink } = await openWithLinks(
        '[Split keyboards](https://www.justinmklam.com/posts/2026/02/split/ "Site")'
      );

      const link = container.querySelector<HTMLAnchorElement>('a[data-external-link="true"]')!;
      expect(link.rel).toBe('noopener noreferrer');
      // A validated http/https link is actionable through the host, so it is
      // not announced as disabled.
      expect(link.getAttribute('aria-disabled')).toBeNull();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);

      expect(onExternalLink).toHaveBeenCalledExactlyOnceWith(
        'https://www.justinmklam.com/posts/2026/02/split/'
      );
      // The document is never allowed to navigate the reader itself.
      expect(click.defaultPrevented).toBe(true);
    });

    it('keeps a fragment anchor internal and never reports it as an external link', async () => {
      const { container, onExternalLink } = await openWithLinks(
        '# Section\n\n[Back to section](#section)'
      );

      const link = container.querySelector<HTMLAnchorElement>('a[href="#section"]')!;
      expect(link.getAttribute('data-external-link')).toBeNull();
      expect(link.getAttribute('aria-disabled')).toBeNull();

      // jsdom has no scrolling; the point is which way the click goes.
      const scrollIntoView = vi.fn();
      for (const heading of container.querySelectorAll('h1')) {
        Object.defineProperty(heading, 'scrollIntoView', { value: scrollIntoView });
      }
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(onExternalLink).not.toHaveBeenCalled();
    });

    it('leaves a link nobody can open inert', async () => {
      const { container, onExternalLink } = await openWithLinks(
        '[Mail the author](mailto:someone@example.com)'
      );

      const link = container.querySelector<HTMLAnchorElement>('a[data-external-link="true"]')!;
      // The click can do nothing on this surface, so assistive tech must hear
      // that the link is disabled rather than a working control.
      expect(link.hasAttribute('aria-disabled')).toBe(true);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(onExternalLink).not.toHaveBeenCalled();
    });

    it('stops reporting links once the document is closed', async () => {
      const { adapter, container, onExternalLink } = await openWithLinks(
        '[Split keyboards](https://example.org/a)'
      );
      const link = container.querySelector<HTMLAnchorElement>('a[data-external-link="true"]')!;

      await adapter.close();
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(onExternalLink).not.toHaveBeenCalled();
    });

    it('falls back to progression scroll when target block does not exist', async () => {
      const { adapter, container } = await openMarkdown('doc-prog', '# A\n\nParagraph 1.\n\nParagraph 2.');

      const scroller = container.querySelector<HTMLElement>('.markdown-viewer-scroll-container')!;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });

      await adapter.goToLocation({ format: 'markdown', blockIndex: 9999, progression: 0.5 });
      expect(scroller.scrollTop).toBe(400); // 0.5 * (1000 - 200)
    });
  });
});

/** Stands in for the CSS Custom Highlight API jsdom does not implement. */
class TestHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/**
 * Installs the highlight registry and range geometry the selection specs need
 * and serves `markdown` for every open. Returns the painted-highlight registry.
 */
function useSelectionEnvironment(markdown: string): Map<string, TestHighlight> {
  const originalHighlight = Reflect.get(window, 'Highlight');
  const originalCss = Reflect.get(window, 'CSS');
  const paintedRanges = new Map<string, TestHighlight>();

  beforeEach(() => {
    paintedRanges.clear();
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          set: (name: string, value: TestHighlight) => { paintedRanges.set(name, value); },
          get: (name: string) => paintedRanges.get(name),
          delete: (name: string) => paintedRanges.delete(name),
        },
      },
    });
    Object.defineProperty(window, 'Highlight', { configurable: true, value: TestHighlight });
    // jsdom runs no layout, so `Range` has neither `getClientRects` nor
    // `getBoundingClientRect` at all, and selection capture or note pointer
    // measurement would throw before an offset assertion is reached. The
    // all-zero geometry jsdom already reports for elements is the honest
    // stand-in; these specs assert on offsets and quotes, not on rects.
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    });
    serveMarkdown(markdown);
  });

  afterEach(() => {
    document.getSelection()!.removeAllRanges();
    Object.defineProperty(window, 'CSS', { configurable: true, value: originalCss });
    Object.defineProperty(window, 'Highlight', { configurable: true, value: originalHighlight });
    // jsdom defines neither method on `Range.prototype`, so deleting the stubs
    // leaves the prototype exactly as the environment shipped it.
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });

  return paintedRanges;
}

async function openAttached(documentId: string): Promise<{ adapter: MarkdownAdapter; container: HTMLElement }> {
  const adapter = new MarkdownAdapter();
  const container = document.createElement('div');
  document.body.appendChild(container);
  await adapter.open(container, testDocumentSource({ documentId, assetUrl: `test://${documentId}.md` }));
  return { adapter, container };
}

/** Selects the given range and reports it the way a reader's sweep would. */
function selectRange(start: Text, startOffset: number, end: Text, endOffset: number): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** Selects the whole of `start` through the whole of `end`. */
function selectTexts(start: Text, end: Text): void {
  selectRange(start, 0, end, end.data.length);
}

/** The Markdown anchor of the single selection reported to the callback. */
function capturedAnchor(callback: ReturnType<typeof vi.fn>): MarkdownAnnotationAnchor {
  const [selection] = callback.mock.calls[0] as [ReaderSelection];
  return selection.anchor as MarkdownAnnotationAnchor;
}

/** A stored annotation over the captured span, as a reopened session sees it. */
function storedAnnotation(
  documentId: string,
  anchor: MarkdownAnnotationAnchor,
  color: 'yellow' | 'green' | 'blue',
  note: string | null = null
): Annotation {
  return {
    id: `ann-${documentId}-${color}`,
    documentId,
    type: note === null ? 'highlight' : 'note',
    color,
    selectedText: anchor.quote.exact,
    note,
    label: null,
    isLocationNote: false,
    status: 'anchored',
    anchor,
    documentHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A Markdown list renders as one `[data-markdown-block]` holding a
 * `.markdown-block-content` per `<li>`, so a selection in any item other than
 * the first has to be measured against a root that covers the whole list.
 * The fixture reproduces a captured web article's bullet list, where each item
 * opens with a bold lead-in followed by plain text.
 */
describe('MarkdownAdapter list item selection', () => {
  const listMarkdown = [
    '# We Must Pace the Frontier',
    '',
    '- **Operational Excellence. **Training a frontier model is an enormous engineering effort.',
    '- **Alignment.** We’ve made clear progress in alignment — training models to be honest and harmless.',
    '- **Interpretability**. Similarly, we can now see inside a model far better than before.',
  ].join('\n');

  const ITEM_TEXTS = [
    'Operational Excellence. Training a frontier model is an enormous engineering effort.',
    'Alignment. We’ve made clear progress in alignment — training models to be honest and harmless.',
    'Interpretability. Similarly, we can now see inside a model far better than before.',
  ] as const;

  const paintedRanges = useSelectionEnvironment(listMarkdown);
  const openListDocument = () => openAttached('doc-list');

  /** The bold lead-in and the plain text after it, inside the numbered item. */
  function itemTexts(container: HTMLElement, index: number): [Text, Text] {
    const item = container.querySelectorAll<HTMLElement>('.markdown-list-item')[index]!;
    const strong = item.querySelector('strong')!;
    return [strong.firstChild as Text, strong.nextSibling as Text];
  }

  it('reports a selection anchored to the whole list for a range inside the second item', async () => {
    const { adapter, container } = await openListDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const [bold, trailing] = itemTexts(container, 1);
    selectTexts(bold, trailing);

    expect(callback).toHaveBeenCalledTimes(1);
    const [selection, error] = callback.mock.calls[0] as [ReaderSelection | null, SelectionIssue | string | null | undefined];
    expect(error).toBeNull();
    expect(selection).not.toBeNull();
    expect(selection!.selectedText).toBe(ITEM_TEXTS[1]);
    expect(selection!.chatDescriptor).toMatchObject({
      format: 'markdown',
      startBlockIndex: 1,
      endBlockIndex: 1,
    });

    const anchor = capturedAnchor(callback);
    expect(anchor.format).toBe('markdown');
    expect(anchor.blockIndex).toBe(1);
    expect(anchor.quote.exact).toBe(ITEM_TEXTS[1]);
    // Offsets are measured over the whole list, so the second item does not
    // start at zero and its prefix is the first item's text.
    expect(anchor.characterStart).toBe(ITEM_TEXTS[0].length);
    expect(anchor.characterEnd).toBe(ITEM_TEXTS[0].length + ITEM_TEXTS[1].length);
    expect(anchor.quote.prefix.endsWith(ITEM_TEXTS[0])).toBe(true);
    // The Chat descriptor carries the same offsets the anchor does, so the two
    // never describe different spans of the same block.
    expect(selection!.chatDescriptor).toMatchObject({
      startCharacterOffset: anchor.characterStart,
      endCharacterOffset: anchor.characterEnd,
    });

    await adapter.close();
    container.remove();
  });

  it('re-resolves and paints an annotation captured from the second list item', async () => {
    const { adapter, container } = await openListDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);
    const [bold, trailing] = itemTexts(container, 1);
    selectTexts(bold, trailing);
    const anchor = capturedAnchor(callback);
    await adapter.close();
    container.remove();

    // A later reading session opens the same document and restores the highlight.
    const reopened = await openListDocument();
    const resolutions = await reopened.adapter.setAnnotations([storedAnnotation('doc-list', anchor, 'yellow')]);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.status).toBe('anchored');
    expect(resolutions[0]!.stage).toBe('native');

    const painted = paintedRanges.get('interleaf-yellow')!;
    expect(painted.ranges).toHaveLength(1);
    const paintedRange = painted.ranges[0]!;
    expect(paintedRange.toString()).toBe(ITEM_TEXTS[1]);
    // The painted text ends inside the second item, not the first one the block
    // element's first content span would have confined it to. Its start is the
    // boundary between the two items, which DOM walking reports as the end of
    // the preceding text node.
    const secondItem = reopened.container.querySelectorAll<HTMLElement>('.markdown-list-item')[1]!;
    expect(secondItem.contains(paintedRange.endContainer)).toBe(true);

    await reopened.adapter.close();
    reopened.container.remove();
  });

  it('keeps a non-list block measured against its own content span', async () => {
    const { adapter, container } = await openListDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const headingContent = container.querySelector<HTMLElement>(
      '.markdown-heading .markdown-block-content'
    )!;
    const headingText = headingContent.firstChild as Text;
    selectTexts(headingText, headingText);

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(0);
    expect(anchor.headingId).toBe('we-must-pace-the-frontier');
    expect(anchor.characterStart).toBe(0);
    expect(anchor.quote.exact).toBe('We Must Pace the Frontier');

    await adapter.close();
    container.remove();
  });

  /**
   * A sweep across two items of one list stays inside a single block, so it is
   * anchored as one span. The quote is the list's own text, which runs the items
   * together without the separators the platform puts in the copied string.
   */
  it('anchors and repaints a sweep across two items of the same list', async () => {
    const { adapter, container } = await openListDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const [startText] = itemTexts(container, 1);
    const [, endText] = itemTexts(container, 2);
    selectTexts(startText, endText);

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(1);
    expect(anchor.quote.exact).toBe(`${ITEM_TEXTS[1]}${ITEM_TEXTS[2]}`);
    expect(anchor.characterStart).toBe(ITEM_TEXTS[0].length);

    const reopened = await openListDocument();
    const resolutions = await reopened.adapter.setAnnotations([storedAnnotation('doc-list', anchor, 'green')]);
    expect(resolutions[0]!.status).toBe('anchored');
    expect(resolutions[0]!.stage).toBe('native');
    expect(paintedRanges.get('interleaf-green')!.ranges[0]!.toString()).toBe(anchor.quote.exact);

    await reopened.adapter.close();
    reopened.container.remove();
    await adapter.close();
    container.remove();
  });
});

/**
 * A Markdown table renders as one `[data-markdown-block]` wrapper holding a
 * `.markdown-block-content` per `<th>`/`<td>`, the same shape a list has. A
 * selection in any cell other than the first header cell therefore has to be
 * measured against a root covering the whole table; otherwise it intersects
 * nothing, no selection is reported, and the reader gets no highlight/note
 * toolbar. The fixture is a representative standings table with an inline-bold
 * body cell; no copy of the reported document exists in this repository.
 */
describe('MarkdownAdapter table cell selection', () => {
  const tableMarkdown = [
    '# League Standings',
    '',
    '| Team | Wins | Notes |',
    '| --- | --- | --- |',
    '| Black Mambas | 12 | **Streak** of six |',
    '| River Kings | 9 | Rebuilding |',
    '',
    'Standings are updated after every fixture.',
  ].join('\n');

  const HEADER_TEXTS = ['Team', 'Wins', 'Notes'] as const;
  const ROW_TEXTS = [
    ['Black Mambas', '12', 'Streak of six'],
    ['River Kings', '9', 'Rebuilding'],
  ] as const;
  /** The table wrapper's own text, which is what block offsets are measured in. */
  const TABLE_TEXT = [...HEADER_TEXTS, ...ROW_TEXTS.flat()].join('');
  const TABLE_BLOCK_INDEX = 1;

  const paintedRanges = useSelectionEnvironment(tableMarkdown);
  const openTableDocument = () => openAttached('doc-table');

  function headerCell(container: HTMLElement, column: number): HTMLElement {
    return container.querySelectorAll<HTMLElement>('.markdown-table thead th')[column]!;
  }

  function bodyCell(container: HTMLElement, row: number, column: number): HTMLElement {
    const tr = container.querySelectorAll<HTMLElement>('.markdown-table tbody tr')[row]!;
    return tr.querySelectorAll<HTMLElement>('td')[column]!;
  }

  it('reports a selection for a range inside a later header cell', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const winsText = headerCell(container, 1).querySelector('.markdown-block-content')!
      .firstChild as Text;
    selectRange(winsText, 0, winsText, winsText.data.length);

    expect(callback).toHaveBeenCalledTimes(1);
    const [selection, error] = callback.mock.calls[0] as [ReaderSelection | null, SelectionIssue | string | null | undefined];
    expect(error).toBeNull();
    // Without a table-wide text root there is no selection at all, so the
    // reader never sees the highlight/note/ask actions for this cell.
    expect(selection).not.toBeNull();
    expect(selection!.selectedText).toBe('Wins');

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(TABLE_BLOCK_INDEX);
    expect(anchor.quote.exact).toBe('Wins');
    // Offsets are measured over the whole table, so a later cell does not start
    // at zero and its prefix is the preceding cells' text.
    expect(anchor.characterStart).toBe(TABLE_TEXT.indexOf('Wins'));
    expect(anchor.characterEnd).toBe(TABLE_TEXT.indexOf('Wins') + 'Wins'.length);
    expect(anchor.quote.prefix.endsWith('Team')).toBe(true);
    expect(selection!.chatDescriptor).toMatchObject({
      format: 'markdown',
      startBlockIndex: TABLE_BLOCK_INDEX,
      endBlockIndex: TABLE_BLOCK_INDEX,
      startCharacterOffset: anchor.characterStart,
      endCharacterOffset: anchor.characterEnd,
    });

    await adapter.close();
    container.remove();
  });

  it('reports a selection spanning inline formatting inside a body cell', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const notes = bodyCell(container, 0, 2).querySelector('.markdown-block-content')!;
    const bold = notes.querySelector('strong')!.firstChild as Text;
    const trailing = notes.lastChild as Text;
    selectRange(bold, 0, trailing, trailing.data.length);

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(TABLE_BLOCK_INDEX);
    expect(anchor.quote.exact).toBe('Streak of six');
    expect(anchor.characterStart).toBe(TABLE_TEXT.indexOf('Streak of six'));

    await adapter.close();
    container.remove();
  });

  it('re-resolves and paints a highlight captured from a body cell after reopen', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);
    const teamText = bodyCell(container, 1, 0).querySelector('.markdown-block-content')!
      .firstChild as Text;
    selectRange(teamText, 0, teamText, teamText.data.length);
    const anchor = capturedAnchor(callback);
    expect(anchor.quote.exact).toBe('River Kings');
    await adapter.close();
    container.remove();

    // A later reading session opens the same document and restores the highlight.
    const reopened = await openTableDocument();
    const resolutions = await reopened.adapter.setAnnotations([storedAnnotation('doc-table', anchor, 'yellow')]);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.status).toBe('anchored');
    expect(resolutions[0]!.stage).toBe('native');

    const painted = paintedRanges.get('interleaf-yellow')!;
    expect(painted.ranges).toHaveLength(1);
    const paintedRange = painted.ranges[0]!;
    expect(paintedRange.toString()).toBe('River Kings');
    // The painted text lands in the intended cell, not the first header cell a
    // per-cell content root would have confined it to. The assertion is on the
    // end boundary: a span starting exactly at a cell boundary is reported by
    // DOM walking as the end of the preceding cell's text node.
    expect(bodyCell(reopened.container, 1, 0).contains(paintedRange.endContainer)).toBe(true);

    await reopened.adapter.close();
    reopened.container.remove();
  });

  it('re-resolves a note captured from a later header cell after reopen', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);
    const notesText = headerCell(container, 2).querySelector('.markdown-block-content')!
      .firstChild as Text;
    selectRange(notesText, 0, notesText, notesText.data.length);
    const anchor = capturedAnchor(callback);
    await adapter.close();
    container.remove();

    const reopened = await openTableDocument();
    const resolutions = await reopened.adapter.setAnnotations([
      storedAnnotation('doc-table', anchor, 'blue', 'Check the streak column weekly.'),
    ]);
    expect(resolutions[0]!.status).toBe('anchored');
    expect(resolutions[0]!.stage).toBe('native');
    // Notes paint under the shared note highlight rather than a colour name.
    const paintedRange = paintedRanges.get('interleaf-note')!.ranges[0]!;
    expect(paintedRange.toString()).toBe('Notes');
    expect(headerCell(reopened.container, 2).contains(paintedRange.endContainer)).toBe(true);

    await reopened.adapter.close();
    reopened.container.remove();
  });

  /**
   * A sweep across cells stays inside the single table block, so it is anchored
   * as one span. The quote is the table's own DOM text, which runs the cells
   * together without the tabs and newlines the platform puts in the copied
   * string.
   */
  it('anchors and repaints a sweep across cells of the same row', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const start = bodyCell(container, 0, 0).querySelector('.markdown-block-content')!
      .firstChild as Text;
    const end = bodyCell(container, 0, 1).querySelector('.markdown-block-content')!
      .firstChild as Text;
    selectRange(start, 0, end, end.data.length);

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(TABLE_BLOCK_INDEX);
    expect(anchor.quote.exact).toBe('Black Mambas12');
    expect(anchor.characterStart).toBe(TABLE_TEXT.indexOf('Black Mambas'));

    const reopened = await openTableDocument();
    const resolutions = await reopened.adapter.setAnnotations([storedAnnotation('doc-table', anchor, 'green')]);
    expect(resolutions[0]!.status).toBe('anchored');
    expect(resolutions[0]!.stage).toBe('native');
    expect(paintedRanges.get('interleaf-green')!.ranges[0]!.toString()).toBe(anchor.quote.exact);

    await reopened.adapter.close();
    reopened.container.remove();
    await adapter.close();
    container.remove();
  });

  it('keeps the first header cell anchored at offset zero', async () => {
    const { adapter, container } = await openTableDocument();
    const callback = vi.fn();
    adapter.setSelectionChangeCallback(callback);

    const teamText = headerCell(container, 0).querySelector('.markdown-block-content')!
      .firstChild as Text;
    selectRange(teamText, 0, teamText, teamText.data.length);

    const anchor = capturedAnchor(callback);
    expect(anchor.blockIndex).toBe(TABLE_BLOCK_INDEX);
    expect(anchor.characterStart).toBe(0);
    expect(anchor.quote.exact).toBe('Team');

    await adapter.close();
    container.remove();
  });
});
